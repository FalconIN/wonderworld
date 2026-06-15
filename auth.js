/**
 * auth.js
 * Handles all authentication flows:
 *   - Email/password sign-up (with email verification)
 *   - Email/password log-in
 *   - Google OAuth (Sign in with Google)
 *   - Password reset email
 *   - Session persistence & nav UI updates
 *   - Sign-out
 */

// ---------------------------------------------------------------------------
// On page load — restore session & update nav
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  // Listen for auth state changes (login, logout, token refresh)
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      await handleSignedInUser(session.user);
    }
    if (event === 'SIGNED_OUT') {
      handleSignedOut();
    }
    // Handle OAuth redirect for Google sign-in
    if (event === 'SIGNED_IN' && session?.provider_token) {
      // User came back from Google OAuth
      await handleSignedInUser(session.user);
      // If booking modal was open before OAuth, re-open and advance
      if (sessionStorage.getItem('ww_booking_intent')) {
        sessionStorage.removeItem('ww_booking_intent');
        openBooking();
        state.isAuthenticated = true;
        state.user = {
          id: session.user.id,
          email: session.user.email,
          firstName: session.user.user_metadata?.full_name?.split(' ')[0] || '',
          lastName: session.user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '',
        };
        setTimeout(() => goToStep(1), 300);
      }
    }
  });

  // Check for existing session on page load
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await handleSignedInUser(session.user);
  }
});

// ---------------------------------------------------------------------------
// Handle a signed-in user: update app state + nav bar
// ---------------------------------------------------------------------------
async function handleSignedInUser(user) {
  // Fetch extended profile from our users table
  const { data: profile } = await supabaseClient
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  state.isAuthenticated = true;
  state.user = {
    id: user.id,
    email: user.email,
    firstName: profile?.first_name || user.user_metadata?.full_name?.split(' ')[0] || '',
    lastName: profile?.last_name || user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '',
    phone: profile?.phone || '',
    isAdmin: profile?.is_admin || false,
  };

  updateNavUI(true);

  // Show admin link in footer if admin
  if (state.user.isAdmin) {
    const adminLinks = document.querySelectorAll('[data-admin-only]');
    adminLinks.forEach(el => el.style.removeProperty('display'));
  }
}

// ---------------------------------------------------------------------------
// Handle signed-out: reset state + nav
// ---------------------------------------------------------------------------
function handleSignedOut() {
  state.isAuthenticated = false;
  state.user = {};
  updateNavUI(false);
}

// ---------------------------------------------------------------------------
// Nav bar UI based on auth state
// ---------------------------------------------------------------------------
function updateNavUI(isLoggedIn) {
  const navArea = document.getElementById('navAuthArea');
  if (!navArea) return;

  if (isLoggedIn) {
    navArea.innerHTML = `
      <div class="flex items-center gap-3">
        <button onclick="viewMyBookings()" class="text-sm font-semibold text-gray-600 hover:text-indigo-500 transition-colors hidden md:block">
          My Bookings
        </button>
        <div class="relative group">
          <button class="flex items-center gap-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl px-4 py-2 text-sm font-semibold transition-all">
            <span class="w-7 h-7 rounded-full bg-indigo-500 text-white flex items-center justify-center text-xs font-bold">
              ${(state.user.firstName?.[0] || state.user.email?.[0] || 'U').toUpperCase()}
            </span>
            <span class="hidden sm:block">${state.user.firstName || 'Account'}</span>
          </button>
          <div class="absolute right-0 top-full mt-2 w-48 bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
            <div class="px-4 py-3 border-b border-gray-100">
              <div class="text-xs text-gray-400 font-medium">Signed in as</div>
              <div class="text-sm font-semibold text-gray-800 truncate">${state.user.email}</div>
            </div>
            <button onclick="openBooking()" class="w-full text-left px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition-colors">🎉 Book a Party</button>
            <button onclick="viewMyBookings()" class="w-full text-left px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition-colors">📋 My Bookings</button>
            ${state.user.isAdmin ? `<a href="/admin.html" class="block px-4 py-3 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors">🔧 Admin Dashboard</a>` : ''}
            <button onclick="signOut()" class="w-full text-left px-4 py-3 text-sm text-red-500 hover:bg-red-50 transition-colors border-t border-gray-100">Sign Out</button>
          </div>
        </div>
      </div>`;
  } else {
    navArea.innerHTML = `<button onclick="openBooking()" class="btn-primary text-sm py-2.5 px-5">Book a Party 🎉</button>`;
  }
}

// ---------------------------------------------------------------------------
// Switch auth tab (signup / login)
// ---------------------------------------------------------------------------
function switchAuth(mode) {
  const isSignup = mode === 'signup';
  document.getElementById('signupFields').style.display = isSignup ? 'block' : 'none';
  document.getElementById('loginFields').style.display  = isSignup ? 'none'  : 'block';

  const tabS = document.getElementById('tabSignup');
  const tabL = document.getElementById('tabLogin');

  if (isSignup) {
    tabS.className = 'flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all bg-white shadow-sm text-gray-900';
    tabL.className = 'flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all text-gray-500';
    document.getElementById('authBtnText').textContent = 'Create My Account & Continue →';
  } else {
    tabL.className = 'flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all bg-white shadow-sm text-gray-900';
    tabS.className = 'flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all text-gray-500';
    document.getElementById('authBtnText').textContent = 'Log In & Continue →';
  }
}

