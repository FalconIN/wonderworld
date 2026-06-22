/**
 * admin.js
 * Admin dashboard:
 *   - Auth guard (admin-only access)
 *   - Overview stats
 *   - Bookings table with cancel
 *   - Payments table with refund via Edge Function
 *   - Customers table
 */

let currentTab = 'overview';
let allBookings   = [];
let allPayments   = [];
let allCustomers  = [];

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
// Tab navigation
// ---------------------------------------------------------------------------
function showTab(tab) {
  currentTab = tab;

  // Update nav buttons
  document.querySelectorAll('.admin-nav-btn').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.getElementById('nav-' + tab);
  if (navBtn) navBtn.classList.add('active');

  // Show/hide tab panels
  ['overview','bookings','payments','customers'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });

  // Page title
  const titles = { overview: 'Overview', bookings: 'Bookings', payments: 'Payments', customers: 'Customers' };
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
    };
    searchEl.placeholder = placeholders[tab] || 'Search...';
  }

  // Load data
  if (tab === 'overview')   loadOverview();
  if (tab === 'bookings')   loadBookings();
  if (tab === 'payments')   loadPayments();
  if (tab === 'customers')  loadCustomers();
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
          <div class="font-semibold text-sm text-gray-900 ${b.status === 'cancelled' ? 'line-through' : ''}">${b.roomName || '—'} · ${b.guestCount} kids</div>
          <div class="text-xs text-gray-400">${b.partyDate} @ ${b.partyTime} · ${b.contactEmail || ''}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge ${statusBadgeClass(b.status)}">${b.status}</span>
        <span class="text-xs text-gray-400 font-mono">${b.bookingRef}</span>
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
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) errors.push('Invalid/missing email');
  if (!matchedRoom) errors.push(`Room "${roomText}" not recognized`);
  if (!date) errors.push(`Date "${dateRaw}" could not be parsed`);
  if (!guests || guests < 1) errors.push('Missing/invalid guest count');
  if (!['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM'].includes(time)) errors.push(`Time "${get('time')}" not a valid slot`);

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
      <td>${r.firstName || '<span class="text-red-400">—</span>'}</td>
      <td>${r.lastName || ''}</td>
      <td>${r.email || '<span class="text-red-400">—</span>'}</td>
      <td>${r.matchedRoom ? r.matchedRoom.name : `<span class="text-red-400">${r.roomText || '—'}</span>`}</td>
      <td>${r.guests ?? '<span class="text-red-400">—</span>'}</td>
      <td>${r.date || `<span class="text-red-400">${r.dateRaw || '—'}</span>`}</td>
      <td>${r.time && ['9:30 AM','11:30 AM','1:30 PM','3:30 PM'].includes(r.time) ? r.time : `<span class="text-red-400">${r.time || '—'}</span>`}</td>
      <td class="text-xs">${r.addonsSummary || '<span class="text-gray-300">—</span>'}</td>
      <td>$${r.price.toFixed(2)}</td>
    </tr>`).join('');

  const errEl = document.getElementById('importErrors');
  const detectedFields = Object.keys(colMap);
  const requiredFields = ['firstName', 'email', 'room', 'guests', 'date', 'time'];
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
    const bookedOn = b.createdAt ? new Date(b.createdAt).toLocaleDateString('en-NZ') : '';
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
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportRows);
  ws['!cols'] = [
    { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 14 },
    { wch: 10 }, { wch: 16 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 },
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
    : `bookings_all_${new Date().toISOString().split('T')[0]}.xlsx`;
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
    const day = (r.date || '').toString().split('T')[0];
    if (!day) return;
    byDate[day] = (byDate[day] || 0) + parseFloat(r.amount || 0);
  });

  const dataPoints = Object.keys(byDate).sort().map(d => ({ x: d + 'T12:00:00', y: byDate[d] }));

  if (revenueChartInstance) revenueChartInstance.destroy();
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
        pointRadius: 3,
        pointBackgroundColor: '#4F46E5',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `$${ctx.parsed.y.toFixed(2)} NZD` } },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', tooltipFormat: 'MMM d' },
          ticks: { color: chartTextColor(), maxTicksLimit: 10 },
          grid: { color: chartGridColor() },
        },
        y: { ticks: { color: chartTextColor(), callback: (v) => '$' + v }, grid: { color: chartGridColor() } },
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
    y: parseInt(r.count),
  })).sort((a, b) => a.x.localeCompare(b.x));

  if (bookingsDotChartInstance) bookingsDotChartInstance.destroy();
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
        pointRadius: 4,
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
            title: (items) => new Date(items[0].raw.x + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'short', month: 'short', day: 'numeric' }),
            label: (ctx) => `${ctx.raw.y} room${ctx.raw.y === 1 ? '' : 's'} booked`,
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

  if (roomPopularityChartInstance) roomPopularityChartInstance.destroy();

  if (labels.length === 0) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
// Bookings
// ---------------------------------------------------------------------------
async function loadBookings() {
  const statusFilter = document.getElementById('bookingStatusFilter')?.value || '';
  const tbody = document.getElementById('bookings-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  let endpoint = 'admin/bookings?limit=200';
  if (statusFilter) endpoint += `&status=${statusFilter}`;

  try {
    allBookings = await callAPI(endpoint, null, 'GET');
  } catch (err) { console.error(err); return; }
  renderBookingsTable(allBookings);
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
      <td><span class="font-mono text-xs text-indigo-600 font-bold">${b.bookingRef}</span></td>
      <td>
        <div class="text-xs text-gray-400">${b.contactEmail || '—'}</div>
      </td>
      <td>${b.roomEmoji || ''} ${b.roomName || '—'}</td>
      <td>
        <div class="text-sm font-semibold">${b.partyDate}</div>
        <div class="text-xs text-gray-400">${b.partyTime}</div>
      </td>
      <td>${b.guestCount}</td>
      <td class="font-semibold">$${parseFloat(b.totalAmount || 0).toFixed(2)}</td>
      <td><span class="badge ${statusBadgeClass(b.status)}">${b.status}</span></td>
      <td>
        <div class="flex gap-2">
          <button onclick="viewBooking('${b.id}')" class="text-xs text-indigo-500 hover:underline font-semibold">View</button>
          ${b.status !== 'cancelled' ? `<button onclick="cancelBooking('${b.id}', '${b.bookingRef}')" class="text-xs text-red-500 hover:underline font-semibold">Cancel</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

