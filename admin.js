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

  // Upcoming list (includes cancelled so admins see the full picture)
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
  if (!confirm(`Are you sure you want to cancel booking ${bookingRef}? This cannot be undone.`)) return;

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

// ---------------------------------------------------------------------------
// Add Booking Modal
// ---------------------------------------------------------------------------
const ROOM_SLUGS = {
  big: 'big',
  sunshine: 'sunshine',
  dream: 'dream',
  forest: 'forest',
};

function openAddBookingModal() {
  // Set min date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('ab_date').min = today;
  document.getElementById('ab_date').value = today;
  document.getElementById('addBookingModal').style.display = 'flex';
  document.getElementById('addBookingError').classList.add('hidden');
}

function closeAddBookingModal() {
  document.getElementById('addBookingModal').style.display = 'none';
}

async function submitAddBooking() {
  const btn = document.getElementById('addBookingBtn');
  const btnText = document.getElementById('addBookingBtnText');
  const spinner = document.getElementById('addBookingBtnSpinner');
  const errEl = document.getElementById('addBookingError');

  // Get values
  const firstName = document.getElementById('ab_firstName').value.trim();
  const lastName  = document.getElementById('ab_lastName').value.trim();
  const email     = document.getElementById('ab_email').value.trim().toLowerCase();
  const phone     = document.getElementById('ab_phone').value.trim();
  const roomId    = document.getElementById('ab_room').value;
  const date      = document.getElementById('ab_date').value;
  const time      = document.getElementById('ab_time').value;
  const guests    = parseInt(document.getElementById('ab_guests').value);
  const food      = document.getElementById('ab_food').value;
  const notes     = document.getElementById('ab_notes').value.trim();
  const amount    = parseFloat(document.getElementById('ab_amount').value) || 0;
  const payStatus = document.getElementById('ab_payStatus').value;
  const status    = document.getElementById('ab_status').value;

  // Validate
  if (!firstName) { errEl.textContent = 'First name is required.'; errEl.classList.remove('hidden'); return; }
  if (!lastName)  { errEl.textContent = 'Last name is required.';  errEl.classList.remove('hidden'); return; }
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { errEl.textContent = 'Valid email is required.'; errEl.classList.remove('hidden'); return; }
  if (!date)   { errEl.textContent = 'Party date is required.';  errEl.classList.remove('hidden'); return; }
  if (!time)   { errEl.textContent = 'Time slot is required.';   errEl.classList.remove('hidden'); return; }
  if (!guests || guests < 1) { errEl.textContent = 'Number of kids is required.'; errEl.classList.remove('hidden'); return; }
  if (!food)   { errEl.textContent = 'Food choice is required.'; errEl.classList.remove('hidden'); return; }
  if (!amount || amount <= 0) { errEl.textContent = 'Amount paid is required.'; errEl.classList.remove('hidden'); return; }

  btn.disabled = true;
  btnText.classList.add('hidden');
  spinner.classList.remove('hidden');
  errEl.classList.add('hidden');

  try {
    // 1. Get the party room DB id from slug
    const slug = ROOM_SLUGS[roomId];
    const { data: roomData, error: roomErr } = await supabaseClient
      .from('party_rooms')
      .select('id, name')
      .eq('slug', slug)
      .single();

    if (roomErr || !roomData) throw new Error('Room not found. Make sure the schema is set up correctly.');

    // 2. Check if slot is already taken
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

    // 3. Upsert a user profile (or find existing)
    // We look up by email in auth — if not found we create a placeholder user row
    let userId = null;
    const { data: existingUser } = await supabaseClient
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      userId = existingUser.id;
      // Update their name/phone if we have it
      await supabaseClient.from('users').update({
        first_name: firstName, last_name: lastName, phone, updated_at: new Date().toISOString()
      }).eq('id', userId);
    } else {
      // Create a placeholder user row with a generated UUID
      const newId = crypto.randomUUID();
      const { error: userErr } = await supabaseClient.from('users').insert({
        id: newId, first_name: firstName, last_name: lastName, email, phone,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (userErr) throw new Error('Could not create user: ' + userErr.message);
      userId = newId;
    }

    // 4. Generate booking ref
    const bookingRef = 'WW-' + Date.now().toString(36).toUpperCase();

    // 5. Insert booking
    const { data: booking, error: bookingErr } = await supabaseClient
      .from('bookings')
      .insert({
        user_id: userId,
        party_room_id: roomData.id,
        booking_ref: bookingRef,
        party_date: date,
        party_time: time,
        guest_count: guests,
        food_choice: food,
        allergy_notes: notes,
        total_amount: amount,
        status: status,
        contact_email: email,
        contact_phone: phone || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (bookingErr) throw new Error('Booking insert failed: ' + bookingErr.message);

    // 6. Lock the time slot as confirmed so it greys out on the live site
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

    // 7. Insert payment record if paid
    if (amount > 0) {
      await supabaseClient.from('payments').insert({
        user_id: userId,
        booking_id: booking.id,
        amount: amount,
        currency: 'nzd',
        status: payStatus === 'paid' ? 'succeeded' : payStatus === 'partial' ? 'succeeded' : 'pending',
        payment_method: 'manual',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // 8. Done!
    closeAddBookingModal();
    alert(`✅ Booking created!\nRef: ${bookingRef}\nThe time slot is now greyed out on the live site.`);
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
