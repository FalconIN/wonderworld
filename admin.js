/**
 * admin.js
 * Admin dashboard:
 *   - Auth guard (admin-only access)
 *   - Overview stats
 *   - Bookings table with cancel
 *   - Payments table with refund via Edge Function
 *   - Customers table
 */

// Paused per user request while the venue-upgrade feature gets dialed in
// first — mirrors the same-named flags in server/routes/admin.js (backend
// is guarded independently; these just keep the UI from offering an action
// that would 403 anyway). Flip both back to true + bump this file's
// cache-busting version + reload PM2 to go live.
const FEATURE_MAGIC_LINK_ENABLED = true;
const FEATURE_NOTES_EMAIL_TOGGLE_ENABLED = true;

let currentTab = 'overview';
let allBookings   = [];
let allPayments   = [];
let allCustomers  = [];

// Bookings sub-tab state — Upcoming is the default, Past defaults to latest-first sort
let bookingsSubTab = 'upcoming';
let upcomingBookings = [];
let pastBookings = [];
const bookingsTabState = {
  upcoming: { search: '', statusFilter: '', sortOrder: 'party_date_asc' },
  past:     { search: '', statusFilter: '', sortOrder: 'party_date_desc' },
};

const NZ_TZ = 'Pacific/Auckland';
function nzDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NZ_TZ }).format(d);
}
function nzGetDay(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: NZ_TZ, weekday: 'short' }).format(d);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(s);
}

// ---------------------------------------------------------------------------
// Food Prep date range state
// ---------------------------------------------------------------------------
let foodPrepRange = { from: null, to: null };

function getMondayOf(d) {
  const dow = nzGetDay(d); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(monday.getDate() + diff);
  return monday;
}

function initFoodPrepRangeIfNeeded() {
  if (foodPrepRange.from && foodPrepRange.to) return;
  const monday = getMondayOf(new Date());
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  foodPrepRange = { from: nzDateStr(monday), to: nzDateStr(sunday) };
  const fromEl = document.getElementById('foodPrepFrom');
  const toEl = document.getElementById('foodPrepTo');
  if (fromEl) fromEl.value = foodPrepRange.from;
  if (toEl) toEl.value = foodPrepRange.to;
}

function setFoodPrepQuickRange(kind) {
  const today = new Date();
  let from, to;
  if (kind === 'thisWeek') {
    from = getMondayOf(today);
    to = new Date(from);
    to.setDate(from.getDate() + 6);
  } else if (kind === 'nextWeek') {
    const thisMonday = getMondayOf(today);
    from = new Date(thisMonday);
    from.setDate(thisMonday.getDate() + 7);
    to = new Date(from);
    to.setDate(from.getDate() + 6);
  } else { // next7
    from = today;
    to = new Date(today);
    to.setDate(today.getDate() + 6);
  }
  foodPrepRange = { from: nzDateStr(from), to: nzDateStr(to) };
  document.getElementById('foodPrepFrom').value = foodPrepRange.from;
  document.getElementById('foodPrepTo').value = foodPrepRange.to;
  loadFoodPrep();
}

function applyFoodPrepRange() {
  const from = document.getElementById('foodPrepFrom').value;
  const to = document.getElementById('foodPrepTo').value;
  if (!from || !to) return;
  if (from > to) {
    alert('The "From" date must be before the "To" date.');
    return;
  }
  foodPrepRange = { from, to };
  loadFoodPrep();
}

function formatFoodPrepRangeLabel(fromISO, toISO) {
  const from = new Date(fromISO + 'T12:00:00');
  const to = new Date(toISO + 'T12:00:00');
  const fromLabel = from.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
  const toLabel = to.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  return `Food Prep: ${fromLabel} – ${toLabel}`;
}

// Splits an addons_summary string on top-level commas only — commas nested
// inside a variant breakdown like "Soft Drink (Coke, Sprite x2) ×3 ($30.00)"
// must NOT split the line in two.
function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0, current = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Only these addons ever get a "(Type, Type x2)" variant breakdown appended
// to their label (mirrors TYPE_PICKER_IDS) — other catalog labels can contain
// their own literal parentheses (e.g. "Kids Party Platter (48pcs)") that must
// NOT be mistaken for a variant breakdown.
const FOOD_PREP_VARIANT_BASE_NAMES = new Set(['11-inch Pizza', 'Soft Drink', 'Nuggets']);

// Tallies one booking's addons_summary into a running totals map, splitting
// typed variants (pizza/soda/nuggets) out into their own named entries so
// "11-inch Pizza (Salami & Cheese ×2)" counts as 2 of that specific variant,
// not 2 generic pizzas.
function tallyAddonsSummary(addonsSummary, totals) {
  if (!addonsSummary) return;
  splitTopLevelCommas(addonsSummary).forEach(chunk => {
    // The outer quantity always uses the unicode "×" sign right before the
    // trailing "($price)"; inner variant counts use a plain ASCII "x".
    const outerMatch = chunk.match(/×\s*(\d+)\s*\(\$/);
    if (!outerMatch) return;
    const outerQty = parseInt(outerMatch[1], 10);
    const label = chunk.slice(0, outerMatch.index).trim();

    const variantMatch = label.match(/^(.+?)\s*\(([^)]+)\)$/);
    const baseName = variantMatch ? variantMatch[1].trim() : null;

    if (variantMatch && FOOD_PREP_VARIANT_BASE_NAMES.has(baseName)) {
      variantMatch[2].split(',').map(s => s.trim()).filter(Boolean).forEach(vp => {
        const m = vp.match(/^(.+?)\s+x(\d+)$/i);
        const variantName = m ? m[1].trim() : vp;
        const variantQty = m ? parseInt(m[2], 10) : 1;
        const key = `${baseName} — ${variantName}`;
        totals[key] = (totals[key] || 0) + variantQty;
      });
    } else {
      totals[label] = (totals[label] || 0) + outerQty;
    }
  });
}

// Parses a food_choice string like "6 Nuggets + 4 Mini Burgers + 2 Vege Burgers"
// (also accepts "Vegie"/"Veggie" spelling and admin-created bookings which
// omit vege burgers entirely). Returns malformed:true for null/empty/
// unparseable strings so callers can flag them instead of silently treating
// them as zero.
function parseFoodChoiceFull(foodChoice) {
  if (!foodChoice || !String(foodChoice).trim()) {
    return { nuggets: 0, burgers: 0, veges: 0, total: 0, malformed: true };
  }
  let remaining = String(foodChoice);
  let veges = 0, burgers = 0, nuggets = 0;

  const vegeMatch = remaining.match(/(\d+)\s*Ve(?:gie|ggie|ge)\s*Burgers?/i);
  if (vegeMatch) {
    veges = parseInt(vegeMatch[1], 10);
    remaining = remaining.slice(0, vegeMatch.index) + remaining.slice(vegeMatch.index + vegeMatch[0].length);
  }
  const burMatch = remaining.match(/(\d+)\s*(?:Mini\s*)?Burgers?/i);
  if (burMatch) {
    burgers = parseInt(burMatch[1], 10);
    remaining = remaining.slice(0, burMatch.index) + remaining.slice(burMatch.index + burMatch[0].length);
  }
  const nugMatch = remaining.match(/(\d+)\s*Nuggets?/i);
  if (nugMatch) nuggets = parseInt(nugMatch[1], 10);

  const total = nuggets + burgers + veges;
  return { nuggets, burgers, veges, total, malformed: total === 0 };
}

// Builds a food_choice string in the same canonical format parseFoodChoiceFull
// expects back — "X Nuggets + Y Mini Burgers + Z Vege Burgers" — so admin-saved
// bookings round-trip through the parser the same way customer bookings do.
function buildFoodChoiceString(nuggets, burgers, veges) {
  const parts = [];
  if (nuggets > 0) parts.push(`${nuggets} Nuggets`);
  if (burgers > 0) parts.push(`${burgers} Mini Burgers`);
  if (veges   > 0) parts.push(`${veges} Vege Burgers`);
  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Init: check admin access via Firebase Auth
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = '/?adminredirect=1';
      return;
    }

    try {
      const profile = await callAPI('users/profile', null, 'GET');
      if (!profile?.isAdmin) {
        alert('Access denied. Admin accounts only.');
        window.location.href = '/';
        return;
      }
      document.getElementById('adminUserInfo').textContent =
        `${profile.firstName} ${profile.lastName}`;
    } catch {
      alert('Could not verify admin access.');
      window.location.href = '/';
      return;
    }

    initAdminTheme();
    await loadOverview();
  });
});

// ---------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------
function initAdminTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  updateThemeToggleUI(isDark);
}

function toggleAdminTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('admin_theme', isDark ? 'dark' : 'light');
  updateThemeToggleUI(isDark);
  if (currentTab === 'overview') {
    if (document.getElementById('revenueChartPanel')?.style.display !== 'none') renderRevenueChart();
    renderBookingsDotChart();
    renderRoomPopularityChart();
  }
}

function updateThemeToggleUI(isDark) {
  const label = document.getElementById('themeToggleLabel');
  const icon = document.getElementById('themeToggleIcon');
  if (label) label.textContent = isDark ? '🌞 Light mode' : '🌙 Dark mode';
  if (icon) icon.textContent = isDark ? '🌙' : '🌞';
}

// ---------------------------------------------------------------------------
// Mobile sidebar drawer
// ---------------------------------------------------------------------------
function openAdminSidebar() {
  document.getElementById('adminSidebar')?.classList.add('sidebar-open');
  document.getElementById('adminSidebarBackdrop')?.classList.remove('hidden');
}

function closeAdminSidebar() {
  document.getElementById('adminSidebar')?.classList.remove('sidebar-open');
  document.getElementById('adminSidebarBackdrop')?.classList.add('hidden');
}

function toggleAdminSidebar() {
  const sidebar = document.getElementById('adminSidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('sidebar-open')) closeAdminSidebar();
  else openAdminSidebar();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAdminSidebar();
});

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
function showTab(tab) {
  currentTab = tab;
  closeAdminSidebar();

  // Update nav buttons
  document.querySelectorAll('.admin-nav-btn').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.getElementById('nav-' + tab);
  if (navBtn) navBtn.classList.add('active');

  // Show/hide tab panels
  ['overview','bookings','payments','customers','today','reviews'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });

  // Page title
  const titles = { overview: 'Overview', bookings: 'Bookings', payments: 'Payments', customers: 'Customers', today: "Today's Schedule", reviews: 'Google Reviews' };
  document.getElementById('pageTitle').textContent = titles[tab] || tab;

  // Reset search box for the new tab with a relevant placeholder
  const searchEl = document.getElementById('searchInput');
  if (searchEl) {
    searchEl.value = '';
    const placeholders = {
      overview: 'Search...',
      bookings: 'Search ref, email, room...',
      payments: 'Search ref, email, cardholder...',
      customers: 'Search name, email, phone...',
      today: 'Search...',
      reviews: 'Search...',
    };
    searchEl.placeholder = placeholders[tab] || 'Search...';
  }

  // When switching to bookings, always start on the Upcoming sub-tab
  if (tab === 'bookings') {
    bookingsSubTab = 'upcoming';
    document.getElementById('bst-upcoming')?.classList.add('active');
    document.getElementById('bst-past')?.classList.remove('active');
    const sortEl = document.getElementById('bookingsSortOrder');
    if (sortEl) sortEl.value = bookingsTabState.upcoming.sortOrder;
    const statusEl = document.getElementById('bookingStatusFilter');
    if (statusEl) statusEl.value = bookingsTabState.upcoming.statusFilter;
    const bsEl = document.getElementById('bookingsSearchInput');
    if (bsEl) bsEl.value = bookingsTabState.upcoming.search;
  }

  // Load data
  if (tab === 'overview')   loadOverview();
  if (tab === 'bookings')   loadBookings();
  if (tab === 'payments')   loadPayments();
  if (tab === 'customers')  loadCustomers();
  if (tab === 'today')      loadToday();
  if (tab === 'reviews')    { loadReviews(); loadSiteRating(); }
}

function refreshCurrentTab() { showTab(currentTab); }

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function loadOverview() {
  try {
    const stats = await callAPI('admin/stats', null, 'GET');
    document.getElementById('stat-bookings').textContent  = stats.totalBookings ?? '—';
    document.getElementById('stat-revenue').textContent   = '$' + (stats.totalRevenue || 0).toFixed(2);
    document.getElementById('stat-customers').textContent = stats.totalCustomers ?? '—';
    document.getElementById('stat-upcoming').textContent  = stats.upcomingCount ?? '—';
    const cancelledNote = document.getElementById('stat-cancelled-note');
    if (cancelledNote) cancelledNote.textContent = stats.cancelledCount > 0 ? `(${stats.cancelledCount} cancelled)` : '';
  } catch (err) {
    console.error('Stats load failed:', err);
  }

  await loadOverviewBookingsList();
  await renderBookingsDotChart();
  await renderRoomPopularityChart();
  loadMonthRevenue();
  loadBalancesDueCount();
  initFoodPrepRangeIfNeeded();
  loadFoodPrep();
  loadWeekendCapacity();
}

async function loadOverviewBookingsList(fromDate, toDate) {
  const list = document.getElementById('upcoming-bookings-list');
  const titleEl = document.getElementById('upcomingListTitle');
  list.innerHTML = '<p class="text-gray-400 text-sm py-4">Loading...</p>';

  let endpoint = 'admin/bookings-list';
  if (fromDate && toDate) {
    endpoint += `?from=${fromDate}&to=${toDate}`;
    titleEl.textContent = `Bookings: ${fromDate} → ${toDate}`;
  } else {
    titleEl.textContent = 'Upcoming Bookings (Next 7 Days)';
  }

  let bookings = [];
  try {
    bookings = await callAPI(endpoint, null, 'GET');
  } catch (err) {
    list.innerHTML = `<p class="text-red-400 text-sm py-4">Failed to load bookings: ${err.message}</p>`;
    return;
  }

  if (!bookings.length) {
    list.innerHTML = '<p class="text-gray-400 text-sm py-4">No bookings found for this range.</p>';
    return;
  }

  list.innerHTML = bookings.map(b => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 ${b.status === 'cancelled' ? 'opacity-60' : ''}">
      <div class="flex items-center gap-3">
        <span class="text-2xl">${b.roomEmoji || '🎉'}</span>
        <div>
          <div class="font-semibold text-sm text-gray-900 ${b.status === 'cancelled' ? 'line-through' : ''}">${roomDisplayName(b.roomName)} · ${b.guestCount} kids</div>
          <div class="text-xs text-gray-400">${(b.partyDate||'').slice(0,10)} @ ${b.partyTime} · ${escapeHtml(b.contactEmail || '')}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge ${statusBadgeClass(b.status)}">${b.status}</span>
        <span class="text-xs text-gray-400 font-mono">${b.bookingRef}</span>
        <button onclick="viewBooking('${b.id}')" class="text-xs text-indigo-500 hover:underline font-semibold">View</button>
      </div>
    </div>`).join('');
}

function applyOverviewDateRange() {
  const from = document.getElementById('overviewRangeFrom').value;
  const to = document.getElementById('overviewRangeTo').value;
  if (!from || !to) {
    alert('Please select both a from and to date.');
    return;
  }
  if (from > to) {
    alert('The "from" date must be before the "to" date.');
    return;
  }
  loadOverviewBookingsList(from, to);
}

function clearOverviewDateRange() {
  document.getElementById('overviewRangeFrom').value = '';
  document.getElementById('overviewRangeTo').value = '';
  loadOverviewBookingsList();
}

// ---------------------------------------------------------------------------
// Import bookings from Excel/CSV
// ---------------------------------------------------------------------------
let importParsedRows = [];
let importRoomLookup = null;

// Flexible header matching — tries common variations since every old
// booking system exports columns differently. Edit these alias lists
// once we see the real export from the old system.
const IMPORT_FIELD_ALIASES = {
  firstName: ['first name', 'firstname', 'first'],
  lastName:  ['last name', 'lastname', 'last', 'surname'],
  email:     ['email', 'e-mail', 'email address', 'contact email'],
  phone:     ['phone', 'mobile', 'contact number', 'phone number'],
  room:      ['room', 'party room', 'package', 'room name'],
  guests:    ['guests', 'kids', 'kid amount', 'number of kids', 'pax', 'children'],
  date:      ['date', 'party date', 'booking date', 'event date'],
  time:      ['time', 'party time', 'start time'],
  price:     ['price', 'price paid', 'total', 'amount', 'total paid'],
  addons:    ['add-ons', 'addons', 'add ons', 'addon', 'extras'],
  food:      ['food', 'food chosen', 'food choice', 'menu'],
  notes:     ['notes', 'allergy', 'allergies', 'comments'],
};

function detectColumnMap(headerRow) {
  const map = {};
  const normalizedHeaders = headerRow.map(h => (h || '').toString().trim().toLowerCase());
  Object.entries(IMPORT_FIELD_ALIASES).forEach(([field, aliases]) => {
    const idx = normalizedHeaders.findIndex(h => aliases.includes(h));
    if (idx !== -1) map[field] = idx;
  });
  return map;
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

      if (!rows || rows.length < 2) {
        alert('That file looks empty or has no data rows.');
        return;
      }

      const headerRow = rows[0];
      const dataRows = rows.slice(1).filter(r => r.some(cell => (cell || '').toString().trim() !== ''));
      const colMap = detectColumnMap(headerRow);

      // Load room slug lookup once
      if (!importRoomLookup) {
        importRoomLookup = await callAPI('admin/rooms', null, 'GET');
      }

      importParsedRows = dataRows.map((r, i) => parseImportRow(r, colMap, i));
      renderImportPreview(headerRow, colMap);
      document.getElementById('importFileInput').value = '';
    } catch (err) {
      alert('Could not read that file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function matchRoom(roomText) {
  if (!roomText) return null;
  const t = roomText.toString().trim().toLowerCase();
  const colorMap = { 'big room': 'big', 'yellow room': 'sunshine', 'sunshine room': 'sunshine',
    'purple room': 'dream', 'dream room': 'dream', 'green room': 'forest', 'forest room': 'forest',
    'wonder forest room': 'forest', 'the big room': 'big' };
  const slug = colorMap[t] || t;
  return (importRoomLookup || []).find(r => r.slug === slug || r.name.toLowerCase() === t) || null;
}

function parseDateValue(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const str = val.toString().trim();
  // Try DD/MM/YYYY (common NZ format)
  const nzMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (nzMatch) {
    const [, d, m, y] = nzMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Try ISO YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.split('T')[0];
  const parsed = new Date(str);
  if (!isNaN(parsed)) return parsed.toISOString().split('T')[0];
  return null;
}

function normalizeTime(val) {
  if (!val) return null;
  const str = val.toString().trim().toUpperCase().replace(/\s+/g, ' ');
  const validSlots = ['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM'];
  const found = validSlots.find(s => str.includes(s.replace(' ', '')) || str === s);
  return found || (validSlots.includes(str) ? str : str);
}

function parseImportRow(row, colMap, index) {
  const get = (field) => colMap[field] !== undefined ? (row[colMap[field]] || '').toString().trim() : '';

  const firstName = get('firstName');
  const lastName = get('lastName');
  const email = get('email').toLowerCase();
  const phone = get('phone');
  const roomText = get('room');
  const guestsRaw = get('guests');
  const guests = parseInt(guestsRaw) || null;
  const dateRaw = get('date');
  const date = parseDateValue(dateRaw);
  const time = normalizeTime(get('time'));
  const priceRaw = get('price').replace(/[$,]/g, '');
  const price = parseFloat(priceRaw) || 0;
  const addonsSummary = get('addons');
  // Extract dollar amounts from the addons text (e.g. "Pizza ×1 ($25.00)") and sum them
  const addonsAmount = addonsSummary
    ? (addonsSummary.match(/\$([\d,.]+)/g) || [])
        .reduce((sum, m) => sum + (parseFloat(m.replace(/[$,]/g, '')) || 0), 0)
    : 0;
  const baseAmount = Math.max(0, price - addonsAmount);
  const food = get('food');
  const notes = get('notes');

  const matchedRoom = matchRoom(roomText);

  const errors = [];
  if (!firstName) errors.push('Missing first name');
  if (email && !/^[^@]+@[^@]+\.[^@]+$/.test(email)) errors.push('Invalid email address');
  if (!matchedRoom) errors.push(`Room "${roomText}" not recognized`);
  if (!date) errors.push(`Date "${dateRaw}" could not be parsed`);
  if (!guests || guests < 1) errors.push('Missing/invalid guest count');
  else if (matchedRoom && (guests < matchedRoom.minGuests || guests > matchedRoom.maxGuests)) {
    errors.push(`${guests} guests is outside ${matchedRoom.name}'s allowed range (${matchedRoom.minGuests}-${matchedRoom.maxGuests})`);
  }
  if (!time) errors.push('Missing time');

  return {
    index, firstName, lastName, email, phone, roomText, matchedRoom,
    guests, date, dateRaw, time, price, addonsSummary, addonsAmount, baseAmount,
    food, notes, errors, valid: errors.length === 0,
  };
}

