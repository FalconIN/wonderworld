/**
 * firebase.js
 * Initialises Firebase Auth and provides shared helpers.
 * Replaces supabase.js — no Supabase dependency remains.
 *
 * Environment variables are injected at build/start time into window.__ENV__
 * by scripts/inject-env.js (same mechanism as before).
 */

// ---------------------------------------------------------------------------
// Firebase config (injected at runtime via window.__ENV__)
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey:            window.__ENV__?.FIREBASE_API_KEY            || '',
  authDomain:        window.__ENV__?.FIREBASE_AUTH_DOMAIN        || '',
  projectId:         window.__ENV__?.FIREBASE_PROJECT_ID         || '',
  storageBucket:     window.__ENV__?.FIREBASE_STORAGE_BUCKET     || '',
  messagingSenderId: window.__ENV__?.FIREBASE_MESSAGING_SENDER_ID || '',
  appId:             window.__ENV__?.FIREBASE_APP_ID             || '',
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// ---------------------------------------------------------------------------
// Stripe (unchanged)
// ---------------------------------------------------------------------------
const STRIPE_PK = window.__ENV__?.STRIPE_PK || window.__ENV__?.STRIPE_PUBLIC_KEY || '';
const stripe = Stripe(STRIPE_PK);

// ---------------------------------------------------------------------------
// API helper — calls local Express server
// Automatically attaches the Firebase ID token when a user is logged in.
// ---------------------------------------------------------------------------
async function callAPI(endpoint, body, method) {
  const user = auth.currentUser;
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
  // Map legacy Edge Function names to new Express endpoints
  const endpointMap = {
    'create-payment-intent':     'payments/create-intent',
    'send-booking-confirmation': 'notifications/booking-confirmation',
    'refund-payment':            'admin/payments/' + (body.paymentId || '_') + '/refund',
  };
  const endpoint = endpointMap[name];
  if (!endpoint) throw new Error('Unknown edge function: ' + name);
  return callAPI(endpoint, body);
}

// ---------------------------------------------------------------------------
// Helper: get the currently authenticated user (or null)
// ---------------------------------------------------------------------------
async function getCurrentUser() {
  return auth.currentUser;
}
