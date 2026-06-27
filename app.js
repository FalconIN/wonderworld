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

const NZ_TZ = 'Pacific/Auckland';
function nzDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NZ_TZ }).format(d);
}
function nzGetDay(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: NZ_TZ, weekday: 'short' }).format(d);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(s);
}

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
  sodaTypes:      {},
  confirmEmail:   '',
  confirmPhone:   '',
  bookingRef:     '',
  bookingId:      null,
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

  if (n === 6) {
    // Show edit banner if >48hrs away; otherwise hide it
    const banner = document.getElementById('editBookingBanner');
    if (banner && state.selectedDate && state.selectedTime) {
      const hrs = getHoursUntilParty(state.selectedDate, state.selectedTime);
      banner.classList.toggle('hidden', hrs <= 48);
    }
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

    // Pizza type validation
    const pizzaQty = state.addons?.pizza_11 || 0;
    if (pizzaQty > 0) {
      const pizzaPicked = state.pizzaTypes ? Object.values(state.pizzaTypes).reduce((s, v) => s + v, 0) : 0;
      if (pizzaPicked < pizzaQty) {
        const errEl = document.getElementById('pizzaTypeError');
        if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        showFieldError('Please choose a type of pizza before continuing.');
        return false;
      }
    }
    const pizzaErr = document.getElementById('pizzaTypeError');
    if (pizzaErr) pizzaErr.classList.add('hidden');

    // Soda type validation
    const sodaQty = state.addons?.drinks_soda || 0;
    if (sodaQty > 0) {
      const sodaPicked = state.sodaTypes ? Object.values(state.sodaTypes).reduce((s, v) => s + v, 0) : 0;
      if (sodaPicked < sodaQty) {
        const errEl = document.getElementById('sodaTypeError');
        if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        showFieldError(`Please choose a flavour for all ${sodaQty} soft drink${sodaQty > 1 ? 's' : ''} before continuing.`);
        return false;
      }
    }
    const sodaErr = document.getElementById('sodaTypeError');
    if (sodaErr) sodaErr.classList.add('hidden');

    // Juice type validation
    const juiceQty = state.addons?.drinks_juice || 0;
    if (juiceQty > 0) {
      const juicePicked = state.juiceTypes ? Object.values(state.juiceTypes).reduce((s, v) => s + v, 0) : 0;
      if (juicePicked < juiceQty) {
        const errEl = document.getElementById('juiceTypeError');
        if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        showFieldError('Please choose a flavour of juice before continuing.');
        return false;
      }
    }
    const juiceErr = document.getElementById('juiceTypeError');
    if (juiceErr) juiceErr.classList.add('hidden');

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
    sodaTypes: [],
    confirmEmail: '',
    confirmPhone: '',
    bookingRef: '',
    bookingId: null,
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
    const today = nzDateStr();
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
  const today = nzGetDay();
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
  { q: "What's included in the party package?", a: "Every party includes exclusive use of your chosen room for 90 minutes, a dedicated party host, tableware, decorations, and your choice of food for all guests. Complimentary soft drinks are provided for the birthday parents too!" },
  { q: "Can I bring my own birthday cake?", a: "Absolutely! You're welcome to bring your own cake. We'll provide plates and napkins — just let us know in advance if you need any special arrangements for cutting and serving." },
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
    const today = nzDateStr();
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
  const next    = Math.max(0, current + delta);

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

  // Disable all + buttons when combined total hits the guest count
  const atMax = newTotal >= total;
  ['nuggetPlus', 'burgerPlus', 'vegePlus'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = atMax;
  });

  if (newTotal === total) {
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
  ['nuggetPlus', 'burgerPlus', 'vegePlus'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = false;
  });
  state.selectedFood = null;
}

