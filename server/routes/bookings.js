const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/auth');

// GET /api/rooms — public room list
router.get('/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, name, emoji, tag_line as "tagLine", color,
              min_guests as "minGuests", max_guests as "maxGuests",
              base_price_per_child as "basePricePerChild",
              weekday_total as "weekdayTotal", weekend_total as "weekendTotal"
       FROM party_rooms WHERE is_active = true ORDER BY sort_order`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/by-slug/:slug — get room id by slug
router.get('/rooms/by-slug/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM party_rooms WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Room not found' });
    res.json({ id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/slots?room_slug=&date=  — get unavailable slot times
router.get('/slots', async (req, res) => {
  const { room_slug, room_id, date, excludeHoldId } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  try {
    // Clean up expired holds first
    await pool.query(
      `DELETE FROM booking_timeslots WHERE status = 'held' AND hold_expires_at < now()`
    );

    let roomId = room_id;
    if (!roomId && room_slug) {
      const { rows } = await pool.query('SELECT id FROM party_rooms WHERE slug = $1', [room_slug]);
      if (!rows[0]) return res.json({ roomId: null, unavailableSlots: [] });
      roomId = rows[0].id;
    }

    const { rows } = await pool.query(
      `SELECT slot_time as "slotTime"
       FROM booking_timeslots
       WHERE party_room_id = $1 AND slot_date = $2
         AND status IN ('confirmed', 'held')
         AND ($3::uuid IS NULL OR id != $3::uuid)`,
      [roomId, date, excludeHoldId || null]
    );

    const unavailableSlots = rows.map(r => r.slotTime);
    res.json({ roomId, unavailableSlots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/slots/hold — create a 15-min slot hold
router.post('/slots/hold', requireAuth, async (req, res) => {
  const { roomId, date, slot } = req.body;
  const userId = req.user.uid;

  try {
    // Clean up any expired hold on this exact slot
    await pool.query(
      `DELETE FROM booking_timeslots
       WHERE party_room_id = $1 AND slot_date = $2 AND slot_time = $3
         AND status = 'held' AND hold_expires_at < now()`,
      [roomId, date, slot]
    );

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, held_by_user_id, hold_expires_at)
       VALUES ($1, $2, $3, 'held', $4, $5)
       RETURNING id`,
      [roomId, date, slot, userId, expiresAt]
    );
    res.json({ holdId: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That slot was just taken — please choose another.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/slots/hold/:holdId — release a slot hold
router.delete('/slots/hold/:holdId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM booking_timeslots WHERE id = $1 AND status = 'held'`,
      [req.params.holdId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings — save a confirmed booking
router.post('/bookings', requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const {
    bookingRef, roomId, roomSlug, partyDate, partyTime, guestCount, foodChoice,
    allergyNotes, addonsSummary, baseAmount, addonsAmount, totalAmount,
    contactEmail, contactPhone, stripePaymentIntentId, slotHoldId, cardholderName,
  } = req.body;

  // Verify the Stripe PaymentIntent was actually charged for the correct amount
  let verifiedTotalAmount;
  let room;
  try {
    const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded.' });
    }

    // Compute expected amount server-side from the room price in the database
    const { rows: [foundRoom] } = await pool.query(
      'SELECT id, base_price_per_child FROM party_rooms WHERE (id = $1 OR slug = $2) AND is_active = true LIMIT 1',
      [roomId || null, roomSlug || null]
    );
    if (!foundRoom) return res.status(400).json({ error: 'Invalid room.' });
    room = foundRoom;

    const serverBaseAmount = parseFloat(room.base_price_per_child) * parseInt(guestCount, 10);
    const expectedCents = Math.round((serverBaseAmount + (parseFloat(addonsAmount) || 0)) * 100);

    if (pi.amount !== expectedCents) {
      return res.status(400).json({ error: 'Payment amount does not match booking total.' });
    }

    verifiedTotalAmount = pi.amount / 100;
  } catch (err) {
    if (err.statusCode) return res.status(400).json({ error: 'Could not verify payment: ' + err.message });
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [booking] } = await client.query(
      `INSERT INTO bookings
         (booking_ref, user_id, party_room_id, party_date, party_time, guest_count,
          food_choice, allergy_notes, addons_summary, base_amount, addons_amount,
          total_amount, status, contact_email, contact_phone, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'confirmed',$13,$14,$15)
       RETURNING id`,
      [bookingRef, uid, room.id, partyDate, partyTime, guestCount,
       foodChoice, allergyNotes, addonsSummary, baseAmount, addonsAmount,
       verifiedTotalAmount, contactEmail, contactPhone, stripePaymentIntentId]
    );

    // Upgrade slot hold to confirmed
    if (slotHoldId) {
      await client.query(
        `UPDATE booking_timeslots SET status = 'confirmed', booking_id = $1 WHERE id = $2`,
        [booking.id, slotHoldId]
      );
    }

    // Save payment record with the Stripe-verified amount
    await client.query(
      `INSERT INTO payments (booking_id, user_id, stripe_payment_intent_id, amount, currency, status, cardholder_name)
       VALUES ($1,$2,$3,$4,'nzd','succeeded',$5)`,
      [booking.id, uid, stripePaymentIntentId, verifiedTotalAmount, cardholderName || null]
    );

    await client.query('COMMIT');
    res.json({ bookingId: booking.id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/users/profile — get current user's profile
router.get('/users/profile', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, first_name as "firstName", last_name as "lastName", email, phone, is_admin as "isAdmin" FROM users WHERE id = $1',
      [req.user.uid]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/profile — upsert user profile
router.post('/users/profile', requireAuth, async (req, res) => {
  const { firstName, lastName, email, phone } = req.body;
  const uid = req.user.uid;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET first_name = EXCLUDED.first_name,
             last_name  = EXCLUDED.last_name,
             email      = EXCLUDED.email,
             phone      = COALESCE(EXCLUDED.phone, users.phone),
             updated_at = now()
       RETURNING id, first_name as "firstName", last_name as "lastName", email, phone, is_admin as "isAdmin"`,
      [uid, firstName || '', lastName || '', email || req.user.email || '', phone || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/bookings — get current user's bookings
router.get('/users/bookings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
              b.party_time as "partyTime", b.guest_count as "guestCount",
              b.food_choice as "foodChoice", b.total_amount as "totalAmount",
              b.status, b.created_at as "createdAt",
              r.name as "roomName", r.emoji as "roomEmoji"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC LIMIT 20`,
      [req.user.uid]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
