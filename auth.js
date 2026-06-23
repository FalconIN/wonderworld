/**
 * auth.js
 * Handles all authentication flows via Firebase Auth:
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
document.addEventListener('DOMContentLoaded', () => {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      await handleSignedInUser(user);

      // If booking modal was open before Google OAuth redirect, re-open it
      if (sessionStorage.getItem('ww_booking_intent')) {
        sessionStorage.removeItem('ww_booking_intent');
        openBooking();
        setTimeout(() => goToStep(1), 300);
      }
    } else {
      handleSignedOut();
    }
  });
});

// ---------------------------------------------------------------------------
// Handle a signed-in user: update app state + nav bar
// ---------------------------------------------------------------------------
async function handleSignedInUser(user) {
  let profile = null;
  try {
    profile = await callAPI('users/profile', null, 'GET');
  } catch (e) {
    // Profile may not exist yet for brand new users — that's fine
  }

  state.isAuthenticated = true;
  state.user = {
    id:        user.uid,
    email:     user.email,
    firstName: profile?.firstName || user.displayName?.split(' ')[0] || '',
    lastName:  profile?.lastName  || user.displayName?.split(' ').slice(1).join(' ') || '',
    phone:     profile?.phone     || '',
    isAdmin:   profile?.isAdmin   || false,
  };

  updateNavUI(true);

  if (typeof checkAfterPayReturn === 'function') checkAfterPayReturn();

  if (state.user.isAdmin) {
    document.querySelectorAll('[data-admin-only]').forEach(el => el.style.removeProperty('display'));
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
    showFieldError(translateFirebaseError(err.code) || err.message || 'Authentication failed.');
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

  if (!firstName || !lastName) throw new Error('Please enter your first and last name.');
  if (!email || !isValidEmail(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const cred = await auth.createUserWithEmailAndPassword(email, password);

  // Save profile to DB
  await callAPI('users/profile', { firstName, lastName, email });

  state.user = { id: cred.user.uid, email, firstName, lastName };
  state.isAuthenticated = true;

  // Send email verification (non-blocking)
  cred.user.sendEmailVerification().catch(() => {});

  goToStep(1);
}

// ---------------------------------------------------------------------------
// Log in with email/password
// ---------------------------------------------------------------------------
async function handleLogin() {
  const email    = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) throw new Error('Please enter your email and password.');

  await auth.signInWithEmailAndPassword(email, password);
  // onAuthStateChanged fires and calls handleSignedInUser() automatically
  goToStep(1);
}

// ---------------------------------------------------------------------------
// Google OAuth sign-in (popup, no redirect needed)
// ---------------------------------------------------------------------------
async function signInWithGoogle() {
  sessionStorage.setItem('ww_booking_intent', '1');

  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');

  try {
    const result = await auth.signInWithPopup(provider);
    const user   = result.user;
    const names  = (user.displayName || '').split(' ');

    // Upsert profile so DB has the Google display name
    await callAPI('users/profile', {
      firstName: names[0] || '',
      lastName:  names.slice(1).join(' ') || '',
      email:     user.email,
    });
  } catch (err) {
    sessionStorage.removeItem('ww_booking_intent');
    showFieldError(translateFirebaseError(err.code) || 'Google sign-in failed.');
  }
}

// ---------------------------------------------------------------------------
// Password reset email
// ---------------------------------------------------------------------------
async function sendPasswordReset() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  if (!email) { showFieldError('Enter your email address first.'); return; }

  try {
    await auth.sendPasswordResetEmail(email);
    showFieldError('✅ Password reset email sent — check your inbox!');
  } catch (err) {
    showFieldError(translateFirebaseError(err.code) || 'Password reset failed.');
  }
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------
async function signOut() {
  await auth.signOut();
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Upsert user profile (called from booking.js finaliseBooking)
// ---------------------------------------------------------------------------
async function upsertUserProfile(userId, firstName, lastName, email, phone = null) {
  try {
    await callAPI('users/profile', { firstName, lastName, email, phone });
  } catch (err) {
    console.error('Profile upsert error:', err);
  }
}

// ---------------------------------------------------------------------------
// View user's past bookings
// ---------------------------------------------------------------------------
async function viewMyBookings() {
  if (!state.isAuthenticated) { openBooking(); return; }

  let bookings = [];
  try {
    bookings = await callAPI('users/bookings', null, 'GET');
  } catch {
    showFieldError('Could not load bookings.');
    return;
  }

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
              <div class="font-display font-bold text-base">${b.roomEmoji || '🎉'} ${b.roomName || 'Party Room'}</div>
              <span class="badge ${b.status === 'confirmed' ? 'badge-green' : b.status === 'cancelled' ? 'badge-red' : 'badge-yellow'}">${b.status}</span>
            </div>
            <div class="grid grid-cols-2 gap-1 text-sm text-gray-600">
              <div>📅 ${b.partyDate} @ ${b.partyTime}</div>
              <div>👦 ${b.guestCount} kids</div>
              <div>🍕 ${escapeHtml(b.foodChoice) || '—'}</div>
              <div>💰 $${parseFloat(b.totalAmount).toFixed(2)} NZD</div>
            </div>
            <div class="mt-2 text-xs text-gray-400">Ref: ${b.bookingRef}</div>
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

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function translateFirebaseError(code) {
  const map = {
    'auth/invalid-credential':         'Incorrect email or password.',
    'auth/wrong-password':             'Incorrect email or password.',
    'auth/user-not-found':             'No account found with this email.',
    'auth/email-already-in-use':       'An account with this email already exists — log in instead.',
    'auth/weak-password':              'Password must be at least 8 characters.',
    'auth/too-many-requests':          'Too many attempts. Please wait a minute and try again.',
    'auth/network-request-failed':     'Network error — check your connection.',
    'auth/popup-closed-by-user':       'Sign-in cancelled.',
    'auth/cancelled-popup-request':    '',
  };
  return map[code] || null;
}