// ══════════════════════════════════════════════════════════════════════════════
// MY BOOKINGS (override auth.js version to add edit buttons + policy banner)
// ══════════════════════════════════════════════════════════════════════════════
async function viewMyBookings() {
  if (!state.isAuthenticated) { openBooking(); return; }

  let bookings = [];
  try {
    bookings = await callAPI('users/bookings', null, 'GET');
  } catch {
    showFieldError('Could not load bookings.');
    return;
  }

  const hoursUntil = b => {
    const t = {'9:30 AM':'09:30','11:30 AM':'11:30','1:30 PM':'13:30','3:30 PM':'15:30'}[b.partyTime] || '12:00';
    return (new Date(`${b.partyDate}T${t}:00`) - new Date()) / 3600000;
  };

  const bookingCards = bookings.length === 0
    ? '<p class="text-gray-400 text-center py-8">No bookings yet — let\'s fix that! 🎉</p>'
    : bookings.map(b => {
        const hrs = hoursUntil(b);
        const isUpcoming = hrs > 0 && b.status === 'confirmed';
        let editBtnHtml = '';
        if (isUpcoming && hrs > 48) {
          editBtnHtml = `<button onclick="document.getElementById('myBookingsOverlay').remove(); openEditBooking('${b.id}')" class="mt-3 w-full text-center text-sm font-semibold text-indigo-600 hover:text-indigo-800 border-2 border-indigo-200 hover:border-indigo-400 rounded-xl py-2 transition-all">✏️ Edit Booking</button>`;
        } else if (isUpcoming && hrs >= 24) {
          editBtnHtml = `<button onclick="document.getElementById('myBookingsOverlay').remove(); openEditBooking('${b.id}')" class="mt-3 w-full text-center text-sm font-semibold text-amber-700 border-2 border-amber-300 rounded-xl py-2 transition-all hover:bg-amber-50">⚠️ Edit Booking (last chance — under 48hrs)</button>`;
        } else if (isUpcoming) {
          editBtnHtml = `<div class="mt-3 text-center text-xs text-gray-400 bg-gray-50 rounded-xl py-2">🚫 Edits not available within 24 hours of your party</div>`;
        }
        return `
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
            ${b.addonsSummary ? `<div class="mt-1 text-xs text-gray-400 truncate">Add-ons: ${escapeHtml(b.addonsSummary)}</div>` : ''}
            <div class="mt-1 text-xs text-gray-400">Ref: ${b.bookingRef}</div>
            ${editBtnHtml}
          </div>`;
      }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'myBookingsOverlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:640px;max-height:85vh;overflow-y:auto" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-display font-bold text-2xl text-gray-900">My Bookings 📋</h2>
        <button onclick="document.getElementById('myBookingsOverlay').remove()" class="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 text-xl">×</button>
      </div>
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-xs text-amber-700">
        ✏️ Need to make changes? You can edit your booking up to 48 hours before your party. Changes within 24 hours of your party cannot be accepted.
      </div>
      ${bookingCards}
      <button onclick="openBooking(); document.getElementById('myBookingsOverlay').remove();" class="btn-primary w-full mt-4">Book Another Party 🎂</button>
    </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════════════════════════════════════════
// EDIT BOOKING — state, helpers, UI
// ══════════════════════════════════════════════════════════════════════════════

const editState = {
  booking: null,
  newGuestCount: 0,
  editNuggets: 0, editBurgers: 0, editVeges: 0,
  newAddons: {},
  newPizzaTypes: {}, newSodaTypes: {}, newJuiceTypes: {},
  savedCard: null,
  deltaAmount: 0,
  editElements: null,
  editClientSecret: null,
  editElementsMounted: false,
  paymentMode: 'new',
};

function getPartyDatetime(partyDate, partyTime) {
  const t24 = {'9:30 AM':'09:30','11:30 AM':'11:30','1:30 PM':'13:30','3:30 PM':'15:30'}[partyTime] || '12:00';
  return new Date(`${partyDate}T${t24}:00`);
}

function getHoursUntilParty(partyDate, partyTime) {
  return (getPartyDatetime(partyDate, partyTime) - new Date()) / 3600000;
}

function openEditBookingFromStep6() {
  if (!state.bookingId) return;
  closeBooking();
  setTimeout(() => openEditBooking(state.bookingId), 200);
}

async function openEditBooking(bookingId) {
  const overlay = document.getElementById('editBookingOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const box = document.getElementById('editBookingBox');
  if (box) { box.classList.remove('modal-animate'); void box.offsetWidth; box.classList.add('modal-animate'); }

  document.getElementById('editBookingContent').innerHTML = `
    <div class="text-center py-12 text-gray-400">
      <svg class="animate-spin h-8 w-8 mx-auto mb-3 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
      Loading booking details...
    </div>`;

  try {
    const [booking, savedCardRes] = await Promise.all([
      callAPI(`bookings/${bookingId}`, null, 'GET'),
      callAPI('payments/saved-card', null, 'GET').catch(() => ({ hasSavedCard: false })),
    ]);
    renderEditStep1(booking, savedCardRes);
  } catch (err) {
    document.getElementById('editBookingContent').innerHTML = `
      <div class="text-center py-8 text-red-500">
        <div class="text-4xl mb-3">⚠️</div>
        <p class="font-semibold">Could not load booking details.</p>
        <p class="text-sm mt-1 text-gray-500">${err.message}</p>
        <button onclick="closeEditBooking()" class="btn-secondary mt-4 py-2 px-6">Close</button>
      </div>`;
  }
}

function closeEditBooking() {
  const overlay = document.getElementById('editBookingOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  if (editState.editElements) {
    try {
      const pe = editState.editElements.getElement('payment');
      if (pe) pe.unmount();
    } catch (e) {}
    editState.editElements = null;
  }
  editState.editClientSecret = null;
  editState.editElementsMounted = false;
  Object.assign(editState, {
    booking: null, newGuestCount: 0,
    editNuggets: 0, editBurgers: 0, editVeges: 0,
    newAddons: {}, newPizzaTypes: {}, newSodaTypes: {}, newJuiceTypes: {},
    savedCard: null, deltaAmount: 0, paymentMode: 'new',
  });
}

function handleEditOverlayClick(event) {
  if (event.target === document.getElementById('editBookingOverlay')) closeEditBooking();
}

// ── Edit step 1: Edit form ─────────────────────────────────────────────
function renderEditStep1(booking, savedCardInfo) {
  editState.booking = booking;
  editState.newGuestCount = booking.guestCount;
  editState.newAddons = {};
  editState.newPizzaTypes = {}; editState.newSodaTypes = {}; editState.newJuiceTypes = {};
  editState.editNuggets = 0; editState.editBurgers = 0; editState.editVeges = 0;
  editState.savedCard = savedCardInfo?.hasSavedCard ? savedCardInfo : null;
  editState.paymentMode = editState.savedCard ? 'saved' : 'new';

  const hours = getHoursUntilParty(booking.partyDate, booking.partyTime);

  if (hours < 24) {
    document.getElementById('editBookingContent').innerHTML = `
      <div class="text-center py-8">
        <div class="text-5xl mb-3">🚫</div>
        <h2 class="font-display font-bold text-xl text-gray-900 mb-2">Changes not available</h2>
        <p class="text-gray-500 text-sm">Edits cannot be accepted within 24 hours of your party.</p>
        <button onclick="closeEditBooking()" class="btn-secondary mt-6 py-2 px-6">Close</button>
      </div>`;
    return;
  }

  const maxGuests = parseInt(booking.roomMaxGuests) || 24;
  const pricePerChild = parseFloat(booking.pricePerChild) || 39;

  const bannerHtml = hours < 48
    ? `<div class="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 mb-5 text-sm text-amber-800">
        <div class="flex items-center gap-2 mb-1"><span class="text-base">⚠️</span><strong>Last chance to edit</strong></div>
        <p class="text-xs">Your party is under 48 hours away. This edit will be processed but no further changes will be accepted after this.</p>
       </div>`
    : `<div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-5 text-xs text-amber-700">
        ✏️ Edits allowed up to 48 hours before your party. Changes within 24 hours cannot be accepted.
       </div>`;

  document.getElementById('editBookingContent').innerHTML = `
    <h2 class="font-display font-bold text-2xl text-gray-900 mb-1">Edit Booking</h2>
    <p class="text-gray-500 text-sm mb-5">Ref: <strong>${booking.bookingRef}</strong></p>

    ${bannerHtml}

    <!-- Locked fields -->
    <div class="bg-gray-50 border-2 border-gray-100 rounded-2xl p-4 mb-5">
      <div class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">🔒 Cannot be changed</div>
      <div class="grid grid-cols-2 gap-y-2 text-sm">
        <div class="text-gray-500">Room</div><div class="font-semibold">${escapeHtml(booking.roomEmoji || '')} ${escapeHtml(booking.roomName)}</div>
        <div class="text-gray-500">Date</div><div class="font-semibold">${booking.partyDate}</div>
        <div class="text-gray-500">Time</div><div class="font-semibold">${booking.partyTime}</div>
        <div class="text-gray-500">Current guests</div><div class="font-semibold">${booking.guestCount} kids</div>
        <div class="text-gray-500">Current food</div><div class="font-semibold">${escapeHtml(booking.foodChoice) || '—'}</div>
        ${booking.addonsSummary ? `<div class="text-gray-500">Current add-ons</div><div class="font-semibold text-xs">${escapeHtml(booking.addonsSummary)}</div>` : ''}
      </div>
    </div>

    <!-- Guest count -->
    <div class="mb-5">
      <label class="lbl">Number of Kids Attending</label>
      <p class="text-xs text-gray-400 mb-2">Cannot go below ${booking.guestCount}. Maximum: ${maxGuests}.</p>
      <div class="flex items-center gap-3">
        <button id="editGuestMinus" onclick="changeEditGuests(-1)" class="w-10 h-10 rounded-xl border-2 border-gray-200 font-bold text-lg hover:border-indigo-400 transition-colors flex items-center justify-center" disabled>−</button>
        <span class="font-display font-bold text-2xl w-10 text-center" id="editGuestCount">${editState.newGuestCount}</span>
        <button id="editGuestPlus" onclick="changeEditGuests(1)" class="w-10 h-10 rounded-xl border-2 border-gray-200 font-bold text-lg hover:border-indigo-400 transition-colors flex items-center justify-center" ${editState.newGuestCount >= maxGuests ? 'disabled' : ''}>+</button>
        <span class="text-gray-400 text-sm ml-1">kids</span>
      </div>
    </div>

    <!-- Food split (shown only if guest count increased) -->
    <div id="editFoodSplitSection" class="hidden mb-5">
      <label class="lbl mb-1 block">Updated Food Split <span class="text-gray-400 font-normal">(must add up to <span id="editFoodTarget">${booking.guestCount}</span> kids)</span></label>
      <p class="text-xs text-amber-600 mb-2" id="editFoodSplitHint">You've added kids — please split food for all guests including the new ones.</p>
      <div id="editFoodSplitError" class="text-red-500 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2 hidden">
        Please update your food selection to match your new guest count of <span id="editFoodErrCount"></span>.
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="bg-gray-50 border-2 border-gray-200 rounded-2xl p-3 text-center">
          <div class="text-3xl mb-1">🍗</div>
          <div class="font-display font-bold text-xs mb-2">Chicken Nuggets</div>
          <div class="flex items-center justify-center gap-2">
            <button onclick="changeEditFoodSplit('nuggets',-1)" class="w-7 h-7 rounded-lg border-2 border-gray-300 font-bold hover:border-indigo-400 flex items-center justify-center text-sm">−</button>
            <span class="font-display font-bold text-xl text-indigo-600 w-7 text-center" id="editNuggetCount">0</span>
            <button id="editNuggetPlus" onclick="changeEditFoodSplit('nuggets',1)" class="w-7 h-7 rounded-lg border-2 border-gray-300 font-bold hover:border-indigo-400 flex items-center justify-center text-sm">+</button>
          </div>
        </div>
        <div class="bg-gray-50 border-2 border-gray-200 rounded-2xl p-3 text-center">
          <div class="text-3xl mb-1">🍔</div>
          <div class="font-display font-bold text-xs mb-2">Mini Burger</div>
          <div class="flex items-center justify-center gap-2">
            <button onclick="changeEditFoodSplit('burgers',-1)" class="w-7 h-7 rounded-lg border-2 border-gray-300 font-bold hover:border-indigo-400 flex items-center justify-center text-sm">−</button>
            <span class="font-display font-bold text-xl text-indigo-600 w-7 text-center" id="editBurgerCount">0</span>
            <button id="editBurgerPlus" onclick="changeEditFoodSplit('burgers',1)" class="w-7 h-7 rounded-lg border-2 border-gray-300 font-bold hover:border-indigo-400 flex items-center justify-center text-sm">+</button>
          </div>
        </div>
        <div class="bg-gray-50 border-2 border-gray-200 rounded-2xl p-3 text-center">
          <div class="text-3xl mb-1">🥦</div>
          <div class="font-display font-bold text-xs mb-2">Vege Mini Burger</div>
          <div class="flex items-center justify-center gap-2">
            <button onclick="changeEditFoodSplit('veges',-1)" class="w-7 h-7 rounded-lg border-2 border-gray-300 font-bold hover:border-indigo-400 flex items-center justify-center text-sm">−</button>
            <span class="font-display font-bold text-xl text-indigo-600 w-7 text-center" id="editVegeCount">0</span>
            <button id="editVegePlus" onclick="changeEditFoodSplit('veges',1)" class="w-7 h-7 rounded-lg border-2 border-gray-300 font-bold hover:border-indigo-400 flex items-center justify-center text-sm">+</button>
          </div>
        </div>
      </div>
      <div id="editFoodSplitStatus" class="mt-2 text-xs text-center text-gray-400">0 / ${booking.guestCount} selected</div>
    </div>

    <!-- New Add-ons -->
    <div class="mb-5">
      <div class="font-display font-bold text-base text-gray-900 mb-1">➕ Additional Add-Ons <span class="text-gray-400 font-normal text-sm">(optional)</span></div>
      <p class="text-xs text-gray-400 mb-3">Only newly added items will be charged. These are on top of your existing add-ons.</p>
      ${buildEditAddonsHtml()}
    </div>

    <!-- Action buttons -->
    <div class="flex gap-3 mt-2">
      <button onclick="closeEditBooking()" class="btn-secondary flex-1 py-3">Cancel</button>
      <button onclick="proceedEditToReview()" class="btn-primary flex-1 py-3">Review Changes →</button>
    </div>`;
}

function buildEditAddonsHtml() {
  const addonDefs = [
    { id: 'pizza_11',        emoji: '🍕', name: '11-inch Pizza',            sub: 'Ham & Cheese · Salami & Cheese · Chorizo & Cheese · Plain Cheese · Vege', price: 25,    hasPicker: 'pizza' },
    { id: 'platter_chicken', emoji: '🍗', name: 'Fried Chicken Platter',    sub: '10 Nuggets · 6 Fried Chicken · 6 Karaage · Fries · Sauces',               price: 39 },
    { id: 'platter_seafood', emoji: '🦐', name: 'Seafood Platter',          sub: '8 Fish Bites · 6 Prawn Twister · 6 Tempura · 6 Calamari · Fries · Sauces', price: 49 },
    { id: 'adult_sandwich',  emoji: '🥪', name: 'Adult Platter — 15 pcs',   sub: 'Ham & Cheese Sandwiches',                                                   price: 60 },
    { id: 'sushi_40',        emoji: '🍣', name: 'Sushi Platter — 40 pcs',   sub: 'Adult sushi platter',                                                       price: 60 },
    { id: 'sushi_24',        emoji: '🍣', name: 'Sushi Platter — 24 pcs',   sub: 'Smaller sushi platter',                                                     price: 30 },
    { id: 'sushi_salmon',    emoji: '🍣', name: 'Salmon Supreme Platter',   sub: '4 Salmon Avocado Roll · 4 Salmon Nigiri · 2 Aburi Salmon',                  price: 28.90 },
    { id: 'sushi_ocean',     emoji: '🍱', name: 'Ocean Deluxe Set',         sub: '4 Tempura Prawn Dragon · 4 Salmon Avocado · 4 Nigiri · 2 Aburi Salmon',     price: 39.90 },
    { id: 'sushi_kids48',    emoji: '🍣', name: 'Kids Party Platter (48 pcs)', sub: 'Salmon, Teriyaki, Katsu, Tuna Mayo, Crab Stick, Avocado',               price: 49.90 },
    { id: 'sushi_garden28',  emoji: '🥗', name: 'Green Garden Platter (28 pcs)', sub: 'Garden Veggie Roll, Avocado Roll, Tofu Veggie, Avo Nigiri',           price: 42.90 },
    { id: 'drinks_soda',     emoji: '🥤', name: 'Soft Drink',               sub: 'Coke · Sprite · Fanta · L&P — per bottle',                                  price: 10,   hasPicker: 'soda' },
    { id: 'drinks_juice',    emoji: '🍊', name: 'Orange / Apple Juice Jug', sub: '1 Jug',                                                                     price: 27,   hasPicker: 'juice' },
  ];

  return addonDefs.map(a => {
    let pickerHtml = '';
    if (a.hasPicker === 'pizza') {
      pickerHtml = `
        <div id="editPizzaPicker" class="hidden mt-3 pt-3 border-t border-gray-200">
          <div class="flex justify-between mb-2">
            <span class="text-xs text-gray-500 font-semibold">Which type(s)?</span>
            <span id="editPizzaCounter" class="text-xs font-bold text-indigo-600">0 / 0 allocated</span>
          </div>
          <div id="editPizzaTypeError" class="text-red-500 text-xs mb-2 hidden">Please choose a type of pizza before continuing.</div>
          <div class="space-y-1.5">
            ${['Ham & Cheese','Salami & Cheese','Chorizo & Cheese','Plain Cheese','Vege Pizza'].map(t =>
              `<div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-gray-700">${t}</span>
                <div class="flex items-center gap-1">
                  <button type="button" onclick="changeEditPizzaType('${t}',-1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">−</button>
                  <span class="w-5 text-center text-xs font-bold" id="editPizzaQty_${t.replace(/[^a-z]/gi,'')}"}>0</span>
                  <button type="button" onclick="changeEditPizzaType('${t}',1)" id="editPizzaPlus_${t.replace(/[^a-z]/gi,'')}" class="edit-pizza-type-plus w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">+</button>
                </div>
              </div>`
            ).join('')}
          </div>
        </div>`;
    } else if (a.hasPicker === 'soda') {
      pickerHtml = `
        <div id="editSodaPicker" class="hidden mt-3 pt-3 border-t border-gray-200">
          <div class="flex justify-between mb-2">
            <span class="text-xs text-gray-500 font-semibold">Which flavour(s)?</span>
            <span id="editSodaCounter" class="text-xs font-bold text-indigo-600">0 / 0 allocated</span>
          </div>
          <div id="editSodaTypeError" class="text-red-500 text-xs mb-2 hidden">Please choose a flavour for your soft drink(s) before continuing.</div>
          <div class="space-y-1.5">
            ${['Coke','Sprite','Fanta','L&P'].map(t =>
              `<div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-gray-700">${t}</span>
                <div class="flex items-center gap-1">
                  <button type="button" onclick="changeEditSodaType('${t}',-1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">−</button>
                  <span class="w-5 text-center text-xs font-bold" id="editSodaQty_${t.replace(/[^a-z]/gi,'')}"}>0</span>
                  <button type="button" onclick="changeEditSodaType('${t}',1)" id="editSodaPlus_${t.replace(/[^a-z]/gi,'')}" class="edit-soda-type-plus w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">+</button>
                </div>
              </div>`
            ).join('')}
          </div>
        </div>`;
    } else if (a.hasPicker === 'juice') {
      pickerHtml = `
        <div id="editJuicePicker" class="hidden mt-3 pt-3 border-t border-gray-200">
          <div class="flex justify-between mb-2">
            <span class="text-xs text-gray-500 font-semibold">Which flavour(s)?</span>
            <span id="editJuiceCounter" class="text-xs font-bold text-indigo-600">0 / 0 allocated</span>
          </div>
          <div id="editJuiceTypeError" class="text-red-500 text-xs mb-2 hidden">Please choose a flavour of juice before continuing.</div>
          <div class="space-y-1.5">
            ${['Orange Juice','Apple Juice'].map(t =>
              `<div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-gray-700">${t}</span>
                <div class="flex items-center gap-1">
                  <button type="button" onclick="changeEditJuiceType('${t}',-1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">−</button>
                  <span class="w-5 text-center text-xs font-bold" id="editJuiceQty_${t.replace(/[^a-z]/gi,'')}"}>0</span>
                  <button type="button" onclick="changeEditJuiceType('${t}',1)" id="editJuicePlus_${t.replace(/[^a-z]/gi,'')}" class="edit-juice-type-plus w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">+</button>
                </div>
              </div>`
            ).join('')}
          </div>
        </div>`;
    }

    return `
      <div class="addon-row bg-gray-50 rounded-xl p-3 border border-gray-100 mb-2">
        <div class="flex items-start gap-3 mb-2">
          <div class="text-2xl flex-shrink-0">${a.emoji}</div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-sm text-gray-800">${a.name}</div>
            <div class="text-xs text-gray-400">${a.sub}</div>
          </div>
        </div>
        <div class="flex items-center justify-between pl-1">
          <span class="bg-green-100 text-green-700 font-bold text-xs rounded-full px-2.5 py-1">$${a.price % 1 === 0 ? a.price : a.price.toFixed(2)}</span>
          <div class="flex items-center gap-1">
            <button onclick="changeEditAddon('${a.id}',-1)" class="w-7 h-7 rounded-lg border border-gray-300 text-sm font-bold hover:border-indigo-400 flex items-center justify-center">−</button>
            <span class="w-6 text-center text-sm font-bold" id="editAddon_${a.id}">0</span>
            <button onclick="changeEditAddon('${a.id}',1)" class="w-7 h-7 rounded-lg border border-gray-300 text-sm font-bold hover:border-indigo-400 flex items-center justify-center">+</button>
          </div>
        </div>
        ${pickerHtml}
      </div>`;
  }).join('');
}

