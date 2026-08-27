/**
 * booking.js
 * Handles:
 *   - Room rendering & selection
 *   - Time slot fetching from Supabase (real availability)
 *   - Optimistic slot locking (30-min hold)
 *   - Server-side double-booking prevention
 *   - Timer logic
 *   - Saving booking to Supabase
 */

// ---------------------------------------------------------------------------
// Room data
// ---------------------------------------------------------------------------
const ROOMS = [
  {
    id: 'sunshine', name: 'Sunshine Room', emoji: '☀️', color: 'yellow',
    tagLine: 'Yellow · Warm & Cheerful',
    minGuests: 8, maxGuests: 15, basePricePerChild: 39,
    description: 'Bright, sunny, and full of energy. Perfect for medium-sized parties with a cheerful vibe.',
    image: 'images/rooms/sunshine.jpg',
  },
  {
    id: 'dream', name: 'Dream Room', emoji: '🌙', color: 'purple',
    tagLine: 'Purple · Magical & Dreamy',
    minGuests: 8, maxGuests: 15, basePricePerChild: 39,
    description: 'Soft lighting, dreamy decor, and a magical atmosphere kids will talk about for weeks.',
    image: 'images/rooms/dream.jpg',
  },
  {
    id: 'forest', name: 'Wonder Forest Room', emoji: '🌿', color: 'green',
    tagLine: 'Green · Nature Adventure',
    minGuests: 8, maxGuests: 15, basePricePerChild: 39,
    description: 'An immersive forest theme with climbing elements and nature-inspired details throughout.',
    image: 'images/rooms/forest.jpg',
  },
  {
    id: 'big', name: 'The Big Room', emoji: '🌟', color: 'indigo',
    tagLine: 'Exclusive Extra Large Zone',
    minGuests: 12, maxGuests: 24,
    basePricePerChild: 39, weekdayTotal: 39, weekendTotal: 49,
    description: 'Our flagship space — private stage, expanded play zone, and everything to make an unforgettable impression.',
    badge: 'BEST VALUE',
    image: 'images/rooms/big.jpg',
  },
  {
    id: 'whole-venue', name: 'Whole Venue Hire', emoji: '🏛️', color: 'slate',
    tagLine: 'Exclusive Full-Venue Buyout · Evenings Only',
    minGuests: 1, maxGuests: 300,
    pricingModel: 'flat', flatPrice: 2899,
    allowedDaysOfWeek: [0, 1, 2], // Sunday, Monday, Tuesday
    description: 'The entire venue, exclusively yours, 5:30–8:30 PM. Venue rental only — choose self-catering or our venue menu at checkout. Sunday, Monday or Tuesday only.',
    badge: 'EXCLUSIVE',
  },
];

const ROOM_COLOR_MAP = {
  indigo: { border: 'border-indigo-200', bg: 'bg-indigo-50', badge: 'bg-indigo-500', text: 'text-indigo-600' },
  yellow: { border: 'border-yellow-200', bg: 'bg-yellow-50', badge: 'bg-yellow-400', text: 'text-yellow-700' },
  purple: { border: 'border-purple-200', bg: 'bg-purple-50', badge: 'bg-purple-500', text: 'text-purple-600' },
  green:  { border: 'border-green-200',  bg: 'bg-green-50',  badge: 'bg-green-500',  text: 'text-green-600' },
  slate:  { border: 'border-slate-300',  bg: 'bg-slate-50',  badge: 'bg-slate-600',  text: 'text-slate-700' },
};

// Official party room booking times (from poster). '5:30 PM' is the new
// evening slot — Friday & Saturday only, see RESTRICTED_SLOT_DAYS below
// (mirrors server/services/bookingRules.js, the actual source of truth —
// this copy is UI-only, greying out the option; the server independently
// rejects it on any other day).
const ALL_SLOTS = ['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM', '5:30 PM'];
const RESTRICTED_SLOT_DAYS = { '5:30 PM': [5, 6] }; // Friday & Saturday

// Whole-venue hire has exactly one time option, distinct from the ordinary
// rooms' 5:30 PM slot (that one ends 7:00 PM; this one runs to 8:30 PM) —
// given its own label so receipts/emails never conflate the two.
const WHOLE_VENUE_SLOTS = ['5:30 PM – 8:30 PM'];

// Slot end times for display
const SLOT_END_TIMES = {
  '9:30 AM':  { one: '11:00 AM', two: '11:30 AM' },
  '11:30 AM': { one: '1:00 PM',  two: '1:30 PM'  },
  '1:30 PM':  { one: '3:00 PM',  two: '3:30 PM'  },
  '3:30 PM':  { one: '5:00 PM',  two: '5:30 PM'  },
  '5:30 PM':  { one: '7:00 PM',  two: '7:00 PM'  },
};

function slotsForRoom(room) {
  return room && room.pricingModel === 'flat' ? WHOLE_VENUE_SLOTS : ALL_SLOTS;
}

// day-of-week int (0=Sun..6=Sat) from a 'YYYY-MM-DD' string, without going
// through the browser's local timezone (matches nzGetDay's NZ-calendar
// semantics for a value that's already an NZ wall-clock date).
function dayOfWeekFromDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function describeDays(days) { return days.map(d => DAY_NAMES[d]).join('/'); }

// Tracks our slot polling interval (replaces Supabase realtime)
let slotSubscription = null;

// ---------------------------------------------------------------------------
// Guest count adjustment
// ---------------------------------------------------------------------------
const GUEST_STEPPER_MAX = Math.max(...ROOMS.map(r => r.maxGuests));
function adjustGuests(delta) {
  state.guests = Math.max(1, Math.min(GUEST_STEPPER_MAX, state.guests + delta));
  const el = document.getElementById('guestCount');
  el.textContent = state.guests;
  el.classList.remove('count-bounce');
  void el.offsetWidth;
  el.classList.add('count-bounce');
  renderRooms();
}

// ---------------------------------------------------------------------------
// Render room cards
// ---------------------------------------------------------------------------
function renderRooms() {
  const container = document.getElementById('roomCards');
  if (!container) return;

  const eligible   = ROOMS.filter(r => state.guests >= r.minGuests && state.guests <= r.maxGuests);
  const ineligible = ROOMS.filter(r => state.guests < r.minGuests || state.guests > r.maxGuests);

  let html = '';

  if (eligible.length === 0) {
    html = `<div class="text-center py-6 text-gray-400">
      <div class="text-3xl mb-2">🤔</div>
      <p>No rooms exactly match ${state.guests} kids. Try adjusting your guest count or <a href="#contact" class="text-indigo-500 underline">contact us</a> for custom arrangements.</p>
    </div>`;
  } else {
    eligible.forEach(r => { html += buildRoomCard(r, false); });
    if (ineligible.length > 0) {
      html += `<div class="text-xs text-gray-400 mt-3 mb-1 font-semibold uppercase tracking-wide">Other rooms (outside your guest count)</div>`;
      ineligible.forEach(r => { html += buildRoomCard(r, true); });
    }
  }
  container.innerHTML = html;
}

