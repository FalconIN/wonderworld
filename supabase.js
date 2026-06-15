/**
 * supabase.js
 * Initialises the Supabase client using public env vars.
 * Secret keys NEVER live here — they belong in Edge Functions only.
 *
 * Environment variables are injected at build time by Vercel.
 * For local dev, create a `.env.local` file (see .env.example).
 */

// ---------------------------------------------------------------------------
// Public Supabase credentials (safe to expose in frontend JS)
// ---------------------------------------------------------------------------
const SUPABASE_URL  = window.__ENV__?.SUPABASE_URL  || 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON = window.__ENV__?.SUPABASE_ANON || window.__ENV__?.SUPABASE_ANON_KEY || 'YOUR_ANON_KEY';

// ---------------------------------------------------------------------------
// Stripe publishable key (safe to expose)
// ---------------------------------------------------------------------------
const STRIPE_PK = window.__ENV__?.STRIPE_PUBLIC_KEY || 'pk_live_YOUR_STRIPE_KEY';

// ---------------------------------------------------------------------------
// Supabase client singleton
// ---------------------------------------------------------------------------
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,       // keeps user logged in across page reloads
    autoRefreshToken: true,
    detectSessionInUrl: true,   // required for OAuth redirect handling
  },
});

// ---------------------------------------------------------------------------
// Stripe client singleton
// ---------------------------------------------------------------------------
const stripe = Stripe(STRIPE_PK);

// ---------------------------------------------------------------------------
// Helper: call a Supabase Edge Function
// ---------------------------------------------------------------------------
async function callEdgeFunction(name, body = {}) {
  const { data, error } = await supabaseClient.functions.invoke(name, { body });
  if (error) throw new Error(error.message);
  return data;
}

// ---------------------------------------------------------------------------
// Helper: get the currently authenticated user (or null)
// ---------------------------------------------------------------------------
async function getCurrentUser() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  return user;
}

// ---------------------------------------------------------------------------
// Realtime subscription helper
// ---------------------------------------------------------------------------
function subscribeToTable(table, filter, callback) {
  return supabaseClient
    .channel(`${table}_changes`)
    .on('postgres_changes', { event: '*', schema: 'public', table, filter }, callback)
    .subscribe();
}