function renderImportPreview(headerRow, colMap) {
  const validCount = importParsedRows.filter(r => r.valid).length;
  const invalidCount = importParsedRows.length - validCount;

  document.getElementById('importSummary').innerHTML = `
    Found <strong>${importParsedRows.length}</strong> row${importParsedRows.length === 1 ? '' : 's'}.
    <span class="text-green-600 font-semibold">${validCount} ready to import</span>
    ${invalidCount > 0 ? `, <span class="text-red-500 font-semibold">${invalidCount} have issues</span> (shown in red, won't be imported)` : ''}.
  `;

  const head = document.getElementById('importTableHead');
  head.innerHTML = `<th>Status</th><th>First</th><th>Last</th><th>Email</th><th>Room</th><th>Kids</th><th>Date</th><th>Time</th><th>Add-ons</th><th>Price</th>`;

  const body = document.getElementById('importTableBody');
  body.innerHTML = importParsedRows.map(r => `
    <tr class="${r.valid ? '' : 'bg-red-50'}">
      <td>${r.valid ? '✅' : '⚠️'}</td>
      <td>${r.firstName ? escapeHtml(r.firstName) : '<span class="text-red-400">—</span>'}</td>
      <td>${r.lastName ? escapeHtml(r.lastName) : ''}</td>
      <td>${r.email ? escapeHtml(r.email) : '<span class="text-red-400">—</span>'}</td>
      <td>${r.matchedRoom ? escapeHtml(r.matchedRoom.name) : `<span class="text-red-400">${escapeHtml(r.roomText || '—')}</span>`}</td>
      <td>${r.guests ?? '<span class="text-red-400">—</span>'}</td>
      <td>${r.date || `<span class="text-red-400">${escapeHtml(r.dateRaw || '—')}</span>`}</td>
      <td>${r.time && ['9:30 AM','11:30 AM','1:30 PM','3:30 PM'].includes(r.time) ? r.time : `<span class="text-red-400">${escapeHtml(r.time || '—')}</span>`}</td>
      <td class="text-xs">${r.addonsSummary ? escapeHtml(r.addonsSummary) : '<span class="text-gray-300">—</span>'}</td>
      <td>$${r.price.toFixed(2)}</td>
    </tr>`).join('');

  const errEl = document.getElementById('importErrors');
  const detectedFields = Object.keys(colMap);
  const requiredFields = ['firstName', 'room', 'guests', 'date', 'time'];
  const missingRequired = requiredFields.filter(f => !detectedFields.includes(f));
  if (missingRequired.length > 0) {
    errEl.style.display = 'block';
    errEl.innerHTML = `<strong>Heads up:</strong> couldn't find a column for: ${missingRequired.join(', ')}. Detected columns in your file: ${headerRow.join(', ')}. These are needed to import — double-check the spreadsheet's column headers, or adjust them and re-upload.`;
  } else {
    errEl.style.display = 'none';
  }

  document.getElementById('importModal').style.display = 'flex';
}

function closeImportModal() {
  document.getElementById('importModal').style.display = 'none';
  importParsedRows = [];
}

async function confirmImport() {
  const btn = document.getElementById('confirmImportBtn');
  const validRows = importParsedRows.filter(r => r.valid);

  if (validRows.length === 0) {
    alert('No valid rows to import.');
    return;
  }

  if (!confirm(`Import ${validRows.length} booking${validRows.length === 1 ? '' : 's'}? This will create real confirmed bookings and lock those time slots.`)) return;

  btn.disabled = true;
  btn.textContent = 'Importing...';

  const rowsToSend = validRows.map(r => ({
    ...r,
    matchedRoomId: r.matchedRoom?.id,
  }));

  let result = { success: 0, failed: 0, messages: [] };
  try {
    result = await callAPI('admin/bookings/import', { rows: rowsToSend });
  } catch (err) {
    alert('Import failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Import Valid Rows';
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Import Valid Rows';

  let msg = `✅ Imported ${result.success} booking${result.success === 1 ? '' : 's'}.`;
  if (result.failed > 0) msg += `\n\n⚠️ ${result.failed} failed:\n${result.messages.join('\n')}`;
  alert(msg);

  closeImportModal();
  refreshCurrentTab();
}

async function exportBookingsToExcel() {
  const from = document.getElementById('overviewRangeFrom').value;
  const to = document.getElementById('overviewRangeTo').value;
  const useRange = from && to;

  let endpoint = 'admin/bookings/export';
  if (useRange) endpoint += `?from=${from}&to=${to}`;

  let rows = [];
  try {
    rows = await callAPI(endpoint, null, 'GET');
  } catch (err) {
    alert('Failed to export: ' + err.message);
    return;
  }

  if (!rows.length) {
    alert('No bookings found to export' + (useRange ? ' for this date range.' : '.'));
    return;
  }

  const ROOM_COLOR_LABELS = {
    'The Big Room': 'Big Room',
    'Sunshine Room': 'Yellow Room',
    'Dream Room': 'Purple Room',
    'Wonder Forest Room': 'Green Room',
  };

  const exportRows = rows.map(b => {
    const bookedOn = b.createdAt ? new Date(b.createdAt).toLocaleDateString('en-NZ', { timeZone: NZ_TZ }) : '';
    const roomName = b.roomName || '';
    return {
      'Date Booked':  bookedOn,
      'First Name':   b.firstName || '',
      'Last Name':    b.lastName  || '',
      'Email':        b.contactEmail || '',
      'Ref Number':   b.bookingRef || '',
      'Party Room':   ROOM_COLOR_LABELS[roomName] || roomName,
      'Kid Amount':   b.guestCount ?? '',
      'Food Chosen':  b.foodChoice || '',
      'Add-ons':      b.addonsSummary || '',
      'Price Paid':   parseFloat(b.totalAmount || 0),
      'Party Date':   b.partyDate || '',
      'Party Time':   b.partyTime || '',
      'Status':       b.status || '',
      'Admin Notes':  b.adminNotes || '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportRows);
  ws['!cols'] = [
    { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 14 },
    { wch: 10 }, { wch: 16 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 },
  ];

  // Format Price Paid column as currency ($X.XX)
  const priceColIndex = 9; // 0-indexed position of "Price Paid"
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let row = range.s.r + 1; row <= range.e.r; row++) {
    const cellRef = XLSX.utils.encode_cell({ r: row, c: priceColIndex });
    if (ws[cellRef]) ws[cellRef].z = '"$"#,##0.00';
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bookings');

  const filename = useRange
    ? `bookings_${from}_to_${to}.xlsx`
    : `bookings_all_${nzDateStr()}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
let revenueChartInstance = null;
let bookingsDotChartInstance = null;
let roomPopularityChartInstance = null;

function chartTextColor() {
  return document.documentElement.classList.contains('dark') ? '#9CA3AF' : '#6B7280';
}
function chartGridColor() {
  return document.documentElement.classList.contains('dark') ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
}

function toggleRevenueChart() {
  const panel = document.getElementById('revenueChartPanel');
  const chevron = document.getElementById('revenueChevron');
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  chevron.textContent = isHidden ? '▲' : '▼';
  if (isHidden) renderRevenueChart();
}

async function renderRevenueChart() {
  const rangeVal = document.getElementById('revenueChartRange')?.value || '30';
  const canvas = document.getElementById('revenueChartCanvas');
  if (!canvas) return;

  let rows = [];
  try {
    rows = await callAPI(`admin/revenue?range=${rangeVal}`, null, 'GET');
  } catch (err) { console.error(err); return; }

  const byDate = {};
  (rows || []).forEach(r => {
    const day = (r.date || '').toString().split('T')[0].split(' ')[0];
    if (!day) return;
    byDate[day] = (byDate[day] || 0) + parseFloat(r.amount || 0);
  });

  const dataPoints = Object.keys(byDate).sort().map(d => ({ x: d + 'T12:00:00', y: byDate[d] }));

  if (revenueChartInstance) { revenueChartInstance.destroy(); revenueChartInstance = null; }
  if (!dataPoints.length) {
    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = chartTextColor();
    ctx2d.font = '14px Inter, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText('No revenue data for this period', canvas.width / 2, canvas.height / 2);
    return;
  }

  revenueChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Revenue (NZD)',
        data: dataPoints,
        borderColor: '#4F46E5',
        backgroundColor: 'rgba(79,70,229,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: dataPoints.length === 1 ? 6 : 4,
        pointHoverRadius: 7,
        pointBackgroundColor: '#4F46E5',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `$${(ctx.parsed.y || 0).toFixed(2)} NZD` } },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', tooltipFormat: 'MMM d' },
          ticks: { color: chartTextColor() },
          grid: { color: chartGridColor() },
        },
        y: {
          beginAtZero: true,
          ticks: { color: chartTextColor(), callback: (v) => '$' + v },
          grid: { color: chartGridColor() },
        },
      },
    },
  });
}

async function renderBookingsDotChart() {
  const canvas = document.getElementById('bookingsDotChartCanvas');
  if (!canvas) return;

  let rows = [];
  try {
    rows = await callAPI('admin/bookings-by-month', null, 'GET');
  } catch (err) { console.error(err); return; }

  const points = (rows || []).map(r => ({
    x: (r.date || '').toString().split('T')[0] + 'T12:00:00',
    y: parseInt(r.count) || 0,
  })).sort((a, b) => a.x.localeCompare(b.x));

  if (bookingsDotChartInstance) { bookingsDotChartInstance.destroy(); bookingsDotChartInstance = null; }
  if (!points.length) {
    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = chartTextColor();
    ctx2d.font = '14px Inter, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText('No bookings this month', canvas.width / 2, canvas.height / 2);
    return;
  }

  bookingsDotChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Rooms booked',
        data: points,
        borderColor: '#0E9F6E',
        backgroundColor: 'rgba(14,159,110,0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: points.length === 1 ? 6 : 4,
        pointHoverRadius: 7,
        pointBackgroundColor: '#0E9F6E',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].raw.x).toLocaleDateString('en-NZ', { timeZone: NZ_TZ, weekday: 'short', month: 'short', day: 'numeric' }),
            label: (ctx) => { const n = ctx.raw.y || 0; return `${n} room${n === 1 ? '' : 's'} booked`; },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', tooltipFormat: 'MMM d' },
          ticks: { color: chartTextColor() },
          grid: { color: chartGridColor() },
        },
        y: {
          beginAtZero: true,
          ticks: { color: chartTextColor(), stepSize: 1 },
          grid: { color: chartGridColor() },
        },
      },
    },
  });
}

async function renderRoomPopularityChart() {
  const canvas = document.getElementById('roomPopularityChartCanvas');
  if (!canvas) return;

  let rows = [];
  try {
    rows = await callAPI('admin/room-popularity', null, 'GET');
  } catch (err) { console.error(err); return; }

  const labels = (rows || []).map(r => r.name);
  const values = (rows || []).map(r => parseInt(r.count));
  const colors = ['#4F46E5', '#F59E0B', '#A855F7', '#0E9F6E', '#EF4444'];

  if (roomPopularityChartInstance) { roomPopularityChartInstance.destroy(); roomPopularityChartInstance = null; }

  if (labels.length === 0) {
    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = chartTextColor();
    ctx2d.font = '14px Inter, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText('No bookings this month', canvas.width / 2, canvas.height / 2);
    return;
  }

  roomPopularityChartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, i) => colors[i % colors.length]),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: chartTextColor(), padding: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed} booking${ctx.parsed === 1 ? '' : 's'}` } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// New overview sections: month revenue, balances count, food prep, weekend capacity
// ---------------------------------------------------------------------------
async function loadMonthRevenue() {
  try {
    const data = await callAPI('admin/month-revenue', null, 'GET');
    document.getElementById('stat-month-revenue').textContent = '$' + parseFloat(data.thisMonth || 0).toFixed(2);
    const last = parseFloat(data.lastMonth || 0);
    const current = parseFloat(data.thisMonth || 0);
    const vsEl = document.getElementById('stat-month-vs');
    if (vsEl) {
      if (last > 0) {
        const pct = ((current - last) / last * 100).toFixed(0);
        vsEl.textContent = (pct >= 0 ? '▲' : '▼') + Math.abs(pct) + '% vs last month';
        vsEl.className = 'text-xs font-semibold ml-1 ' + (pct >= 0 ? 'text-green-500' : 'text-red-400');
      } else {
        vsEl.textContent = '';
      }
    }
    // Pending count note on upcoming stat card
    if (data.pendingCount > 0) {
      const el = document.getElementById('stat-cancelled-note');
      if (el) el.textContent = (el.textContent ? el.textContent + ' · ' : '') + data.pendingCount + ' pending';
    }
  } catch (err) { console.error('month revenue load failed', err); }
}

async function loadBalancesDueCount() {
  try {
    const rows = await callAPI('admin/balances-due', null, 'GET');
    document.getElementById('stat-balances-due').textContent = rows.length;
  } catch (err) { console.error('balances count failed', err); }
}

async function loadFoodPrep() {
  const el = document.getElementById('overview-food-prep');
  if (!el) return;
  const { from, to } = foodPrepRange;
  if (!from || !to) return;

  const labelEl = document.getElementById('foodPrepRangeLabel');
  if (labelEl) labelEl.textContent = formatFoodPrepRangeLabel(from, to);

  el.innerHTML = 'Loading...';
  try {
    const rows = await callAPI(`admin/food-prep?from=${from}&to=${to}`, null, 'GET');
    if (!rows.length) { el.innerHTML = '<p class="text-gray-400 text-sm">No parties in this date range.</p>'; return; }

    let guestConfirmed = 0, guestPending = 0;
    let confirmedParties = 0, pendingParties = 0;
    let nugC = 0, nugP = 0, burC = 0, burP = 0, vegC = 0, vegP = 0;
    let kidsFedTotal = 0;
    // Per-child rooms only — whole-venue hire has no food_choice at all (it
    // has catering_choice instead, tallied separately below), so it must be
    // excluded from both the numerator and denominator of the "does food
    // add up to guests" sanity check, or every whole-venue booking would
    // wrongly trip it.
    let perChildGuestTotal = 0;
    const addonC = {}, addonP = {};
    const missingRefs = [];
    let venueMenuCount = 0, selfCateringCount = 0;

    rows.forEach(b => {
      const isConfirmed = b.status === 'confirmed';
      if (isConfirmed) confirmedParties++; else pendingParties++;

      const guests = parseInt(b.guestCount) || 0;
      if (isConfirmed) guestConfirmed += guests; else guestPending += guests;

      if (b.pricingModel === 'flat') {
        if (b.cateringChoice === 'venue_menu') venueMenuCount++;
        else if (b.cateringChoice === 'self_catering') selfCateringCount++;
      } else {
        perChildGuestTotal += guests;
        const parsed = parseFoodChoiceFull(b.foodChoice);
        if (parsed.malformed) {
          missingRefs.push(b.bookingRef || '—');
        } else {
          kidsFedTotal += parsed.total;
          if (isConfirmed) { nugC += parsed.nuggets; burC += parsed.burgers; vegC += parsed.veges; }
          else { nugP += parsed.nuggets; burP += parsed.burgers; vegP += parsed.veges; }
        }
      }

      tallyAddonsSummary(b.addonsSummary, isConfirmed ? addonC : addonP);
    });

    const guestTotal = guestConfirmed + guestPending;
    const partyTotal = confirmedParties + pendingParties;
    const nugTotal = nugC + nugP, burTotal = burC + burP, vegTotal = vegC + vegP;

    const breakdown = (c, p) => `<span class="text-xs text-gray-400 font-normal">(${c} confirmed, ${p} pending)</span>`;
    const row = (icon, label, total, c, p, cls) => `
      <div class="flex items-center justify-between ${cls} rounded-xl px-4 py-2.5 gap-3">
        <span class="text-sm font-semibold">${icon} ${escapeHtml(label)}</span>
        <span class="font-bold text-right whitespace-nowrap">${total} ${breakdown(c, p)}</span>
      </div>`;

    let html = '<div class="space-y-2">';
    html += `<div class="text-xs font-semibold text-gray-500 mb-1">🎉 ${partyTotal} part${partyTotal === 1 ? 'y' : 'ies'} ${breakdown(confirmedParties, pendingParties)}</div>`;
    html += row('👧', 'Total Kids', guestTotal, guestConfirmed, guestPending, 'bg-indigo-50 dark:bg-indigo-900/20');
    if (nugTotal > 0) html += row('🍗', 'Chicken Nuggets', nugTotal, nugC, nugP, 'bg-yellow-50 dark:bg-yellow-900/20');
    if (burTotal > 0) html += row('🍔', 'Mini Burgers', burTotal, burC, burP, 'bg-orange-50 dark:bg-orange-900/20');
    if (vegTotal > 0) html += row('🥦', 'Vege Burgers', vegTotal, vegC, vegP, 'bg-green-50 dark:bg-green-900/20');

    const addonNames = Array.from(new Set([...Object.keys(addonC), ...Object.keys(addonP)])).sort();
    addonNames.forEach(name => {
      const c = addonC[name] || 0, p = addonP[name] || 0;
      html += row('➕', name, c + p, c, p, 'bg-indigo-50 dark:bg-indigo-900/20');
    });

    if (!nugTotal && !burTotal && !vegTotal && !addonNames.length) {
      html += '<p class="text-gray-400 text-sm">No food choices recorded for this range.</p>';
    }

    if (venueMenuCount > 0 || selfCateringCount > 0) {
      html += `<div class="bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-2.5 text-xs text-slate-700 dark:text-slate-300 font-semibold">Whole Venue Hire: ${venueMenuCount} venue menu, ${selfCateringCount} self-catering — coordinate catering for these separately, they're not included in the per-child totals above</div>`;
    }

    if (missingRefs.length) {
      html += `<div class="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2.5 text-xs text-red-700 dark:text-red-300 font-semibold">⚠️ ${missingRefs.length} booking${missingRefs.length === 1 ? '' : 's'} ${missingRefs.length === 1 ? 'has' : 'have'} missing food data — Ref: ${missingRefs.map(escapeHtml).join(', ')}</div>`;
    }

    if (kidsFedTotal !== perChildGuestTotal) {
      html += `<div class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300 font-semibold">⚠️ Food totals don't match guest count — check bookings for missing food data</div>`;
    }

    html += `<div class="text-xs text-gray-400 mt-3 pt-2 border-t border-gray-100 dark:border-gray-800">Grand total across ${partyTotal} part${partyTotal === 1 ? 'y' : 'ies'} in the selected range</div>`;
    html += '</div>';
    el.innerHTML = html;
  } catch (err) { el.innerHTML = `<p class="text-red-400 text-sm">Failed to load: ${escapeHtml(err.message)}</p>`; }
}

async function loadWeekendCapacity() {
  const el = document.getElementById('overview-weekend-capacity');
  if (!el) return;
  try {
    const rows = await callAPI('admin/weekend-capacity', null, 'GET');
    const byDate = {};
    rows.forEach(r => { byDate[r.date.slice(0, 10)] = { confirmed: parseInt(r.confirmed) || 0, pending: parseInt(r.pending) || 0 }; });

    // Build next 6 weekends
    const TOTAL_SLOTS = 16; // 4 rooms × 4 time slots
    const days = [];
    const today = new Date();
    for (let i = 0; i < 42; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dow = nzGetDay(d);
      if (dow === 0 || dow === 6) {
        const iso = nzDateStr(d);
        const counts = byDate[iso] || { confirmed: 0, pending: 0 };
        days.push({
          iso,
          label: d.toLocaleDateString('en-NZ', { timeZone: NZ_TZ, weekday: 'short', day: 'numeric', month: 'short' }),
          confirmed: counts.confirmed,
          pending: counts.pending,
          booked: counts.confirmed + counts.pending,
        });
      }
    }

    if (!days.length) { el.innerHTML = '<p class="text-gray-400 text-sm">No upcoming weekends found.</p>'; return; }

    let html = '<div class="space-y-2.5">';
    days.forEach(d => {
      const pct = Math.round((d.booked / TOTAL_SLOTS) * 100);
      const barColor = pct >= 100 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : pct >= 50 ? 'bg-indigo-500' : 'bg-teal';
      html += `
        <div>
          <div class="flex items-center justify-between text-xs mb-1">
            <span class="font-semibold text-gray-700 dark:text-gray-300">${d.label}</span>
            <span class="text-gray-500">${d.booked}/${TOTAL_SLOTS} slots${pct >= 100 ? ' 🔴 Full' : ''} <span class="text-gray-400">(${d.confirmed} confirmed, ${d.pending} pending)</span></span>
          </div>
          <div class="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
            <div class="h-full ${barColor} rounded-full transition-all" style="width:${Math.min(pct,100)}%"></div>
          </div>
        </div>`;
    });
    html += '</div>';
    el.innerHTML = html;
  } catch (err) { el.innerHTML = '<p class="text-red-400 text-sm">Failed to load.</p>'; }
}

