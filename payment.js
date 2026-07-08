// payment.js — Stripe Payment Element (card + Apple Pay + Google Pay + Afterpay)

let stripeElements = null;
let stripePaymentElement = null;
let stripeElementsMounted = false;
let clientSecret = null;
let mountedTotalCents = null;

// ---------------------------------------------------------------------------
// Afterpay return handler — called from app.js after all state is initialized
// ---------------------------------------------------------------------------
async function checkAfterPayReturn() {
  const params = new URLSearchParams(window.location.search);
  if (!params.get('afterpay_return')) return;

  // Clean up URL
  window.history.replaceState({}, '', window.location.pathname);

  const saved = sessionStorage.getItem('ww_pending_booking');
  if (!saved) return;

  let pending;
  try { pending = JSON.parse(saved); } catch (e) { return; }
  sessionStorage.removeItem('ww_pending_booking');

  // Restore booking state
  Object.assign(state, {
    selectedRoom:    pending.room,
    partyRoomDbId:   pending.partyRoomDbId,
    selectedDate:    pending.date,
    selectedTime:    pending.time,
    guests:          pending.guests,
    selectedFood:    pending.food,
    addons:          pending.addons || {},
    calculatedTotal: pending.calculatedTotal,
    bookingRef:      pending.bookingRef,
    slotHoldId:      pending.slotHoldId,
    confirmEmail:    pending.confirmEmail,
    confirmPhone:    pending.confirmPhone,
  });
  if (pending.user) state.user = pending.user;

  // Verify payment actually succeeded
  const { paymentIntent } = await stripe.retrievePaymentIntent(pending.clientSecret);

  if (paymentIntent?.status === 'succeeded') {
    state.stripePaymentIntentId = paymentIntent.id;
    // Open modal directly WITHOUT calling openBooking() (which calls resetWizard and wipes state)
    const overlay = document.getElementById('bookingOverlay');
    if (overlay) overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => goToStep(5), 150);
  } else {
    alert('Your Afterpay payment could not be confirmed. Please try booking again.');
  }
}

// ---------------------------------------------------------------------------
// POLi return handler — called from app.js after all state is initialized.
// Unlike Afterpay, the booking is already fully created server-side by the
// time the customer's browser comes back (see server/routes/poli.js) since
// POLi collects contact details before the redirect, not after — so this
// just needs to fetch the booking and show the confirmation step, not
// finalise anything itself.
// ---------------------------------------------------------------------------
async function checkPoliReturn() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('poli_booking');
  if (!outcome) return;

  window.history.replaceState({}, '', window.location.pathname);

  const saved = sessionStorage.getItem('ww_pending_poli_booking');
  sessionStorage.removeItem('ww_pending_poli_booking');

  if (outcome !== 'success') {
    alert('Your bank payment could not be completed. Please try booking again.');
    return;
  }

  const bookingId = params.get('bookingId');
  if (!bookingId) return;

  let pending = null;
  try { pending = saved ? JSON.parse(saved) : null; } catch (e) { /* ignore */ }

  try {
    const booking = await callAPI(`bookings/${bookingId}`, null, 'GET');
    Object.assign(state, {
      selectedRoom:    pending?.room || { name: booking.roomName },
      selectedDate:    booking.partyDate,
      selectedTime:    booking.partyTime,
      guests:          booking.guestCount,
      selectedFood:    booking.foodChoice,
      addons:          pending?.addons || {},
      calculatedTotal: parseFloat(booking.totalAmount),
      bookingRef:      booking.bookingRef,
      bookingId:       booking.id,
      confirmEmail:    booking.contactEmail,
      confirmPhone:    (booking.contactPhone || '').replace('+64', '').trim(),
    });

    const overlay = document.getElementById('bookingOverlay');
    if (overlay) overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      stopTimer();
      buildConfirmationCard();
      goToStep(6);
      launchConfetti();
    }, 150);
  } catch (err) {
    alert('Your bank payment succeeded, but we had trouble loading your booking details. Check "My Bookings" or contact us — your booking is confirmed.');
  }
}

// ---------------------------------------------------------------------------
// POLi payment option (redirect flow — shown only when the server reports
// POLI_CONFIGURED, i.e. real credentials exist. See gallery.html-style pages'
// step4 markup for the paired HTML.)
// ---------------------------------------------------------------------------
function initPoliOption() {
  const enabled = !!(window.__ENV__ && window.__ENV__.POLI_CONFIGURED);
  const tabs = document.getElementById('paymentMethodTabs');
  if (tabs) tabs.classList.toggle('hidden', !enabled);
}