function buildRoomCard(room, dimmed) {
  const c = ROOM_COLOR_MAP[room.color];
  const selected = state.selectedRoom && state.selectedRoom.id === room.id;
  const dimClass = dimmed ? 'opacity-50 pointer-events-none' : '';
  const selClass = selected ? 'room-card selected' : 'room-card';

  const checkBadge = selected ? `
    <div class="room-check-badge absolute top-3 right-3 w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center shadow-md">
      <svg viewBox="0 0 12 12" width="11" height="11" fill="none"><path d="M2 6l3 3 5-5" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>` : '';

  const thumb = room.image ? `
    <img src="${room.image}" alt="${room.name} party room" loading="lazy"
      class="w-16 h-16 rounded-xl object-cover flex-shrink-0 cursor-zoom-in" style="object-position:center 35%;"
      onclick="event.stopPropagation(); openRoomPhoto('${room.image}', '${room.name.replace(/'/g, "\\'")}')" />` : '';

  return `
    <div class="${selClass} ${dimClass} p-4" onclick="selectRoom('${room.id}')">
      ${checkBadge}
      <div class="flex items-start gap-3">
        <div class="w-11 h-11 ${c.badge} rounded-xl flex items-center justify-center text-2xl flex-shrink-0 text-white shadow-sm">${room.emoji}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-0.5">
            <span class="font-display font-bold text-base leading-tight">${room.name}</span>
            ${room.badge ? `<span class="bg-amber-400 text-gray-900 text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap">${room.badge}</span>` : ''}
          </div>
          <div class="text-xs text-gray-400 leading-snug">${room.minGuests}–${room.maxGuests} kids · ${room.tagLine}</div>
          <div class="flex items-center justify-between mt-1.5 flex-wrap gap-1">
            <div class="${c.text} font-display font-bold text-sm">${room.pricingModel === 'flat' ? `$${room.flatPrice.toLocaleString()} flat (venue only)` : `$${room.basePricePerChild}/child`}</div>
            ${selected ? '<div class="text-blue-500 text-xs font-semibold flex items-center gap-1">✓ Selected</div>' : ''}
          </div>
        </div>
        ${thumb}
      </div>
    </div>`;
}

async function selectRoom(id) {
  const roomChanged = state.selectedRoom?.id !== id;

  state.selectedRoom = ROOMS.find(r => r.id === id);
  renderRooms();
  updateStep2SlotsHint();
  const nextBtn = document.getElementById('step1Next');
  nextBtn.disabled = false;
  nextBtn.style.opacity = '1';

  // A held slot's exclusivity lock belongs to whichever room it was created
  // for. Without this, switching rooms left selectedTime/slotHoldId/
  // partyRoomDbId referring to different rooms: the background availability
  // poller (fetchAndRenderSlots, via subscribeToSlotChanges) reads
  // state.selectedRoom fresh on every tick and silently repoints
  // partyRoomDbId at whatever room is now selected, regardless of whether a
  // hold was ever taken out on it — so the final booking could get written
  // for a room whose slot was never actually checked (see WW-129HC4
  // root-cause writeup). Stopping the poller and clearing the stale hold
  // here means it can only resume via updateTimeSlots(), which re-syncs
  // partyRoomDbId/selectedTime/slotHoldId together from a fresh check.
  if (roomChanged) {
    stopTimer();
    if (state.slotHoldId) await releaseSlotHold(state.slotHoldId);
    state.selectedTime = null;
    state.partyRoomDbId = null;
  }
}

// Step 2's hint line describes whichever slot(s) apply to the selected
// room — the ordinary 5-slot list, or whole-venue's single evening slot.
function updateStep2SlotsHint() {
  const hint = document.getElementById('step2SlotsHint');
  if (!hint) return;
  const room = state.selectedRoom;
  if (room && room.pricingModel === 'flat') {
    hint.textContent = `${room.name} sessions: 5:30 PM – 8:30 PM · available ${describeDays(room.allowedDaysOfWeek)} only`;
  } else {
    hint.textContent = 'Party room sessions: 9:30 AM · 11:30 AM · 1:30 PM · 3:30 PM · 5:30 PM (Fri/Sat only)';
  }
}

// ---------------------------------------------------------------------------
// Room photo lightbox
// ---------------------------------------------------------------------------
function openRoomPhoto(src, title) {
  const modal = document.getElementById('roomPhotoOverlay');
  const img = document.getElementById('roomPhotoImg');
  const cap = document.getElementById('roomPhotoCaption');
  if (!modal || !img) return;
  img.src = src;
  img.alt = title + ' party room';
  if (cap) cap.textContent = title;
  modal.style.display = 'flex';
}

function closeRoomPhoto() {
  const modal = document.getElementById('roomPhotoOverlay');
  if (modal) modal.style.display = 'none';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeRoomPhoto();
});

// ---------------------------------------------------------------------------
// Date/time: fetch real availability from Supabase
// ---------------------------------------------------------------------------
async function updateTimeSlots() {
  const dateVal = document.getElementById('partyDate').value;
  if (!dateVal) return;

  state.selectedDate = dateVal;
  state.selectedTime = null;
  document.getElementById('step2Next').disabled = true;

  const d   = new Date(dateVal + 'T00:00:00');
  const day = d.getDay();
  state.isWeekend = (day === 0 || day === 6);

  // Show loading state
  document.getElementById('timeSlotGrid').innerHTML = `
    <div class="col-span-2 py-6 text-center text-gray-400">
      <svg class="animate-spin h-6 w-6 mx-auto mb-2 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
      Checking availability...
    </div>`;

  await fetchAndRenderSlots(dateVal);
  subscribeToSlotChanges(dateVal);
}