// ---------------------------------------------------------------------------
// Today tab
// ---------------------------------------------------------------------------
function printRunSheet() {
  window.print();
}

async function loadToday() {
  const dateLabel = document.getElementById('today-date-label');
  if (dateLabel) dateLabel.textContent = new Date().toLocaleDateString('en-NZ', { timeZone: NZ_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  await Promise.all([renderTodayRunSheet(), renderAllergyAlerts(), renderBalancesDue()]);
}

async function loadReviews() {
  const list = document.getElementById('reviews-list');
  list.innerHTML = '<p class="text-gray-400 text-sm py-4">Loading...</p>';
  try {
    const reviews = await callAPI('admin/reviews', null, 'GET');
    if (!reviews.length) {
      list.innerHTML = '<p class="text-gray-400 text-sm py-4">No reviews fetched yet. Click "Fetch now" to pull the latest 5-star Google reviews.</p>';
      return;
    }
    list.innerHTML = reviews.map(r => `
      <div class="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-0 ${r.visible ? '' : 'opacity-50'}">
        <div class="flex-1">
          <div class="text-amber-500 text-sm mb-1">${'★'.repeat(r.rating)}${r.isManual ? ' <span class="text-gray-400 text-xs font-normal">· pasted manually</span>' : ''}</div>
          <p class="text-sm text-gray-700 dark:text-gray-300">"${escapeHtml(r.text)}"</p>
          <div class="text-xs text-gray-400 mt-1">${escapeHtml(r.authorName)} · ${new Date(r.time * 1000).toLocaleDateString('en-NZ')}</div>
        </div>
        <button onclick="toggleReviewVisible('${r.id}', ${!r.visible})" class="text-xs font-semibold whitespace-nowrap ${r.visible ? 'text-indigo-500 hover:underline' : 'text-gray-400 hover:underline'}">
          ${r.visible ? '👁️ Visible' : '🚫 Hidden'}
        </button>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p class="text-red-400 text-sm py-4">Failed to load reviews: ${err.message}</p>`;
  }
}

async function toggleReviewVisible(reviewId, newVisible) {
  try {
    await callAPI('admin/reviews/' + reviewId, { visible: newVisible }, 'PATCH');
    loadReviews();
  } catch (err) {
    alert('Failed to update review: ' + err.message);
  }
}

async function fetchReviewsNow() {
  const btn = document.getElementById('fetch-reviews-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
  try {
    const result = await callAPI('admin/reviews/fetch-now', {}, 'POST');
    if (result.ok === false && result.reason === 'not_configured') {
      alert('Google Places API key / Place ID not configured — add GOOGLE_PLACES_API_KEY and GOOGLE_PLACE_ID to .env first.');
    } else {
      alert(`✅ Fetched ${result.fetched} five-star reviews (${result.stored} stored/updated).`);
    }
    loadReviews();
  } catch (err) {
    alert('Fetch failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Fetch now'; }
  }
}

// ---------------------------------------------------------------------------
// Overall rating (admin-set, replaces the old live Google Places pull)
// ---------------------------------------------------------------------------
let currentSiteRating = null;

async function loadSiteRating() {
  const display = document.getElementById('site-rating-display');
  try {
    currentSiteRating = await callAPI('admin/site-rating', null, 'GET');
    renderSiteRatingDisplay();
  } catch (err) {
    display.innerHTML = `<p class="text-red-400 text-sm">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSiteRatingDisplay() {
  const display = document.getElementById('site-rating-display');
  if (!currentSiteRating) {
    display.innerHTML = `
      <p class="text-gray-400 text-sm">Not set yet — the public site is showing a hardcoded placeholder rating.</p>
      <button onclick="editSiteRating()" class="btn-primary py-2 px-4 text-sm">Set Rating</button>`;
    return;
  }
  display.innerHTML = `
    <div class="text-3xl font-display font-bold text-gray-900 dark:text-white">${parseFloat(currentSiteRating.rating).toFixed(1)} <span class="text-amber-500 text-xl">★</span></div>
    <div class="text-sm text-gray-400">${currentSiteRating.reviewCount || 0} reviews</div>
    <button onclick="editSiteRating()" class="btn-secondary py-2 px-4 text-sm">✏️ Edit</button>`;
}

function editSiteRating() {
  document.getElementById('site-rating-display').style.display = 'none';
  document.getElementById('site-rating-form').style.display = 'flex';
  document.getElementById('sr_rating').value = currentSiteRating ? currentSiteRating.rating : '';
  document.getElementById('sr_reviewCount').value = currentSiteRating ? currentSiteRating.reviewCount : '';
}

function cancelEditSiteRating() {
  document.getElementById('site-rating-display').style.display = 'flex';
  document.getElementById('site-rating-form').style.display = 'none';
}

async function saveSiteRating() {
  const rating = parseFloat(document.getElementById('sr_rating').value);
  const reviewCount = parseInt(document.getElementById('sr_reviewCount').value) || 0;
  if (!rating || rating < 0 || rating > 5) { alert('Enter a rating between 0 and 5.'); return; }
  try {
    await callAPI('admin/site-rating', { rating, reviewCount }, 'PUT');
    document.getElementById('site-rating-display').style.display = 'flex';
    document.getElementById('site-rating-form').style.display = 'none';
    await loadSiteRating();
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Paste Reviews — parse review text copied from Google Maps and bulk-import
// ---------------------------------------------------------------------------
let parsedReviews = [];

function openPasteReviewsModal() {
  document.getElementById('pasteReviewsInput').value = '';
  document.getElementById('pasteReviewsStep1').style.display = 'block';
  document.getElementById('pasteReviewsStep2').style.display = 'none';
  document.getElementById('pasteReviewsModal').style.display = 'flex';
}

function closePasteReviewsModal() {
  document.getElementById('pasteReviewsModal').style.display = 'none';
  parsedReviews = [];
}

function backToPasteInput() {
  document.getElementById('pasteReviewsStep1').style.display = 'block';
  document.getElementById('pasteReviewsStep2').style.display = 'none';
}

// Estimates a unix-seconds timestamp from Google's relative time text
// ("a month ago", "3 weeks ago", etc.) — approximate, editable in the preview.
function estimateTimeFromAgo(str) {
  const nowSec = Math.floor(Date.now() / 1000);
  const m = (str || '').toLowerCase().match(/(a|\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago/);
  if (!m) return nowSec;
  const n = m[1] === 'a' ? 1 : parseInt(m[1]);
  const unit = m[2];
  let secs;
  if (unit.startsWith('day'))   secs = n * 86400;
  else if (unit.startsWith('week'))  secs = n * 7 * 86400;
  else if (unit.startsWith('month')) secs = n * 30 * 86400;
  else /* year */                    secs = n * 365 * 86400;
  return nowSec - secs;
}

// Parses a raw block of text copied from Google Maps' reviews panel. The
// panel's star-rating icons never survive copy/paste as text, so rating is
// not recoverable here — every parsed review defaults to 5★ and is editable
// in the preview. Review blocks are found by locating each standalone
// "<N> <unit> ago" line (the one reliable anchor Google always renders as
// its own line) and walking outward from there: backward for the review-count
// line ("Local Guide · N reviews · M photos") and author name, forward for
// the body text up to the next "Like\n...\nShare" marker (which also strips
// any trailing "+N" photo-count line and, between blocks, any "Response from
// the owner" reply text — that reply's own inline "... ago" mention is never
// mistaken for the anchor because it's not on a standalone line).
function parseReviewsBlob(blob) {
  const TIME_AGO_RE = /^(?:(?:new|edited)\s+)?(?:a|\d+)\s+(?:day|days|week|weeks|month|months|year|years)\s+ago$/i;
  const COUNT_LINE_RE = /^(?:local guide\s*·\s*)?\d+\s+reviews?\b/i;
  const PLUS_PHOTOS_RE = /^\+\d+$/;

  const segments = blob.replace(/\r\n/g, '\n').split(/\n\s*Like\s*\n\s*Share\s*\n?/i);
  const results = [];

  segments.forEach(seg => {
    const rawLines = seg.split('\n').map(l => l.trim());
    const nonEmpty = [];
    rawLines.forEach((l, i) => { if (l) nonEmpty.push(i); });

    let anchorPos = -1;
    for (let i = nonEmpty.length - 1; i >= 0; i--) {
      if (TIME_AGO_RE.test(rawLines[nonEmpty[i]])) { anchorPos = i; break; }
    }
    if (anchorPos === -1) return; // no recognizable review block in this chunk

    let bodyStart = anchorPos + 1;
    if (bodyStart < nonEmpty.length && /^new$/i.test(rawLines[nonEmpty[bodyStart]])) bodyStart++;

    let bodyEnd = nonEmpty.length;
    if (bodyEnd > bodyStart && PLUS_PHOTOS_RE.test(rawLines[nonEmpty[bodyEnd - 1]])) bodyEnd--;

    const text = nonEmpty.slice(bodyStart, bodyEnd).map(i => rawLines[i]).join('\n').trim();

    let p = anchorPos - 1;
    let authorName = '';
    if (p >= 0 && COUNT_LINE_RE.test(rawLines[nonEmpty[p]])) p--;
    if (p >= 0) authorName = rawLines[nonEmpty[p]];

    const timeAgoRaw = rawLines[nonEmpty[anchorPos]];

    results.push({
      authorName,
      rating: 5,
      text,
      timeAgoRaw,
      time: estimateTimeFromAgo(timeAgoRaw),
    });
  });

  return results;
}

function parsePastedReviews() {
  const blob = document.getElementById('pasteReviewsInput').value;
  if (!blob.trim()) { alert('Paste some review text first.'); return; }

  parsedReviews = parseReviewsBlob(blob);
  if (!parsedReviews.length) {
    alert('Could not find any reviews in that text. Make sure each review still has its "X ago" line (e.g. "a month ago") intact.');
    return;
  }

  document.getElementById('pasteReviewsStep1').style.display = 'none';
  document.getElementById('pasteReviewsStep2').style.display = 'block';
  renderReviewsPreview();
}

function reviewIsValid(r) {
  return !!(r.authorName && r.authorName.trim() && r.text && r.text.trim());
}

function renderReviewsPreview() {
  const validCount = parsedReviews.filter(reviewIsValid).length;
  document.getElementById('pasteReviewsSummary').innerHTML =
    `Found <strong>${parsedReviews.length}</strong> review${parsedReviews.length === 1 ? '' : 's'}. ` +
    `<span class="text-green-600 font-semibold">${validCount} ready to import</span>` +
    (validCount < parsedReviews.length ? `, <span class="text-red-500 font-semibold">${parsedReviews.length - validCount} missing an author name or text</span> (usually means the paste started or ended mid-review — fix the name below or re-paste including it).` : '.') +
    ` Google doesn't include star ratings in copied text — check each rating below.`;

  document.getElementById('pasteReviewsPreview').innerHTML = parsedReviews.map((r, i) => `
    <div class="border ${reviewIsValid(r) ? 'border-gray-200 dark:border-gray-700' : 'border-red-300 bg-red-50 dark:bg-red-950/20'} rounded-xl p-4">
      <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 mb-2">
        <div>
          <label class="lbl">Author</label>
          <input class="field py-2 text-sm" value="${escapeHtml(r.authorName)}" placeholder="Missing — enter a name" oninput="updateParsedReview(${i}, 'authorName', this.value)" />
        </div>
        <div>
          <label class="lbl">Rating</label>
          <select class="field py-2 text-sm w-24" onchange="updateParsedReview(${i}, 'rating', parseInt(this.value))">
            ${[5,4,3,2,1].map(n => `<option value="${n}" ${r.rating === n ? 'selected' : ''}>${n}★</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="lbl">Date <span class="text-gray-400 font-normal">(${escapeHtml(r.timeAgoRaw || 'unknown')})</span></label>
          <input class="field py-2 text-sm" type="date" value="${new Date(r.time * 1000).toISOString().slice(0,10)}" onchange="updateParsedReview(${i}, 'time', Math.floor(new Date(this.value + 'T12:00:00').getTime() / 1000))" />
        </div>
      </div>
      <label class="lbl">Review text</label>
      <textarea class="field text-sm" style="min-height:70px" oninput="updateParsedReview(${i}, 'text', this.value)">${escapeHtml(r.text)}</textarea>
      ${!reviewIsValid(r) ? '<p class="text-xs text-red-500 mt-1">Won\'t be imported until it has both an author name and review text.</p>' : ''}
    </div>`).join('');
}

function updateParsedReview(index, field, value) {
  parsedReviews[index][field] = value;
  // Only re-render the summary counts/validity, not the inputs themselves —
  // a full re-render would blow away whatever the admin is mid-typing.
  const validCount = parsedReviews.filter(reviewIsValid).length;
  document.getElementById('pasteReviewsSummary').innerHTML =
    `Found <strong>${parsedReviews.length}</strong> review${parsedReviews.length === 1 ? '' : 's'}. ` +
    `<span class="text-green-600 font-semibold">${validCount} ready to import</span>` +
    (validCount < parsedReviews.length ? `, <span class="text-red-500 font-semibold">${parsedReviews.length - validCount} missing an author name or text</span>.` : '.');
}

async function confirmReviewsImport() {
  const validReviews = parsedReviews.filter(reviewIsValid);
  if (!validReviews.length) { alert('No valid reviews to import.'); return; }

  const btn = document.getElementById('confirmReviewsImportBtn');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    const { inserted, skipped } = await callAPI('admin/reviews/manual', {
      reviews: validReviews.map(r => ({ authorName: r.authorName.trim(), rating: r.rating, text: r.text.trim(), time: r.time })),
    }, 'POST');
    alert(`✅ Imported ${inserted} review${inserted === 1 ? '' : 's'}.${skipped ? `\n⚠️ Skipped ${skipped} (duplicate or invalid).` : ''}`);
    closePasteReviewsModal();
    loadReviews();
  } catch (err) {
    alert('Import failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Reviews';
  }
}

async function renderTodayRunSheet() {
  const el = document.getElementById('today-runsheet');
  if (!el) return;
  el.innerHTML = '<p class="text-gray-400 text-sm py-4">Loading...</p>';
  try {
    const rows = await callAPI('admin/today', null, 'GET');
    if (!rows.length) {
      el.innerHTML = '<div class="text-center py-12"><div class="text-4xl mb-3">🎉</div><p class="text-gray-400">No parties scheduled for today.</p></div>';
      return;
    }
    const SLOT_ORDER = {'9:30 AM': 1, '11:30 AM': 2, '1:30 PM': 3, '3:30 PM': 4, '5:30 PM': 5, '5:30 PM – 8:30 PM': 5};
    rows.sort((a, b) => (SLOT_ORDER[a.partyTime] || 9) - (SLOT_ORDER[b.partyTime] || 9));

    el.innerHTML = rows.map(b => {
      const name = escapeHtml([b.firstName, b.lastName].filter(Boolean).join(' ')) || '—';
      const balanceDue = parseFloat(b.totalAmount) - parseFloat(b.amountPaid);
      const fullyPaid = balanceDue <= 0.005;
      const allergyHtml = b.allergyNotes ? `
        <div class="mt-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2.5 flex items-start gap-2">
          <span class="text-red-500 text-sm mt-0.5 flex-shrink-0">⚠️</span>
          <div><span class="text-xs font-bold text-red-700 dark:text-red-300 uppercase">Dietary: </span><span class="text-sm text-red-800 dark:text-red-200">${escapeHtml(b.allergyNotes)}</span></div>
        </div>` : '';
      const addonsHtml = b.addonsSummary ? `<div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">➕ ${escapeHtml(b.addonsSummary)}</div>` : '';
      const cateringHtml = b.cateringChoice ? `
        <div class="mt-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2.5 text-sm">
          <div class="font-semibold text-gray-800 dark:text-gray-200">${b.cateringChoice === 'venue_menu' ? 'Venue menu' : 'Self-catering'}</div>
          <div class="text-red-700 dark:text-red-300 font-semibold text-xs mt-0.5">No alcohol${b.noAlcoholAck ? ' — acknowledged' : ' — NOT acknowledged'}</div>
        </div>` : '';

      return `
        <div class="border-2 border-gray-100 dark:border-gray-800 rounded-2xl p-5 mb-4 last:mb-0">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div class="flex items-center gap-2 mb-1">
                <span class="bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 font-bold text-sm px-3 py-1 rounded-full">${escapeHtml(b.partyTime)}</span>
                <span class="font-display font-bold text-lg text-gray-900 dark:text-white">${b.roomEmoji || ''} ${escapeHtml(b.roomName)}</span>
              </div>
              <div class="text-sm text-gray-600 dark:text-gray-400">${name} · <strong>${b.guestCount} kids</strong></div>
              ${b.cateringChoice ? cateringHtml : `<div class="text-sm font-semibold mt-1 text-gray-800 dark:text-gray-200">🍽️ ${escapeHtml(b.foodChoice) || '—'}</div>`}
              ${addonsHtml}
              ${allergyHtml}
            </div>
            <div class="text-right flex-shrink-0">
              <div class="text-lg font-bold ${fullyPaid ? 'text-green-600' : 'text-amber-600'}">
                ${fullyPaid ? '✅ Paid' : `⚠️ $${balanceDue.toFixed(2)} due`}
              </div>
              <div class="text-xs text-gray-400">Total $${parseFloat(b.totalAmount).toFixed(2)}</div>
              <div class="text-xs text-gray-400 font-mono mt-1">${escapeHtml(b.bookingRef)}</div>
            </div>
          </div>
          <div class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex gap-4 text-xs text-gray-400">
            ${b.contactEmail ? `<span>✉️ ${escapeHtml(b.contactEmail)}</span>` : ''}
            ${b.contactPhone ? `<span>📞 ${escapeHtml(b.contactPhone)}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<p class="text-red-400 text-sm">Failed to load run sheet: ${escapeHtml(err.message)}</p>`;
  }
}

async function renderAllergyAlerts() {
  const el = document.getElementById('today-allergy-alerts');
  if (!el) return;
  el.innerHTML = '<p class="text-amber-600 text-sm">Loading...</p>';
  try {
    const rows = await callAPI('admin/allergy-alerts', null, 'GET');
    if (!rows.length) {
      el.innerHTML = '<p class="text-amber-700 dark:text-amber-400 text-sm">✅ No dietary alerts in the next 14 days.</p>';
      return;
    }
    el.innerHTML = rows.map(b => {
      const name = escapeHtml([b.firstName, b.lastName].filter(Boolean).join(' ')) || '—';
      return `
        <div class="bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 mb-3 last:mb-0">
          <div class="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <div class="font-semibold text-sm text-gray-900 dark:text-gray-100">${b.roomEmoji || ''} ${escapeHtml(b.roomName)} · ${formatDate(b.partyDate)} @ ${escapeHtml(b.partyTime)}</div>
              <div class="text-xs text-gray-500 dark:text-gray-400">${name} · ${b.guestCount} kids</div>
              <div class="mt-1.5 text-sm font-semibold text-red-700 dark:text-red-300">⚠️ ${escapeHtml(b.allergyNotes)}</div>
            </div>
            <span class="font-mono text-xs text-indigo-500">${escapeHtml(b.bookingRef)}</span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<p class="text-red-400 text-sm">Failed to load.</p>`;
  }
}

async function renderBalancesDue() {
  const el = document.getElementById('today-balances-due');
  if (!el) return;
  el.innerHTML = '<p class="text-gray-400 text-sm">Loading...</p>';
  try {
    const rows = await callAPI('admin/balances-due', null, 'GET');
    // Update stat card too
    const statEl = document.getElementById('stat-balances-due');
    if (statEl) statEl.textContent = rows.length;

    if (!rows.length) {
      el.innerHTML = '<p class="text-gray-400 text-sm">✅ No outstanding balances.</p>';
      return;
    }
    const totalOwed = rows.reduce((s, r) => s + parseFloat(r.balanceDue), 0);
    el.innerHTML = `
      <div class="bg-amber-50 dark:bg-amber-900/20 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
        <span class="text-sm font-semibold text-amber-800 dark:text-amber-300">${rows.length} booking${rows.length === 1 ? '' : 's'} with outstanding balance</span>
        <span class="font-bold text-amber-700 dark:text-amber-400">$${totalOwed.toFixed(2)} total owed</span>
      </div>` +
    rows.map(b => {
      const name = escapeHtml([b.firstName, b.lastName].filter(Boolean).join(' ')) || '—';
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
          <div>
            <div class="font-semibold text-sm text-gray-900 dark:text-gray-100">${b.roomEmoji || ''} ${escapeHtml(b.roomName)} · ${formatDate(b.partyDate)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">${name} · ${b.contactEmail ? escapeHtml(b.contactEmail) : ''}</div>
          </div>
          <div class="text-right ml-3 flex-shrink-0">
            <div class="font-bold text-amber-600">$${parseFloat(b.balanceDue).toFixed(2)} due</div>
            <div class="text-xs text-gray-400">of $${parseFloat(b.totalAmount).toFixed(2)} total</div>
            <div class="text-xs font-mono text-indigo-500">${escapeHtml(b.bookingRef)}</div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<p class="text-red-400 text-sm">Failed to load.</p>`;
  }
}

// ---------------------------------------------------------------------------
// Bookings — sub-tab management
// ---------------------------------------------------------------------------
function switchBookingsSubTab(tab) {
  // Persist current tab's control values before switching
  const cur = bookingsTabState[bookingsSubTab];
  cur.search = document.getElementById('bookingsSearchInput')?.value || '';
  cur.statusFilter = document.getElementById('bookingStatusFilter')?.value || '';
  cur.sortOrder = document.getElementById('bookingsSortOrder')?.value || cur.sortOrder;

  bookingsSubTab = tab;

  // Restore the new tab's saved values
  const next = bookingsTabState[tab];
  const searchEl = document.getElementById('bookingsSearchInput');
  if (searchEl) searchEl.value = next.search;
  const statusEl = document.getElementById('bookingStatusFilter');
  if (statusEl) statusEl.value = next.statusFilter;
  const sortEl = document.getElementById('bookingsSortOrder');
  if (sortEl) sortEl.value = next.sortOrder;

  // Update pill styles
  document.getElementById('bst-upcoming')?.classList.toggle('active', tab === 'upcoming');
  document.getElementById('bst-past')?.classList.toggle('active', tab === 'past');

  renderCurrentBookingsSubTab();
}

function renderCurrentBookingsSubTab() {
  const q = (document.getElementById('bookingsSearchInput')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('bookingStatusFilter')?.value || '';
  const source = bookingsSubTab === 'upcoming' ? upcomingBookings : pastBookings;

  const filtered = source.filter(b => {
    const matchesSearch = !q ||
      (b.bookingRef || '').toLowerCase().includes(q) ||
      (b.contactEmail || '').toLowerCase().includes(q) ||
      (b.roomName || '').toLowerCase().includes(q) ||
      (b.adminNotes || '').toLowerCase().includes(q) ||
      `${b.firstName || ''} ${b.lastName || ''}`.toLowerCase().includes(q);
    const matchesStatus = !statusFilter || b.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  renderBookingsTable(getBookingsSorted(filtered));
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
async function loadBookings() {
  const tbody = document.getElementById('bookings-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  try {
    allBookings = await callAPI('admin/bookings?limit=500', null, 'GET');
  } catch (err) { console.error(err); return; }

  // A booking moves to Past once 90 minutes have elapsed since its actual
  // party_date + party_time (minutesPastDue is computed server-side against
  // NZ wall-clock time — see server/routes/admin.js), not merely once the
  // calendar date has rolled over.
  const isPast = b => parseFloat(b.minutesPastDue) > 90;
  upcomingBookings = allBookings.filter(b => !isPast(b));
  pastBookings     = allBookings.filter(isPast);

  // Update count badges
  const upEl = document.getElementById('upcoming-badge');
  const paEl = document.getElementById('past-badge');
  if (upEl) upEl.textContent = upcomingBookings.length;
  if (paEl) paEl.textContent = pastBookings.length;

  renderCurrentBookingsSubTab();
}

function handleBookingsSearch(query) {
  bookingsTabState[bookingsSubTab].search = query;
  renderCurrentBookingsSubTab();
}

function renderBookingsTable(bookings) {
  const tbody = document.getElementById('bookings-tbody');
  if (!tbody) return;

  if (!bookings || bookings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-gray-400">No bookings found.</td></tr>';
    return;
  }

  tbody.innerHTML = bookings.map(b => `
    <tr>
      <td data-label="Dates">
        <div class="text-sm font-semibold">${formatDate(b.partyDate)} · ${b.partyTime}</div>
        <div class="text-xs text-gray-400">Booked ${formatDate(b.createdAt)}</div>
      </td>
      <td data-label="Ref"><span class="font-mono text-xs text-indigo-600 font-bold">${b.bookingRef}</span>${b.adminNotes ? ' <span title="Has admin notes">📝</span>' : ''}</td>
      <td data-label="Customer">
        <div class="text-sm font-semibold">${escapeHtml([b.firstName, b.lastName].filter(Boolean).join(' ')) || '—'}</div>
        <div class="text-xs text-gray-400">${escapeHtml(b.contactEmail || '')}</div>
      </td>
      <td data-label="Room">${b.roomEmoji || ''} ${roomDisplayName(b.roomName)}</td>
      <td data-label="Guests">${b.guestCount}</td>
      <td data-label="Total" class="font-semibold">$${parseFloat(b.totalAmount || 0).toFixed(2)}</td>
      <td data-label="Status">
        <span class="badge ${statusBadgeClass(b.status)}">${b.status}</span>
        ${b.status === 'pending' ? (() => {
          const due = parseFloat(b.totalAmount || 0) - parseFloat(b.amountPaid || 0);
          return due > 0.005 ? `<div class="text-xs font-bold text-amber-600 mt-1">$${due.toFixed(2)} due</div>` : '';
        })() : ''}
        ${parseFloat(b.foodCreditAmount || 0) > 0 ? `<div class="text-xs font-bold text-green-600 mt-1">🍟 $${parseFloat(b.foodCreditAmount).toFixed(2)} credit</div>` : ''}
      </td>
      <td data-label="Actions">
        <div class="flex gap-2">
          <button onclick="viewBooking('${b.id}')" class="text-xs text-indigo-500 hover:underline font-semibold">View</button>
          ${b.status !== 'cancelled' ? `<button onclick="openEditBookingModal('${b.id}')" class="text-xs text-teal hover:underline font-semibold">Edit</button>` : ''}
          ${b.status !== 'cancelled' ? `<button onclick="cancelBooking('${b.id}', '${b.bookingRef}')" class="text-xs text-red-500 hover:underline font-semibold">Cancel</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

async function viewBooking(bookingId) {
  let booking = allBookings.find(b => b.id === bookingId);
  if (!booking) {
    try {
      booking = await callAPI('admin/bookings/' + bookingId, null, 'GET');
    } catch (err) {
      console.error('viewBooking fetch failed:', err);
      return;
    }
    if (!booking) return;
    allBookings.push(booking);
  }

  const guestCount = booking.guestCount || 0;
  const baseAmount = booking.baseAmount != null ? parseFloat(booking.baseAmount) : null;
  const ratePerChild = (baseAmount !== null && guestCount > 0) ? baseAmount / guestCount : null;
  const totalAmount = parseFloat(booking.totalAmount || 0);
  const amountPaid = parseFloat(booking.amountPaid || 0);
  const balanceDue = totalAmount - amountPaid;
  const customerName = escapeHtml([booking.firstName, booking.lastName].filter(Boolean).join(' '));

  document.getElementById('bookingDetailContent').innerHTML = `
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Booking Ref</div>
          <div class="font-mono font-bold text-indigo-600">${booking.bookingRef}</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Status</div>
          <span class="badge ${statusBadgeClass(booking.status)}">${booking.status}</span>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Room</div>
          <div class="font-semibold">${booking.roomEmoji || ''} ${roomDisplayName(booking.roomName)}</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Date & Time</div>
          <div class="font-semibold">${(booking.partyDate||'').slice(0,10)} @ ${booking.partyTime}</div>
        </div>
      </div>

      <div class="bg-gray-50 rounded-xl p-4">
        <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Customer</div>
        <div class="font-semibold text-sm">${customerName || '—'}</div>
        ${booking.contactEmail ? `<div class="text-xs text-gray-400 mt-0.5">${escapeHtml(booking.contactEmail)}</div>` : ''}
      </div>

      <div class="bg-indigo-light rounded-xl p-4">
        <div class="font-display font-bold text-indigo-700 mb-2 text-sm">📋 Order Summary</div>
        <div class="space-y-1.5 text-sm text-indigo-800">
          <div class="flex justify-between"><span>Guests:</span><span class="font-semibold">${guestCount} children</span></div>
          ${booking.cateringChoice ? `
          <div class="flex justify-between"><span>Catering:</span><span class="font-semibold">${booking.cateringChoice === 'venue_menu' ? 'Venue menu' : 'Self-catering'}</span></div>
          <div class="flex justify-between"><span>Alcohol:</span><span class="font-semibold text-red-600">${booking.noAlcoholAck ? 'Not permitted — acknowledged' : 'Not permitted — NOT acknowledged'}</span></div>
          ` : `<div class="flex justify-between"><span>Food:</span><span class="font-semibold">${escapeHtml(booking.foodChoice) || '—'}</span></div>`}
          ${ratePerChild ? `<div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${ratePerChild.toFixed(2)}/child × ${guestCount} = $${baseAmount.toFixed(2)}</span></div>` : ''}
          ${booking.addonsSummary ? `<div class="flex justify-between"><span>Add-ons:</span><span class="font-semibold text-right">${escapeHtml(booking.addonsSummary)}</span></div>` : ''}
          <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
            <span>Total:</span><span class="text-indigo-600">$${totalAmount.toFixed(2)} NZD</span>
          </div>
          <div class="flex justify-between text-sm"><span>Paid:</span><span class="font-semibold text-green-700">$${amountPaid.toFixed(2)}</span></div>
          ${balanceDue > 0.005 ? `<div class="flex justify-between text-sm font-bold"><span>Balance due:</span><span class="text-amber-600">$${balanceDue.toFixed(2)}</span></div>` : ''}
        </div>
      </div>

      ${parseFloat(booking.foodCreditAmount || 0) > 0 ? `
      <div class="bg-green-50 border border-green-200 rounded-xl p-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs text-green-600 mb-1 uppercase font-semibold">🍟 Food Credit — from a guest-count reduction</div>
            <div class="text-sm font-bold text-green-800">$${parseFloat(booking.foodCreditAmount).toFixed(2)} outstanding, redeemable at the venue</div>
          </div>
          <button onclick="redeemFoodCredit('${booking.id}')" class="btn-secondary py-2 px-3 text-xs whitespace-nowrap">Mark Redeemed</button>
        </div>
      </div>` : ''}

      ${booking.allergyNotes ? `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div class="text-xs text-amber-600 mb-1 uppercase font-semibold">⚠️ Dietary Requirements</div>
        <div class="text-sm text-gray-600">${escapeHtml(booking.allergyNotes)}</div>
      </div>` : ''}
      ${booking.adminNotes ? `
      <div class="bg-gray-100 border border-gray-200 rounded-xl p-4">
        <div class="text-xs text-gray-500 mb-1 uppercase font-semibold">📝 Admin Notes — internal only</div>
        <div class="text-sm text-gray-700 whitespace-pre-wrap">${escapeHtml(booking.adminNotes)}</div>
      </div>` : ''}
      <div class="text-xs text-gray-400">Booked: ${new Date(booking.createdAt).toLocaleString('en-NZ', { timeZone: NZ_TZ })}</div>
      ${booking.status === 'confirmed' ? `
      <div class="mt-2 flex gap-3">
        <button onclick="openRescheduleModal('${booking.id}')" class="btn-secondary flex-1 py-3 text-sm">
          Reschedule Time
        </button>
        <button onclick="openChangeRoomModal('${booking.id}')" class="btn-secondary flex-1 py-3 text-sm">
          Change Room
        </button>
      </div>` : ''}
      ${booking.status === 'confirmed' && booking.roomPricingModel === 'per_child' && !booking.upgradeStatus ? `
      <button onclick="openVenueUpgradeModal('${booking.id}')" class="w-full py-3 rounded-xl font-semibold text-sm text-white transition-all mt-2" style="background: linear-gradient(135deg,#334155,#0F172A)">
        🏛️ Upgrade to Whole Venue Hire
      </button>` : ''}
      ${booking.upgradeStatus === 'pending_payment' ? `
      <div class="bg-slate-100 border border-slate-300 rounded-xl p-4 mt-2">
        <div class="text-xs text-slate-600 mb-1 uppercase font-semibold">🏛️ Whole Venue Upgrade — Payment Pending</div>
        <div class="text-sm text-slate-700 mb-2">Rate: $${parseFloat(booking.upgradeOverageRate || 0).toFixed(2)}/child. Deadline: ${booking.upgradeDeadlineAt ? new Date(booking.upgradeDeadlineAt).toLocaleDateString('en-NZ', { timeZone: NZ_TZ }) : '—'}</div>
        <button onclick="sendUpgradePaymentLink('${booking.id}', '${escapeHtml(booking.bookingRef)}')" class="btn-secondary w-full py-2.5 text-sm">📧 Send Payment Link</button>
      </div>` : ''}
      ${booking.upgradeStatus === 'completed' ? `
      <div class="bg-slate-100 border border-slate-300 rounded-xl p-4 mt-2">
        <div class="text-xs text-slate-600 mb-1 uppercase font-semibold">🏛️ Whole Venue Upgrade — Paid</div>
        <button onclick="sendUpgradePaymentLink('${booking.id}', '${escapeHtml(booking.bookingRef)}')" class="btn-secondary w-full py-2.5 text-sm">📧 Send Update Email</button>
      </div>` : ''}
      <div class="flex gap-3 mt-2">
        ${booking.status === 'confirmed' ? `
        <button onclick="openResendConfirmationModal('${booking.id}')" class="btn-secondary flex-1 py-3 text-sm">
          ✉️ Resend Confirmation
        </button>` : ''}
        ${booking.status === 'confirmed' && booking.userIsPlaceholder && FEATURE_MAGIC_LINK_ENABLED ? `
        <button onclick="resendMagicLink('${booking.id}', '${escapeHtml(booking.bookingRef)}')" class="btn-secondary flex-1 py-3 text-sm">
          🔑 Resend Magic Link
        </button>` : ''}
        ${booking.status !== 'cancelled' ? `
        <button onclick="cancelBooking('${booking.id}', '${booking.bookingRef}')" class="flex-1 py-3 rounded-xl font-semibold text-sm text-white transition-all" style="background: linear-gradient(135deg,#EF4444,#DC2626)">
          Cancel Booking
        </button>` : ''}
      </div>
    </div>`;

  document.getElementById('bookingDetailModal').style.display = 'flex';
}

async function redeemFoodCredit(bookingId) {
  if (!confirm('Mark this food credit as fully redeemed? This cannot be undone.')) return;
  try {
    await callAPI(`admin/bookings/${bookingId}/redeem-credit`, {}, 'POST');
    const idx = allBookings.findIndex(b => b.id === bookingId);
    if (idx !== -1) allBookings.splice(idx, 1); // force a fresh fetch in viewBooking
    await viewBooking(bookingId);
  } catch (err) {
    alert('Could not redeem credit: ' + err.message);
  }
}

function closeBookingModal() {
  document.getElementById('bookingDetailModal').style.display = 'none';
}

let rescheduleState = { bookingId: null, currentDate: null, currentTime: null, selectedDate: null, selectedTime: null, lastData: null };

function rescheduleDateLabel(dateStr) {
  const [y, m, d] = (dateStr || '').slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function openRescheduleModal(bookingId) {
  const modal = document.getElementById('rescheduleModal');
  const content = document.getElementById('rescheduleContent');
  rescheduleState = { bookingId, currentDate: null, currentTime: null, selectedDate: null, selectedTime: null, lastData: null };
  content.innerHTML = '<p class="text-center text-gray-400 py-6">Loading available slots…</p>';
  modal.style.display = 'flex';

  let data;
  try {
    data = await callAPI(`admin/bookings/${bookingId}/reschedule-slots`, null, 'GET');
  } catch (err) {
    content.innerHTML = `<p class="text-red-500 text-sm">${escapeHtml(err.message)}</p>`;
    return;
  }

  rescheduleState.currentDate = data.currentDate;
  rescheduleState.currentTime = data.currentTime;
  rescheduleState.lastData = data;
  renderRescheduleContent(data);
}

// Picking a slot only stages it — the reschedule doesn't happen until the
// admin explicitly clicks the Confirm button below the grid. A prior version
// fired the reschedule straight off the slot click (behind a native
// confirm() popup), which was easy to misfire or dismiss without the admin
// realizing nothing had actually happened.
function renderRescheduleContent(data) {
  const content = document.getElementById('rescheduleContent');
  const { currentDate, currentTime, requestedDate, slots, anyAvailable } = data;
  const isSelected = t => rescheduleState.selectedDate === requestedDate && rescheduleState.selectedTime === t;

  const slotsHtml = anyAvailable ? `
    <div id="rescheduleSlotGrid" class="grid grid-cols-2 gap-3 mb-2">
      ${slots.map(s => {
        if (s.isCurrent) {
          return `<div class="px-4 py-3 rounded-xl border-2 border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold text-sm text-center">
            ${escapeHtml(s.time)} <span class="text-xs font-normal ml-1">(current)</span>
          </div>`;
        }
        if (s.isTaken) {
          return `<div class="px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-400 font-semibold text-sm text-center cursor-not-allowed">
            ${escapeHtml(s.time)} <span class="text-xs font-normal ml-1">(taken)</span>
          </div>`;
        }
        const selected = isSelected(s.time);
        return `<button onclick="selectRescheduleSlot('${requestedDate}', '${escapeHtml(s.time)}')"
          class="px-4 py-3 rounded-xl border-2 font-semibold text-sm text-center transition-all w-full ${selected ? 'border-brand-orange bg-orange-50 ring-2 ring-brand-orange' : 'border-gray-200 hover:border-brand-orange hover:bg-orange-50'}">
          ${escapeHtml(s.time)}${selected ? ' <span class="text-xs font-normal ml-1">✓ selected</span>' : ''}
        </button>`;
      }).join('')}
    </div>`
    : `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        No time slots available on this date.
      </div>`;

  const canConfirm = !!(rescheduleState.selectedDate && rescheduleState.selectedTime);
  const confirmBtn = `
    <button id="rescheduleConfirmBtn" onclick="doConfirmReschedule()" ${canConfirm ? '' : 'disabled'}
      class="btn-primary w-full py-3 text-sm mt-3 ${canConfirm ? '' : 'opacity-40 cursor-not-allowed'}">
      ${canConfirm ? `Confirm reschedule to ${escapeHtml(rescheduleState.selectedTime)} on ${escapeHtml(rescheduleDateLabel(rescheduleState.selectedDate))}` : 'Select a new time slot'}
    </button>
    <p class="text-xs text-gray-400 mt-2">Confirming will immediately release the current slot, book the new one, and email the customer.</p>`;

  content.innerHTML = `
    <p class="text-sm text-gray-600 mb-3">Current: <strong>${escapeHtml(currentTime)}</strong> on ${escapeHtml(rescheduleDateLabel(currentDate))}</p>
    <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">New date</label>
    <input type="date" id="reschedule_date_input" class="field mb-4" value="${requestedDate}" min="${nzDateStr()}" onchange="onRescheduleDateChange()" />
    <div id="rescheduleSlotsWrap">${slotsHtml}</div>
    ${confirmBtn}`;
}

function selectRescheduleSlot(date, time) {
  rescheduleState.selectedDate = date;
  rescheduleState.selectedTime = time;
  renderRescheduleContent(rescheduleState.lastData);
}

async function onRescheduleDateChange() {
  const dateVal = document.getElementById('reschedule_date_input').value;
  if (!dateVal) return;

  // Changing the date invalidates any slot already staged on the old date.
  rescheduleState.selectedDate = null;
  rescheduleState.selectedTime = null;

  const wrap = document.getElementById('rescheduleSlotsWrap');
  wrap.innerHTML = '<p class="text-center text-gray-400 text-sm py-4">Checking availability…</p>';

  let data;
  try {
    data = await callAPI(`admin/bookings/${rescheduleState.bookingId}/reschedule-slots?date=${dateVal}`, null, 'GET');
  } catch (err) {
    wrap.innerHTML = `<p class="text-red-500 text-sm">${escapeHtml(err.message)}</p>`;
    return;
  }
  rescheduleState.lastData = data;
  renderRescheduleContent(data);
}

async function doConfirmReschedule() {
  const { bookingId, selectedDate: newDate, selectedTime: newTime } = rescheduleState;
  if (!newDate || !newTime) return;

  const content = document.getElementById('rescheduleContent');
  const dateLabel = rescheduleDateLabel(newDate);
  content.innerHTML = '<p class="text-center text-gray-400 py-6">Rescheduling…</p>';

  try {
    const result = await callAPI(`admin/bookings/${bookingId}/reschedule`, { newDate, newTime }, 'POST');

    try {
      await callAPI('notifications/booking-rescheduled', {
        bookingId,
        bookingRef:   result.bookingRef,
        email:        result.contactEmail,
        phone:        result.contactPhone,
        firstName:    result.firstName,
        roomName:     result.roomName,
        partyDate:    result.newDate,
        oldDate:      result.oldDate,
        oldTime:      result.oldTime,
        newTime:      result.newTime,
      });
    } catch (notifErr) {
      console.warn('Reschedule notification failed:', notifErr.message);
    }

    closeRescheduleModal();
    closeBookingModal();
    alert(`✅ Booking rescheduled to ${newTime} on ${dateLabel}. Customer has been notified.`);
    await loadBookings();
  } catch (err) {
    content.innerHTML = `<p class="text-red-500 text-sm mb-3">${escapeHtml(err.message)}</p>
      <button onclick="closeRescheduleModal()" class="btn-secondary w-full py-3 text-sm">Close</button>`;
  }
}

function closeRescheduleModal() {
  document.getElementById('rescheduleModal').style.display = 'none';
}

// Two deliberate steps are required before a room actually changes: picking
// a room (stage 'select') only stages it, then a dedicated warning screen
// (stage 'confirm') with its own explicit button is what actually fires the
// API call. This mirrors the reschedule flow's "don't fire off a native
// confirm() popup" convention above, but goes one step further since a room
// move has no undo — moving back is just another change, not a revert.
let roomChangeState = { bookingId: null, stage: 'select', data: null, selectedRoomId: null, selectedRoomName: null };

async function openChangeRoomModal(bookingId) {
  const modal = document.getElementById('changeRoomModal');
  const content = document.getElementById('changeRoomContent');
  roomChangeState = { bookingId, stage: 'select', data: null, selectedRoomId: null, selectedRoomName: null };
  content.innerHTML = '<p class="text-center text-gray-400 py-6">Loading rooms…</p>';
  modal.style.display = 'flex';

  let data;
  try {
    data = await callAPI(`admin/bookings/${bookingId}/room-options`, null, 'GET');
  } catch (err) {
    content.innerHTML = `<p class="text-red-500 text-sm">${escapeHtml(err.message)}</p>`;
    return;
  }

  roomChangeState.data = data;
  renderChangeRoomSelect();
}

function renderChangeRoomSelect() {
  const { data, selectedRoomId } = roomChangeState;
  const content = document.getElementById('changeRoomContent');

  const roomsHtml = data.rooms.map(r => {
    if (r.isCurrent) {
      return `<div class="px-4 py-3 rounded-xl border-2 border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold text-sm">
        ${r.emoji || ''} ${escapeHtml(roomDisplayName(r.name))} <span class="text-xs font-normal ml-1">(current)</span>
      </div>`;
    }
    if (!r.available) {
      const reason = r.isTaken ? 'booked at this date/time' : `needs ${r.minGuests}-${r.maxGuests} guests`;
      return `<div class="px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-400 font-semibold text-sm cursor-not-allowed">
        ${r.emoji || ''} ${escapeHtml(roomDisplayName(r.name))} <span class="text-xs font-normal ml-1">(${reason})</span>
      </div>`;
    }
    const selected = r.id === selectedRoomId;
    return `<button onclick="selectChangeRoomOption('${r.id}', '${escapeHtml(r.name).replace(/'/g, "\\'")}')"
      class="px-4 py-3 rounded-xl border-2 font-semibold text-sm text-left transition-all w-full ${selected ? 'border-brand-orange bg-orange-50 ring-2 ring-brand-orange' : 'border-gray-200 hover:border-brand-orange hover:bg-orange-50'}">
      ${r.emoji || ''} ${escapeHtml(roomDisplayName(r.name))}${selected ? ' <span class="text-xs font-normal ml-1">✓ selected</span>' : ''}
    </button>`;
  }).join('');

  const canContinue = !!selectedRoomId;
  content.innerHTML = `
    <p class="text-sm text-gray-600 mb-3">Guest count: <strong>${data.guestCount}</strong> · ${(data.partyDate||'').slice(0,10)} @ ${escapeHtml(data.partyTime)}</p>
    <div class="grid grid-cols-1 gap-2 mb-2">${roomsHtml}</div>
    <button id="changeRoomContinueBtn" onclick="showChangeRoomWarning()" ${canContinue ? '' : 'disabled'}
      class="btn-primary w-full py-3 text-sm mt-3 ${canContinue ? '' : 'opacity-40 cursor-not-allowed'}">
      Continue
    </button>`;
}

function selectChangeRoomOption(roomId, roomName) {
  roomChangeState.selectedRoomId = roomId;
  roomChangeState.selectedRoomName = roomName;
  renderChangeRoomSelect();
}

// The second, distinct confirmation screen. Nothing on this screen is
// clickable by accident — it's a full replacement of the modal content with
// one clearly dangerous action and one clearly safe "go back" action.
function showChangeRoomWarning() {
  const { data, selectedRoomName } = roomChangeState;
  if (!selectedRoomName) return;
  roomChangeState.stage = 'confirm';

  const currentRoom = data.rooms.find(r => r.isCurrent);
  const content = document.getElementById('changeRoomContent');
  content.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
      <div class="font-bold text-amber-800 text-sm mb-1">⚠️ This is permanent</div>
      <p class="text-sm text-amber-800">
        You are about to move this booking from
        <strong>${escapeHtml(roomDisplayName(currentRoom ? currentRoom.name : ''))}</strong> to
        <strong>${escapeHtml(roomDisplayName(selectedRoomName))}</strong>.
        The old room's time slot is released immediately and cannot be recovered — this cannot be undone
        (moving back later would just be another room change).
      </p>
    </div>
    <div class="flex gap-3">
      <button onclick="renderChangeRoomSelect()" class="btn-secondary flex-1 py-3 text-sm">
        Go back
      </button>
      <button onclick="doConfirmChangeRoom()" class="flex-1 py-3 rounded-xl font-semibold text-sm text-white transition-all" style="background: linear-gradient(135deg,#EF4444,#DC2626)">
        Yes, permanently change room
      </button>
    </div>`;
}

async function doConfirmChangeRoom() {
  const { bookingId, selectedRoomId, selectedRoomName } = roomChangeState;
  if (!bookingId || !selectedRoomId) return;

  const content = document.getElementById('changeRoomContent');
  content.innerHTML = '<p class="text-center text-gray-400 py-6">Changing room…</p>';

  try {
    const result = await callAPI(`admin/bookings/${bookingId}/change-room`, { newRoomId: selectedRoomId }, 'POST');
    closeChangeRoomModal();
    closeBookingModal();
    alert(`✅ Booking ${result.bookingRef} moved from ${roomDisplayName(result.oldRoomName)} to ${roomDisplayName(result.newRoomName)}.`);
    await loadBookings();
  } catch (err) {
    content.innerHTML = `<p class="text-red-500 text-sm mb-3">${escapeHtml(err.message)}</p>
      <button onclick="renderChangeRoomSelect()" class="btn-secondary w-full py-3 text-sm">Back</button>`;
  }
}

function closeChangeRoomModal() {
  document.getElementById('changeRoomModal').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Venue upgrade (extra-kids whole-venue-hire conversion)
// ---------------------------------------------------------------------------
let venueUpgradeState = { bookingId: null };

function openVenueUpgradeModal(bookingId) {
  venueUpgradeState = { bookingId };
  const modal = document.getElementById('venueUpgradeModal');
  const content = document.getElementById('venueUpgradeContent');
  content.innerHTML = `
    <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">Switches this booking's room to Whole Venue Hire and its pricing to per-child (at this booking's current per-child rate) for the new headcount. The customer will owe the difference between the new total and what's already been paid.</p>
    <div>
      <label class="lbl">New Total Guest Count</label>
      <input class="field" type="number" id="vu_newGuestCount" min="24" placeholder="e.g. 30" oninput="venueUpgradePreview()" />
    </div>
    <div id="venueUpgradePreviewBox" class="mt-3"></div>
    <div id="venueUpgradeError" class="text-red-500 text-sm hidden mt-3"></div>
    <div class="flex gap-3 mt-4">
      <button onclick="closeVenueUpgradeModal()" class="btn-secondary flex-1 py-3">Cancel</button>
      <button onclick="doConfirmVenueUpgrade()" class="flex-1 py-3 rounded-xl font-semibold text-sm text-white transition-all" id="venueUpgradeConfirmBtn" disabled style="background: linear-gradient(135deg,#334155,#0F172A); opacity:.5" >Confirm Upgrade</button>
    </div>`;
  modal.style.display = 'flex';
}

function closeVenueUpgradeModal() {
  document.getElementById('venueUpgradeModal').style.display = 'none';
}

let venueUpgradePreviewDebounce = null;
function venueUpgradePreview() {
  clearTimeout(venueUpgradePreviewDebounce);
  venueUpgradePreviewDebounce = setTimeout(async () => {
    const box = document.getElementById('venueUpgradePreviewBox');
    const confirmBtn = document.getElementById('venueUpgradeConfirmBtn');
    const newGuestCount = parseInt(document.getElementById('vu_newGuestCount').value, 10);
    if (!newGuestCount) { box.innerHTML = ''; confirmBtn.disabled = true; confirmBtn.style.opacity = .5; return; }

    box.innerHTML = '<p class="text-xs text-gray-400">Calculating…</p>';
    try {
      const preview = await callAPI(`admin/bookings/${venueUpgradeState.bookingId}/upgrade-preview?newGuestCount=${newGuestCount}`, null, 'GET');
      let warnings = '';
      if (!preview.dayOfWeekOk) warnings += `<div class="text-amber-600 mb-1">⚠️ This party's date isn't normally a Whole Venue Hire day (Sun/Mon/Tue) — you can still proceed, but double check this is intended.</div>`;
      if (preview.deadlineTooClose) warnings += `<div class="text-amber-600 mb-1">⚠️ This party is close to a week away — the payment deadline may already be too tight.</div>`;
      box.innerHTML = `
        <div class="bg-slate-50 dark:bg-gray-800 rounded-xl p-3 text-sm space-y-1">
          <div class="flex justify-between"><span>Per-child rate</span><span class="font-semibold">$${preview.overageRate.toFixed(2)}</span></div>
          <div class="flex justify-between"><span>New total</span><span class="font-semibold">$${preview.newTotalAmount.toFixed(2)}</span></div>
          <div class="flex justify-between"><span>Already paid</span><span class="font-semibold">$${preview.amountPaid.toFixed(2)}</span></div>
          <div class="flex justify-between border-t border-gray-200 dark:border-gray-700 pt-1 mt-1"><span class="font-bold">Amount due</span><span class="font-bold text-slate-800 dark:text-white">$${preview.delta.toFixed(2)}</span></div>
        </div>
        <div class="text-xs mt-2">${warnings}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = 1;
    } catch (err) {
      box.innerHTML = `<p class="text-red-500 text-sm">${escapeHtml(err.message)}</p>`;
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = .5;
    }
  }, 350);
}

async function doConfirmVenueUpgrade() {
  const newGuestCount = parseInt(document.getElementById('vu_newGuestCount').value, 10);
  const errEl = document.getElementById('venueUpgradeError');
  errEl.classList.add('hidden');
  try {
    await callAPI(`admin/bookings/${venueUpgradeState.bookingId}/upgrade-to-venue`, { newGuestCount }, 'POST');
    closeVenueUpgradeModal();
    closeBookingModal();
    alert('✅ Booking upgraded to Whole Venue Hire. Use "Send Payment Link" on the booking to email the customer.');
    await loadBookings();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function sendUpgradePaymentLink(bookingId, bookingRef) {
  if (!confirm(`Send the whole-venue-upgrade update email (with payment link, if payment is still due) for booking ${bookingRef}? This invalidates any payment link sent previously.`)) return;
  try {
    const result = await callAPI(`admin/bookings/${bookingId}/send-upgrade-payment-link`, {}, 'POST');
    alert(result.amountDue > 0 ? `✅ Update email sent — $${result.amountDue.toFixed(2)} due.` : '✅ Update email sent — no payment required.');
  } catch (err) {
    alert('Failed to send: ' + err.message);
  }
}

// Replaces the old bare confirm() dialog: a plain confirm() can't offer the
// "include admin notes" checkbox, so this is a small modal instead. The
// checkbox is a per-send choice (not a persisted booking field) — ticked
// fresh each time so a note added for one resend can't silently leak into
// some later, unrelated resend nobody meant to include it in. Looks the
// booking up from allBookings by id (rather than taking bookingRef/
// adminNotes as onclick-attribute arguments) since admin notes are
// arbitrary free text — unsafe to interpolate directly into an inline
// onclick="..." attribute the way a generated booking ref safely can be.
function openResendConfirmationModal(bookingId) {
  const booking = allBookings.find(b => b.id === bookingId);
  if (!booking) return;
  const bookingRef = booking.bookingRef;
  const adminNotes = booking.adminNotes || '';
  const modal = document.getElementById('resendConfirmationModal');
  const content = document.getElementById('resendConfirmationContent');
  const hasNotes = FEATURE_NOTES_EMAIL_TOGGLE_ENABLED && !!(adminNotes && adminNotes.trim());

  content.innerHTML = `
    <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">Resend the confirmation email for booking <strong>${escapeHtml(bookingRef)}</strong>?</p>
    ${hasNotes ? `
    <label class="flex items-start gap-2 p-3 rounded-xl border-2 border-gray-200 dark:border-gray-700 cursor-pointer mb-4">
      <input type="checkbox" id="rc_includeNotes" class="mt-0.5 w-4 h-4 accent-indigo-500 flex-shrink-0" />
      <span class="text-sm">Include admin notes under a <strong>NOTES:</strong> heading in this email</span>
    </label>
    <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs text-gray-500 whitespace-pre-wrap mb-4">${escapeHtml(adminNotes)}</div>
    ` : ''}
    <div id="resendConfirmationError" class="text-red-500 text-sm hidden mb-3"></div>
    <div class="flex gap-3">
      <button onclick="closeResendConfirmationModal()" class="btn-secondary flex-1 py-3">Cancel</button>
      <button onclick="doResendConfirmationEmail('${bookingId}', '${escapeHtml(bookingRef)}')" class="btn-primary flex-1 py-3">Resend</button>
    </div>`;

  modal.style.display = 'flex';
}

function closeResendConfirmationModal() {
  document.getElementById('resendConfirmationModal').style.display = 'none';
}

async function resendMagicLink(bookingId, bookingRef) {
  if (!confirm(`Resend the account setup link for booking ${bookingRef}? This invalidates any link sent previously.`)) return;
  try {
    await callAPI(`admin/bookings/${bookingId}/resend-magic-link`, {}, 'POST');
    alert('✅ Account setup link resent.');
  } catch (err) {
    alert('Failed to resend: ' + err.message);
  }
}

async function doResendConfirmationEmail(bookingId, bookingRef) {
  const includeNotes = document.getElementById('rc_includeNotes')?.checked || false;
  try {
    await callAPI(`admin/bookings/${bookingId}/resend-confirmation`, { includeNotes }, 'POST');
    closeResendConfirmationModal();
    alert('✅ Confirmation email resent.');
  } catch (err) {
    const errEl = document.getElementById('resendConfirmationError');
    if (errEl) { errEl.textContent = 'Failed to resend: ' + err.message; errEl.classList.remove('hidden'); }
    else alert('Failed to resend: ' + err.message);
  }
}

async function cancelBooking(bookingId, bookingRef) {
  let payment = null;
  try {
    payment = await callAPI(`admin/payments/for-booking/${bookingId}`, null, 'GET');
  } catch { /* no payment found, proceed */ }

  const isManualPayment = payment?.paymentMethod === 'manual';
  const needsStripeRefund = payment && payment.stripePaymentIntentId && !isManualPayment;

  let confirmMsg = `Are you sure you want to cancel booking ${bookingRef}? This cannot be undone.`;
  if (needsStripeRefund) {
    confirmMsg += `\n\nThis will automatically refund $${parseFloat(payment.amount).toFixed(2)} NZD via Stripe.`;
  } else if (isManualPayment) {
    confirmMsg += `\n\nThis booking was paid manually — no automatic Stripe refund. Refund the customer directly if needed.`;
  }
  if (!confirm(confirmMsg)) return;

  try {
    await callAPI(`admin/bookings/${bookingId}/cancel`, {}, 'PATCH');
  } catch (err) {
    alert('Cancel failed: ' + err.message);
    return;
  }

  let refundMsg = '';
  if (needsStripeRefund) {
    try {
      await callAPI(`admin/payments/${payment.id}/refund`, {
        stripePaymentIntentId: payment.stripePaymentIntentId,
        amount: Math.round(parseFloat(payment.amount) * 100),
      });
      refundMsg = `\n💸 Refund of $${parseFloat(payment.amount).toFixed(2)} processed automatically.`;
    } catch (err) {
      refundMsg = `\n⚠️ Booking was cancelled but the automatic refund failed: ${err.message}\nPlease process it manually from the Payments tab.`;
    }
  }

  closeBookingModal();
  alert(`✅ Booking cancelled.${refundMsg}`);
  await loadBookings();
}

async function clearCancelledBookings() {
  const stats = await callAPI('admin/stats', null, 'GET').catch(() => null);
  const count = stats?.cancelledCount || 0;

  if (!count) { alert('No cancelled bookings to clear.'); return; }
  if (!confirm(`Permanently delete all ${count} cancelled booking${count === 1 ? '' : 's'}? This cannot be undone.`)) return;

  try {
    const { deleted } = await callAPI('admin/bookings/cancelled', null, 'DELETE');
    alert(`✅ Cleared ${deleted} cancelled booking${deleted === 1 ? '' : 's'}.`);
    refreshCurrentTab();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
let paymentsSubTab = 'stripe';
let paymentsRange = { from: null, to: null };

async function loadPayments() {
  const tbody = document.getElementById('payments-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  let endpoint = 'admin/payments?limit=200';
  if (paymentsRange.from && paymentsRange.to) {
    endpoint = `admin/payments?from=${paymentsRange.from}&to=${paymentsRange.to}`;
  }

  try {
    allPayments = await callAPI(endpoint, null, 'GET');
  } catch (err) { console.error(err); return; }
  renderCurrentPaymentsSubTab();
  loadPaymentsSummary();
}

// ---------------------------------------------------------------------------
// Payments — summary banner + date range
// ---------------------------------------------------------------------------
async function loadPaymentsSummary() {
  const titleEl = document.getElementById('payments-summary-title');
  const subtitleEl = document.getElementById('payments-summary-subtitle');

  let endpoint = 'admin/payments/summary';
  if (paymentsRange.from && paymentsRange.to) {
    endpoint += `?from=${paymentsRange.from}&to=${paymentsRange.to}`;
    if (titleEl) titleEl.textContent = `📊 ${paymentsRange.from} → ${paymentsRange.to}`;
    if (subtitleEl) subtitleEl.textContent = 'Payment traffic for the selected range';
  } else {
    if (titleEl) titleEl.textContent = '📊 This Month';
    if (subtitleEl) subtitleEl.textContent = 'Payment traffic overview';
  }

  let data;
  try {
    data = await callAPI(endpoint, null, 'GET');
  } catch (err) { console.error('payments summary load failed', err); return; }

  document.getElementById('payments-summary-revenue').textContent = '$' + data.revenue.toFixed(2);
  document.getElementById('payments-summary-count').textContent = data.successCount;
  const avg = data.successCount > 0 ? data.revenue / data.successCount : 0;
  document.getElementById('payments-summary-avg').textContent = '$' + avg.toFixed(2);
  document.getElementById('payments-summary-refunds').textContent = '$' + data.refundedAmount.toFixed(2);
  const refundCountEl = document.getElementById('payments-summary-refund-count');
  if (refundCountEl) refundCountEl.textContent = data.refundedCount > 0 ? `(${data.refundedCount})` : '';
}

function applyPaymentsDateRange() {
  const from = document.getElementById('paymentsRangeFrom').value;
  const to = document.getElementById('paymentsRangeTo').value;
  if (!from || !to) {
    alert('Please select both a from and to date.');
    return;
  }
  if (from > to) {
    alert('The "from" date must be before the "to" date.');
    return;
  }
  paymentsRange = { from, to };
  loadPayments();
}

function clearPaymentsDateRange() {
  document.getElementById('paymentsRangeFrom').value = '';
  document.getElementById('paymentsRangeTo').value = '';
  paymentsRange = { from: null, to: null };
  loadPayments();
}

// ---------------------------------------------------------------------------
// Payments — sub-tab management
// ---------------------------------------------------------------------------
function switchPaymentsSubTab(tab) {
  paymentsSubTab = tab;
  document.getElementById('pst-stripe')?.classList.toggle('active', tab === 'stripe');
  document.getElementById('pst-manual')?.classList.toggle('active', tab === 'manual');
  renderCurrentPaymentsSubTab();
}

function renderCurrentPaymentsSubTab() {
  const stripePayments = allPayments.filter(p => p.paymentMethod !== 'manual');
  const manualPayments = allPayments.filter(p => p.paymentMethod === 'manual');

  const stripeBadge = document.getElementById('stripe-payments-badge');
  if (stripeBadge) stripeBadge.textContent = stripePayments.length;
  const manualBadge = document.getElementById('manual-payments-badge');
  if (manualBadge) manualBadge.textContent = manualPayments.length;

  renderPaymentsTable(paymentsSubTab === 'manual' ? manualPayments : stripePayments);
}

// Cardholder first name for the Payments tab, in priority order:
//   1) Stripe billing_details.name captured at checkout (payments.cardholder_name)
//   2) the name on the linked booking's account (users.first_name)
//   3) parsed from the contact email's local part, capitalized
//   4) '—'
function cardholderFirstName(p) {
  const fromStripe = (p.cardholderName || '').trim().split(/\s+/)[0];
  if (fromStripe) return fromStripe;

  const fromUser = (p.userFirstName || '').trim().split(/\s+/)[0];
  if (fromUser) return fromUser;

  const localPart = (p.contactEmail || '').split('@')[0];
  if (localPart) return localPart.charAt(0).toUpperCase() + localPart.slice(1).toLowerCase();

  return null;
}

function paymentStatusBadgeClass(status) {
  return status === 'succeeded' ? 'badge-green'
       : status === 'failed'    ? 'badge-red'
       : status === 'refunded'  ? 'badge-yellow'
       : status === 'pending'   ? 'badge-gray'
       : 'badge-gray';
}

function renderPaymentsTable(payments) {
  const tbody = document.getElementById('payments-tbody');
  if (!tbody) return;

  if (!payments || payments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">No payments found.</td></tr>';
    return;
  }

  tbody.innerHTML = payments.map(p => {
    const cardInfo = (p.cardBrand && p.cardLast4)
      ? `${p.cardBrand.toUpperCase()} •••• ${p.cardLast4}`
      : null;
    const bookingRefHtml = p.bookingRef
      ? (p.bookingId
          ? `<span class="font-mono text-sm text-indigo-600 hover:underline cursor-pointer" onclick="viewBooking('${p.bookingId}')">${escapeHtml(p.bookingRef)}</span>`
          : `<span class="font-mono text-sm text-indigo-600">${escapeHtml(p.bookingRef)}</span>`)
      : '<span class="text-gray-400">—</span>';

    return `
    <tr>
      <td data-label="Customer">
        <div class="font-semibold text-sm text-gray-900">${escapeHtml(cardholderFirstName(p)) || '—'}</div>
        ${cardInfo ? `<div class="text-xs text-gray-400 mt-0.5">${cardInfo}</div>` : ''}
      </td>
      <td data-label="Email">
        <div class="text-sm text-gray-500">${escapeHtml(p.contactEmail) || '—'}</div>
      </td>
      <td data-label="Booking Ref">${bookingRefHtml}</td>
      <td data-label="Amount" class="font-bold text-gray-900">$${parseFloat(p.amount || 0).toFixed(2)} ${(p.currency || 'nzd').toUpperCase()}</td>
      <td data-label="Status"><span class="badge ${paymentStatusBadgeClass(p.status)}">${p.status}</span></td>
      <td data-label="Date" class="text-sm text-gray-500">${new Date(p.createdAt).toLocaleString('en-NZ', { timeZone: NZ_TZ })}</td>
      <td data-label="Action">
        ${p.status === 'succeeded' ? `<button onclick="refundPayment('${p.id}', '${p.stripePaymentIntentId}', ${p.amount})" class="text-sm text-red-500 hover:underline font-semibold">Refund</button>` : '—'}
      </td>
    </tr>`;
  }).join('');
}

async function refundPayment(paymentId, stripePaymentIntentId, amount) {
  if (!confirm(`Refund $${parseFloat(amount).toFixed(2)} NZD? This will be processed via Stripe immediately.`)) return;

  try {
    await callAPI(`admin/payments/${paymentId}/refund`, {
      stripePaymentIntentId,
      amount: Math.round(amount * 100),
    });
    alert('✅ Refund processed successfully.');
    await loadPayments();
  } catch (err) {
    alert('Refund failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
async function loadCustomers() {
  const tbody = document.getElementById('customers-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  try {
    allCustomers = await callAPI('admin/customers?limit=5000', null, 'GET');
  } catch (err) { console.error(err); return; }
  renderCustomersTable(allCustomers);
}

function renderCustomersTable(customers) {
  const tbody = document.getElementById('customers-tbody');
  if (!tbody) return;

  const countEl = document.getElementById('customers-count');
  if (countEl) countEl.textContent = customers && customers.length ? `(${customers.length})` : '';

  if (!customers || customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">No customers found.</td></tr>';
    return;
  }

  tbody.innerHTML = customers.map(c => {
    const nonCancelled = (c.bookings || []).filter(b => b.status !== 'cancelled');
    const totalSpent = nonCancelled.reduce((s, b) => s + parseFloat(b.totalAmount || 0), 0);
    const name = escapeHtml(`${c.firstName || ''} ${c.lastName || ''}`.trim()) || '—';
    const isAdmin = c.isAdmin;
    const isSelf = c.id === (auth.currentUser && auth.currentUser.uid);
    let adminCell;
    if (isSelf) {
      adminCell = '<span class="text-xs px-3 py-1 rounded-lg font-semibold bg-indigo-100 text-indigo-700">✅ You</span>';
    } else if (isAdmin) {
      adminCell = '<button onclick="toggleAdmin(\'' + c.id + '\', true)" class="text-xs px-3 py-1 rounded-lg font-semibold transition-all bg-indigo-100 text-indigo-700 hover:bg-red-100 hover:text-red-600">✅ Admin</button>';
    } else {
      adminCell = '<button onclick="toggleAdmin(\'' + c.id + '\', false)" class="text-xs px-3 py-1 rounded-lg font-semibold transition-all bg-gray-100 text-gray-500 hover:bg-indigo-100 hover:text-indigo-700">Make Admin</button>';
    }
    const bookingCount = nonCancelled.length;
    const checkboxCell = (isAdmin || isSelf)
      ? '<td data-label="Select"></td>'
      : `<td data-label="Select"><input type="checkbox" class="customer-checkbox cursor-pointer" data-id="${c.id}" onchange="updateDeleteBtn()"></td>`;
    return `<tr>
      ${checkboxCell}
      <td data-label="Name" class="font-semibold text-sm">${name}</td>
      <td data-label="Email" class="text-sm">${escapeHtml(c.email) || '—'}</td>
      <td data-label="Number" class="text-sm">${escapeHtml(c.phone) || '—'}</td>
      <td data-label="Bookings" class="text-sm">${bookingCount} ${bookingCount === 1 ? 'party' : 'parties'}</td>
      <td data-label="Price Paid" class="font-semibold">$${totalSpent.toFixed(2)}</td>
      <td data-label="Admin">${adminCell}</td>
    </tr>`;
  }).join('');
  updateDeleteBtn();
}

function updateDeleteBtn() {
  const checked = document.querySelectorAll('.customer-checkbox:checked');
  const btn = document.getElementById('delete-customers-btn');
  if (!btn) return;
  if (checked.length > 0) {
    btn.classList.remove('hidden');
    btn.textContent = `🗑️ Delete Selected (${checked.length})`;
  } else {
    btn.classList.add('hidden');
  }
  const selectAll = document.getElementById('customers-select-all');
  if (selectAll) {
    const all = document.querySelectorAll('.customer-checkbox');
    selectAll.checked = all.length > 0 && checked.length === all.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  }
}

function toggleSelectAllCustomers(checked) {
  document.querySelectorAll('.customer-checkbox').forEach(cb => { cb.checked = checked; });
  updateDeleteBtn();
}

async function deleteSelectedCustomers() {
  const checked = [...document.querySelectorAll('.customer-checkbox:checked')];
  if (!checked.length) return;
  const ids = checked.map(cb => cb.dataset.id);
  if (!confirm(`Permanently delete ${ids.length} customer record${ids.length === 1 ? '' : 's'}? This cannot be undone.\n\nCustomers with existing bookings will be skipped, since their booking history must be preserved.`)) return;
  try {
    const { deleted, skipped } = await callAPI('admin/customers/bulk-delete', { ids });
    let msg = `✅ Deleted ${deleted} customer${deleted === 1 ? '' : 's'}.`;
    if (skipped) msg += `\n⚠️ Skipped ${skipped} customer${skipped === 1 ? '' : 's'} with existing bookings.`;
    alert(msg);
    await loadCustomers();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function toggleAdmin(userId, currentlyAdmin) {
  const email = allCustomers.find(c => c.id === userId)?.email || 'this user';
  const action = currentlyAdmin ? 'remove admin from' : 'make admin';
  const confirmed = confirm(`⚠️ Are you sure you want to ${action} ${email}?\n\nThis will ${currentlyAdmin ? 'revoke their access to the admin dashboard.' : 'give them FULL access to the admin dashboard.'}`);
  if (!confirmed) return;

  try {
    await callAPI('admin/users/' + userId + '/set-admin', { isAdmin: !currentlyAdmin });
    allCustomers = allCustomers.map(c => c.id === userId ? { ...c, isAdmin: !currentlyAdmin } : c);
    renderCustomersTable(allCustomers);
  } catch (err) {
    alert('Failed to update admin status: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const BOOKING_SLOT_ORDER = {'9:30 AM': 1, '11:30 AM': 2, '1:30 PM': 3, '3:30 PM': 4, '5:30 PM': 5, '5:30 PM – 8:30 PM': 5};

function getBookingsSorted(bookings) {
  const order = document.getElementById('bookingsSortOrder')?.value || 'party_date_asc';
  return [...bookings].sort((a, b) => {
    if (order === 'party_date_asc' || order === 'party_date_desc') {
      const dateA = a.partyDate || '', dateB = b.partyDate || '';
      if (dateA !== dateB) {
        const cmp = dateA < dateB ? -1 : 1;
        return order === 'party_date_asc' ? cmp : -cmp;
      }
      return (BOOKING_SLOT_ORDER[a.partyTime] || 9) - (BOOKING_SLOT_ORDER[b.partyTime] || 9);
    }
    if (order === 'created_desc')    return (a.createdAt || '') > (b.createdAt || '') ? -1 : 1;
    if (order === 'created_asc')     return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
    return 0;
  });
}

function applyBookingsSort() {
  bookingsTabState[bookingsSubTab].sortOrder = document.getElementById('bookingsSortOrder')?.value || bookingsTabState[bookingsSubTab].sortOrder;
  renderCurrentBookingsSubTab();
}

function applyBookingsStatusFilter() {
  bookingsTabState[bookingsSubTab].statusFilter = document.getElementById('bookingStatusFilter')?.value || '';
  renderCurrentBookingsSubTab();
}

function handleSearch(query) {
  const q = query.toLowerCase();
  if (currentTab === 'bookings') {
    // Route global search bar to the bookings panel search input so both stay in sync
    const bsEl = document.getElementById('bookingsSearchInput');
    if (bsEl) bsEl.value = query;
    renderCurrentBookingsSubTab();
  }
  if (currentTab === 'customers') {
    renderCustomersTable(allCustomers.filter(c =>
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase().includes(q)
    ));
  }
  if (currentTab === 'payments') {
    const subtabPayments = allPayments.filter(p =>
      paymentsSubTab === 'manual' ? p.paymentMethod === 'manual' : p.paymentMethod !== 'manual'
    );
    renderPaymentsTable(subtabPayments.filter(p =>
      (p.bookingRef || '').toLowerCase().includes(q) ||
      (p.contactEmail || '').toLowerCase().includes(q) ||
      (p.cardholderName || '').toLowerCase().includes(q)
    ));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]} ${y}`;
}

const ROOM_DISPLAY_NAMES = {
  'The Big Room':       'Big Room',
  'Sunshine Room':      'Yellow Room',
  'Dream Room':         'Purple Room',
  'Wonder Forest Room': 'Green Room',
};
function roomDisplayName(name) { return ROOM_DISPLAY_NAMES[name] || name || '—'; }

function statusBadgeClass(status) {
  return status === 'confirmed' ? 'badge-green'
       : status === 'cancelled' ? 'badge-red'
       : status === 'pending'   ? 'badge-yellow'
       : 'badge-gray';
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

async function adminSignOut() {
  await auth.signOut();
  window.location.href = '/';
}

// ---------------------------------------------------------------------------
// Add Booking Modal
// ---------------------------------------------------------------------------
// Mirrors the customer-facing ROOMS array in booking.js
const AB_ROOMS = [
  { id: 'big',      name: 'The Big Room',      emoji: '🌟', minGuests: 12, maxGuests: 24, pricePerChild: 39, image: 'images/rooms/big.jpg' },
  { id: 'sunshine', name: 'Sunshine Room',     emoji: '☀️', minGuests: 8,  maxGuests: 15, pricePerChild: 39, image: 'images/rooms/sunshine.jpg' },
  { id: 'dream',    name: 'Dream Room',        emoji: '🌙', minGuests: 8,  maxGuests: 15, pricePerChild: 39, image: 'images/rooms/dream.jpg' },
  { id: 'forest',   name: 'Wonder Forest Room',emoji: '🌿', minGuests: 8,  maxGuests: 15, pricePerChild: 39, image: 'images/rooms/forest.jpg' },
  { id: 'whole-venue', name: 'Whole Venue Hire', emoji: '🏛️', minGuests: 1, maxGuests: 300,
    pricingModel: 'flat', flatPrice: 2899, allowedDaysOfWeek: [0, 1, 2] }, // Sun/Mon/Tue
];

// '5:30 PM' mirrors the customer-facing evening slot (Fri/Sat only, ordinary
// rooms). Whole-venue hire has its own single slot, kept in a separate list
// with a distinct label (5:30-8:30 PM vs the ordinary rooms' 5:30-7:00 PM)
// so the two are never conflated in the booking list.
const AB_ALL_SLOTS = ['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM', '5:30 PM'];
const AB_SLOT_END_TIMES = {
  '9:30 AM':  '11:00 AM',
  '11:30 AM': '1:00 PM',
  '1:30 PM':  '3:00 PM',
  '3:30 PM':  '5:00 PM',
  '5:30 PM':  '7:00 PM',
};
const AB_RESTRICTED_SLOT_DAYS = { '5:30 PM': [5, 6] }; // Friday & Saturday
const AB_WHOLE_VENUE_SLOTS = ['5:30 PM – 8:30 PM'];
const AB_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function abDescribeDays(days) { return days.map(d => AB_DAY_NAMES[d]).join('/'); }
function abDayOfWeekFromDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

// Mirrors the customer-facing ADDON_PRICES in booking.js
const AB_ADDON_PRICES = {
  pizza_11:        { label: '11-inch Pizza',                  price: 25 },
  platter_chicken: { label: 'Fried Chicken Platter',           price: 39 },
  platter_seafood: { label: 'Seafood Platter',                 price: 49 },
  adult_sandwich:  { label: 'Adult Sandwich Platter',          price: 60 },
  sushi_40:        { label: 'Sushi Platter (40 pcs)',          price: 60 },
  sushi_24:        { label: 'Sushi Platter (24 pcs)',          price: 30 },
  sushi_salmon:    { label: 'Salmon Supreme Platter',          price: 28.90 },
  sushi_ocean:     { label: 'Ocean Deluxe Set',                price: 39.90 },
  sushi_kids48:    { label: 'Kids Party Platter (48 pcs)',     price: 49.90 },
  sushi_garden28:  { label: 'Green Garden Platter (28 pcs)',   price: 42.90 },
  drinks_soda:     { label: 'Soft Drink (per bottle)',         price: 10 },
  nuggets_15pc:    { label: 'Chicken Nuggets (15pc)',          price: 20 },
  fries_large:     { label: 'Large Fries',                     price: 20 },
  gf_nuggets:      { label: 'Gluten-Free Nuggets',             price: 5 },
};

// Local state for the manual booking modal
let abState = {
  guests: 10,
  selectedRoomId: null,
  selectedRoomDbId: null,
  selectedDate: null,
  selectedTime: null,
  addons: {},
  sodaTypes: {},
  pizzaTypes: {},
};

function openAddBookingModal() {
  abState = { guests: 10, selectedRoomId: null, selectedRoomDbId: null, selectedDate: null, selectedTime: null, addons: {}, sodaTypes: {}, pizzaTypes: {} };

  const today = nzDateStr();
  document.getElementById('ab_date').min = today;
  document.getElementById('ab_date').value = '';
  document.getElementById('ab_guests').value = 10;
  document.getElementById('ab_notes').value = '';
  document.getElementById('ab_adminNotes').value = '';
  document.getElementById('ab_nuggetCount').value = '0';
  document.getElementById('ab_burgerCount').value = '0';
  document.getElementById('ab_vegeCount').value = '0';
  document.getElementById('ab_foodSplitTotal').textContent = '0 / 10 selected';
  document.getElementById('ab_foodTarget').textContent = '10';
  document.getElementById('ab_amountPaid').value = '';
  document.getElementById('ab_balanceDue').classList.add('hidden');
  document.getElementById('ab_status').value = 'confirmed';
  document.getElementById('ab_timeSlotGrid').innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">Select a room and date first</div>';
  document.getElementById('ab_orderSummary').innerHTML = '<div class="text-indigo-400">Select a room and guests to see pricing</div>';
  document.querySelectorAll('input[name="ab_cateringChoice"]').forEach(el => { el.checked = false; });
  const abAlcoholEl = document.getElementById('ab_noAlcoholAck');
  if (abAlcoholEl) abAlcoholEl.checked = false;

  abRenderRoomCards();
  abRenderStep3ForRoom();
  abRenderAddonsList();
  document.getElementById('addBookingModal').style.display = 'flex';
  document.getElementById('addBookingError').classList.add('hidden');
}

function closeAddBookingModal() {
  document.getElementById('addBookingModal').style.display = 'none';
}

function abOnGuestsChange() {
  const selectedRoom = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  const minG = selectedRoom ? selectedRoom.minGuests : 1;
  const maxG = selectedRoom ? selectedRoom.maxGuests : 24;
  abState.guests = Math.max(minG, Math.min(maxG, parseInt(document.getElementById('ab_guests').value) || minG));
  document.getElementById('ab_guests').value = abState.guests;
  document.getElementById('ab_foodTarget').textContent = abState.guests;
  abRenderRoomCards();
  document.getElementById('ab_nuggetCount').value = '0';
  document.getElementById('ab_burgerCount').value = '0';
  document.getElementById('ab_vegeCount').value = '0';
  document.getElementById('ab_foodSplitTotal').textContent = `0 / ${abState.guests} selected`;
  abUpdateOrderSummary();
}

function abRenderRoomCards() {
  const container = document.getElementById('ab_roomCards');
  if (!container) return;

  const eligible = AB_ROOMS.filter(r => abState.guests >= r.minGuests && abState.guests <= r.maxGuests);
  const ineligible = AB_ROOMS.filter(r => abState.guests < r.minGuests || abState.guests > r.maxGuests);

  let html = '';
  eligible.forEach(r => { html += abBuildRoomCard(r, false); });
  if (ineligible.length > 0) {
    html += `<div class="text-xs text-gray-400 font-semibold pt-2">OTHER ROOMS (outside guest count)</div>`;
    ineligible.forEach(r => { html += abBuildRoomCard(r, true); });
  }
  container.innerHTML = html;

  // If previously selected room is no longer eligible, clear it
  if (abState.selectedRoomId && !eligible.find(r => r.id === abState.selectedRoomId)) {
    abState.selectedRoomId = null;
    abState.selectedRoomDbId = null;
  }
}

function abBuildRoomCard(room, dimmed) {
  const selected = abState.selectedRoomId === room.id;
  const dimClass = dimmed ? 'opacity-50 pointer-events-none' : '';
  const selClass = selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white ab-card';
  const thumb = room.image ? `
    <img src="${room.image}" alt="${room.name} party room" loading="lazy"
      class="w-12 h-12 rounded-lg object-cover flex-shrink-0 cursor-zoom-in" style="object-position:center 35%;"
      onclick="event.stopPropagation(); openRoomPhoto('${room.image}', '${room.name.replace(/'/g, "\\'")}')" />` : '';
  return `
    <div class="border-2 ${selClass} ${dimClass} rounded-xl p-3 cursor-pointer transition-all" onclick="abSelectRoom('${room.id}')">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xl">${room.emoji}</span>
          <div class="min-w-0">
            <div class="font-semibold text-sm truncate">${roomDisplayName(room.name)}</div>
            <div class="text-xs text-gray-400">${room.minGuests}–${room.maxGuests} kids</div>
          </div>
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <div class="text-sm font-bold text-indigo-600">${room.pricingModel === 'flat' ? `$${room.flatPrice.toLocaleString()} flat` : `$${room.pricePerChild}/child`}</div>
          ${thumb}
        </div>
      </div>
    </div>`;
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

async function abSelectRoom(roomId) {
  abState.selectedRoomId = roomId;

  // Clamp guest count to this room's limits
  const room = AB_ROOMS.find(r => r.id === roomId);
  if (room) {
    const guestEl = document.getElementById('ab_guests');
    guestEl.min = room.minGuests;
    guestEl.max = room.maxGuests;
    if (abState.guests < room.minGuests || abState.guests > room.maxGuests) {
      abState.guests = Math.min(Math.max(abState.guests, room.minGuests), room.maxGuests);
      guestEl.value = abState.guests;
      document.getElementById('ab_foodTarget').textContent = abState.guests;
      document.getElementById('ab_nuggetCount').value = '0';
      document.getElementById('ab_burgerCount').value = '0';
      document.getElementById('ab_vegeCount').value = '0';
      document.getElementById('ab_foodSplitTotal').textContent = `0 / ${abState.guests} selected`;
    }
  }

  abRenderRoomCards();
  abRenderStep3ForRoom();

  try {
    const roomRow = await callAPI(`rooms/by-slug/${roomId}`, null, 'GET');
    abState.selectedRoomDbId = roomRow?.id || null;
  } catch {
    abState.selectedRoomDbId = null;
  }

  // Re-fetch slots if a date is already chosen
  const dateVal = document.getElementById('ab_date').value;
  if (dateVal) await abUpdateTimeSlots();
  abUpdateOrderSummary();
}

// Swaps the manual-booking modal between the ordinary per-child food/add-ons
// section and whole-venue hire's catering choice + no-alcohol ack — mirrors
// renderStep3ForRoom() in booking.js for the customer-facing wizard.
function abRenderStep3ForRoom() {
  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  const isWholeVenue = room?.pricingModel === 'flat';
  const foodSection = document.getElementById('ab_foodAddonsSection');
  const cateringSection = document.getElementById('ab_wholeVenueCateringSection');
  if (!foodSection || !cateringSection) return;
  foodSection.classList.toggle('hidden', isWholeVenue);
  cateringSection.classList.toggle('hidden', !isWholeVenue);

  if (isWholeVenue) {
    abOnCateringChoiceChange();
  } else {
    abPlaceAddonsBlock(false);
  }
}

// Tracks the admin Add-Ons card's original spot so it can be moved back after
// being relocated into ab_wholeVenueMenuSlot — mirrors booking.js's
// addonsHomeParent/placeAddonsBlock for the customer wizard. #ab_addonsCard
// otherwise lives inside #ab_foodAddonsSection, which is hidden wholesale for
// whole-venue bookings — without relocating it out, there is no menu picker
// shown at all when "Venue menu" catering is chosen.
let abAddonsHomeParent = null;
let abAddonsHomeNextSibling = null;

function abPlaceAddonsBlock(showAsMenu) {
  const card = document.getElementById('ab_addonsCard');
  if (!card) return;
  if (!abAddonsHomeParent) {
    abAddonsHomeParent = card.parentNode;
    abAddonsHomeNextSibling = card.nextSibling;
  }

  const icon = document.getElementById('ab_addonsHeadingIcon');
  const label = document.getElementById('ab_addonsHeadingLabel');
  const suffix = document.getElementById('ab_addonsHeadingSuffix');

  if (showAsMenu === null) {
    card.classList.add('hidden');
    return;
  }

  if (showAsMenu) {
    const slot = document.getElementById('ab_wholeVenueMenuSlot');
    if (slot && card.parentNode !== slot) slot.appendChild(card);
    if (icon) icon.textContent = '🍽️';
    if (label) label.textContent = 'Menu';
    if (suffix) suffix.textContent = '';
  } else {
    if (abAddonsHomeParent && card.parentNode !== abAddonsHomeParent) {
      abAddonsHomeParent.insertBefore(card, abAddonsHomeNextSibling);
    }
    if (icon) icon.textContent = '➕';
    if (label) label.textContent = 'Add-Ons';
    if (suffix) suffix.textContent = '(optional)';
  }
  card.classList.remove('hidden');
}

function abOnCateringChoiceChange() {
  const checked = document.querySelector('input[name="ab_cateringChoice"]:checked');
  const note = document.getElementById('ab_cateringChoiceNote');
  if (!note) return;
  if (!checked) {
    note.classList.add('hidden');
    abPlaceAddonsBlock(null);
    return;
  }
  note.classList.remove('hidden');
  note.innerHTML = checked.value === 'venue_menu'
    ? '🍽️ No outside food or drink is permitted — birthday cake is always the exception. Choose items from the menu below.'
    : '🍽️ Customer is bringing their own food & drink — birthday cake and everything else is up to them.';
  abPlaceAddonsBlock(checked.value === 'venue_menu' ? true : null);
}

async function abUpdateTimeSlots() {
  const dateVal = document.getElementById('ab_date').value;
  abState.selectedDate = dateVal;
  abState.selectedTime = null;

  const grid = document.getElementById('ab_timeSlotGrid');
  if (!dateVal) {
    grid.innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">Select a date</div>';
    return;
  }
  if (!abState.selectedRoomDbId) {
    grid.innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">Select a room first</div>';
    return;
  }

  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  const dow = abDayOfWeekFromDateStr(dateVal);

  if (Array.isArray(room?.allowedDaysOfWeek) && !room.allowedDaysOfWeek.includes(dow)) {
    grid.innerHTML = `<div class="col-span-2 py-4 text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3">${room.name} is only available on ${abDescribeDays(room.allowedDaysOfWeek)}.</div>`;
    return;
  }

  grid.innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">Checking availability...</div>';

  let unavailable = [];
  try {
    const result = await callAPI(`slots?room_id=${abState.selectedRoomDbId}&date=${dateVal}`, null, 'GET');
    unavailable = result.unavailableSlots || [];
  } catch { /* show all as available on error */ }

  const slots = room?.pricingModel === 'flat' ? AB_WHOLE_VENUE_SLOTS : AB_ALL_SLOTS;

  let html = '';
  slots.forEach(slot => {
    const restrictedDays = AB_RESTRICTED_SLOT_DAYS[slot];
    const dayRestricted = restrictedDays && !restrictedDays.includes(dow);
    const isUnavailable = !dayRestricted && unavailable.includes(slot);
    const selected = abState.selectedTime === slot;
    const disabled = isUnavailable || dayRestricted;
    const cls = disabled
      ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
      : selected
        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 cursor-pointer'
        : 'border-gray-200 bg-white ab-card hover:border-indigo-300 cursor-pointer';
    const badge = dayRestricted ? `${abDescribeDays(restrictedDays)} only` : isUnavailable ? 'Full' : '';
    html += `
      <div class="border-2 ${cls} rounded-xl p-2.5 text-center transition-all" ${disabled ? '' : `onclick="abSelectTime('${slot}', this)"`}>
        <div class="font-semibold text-sm">${slot}</div>
        ${AB_SLOT_END_TIMES[slot] ? `<div class="text-xs opacity-70">– ${AB_SLOT_END_TIMES[slot]}</div>` : ''}
        ${badge ? `<div class="text-xs font-semibold mt-0.5">${badge}</div>` : ''}
      </div>`;
  });
  grid.innerHTML = html;
}

function abSelectTime(slot, el) {
  abState.selectedTime = slot;
  document.querySelectorAll('#ab_timeSlotGrid > div').forEach(c => {
    c.classList.remove('border-indigo-500', 'bg-indigo-50', 'text-indigo-700');
    c.classList.add('border-gray-200', 'bg-white', 'ab-card');
  });
  el.classList.remove('border-gray-200', 'bg-white');
  el.classList.add('border-indigo-500', 'bg-indigo-50', 'text-indigo-700');
}

function abOnFoodInput() {
  const total = abState.guests;
  const nuggets = Math.max(0, parseInt(document.getElementById('ab_nuggetCount').value) || 0);
  const burgers = Math.max(0, parseInt(document.getElementById('ab_burgerCount').value) || 0);
  const veges   = Math.max(0, parseInt(document.getElementById('ab_vegeCount').value) || 0);
  document.getElementById('ab_foodSplitTotal').textContent = `${nuggets + burgers + veges} / ${total} selected`;
  abUpdateOrderSummary();
}

// ── Shared type-picker helpers (used by both ab_ and eb_ forms) ──────────────

const TYPE_PICKER_IDS = new Set(['drinks_soda', 'pizza_11']);

function getAddonTypeMap(addonId) {
  if (addonId === 'drinks_soda')    return { 'Coke': 'Coke', 'Sprite': 'Sprite', 'Fanta': 'Fanta', 'L&P': 'LandP' };
  if (addonId === 'pizza_11')       return { 'Ham & Cheese': 'HamCheese', 'Salami & Cheese': 'SalamiCheese', 'Chorizo & Cheese': 'ChorizoCheese', 'Plain Cheese': 'PlainCheese', 'Vege Pizza': 'VegePizza' };
  return {};
}

function getAddonTypeStateKey(addonId) {
  if (addonId === 'drinks_soda')   return 'sodaTypes';
  if (addonId === 'pizza_11')      return 'pizzaTypes';
  return null;
}

function buildAdminTypePickerHtml(prefix, addonId, currentQty, addonState) {
  const stateKey = getAddonTypeStateKey(addonId);
  const types = addonState[stateKey] || {};
  const total = Object.values(types).reduce((s, v) => s + v, 0);
  const atMax = total >= currentQty;
  const hiddenClass = currentQty === 0 ? ' hidden' : '';
  let rows = '';
  Object.entries(getAddonTypeMap(addonId)).forEach(([type, elemId]) => {
    const jsType = type.replace(/&/g, '&amp;');
    const typeQty = types[type] || 0;
    const plusDisabled = atMax ? ' opacity-30 pointer-events-none' : '';
    rows += `<div class="flex items-center justify-between">
                    <span class="text-xs text-gray-600">${jsType}</span>
                    <div class="flex items-center gap-1">
                      <button type="button" onclick="${prefix}ChangeType('${addonId}','${jsType}',-1)" class="w-5 h-5 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center">−</button>
                      <span class="w-4 text-center text-xs font-bold" id="${prefix}_typeQty_${addonId}_${elemId}">${typeQty}</span>
                      <button type="button" onclick="${prefix}ChangeType('${addonId}','${jsType}',1)" id="${prefix}_typePlus_${addonId}_${elemId}" class="w-5 h-5 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400 flex items-center justify-center${plusDisabled}">+</button>
                    </div>
                  </div>`;
  });
  return `<div id="${prefix}_typePicker_${addonId}" class="mt-2 pt-2 border-t border-gray-200${hiddenClass}">
                <div class="flex items-center justify-between mb-1.5">
                  <div class="text-xs text-gray-500 font-semibold">Which type(s)?</div>
                  <div id="${prefix}_typeCounter_${addonId}" class="text-xs font-bold text-indigo-600">${total} / ${currentQty} allocated</div>
                </div>
                <div class="space-y-1">${rows}</div>
              </div>`;
}

function adminUpdateTypePickerUI(prefix, addonId, addonState) {
  const stateKey = getAddonTypeStateKey(addonId);
  if (!addonState[stateKey]) addonState[stateKey] = {};
  const addonQty = addonState.addons?.[addonId] || 0;
  const total = Object.values(addonState[stateKey]).reduce((s, v) => s + v, 0);
  const atMax = total >= addonQty;
  Object.entries(getAddonTypeMap(addonId)).forEach(([type, elemId]) => {
    const qtyEl = document.getElementById(`${prefix}_typeQty_${addonId}_${elemId}`);
    if (qtyEl) qtyEl.textContent = addonState[stateKey][type] || 0;
    const plusEl = document.getElementById(`${prefix}_typePlus_${addonId}_${elemId}`);
    if (plusEl) {
      plusEl.classList.toggle('opacity-30', atMax);
      plusEl.classList.toggle('pointer-events-none', atMax);
    }
  });
  const counter = document.getElementById(`${prefix}_typeCounter_${addonId}`);
  if (counter) counter.textContent = `${total} / ${addonQty} allocated`;
}

function adminTrimTypeState(addonId, newQty, addonState) {
  const stateKey = getAddonTypeStateKey(addonId);
  if (!stateKey) return;
  if (newQty === 0) { addonState[stateKey] = {}; return; }
  if (!addonState[stateKey]) return;
  let excess = Object.values(addonState[stateKey]).reduce((s, v) => s + v, 0) - newQty;
  const keys = Object.keys(addonState[stateKey]);
  for (let i = keys.length - 1; i >= 0 && excess > 0; i--) {
    const cut = Math.min(addonState[stateKey][keys[i]], excess);
    addonState[stateKey][keys[i]] -= cut;
    excess -= cut;
    if (addonState[stateKey][keys[i]] === 0) delete addonState[stateKey][keys[i]];
  }
}

function getAddonLabelWithTypes(id, addonState) {
  const a = AB_ADDON_PRICES[id];
  const stateKey = getAddonTypeStateKey(id);
  if (!stateKey || !addonState[stateKey] || !Object.keys(addonState[stateKey]).length) return a.label;
  const parts = Object.entries(addonState[stateKey]).filter(([,n]) => n > 0).map(([t,n]) => n > 1 ? `${t} x${n}` : t);
  if (id === 'drinks_soda')    return `Soft Drink (${parts.join(', ')})`;
  if (id === 'pizza_11')       return `11-inch Pizza (${parts.join(', ')})`;
  return a.label;
}

function abUpdateTypePickerUI(addonId) { adminUpdateTypePickerUI('ab', addonId, abState); }
function ebUpdateTypePickerUI(addonId) { adminUpdateTypePickerUI('eb', addonId, editBookingState); }

function abChangeType(addonId, type, delta) {
  const stateKey = getAddonTypeStateKey(addonId);
  if (!abState[stateKey]) abState[stateKey] = {};
  const addonQty = abState.addons?.[addonId] || 0;
  const total = Object.values(abState[stateKey]).reduce((s, v) => s + v, 0);
  if (delta > 0 && total >= addonQty) return;
  const next = Math.max(0, (abState[stateKey][type] || 0) + delta);
  if (next === 0) delete abState[stateKey][type]; else abState[stateKey][type] = next;
  abUpdateTypePickerUI(addonId);
  abUpdateOrderSummary();
}

function ebChangeType(addonId, type, delta) {
  const stateKey = getAddonTypeStateKey(addonId);
  if (!editBookingState[stateKey]) editBookingState[stateKey] = {};
  const addonQty = editBookingState.addons?.[addonId] || 0;
  const total = Object.values(editBookingState[stateKey]).reduce((s, v) => s + v, 0);
  if (delta > 0 && total >= addonQty) return;
  const next = Math.max(0, (editBookingState[stateKey][type] || 0) + delta);
  if (next === 0) delete editBookingState[stateKey][type]; else editBookingState[stateKey][type] = next;
  ebUpdateTypePickerUI(addonId);
  ebUpdateOrderSummary();
}

// ── Add-booking addon list ────────────────────────────────────────────────────

function abRenderAddonsList() {
  const container = document.getElementById('ab_addonsList');
  if (!container) return;
  let html = '';
  Object.entries(AB_ADDON_PRICES).forEach(([id, a]) => {
    const qty = abState.addons[id] || 0;
    const typePicker = TYPE_PICKER_IDS.has(id) ? buildAdminTypePickerHtml('ab', id, qty, abState) : '';
    html += `
      <div class="bg-white ab-card rounded-lg p-2.5 border border-gray-100">
        <div class="flex items-center justify-between">
          <div class="flex-1 min-w-0">
            <div class="text-xs font-semibold text-gray-700">${a.label}</div>
            <span class="bg-green-100 text-green-700 font-bold text-xs rounded-full px-2 py-0.5">$${a.price.toFixed(2)}</span>
          </div>
          <div class="flex items-center gap-1">
            <button onclick="abChangeAddon('${id}', -1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400">−</button>
            <span class="w-5 text-center text-xs font-bold" id="ab_addon_${id}">${qty}</span>
            <button onclick="abChangeAddon('${id}', 1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400">+</button>
          </div>
        </div>${typePicker}
      </div>`;
  });
  container.innerHTML = html;
}

function abChangeAddon(id, delta) {
  const current = abState.addons[id] || 0;
  const next = Math.max(0, current + delta);
  abState.addons[id] = next;
  document.getElementById('ab_addon_' + id).textContent = next;
  if (TYPE_PICKER_IDS.has(id)) {
    const picker = document.getElementById('ab_typePicker_' + id);
    if (picker) picker.classList.toggle('hidden', next === 0);
    adminTrimTypeState(id, next, abState);
    abUpdateTypePickerUI(id);
  }
  abUpdateOrderSummary();
}

function abGetAddonTotal() {
  return Object.entries(abState.addons).reduce((sum, [id, qty]) => sum + (AB_ADDON_PRICES[id]?.price || 0) * qty, 0);
}

function abUpdateOrderSummary() {
  const summaryEl = document.getElementById('ab_orderSummary');
  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  if (!room) {
    summaryEl.innerHTML = '<div class="text-indigo-400">Select a room and guests to see pricing</div>';
    return;
  }
  const isFlat = room.pricingModel === 'flat';
  const baseTotal = isFlat ? room.flatPrice : room.pricePerChild * abState.guests;
  const addonTotal = isFlat ? 0 : abGetAddonTotal();
  const total = baseTotal + addonTotal;

  const addonLines = isFlat ? '' : Object.entries(abState.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => `<div class="flex justify-between"><span>+ ${getAddonLabelWithTypes(id, abState)} ×${qty}</span><span class="font-semibold">$${(AB_ADDON_PRICES[id].price * qty).toFixed(2)}</span></div>`)
    .join('');

  const rateLine = isFlat
    ? `<div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${baseTotal.toLocaleString()} flat (venue rental only)</span></div>`
    : `<div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${room.pricePerChild}/child × ${abState.guests} = $${baseTotal.toFixed(2)}</span></div>`;

  summaryEl.innerHTML = `
    <div class="flex justify-between"><span>Room:</span><span class="font-semibold">${room.name}</span></div>
    ${rateLine}
    ${addonLines}
    <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
      <span>Total:</span><span class="text-indigo-600">$${total.toFixed(2)} NZD</span>
    </div>`;
  abUpdateBalanceDue();
}

function abUpdateBalanceDue() {
  const total = abGetCalculatedTotal();
  const paid = parseFloat(document.getElementById('ab_amountPaid').value);
  const el = document.getElementById('ab_balanceDue');
  if (!isNaN(paid) && paid < total - 0.005) {
    const balance = total - paid;
    el.textContent = `⚠️ Balance due on the day: $${balance.toFixed(2)} NZD`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function abGetCalculatedTotal() {
  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  if (!room) return 0;
  if (room.pricingModel === 'flat') return room.flatPrice;
  return (room.pricePerChild * abState.guests) + abGetAddonTotal();
}

async function submitAddBooking() {
  const btn = document.getElementById('addBookingBtn');
  const btnText = document.getElementById('addBookingBtnText');
  const spinner = document.getElementById('addBookingBtnSpinner');
  const errEl = document.getElementById('addBookingError');

  const firstName = document.getElementById('ab_firstName').value.trim();
  const lastName  = document.getElementById('ab_lastName').value.trim();
  const email     = document.getElementById('ab_email').value.trim().toLowerCase();
  const phone     = document.getElementById('ab_phone').value.trim();
  const date      = abState.selectedDate;
  const time      = abState.selectedTime;
  const guests    = abState.guests;
  const notes  = document.getElementById('ab_notes').value.trim();
  const adminNotes = document.getElementById('ab_adminNotes').value.trim();
  const status = document.getElementById('ab_status').value;

  const nuggets = parseInt(document.getElementById('ab_nuggetCount').value) || 0;
  const burgers = parseInt(document.getElementById('ab_burgerCount').value) || 0;
  const veges   = parseInt(document.getElementById('ab_vegeCount').value) || 0;

  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  const isFlat = room?.pricingModel === 'flat';

  // Validate
  // (First name/email are allowed blank here for phone bookings taken
  // without full details yet — the server defaults them to "ADMIN" /
  // admin@wonderworldwestgate.co.nz so they never save as blank/null.)
  if (!abState.selectedRoomId) { errEl.textContent = 'Please select a party room.'; errEl.classList.remove('hidden'); return; }
  if (!date)   { errEl.textContent = 'Party date is required.';  errEl.classList.remove('hidden'); return; }
  if (!time)   { errEl.textContent = 'Please select a time slot.'; errEl.classList.remove('hidden'); return; }

  let cateringChoice = null;
  let noAlcoholAck = false;
  if (isFlat) {
    const cateringEl = document.querySelector('input[name="ab_cateringChoice"]:checked');
    if (!cateringEl) { errEl.textContent = 'Please choose a catering option.'; errEl.classList.remove('hidden'); return; }
    cateringChoice = cateringEl.value;
    const alcoholEl = document.getElementById('ab_noAlcoholAck');
    if (!alcoholEl?.checked) { errEl.textContent = 'Please acknowledge the no-alcohol policy.'; errEl.classList.remove('hidden'); return; }
    noAlcoholAck = true;
  } else if (nuggets + burgers + veges !== guests) {
    errEl.textContent = `Food selection must add up to ${guests} kids. Currently ${nuggets + burgers + veges} selected.`;
    errEl.classList.remove('hidden');
    return;
  }

  // Pizza / soda / nuggets type validation
  const pizzaQty = isFlat ? 0 : abState.addons['pizza_11'] || 0;
  if (pizzaQty > 0) {
    const picked = Object.values(abState.pizzaTypes || {}).reduce((s, v) => s + v, 0);
    if (picked < pizzaQty) {
      errEl.textContent = `Please choose a type for all ${pizzaQty} pizza(s) before saving.`;
      errEl.classList.remove('hidden');
      document.getElementById('ab_typePicker_pizza_11')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
  }
  const sodaQty = isFlat ? 0 : abState.addons['drinks_soda'] || 0;
  if (sodaQty > 0) {
    const picked = Object.values(abState.sodaTypes || {}).reduce((s, v) => s + v, 0);
    if (picked < sodaQty) {
      errEl.textContent = `Please choose a flavour for all ${sodaQty} soft drink(s) before saving.`;
      errEl.classList.remove('hidden');
      document.getElementById('ab_typePicker_drinks_soda')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
  }

  const foodChoice = isFlat ? null : buildFoodChoiceString(nuggets, burgers, veges);
  const addonLines = isFlat ? [] : Object.entries(abState.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => `${getAddonLabelWithTypes(id, abState)} ×${qty} ($${(AB_ADDON_PRICES[id].price * qty).toFixed(2)})`);
  const addonsSummary = addonLines.join(', ');
  const addonsAmount = isFlat ? 0 : abGetAddonTotal();
  const baseAmount = isFlat ? room.flatPrice : room.pricePerChild * guests;
  const totalAmount = baseAmount + addonsAmount;
  const amountPaidRaw = parseFloat(document.getElementById('ab_amountPaid').value);
  const amountPaid = isNaN(amountPaidRaw) ? totalAmount : Math.min(Math.max(amountPaidRaw, 0), totalAmount);

  btn.disabled = true;
  btnText.classList.add('hidden');
  spinner.classList.remove('hidden');
  errEl.classList.add('hidden');

  try {
    if (!abState.selectedRoomDbId) throw new Error('Room not found. Make sure the schema is set up correctly.');

    const { bookingRef } = await callAPI('admin/bookings/manual', {
      firstName, lastName, email, phone,
      roomId: abState.selectedRoomDbId, roomName: room.name,
      date, time, guests, foodChoice, notes,
      addonsSummary, addonsAmount, baseAmount, totalAmount,
      amountPaid, status, adminNotes, cateringChoice, noAlcoholAck,
    });

    closeAddBookingModal();
    const balanceMsg = amountPaid < totalAmount - 0.005 ? `\n💵 Paid: $${amountPaid.toFixed(2)} — Balance due: $${(totalAmount - amountPaid).toFixed(2)}` : '';
    alert(`✅ Booking created!\nRef: ${bookingRef}\nTotal: $${totalAmount.toFixed(2)}${balanceMsg}\nThe time slot is now greyed out on the live site.`);
    refreshCurrentTab();

  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btnText.classList.remove('hidden');
    spinner.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Edit Booking Modal
// ---------------------------------------------------------------------------
let editBookingState = {
  bookingId: null,
  booking: null,
  guests: 10,
  addons: {},
  sodaTypes: {},
  pizzaTypes: {},
  roomMin: 1,
  roomMax: 24,
};

// Delegates to parseFoodChoiceFull so "4 Mini Burgers" / "2 Vege Burgers"
// (the format customer bookings actually use) parse correctly — this used to
// have its own stricter regex that only matched bare "Burgers", silently
// zeroing out burgers and dropping vege burgers entirely whenever a booking
// came from the customer-facing wizard instead of the admin modal.
function parseFoodChoice(foodChoice) {
  const { nuggets, burgers, veges } = parseFoodChoiceFull(foodChoice);
  return { nuggets, burgers, veges };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAddonsSummary(summary) {
  const addons = {};
  if (!summary) return addons;

  // Typed items have variant names embedded in the label, so match on the base prefix only
  const flexMatchers = {
    drinks_soda:    /Soft Drink(?:\s*\([^)]*\))?\s*×(\d+)/i,
    pizza_11:       /11-inch Pizza(?:\s*\([^)]*\))?\s*×(\d+)/i,
  };
  Object.entries(flexMatchers).forEach(([id, pattern]) => {
    const m = summary.match(pattern);
    if (m) addons[id] = parseInt(m[1]);
  });

  // All other items use the standard label match
  Object.entries(AB_ADDON_PRICES).forEach(([id, a]) => {
    if (addons[id] !== undefined) return;
    const match = summary.match(new RegExp(escapeRegex(a.label) + '[^×]*×(\\d+)', 'i'));
    if (match) addons[id] = parseInt(match[1]);
  });

  return addons;
}

function parseTypesFromSummary(summary, addonId) {
  if (!summary) return {};
  const basePatterns = {
    drinks_soda:    /Soft Drink\s*\(([^)]+)\)/i,
    pizza_11:       /11-inch Pizza\s*\(([^)]+)\)/i,
  };
  const pattern = basePatterns[addonId];
  if (!pattern) return {};
  const outer = summary.match(pattern);
  if (!outer) return {};
  const typeNames = Object.keys(getAddonTypeMap(addonId));
  const types = {};
  outer[1].split(',').forEach(part => {
    const trimmed = part.trim();
    const xMatch = trimmed.match(/^(.+?)\s+x(\d+)$/i);
    const name = xMatch ? xMatch[1].trim() : trimmed;
    const qty  = xMatch ? parseInt(xMatch[2]) : 1;
    if (typeNames.includes(name) && qty > 0) types[name] = qty;
  });
  return types;
}

function openEditBookingModal(bookingId) {
  const booking = allBookings.find(b => b.id === bookingId);
  if (!booking) return;

  editBookingState.bookingId = bookingId;
  editBookingState.booking = booking;
  editBookingState.guests = booking.guestCount || 10;
  editBookingState.addons = parseAddonsSummary(booking.addonsSummary);
  editBookingState.pizzaTypes = parseTypesFromSummary(booking.addonsSummary, 'pizza_11');
  editBookingState.sodaTypes  = parseTypesFromSummary(booking.addonsSummary, 'drinks_soda');
  const ebRoom = AB_ROOMS.find(r => r.name === booking.roomName);
  editBookingState.roomMin = ebRoom ? ebRoom.minGuests : 1;
  editBookingState.roomMax = ebRoom ? ebRoom.maxGuests : 24;
  const ebGuestsEl = document.getElementById('eb_guests');
  ebGuestsEl.min = editBookingState.roomMin;
  ebGuestsEl.max = editBookingState.roomMax;

  const { nuggets, burgers, veges } = parseFoodChoice(booking.foodChoice);

  document.getElementById('eb_bookingRef').textContent = booking.bookingRef;
  document.getElementById('eb_firstName').value = booking.firstName || '';
  document.getElementById('eb_lastName').value = booking.lastName || '';
  document.getElementById('eb_email').value = booking.contactEmail || '';
  document.getElementById('eb_phone').value = booking.contactPhone || '';
  document.getElementById('eb_guests').value = editBookingState.guests;
  document.getElementById('eb_foodTarget').textContent = editBookingState.guests;
  document.getElementById('eb_nuggetCount').textContent = nuggets;
  document.getElementById('eb_burgerCount').textContent = burgers;
  document.getElementById('eb_vegeCount').textContent = veges;
  document.getElementById('eb_foodSplitTotal').textContent = `${nuggets + burgers + veges} / ${editBookingState.guests} selected`;
  document.getElementById('eb_notes').value = booking.allergyNotes || '';
  document.getElementById('eb_adminNotes').value = booking.adminNotes || '';
  document.getElementById('eb_status').value = booking.status === 'pending' ? 'pending' : 'confirmed';
  document.getElementById('eb_amountPaid').value = parseFloat(booking.amountPaid || 0).toFixed(2);
  document.getElementById('editBookingError').classList.add('hidden');

  ebRenderAddonsList();
  ebUpdateOrderSummary();
  document.getElementById('editBookingModal').style.display = 'flex';
}

function closeEditBookingModal() {
  document.getElementById('editBookingModal').style.display = 'none';
}

function ebOnGuestsChange() {
  const { roomMin, roomMax } = editBookingState;
  editBookingState.guests = Math.max(roomMin, Math.min(roomMax, parseInt(document.getElementById('eb_guests').value) || roomMin));
  document.getElementById('eb_guests').value = editBookingState.guests;
  document.getElementById('eb_foodTarget').textContent = editBookingState.guests;
  document.getElementById('eb_nuggetCount').textContent = '0';
  document.getElementById('eb_burgerCount').textContent = '0';
  document.getElementById('eb_vegeCount').textContent = '0';
  document.getElementById('eb_foodSplitTotal').textContent = `0 / ${editBookingState.guests} selected`;
  ebUpdateOrderSummary();
}

function ebChangeFoodSplit(type, delta) {
  const total = editBookingState.guests;
  const nuggets = parseInt(document.getElementById('eb_nuggetCount').textContent) || 0;
  const burgers = parseInt(document.getElementById('eb_burgerCount').textContent) || 0;
  const veges   = parseInt(document.getElementById('eb_vegeCount').textContent) || 0;
  const current = type === 'nuggets' ? nuggets : type === 'burgers' ? burgers : veges;
  const other = (type === 'nuggets' ? burgers + veges : type === 'burgers' ? nuggets + veges : nuggets + burgers);
  const next = Math.max(0, Math.min(current + delta, total - other));

  const elMap = { nuggets: 'eb_nuggetCount', burgers: 'eb_burgerCount', veges: 'eb_vegeCount' };
  document.getElementById(elMap[type]).textContent = next;

  const newNuggets = type === 'nuggets' ? next : nuggets;
  const newBurgers = type === 'burgers' ? next : burgers;
  const newVeges   = type === 'veges'   ? next : veges;
  const newTotal = newNuggets + newBurgers + newVeges;
  document.getElementById('eb_foodSplitTotal').textContent = `${newTotal} / ${total} selected`;
  ebUpdateOrderSummary();
}

function ebRenderAddonsList() {
  const container = document.getElementById('eb_addonsList');
  if (!container) return;
  let html = '';
  Object.entries(AB_ADDON_PRICES).forEach(([id, a]) => {
    const qty = editBookingState.addons[id] || 0;
    const typePicker = TYPE_PICKER_IDS.has(id) ? buildAdminTypePickerHtml('eb', id, qty, editBookingState) : '';
    html += `
      <div class="bg-white ab-card rounded-lg p-2.5 border border-gray-100">
        <div class="flex items-center justify-between">
          <div class="flex-1 min-w-0">
            <div class="text-xs font-semibold text-gray-700">${a.label}</div>
            <span class="bg-green-100 text-green-700 font-bold text-xs rounded-full px-2 py-0.5">$${a.price.toFixed(2)}</span>
          </div>
          <div class="flex items-center gap-1">
            <button onclick="ebChangeAddon('${id}', -1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400">−</button>
            <span class="w-5 text-center text-xs font-bold" id="eb_addon_${id}">${qty}</span>
            <button onclick="ebChangeAddon('${id}', 1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400">+</button>
          </div>
        </div>${typePicker}
      </div>`;
  });
  container.innerHTML = html;
}

function ebChangeAddon(id, delta) {
  const current = editBookingState.addons[id] || 0;
  const next = Math.max(0, current + delta);
  editBookingState.addons[id] = next;
  document.getElementById('eb_addon_' + id).textContent = next;
  if (TYPE_PICKER_IDS.has(id)) {
    const picker = document.getElementById('eb_typePicker_' + id);
    if (picker) picker.classList.toggle('hidden', next === 0);
    adminTrimTypeState(id, next, editBookingState);
    ebUpdateTypePickerUI(id);
  }
  ebUpdateOrderSummary();
}

function ebGetAddonTotal() {
  return Object.entries(editBookingState.addons).reduce((sum, [id, qty]) => sum + (AB_ADDON_PRICES[id]?.price || 0) * qty, 0);
}

function ebUpdateOrderSummary() {
  const booking = editBookingState.booking;
  if (!booking) return;

  const guests = editBookingState.guests;
  const ratePerChild = (booking.baseAmount && booking.guestCount)
    ? parseFloat(booking.baseAmount) / booking.guestCount : 39;
  const baseAmount = ratePerChild * guests;
  const addonTotal = ebGetAddonTotal();
  const total = baseAmount + addonTotal;

  const addonLines = Object.entries(editBookingState.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => `<div class="flex justify-between"><span>+ ${getAddonLabelWithTypes(id, editBookingState)} ×${qty}</span><span class="font-semibold">$${(AB_ADDON_PRICES[id].price * qty).toFixed(2)}</span></div>`)
    .join('');

  document.getElementById('eb_orderSummary').innerHTML = `
    <div class="flex justify-between"><span>Room:</span><span class="font-semibold">${booking.roomEmoji || ''} ${roomDisplayName(booking.roomName)}</span></div>
    <div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${ratePerChild.toFixed(2)}/child × ${guests} = $${baseAmount.toFixed(2)}</span></div>
    ${addonLines}
    <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
      <span>Total:</span><span class="text-indigo-600">$${total.toFixed(2)} NZD</span>
    </div>`;

  ebUpdateBalanceDue();
}

function ebGetCalculatedTotal() {
  const booking = editBookingState.booking;
  if (!booking) return 0;
  const ratePerChild = (booking.baseAmount && booking.guestCount)
    ? parseFloat(booking.baseAmount) / booking.guestCount : 39;
  return (ratePerChild * editBookingState.guests) + ebGetAddonTotal();
}

function ebUpdateBalanceDue() {
  const total = ebGetCalculatedTotal();
  const paid = parseFloat(document.getElementById('eb_amountPaid').value);
  const el = document.getElementById('eb_balanceDue');
  if (el && !isNaN(paid) && paid < total - 0.005) {
    el.textContent = `⚠️ Balance due on the day: $${(total - paid).toFixed(2)} NZD`;
    el.classList.remove('hidden');
  } else if (el) {
    el.classList.add('hidden');
  }
}

async function submitEditBooking() {
  const btn = document.getElementById('editBookingBtn');
  const btnText = document.getElementById('editBookingBtnText');
  const spinner = document.getElementById('editBookingBtnSpinner');
  const errEl = document.getElementById('editBookingError');

  const guests    = editBookingState.guests;
  const nuggets   = parseInt(document.getElementById('eb_nuggetCount').textContent) || 0;
  const burgers   = parseInt(document.getElementById('eb_burgerCount').textContent) || 0;
  const veges     = parseInt(document.getElementById('eb_vegeCount').textContent) || 0;
  const notes     = document.getElementById('eb_notes').value.trim();
  const adminNotes = document.getElementById('eb_adminNotes').value.trim();
  const firstName = document.getElementById('eb_firstName').value.trim();
  const lastName  = document.getElementById('eb_lastName').value.trim();
  const email     = document.getElementById('eb_email').value.trim().toLowerCase();
  const phone     = document.getElementById('eb_phone').value.trim();

  if (nuggets + burgers + veges !== guests) {
    errEl.textContent = `Food selection must add up to ${guests} kids. Currently ${nuggets + burgers + veges} selected.`;
    errEl.classList.remove('hidden');
    return;
  }

  const pizzaQty = editBookingState.addons['pizza_11'] || 0;
  if (pizzaQty > 0) {
    const picked = Object.values(editBookingState.pizzaTypes || {}).reduce((s, v) => s + v, 0);
    if (picked < pizzaQty) {
      errEl.textContent = `Please choose a type for all ${pizzaQty} pizza(s) before saving.`;
      errEl.classList.remove('hidden');
      document.getElementById('eb_typePicker_pizza_11')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
  }
  const sodaQty = editBookingState.addons['drinks_soda'] || 0;
  if (sodaQty > 0) {
    const picked = Object.values(editBookingState.sodaTypes || {}).reduce((s, v) => s + v, 0);
    if (picked < sodaQty) {
      errEl.textContent = `Please choose a flavour for all ${sodaQty} soft drink(s) before saving.`;
      errEl.classList.remove('hidden');
      document.getElementById('eb_typePicker_drinks_soda')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
  }

  const ratePerChild = (editBookingState.booking.baseAmount && editBookingState.booking.guestCount)
    ? parseFloat(editBookingState.booking.baseAmount) / editBookingState.booking.guestCount : 39;
  const baseAmount = ratePerChild * guests;
  const addonsAmount = ebGetAddonTotal();
  const totalAmount = baseAmount + addonsAmount;

  const foodChoice = buildFoodChoiceString(nuggets, burgers, veges);
  const addonLines = Object.entries(editBookingState.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => `${getAddonLabelWithTypes(id, editBookingState)} ×${qty} ($${(AB_ADDON_PRICES[id].price * qty).toFixed(2)})`);
  const addonsSummary = addonLines.join(', ');

  btn.disabled = true;
  btnText.classList.add('hidden');
  spinner.classList.remove('hidden');
  errEl.classList.add('hidden');

  const bookingStatus = document.getElementById('eb_status').value;
  const amountPaid = parseFloat(document.getElementById('eb_amountPaid').value) || 0;

  try {
    await callAPI(`admin/bookings/${editBookingState.bookingId}`, {
      firstName, lastName, email, phone,
      guestCount: guests,
      foodChoice,
      allergyNotes: notes,
      addonsSummary,
      addonsAmount,
      baseAmount,
      totalAmount,
      bookingStatus,
      amountPaid,
      adminNotes,
    }, 'PATCH');

    closeEditBookingModal();
    alert(`✅ Booking updated successfully.`);
    await loadBookings();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btnText.classList.remove('hidden');
    spinner.classList.add('hidden');
  }
}