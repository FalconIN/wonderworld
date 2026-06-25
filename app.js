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
  addons:         {},
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

  const direction = n >= state.currentStep ? 'forward' : 'back';

  const prev = document.getElementById(`step${state.currentStep}`);
  if (prev) prev.style.display = 'none';

  state.currentStep = n;

  const next = document.getElementById(`step${n}`);
  if (next) {
    next.style.display = 'block';
    next.classList.remove('step-enter-forward', 'step-enter-back');
    void next.offsetWidth;
    next.classList.add(direction === 'forward' ? 'step-enter-forward' : 'step-enter-back');
  }

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
    const icon = cls === 'done'
      ? `<svg viewBox="0 0 14 14" width="13" height="13" fill="none"><path d="M2 7l4 4 6-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : i;
    html += `<div class="step-dot ${cls}" title="${steps[i-1]}">${icon}</div>`;
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
    if (!state.slotHoldId) {
      showFieldError('Still reserving your slot — please wait a moment and try again.');
      return false;
    }
  }
  if (n === 3) {
    const nuggets = parseInt(document.getElementById('nuggetCount')?.textContent) || 0;
    const burgers = parseInt(document.getElementById('burgerCount')?.textContent) || 0;
    const veges   = parseInt(document.getElementById('vegeCount')?.textContent) || 0;
    if (nuggets + burgers + veges !== state.guests) {
      showFieldError(`Food selection must add up to ${state.guests} kids. Currently ${nuggets + burgers + veges} selected.`);
      return false;
    }
    const parts = [];
    if (nuggets > 0) parts.push(nuggets + ' Nuggets');
    if (burgers > 0) parts.push(burgers + ' Mini Burgers');
    if (veges   > 0) parts.push(veges   + ' Vege Burgers');
    state.selectedFood = parts.join(' + ');
    const waiver = document.getElementById('liabilityWaiver');
    if (waiver && !waiver.checked) {
      showFieldError('Please read and accept the Terms of Entry & Liability Waiver to continue.');
      return false;
    }
  }
  return true;
}

// Verify slot is still available before proceeding to payment
async function verifySlotAvailability() {
  if (!state.partyRoomDbId || !state.selectedDate || !state.selectedTime) return true;
  try {
    const holdParam = state.slotHoldId ? `&excludeHoldId=${state.slotHoldId}` : '';
    const { unavailableSlots } = await callAPI(
      `slots?room_id=${state.partyRoomDbId}&date=${state.selectedDate}${holdParam}`,
      null, 'GET'
    );
    return !(unavailableSlots || []).includes(state.selectedTime);
  } catch {
    return true;
  }
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

  const box = document.getElementById('bookingBox');
  if (box) {
    box.classList.remove('modal-animate');
    void box.offsetWidth;
    box.classList.add('modal-animate');
  }
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
  // Reset Stripe Payment Element so it re-mounts fresh next time
  if (typeof resetPaymentElement === 'function') resetPaymentElement();

  // Hide all steps
  for (let i = 0; i <= 6; i++) {
    const el = document.getElementById('step' + i);
    if (el) el.style.display = 'none';
  }

  // Reset Stripe Payment Element
  if (typeof resetPaymentElement === 'function') resetPaymentElement();

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
    addons: {},
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

  // Reset addon quantity displays
  if (typeof ADDON_PRICES !== 'undefined') {
    Object.keys(ADDON_PRICES).forEach(id => {
      const el = document.getElementById('addon_' + id);
      if (el) el.textContent = '0';
    });
  }
  const addonSubtotalEl = document.getElementById('addonSubtotal');
  if (addonSubtotalEl) addonSubtotalEl.classList.add('hidden');

  // Reset food split counters
  const nuggetEl = document.getElementById('nuggetCount');
  const burgerEl = document.getElementById('burgerCount');
  const vegeEl   = document.getElementById('vegeCount');
  if (nuggetEl) nuggetEl.textContent = '0';
  if (burgerEl) burgerEl.textContent = '0';
  if (vegeEl)   vegeEl.textContent   = '0';
  const foodSplitTotal = document.getElementById('foodSplitTotal');
  if (foodSplitTotal) foodSplitTotal.textContent = '0 / 10 selected';
  const foodSplitError = document.getElementById('foodSplitError');
  if (foodSplitError) foodSplitError.classList.add('hidden');

  // Reset allergy fields
  const allergyNotes = document.getElementById('allergyNotes');
  if (allergyNotes) allergyNotes.value = '';
  ['allergyGluten', 'allergyDairy', 'allergyNuts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  const waiver = document.getElementById('liabilityWaiver');
  if (waiver) waiver.checked = false;

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
  const colors = ['#4F46E5','#0E9F6E','#F59E0B','#EC4899','#EF4444','#3B82F6','#8B5CF6','#F97316'];

  [0, 450].forEach(delay => {
    setTimeout(() => {
      for (let i = 0; i < 55; i++) {
        const piece = document.createElement('div');
        const isRibbon = Math.random() > 0.6;
        const size = 6 + Math.random() * 8;
        piece.style.cssText = `
          position:absolute;
          left:${Math.random() * 100}%;
          top:${Math.random() * 10}%;
          width:${isRibbon ? 4 : size}px;
          height:${isRibbon ? (12 + Math.random() * 8) : size}px;
          background:${colors[Math.floor(Math.random() * colors.length)]};
          border-radius:${Math.random() > 0.4 ? '50%' : '2px'};
          animation:confettiFall ${1.5 + Math.random() * 1.3}s ease-out ${i * 0.02}s forwards;
          transform:rotate(${Math.random() * 360}deg);
        `;
        container.appendChild(piece);
      }
    }, delay);
  });
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

  window.addEventListener('scroll', () => {
    const nav = document.querySelector('nav');
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 20);
  }, { passive: true });
});

// ---------------------------------------------------------------------------
// Food split (nuggets + burgers + vege must add up to guest count)
// ---------------------------------------------------------------------------
function changeFoodSplit(type, delta) {
  const total   = state.guests;
  const nuggets = parseInt(document.getElementById('nuggetCount').textContent) || 0;
  const burgers = parseInt(document.getElementById('burgerCount').textContent) || 0;
  const veges   = parseInt(document.getElementById('vegeCount').textContent)   || 0;

  const current = type === 'nuggets' ? nuggets : type === 'burgers' ? burgers : veges;
  const others  = total - current;
  const next    = Math.max(0, Math.min(current + delta, others));

  if (type === 'nuggets')      document.getElementById('nuggetCount').textContent = next;
  else if (type === 'burgers') document.getElementById('burgerCount').textContent = next;
  else                         document.getElementById('vegeCount').textContent   = next;

  const n = type === 'nuggets' ? next : nuggets;
  const b = type === 'burgers' ? next : burgers;
  const v = type === 'veges'   ? next : veges;
  const newTotal = n + b + v;

  const totalEl = document.getElementById('foodSplitTotal');
  const ofEl    = document.getElementById('foodSplitOf');
  if (totalEl) totalEl.textContent = `${newTotal} / ${total} selected`;
  if (ofEl)    ofEl.textContent = total;

  const errEl = document.getElementById('foodSplitError');
  if (newTotal === total) {
    if (errEl) errEl.classList.add('hidden');
    const parts = [];
    if (n > 0) parts.push(n + ' Nuggets');
    if (b > 0) parts.push(b + ' Mini Burgers');
    if (v > 0) parts.push(v + ' Vege Burgers');
    state.selectedFood = parts.join(' + ');
  } else {
    state.selectedFood = null;
  }
}

function initFoodSplit() {
  const total = state.guests;
  const targetEl = document.getElementById('foodGuestTarget');
  const ofEl     = document.getElementById('foodSplitOf');
  const totalEl  = document.getElementById('foodSplitTotal');
  if (targetEl) targetEl.textContent = total;
  if (ofEl)     ofEl.textContent = total;
  if (totalEl)  totalEl.textContent = `0 / ${total} selected`;
  const nuggetEl = document.getElementById('nuggetCount');
  const burgerEl = document.getElementById('burgerCount');
  const vegeEl   = document.getElementById('vegeCount');
  if (nuggetEl) nuggetEl.textContent = '0';
  if (burgerEl) burgerEl.textContent = '0';
  if (vegeEl)   vegeEl.textContent   = '0';
  state.selectedFood = null;
}