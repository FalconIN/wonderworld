/**
 * payment.js
 * Stripe integration:
 *   - Stripe Card Element (iframe card input)
 *   - Payment Request Button (Apple Pay / Google Pay)
 *   - Creates PaymentIntent via Supabase Edge Function
 *   - Records payment in Supabase
 */

let stripeCardElement   = null;
let stripeCardMounted   = false;
let paymentRequest      = null;
let prButton            = null;

// ---------------------------------------------------------------------------
// Mount Stripe elements when step 4 is shown
// ---------------------------------------------------------------------------
async function mountStripeElements() {
  if (stripeCardMounted) return;

  const elements = stripe.elements({
    fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap' }],
    locale: 'en',
  });

  // Card element
  stripeCardElement = elements.create('card', {
    style: {
      base: {
        fontFamily: 'Inter, sans-serif',
        fontSize: '15px',
        color: '#1F2937',
        '::placeholder': { color: '#9CA3AF' },
      },
      invalid: { color: '#EF4444' },
    },
    hidePostalCode: true, // NZ doesn't use ZIP
  });

  stripeCardElement.mount('#stripe-card-element');

  stripeCardElement.on('change', event => {
    const err = document.getElementById('stripe-card-errors');
    if (event.error) {
      err.textContent = event.error.message;
    } else {
      err.textContent = '';
    }
  });

  stripeCardMounted = true;

  // Payment Request Button (Apple Pay / Google Pay)
  await setupPaymentRequestButton(elements);
}

// ---------------------------------------------------------------------------
// Payment Request Button (Apple Pay / Google Pay via Stripe)
// ---------------------------------------------------------------------------
async function setupPaymentRequestButton(elements) {
  const totalAmount = state.calculatedTotal || 0;

  paymentRequest = stripe.paymentRequest({
    country: 'NZ',
    currency: 'nzd',
    total: {
      label: `Wonder World Westgate — ${state.selectedRoom?.name || 'Party Booking'}`,
      amount: Math.round(totalAmount * 100), // Stripe uses cents
    },
    requestPayerName:  true,
    requestPayerEmail: true,
    requestPayerPhone: true,
  });

  // Check if Apple Pay / Google Pay is available
  const canMakePayment = await paymentRequest.canMakePayment();

  if (canMakePayment) {
    prButton = elements.create('paymentRequestButton', {
      paymentRequest,
      style: {
        paymentRequestButton: {
          type: 'default',
          theme: 'dark',
          height: '52px',
        },
      },
    });
    prButton.mount('#payment-request-button');

    // Show divider
    document.getElementById('paymentRequestDivider').style.removeProperty('display');
    document.getElementById('paymentRequestDivider').style.display = 'flex';

    paymentRequest.on('paymentmethod', async (ev) => {
      await handlePaymentRequestPayment(ev);
    });
  } else {
    // Hide the payment request button container if not supported
    const prContainer = document.getElementById('payment-request-button');
    if (prContainer) prContainer.style.display = 'none';
  }
}

async function handlePaymentRequestPayment(ev) {
  try {
    // Create PaymentIntent server-side
    const { clientSecret } = await callEdgeFunction('create-payment-intent', {
      amount:      Math.round(state.calculatedTotal * 100),
      currency:    'nzd',
      bookingRef:  state.bookingRef || 'PENDING',
      customerEmail: state.user.email,
      metadata: {
        room:       state.selectedRoom?.id,
        date:       state.selectedDate,
        time:       state.selectedTime,
        guests:     String(state.guests),
        userId:     state.user.id,
      },
    });

    const { paymentIntent, error } = await stripe.confirmCardPayment(
      clientSecret,
      { payment_method: ev.paymentMethod.id },
      { handleActions: false }
    );

    if (error) {
      ev.complete('fail');
      showFieldError('Payment failed: ' + error.message);
      return;
    }

    if (paymentIntent.status === 'requires_action') {
      // Apple Pay / Google Pay may need 3D Secure
      const { error: actionError } = await stripe.confirmCardPayment(clientSecret);
      if (actionError) {
        ev.complete('fail');
        showFieldError('Payment failed: ' + actionError.message);
        return;
      }
    }

    ev.complete('success');
    state.stripePaymentIntentId = paymentIntent.id;
    state.calculatedTotal       = paymentIntent.amount / 100;

    goToStep(5);
  } catch (err) {
    ev.complete('fail');
    showFieldError('Payment error: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Standard card payment
// ---------------------------------------------------------------------------
async function processStripePayment() {
  if (!stripeCardElement) {
    showFieldError('Card form not ready. Please wait a moment and try again.');
    return;
  }

  const cardholderName = document.getElementById('cardholderName')?.value.trim();
  if (!cardholderName) {
    showFieldError('Please enter the name on your card.');
    return;
  }

  setPayBtnLoading(true);

  try {
    // 1. Create PaymentIntent via Edge Function (server keeps secret key)
    const { clientSecret } = await callEdgeFunction('create-payment-intent', {
      amount:        Math.round(state.calculatedTotal * 100),
      currency:      'nzd',
      bookingRef:    state.bookingRef || 'PENDING',
      customerEmail: state.user.email,
      metadata: {
        room:    state.selectedRoom?.id,
        date:    state.selectedDate,
        time:    state.selectedTime,
        guests:  String(state.guests),
        userId:  state.user.id,
      },
    });

    // 2. Confirm payment on the client
    const { paymentIntent, error } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card: stripeCardElement,
        billing_details: {
          name:  cardholderName,
          email: state.user.email,
        },
      },
    });

    if (error) {
      showFieldError('Payment declined: ' + error.message);
      await recordFailedPayment(error.message);
      return;
    }

    if (paymentIntent.status === 'succeeded') {
      state.stripePaymentIntentId = paymentIntent.id;
      state.calculatedTotal       = paymentIntent.amount / 100;
      goToStep(5);
    }
  } catch (err) {
    showFieldError('Payment error: ' + err.message);
  } finally {
    setPayBtnLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Record a failed payment attempt in Supabase
// ---------------------------------------------------------------------------
async function recordFailedPayment(reason) {
  try {
    await supabaseClient.from('payments').insert({
      user_id:   state.user.id || null,
      amount:    state.calculatedTotal,
      currency:  'nzd',
      status:    'failed',
      error_message: reason,
      metadata: {
        room:   state.selectedRoom?.id,
        date:   state.selectedDate,
        time:   state.selectedTime,
      },
    });
  } catch (_) { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setPayBtnLoading(loading) {
  const btn     = document.getElementById('payBtn');
  const text    = document.getElementById('payBtnText');
  const spinner = document.getElementById('payBtnSpinner');
  if (!btn) return;
  btn.disabled = loading;
  if (text)    text.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}
