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

  // Load initial tab
  await loadOverview();
});

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
  ] = await Promise.all([
    supabaseClient.from('bookings').select('*', { count: 'exact', head: true }),
    supabaseClient.from('payments').select('amount').eq('status', 'succeeded'),
    supabaseClient.from('users').select('*', { count: 'exact', head: true }),
    supabaseClient.from('bookings')
      .select('*', { count: 'exact', head: true })
      .gte('party_date', new Date().toISOString().split('T')[0])
      .lte('party_date', new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0])
      .eq('status', 'confirmed'),
  ]);

  const totalRevenue = (revenueData || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);

  document.getElementById('stat-bookings').textContent  = totalBookings ?? '—';
  document.getElementById('stat-revenue').textContent   = '$' + totalRevenue.toFixed(2);
  document.getElementById('stat-customers').textContent = totalCustomers ?? '—';
  document.getElementById('stat-upcoming').textContent  = upcomingCount ?? '—';

  // Upcoming list
  const { data: upcoming } = await supabaseClient
    .from('bookings')
    .select('booking_ref, party_date, party_time, guest_count, status, contact_email, party_rooms(name, emoji)')
    .gte('party_date', new Date().toISOString().split('T')[0])
    .order('party_date', { ascending: true })
    .limit(10);

  const list = document.getElementById('upcoming-bookings-list');
  if (!upcoming || upcoming.length === 0) {
    list.innerHTML = '<p class="text-gray-400 text-sm py-4">No upcoming parties.</p>';
    return;
  }

  list.innerHTML = upcoming.map(b => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div class="flex items-center gap-3">
        <span class="text-2xl">${b.party_rooms?.emoji || '🎉'}</span>
        <div>
          <div class="font-semibold text-sm text-gray-900">${b.party_rooms?.name || '—'} · ${b.guest_count} kids</div>
          <div class="text-xs text-gray-400">${b.party_date} @ ${b.party_time} · ${b.contact_email}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge ${b.status === 'confirmed' ? 'badge-green' : 'badge-yellow'}">${b.status}</span>
        <span class="text-xs text-gray-400 font-mono">${b.booking_ref}</span>
      </div>
    </div>`).join('');
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
      food_choice, total_amount, status, contact_email, contact_phone,
      created_at, allergy_notes, allergies, is_weekend,
      party_rooms ( name, emoji ),
      users ( first_name, last_name, email )
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
        <div class="font-semibold text-sm">${b.users?.first_name || ''} ${b.users?.last_name || ''}</div>
        <div class="text-xs text-gray-400">${b.contact_email}</div>
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
          ${b.status === 'confirmed' ? `<button onclick="cancelBooking('${b.id}', '${b.booking_ref}')" class="text-xs text-red-500 hover:underline font-semibold">Cancel</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

async function viewBooking(bookingId) {
  const booking = allBookings.find(b => b.id === bookingId);
  if (!booking) return;

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
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Guests</div>
          <div class="font-semibold">${booking.guest_count} children</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Food</div>
          <div class="font-semibold">${booking.food_choice || '—'}</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Total Paid</div>
          <div class="font-bold text-indigo-600">$${parseFloat(booking.total_amount || 0).toFixed(2)} NZD</div>
        </div>
        <div class="bg-gray-50 rounded-xl p-4">
          <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Pricing</div>
          <div class="font-semibold">${booking.is_weekend ? 'Weekend' : 'Weekday'}</div>
        </div>
      </div>
      <div class="bg-gray-50 rounded-xl p-4">
        <div class="text-xs text-gray-400 mb-1 uppercase font-semibold">Customer</div>
        <div class="font-semibold">${booking.users?.first_name || ''} ${booking.users?.last_name || ''}</div>
        <div class="text-sm text-gray-500">${booking.contact_email}</div>
        <div class="text-sm text-gray-500">${booking.contact_phone || '—'}</div>
      </div>
      ${(booking.allergies?.length || booking.allergy_notes) ? `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div class="text-xs text-amber-600 mb-1 uppercase font-semibold">⚠️ Dietary Requirements</div>
        <div class="font-semibold text-sm">${(booking.allergies || []).join(', ') || '—'}</div>
        ${booking.allergy_notes ? `<div class="text-sm text-gray-600 mt-1">${booking.allergy_notes}</div>` : ''}
      </div>` : ''}
      <div class="text-xs text-gray-400">Booked: ${new Date(booking.created_at).toLocaleString('en-NZ')}</div>
      ${booking.status === 'confirmed' ? `
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
  if (!confirm(`Are you sure you want to cancel booking ${bookingRef}? This cannot be undone.`)) return;

  const { error } = await supabaseClient
    .from('bookings')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', bookingId);

  if (error) {
    alert('Cancel failed: ' + error.message);
    return;
  }

  // Release the timeslot
  await supabaseClient
    .from('booking_timeslots')
    .update({ status: 'released' })
    .eq('booking_id', bookingId);

  closeBookingModal();
  alert('✅ Booking cancelled. Process refund in the Payments tab if needed.');
  await loadBookings();
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
      created_at, error_message,
      bookings ( booking_ref ),
      users ( first_name, last_name, email )
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

  tbody.innerHTML = payments.map(p => `
    <tr>
      <td><span class="font-mono text-xs text-gray-500">${(p.stripe_payment_intent_id || '—').slice(0, 20)}...</span></td>
      <td>
        <div class="font-semibold text-sm">${p.users?.first_name || ''} ${p.users?.last_name || ''}</div>
        <div class="text-xs text-gray-400">${p.users?.email || '—'}</div>
      </td>
      <td><span class="font-mono text-xs text-indigo-600">${p.bookings?.booking_ref || '—'}</span></td>
      <td class="font-bold">$${parseFloat(p.amount || 0).toFixed(2)} ${(p.currency || 'nzd').toUpperCase()}</td>
      <td><span class="badge ${p.status === 'succeeded' ? 'badge-green' : p.status === 'failed' ? 'badge-red' : 'badge-yellow'}">${p.status}</span></td>
      <td class="text-xs text-gray-500">${new Date(p.created_at).toLocaleString('en-NZ')}</td>
      <td>
        ${p.status === 'succeeded' ? `<button onclick="refundPayment('${p.id}', '${p.stripe_payment_intent_id}', ${p.amount})" class="text-xs text-red-500 hover:underline font-semibold">Refund</button>` : '—'}
      </td>
    </tr>`).join('');
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
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-gray-400">Loading...</td></tr>';

  const { data, error } = await supabaseClient
    .from('users')
    .select(`
      id, first_name, last_name, email, phone, created_at,
      bookings ( id, total_amount, status )
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { console.error(error); return; }
  allCustomers = data || [];
  renderCustomersTable(allCustomers);
}

function renderCustomersTable(customers) {
  const tbody = document.getElementById('customers-tbody');
  if (!tbody) return;

  if (!customers || customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-gray-400">No customers found.</td></tr>';
    return;
  }

  tbody.innerHTML = customers.map(c => {
    const confirmedBookings = (c.bookings || []).filter(b => b.status === 'confirmed');
    const totalSpent = confirmedBookings.reduce((s, b) => s + parseFloat(b.total_amount || 0), 0);
    return `<tr>
      <td>
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-sm">
            ${(c.first_name?.[0] || '?').toUpperCase()}
          </div>
          <div>
            <div class="font-semibold text-sm">${c.first_name || ''} ${c.last_name || ''}</div>
          </div>
        </div>
      </td>
      <td class="text-sm">${c.email}</td>
      <td class="text-sm">${c.phone || '—'}</td>
      <td>${confirmedBookings.length}</td>
      <td class="font-semibold">$${totalSpent.toFixed(2)}</td>
      <td class="text-xs text-gray-400">${new Date(c.created_at).toLocaleDateString('en-NZ')}</td>
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
      `${b.users?.first_name} ${b.users?.last_name}`.toLowerCase().includes(q)
    ));
  }
  if (currentTab === 'customers') {
    renderCustomersTable(allCustomers.filter(c =>
      (c.email || '').toLowerCase().includes(q) ||
      `${c.first_name} ${c.last_name}`.toLowerCase().includes(q)
    ));
  }
  if (currentTab === 'payments') {
    renderPaymentsTable(allPayments.filter(p =>
      (p.bookings?.booking_ref || '').toLowerCase().includes(q) ||
      (p.users?.email || '').toLowerCase().includes(q)
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
