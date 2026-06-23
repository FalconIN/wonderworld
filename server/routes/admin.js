const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAdmin } = require('../middleware/auth');

// All routes require admin
router.use(requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [bookings, revenue, customers, upcoming, cancelled] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM bookings`),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM bookings WHERE status != 'cancelled'`),
      pool.query(`SELECT COUNT(*) FROM users`),
      pool.query(
        `SELECT COUNT(*) FROM bookings
         WHERE party_date >= CURRENT_DATE
           AND party_date <= CURRENT_DATE + INTERVAL '7 days'
           AND status = 'confirmed'`
      ),
      pool.query(`SELECT COUNT(*) FROM bookings WHERE status = 'cancelled'`),
    ]);

    res.json({
      totalBookings:   parseInt(bookings.rows[0].count),
      totalRevenue:    parseFloat(revenue.rows[0].total),
      totalCustomers:  parseInt(customers.rows[0].count),
      upcomingCount:   parseInt(upcoming.rows[0].count),
      cancelledCount:  parseInt(cancelled.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/bookings-list?from=&to=&limit=
router.get('/bookings-list', async (req, res) => {
  const { from, to, limit = 10 } = req.query;
  try {
    let q, params;
    if (from && to) {
      q = `SELECT b.booking_ref as "bookingRef", b.party_date as "partyDate",
                  b.party_time as "partyTime", b.guest_count as "guestCount",
                  b.status, b.contact_email as "contactEmail",
                  r.name as "roomName", r.emoji as "roomEmoji"
           FROM bookings b JOIN party_rooms r ON r.id = b.party_room_id
           WHERE b.party_date >= $1 AND b.party_date <= $2
           ORDER BY b.party_date ASC`;
      params = [from, to];
    } else {
      q = `SELECT b.booking_ref as "bookingRef", b.party_date as "partyDate",
                  b.party_time as "partyTime", b.guest_count as "guestCount",
                  b.status, b.contact_email as "contactEmail",
                  r.name as "roomName", r.emoji as "roomEmoji"
           FROM bookings b JOIN party_rooms r ON r.id = b.party_room_id
           WHERE b.party_date >= CURRENT_DATE
           ORDER BY b.party_date ASC LIMIT $1`;
      params = [parseInt(limit)];
    }
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/bookings?status=&limit=
router.get('/bookings', async (req, res) => {
  const { status, limit = 200 } = req.query;
  try {
    let q = `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
                    b.party_time as "partyTime", b.guest_count as "guestCount",
                    b.food_choice as "foodChoice", b.total_amount as "totalAmount",
                    b.status, b.allergy_notes as "allergyNotes",
                    b.party_room_id as "partyRoomId", b.user_id as "userId",
                    b.contact_email as "contactEmail",
                    b.contact_phone as "contactPhone",
                    b.addons_summary as "addonsSummary",
                    b.base_amount as "baseAmount", b.addons_amount as "addonsAmount",
                    b.created_at as "createdAt",
                    r.name as "roomName", r.emoji as "roomEmoji",
                    u.first_name as "firstName", u.last_name as "lastName",
                    COALESCE(pay.amount_paid, 0) as "amountPaid"
             FROM bookings b
             JOIN party_rooms r ON r.id = b.party_room_id
             LEFT JOIN users u ON u.id = b.user_id
             LEFT JOIN (
               SELECT booking_id, SUM(amount) FILTER (WHERE status = 'succeeded') as amount_paid
               FROM payments GROUP BY booking_id
             ) pay ON pay.booking_id = b.id`;
    const params = [];
    if (status) { q += ` WHERE b.status = $1`; params.push(status); }
    q += ` ORDER BY b.created_at DESC LIMIT ${parseInt(limit)}`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/bookings/export?from=&to=
router.get('/bookings/export', async (req, res) => {
  const { from, to } = req.query;
  try {
    let q = `SELECT b.booking_ref as "bookingRef", b.party_date as "partyDate",
                    b.party_time as "partyTime", b.guest_count as "guestCount",
                    b.food_choice as "foodChoice", b.addons_summary as "addonsSummary",
                    b.total_amount as "totalAmount", b.status,
                    b.contact_email as "contactEmail", b.created_at as "createdAt",
                    r.name as "roomName",
                    u.first_name as "firstName", u.last_name as "lastName"
             FROM bookings b
             JOIN party_rooms r ON r.id = b.party_room_id
             LEFT JOIN users u ON u.id = b.user_id`;
    const params = [];
    if (from && to) {
      q += ` WHERE b.party_date >= $1 AND b.party_date <= $2`;
      params.push(from, to);
    }
    q += ` ORDER BY b.party_date ASC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/payments/for-booking/:bookingId
router.get('/payments/for-booking/:bookingId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, stripe_payment_intent_id as "stripePaymentIntentId",
              amount, status, payment_method as "paymentMethod"
       FROM payments WHERE booking_id = $1 AND status = 'succeeded' LIMIT 1`,
      [req.params.bookingId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/bookings/:id/cancel
router.patch('/bookings/:id/cancel', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [booking] } = await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE id = $1 RETURNING party_room_id as "partyRoomId", party_date as "partyDate", party_time as "partyTime"`,
      [req.params.id]
    );
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    // Release the timeslot
    await client.query(
      `UPDATE booking_timeslots SET status = 'released'
       WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3`,
      [booking.partyRoomId, booking.partyDate, booking.partyTime]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/bookings/:id — edit customer details, food, add-ons, guest count, notes
router.patch('/bookings/:id', async (req, res) => {
  const { firstName, lastName, email, phone, guestCount, foodChoice, allergyNotes, addonsSummary, addonsAmount, baseAmount, totalAmount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [booking] } = await client.query(
      `UPDATE bookings
       SET guest_count = $1, food_choice = $2, allergy_notes = $3,
           addons_summary = $4, addons_amount = $5, base_amount = $6,
           total_amount = $7, contact_email = $8, contact_phone = $9,
           updated_at = now()
       WHERE id = $10
       RETURNING user_id`,
      [guestCount, foodChoice, allergyNotes || '', addonsSummary || '', addonsAmount || 0,
       baseAmount, totalAmount, email || '', phone || null, req.params.id]
    );
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }

    if (booking.user_id) {
      await client.query(
        `UPDATE users SET first_name = $1, last_name = $2, email = $3, phone = $4, updated_at = now() WHERE id = $5`,
        [firstName || '', lastName || '', email || '', phone || null, booking.user_id]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/bookings/cancelled
router.delete('/bookings/cancelled', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id FROM bookings WHERE status = 'cancelled'`);
    const ids = rows.map(r => r.id);
    if (!ids.length) { await client.query('ROLLBACK'); return res.json({ deleted: 0 }); }

    await client.query(`DELETE FROM payments WHERE booking_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query('COMMIT');
    res.json({ deleted: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/admin/payments?limit=
router.get('/payments', async (req, res) => {
  const { limit = 200 } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.stripe_payment_intent_id as "stripePaymentIntentId",
              p.amount, p.currency, p.status,
              p.card_brand as "cardBrand", p.card_last4 as "cardLast4",
              p.cardholder_name as "cardholderName",
              p.created_at as "createdAt", p.error_message as "errorMessage",
              b.booking_ref as "bookingRef", b.contact_email as "contactEmail"
       FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id
       ORDER BY p.created_at DESC LIMIT $1`,
      [parseInt(limit)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/payments/:id/refund
router.post('/payments/:id/refund', async (req, res) => {
  const { stripePaymentIntentId, amount } = req.body;
  try {
    if (stripePaymentIntentId) {
      await stripe.refunds.create({
        payment_intent: stripePaymentIntentId,
        amount: parseInt(amount),
      });
    }
    await pool.query(
      `UPDATE payments SET status = 'refunded', refunded_at = now(), updated_at = now() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/customers?limit=
router.get('/customers', async (req, res) => {
  const { limit = 200 } = req.query;
  try {
    const { rows: users } = await pool.query(
      `SELECT id, first_name as "firstName", last_name as "lastName",
              email, phone, is_admin as "isAdmin", created_at as "createdAt"
       FROM users ORDER BY created_at DESC LIMIT $1`,
      [parseInt(limit)]
    );
    const { rows: bookings } = await pool.query(
      `SELECT contact_email as email, total_amount as "totalAmount", status FROM bookings`
    );
    const byEmail = {};
    bookings.forEach(b => {
      const k = (b.email || '').toLowerCase();
      if (!byEmail[k]) byEmail[k] = [];
      byEmail[k].push(b);
    });
    const result = users.map(u => ({ ...u, bookings: byEmail[(u.email || '').toLowerCase()] || [] }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/revenue?range=30
router.get('/revenue', async (req, res) => {
  const { range } = req.query;
  try {
    let q = `SELECT DATE(created_at) as date, SUM(total_amount) as amount
             FROM bookings WHERE status != 'cancelled'`;
    const params = [];
    if (range && range !== 'all') {
      q += ` AND created_at >= NOW() - INTERVAL '${parseInt(range)} days'`;
    }
    q += ` GROUP BY DATE(created_at) ORDER BY date ASC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/bookings-by-month
router.get('/bookings-by-month', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT party_date as date, COUNT(*) as count
       FROM bookings
       WHERE status != 'cancelled'
         AND party_date >= DATE_TRUNC('month', CURRENT_DATE)
         AND party_date <= (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')
       GROUP BY party_date ORDER BY party_date`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/room-popularity
router.get('/room-popularity', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.name, COUNT(*) as count
       FROM bookings b JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.status != 'cancelled'
         AND b.party_date >= DATE_TRUNC('month', CURRENT_DATE)
         AND b.party_date <= (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')
       GROUP BY r.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/rooms — for room slug lookup (import tool)
router.get('/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, slug, name FROM party_rooms WHERE is_active = true`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/bookings/import
router.post('/bookings/import', async (req, res) => {
  const { rows: validRows } = req.body;
  let successCount = 0;
  const failures = [];

  for (const r of validRows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert user
      let userId;
      const { rows: existing } = await client.query(`SELECT id FROM users WHERE email = $1`, [r.email]);
      if (existing[0]) {
        userId = existing[0].id;
      } else {
        const newId = require('crypto').randomUUID();
        await client.query(
          `INSERT INTO users (id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5)`,
          [newId, r.firstName, r.lastName, r.email, r.phone || null]
        );
        userId = newId;
      }

      // Check slot
      const { rows: slot } = await client.query(
        `SELECT id, status FROM booking_timeslots WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3`,
        [r.matchedRoomId, r.date, r.time]
      );
      if (slot[0]?.status === 'confirmed') throw new Error(`Slot already booked: ${r.date} ${r.time}`);

      const bookingRef = 'WW-IMP-' + Math.random().toString(36).slice(2, 7).toUpperCase();
      const { rows: [booking] } = await client.query(
        `INSERT INTO bookings (user_id, party_room_id, booking_ref, party_date, party_time, guest_count,
            food_choice, allergy_notes, addons_summary, base_amount, addons_amount, total_amount,
            status, contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'confirmed',$13,$14)
         RETURNING id`,
        [userId, r.matchedRoomId, bookingRef, r.date, r.time, r.guests,
         r.food || '', r.notes || '', r.addonsSummary || '',
         r.baseAmount, r.addonsAmount, r.price, r.email, r.phone || null]
      );

      if (slot[0]) {
        await client.query(`UPDATE booking_timeslots SET status = 'confirmed', booking_id = $1 WHERE id = $2`, [booking.id, slot[0].id]);
      } else {
        await client.query(
          `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, held_by_user_id, booking_id)
           VALUES ($1,$2,$3,'confirmed',$4,$5)`,
          [r.matchedRoomId, r.date, r.time, userId, booking.id]
        );
      }

      await client.query('COMMIT');
      successCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      failures.push(`${r.firstName} ${r.lastName} (${r.date} ${r.time}): ${err.message}`);
    } finally {
      client.release();
    }
  }

  res.json({ success: successCount, failed: failures.length, messages: failures });
});

// POST /api/admin/bookings/manual — admin manually adds a booking
router.post('/bookings/manual', async (req, res) => {
  const {
    firstName, lastName, email, phone,
    roomId, roomName, date, time, guests,
    foodChoice, notes, addonsSummary, addonsAmount, baseAmount, totalAmount,
    amountPaid, status = 'confirmed',
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check slot
    const { rows: slot } = await client.query(
      `SELECT id, status FROM booking_timeslots WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3`,
      [roomId, date, time]
    );
    if (slot[0]?.status === 'confirmed') throw new Error(`That time slot is already booked for ${roomName} on ${date}.`);

    // Upsert user (email optional — if blank, always create a new record)
    let userId;
    if (email) {
      const { rows: existing } = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
      if (existing[0]) {
        userId = existing[0].id;
        await client.query(
          `UPDATE users SET first_name=$1, last_name=$2, phone=COALESCE($3,phone), updated_at=now() WHERE id=$4`,
          [firstName || '', lastName || '', phone || null, userId]
        );
      } else {
        const newId = require('crypto').randomUUID();
        await client.query(
          `INSERT INTO users (id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5)`,
          [newId, firstName || '', lastName || '', email, phone || null]
        );
        userId = newId;
      }
    } else {
      const newId = require('crypto').randomUUID();
      await client.query(
        `INSERT INTO users (id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5)`,
        [newId, firstName || '', lastName || '', '', phone || null]
      );
      userId = newId;
    }

    const bookingRef = 'WW-' + Date.now().toString(36).toUpperCase();
    const { rows: [booking] } = await client.query(
      `INSERT INTO bookings (user_id, party_room_id, booking_ref, party_date, party_time,
          guest_count, food_choice, allergy_notes, addons_summary, base_amount, addons_amount,
          total_amount, status, contact_email, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [userId, roomId, bookingRef, date, time, guests, foodChoice, notes || '',
       addonsSummary || '', baseAmount, addonsAmount || 0, totalAmount,
       status, email || '', phone || null]
    );

    if (slot[0]) {
      await client.query(`UPDATE booking_timeslots SET status='confirmed', booking_id=$1, held_by_user_id=$2 WHERE id=$3`, [booking.id, userId, slot[0].id]);
    } else {
      await client.query(
        `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, held_by_user_id, booking_id)
         VALUES ($1,$2,$3,'confirmed',$4,$5)`,
        [roomId, date, time, userId, booking.id]
      );
    }

    const paid = parseFloat(amountPaid) || 0;
    if (paid > 0) {
      await client.query(
        `INSERT INTO payments (booking_id, user_id, amount, currency, status, payment_method)
         VALUES ($1,$2,$3,'nzd','succeeded','manual')`,
        [booking.id, userId, paid]
      );
    }

    await client.query('COMMIT');
    res.json({ bookingRef, bookingId: booking.id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/admin/users/:id/set-admin
router.post('/users/:id/set-admin', async (req, res) => {
  const { isAdmin } = req.body;
  if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be a boolean' });
  try {
    const { rowCount } = await pool.query(
      'UPDATE users SET is_admin = $1, updated_at = now() WHERE id = $2',
      [isAdmin, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