async function viewBooking(bookingId) {
  const booking = allBookings.find(b => b.id === bookingId);
  if (!booking) return;

  const guestCount = booking.guestCount || 0;
  const baseAmount = booking.baseAmount != null ? parseFloat(booking.baseAmount) : null;
  const ratePerChild = (baseAmount !== null && guestCount > 0) ? baseAmount / guestCount : null;

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
          <div class="font-semibold">${booking.roomEmoji || ''} ${booking.roomName || '—'}</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Date & Time</div>
          <div class="font-semibold">${booking.partyDate} @ ${booking.partyTime}</div>
        </div>
      </div>

      <div class="bg-indigo-light rounded-xl p-4">
        <div class="font-display font-bold text-indigo-700 mb-2 text-sm">📋 Order Summary</div>
        <div class="space-y-1.5 text-sm text-indigo-800">
          <div class="flex justify-between"><span>Guests:</span><span class="font-semibold">${guestCount} children</span></div>
          <div class="flex justify-between"><span>Food:</span><span class="font-semibold">${booking.foodChoice || '—'}</span></div>
          ${ratePerChild ? `<div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${ratePerChild.toFixed(2)}/child × ${guestCount} = $${baseAmount.toFixed(2)}</span></div>` : ''}
          ${booking.addonsSummary ? `<div class="flex justify-between"><span>Add-ons:</span><span class="font-semibold text-right">${booking.addonsSummary}</span></div>` : ''}
          <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
            <span>Total:</span><span class="text-indigo-600">$${parseFloat(booking.totalAmount || 0).toFixed(2)} NZD</span>
          </div>
        </div>
      </div>

      <div class="bg-gray-50 rounded-xl p-4">
        <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Customer</div>
        <div class="text-sm text-gray-500">${booking.contactEmail || '—'}</div>
      </div>
      ${booking.allergyNotes ? `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div class="text-xs text-amber-600 mb-1 uppercase font-semibold">⚠️ Dietary Requirements</div>
        <div class="text-sm text-gray-600">${booking.allergyNotes}</div>
      </div>` : ''}
      <div class="text-xs text-gray-400">Booked: ${new Date(booking.createdAt).toLocaleString('en-NZ')}</div>
      ${booking.status !== 'cancelled' ? `
      <button onclick="cancelBooking('${booking.id}', '${booking.bookingRef}')" class="btn-primary w-full py-3 mt-2" style="background: linear-gradient(135deg,#EF4444,#DC2626)">
        Cancel This Booking
      </button>` : ''}
    </div>`;

  document.getElementById('bookingDetailModal').style.display = 'flex';
}

function closeBookingModal() {
  document.getElementById('bookingDetailModal').style.display = 'none';
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
async function loadPayments() {
  const tbody = document.getElementById('payments-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  try {
    allPayments = await callAPI('admin/payments?limit=200', null, 'GET');
  } catch (err) { console.error(err); return; }
  renderPaymentsTable(allPayments);
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
      : '—';
    return `
    <tr>
      <td>
        <div class="font-semibold text-sm">${p.cardholderName || '—'}</div>
        <div class="text-xs text-gray-400">${cardInfo}</div>
      </td>
      <td>
        <div class="text-xs text-gray-400">${p.contactEmail || '—'}</div>
      </td>
      <td><span class="font-mono text-xs text-indigo-600">${p.bookingRef || '—'}</span></td>
      <td class="font-bold">$${parseFloat(p.amount || 0).toFixed(2)} ${(p.currency || 'nzd').toUpperCase()}</td>
      <td><span class="badge ${p.status === 'succeeded' ? 'badge-green' : p.status === 'failed' ? 'badge-red' : 'badge-yellow'}">${p.status}</span></td>
      <td class="text-xs text-gray-500">${new Date(p.createdAt).toLocaleString('en-NZ')}</td>
      <td>
        ${p.status === 'succeeded' ? `<button onclick="refundPayment('${p.id}', '${p.stripePaymentIntentId}', ${p.amount})" class="text-xs text-red-500 hover:underline font-semibold">Refund</button>` : '—'}
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
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  try {
    allCustomers = await callAPI('admin/customers?limit=200', null, 'GET');
  } catch (err) { console.error(err); return; }
  renderCustomersTable(allCustomers);
}

