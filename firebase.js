/**
 * firebase.js
 * Fetches client config from /api/config at load time (synchronous XHR so
 * inline scripts that immediately use `auth` or `stripe` keep working), then
 * initialises Firebase Auth and Stripe.
 */

(function () {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/config', false); // synchronous — blocks until response arrives
  xhr.send();

  if (xhr.status !== 200) {
    console.error('[firebase.js] Could not load /api/config — status ' + xhr.status);
    return;
  }

  const cfg = JSON.parse(xhr.responseText);

  firebase.initializeApp({
    apiKey:            cfg.FIREBASE_API_KEY,
    authDomain:        cfg.FIREBASE_AUTH_DOMAIN,
    projectId:         cfg.FIREBASE_PROJECT_ID,
    storageBucket:     cfg.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: cfg.FIREBASE_MESSAGING_SENDER_ID,
    appId:             cfg.FIREBASE_APP_ID,
  });

  // Expose Stripe PK via a temporary global so the Stripe() call below can use it
  window.__stripePk = cfg.STRIPE_PK || '';
})();

const auth   = firebase.auth();
const stripe = Stripe(window.__stripePk || '');
delete window.__stripePk; // clean up — not needed after init

// ---------------------------------------------------------------------------
// API helper — attaches the Firebase ID token to every request
// ---------------------------------------------------------------------------
async function callAPI(endpoint, body, method) {
  const user  = auth.currentUser;
  const token = user ? await user.getIdToken() : null;

  const m = method || (body !== undefined && body !== null ? 'POST' : 'GET');
  const isBodyless = (m === 'GET' || m === 'DELETE');

  const options = {
    method: m,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  };

  if (!isBodyless && body != null) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch('/api/' + endpoint, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

// Alias kept for compatibility with payment.js / booking.js call sites
async function callEdgeFunction(name, body = {}) {
  const endpointMap = {
    'create-payment-intent':     'payments/create-intent',
    'send-booking-confirmation': 'notifications/booking-confirmation',
    'refund-payment':            'admin/payments/' + (body.paymentId || '_') + '/refund',
  };
  const endpoint = endpointMap[name];
  if (!endpoint) throw new Error('Unknown edge function: ' + name);
  return callAPI(endpoint, body);
}

async function getCurrentUser() {
  return auth.currentUser;
}
