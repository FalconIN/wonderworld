// payment.js — Stripe Payment Element (card + Apple Pay + Google Pay + Afterpay)

let stripeElements = null;
let stripePaymentElement = null;
let stripeElementsMounted = false;
let clientSecret = null;

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
// Mount Stripe Payment Element when step 4 is shown
// ---------------------------------------------------------------------------
async function mountStripeElements() {
  if (stripeElementsMounted) return;

  const wrapper = document.getElementById('stripe-payment-wrapper');
  if (!wrapper) return;

  const totalAmount = state.calculatedTotal || 0;
  wrapper.innerHTML = '<div class="text-gray-400 text-sm text-center py-6">Loading payment options...</div>';

  try {
    const result = await callEdgeFunction('create-payment-intent', {
      amount:        Math.round(totalAmount * 100),
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
  } catch (err) {
    wrapper.innerHTML = `<div class="text-red-500 text-sm text-center py-4">Failed to load payment: ${err.message}</div>`;
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
}