// ---------------------------------------------------------------------------
// Submit auth form (signup or login)
// ---------------------------------------------------------------------------
async function submitAuth() {
  const isSignup = document.getElementById('signupFields').style.display !== 'none';
  setAuthLoading(true);

  try {
    if (isSignup) {
      await handleSignup();
    } else {
      await handleLogin();
    }
  } catch (err) {
    showFieldError(err.message || 'Authentication failed. Please try again.');
  } finally {
    setAuthLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Sign up with email/password
// ---------------------------------------------------------------------------
async function handleSignup() {
  const firstName = document.getElementById('authFirstName').value.trim();
  const lastName  = document.getElementById('authLastName').value.trim();
  const email     = document.getElementById('authEmail').value.trim().toLowerCase();
  const password  = document.getElementById('authPassword').value;

  // Client-side validation
  if (!firstName || !lastName) throw new Error('Please enter your first and last name.');
  if (!email || !isValidEmail(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: { first_name: firstName, last_name: lastName },
      emailRedirectTo: `${window.location.origin}/`,
    },
  });

  if (error) throw new Error(translateSupabaseError(error.message));

  if (data.user && !data.session) {
    // Email confirmation required
    showFieldError('✅ Check your inbox! Click the verification link to confirm your account, then log in.');
    switchAuth('login');
    return;
  }

  // Auto-confirmed (e.g. dev mode) — upsert profile row
  if (data.user) {
    await upsertUserProfile(data.user.id, firstName, lastName, email);
    state.user = { id: data.user.id, email, firstName, lastName };
    state.isAuthenticated = true;
    goToStep(1);
  }
}

// ---------------------------------------------------------------------------
// Log in with email/password
// ---------------------------------------------------------------------------
async function handleLogin() {
  const email    = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) throw new Error('Please enter your email and password.');

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) throw new Error(translateSupabaseError(error.message));

  // onAuthStateChange fires and calls handleSignedInUser() automatically
  goToStep(1);
}

// ---------------------------------------------------------------------------
// Google OAuth sign-in
// ---------------------------------------------------------------------------
async function signInWithGoogle() {
  // Save intent so we can re-open the booking modal after OAuth redirect
  sessionStorage.setItem('ww_booking_intent', '1');

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/`,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  });

  if (error) showFieldError('Google sign-in failed: ' + error.message);
}

// ---------------------------------------------------------------------------
// Password reset email
// ---------------------------------------------------------------------------
async function sendPasswordReset() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  if (!email) { showFieldError('Enter your email address first.'); return; }

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/?reset=1`,
  });

  if (error) {
    showFieldError('Password reset failed: ' + error.message);
  } else {
    showFieldError('✅ Password reset email sent — check your inbox!');
  }
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------
async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Upsert user profile in our custom users table
// ---------------------------------------------------------------------------
async function upsertUserProfile(userId, firstName, lastName, email, phone = null) {
  const { error } = await supabaseClient
    .from('users')
    .upsert({
      id: userId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (error) console.error('Profile upsert error:', error);
}

// ---------------------------------------------------------------------------
// View user's past bookings (opens a simple modal)
// ---------------------------------------------------------------------------
async function viewMyBookings() {
  if (!state.isAuthenticated) { openBooking(); return; }

  const { data: bookings, error } = await supabaseClient
    .from('bookings')
    .select(`
      id, booking_ref, party_date, party_time, guest_count,
      food_choice, total_amount, status, created_at,
      party_rooms ( name, emoji )
    `)
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) { showFieldError('Could not load bookings.'); return; }

  // Build modal HTML
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'myBookingsOverlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:640px;max-height:85vh;overflow-y:auto" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-6">
        <h2 class="font-display font-bold text-2xl text-gray-900">My Bookings 📋</h2>
        <button onclick="document.getElementById('myBookingsOverlay').remove()" class="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200">×</button>
      </div>
      ${bookings.length === 0 ? '<p class="text-gray-400 text-center py-8">No bookings yet — let\'s fix that! 🎉</p>' :
        bookings.map(b => `
          <div class="border-2 border-gray-100 rounded-2xl p-4 mb-3">
            <div class="flex items-center justify-between mb-2">
              <div class="font-display font-bold text-base">${b.party_rooms?.emoji || '🎉'} ${b.party_rooms?.name || 'Party Room'}</div>
              <span class="badge ${b.status === 'confirmed' ? 'badge-green' : b.status === 'cancelled' ? 'badge-red' : 'badge-yellow'}">${b.status}</span>
            </div>
            <div class="grid grid-cols-2 gap-1 text-sm text-gray-600">
              <div>📅 ${b.party_date} @ ${b.party_time}</div>
              <div>👦 ${b.guest_count} kids</div>
              <div>🍕 ${b.food_choice || '—'}</div>
              <div>💰 $${parseFloat(b.total_amount).toFixed(2)} NZD</div>
            </div>
            <div class="mt-2 text-xs text-gray-400">Ref: ${b.booking_ref}</div>
          </div>`).join('')}
      <button onclick="openBooking(); document.getElementById('myBookingsOverlay').remove();" class="btn-primary w-full mt-4">Book Another Party 🎂</button>
    </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setAuthLoading(loading) {
  const btn     = document.getElementById('authSubmitBtn');
  const text    = document.getElementById('authBtnText');
  const spinner = document.getElementById('authBtnSpinner');
  if (!btn) return;
  btn.disabled = loading;
  if (text)    text.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function translateSupabaseError(msg) {
  if (!msg) return 'An unknown error occurred.';
  if (msg.includes('Invalid login credentials'))   return 'Incorrect email or password.';
  if (msg.includes('Email not confirmed'))          return 'Please verify your email before logging in.';
  if (msg.includes('User already registered'))      return 'An account with this email already exists — log in instead.';
  if (msg.includes('Password should be at least'))  return 'Password must be at least 8 characters.';
  if (msg.includes('rate limit'))                   return 'Too many attempts. Please wait a minute and try again.';
  return msg;
}
