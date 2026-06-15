/**
 * app.js
 * Core wizard logic:
 *   - Global state object
 *   - Step navigation & validation
 *   - Opening hours
 *   - FAQ accordion
 *   - Directions toggle
 *   - Confetti
 *   - Error toasts
 *   - Init
 */

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const state = {
  currentStep:    0,
  isAuthenticated: false,
  user:           {},
  guests:         10,
  selectedRoom:   null,
  partyRoomDbId:  null,
  selectedDate:   null,
  selectedTime:   null,
  slotHoldId:     null,
  isWeekend:      false,
  selectedFood:   null,
  allergyNotes:   '',
  allergies:      [],
  confirmEmail:   '',
  confirmPhone:   '',
  bookingRef:     '',
  stripePaymentIntentId: null,
  calculatedTotal: 0,
};

// ---------------------------------------------------------------------------
// Step labels
// ---------------------------------------------------------------------------
const STEP_LABELS = ['Account', 'Room', 'Date & Time', 'Food', 'Payment', 'Confirm'];

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------
async function goToStep(n) {
  // Validate current step before advancing
  if (n > state.currentStep) {
    if (!await validateStep(state.currentStep)) return;
  }

  const prev = document.getElementById(`step${state.currentStep}`);
  if (prev) prev.style.display = 'none';

  state.currentStep = n;

  const next = document.getElementById(`step${n}`);
  if (next) next.style.display = 'block';

  renderStepIndicator(n);

  // Timer management
  if (n === 2) startTimer();
  if (n === 0 || n === 6) stopTimer();
  if (n >= 5) stopTimer();

  // Step-specific hooks
  if (n === 4) {
    renderOrderSummary();
    // Mount Stripe elements after a short delay (DOM must be ready)
    setTimeout(mountStripeElements, 100);
  }

  if (n === 5) {
    const emailField = document.getElementById('confirmEmail');
    if (emailField && state.user.email) emailField.value = state.user.email;
    const phoneField = document.getElementById('confirmPhone');
    if (phoneField && state.user.phone) phoneField.value = state.user.phone.replace('+64', '').trim();
  }

  // Scroll to top of modal
  const box = document.getElementById('bookingBox');
  if (box) box.scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------
function renderStepIndicator(activeStep) {
  const el = document.getElementById('stepIndicator');
  if (!el) return;

  if (activeStep === 0 || activeStep === 6) {
    el.style.setProperty('display', 'none', 'important');
    return;
  }

  el.style.removeProperty('display');
  el.style.display = 'flex';
  el.style.alignItems = 'center';

  const steps = ['Room', 'Date', 'Food', 'Pay', 'Confirm'];
  let html = '';
  for (let i = 1; i <= 5; i++) {
    let cls = 'pending';
    if (i < activeStep) cls = 'done';
    if (i === activeStep) cls = 'active';
    const icon = cls === 'done' ? '✓' : i;
    html += `<div class="step-dot ${cls}">${icon}</div>`;
    if (i < 5) html += `<div class="step-line ${i < activeStep ? 'done' : ''}"></div>`;
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------
async function validateStep(n) {
  if (n === 0) {
    if (!state.isAuthenticated) {
      showFieldError('Please complete sign up or log in first.');
      return false;
    }
  }
  if (n === 1) {
    if (!state.selectedRoom) {
      showFieldError('Please select a party room.');
      return false;
    }
  }
  if (n === 2) {
    if (!state.selectedDate || !state.selectedTime) {
      showFieldError('Please select both a date and a time slot.');
      return false;
    }
    // Double-check slot is still available (race condition guard)
    const stillAvailable = await verifySlotAvailability();
    if (!stillAvailable) {
      showFieldError('Sorry — that slot was just taken! Please select another time.');
      state.selectedTime = null;
      document.getElementById('step2Next').disabled = true;
      await fetchAndRenderSlots(state.selectedDate);
      return false;
    }
  }
  if (n === 3) {
    if (!state.selectedFood) {
      showFieldError('Please choose a food option for your guests.');
      return false;
    }
  }
  return true;
}

// Verify slot is still available before proceeding to payment
async function verifySlotAvailability() {
  if (!state.partyRoomDbId || !state.selectedDate || !state.selectedTime) return true;

  const { data } = await supabaseClient
    .from('booking_timeslots')
    .select('id, status, hold_expires_at')
    .eq('party_room_id', state.partyRoomDbId)
    .eq('slot_date', state.selectedDate)
    .eq('slot_time', state.selectedTime)
    .single();

  if (!data) return true; // no record = available
  if (data.status === 'confirmed') return false;
  if (data.status === 'held') {
    // Our own hold is fine
    if (data.id === state.slotHoldId) return true;
    // Someone else's hold — check expiry
    return new Date(data.hold_expires_at) <= new Date();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Error toast
// ---------------------------------------------------------------------------
function showFieldError(msg) {
  const existing = document.getElementById('fieldError');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id        = 'fieldError';
  div.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-5 py-3 rounded-xl shadow-xl text-sm font-semibold z-[200] transition-all max-w-sm text-center';
  div.textContent = msg.startsWith('✅') ? msg : '⚠️ ' + msg;
  if (msg.startsWith('✅')) div.className = div.className.replace('bg-gray-900', 'bg-teal-600');

  document.body.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transition = 'opacity .3s';
    setTimeout(() => div.remove(), 300);
  }, 4000);
}

// ---------------------------------------------------------------------------
// Open / close booking overlay
// ---------------------------------------------------------------------------
function openBooking() {
  const overlay = document.getElementById('bookingOverlay');
  if (overlay) overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  resetWizard();
}

function closeBooking() {
  const overlay = document.getElementById('bookingOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  stopTimer();

  // Release slot hold if exists
  if (state.slotHoldId) {
    releaseSlotHold(state.slotHoldId);
  }
}

function handleOverlayClick(event) {
  if (event.target === document.getElementById('bookingOverlay')) {
    closeBooking();
  }
}

// ---------------------------------------------------------------------------
// Reset wizard
// ---------------------------------------------------------------------------
function resetWizard() {
  // Hide all steps
  for (let i = 0; i <= 6; i++) {
    const el = document.getElementById('step' + i);
    if (el) el.style.display = 'none';
  }

  // Reset Stripe card element
  if (stripeCardElement) {
    stripeCardElement.clear();
    stripeCardMounted = false;
    stripeCardElement = null;
  }
  if (prButton) {
    prButton = null;
  }

  // Reset state
  Object.assign(state, {
    currentStep: 0,
    guests: 10,
    selectedRoom: null,
    partyRoomDbId: null,
    selectedDate: null,
    selectedTime: null,
    slotHoldId: null,
    isWeekend: false,
    selectedFood: null,
    allergyNotes: '',
    allergies: [],
    confirmEmail: '',
    confirmPhone: '',
    bookingRef: '',
    stripePaymentIntentId: null,
    calculatedTotal: 0,
  });

  // Restore auth state (don't reset if already logged in)
  const step0 = document.getElementById('step0');
  if (step0) step0.style.display = 'block';

  // If user is already authenticated, skip to step 1
  if (state.isAuthenticated) {
    // Keep isAuthenticated and user
  }

  renderStepIndicator(0);
  stopTimer();
  renderRooms();

  // Reset guest counter
  const gc = document.getElementById('guestCount');
  if (gc) gc.textContent = '10';

  // Set min date
  const dateInput = document.getElementById('partyDate');
  if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.min   = today;
    dateInput.value = '';
  }

  // Reset time slot grid
  const tsg = document.getElementById('timeSlotGrid');
  if (tsg) tsg.innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">← Select a date first</div>';

  // Reset step1 next button
  const s1n = document.getElementById('step1Next');
  if (s1n) s1n.disabled = true;

  // If authenticated, skip to step 1 automatically
  if (state.isAuthenticated) {
    state.currentStep = 0; // will be set to 1 by goToStep
    setTimeout(() => {
      // Update auth step to show logged-in message
      const step0El = document.getElementById('step0');
      if (step0El) step0El.style.display = 'none';
      state.currentStep = 0;
      goToStep(1);
    }, 50);
  }
}

// ---------------------------------------------------------------------------
// Confetti
// ---------------------------------------------------------------------------
function launchConfetti() {
  const container = document.getElementById('confettiContainer');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#4F46E5','#0E9F6E','#F59E0B','#EC4899','#EF4444','#3B82F6'];
  for (let i = 0; i < 55; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.cssText = `
      left: ${Math.random() * 100}%;
      top: ${Math.random() * 30}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      animation-delay: ${Math.random() * 1.2}s;
      animation-duration: ${1.2 + Math.random()}s;
      transform: rotate(${Math.random() * 360}deg);
      width: ${6 + Math.random() * 8}px;
      height: ${6 + Math.random() * 8}px;
      border-radius: ${Math.random() > .5 ? '50%' : '2px'};
    `;
    container.appendChild(piece);
  }
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------
const HOURS = [
  { day: 'Wednesday – Saturday', hours: '8:30 AM – 8:30 PM', highlight: false },
  { day: 'Sunday',               hours: '8:30 AM – 5:30 PM', highlight: true, note: 'Peak day' },
  { day: 'Monday - Tuesday',     hours: '8:30 AM – 5:30 PM', highlight: false },
  { day: 'Public Holidays',      hours: 'SUBJECT TO CHANGE', highlight: false, muted: true },
];

function renderHours() {
  const table = document.getElementById('hoursTable');
  if (!table) return;
  const today = new Date().getDay();
  const todayIndex = today === 0 ? 1 : today >= 1 && today <= 2 ? 2 : 0;
  table.innerHTML = HOURS.map((row, i) => {
    const isToday   = i === todayIndex;
    const bgClass   = row.highlight ? 'bg-amber-50' : row.muted ? 'bg-gray-50' : 'bg-white';
    const textClass = row.muted ? 'text-gray-400' : row.highlight ? 'text-amber-700' : 'text-gray-900';
    const timeClass = row.muted ? 'text-gray-400' : row.highlight ? 'text-amber-600' : 'text-indigo-500';
    const todayBadge = isToday ? `<span class="ml-2 bg-teal text-white text-xs font-bold px-2 py-0.5 rounded-full" style="background:#0E9F6E">TODAY</span>` : '';
    const noteBadge  = row.note && !isToday ? `<span class="ml-2 text-amber-500 text-xs font-semibold">${row.note}</span>` : '';
    return `
      <div class="flex items-center justify-between px-6 py-4 ${bgClass}${isToday ? ' ring-2 ring-inset ring-teal-300' : ''}">
        <span class="font-semibold ${textClass} flex items-center">${row.day}${todayBadge}${noteBadge}</span>
        <span class="font-bold ${timeClass}">${row.hours}</span>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// FAQ accordion
// ---------------------------------------------------------------------------
const FAQ_DATA = [
  { q: "What's included in the party package?", a: "Every party includes exclusive use of your chosen room for 2 hours, a dedicated party host, tableware, decorations, and your choice of food for all guests. Complimentary soft drinks are provided for the birthday parents too!" },
  { q: "Can I bring my own birthday cake?", a: "Absolutely! You're welcome to bring your own cake. We'll provide plates, napkins, and candles — just let us know in advance if you need any special arrangements for cutting and serving." },
  { q: "How far in advance should I book?", a: "We recommend booking at least 3–4 weeks ahead, especially for weekend slots which fill up quickly. Holiday periods (school holidays, Christmas, Easter) can book out 6–8 weeks in advance, so get in early!" },
  { q: "What's the cancellation or rescheduling policy?", a: "Free cancellation or rescheduling up to 7 days before your party date. Within 7 days, a 50% fee applies. No-shows on the day are non-refundable. Contact us early and we'll always do our best to help." },
  { q: "Are parents and adults allowed to stay?", a: "Yes! Parents and caregivers are welcome to stay for the entire party. We have comfortable seating areas and complimentary tea and coffee for adults while the kids have the time of their lives." },
  { q: "Do you cater for dietary requirements and allergies?", a: "Definitely. We offer gluten-free, dairy-free, and nut-free options. Please note all dietary requirements during booking and our kitchen team will ensure every child is safely catered for." },
];

function renderFAQ() {
  const container = document.getElementById('faqAccordion');
  if (!container) return;
  container.innerHTML = FAQ_DATA.map((item, i) => `
    <div class="bg-white rounded-2xl border-2 border-gray-100 overflow-hidden">
      <button class="w-full flex items-center justify-between px-6 py-5 text-left hover:bg-gray-50 transition-colors" onclick="toggleFAQ(${i})">
        <span class="font-display font-semibold text-lg text-gray-900 pr-4">${item.q}</span>
        <span id="faqIcon${i}" class="flex-shrink-0 w-9 h-9 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-500 font-bold text-xl leading-none select-none">+</span>
      </button>
      <div id="faqBody${i}" style="max-height:0;overflow:hidden;transition:max-height .3s ease">
        <p class="text-gray-500 px-6 pb-5 leading-relaxed">${item.a}</p>
      </div>
    </div>`).join('');
}

function toggleFAQ(i) {
  FAQ_DATA.forEach((_, j) => {
    const b = document.getElementById(`faqBody${j}`);
    const ic = document.getElementById(`faqIcon${j}`);
    if (b)  b.style.maxHeight = '0';
    if (ic) ic.textContent = '+';
  });
  const body = document.getElementById(`faqBody${i}`);
  const icon = document.getElementById(`faqIcon${i}`);
  if (body && body.style.maxHeight === '0px' || (body && body.style.maxHeight === '')) {
    if (body) body.style.maxHeight = body.scrollHeight + 64 + 'px';
    if (icon) icon.textContent = '−';
  }
}

// ---------------------------------------------------------------------------
// Directions toggle
// ---------------------------------------------------------------------------
function toggleDirections() {
  const card = document.getElementById('directionsCard');
  if (!card) return;
  card.classList.toggle('hidden');
  if (!card.classList.contains('hidden')) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  renderHours();
  renderFAQ();
  renderRooms();

  const dateInput = document.getElementById('partyDate');
  if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.min = today;
  }
});