// ── Edit guest count ───────────────────────────────────────────────────
function changeEditGuests(delta) {
  const booking = editState.booking;
  if (!booking) return;
  const maxGuests = parseInt(booking.roomMaxGuests) || 24;
  const next = Math.max(booking.guestCount, Math.min(maxGuests, editState.newGuestCount + delta));
  editState.newGuestCount = next;

  const el = document.getElementById('editGuestCount');
  if (el) el.textContent = next;

  const minusBtn = document.getElementById('editGuestMinus');
  const plusBtn = document.getElementById('editGuestPlus');
  if (minusBtn) minusBtn.disabled = next <= booking.guestCount;
  if (plusBtn) plusBtn.disabled = next >= maxGuests;

  const foodSection = document.getElementById('editFoodSplitSection');
  if (foodSection) foodSection.classList.toggle('hidden', next <= booking.guestCount);

  const foodTarget = document.getElementById('editFoodTarget');
  if (foodTarget) foodTarget.textContent = next;
  const foodHint = document.getElementById('editFoodSplitHint');
  if (foodHint) foodHint.textContent = `You've added ${next - booking.guestCount} kid${next - booking.guestCount > 1 ? 's' : ''} — please split food for all ${next} guests (including original ${booking.guestCount}).`;
  const errCount = document.getElementById('editFoodErrCount');
  if (errCount) errCount.textContent = next;

  // Reset food split when guest count changes
  editState.editNuggets = 0; editState.editBurgers = 0; editState.editVeges = 0;
  ['editNuggetCount','editBurgerCount','editVegeCount'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.textContent = '0';
  });
  const statusEl = document.getElementById('editFoodSplitStatus');
  if (statusEl) statusEl.textContent = `0 / ${next} selected`;
  ['editNuggetPlus','editBurgerPlus','editVegePlus'].forEach(id => {
    const b = document.getElementById(id); if (b) b.disabled = false;
  });

  updateEditDelta();
}