function switchPaymentMethod(method) {
  const isCard = method === 'stripe';
  document.getElementById('cardPaymentPanel')?.classList.toggle('hidden', !isCard);
  document.getElementById('poliPaymentPanel')?.classList.toggle('hidden', isCard);

  const cardTab = document.getElementById('payTabCard');
  const poliTab = document.getElementById('payTabPoli');
  if (cardTab) cardTab.className = `flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${isCard ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`;
  if (poliTab) poliTab.className = `flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${!isCard ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`;
}

async function processPoliPayment() {
  const errEl = document.getElementById('poli-payment-errors');
  if (errEl) errEl.textContent = '';

  const email = document.getElementById('poliEmail')?.value.trim();
  const phone = document.getElementById('poliPhone')?.value.trim();

  if (!email || !isValidEmail(email)) {
    if (errEl) errEl.textContent = 'Please enter a valid email address.';
    return;
  }
  if (!phone || !isValidNzMobile(phone)) {
    if (errEl) errEl.textContent = 'Please enter a valid NZ mobile number (e.g. 021 234 5678).';
    return;
  }

  const btn = document.getElementById('poliPayBtn');
  const btnText = document.getElementById('poliPayBtnText');
  const btnSpinner = document.getElementById('poliPayBtnSpinner');
  btn.disabled = true;
  btnText?.classList.add('hidden');
  btnSpinner?.classList.remove('hidden');

  const addonLines = getAddonSummaryLines();
  const addonsSummaryText = addonLines.map(a => `${a.label} ×${a.qty} ($${a.subtotal.toFixed(2)})`).join(', ');

  try {
    const { navigateUrl } = await callAPI('poli/initiate', {
      bookingRef:     state.bookingRef,
      roomId:         state.partyRoomDbId,
      roomSlug:       state.selectedRoom?.id,
      partyDate:      state.selectedDate,
      partyTime:      state.selectedTime,
      guestCount:     state.guests,
      foodChoice:     state.selectedFood,
      allergyNotes:   state.allergyNotes,
      addonsSummary:  addonsSummaryText,
      addonsAmount:   getAddonTotal(),
      contactEmail:   email,
      contactPhone:   phone.replace(/\s/g, ''),
      slotHoldId:     state.slotHoldId,
      firstName:      state.user?.firstName || '',
      lastName:       state.user?.lastName || '',
    });

    // Stash just enough to redisplay the confirmation nicely when the
    // customer's browser comes back — the booking itself is created
    // server-side, this is purely cosmetic (room/addons for the summary card).
    sessionStorage.setItem('ww_pending_poli_booking', JSON.stringify({
      room: state.selectedRoom,
      addons: state.addons,
    }));

    window.location.href = navigateUrl;
  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Could not start bank payment. Please try again.';
    btn.disabled = false;
    btnText?.classList.remove('hidden');
    btnSpinner?.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Mount Stripe Payment Element when step 4 is shown
// ---------------------------------------------------------------------------
async function mountStripeElements() {
  const totalAmount = state.calculatedTotal || 0;
  const totalCents = Math.round(totalAmount * 100);

  if (stripeElementsMounted) {
    // Guest count/food/add-ons can still be edited via the step 4 → 3 → 2 back buttons.
    // If the total hasn't changed, keep the already-mounted element (and its PaymentIntent)
    // as-is. If it HAS changed, the existing PaymentIntent is now stale — tear it down and
    // create a fresh one for the current total instead of letting the customer pay the old
    // amount and fail the server-side total check after being charged.
    if (mountedTotalCents === totalCents) return;
    resetPaymentElement();
  }

  const wrapper = document.getElementById('stripe-payment-wrapper');
  if (!wrapper) return;

  wrapper.innerHTML = '<div class="text-gray-400 text-sm text-center py-6">Loading payment options...</div>';

  try {
    const result = await callEdgeFunction('create-payment-intent', {
      roomId:        state.partyRoomDbId,
      roomSlug:      state.selectedRoom?.id,
      guestCount:    state.guests,
      addonsAmount:  getAddonTotal(),
      currency:      'nzd',
      bookingRef:    state.bookingRef || 'PENDING',
      customerEmail: state.user?.email || '',
      metadata: {
        room:   state.selectedRoom?.name || '',
        date:   state.selectedDate || '',
        time:   state.selectedTime || '',
        guests: state.guests,
      },
    });
    clientSecret = result.clientSecret;
    mountedTotalCents = totalCents;
  } catch (err) {
    // A 400 means the server rejected the booking details themselves (e.g. guest count
    // outside the room's limits) — show that message as-is instead of framing it as a
    // Stripe/payment loading problem.
    const message = err.status === 400 ? err.message : `Failed to load payment: ${err.message}`;
    wrapper.innerHTML = `<div class="text-red-500 text-sm text-center py-4">${message}</div>`;
    return;
  }

  wrapper.innerHTML = '<div id="stripe-payment-element"></div>';

  stripeElements = stripe.elements({
    clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#4F46E5',
        colorText: '#1F2937',
        colorDanger: '#EF4444',
        fontFamily: 'Inter, sans-serif',
        borderRadius: '12px',
      },
    },
  });

  stripePaymentElement = stripeElements.create('payment', {
    layout: { type: 'tabs', defaultCollapsed: false },
    fields: { billingDetails: { address: 'auto' } },
    defaultValues: {
      billingDetails: {
        email: state.user?.email || '',
        name: `${state.user?.firstName || ''} ${state.user?.lastName || ''}`.trim(),
        address: { country: 'NZ' },
      },
    },
  });

  stripePaymentElement.mount('#stripe-payment-element');
  stripeElementsMounted = true;
}

