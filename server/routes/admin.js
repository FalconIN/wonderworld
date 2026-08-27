const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAdmin } = require('../middleware/auth');
const { fetchAndStoreReviews } = require('../services/googleReviewsSync');
const { reclaimableHoldClause } = require('../services/holdExpiry');
const { assertBookingAllowedOnDate } = require('../services/bookingRules');
const { sendBookingConfirmation } = require('../services/bookingNotifications');

const TWILIO_CONFIGURED = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

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
      q = `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
                  b.party_time as "partyTime", b.guest_count as "guestCount",
                  b.status, b.contact_email as "contactEmail",
                  r.name as "roomName", r.emoji as "roomEmoji"
           FROM bookings b JOIN party_rooms r ON r.id = b.party_room_id
           WHERE b.party_date >= $1 AND b.party_date <= $2
           ORDER BY b.party_date ASC`;
      params = [from, to];
    } else {
      q = `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
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
    // minutesPastDue computed in Postgres against NZ wall-clock time (see the
    // matching comment in bookings.js's edit-window check) — the admin's
    // browser timezone is untrustworthy for this, so the Upcoming/Past split
    // in admin.js relies on this field instead of comparing party_date to a
    // client-side "today".
    let q = `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
                    b.party_time as "partyTime", b.guest_count as "guestCount",
                    b.food_choice as "foodChoice", b.total_amount as "totalAmount",
                    b.status, b.allergy_notes as "allergyNotes",
                    b.party_room_id as "partyRoomId", b.user_id as "userId",
                    b.contact_email as "contactEmail",
                    b.contact_phone as "contactPhone",
                    b.addons_summary as "addonsSummary",
                    b.base_amount as "baseAmount", b.addons_amount as "addonsAmount",
                    b.admin_notes as "adminNotes",
                    b.food_credit_amount as "foodCreditAmount",
                    b.created_at as "createdAt",
                    r.name as "roomName", r.emoji as "roomEmoji",
                    u.first_name as "firstName", u.last_name as "lastName",
                    COALESCE(pay.amount_paid, 0) as "amountPaid",
                    EXTRACT(EPOCH FROM (
                      now() - (b.party_date + CASE b.party_time
                        WHEN '9:30 AM'  THEN '09:30'::time
                        WHEN '11:30 AM' THEN '11:30'::time
                        WHEN '1:30 PM'  THEN '13:30'::time
                        WHEN '3:30 PM'  THEN '15:30'::time
                        WHEN '5:30 PM'  THEN '17:30'::time
                        ELSE '12:00'::time
                      END) AT TIME ZONE 'Pacific/Auckland'
                    )) / 60 as "minutesPastDue"
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
                    b.admin_notes as "adminNotes",
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

// GET /api/admin/bookings/:id
router.get('/bookings/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
              b.party_time as "partyTime", b.guest_count as "guestCount",
              b.food_choice as "foodChoice", b.total_amount as "totalAmount",
              b.status, b.allergy_notes as "allergyNotes",
              b.party_room_id as "partyRoomId", b.user_id as "userId",
              b.contact_email as "contactEmail",
              b.contact_phone as "contactPhone",
              b.addons_summary as "addonsSummary",
              b.base_amount as "baseAmount", b.addons_amount as "addonsAmount",
              b.admin_notes as "adminNotes",
              b.catering_choice as "cateringChoice", b.no_alcohol_ack as "noAlcoholAck",
              b.food_credit_amount as "foodCreditAmount",
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
       ) pay ON pay.booking_id = b.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
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

// POST /api/admin/bookings/:id/redeem-credit — mark a booking's accrued food
// credit (see bookings.food_credit_amount, POST /api/bookings/:id/reduce-guests)
// as used at the venue. There's no POS integration to redeem against, so
// this is an all-or-nothing "zero it out" action logged to admin_notes for
// an audit trail, rather than a partial-redemption balance.
router.post('/bookings/:id/redeem-credit', async (req, res) => {
  try {
    const { rows: [before] } = await pool.query(
      `SELECT food_credit_amount as "foodCreditAmount", admin_notes as "adminNotes" FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (!before) return res.status(404).json({ error: 'Booking not found' });
    if (parseFloat(before.foodCreditAmount) <= 0) {
      return res.status(400).json({ error: 'This booking has no outstanding food credit.' });
    }

    const note = `Food credit of $${parseFloat(before.foodCreditAmount).toFixed(2)} marked redeemed ${new Date().toISOString().slice(0, 10)} by ${req.user.email || req.user.uid}.`;
    const newNotes = before.adminNotes ? `${before.adminNotes}\n${note}` : note;

    await pool.query(
      `UPDATE bookings SET food_credit_amount = 0, admin_notes = $1, updated_at = now() WHERE id = $2`,
      [newNotes, req.params.id]
    );
    res.json({ ok: true });
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
       WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    // Delete the timeslot so the slot becomes bookable again. Scoped to this
    // booking's own id, not its (room, date, time) — deleting by the derived
    // triple would delete WHATEVER row currently occupies that slot, which
    // isn't necessarily this booking's own lock if the two were ever out of
    // sync (see the WW-CJYSR1/WW-KM6D1V legacy mismatch incident: cancelling
    // the wrong booking with that bug live would have freed a room a
    // different, still-valid paying customer actually held).
    await client.query(
      `DELETE FROM booking_timeslots WHERE booking_id = $1`,
      [req.params.id]
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

// PATCH /api/admin/bookings/:id — edit customer details, food, add-ons, guest count, notes, payment
router.patch('/bookings/:id', async (req, res) => {
  const { firstName, lastName, email, phone, guestCount, foodChoice, allergyNotes, addonsSummary, addonsAmount, baseAmount, totalAmount, bookingStatus, amountPaid, adminNotes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [before] } = await client.query(`SELECT total_amount FROM bookings WHERE id = $1`, [req.params.id]);
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }

    const allowedStatuses = ['confirmed', 'pending', 'cancelled'];
    const newStatus = allowedStatuses.includes(bookingStatus) ? bookingStatus : null;

    const baseParams = [guestCount, foodChoice, allergyNotes || '', addonsSummary || '', addonsAmount || 0,
       baseAmount, totalAmount, email || '', phone || null, adminNotes || ''];
    const statusClause = newStatus ? `status = $${baseParams.length + 1},` : '';
    if (newStatus) baseParams.push(newStatus);
    baseParams.push(req.params.id);
    const idIdx = baseParams.length;

    const { rows: [booking] } = await client.query(
      `UPDATE bookings
       SET guest_count = $1, food_choice = $2, allergy_notes = $3,
           addons_summary = $4, addons_amount = $5, base_amount = $6,
           total_amount = $7, contact_email = $8, contact_phone = $9,
           admin_notes = $10,
           ${statusClause} updated_at = now()
       WHERE id = $${idIdx}
       RETURNING user_id`,
      baseParams
    );
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }

    // Cancelling here (rather than via the dedicated cancel button) used to
    // leave the timeslot locked forever — this mirrors the release the
    // dedicated PATCH /bookings/:id/cancel endpoint does, so a slot cancelled
    // through the edit-details form doesn't stay permanently ghost-locked.
    // Scoped to this booking's own id, not its (room, date, time) — see the
    // matching fix on PATCH /bookings/:id/cancel for why deleting by the
    // derived triple is unsafe if the lock and the booking were ever out of
    // sync (WW-CJYSR1/WW-KM6D1V legacy incident).
    if (newStatus === 'cancelled') {
      await client.query(
        `DELETE FROM booking_timeslots WHERE booking_id = $1`,
        [req.params.id]
      );
    }

    await client.query(
      `INSERT INTO booking_edits
         (booking_id, changed_by, change_type, delta_amount, new_guest_count, new_food_choice, new_addons_summary)
       VALUES ($1, $2, 'admin_edit', $3, $4, $5, $6)`,
      [req.params.id, req.user.uid, (parseFloat(totalAmount) || 0) - parseFloat(before.total_amount || 0),
       guestCount, foodChoice || null, addonsSummary || null]
    );

    if (booking.user_id) {
      // Check if this user is shared across other bookings
      const { rows: others } = await client.query(
        `SELECT id FROM bookings WHERE user_id = $1 AND id != $2 LIMIT 1`,
        [booking.user_id, req.params.id]
      );

      if (others.length > 0) {
        // Shared user — create a new independent user record for this booking only
        const newUserId = require('crypto').randomUUID();
        await client.query(
          `INSERT INTO users (id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5)`,
          [newUserId, firstName || '', lastName || '', email || '', phone || null]
        );
        await client.query(`UPDATE bookings SET user_id = $1 WHERE id = $2`, [newUserId, req.params.id]);
      } else {
        // Sole booking on this user — safe to update in place
        await client.query(
          `UPDATE users SET first_name = $1, last_name = $2, email = $3, phone = $4, updated_at = now() WHERE id = $5`,
          [firstName || '', lastName || '', email || '', phone || null, booking.user_id]
        );
      }
    }

    // Update amount paid — this field is pre-filled in the edit form with the
    // booking's already-COMBINED paid total (real Stripe/POLi payments plus
    // any prior manual record), and gets resubmitted as-is on every save of
    // this form even when the admin only changed something unrelated like a
    // phone number. Replacing the whole 'manual' payments row with that
    // combined figure used to insert a brand-new manual row for the FULL
    // amount on every such save, stacking on top of the real payment row
    // (which is never touched here) and doubling — or, on repeated saves,
    // compounding — the recorded amount paid. Only the difference between
    // what's submitted and what's actually been charged via a real payment
    // should ever land in the manual row.
    if (amountPaid !== undefined) {
      const requestedPaid = Math.max(0, parseFloat(amountPaid) || 0);
      const { rows: [realPaidRow] } = await client.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM payments
         WHERE booking_id = $1 AND status = 'succeeded' AND payment_method IS DISTINCT FROM 'manual'`,
        [req.params.id]
      );
      const manualAmount = requestedPaid - parseFloat(realPaidRow.total);

      await client.query(`DELETE FROM payments WHERE booking_id = $1 AND payment_method = 'manual'`, [req.params.id]);
      if (manualAmount > 0.005) {
        await client.query(
          `INSERT INTO payments (booking_id, user_id, amount, currency, status, payment_method)
           VALUES ($1, $2, $3, 'nzd', 'succeeded', 'manual')`,
          [req.params.id, booking.user_id, manualAmount]
        );
      }
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

    // payments.booking_id is ON DELETE SET NULL — deleting the booking preserves
    // the payment row (financial/accounting record) instead of destroying it.
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

// POST /api/admin/customers/bulk-delete — bulk delete non-admin users by ID array.
// Users with existing bookings are skipped rather than attempted (bookings.user_id
// is ON DELETE RESTRICT, so including even one such id would previously fail the
// entire batch with a raw FK-violation error and no indication of which id blocked it).
router.post('/customers/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No IDs provided' });
  }
  try {
    const { rows: withBookings } = await pool.query(
      `SELECT DISTINCT user_id FROM bookings WHERE user_id = ANY($1::text[])`,
      [ids]
    );
    const blockedIds = new Set(withBookings.map(r => r.user_id));
    const deletableIds = ids.filter(id => !blockedIds.has(id));

    let deleted = 0;
    if (deletableIds.length) {
      const result = await pool.query(
        `DELETE FROM users WHERE id = ANY($1::text[]) AND is_admin = false`,
        [deletableIds]
      );
      deleted = result.rowCount;
    }
    res.json({ deleted, skipped: blockedIds.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/payments?limit=&from=&to=
router.get('/payments', async (req, res) => {
  const { from, to } = req.query;
  const hasRange = from && to;
  const limit = parseInt(req.query.limit) || (hasRange ? 1000 : 200);
  try {
    const dateClause = hasRange ? `WHERE p.created_at::date BETWEEN $1 AND $2` : '';
    const params = hasRange ? [from, to, limit] : [limit];
    const { rows } = await pool.query(
      `SELECT p.id, p.stripe_payment_intent_id as "stripePaymentIntentId",
              p.amount, p.currency, p.status, p.payment_method as "paymentMethod",
              p.card_brand as "cardBrand", p.card_last4 as "cardLast4",
              p.cardholder_name as "cardholderName",
              p.created_at as "createdAt", p.error_message as "errorMessage",
              b.id as "bookingId", b.booking_ref as "bookingRef", b.contact_email as "contactEmail",
              u.first_name as "userFirstName"
       FROM payments p
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN users u ON u.id = COALESCE(p.user_id, b.user_id)
       ${dateClause}
       ORDER BY p.created_at DESC LIMIT $${hasRange ? 3 : 1}`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/payments/summary?from=&to= — defaults to the current month
router.get('/payments/summary', async (req, res) => {
  const { from, to } = req.query;
  const hasRange = from && to;
  try {
    const dateClause = hasRange
      ? `WHERE created_at::date BETWEEN $1 AND $2`
      : `WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)`;
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) as revenue,
         COUNT(*) FILTER (WHERE status = 'succeeded') as "successCount",
         COALESCE(SUM(amount) FILTER (WHERE status = 'refunded'), 0) as "refundedAmount",
         COUNT(*) FILTER (WHERE status = 'refunded') as "refundedCount",
         COUNT(*) FILTER (WHERE status = 'pending') as "pendingCount",
         COUNT(*) FILTER (WHERE status = 'failed') as "failedCount",
         COUNT(*) FILTER (WHERE payment_method = 'manual' AND status = 'succeeded') as "manualCount"
       FROM payments
       ${dateClause}`,
      hasRange ? [from, to] : []
    );
    const r = rows[0];
    res.json({
      revenue:        parseFloat(r.revenue),
      successCount:   parseInt(r.successCount),
      refundedAmount: parseFloat(r.refundedAmount),
      refundedCount:  parseInt(r.refundedCount),
      pendingCount:   parseInt(r.pendingCount),
      failedCount:    parseInt(r.failedCount),
      manualCount:    parseInt(r.manualCount),
    });
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
  const { limit = 5000 } = req.query;
  try {
    const { rows: users } = await pool.query(
      `SELECT id, first_name as "firstName", last_name as "lastName",
              email, phone, is_admin as "isAdmin", created_at as "createdAt"
       FROM users ORDER BY created_at DESC LIMIT $1`,
      [parseInt(limit)]
    );
    const { rows: bookings } = await pool.query(
      `SELECT user_id as "userId", total_amount as "totalAmount", status FROM bookings`
    );
    const byUserId = {};
    bookings.forEach(b => {
      if (!b.userId) return;
      if (!byUserId[b.userId]) byUserId[b.userId] = [];
      byUserId[b.userId].push(b);
    });
    const result = users.map(u => ({ ...u, bookings: byUserId[u.id] || [] }));
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
    const { rows } = await pool.query(
      `SELECT id, slug, name, min_guests as "minGuests", max_guests as "maxGuests" FROM party_rooms WHERE is_active = true`
    );
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

      // Validate guest count against the room's capacity (mirrors the check
      // in the customer-facing booking flow, which this admin path bypasses).
      const { rows: [room] } = await client.query(
        `SELECT min_guests as "minGuests", max_guests as "maxGuests" FROM party_rooms WHERE id = $1`,
        [r.matchedRoomId]
      );
      if (!room) throw new Error('Room not found.');
      if (!r.guests || r.guests < room.minGuests || r.guests > room.maxGuests) {
        throw new Error(`Guest count ${r.guests} is outside this room's allowed range (${room.minGuests}-${room.maxGuests}).`);
      }

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

      // Fast-path check for a friendly per-row failure message — NOT the
      // actual safety mechanism; see the atomic claim after the booking row
      // is inserted below. A plain SELECT-then-conditionally-write here (the
      // previous version) left a window between this check and the write
      // where a concurrent import/manual booking or customer checkout could
      // claim the same slot; the later write would then silently overwrite
      // that claim's lock instead of failing — see the WW-CJYSR1/WW-KM6D1V
      // legacy incident this pattern produced when it lived in the
      // customer-facing flow, closed there by the same atomic-claim fix.
      await client.query(
        `DELETE FROM booking_timeslots
         WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3
           AND status = 'held' AND ${reclaimableHoldClause()}`,
        [r.matchedRoomId, r.date, r.time]
      );
      const { rows: [slotPreview] } = await client.query(
        `SELECT status FROM booking_timeslots WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3`,
        [r.matchedRoomId, r.date, r.time]
      );
      if (slotPreview && slotPreview.status !== 'released') throw new Error(`Slot already booked: ${r.date} ${r.time}`);

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

      // Atomic claim-then-write, same pattern as /reschedule and
      // /change-room: the INSERT..ON CONFLICT and its WHERE guard run
      // together under Postgres's own row lock for the conflicting row, so a
      // concurrent writer racing for this exact slot serializes instead of
      // silently clobbering this claim (or being clobbered by it).
      const { rows: claimed } = await client.query(
        `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, held_by_user_id, booking_id)
         VALUES ($1, $2, $3, 'confirmed', $4, $5)
         ON CONFLICT (party_room_id, slot_date, slot_time) DO UPDATE
           SET status = 'confirmed', booking_id = EXCLUDED.booking_id,
               held_by_user_id = EXCLUDED.held_by_user_id, hold_expires_at = NULL
           WHERE booking_timeslots.status = 'released'
              OR (booking_timeslots.status = 'held' AND ${reclaimableHoldClause('booking_timeslots')})
         RETURNING id`,
        [r.matchedRoomId, r.date, r.time, userId, booking.id]
      );
      if (claimed.length === 0) throw new Error(`Slot already booked: ${r.date} ${r.time}`);

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
    amountPaid, status = 'confirmed', adminNotes, cateringChoice, noAlcoholAck,
  } = req.body;

  // Blank name/email on an admin-created (e.g. phone) booking used to save as
  // blank/null, which read as broken data in the booking lists. Default them
  // instead. Email specifically defaults to a real address (not the literal
  // "ADMIN") because users.email is validated elsewhere in the app against
  // /^[^@]+@[^@]+\.[^@]+$/ and must stay unique/non-null in the DB.
  const ADMIN_PLACEHOLDER_EMAIL = 'admin@wonderworldwestgate.co.nz';
  const resolvedFirstName = (firstName || '').trim() || 'ADMIN';
  const resolvedLastName = (lastName || '').trim();
  const resolvedEmail = (email || '').trim().toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate guest count against the room's capacity (mirrors the check
    // in the customer-facing booking flow, which this admin path bypasses).
    const { rows: [room] } = await client.query(
      `SELECT name, min_guests as "minGuests", max_guests as "maxGuests",
              pricing_model as "pricingModel", flat_price as "flatPrice",
              allowed_days_of_week
       FROM party_rooms WHERE id = $1`,
      [roomId]
    );
    if (!room) throw new Error('Selected room not found.');
    if (!guests || guests < room.minGuests || guests > room.maxGuests) {
      throw new Error(`${roomName} requires between ${room.minGuests} and ${room.maxGuests} guests.`);
    }
    // Same Fri/Sat-only (evening slot) / Sun-Mon-Tue-only (whole-venue)
    // day-of-week gate as the customer-facing flow — admins can still
    // override the room/date pairing itself, but not onto a day the
    // room/slot combination doesn't support at all.
    assertBookingAllowedOnDate({ name: room.name, allowed_days_of_week: room.allowed_days_of_week }, time, date);
    if (room.pricingModel === 'flat') {
      if (!['self_catering', 'venue_menu'].includes(cateringChoice)) {
        throw new Error('Please choose a catering option for this whole-venue booking.');
      }
      if (!noAlcoholAck) {
        throw new Error('Please acknowledge the no-alcohol policy for this whole-venue booking.');
      }
    }

    // Fast-path check for a friendly error message — NOT the actual safety
    // mechanism; see the atomic claim after the booking row is inserted
    // below. A plain SELECT-then-conditionally-write here (the previous
    // version) left a window between this check and the write where a
    // second concurrent manual booking (e.g. two staff both taking phone
    // bookings for the same popular slot) or a customer checkout hold could
    // claim the same slot; the later write would then silently overwrite
    // that claim's lock instead of failing — see the WW-CJYSR1/WW-KM6D1V
    // legacy incident this exact pattern produced when it lived in the
    // customer-facing flow, closed there by the same atomic-claim fix.
    await client.query(
      `DELETE FROM booking_timeslots
       WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3
         AND status = 'held' AND ${reclaimableHoldClause()}`,
      [roomId, date, time]
    );
    const { rows: [slotPreview] } = await client.query(
      `SELECT status FROM booking_timeslots WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3`,
      [roomId, date, time]
    );
    if (slotPreview && slotPreview.status !== 'released') throw new Error(`That time slot is already booked for ${roomName} on ${date}.`);

    // Upsert user. A real email keeps its own account, looked up/created by
    // that email as before. A blank email is NOT given a fresh random row
    // each time (users.email is UNIQUE NOT NULL, so a second blank-email
    // booking would previously crash on a duplicate-key error) — instead it
    // reuses one shared "ADMIN" placeholder account. Note: because bookings
    // has no name column of its own (only users.first_name/last_name via
    // user_id), this placeholder's name is shared across every blank-email
    // booking — if you type different names on two different blank-email
    // bookings, only the most recent one will display for both.
    let userId;
    if (resolvedEmail) {
      const { rows: existing } = await client.query(`SELECT id FROM users WHERE email = $1`, [resolvedEmail]);
      if (existing[0]) {
        userId = existing[0].id;
        await client.query(
          `UPDATE users SET first_name=$1, last_name=$2, phone=COALESCE($3,phone), updated_at=now() WHERE id=$4`,
          [resolvedFirstName, resolvedLastName, phone || null, userId]
        );
      } else {
        const newId = require('crypto').randomUUID();
        await client.query(
          `INSERT INTO users (id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5)`,
          [newId, resolvedFirstName, resolvedLastName, resolvedEmail, phone || null]
        );
        userId = newId;
      }
    } else {
      const { rows: existing } = await client.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_PLACEHOLDER_EMAIL]);
      if (existing[0]) {
        userId = existing[0].id;
        await client.query(
          `UPDATE users SET first_name=$1, last_name=$2, phone=COALESCE($3,phone), updated_at=now() WHERE id=$4`,
          [resolvedFirstName, resolvedLastName, phone || null, userId]
        );
      } else {
        const newId = require('crypto').randomUUID();
        await client.query(
          `INSERT INTO users (id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5)`,
          [newId, resolvedFirstName, resolvedLastName, ADMIN_PLACEHOLDER_EMAIL, phone || null]
        );
        userId = newId;
      }
    }

    const bookingRef = 'WW-' + Date.now().toString(36).toUpperCase();
    const { rows: [booking] } = await client.query(
      `INSERT INTO bookings (user_id, party_room_id, booking_ref, party_date, party_time,
          guest_count, food_choice, allergy_notes, addons_summary, base_amount, addons_amount,
          total_amount, status, contact_email, contact_phone, admin_notes,
          catering_choice, no_alcohol_ack)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [userId, roomId, bookingRef, date, time, guests, foodChoice, notes || '',
       addonsSummary || '', baseAmount, addonsAmount || 0, totalAmount,
       status, resolvedEmail || ADMIN_PLACEHOLDER_EMAIL, phone || null, adminNotes || '',
       room.pricingModel === 'flat' ? cateringChoice : null,
       room.pricingModel === 'flat' ? !!noAlcoholAck : false]
    );

    // Atomic claim-then-write, same pattern as /reschedule and /change-room:
    // the INSERT..ON CONFLICT and its WHERE guard run together under
    // Postgres's own row lock for the conflicting row, so a concurrent
    // writer racing for this exact slot serializes instead of silently
    // clobbering this claim (or being clobbered by it).
    const { rows: claimed } = await client.query(
      `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, held_by_user_id, booking_id)
       VALUES ($1, $2, $3, 'confirmed', $4, $5)
       ON CONFLICT (party_room_id, slot_date, slot_time) DO UPDATE
         SET status = 'confirmed', booking_id = EXCLUDED.booking_id,
             held_by_user_id = EXCLUDED.held_by_user_id, hold_expires_at = NULL
         WHERE booking_timeslots.status = 'released'
            OR (booking_timeslots.status = 'held' AND ${reclaimableHoldClause('booking_timeslots')})
       RETURNING id`,
      [roomId, date, time, userId, booking.id]
    );
    if (claimed.length === 0) throw new Error(`That time slot is already booked for ${roomName} on ${date}.`);

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

    // Unlike the customer-facing checkout flow, there's no browser waiting to
    // trigger this client-side — staff just filled in a form. Send it now,
    // server-side, same as the POLi return handler does. Only for bookings
    // actually confirmed (a manual booking can be entered as 'pending').
    if (status === 'confirmed') {
      sendBookingConfirmation({
        bookingRef, bookingId: booking.id, email: resolvedEmail || null, phone: phone || null,
        firstName: resolvedFirstName, lastName: resolvedLastName, roomName: room.name,
        partyDate: date, partyTime: time, guestCount: guests, foodChoice,
        addonsSummary, totalAmount,
        cateringChoice: room.pricingModel === 'flat' ? cateringChoice : null,
        noAlcoholAck: room.pricingModel === 'flat' ? !!noAlcoholAck : false,
      }).catch(err => console.error('Manual booking confirmation notification failed:', err));
    }
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

// GET /api/admin/today — today's run sheet
router.get('/today', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.party_time as "partyTime",
              b.guest_count as "guestCount", b.food_choice as "foodChoice",
              b.allergy_notes as "allergyNotes", b.addons_summary as "addonsSummary",
              b.contact_email as "contactEmail", b.contact_phone as "contactPhone",
              b.total_amount as "totalAmount",
              b.catering_choice as "cateringChoice", b.no_alcohol_ack as "noAlcoholAck",
              COALESCE(pay.amount_paid, 0) as "amountPaid",
              r.name as "roomName", r.emoji as "roomEmoji", r.color as "roomColor",
              u.first_name as "firstName", u.last_name as "lastName"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN (
         SELECT booking_id, SUM(amount) FILTER (WHERE status = 'succeeded') as amount_paid
         FROM payments GROUP BY booking_id
       ) pay ON pay.booking_id = b.id
       WHERE b.party_date = CURRENT_DATE AND b.status = 'confirmed'
       ORDER BY b.party_time ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/allergy-alerts — upcoming bookings next 14 days with allergy_notes
router.get('/allergy-alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
              b.party_time as "partyTime", b.allergy_notes as "allergyNotes",
              b.guest_count as "guestCount",
              r.name as "roomName", r.emoji as "roomEmoji",
              u.first_name as "firstName", u.last_name as "lastName"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.party_date >= CURRENT_DATE
         AND b.party_date <= CURRENT_DATE + INTERVAL '14 days'
         AND b.status = 'confirmed'
         AND b.allergy_notes IS NOT NULL AND trim(b.allergy_notes) != ''
       ORDER BY b.party_date ASC, b.party_time ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/balances-due
router.get('/balances-due', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
              b.party_time as "partyTime", b.total_amount as "totalAmount",
              COALESCE(pay.amount_paid, 0) as "amountPaid",
              (b.total_amount - COALESCE(pay.amount_paid, 0)) as "balanceDue",
              r.name as "roomName", r.emoji as "roomEmoji",
              u.first_name as "firstName", u.last_name as "lastName",
              b.contact_email as "contactEmail", b.contact_phone as "contactPhone"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN (
         SELECT booking_id, SUM(amount) FILTER (WHERE status = 'succeeded') as amount_paid
         FROM payments GROUP BY booking_id
       ) pay ON pay.booking_id = b.id
       WHERE b.status = 'confirmed'
         AND (b.total_amount - COALESCE(pay.amount_paid, 0)) > 0.005
       ORDER BY b.party_date ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/weekend-capacity — next 6 weekends (42 days) booked slots per day
// Counts confirmed + pending (cancelled bookings freed their slot and never count).
router.get('/weekend-capacity', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.party_date as "date",
              COUNT(*) FILTER (WHERE b.status = 'confirmed') as "confirmed",
              COUNT(*) FILTER (WHERE b.status = 'pending') as "pending"
       FROM bookings b
       WHERE b.status IN ('confirmed', 'pending')
         AND EXTRACT(DOW FROM b.party_date) IN (0, 6)
         AND b.party_date >= CURRENT_DATE
         AND b.party_date < CURRENT_DATE + INTERVAL '42 days'
       GROUP BY b.party_date
       ORDER BY b.party_date ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/food-prep?from=YYYY-MM-DD&to=YYYY-MM-DD — bookings in range for food totals
// Counts confirmed + pending (cancelled bookings never count).
router.get('/food-prep', async (req, res) => {
  try {
    let { from, to } = req.query;
    if (!from || !to) {
      // Defensive default: current week (Mon-Sun) if the caller omits the range.
      const now = new Date();
      const dow = now.getUTCDay(); // 0=Sun..6=Sat
      const diffToMonday = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() + diffToMonday);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      from = monday.toISOString().slice(0, 10);
      to = sunday.toISOString().slice(0, 10);
    }
    const { rows } = await pool.query(
      `SELECT b.booking_ref as "bookingRef", b.party_date as "date", b.party_time as "partyTime",
              b.food_choice as "foodChoice", b.guest_count as "guestCount",
              b.addons_summary as "addonsSummary", b.status,
              b.catering_choice as "cateringChoice",
              r.name as "roomName", r.emoji as "roomEmoji", r.pricing_model as "pricingModel"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.status IN ('confirmed', 'pending')
         AND b.party_date >= $1 AND b.party_date <= $2
       ORDER BY b.party_date ASC, b.party_time ASC`,
      [from, to]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/month-revenue — this month vs last month + pending count
router.get('/month-revenue', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(total_amount) FILTER (
           WHERE party_date >= DATE_TRUNC('month', CURRENT_DATE)
             AND status != 'cancelled'
         ), 0) as "thisMonth",
         COALESCE(SUM(total_amount) FILTER (
           WHERE party_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
             AND party_date < DATE_TRUNC('month', CURRENT_DATE)
             AND status != 'cancelled'
         ), 0) as "lastMonth",
         COUNT(*) FILTER (WHERE status = 'pending') as "pendingCount"
       FROM bookings`
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/bookings/:id/resend-confirmation
router.post('/bookings/:id/resend-confirmation', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.status,
              b.party_date as "partyDate", b.party_time as "partyTime",
              b.guest_count as "guestCount", b.food_choice as "foodChoice",
              b.addons_summary as "addonsSummary", b.total_amount as "totalAmount",
              b.contact_email as "contactEmail", b.contact_phone as "contactPhone",
              r.name as "roomName",
              u.first_name as "firstName", u.last_name as "lastName"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    const b = rows[0];
    if (b.status !== 'confirmed') {
      return res.status(400).json({ error: `Only confirmed bookings can have their confirmation resent (this one is ${b.status}).` });
    }

    const results = { email: null, sms: null };

    // Email via Resend
    if (!b.contactEmail) {
      results.email = 'skipped: no email on file';
    } else
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { data, error } = await resend.emails.send({
        from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
        to:      b.contactEmail,
        subject: `🎉 Party Booking Confirmed! Ref: ${b.bookingRef}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
            <div style="background:linear-gradient(135deg,#4F46E5,#7C3AED);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
              <div style="font-size:40px;margin-bottom:8px">🎉</div>
              <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Party Booking Confirmed!</h1>
              <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
            </div>
            <p style="font-size:15px;margin-bottom:20px">Hi <strong>${b.firstName || 'there'}</strong>! Your party is all locked in. Here's your summary:</p>
            <div style="background:#F9FAFB;border-radius:16px;padding:24px;margin-bottom:20px">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:6px">Booking Reference</div>
              <div style="font-size:22px;font-weight:700;color:#4F46E5;margin-bottom:20px">${b.bookingRef}</div>
              <table style="width:100%;font-size:14px;border-collapse:collapse">
                <tr><td style="padding:6px 0;color:#6B7280;width:40%">Room</td><td style="font-weight:600">${b.roomName}</td></tr>
                <tr><td style="padding:6px 0;color:#6B7280">Date &amp; Time</td><td style="font-weight:600">${b.partyDate} at ${b.partyTime}</td></tr>
                <tr><td style="padding:6px 0;color:#6B7280">Guests</td><td style="font-weight:600">${b.guestCount} kids</td></tr>
                <tr><td style="padding:6px 0;color:#6B7280">Food</td><td style="font-weight:600">${b.foodChoice || '—'}</td></tr>
                ${b.addonsSummary ? `<tr><td style="padding:6px 0;color:#6B7280">Add-ons</td><td style="font-weight:600">${b.addonsSummary}</td></tr>` : ''}
                <tr><td style="padding:10px 0 6px;color:#6B7280;border-top:1px solid #E5E7EB">Total Paid</td><td style="padding-top:10px;font-weight:700;font-size:16px;color:#4F46E5;border-top:1px solid #E5E7EB">$${parseFloat(b.totalAmount).toFixed(2)} NZD</td></tr>
                <tr><td style="padding:6px 0;color:#6B7280">Receipt to</td><td style="font-weight:600">${b.contactEmail}</td></tr>
              </table>
            </div>
            <div style="background:#FEF3C7;border-radius:12px;padding:16px;margin-bottom:20px;font-size:14px">
              <strong>📌 Good to know:</strong><br>
              All guests must wear grip or non-slip socks. No outdoor shoes in the playground.<br>
              Outside birthday cake is welcome! 🎂
            </div>
            <p style="font-size:13px;color:#6B7280">Our team will be in touch within 24 hours to confirm the final details.<br>Questions? Email us at <a href="mailto:bookings@wonderworldwestgate.co.nz" style="color:#4F46E5">bookings@wonderworldwestgate.co.nz</a></p>
            <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
          </div>
        `,
      });
      if (error) throw new Error(error.message);
      results.email = 'sent';
      await pool.query(
        'INSERT INTO email_logs (booking_id, email_type, recipient, resend_id, status) VALUES ($1, $2, $3, $4, $5)',
        [b.id, 'resend_confirmation', b.contactEmail, data?.id || null, 'sent']
      );
    } catch (err) {
      console.error('Resend confirmation email failed:', err.message);
      results.email = 'failed: ' + err.message;
    }

    // SMS via Twilio (only if phone on record)
    // Twilio isn't configured in this environment (no TWILIO_* env vars) —
    // without this guard the SDK constructor throws ("username is required",
    // treating the missing account SID as a Basic Auth username) on every
    // single call, every time an admin resends a confirmation. The other two
    // notification paths (bookingNotifications.js, notifications.js) already
    // check TWILIO_CONFIGURED before attempting; this one didn't.
    if (b.contactPhone && !TWILIO_CONFIGURED) {
      results.sms = 'skipped: Twilio not configured';
    } else if (b.contactPhone) {
      try {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const nzPhone = b.contactPhone.startsWith('+') ? b.contactPhone : '+64' + b.contactPhone.replace(/^0/, '');
        const msg = await client.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   nzPhone,
          body: `Wonder World Westgate: Hi ${b.firstName || 'there'}! Your party is confirmed 🎉 Ref: ${b.bookingRef}. ${b.roomName} on ${b.partyDate} @ ${b.partyTime}. Total: $${parseFloat(b.totalAmount).toFixed(2)}. See you soon!`,
        });
        results.sms = 'sent';
        await pool.query(
          'INSERT INTO sms_logs (booking_id, sms_type, recipient, twilio_sid, status) VALUES ($1, $2, $3, $4, $5)',
          [b.id, 'resend_confirmation', nzPhone, msg.sid, 'sent']
        );
      } catch (err) {
        console.error('Resend confirmation SMS failed:', err.message);
        results.sms = 'failed: ' + err.message;
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const RESCHEDULE_ALL_SLOTS = ['9:30 AM', '11:30 AM', '1:30 PM', '3:30 PM', '5:30 PM'];

// YYYY-MM-DD, and a real calendar date (rejects e.g. 2026-02-30)
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// GET /api/admin/bookings/:id/reschedule-slots?date=YYYY-MM-DD
// No time restrictions for admins — they can reschedule any booking at any time.
// `date` is the date being considered for the new slot; defaults to the
// booking's current party_date so the picker can pre-populate itself.
router.get('/bookings/:id/reschedule-slots', async (req, res) => {
  try {
    // to_char avoids handing a JS Date object (pg's default parser for `date`)
    // back to the client or into further string comparisons — see bookings.js
    // edit-window bug for what goes wrong when a Date object gets templated
    // into a string instead of formatted explicitly.
    const { rows: [booking] } = await pool.query(
      `SELECT b.party_room_id, b.party_time,
              to_char(b.party_date, 'YYYY-MM-DD') as party_date
       FROM bookings b
       WHERE b.id = $1 AND b.status = 'confirmed'`,
      [req.params.id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    const requestedDate = req.query.date || booking.party_date;
    if (!isValidDateStr(requestedDate)) {
      return res.status(400).json({ error: 'Invalid date.' });
    }

    // Expire stale holds
    await pool.query(
      `DELETE FROM booking_timeslots WHERE status = 'held' AND ${reclaimableHoldClause()}`
    );

    // Find the booking's own timeslot row (any status) so we can exclude it from "taken"
    const { rows: ownSlots } = await pool.query(
      `SELECT id FROM booking_timeslots WHERE booking_id = $1`,
      [req.params.id]
    );
    const ownSlotId = ownSlots[0]?.id || null;

    const { rows: takenRows } = await pool.query(
      `SELECT slot_time FROM booking_timeslots
       WHERE party_room_id = $1 AND slot_date = $2
         AND status IN ('confirmed', 'held')
         AND ($3::uuid IS NULL OR id != $3::uuid)`,
      [booking.party_room_id, requestedDate, ownSlotId]
    );

    const takenSlots = takenRows.map(r => r.slot_time);
    const isCurrentDate = requestedDate === booking.party_date;

    const slots = RESCHEDULE_ALL_SLOTS.map(time => {
      const isCurrent = isCurrentDate && time === booking.party_time;
      return {
        time,
        isCurrent,
        isTaken:   !isCurrent && takenSlots.includes(time),
        available: !isCurrent && !takenSlots.includes(time),
      };
    });

    res.json({
      currentDate:    booking.party_date,
      currentTime:    booking.party_time,
      requestedDate,
      slots,
      anyAvailable:   slots.some(s => s.available),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/bookings/:id/reschedule
// Admins have no time restriction — they can reschedule at any point, to any
// date and time, including today or within the next hour.
router.post('/bookings/:id/reschedule', async (req, res) => {
  const { newDate, newTime } = req.body;

  if (!isValidDateStr(newDate)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }
  if (!RESCHEDULE_ALL_SLOTS.includes(newTime)) {
    return res.status(400).json({ error: 'Invalid time slot.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: [booking] } = await client.query(
      `SELECT b.id, b.booking_ref, b.party_time, b.party_room_id,
              b.contact_email, b.contact_phone, b.user_id,
              to_char(b.party_date, 'YYYY-MM-DD') as party_date,
              u.first_name, r.name as room_name
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.id = $1 AND b.status = 'confirmed'
       FOR UPDATE OF b`,
      [req.params.id]
    );

    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found or not confirmed.' });
    }
    if (booking.party_date === newDate && booking.party_time === newTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That is already the current date and time.' });
    }

    const oldDate = booking.party_date;
    const oldTime = booking.party_time;

    // Atomically claim the target slot: the INSERT..ON CONFLICT and its WHERE
    // guard are evaluated together under the row lock Postgres takes for the
    // conflicting row, so two concurrent reschedules racing for the same
    // target slot serialize instead of one silently clobbering the other's
    // lock (the previous version checked "is it taken" and then upserted as
    // two separate statements, which left a window for exactly that race).
    // A plain 'released' row, or a 'held' row whose hold has expired, is fair
    // game to claim; a live 'confirmed' or 'held' row is not.
    const { rows: claimed } = await client.query(
      `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, booking_id)
       VALUES ($1, $2, $3, 'confirmed', $4)
       ON CONFLICT (party_room_id, slot_date, slot_time) DO UPDATE
         SET status = 'confirmed', booking_id = EXCLUDED.booking_id, held_by_user_id = NULL, hold_expires_at = NULL
         WHERE booking_timeslots.status = 'released'
            OR (booking_timeslots.status = 'held' AND ${reclaimableHoldClause('booking_timeslots')})
       RETURNING id`,
      [booking.party_room_id, newDate, newTime, booking.id]
    );
    if (claimed.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That time slot is already taken.' });
    }

    // Release the booking's old timeslot row (regardless of status) now that
    // the new one is safely claimed.
    await client.query(
      `UPDATE booking_timeslots SET status = 'released', booking_id = NULL
       WHERE booking_id = $1 AND id != $2`,
      [booking.id, claimed[0].id]
    );

    await client.query(
      `UPDATE bookings SET party_date = $1, party_time = $2, updated_at = now() WHERE id = $3`,
      [newDate, newTime, booking.id]
    );

    // Log the reschedule to booking_edits inside the same transaction, so the
    // audit row is guaranteed to exist whenever the reschedule itself succeeds.
    await client.query(
      `INSERT INTO booking_edits
         (booking_id, changed_by, change_type, delta_amount,
          old_party_date, old_party_time, new_party_date, new_party_time)
       VALUES ($1, $2, 'reschedule', 0, $3, $4, $5, $6)`,
      [booking.id, req.user.uid, oldDate, oldTime, newDate, newTime]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      oldDate,
      oldTime,
      newDate,
      newTime,
      bookingRef:   booking.booking_ref,
      contactEmail: booking.contact_email,
      contactPhone: booking.contact_phone,
      firstName:    booking.first_name,
      roomName:     booking.room_name,
      partyDate:    newDate,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

// GET /api/admin/bookings/:id/room-options
// Lists every active room alongside whether it's free at this booking's
// existing date/time and whether the booking's guest count fits its
// capacity, so the admin UI can grey out rooms that aren't actually a valid
// target before anyone picks one.
router.get('/bookings/:id/room-options', async (req, res) => {
  try {
    const { rows: [booking] } = await pool.query(
      `SELECT b.party_room_id as "currentRoomId", b.guest_count as "guestCount",
              b.party_time as "partyTime", to_char(b.party_date, 'YYYY-MM-DD') as "partyDate"
       FROM bookings b
       WHERE b.id = $1 AND b.status = 'confirmed'`,
      [req.params.id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    // Expire stale holds so they don't falsely block a room as taken.
    await pool.query(
      `DELETE FROM booking_timeslots WHERE status = 'held' AND ${reclaimableHoldClause()}`
    );

    const { rows: rooms } = await pool.query(
      `SELECT r.id, r.slug, r.name, r.emoji,
              r.min_guests as "minGuests", r.max_guests as "maxGuests",
              EXISTS (
                SELECT 1 FROM booking_timeslots t
                WHERE t.party_room_id = r.id
                  AND t.slot_date = $2 AND t.slot_time = $3
                  AND t.status IN ('confirmed', 'held')
                  AND t.booking_id != $1
              ) as "isTaken"
       FROM party_rooms r
       WHERE r.is_active = true
       ORDER BY r.sort_order`,
      [req.params.id, booking.partyDate, booking.partyTime]
    );

    res.json({
      currentRoomId: booking.currentRoomId,
      guestCount:    booking.guestCount,
      partyDate:     booking.partyDate,
      partyTime:     booking.partyTime,
      rooms: rooms.map(r => ({
        ...r,
        isCurrent:     r.id === booking.currentRoomId,
        fitsCapacity:  booking.guestCount >= r.minGuests && booking.guestCount <= r.maxGuests,
        available:     r.id !== booking.currentRoomId && !r.isTaken && booking.guestCount >= r.minGuests && booking.guestCount <= r.maxGuests,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/bookings/:id/change-room
// Moves a confirmed booking to a different room at its existing date/time.
// This is deliberately its own endpoint (rather than a field on the general
// PATCH /bookings/:id editor) because — like reschedule — it has to swap
// booking_timeslots rows atomically, not just update a column.
router.post('/bookings/:id/change-room', async (req, res) => {
  const { newRoomId } = req.body;
  if (!newRoomId) return res.status(400).json({ error: 'newRoomId is required.' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const { rows: [booking] } = await client.query(
      `SELECT b.id, b.booking_ref, b.guest_count, b.party_time, b.party_room_id,
              b.contact_email, b.contact_phone, b.user_id,
              to_char(b.party_date, 'YYYY-MM-DD') as party_date,
              u.first_name, r.name as room_name
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.id = $1 AND b.status = 'confirmed'
       FOR UPDATE OF b`,
      [req.params.id]
    );

    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found or not confirmed.' });
    }
    if (booking.party_room_id === newRoomId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That is already the current room.' });
    }

    const { rows: [newRoom] } = await client.query(
      `SELECT id, name, min_guests as "minGuests", max_guests as "maxGuests"
       FROM party_rooms WHERE id = $1 AND is_active = true`,
      [newRoomId]
    );
    if (!newRoom) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Selected room not found.' });
    }
    if (booking.guest_count < newRoom.minGuests || booking.guest_count > newRoom.maxGuests) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${newRoom.name} only fits ${newRoom.minGuests}-${newRoom.maxGuests} guests; this booking has ${booking.guest_count}.` });
    }

    const oldRoomId = booking.party_room_id;
    const oldRoomName = booking.room_name;

    // Same atomic claim-then-release pattern as /reschedule: the INSERT..ON
    // CONFLICT and its WHERE guard run together under the row lock Postgres
    // takes for the conflicting row, so two concurrent moves racing for the
    // same target slot serialize instead of one clobbering the other.
    const { rows: claimed } = await client.query(
      `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, booking_id)
       VALUES ($1, $2, $3, 'confirmed', $4)
       ON CONFLICT (party_room_id, slot_date, slot_time) DO UPDATE
         SET status = 'confirmed', booking_id = EXCLUDED.booking_id, held_by_user_id = NULL, hold_expires_at = NULL
         WHERE booking_timeslots.status = 'released'
            OR (booking_timeslots.status = 'held' AND ${reclaimableHoldClause('booking_timeslots')})
       RETURNING id`,
      [newRoomId, booking.party_date, booking.party_time, booking.id]
    );
    if (claimed.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That room is already booked for this date and time.' });
    }

    // Release the booking's old timeslot row now that the new one is claimed.
    await client.query(
      `UPDATE booking_timeslots SET status = 'released', booking_id = NULL
       WHERE booking_id = $1 AND id != $2`,
      [booking.id, claimed[0].id]
    );

    await client.query(
      `UPDATE bookings SET party_room_id = $1, updated_at = now() WHERE id = $2`,
      [newRoomId, booking.id]
    );

    // Room changes are permanent and irreversible from the admin's point of
    // view (no "undo" — moving back is just another change-room call), so
    // this audit row is the only record of what the room used to be.
    await client.query(
      `INSERT INTO booking_edits
         (booking_id, changed_by, change_type, delta_amount, old_party_room_id, new_party_room_id)
       VALUES ($1, $2, 'room_change', 0, $3, $4)`,
      [booking.id, req.user.uid, oldRoomId, newRoomId]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      oldRoomName,
      newRoomName: newRoom.name,
      bookingRef:   booking.booking_ref,
      contactEmail: booking.contact_email,
      contactPhone: booking.contact_phone,
      firstName:    booking.first_name,
      partyDate:    booking.party_date,
      partyTime:    booking.party_time,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

// GET /api/admin/reviews — all fetched reviews, including hidden
router.get('/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, author_name as "authorName", rating, text, time,
              profile_photo_url as "profilePhotoUrl", visible, is_manual as "isManual", created_at as "createdAt"
       FROM google_reviews
       ORDER BY time DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/reviews/:id — show/hide, or edit the text/author/rating of a review
router.patch('/reviews/:id', async (req, res) => {
  const { visible, authorName, rating, text } = req.body;
  const sets = [];
  const params = [];
  if (visible !== undefined) { params.push(!!visible); sets.push(`visible = $${params.length}`); }
  if (authorName !== undefined) { params.push(authorName); sets.push(`author_name = $${params.length}`); }
  if (rating !== undefined) { params.push(parseInt(rating)); sets.push(`rating = $${params.length}`); }
  if (text !== undefined) { params.push(text); sets.push(`text = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id);
  try {
    await pool.query(`UPDATE google_reviews SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reviews/fetch-now — manually trigger a Google reviews re-fetch
router.post('/reviews/fetch-now', async (req, res) => {
  try {
    const result = await fetchAndStoreReviews();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reviews/manual — bulk-add reviews pasted/parsed in the admin UI.
// Skips any row that already exists (same author_name + text) so re-pasting the
// same batch twice is harmless.
router.post('/reviews/manual', async (req, res) => {
  const { reviews } = req.body;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(400).json({ error: 'No reviews provided' });
  }
  let inserted = 0, skipped = 0;
  try {
    for (const r of reviews) {
      const authorName = (r.authorName || '').trim();
      const text = (r.text || '').trim();
      const rating = parseInt(r.rating);
      const time = parseInt(r.time);
      if (!authorName || !text || !rating || rating < 1 || rating > 5 || !time) {
        skipped++;
        continue;
      }
      const { rows: existing } = await pool.query(
        `SELECT id FROM google_reviews WHERE author_name = $1 AND text = $2`,
        [authorName, text]
      );
      if (existing.length) { skipped++; continue; }

      await pool.query(
        `INSERT INTO google_reviews (author_name, rating, text, time, visible, is_manual)
         VALUES ($1, $2, $3, $4, true, true)`,
        [authorName, rating, text, time]
      );
      inserted++;
    }
    res.json({ inserted, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/site-rating — the admin-set aggregate rating shown on the public site
router.get('/site-rating', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT rating, review_count as "reviewCount", updated_at as "updatedAt" FROM site_rating WHERE id = 1');
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/site-rating — set/update it
router.put('/site-rating', async (req, res) => {
  const rating = parseFloat(req.body.rating);
  const reviewCount = parseInt(req.body.reviewCount) || 0;
  if (!rating || rating < 0 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 0 and 5' });
  }
  try {
    await pool.query(
      `INSERT INTO site_rating (id, rating, review_count, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET rating = $1, review_count = $2, updated_at = now()`,
      [rating, reviewCount]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
