const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimit');
const { createConfirmedBooking } = require('../services/bookingCreator');
const { sendBookingConfirmation } = require('../services/bookingNotifications');
const poli = require('../services/poliClient');

const SITE_URL = process.env.SITE_URL || 'https://wonderworldwestgate.co.nz';

// GET /api/poli/status — lets the frontend check availability without
// leaking whether credentials exist, just whether the feature is usable.
router.get('/status', (req, res) => {
  res.json({ enabled: poli.POLI_CONFIGURED });
});

// POST /api/poli/initiate
// Mirrors payments.js create-intent's server-side price verification, but
// instead of returning a Stripe client secret, stashes the full booking
// payload server-side (keyed by the existing slot hold) and returns a
// NavigateURL to redirect the customer's browser to POLi.
//
// We stash the payload rather than round-tripping it through POLi's
// MerchantData field because that field's length limit isn't confirmed —
// only the (short, fixed-length) slot hold id travels as MerchantRef.
router.post('/initiate', requireAuth, paymentLimiter, async (req, res) => {
  if (!poli.POLI_CONFIGURED) return res.status(503).json({ error: 'POLi is not available.' });

  const {
    bookingRef, roomId, roomSlug, partyDate, partyTime, guestCount, foodChoice,
    allergyNotes, addonsSummary, addonsAmount = 0, contactEmail, contactPhone, slotHoldId,
    firstName, lastName,
  } = req.body;
  const uid = req.user.uid;

  if (!slotHoldId) return res.status(400).json({ error: 'Missing slot hold.' });
  if (!bookingRef || !bookingRef.trim()) return res.status(400).json({ error: 'Missing booking reference.' });

  try {
    const { rows: [room] } = await pool.query(
      'SELECT id, name, base_price_per_child, min_guests, max_guests FROM party_rooms WHERE (id = $1 OR slug = $2) AND is_active = true LIMIT 1',
      [roomId || null, roomSlug || null]
    );
    if (!room) return res.status(400).json({ error: 'Invalid room.' });

    const guests = parseInt(guestCount, 10);
    if (!guests || guests < room.min_guests || guests > room.max_guests) {
      return res.status(400).json({ error: `This room requires between ${room.min_guests} and ${room.max_guests} guests.` });
    }

    const baseAmount = parseFloat(room.base_price_per_child) * guests;
    const totalAmount = baseAmount + parseFloat(addonsAmount || 0);
    if (!totalAmount || totalAmount < 1) return res.status(400).json({ error: 'Invalid booking amount.' });

    await pool.query(
      `INSERT INTO poli_pending_bookings (slot_hold_id, payload)
       VALUES ($1, $2)
       ON CONFLICT (slot_hold_id) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
      [slotHoldId, JSON.stringify({
        bookingRef, uid, roomId: room.id, partyDate, partyTime, guestCount, foodChoice,
        allergyNotes, addonsSummary, baseAmount, addonsAmount, totalAmount,
        contactEmail, contactPhone, slotHoldId, firstName, lastName,
      })]
    );

    const { navigateUrl, token, poliRef } = await poli.initiateTransaction({
      amount: totalAmount,
      merchantRef: slotHoldId,
      homePageUrl: SITE_URL,
      successUrl: `${SITE_URL}/api/poli/return/success`,
      failureUrl: `${SITE_URL}/api/poli/return/failure`,
      notificationUrl: `${SITE_URL}/api/poli/notification`,
    });

    await pool.query(
      `UPDATE poli_pending_bookings SET poli_token = $1, poli_ref = $2 WHERE slot_hold_id = $3`,
      [token, poliRef || null, slotHoldId]
    );

    res.json({ navigateUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared verify-and-confirm logic used by both the browser return redirect
// and the (more trustworthy, server-to-server) notification callback below.
// Idempotent: if a payment already exists for this token, does nothing.
async function verifyAndConfirm(token) {
  const result = await poli.getTransaction(token);
  if (!poli.isSuccessStatus(result.statusCode)) {
    return { ok: false, result };
  }

  const { rows: [existing] } = await pool.query(
    'SELECT booking_id FROM payments WHERE poli_transaction_token = $1', [token]
  );
  if (existing) return { ok: true, alreadyProcessed: true, bookingId: existing.booking_id };

  const { rows: [pending] } = await pool.query(
    'SELECT payload FROM poli_pending_bookings WHERE poli_token = $1', [token]
  );
  if (!pending) throw new Error(`No pending booking found for POLi token ${token}.`);

  const p = pending.payload;

  // Re-verify the amount server-side against the room price, same defense
  // as the Stripe path — never trust the amount POLi echoes back alone.
  const { rows: [room] } = await pool.query(
    'SELECT id, name, base_price_per_child, min_guests, max_guests FROM party_rooms WHERE id = $1', [p.roomId]
  );
  if (!room) throw new Error('Room no longer exists for pending POLi booking.');
  const pendingGuests = parseInt(p.guestCount, 10);
  if (!pendingGuests || pendingGuests < room.min_guests || pendingGuests > room.max_guests) {
    throw new Error(`Guest count ${p.guestCount} is outside room limits (${room.min_guests}-${room.max_guests}).`);
  }
  const expected = parseFloat(room.base_price_per_child) * pendingGuests + parseFloat(p.addonsAmount || 0);
  if (result.amount && Math.abs(parseFloat(result.amount) - expected) > 0.01) {
    throw new Error(`POLi amount (${result.amount}) does not match expected booking total (${expected}).`);
  }

  const bookingId = await createConfirmedBooking({
    bookingRef: p.bookingRef, uid: p.uid, room, partyDate: p.partyDate, partyTime: p.partyTime,
    guestCount: p.guestCount, foodChoice: p.foodChoice, allergyNotes: p.allergyNotes,
    addonsSummary: p.addonsSummary, baseAmount: p.baseAmount, addonsAmount: p.addonsAmount,
    totalAmount: expected, contactEmail: p.contactEmail, contactPhone: p.contactPhone,
    slotHoldId: p.slotHoldId, paymentProvider: 'poli', poliTransactionToken: token,
    poliTransactionRef: result.merchantRef,
  });

  await pool.query('DELETE FROM poli_pending_bookings WHERE poli_token = $1', [token]);

  // Best-effort — the booking already succeeded above, this is just
  // bookkeeping so the wizard doesn't offer to "resume" a completed booking.
  pool.query(
    `UPDATE booking_sessions SET status = 'completed', updated_at = now() WHERE user_id = $1 AND status = 'active'`,
    [p.uid]
  ).catch(err => console.error('Failed to mark booking_session completed:', err));

  // Unlike Stripe/Afterpay, the browser may never come back to trigger this
  // client-side — send it now, server-side, since we already have everything.
  sendBookingConfirmation({
    bookingRef: p.bookingRef, bookingId, email: p.contactEmail, phone: p.contactPhone,
    firstName: p.firstName, lastName: p.lastName, roomName: room.name,
    partyDate: p.partyDate, partyTime: p.partyTime, guestCount: p.guestCount,
    foodChoice: p.foodChoice, addonsSummary: p.addonsSummary, totalAmount: expected,
  }).catch(err => console.error('POLi booking confirmation notification failed:', err));

  return { ok: true, bookingId };
}

// GET /api/poli/return/success — POLi redirects the customer's browser here.
// The exact query param name POLi appends the token as is unconfirmed
// (checking common variants) — this MUST be checked against a real sandbox
// redirect before launch.
router.get('/return/success', async (req, res) => {
  const token = req.query.token || req.query.Token || req.query.TransactionToken;
  if (!token) return res.redirect(`${SITE_URL}/?poli_booking=error`);

  try {
    const outcome = await verifyAndConfirm(token);
    if (!outcome.ok) return res.redirect(`${SITE_URL}/?poli_booking=failed`);
    res.redirect(`${SITE_URL}/?poli_booking=success&bookingId=${outcome.bookingId}`);
  } catch (err) {
    console.error('POLi return/success verification failed:', err);
    res.redirect(`${SITE_URL}/?poli_booking=error`);
  }
});

// GET /api/poli/return/failure — customer cancelled or the bank declined.
router.get('/return/failure', async (req, res) => {
  const token = req.query.token || req.query.Token || req.query.TransactionToken;
  if (token) {
    await pool.query('DELETE FROM poli_pending_bookings WHERE poli_token = $1', [token]).catch(() => {});
  }
  res.redirect(`${SITE_URL}/?poli_booking=failed`);
});

// POST /api/poli/notification — server-to-server callback, the authoritative
// source of truth (same role as the Stripe webhook). Payload shape is
// unconfirmed, so the token is read defensively from query, JSON body, or
// urlencoded body — the content is never trusted directly regardless, this
// only tells us WHICH transaction to independently re-verify via
// getTransaction.
router.post('/notification', express.urlencoded({ extended: true }), async (req, res) => {
  const token = req.query.token || req.body?.token || req.body?.Token || req.body?.TransactionToken;
  if (!token) return res.status(400).json({ error: 'No transaction token in notification.' });

  try {
    await verifyAndConfirm(token);
    res.json({ received: true });
  } catch (err) {
    console.error('POLi notification verification failed:', err);
    res.status(500).json({ error: 'Failed to process notification.' });
  }
});

module.exports = router;