// ── Edit food split ────────────────────────────────────────────────────
function changeEditFoodSplit(type, delta) {
  const total = editState.newGuestCount;
  const n = editState.editNuggets, b = editState.editBurgers, v = editState.editVeges;
  const current = type === 'nuggets' ? n : type === 'burgers' ? b : v;
  const next = Math.max(0, current + delta);

  if (type === 'nuggets') editState.editNuggets = next;
  else if (type === 'burgers') editState.editBurgers = next;
  else editState.editVeges = next;

  const newN = type === 'nuggets' ? next : n;
  const newB = type === 'burgers' ? next : b;
  const newV = type === 'veges'   ? next : v;
  const combined = newN + newB + newV;

  const elMap = { nuggets: 'editNuggetCount', burgers: 'editBurgerCount', veges: 'editVegeCount' };
  const el = document.getElementById(elMap[type]);
  if (el) el.textContent = next;

  const atMax = combined >= total;
  ['editNuggetPlus','editBurgerPlus','editVegePlus'].forEach(id => {
    const btn = document.getElementById(id); if (btn) btn.disabled = atMax;
  });

  const statusEl = document.getElementById('editFoodSplitStatus');
  if (statusEl) statusEl.textContent = `${combined} / ${total} selected`;
}

// ── Edit addon qty ─────────────────────────────────────────────────────
function changeEditAddon(id, delta) {
  const current = editState.newAddons[id] || 0;
  const next = Math.max(0, current + delta);
  editState.newAddons[id] = next;

  const el = document.getElementById('editAddon_' + id);
  if (el) el.textContent = next;

  if (id === 'pizza_11') {
    const picker = document.getElementById('editPizzaPicker');
    if (picker) picker.classList.toggle('hidden', next === 0);
    if (next === 0) {
      editState.newPizzaTypes = {};
      updateEditPizzaPickerUI();
    } else {
      trimEditTypeAllocation(editState.newPizzaTypes, next);
      updateEditPizzaPickerUI();
    }
  }
  if (id === 'drinks_soda') {
    const picker = document.getElementById('editSodaPicker');
    if (picker) picker.classList.toggle('hidden', next === 0);
    if (next === 0) {
      editState.newSodaTypes = {};
      updateEditSodaPickerUI();
    } else {
      trimEditTypeAllocation(editState.newSodaTypes, next);
      updateEditSodaPickerUI();
    }
  }
  if (id === 'drinks_juice') {
    const picker = document.getElementById('editJuicePicker');
    if (picker) picker.classList.toggle('hidden', next === 0);
    if (next === 0) {
      editState.newJuiceTypes = {};
      updateEditJuicePickerUI();
    } else {
      trimEditTypeAllocation(editState.newJuiceTypes, next);
      updateEditJuicePickerUI();
    }
  }
  updateEditDelta();
}

