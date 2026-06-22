// payment.js — Stripe Payment Element (card + Apple Pay + Google Pay + Afterpay)

let stripeElements = null;
let stripePaymentElement = null;
let stripeElementsMounted = false;
let clientSecret = null;

async function mountStripeElements() {
  if (stripeElementsMounted) return;

  const wrapper = document.getElementById('stripe-payment-wrapper');
  if (!wrapper) return;

  const totalAmount = state.calculatedTotal || 0;

  // Show loading state
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

  // Create the mount point fresh
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
    fields: {
      billingDetails: { address: 'auto' },
    },
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

  try {
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        return_url: window.location.origin,
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
      if (errEl) errEl.textContent = error.message || 'Payment failed. Please try again.';
      btn.disabled = false;
      btnText?.classList.remove('hidden');
      btnSpinner?.classList.add('hidden');
      return;
    }

    // Success
    state.stripePaymentIntentId = paymentIntent?.id || clientSecret.split('_secret_')[0];
    goToStep(5);

  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Payment failed.';
    btn.disabled = false;
    btnText?.classList.remove('hidden');
    btnSpinner?.classList.add('hidden');
  }
}

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