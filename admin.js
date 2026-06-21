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
// Init: check admin access
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = '/?adminredirect=1';
    return;
  }

  // Verify admin flag
  const { data: profile } = await supabaseClient
    .from('users')
    .select('first_name, last_name, is_admin')
    .eq('id', session.user.id)
    .single();

  if (!profile?.is_admin) {
    alert('Access denied. Admin accounts only.');
    window.location.href = '/';
    return;
  }

  document.getElementById('adminUserInfo').textContent =
    `${profile.first_name} ${profile.last_name}`;

  initAdminTheme();

  // Load initial tab
  await loadOverview();
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
  // Totals
  const [
    { count: totalBookings },
    { data: revenueData },
    { count: totalCustomers },
    { count: upcomingCount },
    { count: cancelledCount },
  ] = await Promise.all([
    supabaseClient.from('bookings').select('*', { count: 'exact', head: true }),
    supabaseClient.from('bookings').select('total_amount').neq('status', 'cancelled'),
    supabaseClient.from('users').select('*', { count: 'exact', head: true }),
    supabaseClient.from('bookings')
      .select('*', { count: 'exact', head: true })
      .gte('party_date', new Date().toISOString().split('T')[0])
      .lte('party_date', new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0])
      .eq('status', 'confirmed'),
    supabaseClient.from('bookings').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
  ]);

  const totalRevenue = (revenueData || []).reduce((s, r) => s + parseFloat(r.total_amount || 0), 0);

  document.getElementById('stat-bookings').textContent  = totalBookings ?? '—';
  document.getElementById('stat-revenue').textContent   = '$' + totalRevenue.toFixed(2);
  document.getElementById('stat-customers').textContent = totalCustomers ?? '—';
  document.getElementById('stat-upcoming').textContent  = upcomingCount ?? '—';

  const cancelledNote = document.getElementById('stat-cancelled-note');
  if (cancelledNote) {
    cancelledNote.textContent = cancelledCount > 0 ? `(${cancelledCount} cancelled)` : '';
  }

  await loadOverviewBookingsList();
  await renderBookingsDotChart();
  await renderRoomPopularityChart();
}