function trimEditTypeAllocation(obj, maxTotal) {
  let total = Object.values(obj).reduce((s, v) => s + v, 0);
  const keys = Object.keys(obj);
  for (let i = keys.length - 1; i >= 0 && total > maxTotal; i--) {
    const cut = Math.min(obj[keys[i]], total - maxTotal);
    obj[keys[i]] -= cut; total -= cut;
    if (obj[keys[i]] === 0) delete obj[keys[i]];
  }
}

function changeEditPizzaType(type, delta) {
  const qty = editState.newAddons.pizza_11 || 0;
  const total = Object.values(editState.newPizzaTypes).reduce((s,v)=>s+v,0);
  if (delta > 0 && total >= qty) return;
  const next = Math.max(0, (editState.newPizzaTypes[type] || 0) + delta);
  if (next === 0) delete editState.newPizzaTypes[type]; else editState.newPizzaTypes[type] = next;
  updateEditPizzaPickerUI();
}

function changeEditSodaType(type, delta) {
  const qty = editState.newAddons.drinks_soda || 0;
  const total = Object.values(editState.newSodaTypes).reduce((s,v)=>s+v,0);
  if (delta > 0 && total >= qty) return;
  const next = Math.max(0, (editState.newSodaTypes[type] || 0) + delta);
  if (next === 0) delete editState.newSodaTypes[type]; else editState.newSodaTypes[type] = next;
  updateEditSodaPickerUI();
}

function changeEditJuiceType(type, delta) {
  const qty = editState.newAddons.drinks_juice || 0;
  const total = Object.values(editState.newJuiceTypes).reduce((s,v)=>s+v,0);
  if (delta > 0 && total >= qty) return;
  const next = Math.max(0, (editState.newJuiceTypes[type] || 0) + delta);
  if (next === 0) delete editState.newJuiceTypes[type]; else editState.newJuiceTypes[type] = next;
  updateEditJuicePickerUI();
}

function updateEditPizzaPickerUI() {
  const qty = editState.newAddons.pizza_11 || 0;
  const total = Object.values(editState.newPizzaTypes).reduce((s,v)=>s+v,0);
  const atMax = total >= qty;
  [['Ham & Cheese','HamCheese'],['Salami & Cheese','SalamiCheese'],['Chorizo & Cheese','ChorizoCheese'],['Plain Cheese','PlainCheese'],['Vege Pizza','VegePizza']].forEach(([t,id]) => {
    const qEl = document.getElementById('editPizzaQty_' + t.replace(/[^a-z]/gi,''));
    if (qEl) qEl.textContent = editState.newPizzaTypes[t] || 0;
    const pEl = document.getElementById('editPizzaPlus_' + t.replace(/[^a-z]/gi,''));
    if (pEl) { pEl.classList.toggle('opacity-30', atMax); pEl.classList.toggle('pointer-events-none', atMax); }
  });
  const cEl = document.getElementById('editPizzaCounter');
  if (cEl) cEl.textContent = `${total} / ${qty} allocated`;
}