function renderCustomersTable(customers) {
  const tbody = document.getElementById('customers-tbody');
  if (!tbody) return;

  if (!customers || customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-gray-400">No customers found.</td></tr>';
    return;
  }

  tbody.innerHTML = customers.map(c => {
    const nonCancelled = (c.bookings || []).filter(b => b.status !== 'cancelled');
    const totalSpent = nonCancelled.reduce((s, b) => s + parseFloat(b.totalAmount || 0), 0);
    const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || '—';
    const isAdmin = c.isAdmin;
    const isSelf = c.id === (auth.currentUser && auth.currentUser.uid);
    const safeEmail = (c.email || '').replace(/'/g, "\\'");
    let adminCell;
    if (isSelf) {
      adminCell = '<span class="text-xs px-3 py-1 rounded-lg font-semibold bg-indigo-100 text-indigo-700">✅ You</span>';
    } else if (isAdmin) {
      adminCell = '<button onclick="toggleAdmin(\'' + c.id + '\', \'' + safeEmail + '\', true)" class="text-xs px-3 py-1 rounded-lg font-semibold transition-all bg-indigo-100 text-indigo-700 hover:bg-red-100 hover:text-red-600">✅ Admin</button>';
    } else {
      adminCell = '<button onclick="toggleAdmin(\'' + c.id + '\', \'' + safeEmail + '\', false)" class="text-xs px-3 py-1 rounded-lg font-semibold transition-all bg-gray-100 text-gray-500 hover:bg-indigo-100 hover:text-indigo-700">Make Admin</button>';
    }
    return `<tr>
      <td class="font-semibold text-sm">${name}</td>
      <td class="text-sm">${c.email || '—'}</td>
      <td class="text-sm">${c.phone || '—'}</td>
      <td class="font-semibold">$${totalSpent.toFixed(2)}</td>
      <td>${adminCell}</td>
    </tr>`;
  }).join('');
}

async function toggleAdmin(userId, email, currentlyAdmin) {
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
function handleSearch(query) {
  const q = query.toLowerCase();
  if (currentTab === 'bookings') {
    renderBookingsTable(allBookings.filter(b =>
      (b.booking_ref || '').toLowerCase().includes(q) ||
      (b.contact_email || '').toLowerCase().includes(q) ||
      (b.party_rooms?.name || '').toLowerCase().includes(q)
    ));
  }
  if (currentTab === 'customers') {
    renderCustomersTable(allCustomers.filter(c =>
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase().includes(q)
    ));
  }
  if (currentTab === 'payments') {
    renderPaymentsTable(allPayments.filter(p =>
      (p.bookings?.booking_ref || '').toLowerCase().includes(q) ||
      (p.bookings?.contact_email || '').toLowerCase().includes(q) ||
      (p.cardholder_name || '').toLowerCase().includes(q)
    ));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function statusBadgeClass(status) {
  return status === 'confirmed' ? 'badge-green'
       : status === 'cancelled' ? 'badge-red'
       : status === 'pending'   ? 'badge-yellow'
       : 'badge-gray';
}

async function adminSignOut() {
  await auth.signOut();
  window.location.href = '/';
}

// ---------------------------------------------------------------------------
// Add Booking Modal
// ---------------------------------------------------------------------------
const ROOM_SLUGS = {
  big: 'big',
  sunshine: 'sunshine',
  dream: 'dream',
  forest: 'forest',
};

// Mirrors the customer-facing ROOMS array in booking.js
const AB_ROOMS = [
  { id: 'big',      name: 'The Big Room',      emoji: '🌟', minGuests: 12, maxGuests: 24, pricePerChild: 39 },
  { id: 'sunshine', name: 'Sunshine Room',     emoji: '☀️', minGuests: 8,  maxGuests: 15, pricePerChild: 39 },
  { id: 'dream',    name: 'Dream Room',        emoji: '🌙', minGuests: 8,  maxGuests: 15, pricePerChild: 39 },
  { id: 'forest',   name: 'Wonder Forest Room',emoji: '🌿', minGuests: 8,  maxGuests: 15, pricePerChild: 39 },
];

const AB_ALL_SLOTS = ['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM'];
const AB_SLOT_END_TIMES = {
  '9:30 AM':  '11:00 AM',
  '11:30 AM': '1:00 PM',
  '1:30 PM':  '3:00 PM',
  '3:30 PM':  '5:00 PM',
};

// Mirrors the customer-facing ADDON_PRICES in booking.js
const AB_ADDON_PRICES = {
  pizza_ham:       { label: 'Ham & Cheese Pizza',     price: 25 },
  pizza_veg:       { label: 'Vegetarian Pizza',       price: 25 },
  platter_chicken: { label: 'Fried Chicken Platter',  price: 39 },
  platter_seafood: { label: 'Seafood Platter',        price: 49 },
  adult_sandwich:  { label: 'Adult Sandwich Platter', price: 60 },
  sushi_40:        { label: 'Sushi Platter (40 pcs)', price: 60 },
  sushi_24:        { label: 'Sushi Platter (24 pcs)', price: 30 },
  sushi_salmon:    { label: 'Salmon Supreme Platter', price: 28.90 },
  sushi_ocean:     { label: 'Ocean Deluxe Set',       price: 39.90 },
};

// Local state for the manual booking modal
let abState = {
  guests: 10,
  selectedRoomId: null,
  selectedRoomDbId: null,
  selectedDate: null,
  selectedTime: null,
  addons: {},
};

function openAddBookingModal() {
  abState = { guests: 10, selectedRoomId: null, selectedRoomDbId: null, selectedDate: null, selectedTime: null, addons: {} };

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('ab_date').min = today;
  document.getElementById('ab_date').value = '';
  document.getElementById('ab_guests').value = 10;
  document.getElementById('ab_notes').value = '';
  document.getElementById('ab_nuggetCount').textContent = '0';
  document.getElementById('ab_burgerCount').textContent = '0';
  document.getElementById('ab_foodSplitTotal').textContent = '0 / 10 selected';
  document.getElementById('ab_foodTarget').textContent = '10';
  document.getElementById('ab_payStatus').value = 'paid';
  document.getElementById('ab_status').value = 'confirmed';
  document.getElementById('ab_timeSlotGrid').innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">Select a room and date first</div>';
  document.getElementById('ab_orderSummary').innerHTML = '<div class="text-indigo-400">Select a room and guests to see pricing</div>';

  abRenderRoomCards();
  abRenderAddonsList();
  document.getElementById('addBookingModal').style.display = 'flex';
  document.getElementById('addBookingError').classList.add('hidden');
}

function closeAddBookingModal() {
  document.getElementById('addBookingModal').style.display = 'none';
}

function abOnGuestsChange() {
  abState.guests = Math.max(1, Math.min(24, parseInt(document.getElementById('ab_guests').value) || 1));
  document.getElementById('ab_guests').value = abState.guests;
  document.getElementById('ab_foodTarget').textContent = abState.guests;
  abRenderRoomCards();
  // Reset food split since target changed
  document.getElementById('ab_nuggetCount').textContent = '0';
  document.getElementById('ab_burgerCount').textContent = '0';
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
  return `
    <div class="border-2 ${selClass} ${dimClass} rounded-xl p-3 cursor-pointer transition-all" onclick="abSelectRoom('${room.id}')">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-xl">${room.emoji}</span>
          <div>
            <div class="font-semibold text-sm">${room.name}</div>
            <div class="text-xs text-gray-400">${room.minGuests}–${room.maxGuests} kids</div>
          </div>
        </div>
        <div class="text-sm font-bold text-indigo-600">$${room.pricePerChild}/child</div>
      </div>
    </div>`;
}

async function abSelectRoom(roomId) {
  abState.selectedRoomId = roomId;
  abRenderRoomCards();

  const slug = ROOM_SLUGS[roomId];
  try {
    const roomRow = await callAPI(`rooms/by-slug/${slug}`, null, 'GET');
    abState.selectedRoomDbId = roomRow?.id || null;
  } catch {
    abState.selectedRoomDbId = null;
  }

  // Re-fetch slots if a date is already chosen
  const dateVal = document.getElementById('ab_date').value;
  if (dateVal) await abUpdateTimeSlots();
  abUpdateOrderSummary();
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

  grid.innerHTML = '<div class="text-gray-400 text-sm col-span-2 py-4 text-center">Checking availability...</div>';

  let unavailable = [];
  try {
    const result = await callAPI(`slots?room_id=${abState.selectedRoomDbId}&date=${dateVal}`, null, 'GET');
    unavailable = result.unavailableSlots || [];
  } catch { /* show all as available on error */ }

  let html = '';
  AB_ALL_SLOTS.forEach(slot => {
    const isUnavailable = unavailable.includes(slot);
    const selected = abState.selectedTime === slot;
    const cls = isUnavailable
      ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
      : selected
        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 cursor-pointer'
        : 'border-gray-200 bg-white ab-card hover:border-indigo-300 cursor-pointer';
    html += `
      <div class="border-2 ${cls} rounded-xl p-2.5 text-center transition-all" ${isUnavailable ? '' : `onclick="abSelectTime('${slot}', this)"`}>
        <div class="font-semibold text-sm">${slot}</div>
        <div class="text-xs opacity-70">– ${AB_SLOT_END_TIMES[slot]}</div>
        ${isUnavailable ? '<div class="text-xs font-semibold mt-0.5">Full</div>' : ''}
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

function abChangeFoodSplit(type, delta) {
  const total = abState.guests;
  const nuggets = parseInt(document.getElementById('ab_nuggetCount').textContent) || 0;
  const burgers = parseInt(document.getElementById('ab_burgerCount').textContent) || 0;
  const current = type === 'nuggets' ? nuggets : burgers;
  const other = type === 'nuggets' ? burgers : nuggets;
  const next = Math.max(0, Math.min(current + delta, total - other));

  if (type === 'nuggets') {
    document.getElementById('ab_nuggetCount').textContent = next;
  } else {
    document.getElementById('ab_burgerCount').textContent = next;
  }

  const newTotal = type === 'nuggets' ? next + burgers : nuggets + next;
  document.getElementById('ab_foodSplitTotal').textContent = `${newTotal} / ${total} selected`;
}

function abRenderAddonsList() {
  const container = document.getElementById('ab_addonsList');
  if (!container) return;
  let html = '';
  Object.entries(AB_ADDON_PRICES).forEach(([id, a]) => {
    html += `
      <div class="flex items-center justify-between bg-white ab-card rounded-lg p-2.5 border border-gray-100">
        <div class="flex-1 min-w-0">
          <div class="text-xs font-semibold text-gray-700">${a.label}</div>
          <span class="bg-green-100 text-green-700 font-bold text-xs rounded-full px-2 py-0.5">$${a.price.toFixed(2)}</span>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="abChangeAddon('${id}', -1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400">−</button>
          <span class="w-5 text-center text-xs font-bold" id="ab_addon_${id}">0</span>
          <button onclick="abChangeAddon('${id}', 1)" class="w-6 h-6 rounded border border-gray-300 text-xs font-bold hover:border-indigo-400">+</button>
        </div>
      </div>`;
  });
  container.innerHTML = html;
}

function abChangeAddon(id, delta) {
  const current = abState.addons[id] || 0;
  const next = Math.max(0, current + delta);
  abState.addons[id] = next;
  document.getElementById('ab_addon_' + id).textContent = next;
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
  const baseTotal = room.pricePerChild * abState.guests;
  const addonTotal = abGetAddonTotal();
  const total = baseTotal + addonTotal;

  const addonLines = Object.entries(abState.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => `<div class="flex justify-between"><span>+ ${AB_ADDON_PRICES[id].label} ×${qty}</span><span class="font-semibold">$${(AB_ADDON_PRICES[id].price * qty).toFixed(2)}</span></div>`)
    .join('');

  summaryEl.innerHTML = `
    <div class="flex justify-between"><span>Room:</span><span class="font-semibold">${room.name}</span></div>
    <div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${room.pricePerChild}/child × ${abState.guests} = $${baseTotal.toFixed(2)}</span></div>
    ${addonLines}
    <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
      <span>Total:</span><span class="text-indigo-600">$${total.toFixed(2)} NZD</span>
    </div>`;
}

function abGetCalculatedTotal() {
  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  if (!room) return 0;
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
  const notes     = document.getElementById('ab_notes').value.trim();
  const payStatus = document.getElementById('ab_payStatus').value;
  const status    = document.getElementById('ab_status').value;

  const nuggets = parseInt(document.getElementById('ab_nuggetCount').textContent) || 0;
  const burgers = parseInt(document.getElementById('ab_burgerCount').textContent) || 0;

  // Validate
  if (!firstName) { errEl.textContent = 'First name is required.'; errEl.classList.remove('hidden'); return; }
  if (!lastName)  { errEl.textContent = 'Last name is required.';  errEl.classList.remove('hidden'); return; }
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { errEl.textContent = 'Valid email is required.'; errEl.classList.remove('hidden'); return; }
  if (!abState.selectedRoomId) { errEl.textContent = 'Please select a party room.'; errEl.classList.remove('hidden'); return; }
  if (!date)   { errEl.textContent = 'Party date is required.';  errEl.classList.remove('hidden'); return; }
  if (!time)   { errEl.textContent = 'Please select a time slot.'; errEl.classList.remove('hidden'); return; }
  if (nuggets + burgers !== guests) {
    errEl.textContent = `Food selection must add up to ${guests} kids. Currently ${nuggets + burgers} selected.`;
    errEl.classList.remove('hidden');
    return;
  }

  const foodChoice = `${nuggets > 0 ? nuggets + ' Nuggets' : ''}${nuggets > 0 && burgers > 0 ? ' + ' : ''}${burgers > 0 ? burgers + ' Burgers' : ''}`;
  const addonLines = Object.entries(abState.addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => `${AB_ADDON_PRICES[id].label} ×${qty} ($${(AB_ADDON_PRICES[id].price * qty).toFixed(2)})`);
  const addonsSummary = addonLines.join(', ');
  const addonsAmount = abGetAddonTotal();
  const room = AB_ROOMS.find(r => r.id === abState.selectedRoomId);
  const baseAmount = room.pricePerChild * guests;
  const totalAmount = baseAmount + addonsAmount;

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
      payStatus, status,
    });

    closeAddBookingModal();
    alert(`✅ Booking created!\nRef: ${bookingRef}\nTotal: $${totalAmount.toFixed(2)}\nThe time slot is now greyed out on the live site.`);
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