async function loadOverviewBookingsList(fromDate, toDate) {
  const list = document.getElementById('upcoming-bookings-list');
  const titleEl = document.getElementById('upcomingListTitle');
  list.innerHTML = '<p class="text-gray-400 text-sm py-4">Loading...</p>';

  let query = supabaseClient
    .from('bookings')
    .select('booking_ref, party_date, party_time, guest_count, status, contact_email, party_rooms(name, emoji)')
    .order('party_date', { ascending: true });

  if (fromDate && toDate) {
    query = query.gte('party_date', fromDate).lte('party_date', toDate);
    titleEl.textContent = `Bookings: ${fromDate} → ${toDate}`;
  } else {
    query = query.gte('party_date', new Date().toISOString().split('T')[0]).limit(10);
    titleEl.textContent = 'Upcoming Bookings (Next 7 Days)';
  }

  const { data: bookings, error } = await query;

  if (error) {
    list.innerHTML = `<p class="text-red-400 text-sm py-4">Failed to load bookings: ${error.message}</p>`;
    return;
  }

  if (!bookings || bookings.length === 0) {
    list.innerHTML = '<p class="text-gray-400 text-sm py-4">No bookings found for this range.</p>';
    return;
  }

  list.innerHTML = bookings.map(b => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 ${b.status === 'cancelled' ? 'opacity-60' : ''}">
      <div class="flex items-center gap-3">
        <span class="text-2xl">${b.party_rooms?.emoji || '🎉'}</span>
        <div>
          <div class="font-semibold text-sm text-gray-900 ${b.status === 'cancelled' ? 'line-through' : ''}">${b.party_rooms?.name || '—'} · ${b.guest_count} kids</div>
          <div class="text-xs text-gray-400">${b.party_date} @ ${b.party_time} · ${b.contact_email || ''}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge ${statusBadgeClass(b.status)}">${b.status}</span>
        <span class="text-xs text-gray-400 font-mono">${b.booking_ref}</span>
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

async function exportBookingsToExcel() {
  const from = document.getElementById('overviewRangeFrom').value;
  const to = document.getElementById('overviewRangeTo').value;
  const useRange = from && to;

  let fullQuery = supabaseClient
    .from('bookings')
    .select(`
      booking_ref, party_date, party_time, guest_count, food_choice,
      addons_summary, total_amount, status, contact_email, created_at,
      party_rooms ( name )
    `)
    .order('party_date', { ascending: true });
  if (useRange) fullQuery = fullQuery.gte('party_date', from).lte('party_date', to);

  const { data: rows, error: rowsError } = await fullQuery;

  if (rowsError) {
    alert('Failed to export: ' + rowsError.message);
    return;
  }
  if (!rows || rows.length === 0) {
    alert('No bookings found to export' + (useRange ? ' for this date range.' : '.'));
    return;
  }

  // Look up first/last name per booking via contact_email against the users table
  const emails = [...new Set(rows.map(r => (r.contact_email || '').toLowerCase()).filter(Boolean))];
  let usersByEmail = {};
  if (emails.length > 0) {
    const { data: usersData } = await supabaseClient
      .from('users')
      .select('email, first_name, last_name')
      .in('email', emails);
    (usersData || []).forEach(u => { usersByEmail[(u.email || '').toLowerCase()] = u; });
  }

  const ROOM_COLOR_LABELS = {
    'The Big Room': 'Big Room',
    'Sunshine Room': 'Yellow Room',
    'Dream Room': 'Purple Room',
    'Wonder Forest Room': 'Green Room',
  };

  const exportRows = rows.map(b => {
    const u = usersByEmail[(b.contact_email || '').toLowerCase()] || {};
    const bookedOn = b.created_at ? new Date(b.created_at).toLocaleDateString('en-NZ') : '';
    const roomName = b.party_rooms?.name || '';
    return {
      'Date Booked':  bookedOn,
      'First Name':   u.first_name || '',
      'Last Name':    u.last_name || '',
      'Ref Number':   b.booking_ref || '',
      'Party Room':   ROOM_COLOR_LABELS[roomName] || roomName,
      'Kid Amount':   b.guest_count ?? '',
      'Food Chosen':  b.food_choice || '',
      'Add-ons':      b.addons_summary || '',
      'Price Paid':   parseFloat(b.total_amount || 0),
      'Party Date':   b.party_date || '',
      'Party Time':   b.party_time || '',
      'Status':       b.status || '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportRows);
  ws['!cols'] = [
    { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
    { wch: 10 }, { wch: 16 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 },
  ];

  // Format Price Paid column as currency ($X.XX)
  const priceColIndex = 8; // 0-indexed position of "Price Paid"
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

  let query = supabaseClient
    .from('bookings')
    .select('party_date, total_amount, created_at')
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true });

  if (rangeVal !== 'all') {
    const days = parseInt(rangeVal);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    query = query.gte('created_at', cutoff);
  }

  const { data: rows, error } = await query;
  if (error) { console.error(error); return; }

  // Group revenue by the date the booking was MADE (created_at), since that's
  // what "revenue per day" means for a business tracking cashflow
  const byDate = {};
  (rows || []).forEach(r => {
    const day = (r.created_at || '').split('T')[0];
    if (!day) return;
    byDate[day] = (byDate[day] || 0) + parseFloat(r.total_amount || 0);
  });

  const labels = Object.keys(byDate).sort();
  const values = labels.map(d => byDate[d]);

  if (revenueChartInstance) revenueChartInstance.destroy();
  revenueChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-NZ', { month: 'short', day: 'numeric' })),
      datasets: [{
        label: 'Revenue (NZD)',
        data: values,
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
        x: { ticks: { color: chartTextColor() }, grid: { color: chartGridColor() } },
        y: { ticks: { color: chartTextColor(), callback: (v) => '$' + v }, grid: { color: chartGridColor() } },
      },
    },
  });
}

async function renderBookingsDotChart() {
  const canvas = document.getElementById('bookingsDotChartCanvas');
  if (!canvas) return;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: rows, error } = await supabaseClient
    .from('bookings')
    .select('party_date, status')
    .neq('status', 'cancelled')
    .gte('party_date', monthStart)
    .lte('party_date', monthEnd);

  if (error) { console.error(error); return; }

  const byDate = {};
  (rows || []).forEach(r => {
    byDate[r.party_date] = (byDate[r.party_date] || 0) + 1;
  });

  const points = Object.entries(byDate).map(([date, count]) => ({
    x: date,
    y: count,
  })).sort((a, b) => a.x.localeCompare(b.x));

  if (bookingsDotChartInstance) bookingsDotChartInstance.destroy();
  bookingsDotChartInstance = new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Rooms booked',
        data: points,
        backgroundColor: '#0E9F6E',
        pointRadius: 6,
        pointHoverRadius: 8,
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

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: rows, error } = await supabaseClient
    .from('bookings')
    .select('party_date, status, party_rooms ( name )')
    .neq('status', 'cancelled')
    .gte('party_date', monthStart)
    .lte('party_date', monthEnd);

  if (error) { console.error(error); return; }

  const byRoom = {};
  (rows || []).forEach(r => {
    const name = r.party_rooms?.name || 'Unknown';
    byRoom[name] = (byRoom[name] || 0) + 1;
  });

  const labels = Object.keys(byRoom);
  const values = labels.map(l => byRoom[l]);
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

  let query = supabaseClient
    .from('bookings')
    .select(`
      id, booking_ref, party_date, party_time, guest_count,
      food_choice, total_amount, status, allergy_notes,
      party_room_id, user_id, contact_email, addons_summary, base_amount, addons_amount, created_at,
      party_rooms ( name, emoji )
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (statusFilter) query = query.eq('status', statusFilter);

  const { data, error } = await query;
  if (error) { console.error(error); return; }
  allBookings = data || [];
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
      <td><span class="font-mono text-xs text-indigo-600 font-bold">${b.booking_ref}</span></td>
      <td>
        <div class="text-xs text-gray-400">${b.contact_email || '—'}</div>
      </td>
      <td>${b.party_rooms?.emoji || ''} ${b.party_rooms?.name || '—'}</td>
      <td>
        <div class="text-sm font-semibold">${b.party_date}</div>
        <div class="text-xs text-gray-400">${b.party_time}</div>
      </td>
      <td>${b.guest_count}</td>
      <td class="font-semibold">$${parseFloat(b.total_amount || 0).toFixed(2)}</td>
      <td><span class="badge ${statusBadgeClass(b.status)}">${b.status}</span></td>
      <td>
        <div class="flex gap-2">
          <button onclick="viewBooking('${b.id}')" class="text-xs text-indigo-500 hover:underline font-semibold">View</button>
          ${b.status !== 'cancelled' ? `<button onclick="cancelBooking('${b.id}', '${b.booking_ref}')" class="text-xs text-red-500 hover:underline font-semibold">Cancel</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

async function viewBooking(bookingId) {
  const booking = allBookings.find(b => b.id === bookingId);
  if (!booking) return;

  const guestCount = booking.guest_count || 0;
  const baseAmount = booking.base_amount !== null && booking.base_amount !== undefined
    ? parseFloat(booking.base_amount) : null;
  const ratePerChild = (baseAmount !== null && guestCount > 0) ? baseAmount / guestCount : null;

  document.getElementById('bookingDetailContent').innerHTML = `
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Booking Ref</div>
          <div class="font-mono font-bold text-indigo-600">${booking.booking_ref}</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Status</div>
          <span class="badge ${statusBadgeClass(booking.status)}">${booking.status}</span>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Room</div>
          <div class="font-semibold">${booking.party_rooms?.emoji || ''} ${booking.party_rooms?.name || '—'}</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Date & Time</div>
          <div class="font-semibold">${booking.party_date} @ ${booking.party_time}</div>
        </div>
      </div>

      <div class="bg-indigo-light rounded-xl p-4">
        <div class="font-display font-bold text-indigo-700 mb-2 text-sm">📋 Order Summary</div>
        <div class="space-y-1.5 text-sm text-indigo-800">
          <div class="flex justify-between"><span>Guests:</span><span class="font-semibold">${guestCount} children</span></div>
          <div class="flex justify-between"><span>Food:</span><span class="font-semibold">${booking.food_choice || '—'}</span></div>
          ${ratePerChild ? `<div class="flex justify-between"><span>Rate:</span><span class="font-semibold">$${ratePerChild.toFixed(2)}/child × ${guestCount} = $${baseAmount.toFixed(2)}</span></div>` : ''}
          ${booking.addons_summary ? `<div class="flex justify-between"><span>Add-ons:</span><span class="font-semibold text-right">${booking.addons_summary}</span></div>` : ''}
          <div class="border-t border-indigo-200 mt-2 pt-2 flex justify-between font-bold text-base">
            <span>Total:</span><span class="text-indigo-600">$${parseFloat(booking.total_amount || 0).toFixed(2)} NZD</span>
          </div>
        </div>
      </div>

      <div class="bg-gray-50 rounded-xl p-4">
        <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Customer</div>
        <div class="text-sm text-gray-500">${booking.contact_email || '—'}</div>
      </div>
      ${booking.allergy_notes ? `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div class="text-xs text-amber-600 mb-1 uppercase font-semibold">⚠️ Dietary Requirements</div>
        <div class="text-sm text-gray-600">${booking.allergy_notes}</div>
      </div>` : ''}
      <div class="text-xs text-gray-400">Booked: ${new Date(booking.created_at).toLocaleString('en-NZ')}</div>
      ${booking.status !== 'cancelled' ? `
      <button onclick="cancelBooking('${booking.id}', '${booking.booking_ref}')" class="btn-primary w-full py-3 mt-2" style="background: linear-gradient(135deg,#EF4444,#DC2626)">
        Cancel This Booking
      </button>` : ''}
    </div>`;

  document.getElementById('bookingDetailModal').style.display = 'flex';
}

function closeBookingModal() {
  document.getElementById('bookingDetailModal').style.display = 'none';
}

async function cancelBooking(bookingId, bookingRef) {
  // Look up the payment for this booking first so we know whether a refund is needed
  const { data: payment } = await supabaseClient
    .from('payments')
    .select('id, stripe_payment_intent_id, amount, status, payment_method')
    .eq('booking_id', bookingId)
    .eq('status', 'succeeded')
    .maybeSingle();

  const isManualPayment = payment?.payment_method === 'manual';
  const needsStripeRefund = payment && payment.stripe_payment_intent_id && !isManualPayment;

  let confirmMsg = `Are you sure you want to cancel booking ${bookingRef}? This cannot be undone.`;
  if (needsStripeRefund) {
    confirmMsg += `\n\nThis will automatically refund $${parseFloat(payment.amount).toFixed(2)} NZD via Stripe.`;
  } else if (isManualPayment) {
    confirmMsg += `\n\nThis booking was paid manually — no automatic Stripe refund will be triggered. Refund the customer directly if needed.`;
  }
  if (!confirm(confirmMsg)) return;

  const { error } = await supabaseClient
    .from('bookings')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', bookingId);

  if (error) {
    alert('Cancel failed: ' + error.message);
    return;
  }

  // Release the timeslot by finding the booking's room/date/time
  const booking = allBookings.find(b => b.id === bookingId);
  if (booking) {
    await supabaseClient
      .from('booking_timeslots')
      .update({ status: 'released' })
      .eq('party_room_id', booking.party_room_id)
      .eq('slot_date', booking.party_date)
      .eq('slot_time', booking.party_time);
  }

  // Auto-refund via Stripe if there's a real payment intent attached
  let refundMsg = '';
  if (needsStripeRefund) {
    try {
      await callEdgeFunction('refund-payment', {
        paymentIntentId: payment.stripe_payment_intent_id,
        paymentId: payment.id,
        amount: Math.round(parseFloat(payment.amount) * 100),
      });
      await supabaseClient
        .from('payments')
        .update({ status: 'refunded', refunded_at: new Date().toISOString() })
        .eq('id', payment.id);
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
  const { count } = await supabaseClient
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'cancelled');

  if (!count || count === 0) {
    alert('No cancelled bookings to clear.');
    return;
  }

  if (!confirm(`Permanently delete all ${count} cancelled booking${count === 1 ? '' : 's'}? This cannot be undone.`)) return;

  const { data: cancelledBookings, error: fetchErr } = await supabaseClient
    .from('bookings')
    .select('id')
    .eq('status', 'cancelled');

  if (fetchErr) {
    alert('Failed to fetch cancelled bookings: ' + fetchErr.message);
    return;
  }

  const ids = (cancelledBookings || []).map(b => b.id);
  if (ids.length === 0) return;

  // Delete dependent payment records first (no FK cascade assumed)
  await supabaseClient.from('payments').delete().in('booking_id', ids);

  const { error: deleteErr } = await supabaseClient
    .from('bookings')
    .delete()
    .in('id', ids);

  if (deleteErr) {
    alert('Failed to delete cancelled bookings: ' + deleteErr.message);
    return;
  }

  alert(`✅ Cleared ${ids.length} cancelled booking${ids.length === 1 ? '' : 's'}.`);
  refreshCurrentTab();
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
async function loadPayments() {
  const tbody = document.getElementById('payments-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  const { data, error } = await supabaseClient
    .from('payments')
    .select(`
      id, stripe_payment_intent_id, amount, currency, status,
      card_brand, card_last4, cardholder_name,
      created_at, error_message,
      bookings ( booking_ref, contact_email )
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { console.error(error); return; }
  allPayments = data || [];
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
    const cardInfo = (p.card_brand && p.card_last4)
      ? `${p.card_brand.toUpperCase()} •••• ${p.card_last4}`
      : '—';
    return `
    <tr>
      <td>
        <div class="font-semibold text-sm">${p.cardholder_name || '—'}</div>
        <div class="text-xs text-gray-400">${cardInfo}</div>
      </td>
      <td>
        <div class="text-xs text-gray-400">${p.bookings?.contact_email || '—'}</div>
      </td>
      <td><span class="font-mono text-xs text-indigo-600">${p.bookings?.booking_ref || '—'}</span></td>
      <td class="font-bold">$${parseFloat(p.amount || 0).toFixed(2)} ${(p.currency || 'nzd').toUpperCase()}</td>
      <td><span class="badge ${p.status === 'succeeded' ? 'badge-green' : p.status === 'failed' ? 'badge-red' : 'badge-yellow'}">${p.status}</span></td>
      <td class="text-xs text-gray-500">${new Date(p.created_at).toLocaleString('en-NZ')}</td>
      <td>
        ${p.status === 'succeeded' ? `<button onclick="refundPayment('${p.id}', '${p.stripe_payment_intent_id}', ${p.amount})" class="text-xs text-red-500 hover:underline font-semibold">Refund</button>` : '—'}
      </td>
    </tr>`;
  }).join('');
}

async function refundPayment(paymentId, stripePaymentIntentId, amount) {
  if (!confirm(`Refund $${parseFloat(amount).toFixed(2)} NZD? This will be processed via Stripe immediately.`)) return;

  try {
    await callEdgeFunction('refund-payment', {
      paymentIntentId: stripePaymentIntentId,
      paymentId,
      amount: Math.round(amount * 100),
    });

    // Update local record
    await supabaseClient
      .from('payments')
      .update({ status: 'refunded', refunded_at: new Date().toISOString() })
      .eq('id', paymentId);

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

  const { data: users, error: usersError } = await supabaseClient
    .from('users')
    .select('id, first_name, last_name, email, phone, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  if (usersError) { console.error(usersError); return; }

  const { data: bookings, error: bookingsError } = await supabaseClient
    .from('bookings')
    .select('contact_email, total_amount, status');

  if (bookingsError) { console.error(bookingsError); return; }

  // Group bookings by contact_email for quick lookup
  const bookingsByEmail = {};
  (bookings || []).forEach(b => {
    const key = (b.contact_email || '').toLowerCase();
    if (!key) return;
    if (!bookingsByEmail[key]) bookingsByEmail[key] = [];
    bookingsByEmail[key].push(b);
  });

  allCustomers = (users || []).map(u => ({
    ...u,
    bookings: bookingsByEmail[(u.email || '').toLowerCase()] || [],
  }));

  renderCustomersTable(allCustomers);
}

function renderCustomersTable(customers) {
  const tbody = document.getElementById('customers-tbody');
  if (!tbody) return;

  if (!customers || customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-gray-400">No customers found.</td></tr>';
    return;
  }

  tbody.innerHTML = customers.map(c => {
    const nonCancelled = (c.bookings || []).filter(b => b.status !== 'cancelled');
    const totalSpent = nonCancelled.reduce((s, b) => s + parseFloat(b.total_amount || 0), 0);
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
    return `<tr>
      <td class="font-semibold text-sm">${name}</td>
      <td class="text-sm">${c.email || '—'}</td>
      <td class="text-sm">${c.phone || '—'}</td>
      <td class="font-semibold">$${totalSpent.toFixed(2)}</td>
    </tr>`;
  }).join('');
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
  await supabaseClient.auth.signOut();
  window.location.href = '/';
}

// Shared with admin context
async function callEdgeFunction(name, body = {}) {
  const { data, error } = await supabaseClient.functions.invoke(name, { body });
  if (error) throw new Error(error.message);
  return data;
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
  const selClass = selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white';
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
  const { data: roomRow } = await supabaseClient
    .from('party_rooms')
    .select('id')
    .eq('slug', slug)
    .single();

  abState.selectedRoomDbId = roomRow?.id || null;

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

  const { data: bookedSlots } = await supabaseClient
    .from('booking_timeslots')
    .select('slot_time, status, hold_expires_at')
    .eq('party_room_id', abState.selectedRoomDbId)
    .eq('slot_date', dateVal)
    .in('status', ['confirmed', 'held']);

  const unavailable = (bookedSlots || [])
    .filter(s => s.status === 'confirmed' || (s.status === 'held' && new Date(s.hold_expires_at) > new Date()))
    .map(s => s.slot_time);

  let html = '';
  AB_ALL_SLOTS.forEach(slot => {
    const isUnavailable = unavailable.includes(slot);
    const selected = abState.selectedTime === slot;
    const cls = isUnavailable
      ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
      : selected
        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 cursor-pointer'
        : 'border-gray-200 bg-white hover:border-indigo-300 cursor-pointer';
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
    c.classList.add('border-gray-200', 'bg-white');
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
      <div class="flex items-center justify-between bg-white rounded-lg p-2.5 border border-gray-100">
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
    const roomData = { id: abState.selectedRoomDbId, name: room.name };
    if (!roomData.id) throw new Error('Room not found. Make sure the schema is set up correctly.');

    // Check if slot is already taken (race condition guard)
    const { data: existingSlot } = await supabaseClient
      .from('booking_timeslots')
      .select('id, status')
      .eq('party_room_id', roomData.id)
      .eq('slot_date', date)
      .eq('slot_time', time)
      .single();

    if (existingSlot && existingSlot.status === 'confirmed') {
      throw new Error(`That time slot is already booked for ${roomData.name} on ${date}.`);
    }

    // Upsert user
    let userId = null;
    const { data: existingUser } = await supabaseClient
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      userId = existingUser.id;
      await supabaseClient.from('users').update({
        first_name: firstName, last_name: lastName, phone, updated_at: new Date().toISOString()
      }).eq('id', userId);
    } else {
      const newId = crypto.randomUUID();
      const { error: userErr } = await supabaseClient.from('users').insert({
        id: newId, first_name: firstName, last_name: lastName, email, phone,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (userErr) throw new Error('Could not create user: ' + userErr.message);
      userId = newId;
    }

    const bookingRef = 'WW-' + Date.now().toString(36).toUpperCase();

    const { data: booking, error: bookingErr } = await supabaseClient
      .from('bookings')
      .insert({
        user_id: userId,
        party_room_id: roomData.id,
        booking_ref: bookingRef,
        party_date: date,
        party_time: time,
        guest_count: guests,
        food_choice: foodChoice,
        allergy_notes: notes,
        addons_summary: addonsSummary,
        base_amount: baseAmount,
        addons_amount: addonsAmount,
        total_amount: totalAmount,
        status: status,
        contact_email: email,
        contact_phone: phone || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (bookingErr) throw new Error('Booking insert failed: ' + bookingErr.message);

    // Lock the time slot
    if (existingSlot) {
      await supabaseClient.from('booking_timeslots').update({
        status: 'confirmed', held_by_user_id: userId,
      }).eq('id', existingSlot.id);
    } else {
      await supabaseClient.from('booking_timeslots').insert({
        party_room_id: roomData.id,
        slot_date: date,
        slot_time: time,
        status: 'confirmed',
        held_by_user_id: userId,
      });
    }

    // Insert payment record
    if (totalAmount > 0) {
      await supabaseClient.from('payments').insert({
        user_id: userId,
        booking_id: booking.id,
        amount: totalAmount,
        currency: 'nzd',
        status: payStatus === 'paid' ? 'succeeded' : 'pending',
        payment_method: 'manual',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

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