function updateEditSodaPickerUI() {
  const qty = editState.newAddons.drinks_soda || 0;
  const total = Object.values(editState.newSodaTypes).reduce((s,v)=>s+v,0);
  const atMax = total >= qty;
  [['Coke','Coke'],['Sprite','Sprite'],['Fanta','Fanta'],['L&P','LP']].forEach(([t,id]) => {
    const qEl = document.getElementById('editSodaQty_' + t.replace(/[^a-z]/gi,''));
    if (qEl) qEl.textContent = editState.newSodaTypes[t] || 0;
    const pEl = document.getElementById('editSodaPlus_' + t.replace(/[^a-z]/gi,''));
    if (pEl) { pEl.classList.toggle('opacity-30', atMax); pEl.classList.toggle('pointer-events-none', atMax); }
  });
  const cEl = document.getElementById('editSodaCounter');
  if (cEl) cEl.textContent = `${total} / ${qty} allocated`;
}

function updateEditJuicePickerUI() {
  const qty = editState.newAddons.drinks_juice || 0;
  const total = Object.values(editState.newJuiceTypes).reduce((s,v)=>s+v,0);
  const atMax = total >= qty;
  [['Orange Juice','OrangeJuice'],['Apple Juice','AppleJuice']].forEach(([t,id]) => {
    const qEl = document.getElementById('editJuiceQty_' + t.replace(/[^a-z]/gi,''));
    if (qEl) qEl.textContent = editState.newJuiceTypes[t] || 0;
    const pEl = document.getElementById('editJuicePlus_' + t.replace(/[^a-z]/gi,''));
    if (pEl) { pEl.classList.toggle('opacity-30', atMax); pEl.classList.toggle('pointer-events-none', atMax); }
  });
  const cEl = document.getElementById('editJuiceCounter');
  if (cEl) cEl.textContent = `${total} / ${qty} allocated`;
}

// ── Compute delta amount ───────────────────────────────────────────────
function getEditAddonSummaryLines() {
  const PRICES = typeof ADDON_PRICES !== 'undefined' ? ADDON_PRICES : {};
  return Object.entries(editState.newAddons)
    .filter(([,qty]) => qty > 0)
    .map(([id, qty]) => {
      const a = PRICES[id] || { label: id, price: 0 };
      let label = a.label;
      if (id === 'pizza_11' && Object.keys(editState.newPizzaTypes).length) {
        const parts = Object.entries(editState.newPizzaTypes).filter(([,n])=>n>0).map(([t,n])=>n>1?`${t} x${n}`:t);
        label = '11-inch Pizza (' + parts.join(', ') + ')';
      }
      if (id === 'drinks_soda' && Object.keys(editState.newSodaTypes).length) {
        const parts = Object.entries(editState.newSodaTypes).filter(([,n])=>n>0).map(([t,n])=>n>1?`${t} x${n}`:t);
        label = 'Soft Drink (' + parts.join(', ') + ')';
      }
      if (id === 'drinks_juice' && Object.keys(editState.newJuiceTypes).length) {
        const parts = Object.entries(editState.newJuiceTypes).filter(([,n])=>n>0).map(([t,n])=>n>1?`${t} x${n}`:t);
        label = 'Juice Jug (' + parts.join(', ') + ')';
      }
      return { label, qty, price: a.price, subtotal: a.price * qty };
    });
}

function getEditAddonTotal() {
  const PRICES = typeof ADDON_PRICES !== 'undefined' ? ADDON_PRICES : {};
  return Object.entries(editState.newAddons).reduce((sum,[id,qty])=>sum+(PRICES[id]?.price||0)*qty, 0);
}

function updateEditDelta() {
  const booking = editState.booking;
  if (!booking) return;
  const pricePerChild = parseFloat(booking.pricePerChild) || 39;
  const newKids = editState.newGuestCount - booking.guestCount;
  const kidsDelta = newKids * pricePerChild;
  const addonsDelta = getEditAddonTotal();
  editState.deltaAmount = kidsDelta + addonsDelta;
}

