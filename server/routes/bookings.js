const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/auth');
const { bookingLimiter } = require('../middleware/rateLimit');
const { createConfirmedBooking } = require('../services/bookingCreator');

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
router.post('/slots/hold', requireAuth, bookingLimiter, async (req, res) => {
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

    // The room hold shares its expiry with the customer's active booking
    // session — one deadline for the whole wizard attempt, not two
    // independently ticking countdowns. A session is always opened before
    // step 2 (where this is called) is reachable, so this should always find
    // one; the now()+15min fallback only covers a session having separately
    // failed to open.
    const { rows: [session] } = await pool.query(
      `SELECT expires_at FROM booking_sessions WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
      [userId]
    );
    const expiresAt = session ? session.expires_at : new Date(Date.now() + 15 * 60 * 1000);

    // Upsert rather than a plain INSERT: the unique constraint on
    // (room, date, time) means a slot that was ever locked and then released
    // (e.g. by an admin reschedule moving a booking away from it) leaves a
    // 'released' row behind instead of a deleted one. A plain INSERT would
    // hit that row as a duplicate key and permanently 409 every future
    // customer trying to hold that exact slot again, even though /api/slots
    // correctly reports it as available. The WHERE guard still refuses to
    // clobber a live 'confirmed' or unexpired 'held' row.
    const { rows } = await pool.query(
      `INSERT INTO booking_timeslots (party_room_id, slot_date, slot_time, status, held_by_user_id, hold_expires_at)
       VALUES ($1, $2, $3, 'held', $4, $5)
       ON CONFLICT (party_room_id, slot_date, slot_time) DO UPDATE
         SET status = 'held', held_by_user_id = EXCLUDED.held_by_user_id,
             hold_expires_at = EXCLUDED.hold_expires_at, booking_id = NULL
         WHERE booking_timeslots.status = 'released'
            OR (booking_timeslots.status = 'held' AND booking_timeslots.hold_expires_at < now())
       RETURNING id`,
      [roomId, date, slot, userId, expiresAt]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'That slot was just taken — please choose another.' });
    }
    res.json({ holdId: rows[0].id, expiresAt });
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
router.post('/bookings', requireAuth, bookingLimiter, async (req, res) => {
  const uid = req.user.uid;
  const {
    bookingRef, roomId, roomSlug, partyDate, partyTime, guestCount, foodChoice,
    allergyNotes, addonsSummary, baseAmount, addonsAmount, totalAmount,
    contactEmail, contactPhone, stripePaymentIntentId, slotHoldId, cardholderName,
  } = req.body;

  // Verify the Stripe PaymentIntent was actually charged for the correct amount
  let verifiedTotalAmount;
  let room;
  let stripeBillingName = null;
  let stripeCardBrand = null;
  let stripeCardLast4 = null;
  try {
    const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId, { expand: ['payment_method'] });
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded.' });
    }

    // Compute expected amount server-side from the room price in the database
    const { rows: [foundRoom] } = await pool.query(
      'SELECT id, name, base_price_per_child, min_guests, max_guests FROM party_rooms WHERE (id = $1 OR slug = $2) AND is_active = true LIMIT 1',
      [roomId || null, roomSlug || null]
    );
    if (!foundRoom) return res.status(400).json({ error: 'Invalid room.' });
    room = foundRoom;

    const guests = parseInt(guestCount, 10);
    if (!guests || guests < room.min_guests || guests > room.max_guests) {
      return res.status(400).json({ error: `This room requires between ${room.min_guests} and ${room.max_guests} guests.` });
    }

    const serverBaseAmount = parseFloat(room.base_price_per_child) * guests;
    const expectedCents = Math.round((serverBaseAmount + (parseFloat(addonsAmount) || 0)) * 100);

    if (pi.amount !== expectedCents) {
      // The card has already been captured (pi.status === 'succeeded' above) for a stale
      // amount — most likely the guest count/add-ons changed after the Payment Element was
      // mounted. Refund immediately rather than leaving the customer charged with no booking,
      // and leave a record in `payments` (booking_id NULL, since no booking was created) so
      // it's visible in the admin Payments tab for reconciliation.
      let refundStatus = 'failed';
      let refundNote = 'Auto-refund failed — needs manual reconciliation.';
      try {
        await stripe.refunds.create({ payment_intent: stripePaymentIntentId });
        refundStatus = 'refunded';
        refundNote = 'Auto-refunded.';
      } catch (refundErr) {
        refundNote = `Auto-refund failed: ${refundErr.message} — needs manual reconciliation.`;
      }

      await pool.query(
        `INSERT INTO payments
           (booking_id, user_id, stripe_payment_intent_id, amount, currency, status,
            payment_provider, error_message, refunded_at)
         VALUES (NULL, $1, $2, $3, 'nzd', $4, 'stripe', $5, CASE WHEN $4 = 'refunded' THEN now() ELSE NULL END)
         ON CONFLICT (stripe_payment_intent_id) DO UPDATE
           SET status = EXCLUDED.status, error_message = EXCLUDED.error_message,
               refunded_at = EXCLUDED.refunded_at, updated_at = now()`,
        [uid, stripePaymentIntentId, pi.amount / 100, refundStatus,
         `Amount mismatch: charged $${(pi.amount / 100).toFixed(2)}, expected $${(expectedCents / 100).toFixed(2)}. ${refundNote}`]
      );

      return res.status(400).json({
        error: refundStatus === 'refunded'
          ? "Your booking total changed after payment started, so we've automatically refunded your card. Please try booking again."
          : 'Your booking total changed after payment started. We could not confirm the refund — please contact us at Bookings@wonderworldwestgate.co.nz so we can sort this out.'
      });
    }

    verifiedTotalAmount = pi.amount / 100;
    stripeBillingName = pi.payment_method?.billing_details?.name || null;
    stripeCardBrand = pi.payment_method?.card?.brand || null;
    stripeCardLast4 = pi.payment_method?.card?.last4 || null;
  } catch (err) {
    if (err.statusCode) return res.status(400).json({ error: 'Could not verify payment: ' + err.message });
    throw err;
  }

  try {
    // Prefer the name Stripe actually captured with the card (set from the
    // logged-in user's account name at checkout — see payment.js) over the
    // client-submitted value, which isn't independently verified.
    const bookingId = await createConfirmedBooking({
      bookingRef, uid, room, partyDate, partyTime, guestCount, foodChoice,
      allergyNotes, addonsSummary, baseAmount, addonsAmount, totalAmount: verifiedTotalAmount,
      contactEmail, contactPhone, slotHoldId, cardholderName: stripeBillingName || cardholderName,
      cardBrand: stripeCardBrand, cardLast4: stripeCardLast4,
      paymentProvider: 'stripe', stripePaymentIntentId,
    });

    // Best-effort — the booking already succeeded above, this is just
    // bookkeeping so the wizard doesn't offer to "resume" a completed booking.
    pool.query(
      `UPDATE booking_sessions SET status = 'completed', updated_at = now() WHERE user_id = $1 AND status = 'active'`,
      [uid]
    ).catch(err => console.error('Failed to mark booking_session completed:', err));

    res.json({ bookingId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-created bookings (server/routes/admin.js manual/import creation)
// mint a users row with id = crypto.randomUUID() when no account exists yet
// for the email given — e.g. a phone booking taken before the customer ever
// signed up. That id is never a real Firebase UID (Firebase UIDs don't take
// this shape), which is what lets us tell a "placeholder" account apart from
// a real one without a schema change. If the email on a placeholder matches
// this Firebase-verified user's own email, re-point its bookings/payments/
// timeslot-holds onto the real account and drop the placeholder, so
// GET /users/bookings (which matches strictly on user_id, never email)
// picks them up.
// Gated on req.user.email_verified so someone can't get read/edit access to
// a phone booking just by signing up with an email they don't own but
// haven't confirmed — see the ADMIN_PLACEHOLDER_EMAIL guard for the same
// reason on the shared "blank email" bucket from the manual-booking form.
const PLACEHOLDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_PLACEHOLDER_EMAIL = 'admin@wonderworldwestgate.co.nz';

// Never allowed to throw — this runs as a side effect of profile
// read/save, and a failure here must not break either of those.
async function claimPlaceholderBookings(uid, req) {
  try {
    if (!req.user.email || !req.user.email_verified) return;
    const verifiedEmail = req.user.email.toLowerCase();
    if (verifiedEmail === ADMIN_PLACEHOLDER_EMAIL) return;

    const { rows: [existing] } = await pool.query(`SELECT id FROM users WHERE email = $1`, [verifiedEmail]);
    if (!existing || existing.id === uid || !PLACEHOLDER_ID_RE.test(existing.id)) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE bookings SET user_id = $1 WHERE user_id = $2`, [uid, existing.id]);
      await client.query(`UPDATE payments SET user_id = $1 WHERE user_id = $2`, [uid, existing.id]);
      await client.query(`UPDATE booking_timeslots SET held_by_user_id = $1 WHERE held_by_user_id = $2`, [uid, existing.id]);
      await client.query(`DELETE FROM users WHERE id = $1`, [existing.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Failed to claim placeholder bookings (${existing.id} -> ${uid}):`, err);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`claimPlaceholderBookings lookup failed for uid ${uid}:`, err);
  }
}

// GET /api/users/profile — get current user's profile
router.get('/users/profile', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, first_name as "firstName", last_name as "lastName", email, phone, is_admin as "isAdmin" FROM users WHERE id = $1',
      [req.user.uid]
    );
    // Only attempt this once the account already has a profile row — a
    // brand new signup hasn't POSTed one yet, and re-pointing a booking onto
    // a users.id that doesn't exist yet would fail the FK constraint.
    if (rows[0]) await claimPlaceholderBookings(req.user.uid, req);
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
    await claimPlaceholderBookings(uid, req);
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
router.post('/bookings/:id/edit', requireAuth, bookingLimiter, async (req, res) => {
  const uid = req.user.uid;
  const bookingId = req.params.id;
  const {
    newGuestCount, newFoodChoice, newAddonsSummary, newAddonsAmount,
    deltaAmount, paymentIntentId, changeType,
  } = req.body;

  let booking;
  try {
    // hoursUntilParty is computed in Postgres (which already knows the NZ
    // calendar via db.js's session `SET TIME ZONE 'Pacific/Auckland'`) rather
    // than in Node, which runs on a UTC host here — doing the arithmetic in
    // JS previously templated a raw `date`-typed Date object into a string
    // (`${booking.party_date}T...`), producing an unparseable string and
    // silently making this check a no-op (NaN < 24 is always false); doing
    // it naively in JS even after fixing that would still be off by NZ's
    // UTC+12/+13 offset since the host isn't in that timezone.
    const { rows } = await pool.query(
      `SELECT b.*, r.base_price_per_child as "pricePerChild", r.max_guests as "roomMaxGuests",
              r.min_guests as "roomMinGuests",
              EXTRACT(EPOCH FROM (
                (b.party_date + CASE b.party_time
                   WHEN '9:30 AM'  THEN '09:30'::time
                   WHEN '11:30 AM' THEN '11:30'::time
                   WHEN '1:30 PM'  THEN '13:30'::time
                   WHEN '3:30 PM'  THEN '15:30'::time
                   ELSE '12:00'::time
                 END) AT TIME ZONE 'Pacific/Auckland' - now()
              )) / 3600 as "hoursUntilParty"
       FROM bookings b JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.id = $1 AND b.user_id = $2 AND b.status = 'confirmed'`,
      [bookingId, uid]
    );
    booking = rows[0];
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found or cannot be edited.' });

  // Server-side 24hr check
  const hoursUntil = parseFloat(booking.hoursUntilParty);
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
  let editCardBrand = null;
  let editCardLast4 = null;
  let editCardholderName = null;
  if (delta > 0) {
    if (!paymentIntentId) return res.status(400).json({ error: 'Payment required for this edit.' });
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
      if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Payment has not succeeded.' });
      const expectedCents = Math.round(delta * 100);
      if (Math.abs(pi.amount - expectedCents) > 2) {
        return res.status(400).json({ error: 'Payment amount mismatch.' });
      }
      editCardBrand = pi.payment_method?.card?.brand || null;
      editCardLast4 = pi.payment_method?.card?.last4 || null;
      editCardholderName = pi.payment_method?.billing_details?.name || null;
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
        `INSERT INTO payments (booking_id, user_id, stripe_payment_intent_id, amount, currency, status,
                                cardholder_name, card_brand, card_last4)
         VALUES ($1, $2, $3, $4, 'nzd', 'succeeded', $5, $6, $7)`,
        [bookingId, uid, paymentIntentId, delta, editCardholderName, editCardBrand, editCardLast4]
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
