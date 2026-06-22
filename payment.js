// payment.js — Stripe Payment Element (supports card, Apple Pay, Google Pay, Afterpay, Link, etc.)

let stripeElements = null;
let stripePaymentElement = null;
let stripeElementsMounted = false;
let clientSecret = null;

// ---------------------------------------------------------------------------
// Mount Stripe Payment Element when step 4 is shown
// ---------------------------------------------------------------------------
async function mountStripeElements() {
  if (stripeElementsMounted) return;

  const totalAmount = state.calculatedTotal || 0;

  // Create a PaymentIntent first — the Payment Element needs the client secret
  // upfront (unlike the legacy card element which could create it on submit)
  try {
    const result = await callEdgeFunction('create-payment-intent', {
      amount:         Math.round(totalAmount * 100),
      currency:       'nzd',
      bookingRef:     state.bookingRef || 'PENDING',
      customerEmail:  state.user?.email || '',
      metadata: {
        room:   state.selectedRoom?.name || '',
        date:   state.selectedDate || '',
        time:   state.selectedTime || '',
        guests: state.guests,
      },
    });

    clientSecret = result.clientSecret;
  } catch (err) {
    const errEl = document.getElementById('stripe-payment-errors');
    if (errEl) errEl.textContent = 'Failed to load payment form: ' + err.message;
    return;
  }

  // Mount the unified Payment Element
  stripeElements = stripe.elements({
    clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#4F46E5',
        colorBackground: '#ffffff',
        colorText: '#1F2937',
        colorDanger: '#EF4444',
        fontFamily: 'Inter, sans-serif',
        borderRadius: '12px',
        spacingUnit: '4px',
      },
    },
  });

  stripePaymentElement = stripeElements.create('payment', {
    layout: { type: 'tabs', defaultCollapsed: false },
    fields: {
      billingDetails: {
        address: 'auto', // collect address when required by payment method (e.g. Afterpay)
      },
    },
    defaultValues: {
      billingDetails: {
        email: state.user?.email || '',
        name: `${state.user?.firstName || ''} ${state.user?.lastName || ''}`.trim(),
        address: {
          country: 'NZ',
        },
      },
    },
  });

  stripePaymentElement.mount('#stripe-payment-element');
  stripeElementsMounted = true;
}

// ---------------------------------------------------------------------------
// Process payment on "Pay & Confirm" click
// ---------------------------------------------------------------------------
async function processStripePayment() {
  if (!stripeElements || !clientSecret) {
    showFieldError('Payment form not loaded. Please try again.');
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

  try {
    // Confirm the payment — Stripe handles all method types automatically
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        return_url: window.location.href, // fallback for redirect-based methods
        payment_method_data: {
          billing_details: {
            email: state.user?.email || state.confirmEmail || '',
            name:  `${state.user?.firstName || ''} ${state.user?.lastName || ''}`.trim(),
          },
        },
      },
      redirect: 'if_required', // stay on page for card/Afterpay; redirect only if needed (e.g. bank redirect methods)
    });

    if (confirmError) {
      if (errEl) errEl.textContent = confirmError.message || 'Payment failed.';
      btn.disabled = false;
      btnText?.classList.remove('hidden');
      btnSpinner?.classList.add('hidden');
      return;
    }

    // Payment succeeded — move to contact details step
    state.stripePaymentIntentId = paymentIntent?.id || clientSecret.split('_secret_')[0];
    goToStep(5);

  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Payment failed.';
    btn.disabled = false;
    btnText?.classList.remove('hidden');
    btnSpinner?.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Reset payment element when wizard is reset (e.g. closing/reopening modal)
// ---------------------------------------------------------------------------
function resetPaymentElement() {
  if (stripePaymentElement) {
    stripePaymentElement.unmount();
    stripePaymentElement = null;
  }
  stripeElements = null;
  stripeElementsMounted = false;
  clientSecret = null;
}