// ── Proceed to review step ─────────────────────────────────────────────
function proceedEditToReview() {
  const booking = editState.booking;
  if (!booking) return;
  updateEditDelta();

  // Validate food split if guest count increased
  if (editState.newGuestCount > booking.guestCount) {
    const combined = editState.editNuggets + editState.editBurgers + editState.editVeges;
    if (combined !== editState.newGuestCount) {
      const errEl = document.getElementById('editFoodSplitError');
      const errCount = document.getElementById('editFoodErrCount');
      if (errCount) errCount.textContent = editState.newGuestCount;
      if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
      showFieldError(`Please update your food selection to match your new guest count of ${editState.newGuestCount}.`);
      return;
    }
    const foodErrEl = document.getElementById('editFoodSplitError');
    if (foodErrEl) foodErrEl.classList.add('hidden');
  }

  // Validate pizza types
  const pizzaQty = editState.newAddons.pizza_11 || 0;
  if (pizzaQty > 0) {
    const picked = Object.values(editState.newPizzaTypes).reduce((s,v)=>s+v,0);
    if (picked < pizzaQty) {
      const errEl = document.getElementById('editPizzaTypeError');
      if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
      showFieldError('Please choose a type of pizza before continuing.');
      return;
    }
  }
  const pizzaErrEl = document.getElementById('editPizzaTypeError');
  if (pizzaErrEl) pizzaErrEl.classList.add('hidden');

  // Validate soda types
  const sodaQty = editState.newAddons.drinks_soda || 0;
  if (sodaQty > 0) {
    const picked = Object.values(editState.newSodaTypes).reduce((s,v)=>s+v,0);
    if (picked < sodaQty) {
      const errEl = document.getElementById('editSodaTypeError');
      if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
      showFieldError('Please choose a flavour for your soft drink(s) before continuing.');
      return;
    }
  }
  const sodaErrEl = document.getElementById('editSodaTypeError');
  if (sodaErrEl) sodaErrEl.classList.add('hidden');

  // Validate juice types
  const juiceQty = editState.newAddons.drinks_juice || 0;
  if (juiceQty > 0) {
    const picked = Object.values(editState.newJuiceTypes).reduce((s,v)=>s+v,0);
    if (picked < juiceQty) {
      const errEl = document.getElementById('editJuiceTypeError');
      if (errEl) { errEl.classList.remove('hidden'); errEl.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
      showFieldError('Please choose a flavour of juice before continuing.');
      return;
    }
  }
  const juiceErrEl = document.getElementById('editJuiceTypeError');
  if (juiceErrEl) juiceErrEl.classList.add('hidden');

  // No changes made
  if (editState.newGuestCount === booking.guestCount && getEditAddonTotal() === 0) {
    showFieldError('No changes detected. Adjust the guest count or add new items to continue.');
    return;
  }

  renderEditStep2();
}

// ── Edit step 2: Review + payment ──────────────────────────────────────
function renderEditStep2() {
  const booking = editState.booking;
  const pricePerChild = parseFloat(booking.pricePerChild) || 39;
  const newKids = editState.newGuestCount - booking.guestCount;
  const addonLines = getEditAddonSummaryLines();
  const addonTotal = getEditAddonTotal();
  const delta = editState.deltaAmount;

  let newFoodChoice = booking.foodChoice;
  if (editState.newGuestCount > booking.guestCount) {
    const parts = [];
    if (editState.editNuggets > 0) parts.push(editState.editNuggets + ' Nuggets');
    if (editState.editBurgers > 0) parts.push(editState.editBurgers + ' Mini Burgers');
    if (editState.editVeges > 0)   parts.push(editState.editVeges + ' Vege Burgers');
    newFoodChoice = parts.join(' + ');
  }

  // Build delta line items
  let deltaHtml = '';
  if (newKids > 0) {
    deltaHtml += `<div class="flex justify-between"><span>${newKids} new kid${newKids>1?'s':''} × $${pricePerChild}/child</span><span class="font-semibold">$${(newKids*pricePerChild).toFixed(2)}</span></div>`;
  }
  addonLines.forEach(a => {
    deltaHtml += `<div class="flex justify-between"><span>+ ${a.label} ×${a.qty}</span><span class="font-semibold">$${a.subtotal.toFixed(2)}</span></div>`;
  });

  // Food split display
  const foodDisplay = editState.newGuestCount > booking.guestCount
    ? `<div class="mt-2 pt-2 border-t border-indigo-100 text-xs text-indigo-700 flex items-center gap-1"><span>🍽️ Updated food split:</span><span class="font-semibold">${newFoodChoice}</span></div>`
    : '';

  // Payment options
  let paymentHtml = '';
  if (delta > 0) {
    const savedCardHtml = editState.savedCard
      ? `<div class="flex gap-2 mb-4">
          <button id="editPaySavedBtn" onclick="setEditPaymentMode('saved')" class="flex-1 border-2 border-indigo-300 bg-indigo-50 text-indigo-700 font-bold text-sm rounded-xl px-3 py-2.5 transition-all hover:bg-indigo-100">
            💳 Saved ${editState.savedCard.cardBrand} ···${editState.savedCard.cardLast4}
          </button>
          <button id="editPayNewBtn" onclick="setEditPaymentMode('new')" class="flex-1 border-2 border-gray-200 bg-white text-gray-600 font-semibold text-sm rounded-xl px-3 py-2.5 transition-all hover:border-indigo-300">
            Use different card
          </button>
        </div>`
      : '';

    paymentHtml = `
      <div class="mt-5">
        <label class="lbl">Payment</label>
        ${savedCardHtml}
        <div id="editStripeWrapper" class="mb-3 ${editState.paymentMode === 'saved' ? 'hidden' : ''}"></div>
        <div id="editStripeErrors" class="text-red-500 text-sm mb-3"></div>
      </div>`;
  }

  const submitLabel = delta > 0
    ? `Pay $${delta.toFixed(2)} & Confirm Changes`
    : 'Confirm Changes (no payment needed)';

  document.getElementById('editBookingContent').innerHTML = `
    <h2 class="font-display font-bold text-2xl text-gray-900 mb-5">Review Your Changes</h2>

    <!-- Changes summary -->
    <div class="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-4 mb-5">
      <div class="font-display font-bold text-indigo-700 mb-3">📋 What's changing</div>
      <div class="space-y-1.5 text-sm text-indigo-800">
        ${newKids > 0 ? `<div class="flex justify-between"><span>Guest count</span><span class="font-semibold">${booking.guestCount} → ${editState.newGuestCount} kids</span></div>` : ''}
        ${newFoodChoice && newFoodChoice !== booking.foodChoice ? `<div class="flex justify-between"><span>Food split</span><span class="font-semibold text-xs">${newFoodChoice}</span></div>` : ''}
        ${addonLines.map(a=>`<div class="flex justify-between"><span>+ ${a.label} ×${a.qty}</span><span class="font-semibold">$${a.subtotal.toFixed(2)}</span></div>`).join('')}
        ${foodDisplay}
        <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
          <span>${delta > 0 ? 'Additional charge:' : 'No charge:'}</span>
          <span class="text-indigo-600">$${delta.toFixed(2)} NZD</span>
        </div>
      </div>
    </div>

    ${paymentHtml}

    <div class="flex gap-3 mt-4">
      <button onclick="renderEditStep1(editState.booking, editState.savedCard ? {hasSavedCard:true,...editState.savedCard} : {hasSavedCard:false})" class="btn-secondary flex-1 py-3">← Back</button>
      <button id="editSubmitBtn" onclick="submitEditBooking()" class="btn-primary flex-1 py-3">
        <span id="editSubmitText">${submitLabel}</span>
        <span id="editSubmitSpinner" class="hidden">
          <svg class="animate-spin h-5 w-5 mx-auto text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        </span>
      </button>
    </div>`;

  if (delta > 0 && editState.paymentMode !== 'saved') {
    setTimeout(() => mountEditStripeElement(delta), 100);
  }
  if (delta > 0 && editState.savedCard) {
    updateEditPaymentModeUI();
  }
}

function setEditPaymentMode(mode) {
  editState.paymentMode = mode;
  updateEditPaymentModeUI();
  const wrapper = document.getElementById('editStripeWrapper');
  if (mode === 'new' && wrapper) {
    wrapper.classList.remove('hidden');
    if (!editState.editElementsMounted) {
      setTimeout(() => mountEditStripeElement(editState.deltaAmount), 100);
    }
  } else if (wrapper) {
    wrapper.classList.add('hidden');
  }
}

function updateEditPaymentModeUI() {
  const savedBtn = document.getElementById('editPaySavedBtn');
  const newBtn = document.getElementById('editPayNewBtn');
  const isSaved = editState.paymentMode === 'saved';
  if (savedBtn) {
    savedBtn.className = `flex-1 border-2 ${isSaved ? 'border-indigo-400 bg-indigo-100 text-indigo-700 font-bold' : 'border-indigo-300 bg-indigo-50 text-indigo-700 font-bold'} text-sm rounded-xl px-3 py-2.5 transition-all hover:bg-indigo-100`;
  }
  if (newBtn) {
    newBtn.className = `flex-1 border-2 ${!isSaved ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold' : 'border-gray-200 bg-white text-gray-600 font-semibold'} text-sm rounded-xl px-3 py-2.5 transition-all hover:border-indigo-300`;
  }
}

async function mountEditStripeElement(deltaAmount) {
  if (editState.editElementsMounted) return;
  const wrapper = document.getElementById('editStripeWrapper');
  if (!wrapper || !stripe) return;

  wrapper.innerHTML = '<div class="text-gray-400 text-sm text-center py-4">Loading payment...</div>';

  try {
    const result = await callAPI('payments/create-edit-intent', {
      deltaAmount,
      bookingId: editState.booking.id,
      currency: 'nzd',
    });
    editState.editClientSecret = result.clientSecret;
  } catch (err) {
    wrapper.innerHTML = `<div class="text-red-500 text-sm text-center py-3">Failed to load payment: ${err.message}</div>`;
    return;
  }

  wrapper.innerHTML = '<div id="editPaymentElement"></div>';
  editState.editElements = stripe.elements({
    clientSecret: editState.editClientSecret,
    appearance: { theme: 'stripe', variables: { colorPrimary: '#4F46E5', borderRadius: '12px' } },
  });
  const pe = editState.editElements.create('payment', {
    layout: { type: 'tabs', defaultCollapsed: false },
    defaultValues: { billingDetails: { email: state.user?.email || '', address: { country: 'NZ' } } },
  });
  pe.mount('#editPaymentElement');
  editState.editElementsMounted = true;
}

// ── Submit the edit ────────────────────────────────────────────────────
async function submitEditBooking() {
  const booking = editState.booking;
  const delta = editState.deltaAmount;
  const btn = document.getElementById('editSubmitBtn');
  const text = document.getElementById('editSubmitText');
  const spinner = document.getElementById('editSubmitSpinner');

  if (btn) btn.disabled = true;
  if (text) text.classList.add('hidden');
  if (spinner) spinner.classList.remove('hidden');

  try {
    let paymentIntentId = null;

    if (delta > 0) {
      if (editState.paymentMode === 'saved') {
        const result = await callAPI('payments/charge-saved-card', {
          deltaAmount: delta,
          bookingId: booking.id,
          metadata: { booking_ref: booking.bookingRef },
        });
        if (!result.paymentIntentId) throw new Error('Payment could not be processed. Please try a different card.');
        paymentIntentId = result.paymentIntentId;
      } else {
        if (!editState.editElements || !editState.editClientSecret) {
          throw new Error('Payment form not ready. Please wait and try again.');
        }
        const { error, paymentIntent } = await stripe.confirmPayment({
          elements: editState.editElements,
          confirmParams: {
            return_url: window.location.origin + '/',
            payment_method_data: {
              billing_details: { email: state.user?.email || '', name: `${state.user?.firstName||''} ${state.user?.lastName||''}`.trim() },
            },
          },
          redirect: 'if_required',
        });
        if (error) {
          const errEl = document.getElementById('editStripeErrors');
          if (errEl) errEl.textContent = error.message;
          throw new Error(error.message);
        }
        paymentIntentId = paymentIntent?.id || editState.editClientSecret.split('_secret_')[0];
      }
    }

    await finalizeBookingEdit(paymentIntentId);
  } catch (err) {
    showFieldError(err.message || 'Something went wrong. Please try again.');
    if (btn) btn.disabled = false;
    if (text) text.classList.remove('hidden');
    if (spinner) spinner.classList.add('hidden');
  }
}

async function finalizeBookingEdit(paymentIntentId) {
  const booking = editState.booking;
  const delta = editState.deltaAmount;
  const newKids = editState.newGuestCount - booking.guestCount;
  const addonLines = getEditAddonSummaryLines();

  let newFoodChoice = null;
  if (editState.newGuestCount > booking.guestCount) {
    const parts = [];
    if (editState.editNuggets > 0) parts.push(editState.editNuggets + ' Nuggets');
    if (editState.editBurgers > 0) parts.push(editState.editBurgers + ' Mini Burgers');
    if (editState.editVeges > 0)   parts.push(editState.editVeges + ' Vege Burgers');
    newFoodChoice = parts.join(' + ');
  }

  const newAddonsSummary = addonLines.length > 0
    ? addonLines.map(a => `${a.label} ×${a.qty} ($${a.subtotal.toFixed(2)})`).join(', ')
    : null;

  const newAddonsAmount = addonLines.reduce((s, a) => s + a.subtotal, 0);

  let changeType = 'add_addons';
  if (newKids > 0 && addonLines.length > 0) changeType = 'both';
  else if (newKids > 0) changeType = 'add_kids';

  // Persist edit
  await callAPI(`bookings/${booking.id}/edit`, {
    newGuestCount: editState.newGuestCount,
    newFoodChoice,
    newAddonsSummary,
    newAddonsAmount,
    deltaAmount: delta,
    paymentIntentId,
    changeType,
  });

  // Send modification email
  const newTotalAmount = parseFloat(booking.totalAmount) + delta;
  callAPI('notifications/booking-modification', {
    bookingId: booking.id,
    bookingRef: booking.bookingRef,
    email: booking.contactEmail || state.user?.email || '',
    phone: state.user?.phone || '',
    firstName: state.user?.firstName || '',
    roomName: booking.roomName,
    partyDate: booking.partyDate,
    partyTime: booking.partyTime,
    newGuestCount: editState.newGuestCount,
    newFoodChoice,
    newAddonsSummary,
    deltaAmount: delta,
    newTotalAmount,
  }).catch(console.error);

  // Show success
  document.getElementById('editBookingContent').innerHTML = `
    <div class="text-center py-10">
      <div class="w-20 h-20 rounded-full bg-teal-100 flex items-center justify-center text-4xl mx-auto mb-4">✅</div>
      <h2 class="font-display font-bold text-2xl text-gray-900 mb-2">Booking Updated!</h2>
      <p class="text-gray-500 mb-2">Your changes have been saved and a confirmation email is on its way.</p>
      <div class="bg-indigo-50 rounded-xl p-4 text-sm text-indigo-800 text-left mb-6 mt-4">
        <div class="font-bold mb-1">Updated details</div>
        <div>${editState.newGuestCount} kids · ${newFoodChoice || booking.foodChoice || '—'}</div>
        ${newAddonsSummary ? `<div class="text-xs text-indigo-600 mt-1">New add-ons: ${newAddonsSummary}</div>` : ''}
        ${delta > 0 ? `<div class="font-semibold mt-1">Additional charge: $${delta.toFixed(2)} NZD</div>` : ''}
      </div>
      <button onclick="closeEditBooking()" class="btn-primary py-3 px-10">Done 🎉</button>
    </div>`;
}