async function fetchAndRenderSlots(dateVal) {
  if (!state.selectedRoom) {
    showFieldError('Please select a room first.');
    return;
  }

  const room = state.selectedRoom;
  const dow = dayOfWeekFromDateStr(dateVal);

  // Whole-venue hire (and any other future flat/day-restricted room) isn't
  // bookable at all outside its allowed days — don't even hit the
  // availability endpoint, just explain why.
  if (Array.isArray(room.allowedDaysOfWeek) && !room.allowedDaysOfWeek.includes(dow)) {
    document.getElementById('timeSlotGrid').innerHTML = `
      <div class="col-span-2 py-6 text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3">
        ${room.name} is only available on ${describeDays(room.allowedDaysOfWeek)}. Please pick a different date.
      </div>`;
    return;
  }

  try {
    const { roomId, unavailableSlots } = await callAPI(
      `slots?room_slug=${encodeURIComponent(state.selectedRoom.id)}&date=${dateVal}`,
      null, 'GET'
    );

    if (roomId) state.partyRoomDbId = roomId;
    renderSlotsHtml(slotsForRoom(room), unavailableSlots || [], dow);
  } catch (err) {
    console.error('Failed to fetch slots:', err);
    renderSlotsHtml(slotsForRoom(room), [], dow);
  }
}

