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
              b.food_choice as "foodChoice", b.addons_summary as "addonsSummary",
              b.base_amount as "baseAmount", b.addons_amount as "addonsAmount",
              b.total_amount as "totalAmount", b.status, b.created_at as "createdAt",
              r.name as "roomName", r.emoji as "roomEmoji", r.slug as "roomSlug",
              r.max_guests as "roomMaxGuests", r.base_price_per_child as "pricePerChild"
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

// GET /api/bookings/:id — get full booking details for edit modal
router.get('/bookings/:id', requireAuth, async (req, res) => {
  const uid = req.user.uid;
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.booking_ref as "bookingRef", b.party_date as "partyDate",
              b.party_time as "partyTime", b.guest_count as "guestCount",
              b.food_choice as "foodChoice", b.addons_summary as "addonsSummary",
              b.base_amount as "baseAmount", b.addons_amount as "addonsAmount",
              b.total_amount as "totalAmount", b.status, b.contact_email as "contactEmail",
              b.stripe_payment_intent_id as "stripePaymentIntentId",
              r.name as "roomName", r.emoji as "roomEmoji", r.slug as "roomSlug",
              r.max_guests as "roomMaxGuests", r.base_price_per_child as "pricePerChild"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.id = $1 AND b.user_id = $2`,
      [req.params.id, uid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/edit — apply edit after successful payment
router.post('/bookings/:id/edit', requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const bookingId = req.params.id;
  const {
    newGuestCount, newFoodChoice, newAddonsSummary, newAddonsAmount,
    deltaAmount, paymentIntentId, changeType,
  } = req.body;

  const TIME_MAP = { '9:30 AM': '09:30', '11:30 AM': '11:30', '1:30 PM': '13:30', '3:30 PM': '15:30' };

  let booking;
  try {
    const { rows } = await pool.query(
      `SELECT b.*, r.base_price_per_child as "pricePerChild", r.max_guests as "roomMaxGuests",
              r.min_guests as "roomMinGuests"
       FROM bookings b JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.id = $1 AND b.user_id = $2 AND b.status = 'confirmed'`,
      [bookingId, uid]
    );
    booking = rows[0];
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found or cannot be edited.' });

  // Server-side 48hr/24hr check
  const t = TIME_MAP[booking.party_time] || '12:00';
  const partyDt = new Date(`${booking.party_date}T${t}:00`);
  const hoursUntil = (partyDt - new Date()) / 3600000;
  if (hoursUntil < 24) {
    return res.status(400).json({ error: 'Edits cannot be accepted within 24 hours of your party.' });
  }

  // Validate guest count
  if (parseInt(newGuestCount, 10) < booking.guest_count) {
    return res.status(400).json({ error: 'Guest count cannot be reduced.' });
  }
  if (parseInt(newGuestCount, 10) > booking.roomMaxGuests) {
    return res.status(400).json({ error: `Guest count cannot exceed ${booking.roomMaxGuests}.` });
  }

  // Verify payment if there is a charge
  const delta = parseFloat(deltaAmount) || 0;
  if (delta > 0) {
    if (!paymentIntentId) return res.status(400).json({ error: 'Payment required for this edit.' });
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Payment has not succeeded.' });
      const expectedCents = Math.round(delta * 100);
      if (Math.abs(pi.amount - expectedCents) > 2) {
        return res.status(400).json({ error: 'Payment amount mismatch.' });
      }
    } catch (err) {
      return res.status(400).json({ error: 'Could not verify payment: ' + err.message });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const newTotal = parseFloat(booking.total_amount) + delta;
    const prevAddons = booking.addons_summary ? booking.addons_summary.trim() : '';
    const newAddons = newAddonsSummary ? newAddonsSummary.trim() : '';
    const combinedAddons = [prevAddons, newAddons].filter(Boolean).join(', ');
    const newTotalAddons = parseFloat(booking.addons_amount || 0) + parseFloat(newAddonsAmount || 0);

    await client.query(
      `UPDATE bookings SET
         guest_count = $1, food_choice = COALESCE($2, food_choice),
         addons_summary = $3, addons_amount = $4, total_amount = $5, updated_at = now()
       WHERE id = $6`,
      [newGuestCount, newFoodChoice || null, combinedAddons || null,
       newTotalAddons, newTotal, bookingId]
    );

    await client.query(
      `INSERT INTO booking_edits
         (booking_id, changed_by, change_type, delta_amount, new_guest_count,
          new_food_choice, new_addons_summary, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [bookingId, uid, changeType || 'both', delta, newGuestCount,
       newFoodChoice || null, newAddonsSummary || null, paymentIntentId || null]
    );

    if (delta > 0 && paymentIntentId) {
      await client.query(
        `INSERT INTO payments (booking_id, user_id, stripe_payment_intent_id, amount, currency, status)
         VALUES ($1, $2, $3, $4, 'nzd', 'succeeded')`,
        [bookingId, uid, paymentIntentId, delta]
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

module.exports = router;