// ---------------------------------------------------------------------------
// Process payment
// ---------------------------------------------------------------------------
async function processStripePayment() {
  if (!stripeElements || !clientSecret) {
    showFieldError('Payment form not ready — please wait a moment and try again.');
    return;
  }

  const btn = document.getElementById('payBtn');
  const btnText = document.getElementById('payBtnText');
  const btnSpinner = document.getElementById('payBtnSpinner');
  const errEl = document.getElementById('stripe-payment-errors');

  btn.disabled = true;
  btnText?.classList.add('hidden');
  btnSpinner?.classList.remove('hidden');
  if (errEl) errEl.textContent = '';

  // Save booking state before redirect (Afterpay redirects away from the page)
  sessionStorage.setItem('ww_pending_booking', JSON.stringify({
    clientSecret,
    room:            state.selectedRoom,
    partyRoomDbId:   state.partyRoomDbId,
    date:            state.selectedDate,
    time:            state.selectedTime,
    guests:          state.guests,
    food:            state.selectedFood,
    addons:          state.addons,
    calculatedTotal: state.calculatedTotal,
    bookingRef:      state.bookingRef,
    slotHoldId:      state.slotHoldId,
    user:            state.user,
    confirmEmail:    state.confirmEmail,
    confirmPhone:    state.confirmPhone,
  }));

  try {
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        return_url: window.location.origin + '/?afterpay_return=1',
        payment_method_data: {
          billing_details: {
            email: state.user?.email || state.confirmEmail || '',
            name: `${state.user?.firstName || ''} ${state.user?.lastName || ''}`.trim(),
          },
        },
      },
      redirect: 'if_required',
    });

    if (error) {
      sessionStorage.removeItem('ww_pending_booking');
      if (errEl) errEl.textContent = error.message || 'Payment failed. Please try again.';
      btn.disabled = false;
      btnText?.classList.remove('hidden');
      btnSpinner?.classList.add('hidden');
      return;
    }

    // Non-redirect payment succeeded (card, Apple Pay, Google Pay)
    sessionStorage.removeItem('ww_pending_booking');
    state.stripePaymentIntentId = paymentIntent?.id || clientSecret.split('_secret_')[0];
    goToStep(5);

  } catch (err) {
    sessionStorage.removeItem('ww_pending_booking');
    if (errEl) errEl.textContent = err.message || 'Payment failed.';
    btn.disabled = false;
    btnText?.classList.remove('hidden');
    btnSpinner?.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
function resetPaymentElement() {
  if (stripePaymentElement) {
    try { stripePaymentElement.unmount(); } catch (e) {}
    stripePaymentElement = null;
  }
  const wrapper = document.getElementById('stripe-payment-wrapper');
  if (wrapper) wrapper.innerHTML = '';
  stripeElements = null;
  stripeElementsMounted = false;
  clientSecret = null;
  mountedTotalCents = null;
}