function renderSlotsHtml(slots, unavailableSlots, dow) {
  const grid = document.getElementById('timeSlotGrid');
  if (!grid) return;

  let html = '';
  slots.forEach(slot => {
    const restrictedDays = RESTRICTED_SLOT_DAYS[slot];
    const dayRestricted = restrictedDays && !restrictedDays.includes(dow);
    const unavail  = !dayRestricted && unavailableSlots.includes(slot);
    const selected = state.selectedTime === slot;
    const ends = SLOT_END_TIMES[slot];
    let cls = 'time-slot';
    if (unavail || dayRestricted) cls += ' unavailable';
    if (selected) cls += ' selected';
    if (dayRestricted) {
      html += `
        <div class="${cls}">
          <div class="font-display font-bold text-base">${slot}</div>
          <div class="text-xs opacity-60 mt-0.5">${ends ? '– ' + ends.one : ''}</div>
          <div class="mt-1.5 text-xs font-semibold text-gray-400 bg-gray-100 rounded-full px-2 py-0.5 inline-block">${describeDays(restrictedDays)} only</div>
        </div>`;
    } else if (unavail) {
      html += `
        <div class="${cls}">
          <div class="font-display font-bold text-base">${slot}</div>
          <div class="text-xs opacity-60 mt-0.5">${ends ? '– ' + ends.one : ''}</div>
          <div class="mt-1.5 text-xs font-semibold text-gray-400 bg-gray-100 rounded-full px-2 py-0.5 inline-block">Full</div>
        </div>`;
    } else {
      const checkIcon = selected
        ? `<div class="mt-1.5"><svg viewBox="0 0 14 14" width="16" height="16" fill="none" class="mx-auto"><path d="M2 7l4 4 6-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
        : '';
      html += `
        <div class="${cls}" onclick="selectTime('${slot}', this)">
          <div class="font-display font-bold text-base">${slot}</div>
          <div class="text-xs opacity-70 mt-0.5">${ends ? '– ' + ends.one : ''}</div>
          ${checkIcon}
        </div>`;
    }
  });
  grid.innerHTML = html;
}

// Poll for slot changes every 10 seconds (replaces Supabase realtime)
function subscribeToSlotChanges(dateVal) {
  if (slotSubscription) clearInterval(slotSubscription);
  slotSubscription = setInterval(() => fetchAndRenderSlots(dateVal), 10000);
}

async function selectTime(slot, el) {
  // If there was a previous hold, release it
  if (state.slotHoldId) {
    await releaseSlotHold(state.slotHoldId);
  }

  document.querySelectorAll('.time-slot').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedTime = slot;
  document.getElementById('step2Next').disabled = false;

  // Create a 30-minute hold on this slot
  await createSlotHold(slot);
}

// ---------------------------------------------------------------------------
// Slot hold management
// ---------------------------------------------------------------------------
async function createSlotHold(slot) {
  if (!state.partyRoomDbId || !state.selectedDate) return;

  try {
    const { holdId, expiresAt } = await callAPI('slots/hold', {
      roomId: state.partyRoomDbId,
      date:   state.selectedDate,
      slot,
    });
    state.slotHoldId = holdId;
    // The server sets the hold's expiry equal to the booking session's —
    // refresh our copy from it (the authoritative source) rather than
    // assuming it still matches what we cached when the session opened.
    if (expiresAt) startSessionTimer(expiresAt);
    startTimer();
  } catch (err) {
    showFieldError(err.message.includes('just taken')
      ? 'That time slot was just taken! Please choose another.'
      : 'Could not hold this slot — please try again.');
    state.selectedTime = null;
    document.getElementById('step2Next').disabled = true;
    await fetchAndRenderSlots(state.selectedDate);
  }
}

async function releaseSlotHold(holdId) {
  if (!holdId) return;
  try {
    await callAPI(`slots/hold/${holdId}`, null, 'DELETE');
  } catch { /* best-effort */ }
  state.slotHoldId = null;
}

// ---------------------------------------------------------------------------
// Booking session — resume an in-progress attempt within 30 minutes instead
// of starting over, and cap customers to one active attempt at a time.
// Backed by server/routes/bookingSessions.js.
// ---------------------------------------------------------------------------
function getWizardStateSnapshot() {
  return {
    currentStep:   state.currentStep,
    guests:        state.guests,
    selectedRoom:  state.selectedRoom,
    partyRoomDbId: state.partyRoomDbId,
    selectedDate:  state.selectedDate,
    selectedTime:  state.selectedTime,
    slotHoldId:    state.slotHoldId,
    isWeekend:     state.isWeekend,
    selectedFood:  state.selectedFood,
    foodSplit:     state.foodSplit,
    allergyNotes:  document.getElementById('allergyNotes')?.value ?? state.allergyNotes,
    addons:        state.addons,
    sodaTypes:     state.sodaTypes,
    pizzaTypes:    state.pizzaTypes,
    cateringChoice: state.cateringChoice,
    noAlcoholAck:   state.noAlcoholAck,
    confirmEmail:  state.confirmEmail,
    confirmPhone:  state.confirmPhone,
  };
}

// Re-paints step DOM from a restored wizard_state blob. Reuses the same
// render functions the wizard already calls as the customer clicks through
// (renderRooms, repaintAddons, the soda/pizza picker updaters) so this
// stays in sync with however those steps normally render.
function hydrateWizardUI(saved) {
  Object.assign(state, saved);

  const gc = document.getElementById('guestCount');
  if (gc) gc.textContent = state.guests;
  renderRooms();
  updateStep2SlotsHint();

  if (state.selectedDate) {
    const dateInput = document.getElementById('partyDate');
    if (dateInput) dateInput.value = state.selectedDate;
    fetchAndRenderSlots(state.selectedDate);
    subscribeToSlotChanges(state.selectedDate);
    const step2Next = document.getElementById('step2Next');
    if (step2Next) step2Next.disabled = !state.selectedTime;
    if (state.slotHoldId) startTimer();
  }

  if (state.foodSplit) {
    const { nuggets = 0, burgers = 0, veges = 0, gfNuggets = 0 } = state.foodSplit;
    const total = nuggets + burgers + veges + gfNuggets;
    const nuggetEl = document.getElementById('nuggetCount');
    const burgerEl = document.getElementById('burgerCount');
    const vegeEl   = document.getElementById('vegeCount');
    if (nuggetEl) nuggetEl.textContent = nuggets;
    if (burgerEl) burgerEl.textContent = burgers;
    if (vegeEl)   vegeEl.textContent   = veges;
    const totalEl = document.getElementById('foodSplitTotal');
    if (totalEl) totalEl.textContent = `${total} / ${state.guests} selected`;
    const atMax = total >= state.guests;
    ['nuggetPlus', 'burgerPlus', 'vegePlus', 'gfNuggetsPlus'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = atMax;
    });
  }

  if (typeof repaintAddons === 'function') repaintAddons();

  // Restore catering choice / no-alcohol ack regardless of which step the
  // resumed session lands on — goToStep's own n===3 hook only fires when
  // step 3 is the actual destination.
  if (state.selectedRoom?.pricingModel === 'flat') renderStep3ForRoom();

  const allergyNotesEl = document.getElementById('allergyNotes');
  if (allergyNotesEl) allergyNotesEl.value = state.allergyNotes || '';

  const emailField = document.getElementById('confirmEmail');
  if (emailField) emailField.value = state.confirmEmail || state.user?.email || '';
  const phoneField = document.getElementById('confirmPhone');
  if (phoneField) phoneField.value = state.confirmPhone || '';
}

// Called from openBooking() once the customer is authenticated — replaces an
// unconditional resetWizard() with "resume if there's an active attempt,
// otherwise start fresh."
async function resumeOrStartWizard() {
  let result;
  try {
    result = await callAPI('booking-sessions/open', null, 'POST');
  } catch (err) {
    // Session service unavailable — fall back to today's behavior rather
    // than blocking the customer from booking at all.
    console.error('Could not open booking session:', err);
    resetWizard();
    return;
  }

  const { sessionId, bookingRef, resumed, wizardState, expiresAt, holdExpired } = result;

  if (resumed && wizardState && Object.keys(wizardState).length > 0) {
    for (let i = 0; i <= 6; i++) {
      const el = document.getElementById('step' + i);
      if (el) el.style.display = 'none';
    }

    state.sessionId = sessionId;
    state.bookingRef = bookingRef;
    state.sessionExpiresAt = expiresAt;
    hydrateWizardUI(wizardState);

    if (holdExpired) {
      showFieldError('Your held time slot expired while you were away — please pick a new one.');
    }

    const resumeStep = holdExpired ? Math.min(state.currentStep || 1, 2) : (state.currentStep || 1);
    state.currentStep = 0;
    goToStep(Math.max(resumeStep, 1));
  } else {
    resetWizard();
    state.sessionId = sessionId;
    state.bookingRef = bookingRef;
    state.sessionExpiresAt = expiresAt;
  }

  startSessionTimer(state.sessionExpiresAt);
}

// Autosaved on every step transition (see goToStep in app.js) — not on every
// keystroke, so at most a handful of calls per attempt.
async function saveSessionState() {
  if (!state.sessionId) return;
  try {
    await callAPI(`booking-sessions/${state.sessionId}`, { wizardState: getWizardStateSnapshot() }, 'PATCH');
  } catch (err) {
    if (err.status === 410) {
      state.sessionId = null;
      stopSessionTimer();
      showFieldError('Your booking attempt timed out — starting a fresh attempt.');
      if (typeof resumeOrStartWizard === 'function') resumeOrStartWizard();
      else resetWizard();
    }
    // Other failures are non-fatal — the next step transition will retry.
  }
}

// Single ticking engine for BOTH the "attempt expires in" countdown and the
// "room hold expires" bar — the server sets a slot hold's hold_expires_at
// equal to the booking session's expires_at (see POST /api/slots/hold), so
// there's exactly one deadline for the whole wizard attempt. Both displays
// are painted from that same `expiresAt` value on every tick instead of
// running independent countdowns, which is what let them drift apart.
let sessionTimerInterval = null;
function startSessionTimer(expiresAt) {
  stopSessionTimer();
  if (!expiresAt) return;
  state.sessionExpiresAt = expiresAt;

  const sessionEl      = document.getElementById('sessionCountdown');
  const sessionDisplay = document.getElementById('sessionCountdownDisplay');
  const holdBar        = document.getElementById('timerBar');
  const holdDisplay     = document.getElementById('timerDisplay');

  const tick = () => {
    const remainingMs = new Date(expiresAt).getTime() - Date.now();
    const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const txt = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    if (sessionDisplay) sessionDisplay.textContent = txt;
    if (holdDisplay)    holdDisplay.textContent = txt;
    if (holdBar)         holdBar.classList.toggle('urgent', totalSec <= 120);

    if (remainingMs <= 0) {
      stopSessionTimer();
      handleTimerExpiry();
    }
  };

  if (sessionEl) sessionEl.style.display = 'block';
  tick();
  sessionTimerInterval = setInterval(tick, 1000);
}

function stopSessionTimer() {
  clearInterval(sessionTimerInterval);
  const el = document.getElementById('sessionCountdown');
  if (el) el.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Food selection
// ---------------------------------------------------------------------------
function selectFood(type, el) {
  document.querySelectorAll('.food-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedFood = type;
}

// ---------------------------------------------------------------------------
// Step 3 — swaps between the ordinary per-child food/add-ons picker and
// whole-venue hire's catering choice + no-alcohol acknowledgment.
// ---------------------------------------------------------------------------
function renderStep3ForRoom() {
  const isWholeVenue = state.selectedRoom?.pricingModel === 'flat';
  const foodSection = document.getElementById('foodAddonsSection');
  const cateringSection = document.getElementById('wholeVenueCateringSection');
  const heading = document.getElementById('step3Heading');
  const subheading = document.getElementById('step3Subheading');
  if (!foodSection || !cateringSection) return;

  foodSection.classList.toggle('hidden', isWholeVenue);
  cateringSection.classList.toggle('hidden', !isWholeVenue);

  if (heading) heading.textContent = isWholeVenue ? 'Catering & house rules' : "What's on the menu?";
  if (subheading) subheading.textContent = isWholeVenue
    ? 'Choose how food & drink will be handled for your event.'
    : "Pick your main meal (included) and add any extras you'd like.";

  if (isWholeVenue) {
    // Restore a previously-chosen radio/checkbox (e.g. resumed session or
    // navigating back to this step) rather than always defaulting to blank.
    if (state.cateringChoice) {
      const radio = document.querySelector(`input[name="cateringChoice"][value="${state.cateringChoice}"]`);
      if (radio) radio.checked = true;
    }
    const alcoholEl = document.getElementById('noAlcoholAck');
    if (alcoholEl) alcoholEl.checked = !!state.noAlcoholAck;
    onCateringChoiceChange();
  } else {
    placeAddonsBlock(false);
  }
}

// Tracks the Add-Ons block's original spot in the ordinary-room markup so it
// can be moved back after being relocated into the whole-venue catering
// section (see placeAddonsBlock) — captured once, on first use.
let addonsHomeParent = null;
let addonsHomeNextSibling = null;

// The Add-Ons list (#addonsBlock) is a single shared DOM node — for
// whole-venue hire's "venue menu" option we relocate it (rather than
// duplicating the markup, which would create duplicate ids) into
// #wholeVenueMenuSlot and retitle it "Menu", since venue-menu items are
// purchased individually rather than including a free per-child meal like
// the ordinary rooms' top-3 nuggets/burger/vege-burger picker does.
function placeAddonsBlock(showAsMenu) {
  const block = document.getElementById('addonsBlock');
  if (!block) return;
  if (!addonsHomeParent) {
    addonsHomeParent = block.parentNode;
    addonsHomeNextSibling = block.nextSibling;
  }

  const icon = document.getElementById('addonsHeadingIcon');
  const label = document.getElementById('addonsHeadingLabel');
  const suffix = document.getElementById('addonsHeadingSuffix');
  const subheading = document.getElementById('addonsSubheadingText');

  if (showAsMenu === null) {
    block.classList.add('hidden');
    return;
  }

  if (showAsMenu) {
    const slot = document.getElementById('wholeVenueMenuSlot');
    if (slot && block.parentNode !== slot) slot.appendChild(block);
    if (icon) icon.textContent = '🍽️';
    if (label) label.textContent = 'Menu';
    if (suffix) suffix.textContent = '';
    if (subheading) subheading.textContent = "Choose what you'd like to order — priced per item, added to your total.";
  } else {
    if (addonsHomeParent && block.parentNode !== addonsHomeParent) {
      addonsHomeParent.insertBefore(block, addonsHomeNextSibling);
    }
    if (icon) icon.textContent = '➕';
    if (label) label.textContent = 'Add-Ons';
    if (suffix) suffix.textContent = '(optional extras)';
    if (subheading) subheading.textContent = 'Prices are per item — added to your total.';
  }
  block.classList.remove('hidden');
}

function onCateringChoiceChange() {
  const checked = document.querySelector('input[name="cateringChoice"]:checked');
  const note = document.getElementById('cateringChoiceNote');
  if (!note) return;
  if (!checked) {
    note.classList.add('hidden');
    placeAddonsBlock(null);
    return;
  }
  note.classList.remove('hidden');
  note.innerHTML = checked.value === 'venue_menu'
    ? '🍽️ No outside food or drink is permitted — birthday cake is always the exception. Choose your items from the menu below.'
    : '🍽️ You&rsquo;re bringing your own food & drink — birthday cake and everything else is up to you.';
  placeAddonsBlock(checked.value === 'venue_menu' ? true : null);
}

// ---------------------------------------------------------------------------
// Save confirmed booking
// ---------------------------------------------------------------------------
async function saveBookingToSupabase(paymentIntentId, amountPaid) {
  const allergyNotes = document.getElementById('allergyNotes')?.value.trim() || '';
  const cardholderName = document.getElementById('cardholderName')?.value.trim() || null;

  const addonLines = getAddonSummaryLines();
  const addonsSummary = addonLines.length > 0
    ? addonLines.map(a => `${a.label} ×${a.qty} ($${a.subtotal.toFixed(2)})`).join(', ')
    : '';
  const addonsAmount = getAddonTotal();
  const baseAmount   = amountPaid - addonsAmount;

  // bookingRef comes from the booking session opened when the wizard started
  // (see resumeOrStartWizard) — reused as-is so the ref Stripe/POLi saw during
  // payment matches what lands in the bookings table, instead of minting a
  // fresh one here that would never match.
  const { bookingId } = await callAPI('bookings', {
    bookingRef: state.bookingRef,
    roomId:                  state.partyRoomDbId,
    roomSlug:                state.selectedRoom?.id,
    partyDate:               state.selectedDate,
    partyTime:               state.selectedTime,
    guestCount:              state.guests,
    foodChoice:              state.selectedFood,
    allergyNotes,
    addonsSummary,
    baseAmount,
    addonsAmount,
    totalAmount:             amountPaid,
    contactEmail:            state.confirmEmail,
    contactPhone:            '+64' + state.confirmPhone.replace(/\s/g, ''),
    stripePaymentIntentId:   paymentIntentId,
    slotHoldId:              state.slotHoldId,
    cardholderName,
    cateringChoice:          state.cateringChoice,
    noAlcoholAck:            state.noAlcoholAck,
  });

  state.slotHoldId = null;
  return bookingId;
}

// ---------------------------------------------------------------------------
// Finalise booking (called after payment success)
// ---------------------------------------------------------------------------
async function finaliseBooking() {
  const email = document.getElementById('confirmEmail').value.trim();
  const phone = document.getElementById('confirmPhone').value.trim();

  if (!email || !phone) { showFieldError('Please enter both your email and mobile number.'); return; }
  if (!isValidEmail(email)) { showFieldError('Please enter a valid email address.'); return; }
  if (!isValidNzMobile(phone)) {
    showFieldError('Please enter a valid NZ mobile number (e.g. 021 234 5678).');
    return;
  }

  state.confirmEmail = email;
  state.confirmPhone = phone;

  // Update user profile with phone
  if (state.user.id) {
    await upsertUserProfile(state.user.id, state.user.firstName, state.user.lastName, state.user.email, '+64' + phone.replace(/\s/g, ''));
  }

  setFinaliseLoading(true);

  try {
    // Save confirmed booking
    const bookingId = await saveBookingToSupabase(state.stripePaymentIntentId, state.calculatedTotal);
    state.bookingId = bookingId;

    // Booking succeeded — the server also marks the session completed, but
    // stop autosaving locally regardless so no further PATCHes fire.
    state.sessionId = null;
    stopSessionTimer();

    // Trigger Edge Functions: email + SMS
    const addonLines = getAddonSummaryLines();
    const addonsSummaryText = addonLines.map(a => `${a.label} ×${a.qty} ($${a.subtotal.toFixed(2)})`).join(', ');

    await callEdgeFunction('send-booking-confirmation', {
      bookingRef:     state.bookingRef,
      bookingId,
      email,
      phone:          phone.replace(/\s/g, ''),
      firstName:      state.user.firstName,
      lastName:       state.user.lastName,
      roomName:       state.selectedRoom.name,
      partyDate:      state.selectedDate,
      partyTime:      state.selectedTime,
      guestCount:     state.guests,
      foodChoice:     state.selectedFood,
      addonsSummary:  addonsSummaryText,
      totalAmount:    state.calculatedTotal,
      cateringChoice: state.cateringChoice,
      noAlcoholAck:   state.noAlcoholAck,
    });

    stopTimer();
    buildConfirmationCard();
    goToStep(6);
    launchConfetti();
  } catch (err) {
    showFieldError('Something went wrong: ' + err.message + '. Please contact us at Bookings@wonderworldwestgate.co.nz');
  } finally {
    setFinaliseLoading(false);
  }
}

function buildConfirmationCard() {
  const room = state.selectedRoom;
  const isFlat = room?.pricingModel === 'flat';
  const addonLines = getAddonSummaryLines();
  const addonHtml = addonLines.length > 0
    ? addonLines.map(a => `<div class="text-gray-500">+ ${a.label} ×${a.qty}</div><div class="font-semibold">$${a.subtotal.toFixed(2)}</div>`).join('')
    : '';

  const cateringLabel = state.cateringChoice === 'venue_menu' ? 'Venue menu' : 'Self-catering';
  const middleRowsHtml = isFlat
    ? `
      <div class="text-gray-500">Catering</div><div class="font-semibold">${cateringLabel}</div>
      <div class="text-gray-500">Alcohol</div><div class="font-semibold">Not permitted 🚫</div>
      ${addonHtml}`
    : `
      <div class="text-gray-500">Food</div><div class="font-semibold">${state.selectedFood || '—'}</div>
      ${addonHtml}`;

  document.getElementById('bookingSummaryCard').innerHTML = `
    <div class="font-display font-bold text-xl text-gray-800 mb-1">🎂 Booking Confirmed!</div>
    <div class="text-indigo-600 font-bold text-sm mb-4">Ref: ${state.bookingRef}</div>
    <div class="grid grid-cols-2 gap-y-2 text-sm">
      <div class="text-gray-500">Room</div><div class="font-semibold">${room?.name || ''}</div>
      <div class="text-gray-500">Date & Time</div><div class="font-semibold">${state.selectedDate} at ${state.selectedTime}</div>
      <div class="text-gray-500">Guests</div><div class="font-semibold">${state.guests} kids</div>
      ${middleRowsHtml}
      <div class="text-gray-500">Total Paid</div><div class="font-bold text-indigo-600">$${state.calculatedTotal?.toFixed(2)} NZD</div>
      <div class="text-gray-500">Receipt to</div><div class="font-semibold text-sm truncate">${state.confirmEmail}</div>
      <div class="text-gray-500">SMS to</div><div class="font-semibold">+64 ${state.confirmPhone}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Add-on prices
// ---------------------------------------------------------------------------
const ADDON_PRICES = {
  pizza_11:        { label: '11-inch Pizza',            price: 25 },
  platter_chicken: { label: 'Fried Chicken Platter',    price: 39 },
  platter_seafood: { label: 'Seafood Platter',          price: 49 },
  adult_sandwich:  { label: 'Adult Sandwich Platter',   price: 60 },
  sushi_40:        { label: 'Sushi Platter (40 pcs)',   price: 60 },
  sushi_24:        { label: 'Sushi Platter (24 pcs)',   price: 30 },
  sushi_salmon:    { label: 'Salmon Supreme Platter',   price: 28.90 },
  sushi_ocean:     { label: 'Ocean Deluxe Set',         price: 39.90 },
  sushi_kids48:    { label: 'Kids Party Platter (48pcs)', price: 49.90 },
  sushi_garden28:  { label: 'Green Garden Platter (28pcs)', price: 42.90 },
  drinks_soda:     { label: 'Soft Drink', price: 10 },
  nuggets_15pc:    { label: 'Chicken Nuggets (15pc)', price: 20 },
  fries_large:     { label: 'Large Fries', price: 20 },
  gf_nuggets:      { label: 'Gluten-Free Nuggets', price: 5 },
};

// Feature flag — the gluten-free nugget upgrade is fully built (pricing,
// order summary, food-prep report) but held back from customers pending
// a manual check. Flip to true to go live; no other changes needed. See
// updateGfNuggetsUI below and changeFoodSplit('gfNuggets', ...) in app.js.
const GF_NUGGETS_ENABLED = true;

// Also live for anyone in private test mode (see isTestMode() in app.js),
// so it can be verified before flipping the flag above for everyone.
function gfNuggetsEnabled() {
  return GF_NUGGETS_ENABLED || (typeof isTestMode === 'function' && isTestMode());
}

function changeAddon(id, delta) {
  if (!state.addons) state.addons = {};
  const current = state.addons[id] || 0;
  const next = Math.max(0, current + delta);
  state.addons[id] = next;
  const el = document.getElementById('addon_' + id);
  if (el) el.textContent = next;

  if (id === 'drinks_soda') {
    const picker = document.getElementById('sodaTypePicker');
    if (picker) picker.classList.toggle('hidden', next === 0);
    if (next === 0) {
      state.sodaTypes = {};
    } else if (state.sodaTypes) {
      let total = Object.values(state.sodaTypes).reduce((s, v) => s + v, 0);
      let excess = total - next;
      const types = Object.keys(state.sodaTypes);
      for (let i = types.length - 1; i >= 0 && excess > 0; i--) {
        const cut = Math.min(state.sodaTypes[types[i]], excess);
        state.sodaTypes[types[i]] -= cut;
        excess -= cut;
        if (state.sodaTypes[types[i]] === 0) delete state.sodaTypes[types[i]];
      }
    }
    updateSodaPickerUI();
  }

  if (id === 'pizza_11') {
    const picker = document.getElementById('pizzaTypePicker');
    if (picker) picker.classList.toggle('hidden', next === 0);
    if (next === 0) {
      state.pizzaTypes = {};
    } else if (state.pizzaTypes) {
      // Trim allocated total down to new qty
      let total = Object.values(state.pizzaTypes).reduce((s, v) => s + v, 0);
      let excess = total - next;
      const types = Object.keys(state.pizzaTypes);
      for (let i = types.length - 1; i >= 0 && excess > 0; i--) {
        const cut = Math.min(state.pizzaTypes[types[i]], excess);
        state.pizzaTypes[types[i]] -= cut;
        excess -= cut;
        if (state.pizzaTypes[types[i]] === 0) delete state.pizzaTypes[types[i]];
      }
    }
    updatePizzaPickerUI();
  }

  updateAddonSubtotal();
  renderOrderSummary();
}

// Repaints every addon counter + sub-picker from state — used when hydrating
// a resumed booking session, where state is restored programmatically rather
// than built up one click at a time via changeAddon().
function repaintAddons() {
  if (!state.addons) return;
  Object.keys(ADDON_PRICES).forEach(id => {
    const el = document.getElementById('addon_' + id);
    if (el) el.textContent = state.addons[id] || 0;
  });
  const pizzaPicker = document.getElementById('pizzaTypePicker');
  if (pizzaPicker) pizzaPicker.classList.toggle('hidden', !(state.addons.pizza_11 > 0));
  const sodaPicker = document.getElementById('sodaTypePicker');
  if (sodaPicker) sodaPicker.classList.toggle('hidden', !(state.addons.drinks_soda > 0));
  updatePizzaPickerUI();
  updateSodaPickerUI();
  updateGfNuggetsUI();
  updateAddonSubtotal();
  renderOrderSummary();
}

// Gluten-free nuggets is its own peer card in the food-split grid (see
// menu.html/prices.html #gfNuggetsCard), sharing the same guest-count pool
// as Chicken Nuggets/Mini Burger/Vege Burger — its +/- routes through the
// same changeFoodSplit('gfNuggets', ...) as the other three. This just
// shows/hides the card (and the grid's column count) for the feature flag,
// and keeps everything zeroed while it's held back.
function updateGfNuggetsUI() {
  const card = document.getElementById('gfNuggetsCard');
  const grid = document.getElementById('foodSplitGrid');
  const enabled = gfNuggetsEnabled();

  if (grid) {
    grid.classList.toggle('grid-cols-2', enabled);
    grid.classList.toggle('grid-cols-3', !enabled);
  }

  if (!enabled) {
    // Held back from customers — keep it hidden and zeroed, so nothing
    // renders or prices even if some other path (e.g. a resumed session
    // saved before this flag existed) sets it.
    if (card) card.classList.add('hidden');
    if (state.foodSplit) state.foodSplit.gfNuggets = 0;
    if (state.addons) state.addons.gf_nuggets = 0;
    const countEl = document.getElementById('addon_gf_nuggets');
    if (countEl) countEl.textContent = '0';
    return;
  }

  if (card) card.classList.remove('hidden');
  const countEl = document.getElementById('addon_gf_nuggets');
  if (countEl) countEl.textContent = state.addons?.gf_nuggets || 0;
}

function updateSodaPickerUI() {
  if (!state.sodaTypes) state.sodaTypes = {};
  const qty = state.addons?.drinks_soda || 0;
  const total = Object.values(state.sodaTypes).reduce((s, v) => s + v, 0);
  const atMax = total >= qty;
  const typeIds = { 'Coke': 'Coke', 'Sprite': 'Sprite', 'Fanta': 'Fanta', 'L&P': 'LandP' };
  Object.entries(typeIds).forEach(([type, id]) => {
    const qtyEl = document.getElementById('sodaQty_' + id);
    if (qtyEl) qtyEl.textContent = state.sodaTypes[type] || 0;
    const plusEl = document.getElementById('sodaPlus_' + id);
    if (plusEl) {
      plusEl.classList.toggle('opacity-30', atMax);
      plusEl.classList.toggle('pointer-events-none', atMax);
    }
  });
  const counter = document.getElementById('sodaTypeCounter');
  if (counter) counter.textContent = `${total} / ${qty} allocated`;
}

function changeSodaType(type, delta) {
  if (!state.sodaTypes) state.sodaTypes = {};
  const qty = state.addons?.drinks_soda || 0;
  const total = Object.values(state.sodaTypes).reduce((s, v) => s + v, 0);
  if (delta > 0 && total >= qty) return;
  const next = Math.max(0, (state.sodaTypes[type] || 0) + delta);
  if (next === 0) delete state.sodaTypes[type]; else state.sodaTypes[type] = next;
  updateSodaPickerUI();
  renderOrderSummary();
}

function updatePizzaPickerUI() {
  if (!state.pizzaTypes) state.pizzaTypes = {};
  const qty = state.addons?.pizza_11 || 0;
  const total = Object.values(state.pizzaTypes).reduce((s, v) => s + v, 0);
  const atMax = total >= qty;
  const typeIds = {
    'Ham & Cheese': 'HamCheese',
    'Salami & Cheese': 'SalamiCheese',
    'Chorizo & Cheese': 'ChorizoCheese',
    'Plain Cheese': 'PlainCheese',
    'Vege Pizza': 'VegePizza',
  };
  Object.entries(typeIds).forEach(([type, id]) => {
    const qtyEl = document.getElementById('pizzaQty_' + id);
    if (qtyEl) qtyEl.textContent = state.pizzaTypes[type] || 0;
    const plusEl = document.getElementById('pizzaPlus_' + id);
    if (plusEl) {
      plusEl.classList.toggle('opacity-30', atMax);
      plusEl.classList.toggle('pointer-events-none', atMax);
    }
  });
  const counter = document.getElementById('pizzaTypeCounter');
  if (counter) counter.textContent = `${total} / ${qty} allocated`;
}

function changePizzaType(type, delta) {
  if (!state.pizzaTypes) state.pizzaTypes = {};
  const qty = state.addons?.pizza_11 || 0;
  const total = Object.values(state.pizzaTypes).reduce((s, v) => s + v, 0);
  if (delta > 0 && total >= qty) return;
  const next = Math.max(0, (state.pizzaTypes[type] || 0) + delta);
  if (next === 0) delete state.pizzaTypes[type]; else state.pizzaTypes[type] = next;
  updatePizzaPickerUI();
  renderOrderSummary();
}

function updateAddonSubtotal() {
  const subtotal = getAddonTotal();
  const el = document.getElementById('addonSubtotal');
  const amt = document.getElementById('addonSubtotalAmount');
  if (!el || !amt) return;
  if (subtotal > 0) {
    el.classList.remove('hidden');
    amt.textContent = '$' + subtotal.toFixed(2);
  } else {
    el.classList.add('hidden');
  }
}

function getAddonTotal() {
  if (!state.addons) return 0;
  return Object.entries(state.addons).reduce((sum, [id, qty]) => {
    return sum + (ADDON_PRICES[id]?.price || 0) * qty;
  }, 0);
}

function getAddonSummaryLines() {
  if (!state.addons) return [];
  return Object.entries(state.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => {
      const a = ADDON_PRICES[id];
      let label = a.label;
      if (id === 'drinks_soda' && state.sodaTypes && Object.keys(state.sodaTypes).length > 0) {
        const parts = Object.entries(state.sodaTypes).filter(([,n]) => n > 0).map(([t,n]) => n > 1 ? `${t} x${n}` : t);
        label = 'Soft Drink (' + parts.join(', ') + ')';
      }
      if (id === 'pizza_11' && state.pizzaTypes && Object.keys(state.pizzaTypes).length > 0) {
        const parts = Object.entries(state.pizzaTypes).filter(([,n]) => n > 0).map(([t,n]) => n > 1 ? `${t} x${n}` : t);
        label = '11-inch Pizza (' + parts.join(', ') + ')';
      }
      return { label, qty, price: a.price, subtotal: a.price * qty };
    });
}
function renderOrderSummary() {
  if (!state.selectedRoom) return;
  const room = state.selectedRoom;
  const isFlat = room.pricingModel === 'flat';
  const baseTotal = isFlat ? room.flatPrice : room.basePricePerChild * state.guests;
  const addonTotal = getAddonTotal();
  const total = baseTotal + addonTotal;
  state.calculatedTotal = total;

  const addonLines = getAddonSummaryLines();

  let addonHtml = '';
  if (addonLines.length > 0) {
    addonHtml = addonLines.map(a =>
      `<div class="flex justify-between text-indigo-700"><span>+ ${a.label} ×${a.qty}</span><span class="font-semibold">$${a.subtotal.toFixed(2)}</span></div>`
    ).join('');
  }

  const cateringLabel = state.cateringChoice === 'venue_menu' ? 'Venue menu'
    : state.cateringChoice === 'self_catering' ? 'Self-catering' : 'Not selected';

  const detailsHtml = isFlat
    ? `
      <div class="flex justify-between"><span>Catering:</span><span class="font-semibold">${cateringLabel}</span></div>
      <div class="flex justify-between"><span>Alcohol:</span><span class="font-semibold">Not permitted 🚫</span></div>
      <div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${baseTotal.toLocaleString()} flat (venue rental only)</span></div>`
    : `
      <div class="flex justify-between"><span>Food:</span><span class="font-semibold">${state.selectedFood || 'Not selected'}</span></div>
      <div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${room.basePricePerChild}/child × ${state.guests} = $${baseTotal.toFixed(2)}</span></div>`;

  document.getElementById('orderSummaryPill').innerHTML = `
    <div class="font-display font-bold text-indigo-700 mb-3 text-base">📋 Your Order Summary</div>
    <div class="space-y-1.5 text-sm text-indigo-800">
      <div class="flex justify-between"><span>Room:</span><span class="font-semibold">${room.name}</span></div>
      <div class="flex justify-between"><span>Date:</span><span class="font-semibold">${state.selectedDate} @ ${state.selectedTime}</span></div>
      <div class="flex justify-between"><span>Guests:</span><span class="font-semibold">${state.guests} children</span></div>
      ${detailsHtml}
      ${addonHtml}
      <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
        <span>Total:</span><span class="text-indigo-600">$${total.toFixed(2)} NZD</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
// The room-hold bar's actual ticking is driven by startSessionTimer() above
// (same shared expiresAt) — this just shows/hides the bar itself.
function startTimer() {
  const tc = document.getElementById('timerContainer');
  if (tc) tc.style.display = 'block';
}

// Fires once when the shared deadline (booking session + room hold, always
// the same instant) passes. The whole attempt is over at that point, not
// just the room hold, so this reopens a fresh session/hold rather than
// leaving the customer in a dead wizard with no active session.
//
// If a payment confirmation is in flight (state.paymentInFlight, set by
// payment.js around stripe.confirmPayment()), deleting the hold and
// resetting the wizard right now would race an in-progress charge — the
// card can still succeed a moment later with the hold already gone and no
// wizard state left to save a booking against (see WW-129HC4 incident
// writeup). Defer instead of acting: by the time paymentInFlight clears,
// this is either moot (payment succeeded, wizard already moved to step 5)
// or the hold really is dead and this runs for real.
async function handleTimerExpiry() {
  if (state.paymentInFlight) {
    setTimeout(handleTimerExpiry, 1000);
    return;
  }

  const display = document.getElementById('timerDisplay');
  if (display) display.textContent = '00:00';

  if (state.slotHoldId) {
    await releaseSlotHold(state.slotHoldId);
  }
  state.sessionId = null;

  alert('⏰ Your booking attempt has expired. Starting a fresh attempt — please choose your details again.');
  if (typeof resumeOrStartWizard === 'function') resumeOrStartWizard();
  else resetWizard();
}

function stopTimer() {
  if (slotSubscription) { clearInterval(slotSubscription); slotSubscription = null; }
  const tc = document.getElementById('timerContainer');
  if (tc) tc.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setFinaliseLoading(loading) {
  const btn     = document.getElementById('finaliseBtn');
  const text    = document.getElementById('finaliseBtnText');
  const spinner = document.getElementById('finaliseBtnSpinner');
  if (!btn) return;
  btn.disabled = loading;
  if (text)    text.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidNzMobile(phone) {
  // Strip spaces, dashes, and an optional leading +64 / 0064 / 64
  let cleaned = phone.replace(/[\s-]/g, '');
  cleaned = cleaned.replace(/^(\+?64|0064)/, '0');
  // NZ mobiles: 02x followed by 7-9 digits (total 9-10 digits starting with 02)
  return /^02[0-9]\d{6,8}$/.test(cleaned);
}