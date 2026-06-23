/**
 * booking.js
 * Handles:
 *   - Room rendering & selection
 *   - Time slot fetching from Supabase (real availability)
 *   - Optimistic slot locking (15-min hold)
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
  },
  {
    id: 'dream', name: 'Dream Room', emoji: '🌙', color: 'purple',
    tagLine: 'Purple · Magical & Dreamy',
    minGuests: 8, maxGuests: 15, basePricePerChild: 39,
    description: 'Soft lighting, dreamy decor, and a magical atmosphere kids will talk about for weeks.',
  },
  {
    id: 'forest', name: 'Wonder Forest Room', emoji: '🌿', color: 'green',
    tagLine: 'Green · Nature Adventure',
    minGuests: 8, maxGuests: 15, basePricePerChild: 39,
    description: 'An immersive forest theme with climbing elements and nature-inspired details throughout.',
  },
  {
    id: 'big', name: 'The Big Room', emoji: '🌟', color: 'indigo',
    tagLine: 'Exclusive Extra Large Zone',
    minGuests: 12, maxGuests: 24,
    basePricePerChild: 39, weekdayTotal: 39, weekendTotal: 49,
    description: 'Our flagship space — private stage, expanded play zone, and everything to make an unforgettable impression.',
    badge: 'BEST VALUE',
  },
];

const ROOM_COLOR_MAP = {
  indigo: { border: 'border-indigo-200', bg: 'bg-indigo-50', badge: 'bg-indigo-500', text: 'text-indigo-600' },
  yellow: { border: 'border-yellow-200', bg: 'bg-yellow-50', badge: 'bg-yellow-400', text: 'text-yellow-700' },
  purple: { border: 'border-purple-200', bg: 'bg-purple-50', badge: 'bg-purple-500', text: 'text-purple-600' },
  green:  { border: 'border-green-200',  bg: 'bg-green-50',  badge: 'bg-green-500',  text: 'text-green-600' },
};

// Official party room booking times (from poster)
const ALL_SLOTS = ['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM'];

// Slot end times for display
const SLOT_END_TIMES = {
  '9:30 AM':  { one: '11:00 AM', two: '11:30 AM' },
  '11:30 AM': { one: '1:00 PM',  two: '1:30 PM'  },
  '1:30 PM':  { one: '3:00 PM',  two: '3:30 PM'  },
  '3:30 PM':  { one: '5:00 PM',  two: '5:30 PM'  },
};

// Tracks our slot polling interval (replaces Supabase realtime)
let slotSubscription = null;

// ---------------------------------------------------------------------------
// Guest count adjustment
// ---------------------------------------------------------------------------
function adjustGuests(delta) {
  state.guests = Math.max(1, Math.min(24, state.guests + delta));
  document.getElementById('guestCount').textContent = state.guests;
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

  return `
    <div class="${selClass} ${dimClass} p-4" onclick="selectRoom('${room.id}')">
      <div class="flex items-start gap-3">
        <div class="w-11 h-11 ${c.badge} rounded-xl flex items-center justify-center text-2xl flex-shrink-0 text-white">${room.emoji}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-0.5">
            <span class="font-display font-bold text-base leading-tight">${room.name}</span>
            ${room.badge ? `<span class="bg-amber-400 text-gray-900 text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap">${room.badge}</span>` : ''}
          </div>
          <div class="text-xs text-gray-400 leading-snug">${room.minGuests}–${room.maxGuests} kids · ${room.tagLine}</div>
          <div class="flex items-center justify-between mt-1.5 flex-wrap gap-1">
            <div class="${c.text} font-display font-bold text-sm">$${room.basePricePerChild}/child</div>
            ${selected ? '<div class="text-indigo-500 text-xs font-semibold">✓ Selected</div>' : ''}
          </div>
        </div>
      </div>
    </div>`;
}

function selectRoom(id) {
  state.selectedRoom = ROOMS.find(r => r.id === id);
  renderRooms();
  const nextBtn = document.getElementById('step1Next');
  nextBtn.disabled = false;
  nextBtn.style.opacity = '1';
}

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

  const tag = document.getElementById('dayTypeTag');
  tag.style.display = 'inline-block';
  if (state.isWeekend) {
    tag.textContent = '📅 Weekend — peak pricing applies';
    tag.className   = 'mt-2 text-xs font-semibold rounded-full px-3 py-1 inline-block bg-amber-100 text-amber-700';
  } else {
    tag.textContent = '📅 Weekday — standard pricing';
    tag.className   = 'mt-2 text-xs font-semibold rounded-full px-3 py-1 inline-block bg-teal-100 text-teal-700';
  }

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

  try {
    const { roomId, unavailableSlots } = await callAPI(
      `slots?room_slug=${encodeURIComponent(state.selectedRoom.id)}&date=${dateVal}`,
      null, 'GET'
    );

    if (roomId) state.partyRoomDbId = roomId;
    renderSlotsHtml(ALL_SLOTS, unavailableSlots || []);
  } catch (err) {
    console.error('Failed to fetch slots:', err);
    renderSlotsHtml(ALL_SLOTS, []);
  }
}

function renderSlotsHtml(slots, unavailableSlots) {
  const grid = document.getElementById('timeSlotGrid');
  if (!grid) return;

  let html = '';
  slots.forEach(slot => {
    const unavail  = unavailableSlots.includes(slot);
    const selected = state.selectedTime === slot;
    const ends = SLOT_END_TIMES[slot];
    let cls = 'time-slot';
    if (unavail)  cls += ' unavailable';
    if (selected) cls += ' selected';
    if (unavail) {
      html += `<div class="${cls}"><div class="font-semibold">${slot}</div><div class="text-xs opacity-60">– ${ends?.one || ''}</div><div class="text-xs text-gray-400 mt-0.5">Full</div></div>`;
    } else {
      html += `<div class="${cls}" onclick="selectTime('${slot}', this)"><div class="font-semibold">${slot}</div><div class="text-xs opacity-75">– ${ends?.one || ''}</div></div>`;
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

  // Create a 15-minute hold on this slot
  await createSlotHold(slot);
}

// ---------------------------------------------------------------------------
// Slot hold management
// ---------------------------------------------------------------------------
async function createSlotHold(slot) {
  if (!state.partyRoomDbId || !state.selectedDate) return;

  try {
    const { holdId } = await callAPI('slots/hold', {
      roomId: state.partyRoomDbId,
      date:   state.selectedDate,
      slot,
    });
    state.slotHoldId = holdId;
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
// Food selection
// ---------------------------------------------------------------------------
function selectFood(type, el) {
  document.querySelectorAll('.food-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedFood = type;
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

  const bookingRef = 'WW-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  state.bookingRef = bookingRef;

  const { bookingId } = await callAPI('bookings', {
    bookingRef,
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
    });

    stopTimer();
    buildConfirmationCard();
    goToStep(6);
    launchConfetti();
  } catch (err) {
    showFieldError('Something went wrong: ' + err.message + '. Please contact us at hello@wonderworldwestgate.co.nz');
  } finally {
    setFinaliseLoading(false);
  }
}

function buildConfirmationCard() {
  const room = state.selectedRoom;
  const addonLines = getAddonSummaryLines();
  const addonHtml = addonLines.length > 0
    ? addonLines.map(a => `<div class="text-gray-500">+ ${a.label} ×${a.qty}</div><div class="font-semibold">$${a.subtotal.toFixed(2)}</div>`).join('')
    : '';

  document.getElementById('bookingSummaryCard').innerHTML = `
    <div class="font-display font-bold text-xl text-gray-800 mb-1">🎂 Booking Confirmed!</div>
    <div class="text-indigo-600 font-bold text-sm mb-4">Ref: ${state.bookingRef}</div>
    <div class="grid grid-cols-2 gap-y-2 text-sm">
      <div class="text-gray-500">Room</div><div class="font-semibold">${room?.name || ''}</div>
      <div class="text-gray-500">Date & Time</div><div class="font-semibold">${state.selectedDate} at ${state.selectedTime}</div>
      <div class="text-gray-500">Guests</div><div class="font-semibold">${state.guests} kids</div>
      <div class="text-gray-500">Food</div><div class="font-semibold">${state.selectedFood || '—'}</div>
      ${addonHtml}
      <div class="text-gray-500">Total Paid</div><div class="font-bold text-indigo-600">$${state.calculatedTotal?.toFixed(2)} NZD</div>
      <div class="text-gray-500">Receipt to</div><div class="font-semibold text-sm truncate">${state.confirmEmail}</div>
      <div class="text-gray-500">SMS to</div><div class="font-semibold">+64 ${state.confirmPhone}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Add-on prices
// ---------------------------------------------------------------------------
const ADDON_PRICES = {
  pizza_ham:       { label: 'Ham & Cheese Pizza',       price: 25 },
  pizza_veg:       { label: 'Vegetarian Pizza',         price: 25 },
  platter_chicken: { label: 'Fried Chicken Platter',    price: 39 },
  platter_seafood: { label: 'Seafood Platter',          price: 49 },
  adult_sandwich:  { label: 'Adult Sandwich Platter',   price: 60 },
  sushi_40:        { label: 'Sushi Platter (40 pcs)',   price: 60 },
  sushi_24:        { label: 'Sushi Platter (24 pcs)',   price: 30 },
  sushi_salmon:    { label: 'Salmon Supreme Platter',   price: 28.90 },
  sushi_ocean:     { label: 'Ocean Deluxe Set',         price: 39.90 },

};

function changeAddon(id, delta) {
  if (!state.addons) state.addons = {};
  const current = state.addons[id] || 0;
  const next = Math.max(0, current + delta);
  state.addons[id] = next;
  const el = document.getElementById('addon_' + id);
  if (el) el.textContent = next;
  updateAddonSubtotal();
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
      return { label: a.label, qty, price: a.price, subtotal: a.price * qty };
    });
}
function renderOrderSummary() {
  if (!state.selectedRoom) return;
  const room = state.selectedRoom;
  const pricePerChild = room.basePricePerChild;
  const baseTotal = pricePerChild * state.guests;
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

  document.getElementById('orderSummaryPill').innerHTML = `
    <div class="font-display font-bold text-indigo-700 mb-3 text-base">📋 Your Order Summary</div>
    <div class="space-y-1.5 text-sm text-indigo-800">
      <div class="flex justify-between"><span>Room:</span><span class="font-semibold">${room.name}</span></div>
      <div class="flex justify-between"><span>Date:</span><span class="font-semibold">${state.selectedDate} @ ${state.selectedTime}</span></div>
      <div class="flex justify-between"><span>Guests:</span><span class="font-semibold">${state.guests} children</span></div>
      <div class="flex justify-between"><span>Food:</span><span class="font-semibold">${state.selectedFood || 'Not selected'}</span></div>
      <div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${pricePerChild}/child × ${state.guests} = $${baseTotal.toFixed(2)}</span></div>
      ${addonHtml}
      <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
        <span>Total:</span><span class="text-indigo-600">$${total.toFixed(2)} NZD</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
let timerInterval = null;
let timerSeconds  = 15 * 60;

function startTimer() {
  clearInterval(timerInterval);
  timerSeconds = 15 * 60;
  document.getElementById('timerContainer').style.display = 'block';
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      handleTimerExpiry();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m   = Math.floor(timerSeconds / 60);
  const s   = timerSeconds % 60;
  const txt = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const display = document.getElementById('timerDisplay');
  if (display) display.textContent = txt;
  const bar = document.getElementById('timerBar');
  if (bar) {
    if (timerSeconds <= 120) bar.classList.add('urgent');
    else bar.classList.remove('urgent');
  }
}

async function handleTimerExpiry() {
  const display = document.getElementById('timerDisplay');
  if (display) display.textContent = 'Expired';

  // Release hold if any
  if (state.slotHoldId) {
    await releaseSlotHold(state.slotHoldId);
  }

  alert('⏰ Your room hold has expired. Please start your booking again to secure a new slot.');
  resetWizard();
}

function stopTimer() {
  clearInterval(timerInterval);
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