const pool   = require('../db');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createConfirmedBooking, SlotHoldExpiredError } = require('./bookingCreator');
const { sendBookingConfirmation } = require('./bookingNotifications');
const { assertBookingAllowedOnDate } = require('./bookingRules');
const { getAddonTotal, buildAddonsSummary } = require('./addonPricing');

const ALERT_EMAIL = process.env.BOOKING_ALERTS_EMAIL || 'Bookings@wonderworldwestgate.co.nz';

async function alertAdmin(subject, message) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
      to:      ALERT_EMAIL,
      subject: `⚠️ ${subject}`,
      html:    `<pre style="font-family:monospace;white-space:pre-wrap;font-size:13px">${message}</pre>`,
    });
  } catch (err) {
    console.error('Admin alert email failed:', err.message);
  }
}

// Card has been charged with nothing to show for it (no session data to
// reconstruct the booking from, or the slot is genuinely gone by the time we
// try) — refund it and leave a `payments` row (booking_id NULL) for the
// admin Payments tab, same convention POST /api/bookings' own error branches
// already use. Always followed by an admin email, since this always needs a
// human (find the customer a new slot, or confirm the refund landed).
async function refundOrphan(paymentIntentId, amount, uid, reason, bookingRef, s) {
  let refundStatus = 'failed';
  let refundNote = 'Auto-refund failed — needs manual reconciliation.';
  try {
    await stripe.refunds.create({ payment_intent: paymentIntentId });
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
    [uid || null, paymentIntentId, amount, refundStatus, `${reason} ${refundNote}`]
  );

  const wanted = s
    ? `They wanted: ${s.selectedRoom?.name || '(unknown room)'} on ${s.selectedDate} at ${s.selectedTime}, ${s.guests} guests.`
    : '';
  await alertAdmin(
    `Stranded Stripe payment needs review — ${bookingRef || paymentIntentId}`,
    `PaymentIntent ${paymentIntentId} ($${Number(amount).toFixed(2)} NZD) succeeded but could not be turned into a booking automatically.

Reason: ${reason}

${refundStatus === 'refunded' ? 'The customer has been automatically refunded.' : 'AUTO-REFUND FAILED — this needs manual attention in the Stripe dashboard.'}

${wanted}`
  );

  return refundStatus;
}

// Server-side safety net for the gap that stranded WW-C2PRDY (2026-08-11):
// booking confirmation was entirely client-driven (Stripe charges the card
// in-browser, then the frontend calls POST /api/bookings to write it) with
// nothing server-side ever finding out if that second call never arrives —
// tab closed, connection dropped, app crashed right after the charge
// succeeded. POLi never had this problem because its notification webhook
// (server/routes/poli.js verifyAndConfirm) is the authoritative confirmation
// path regardless of whether the browser returns; this mirrors that pattern
// for Stripe, driven by the payment_intent.succeeded webhook instead of the
// client's own follow-up call.
//
// Idempotent and safe to race against the client's own POST /api/bookings —
// both check for an existing `payments` row keyed by this PaymentIntent id
// before writing anything, so whichever gets there first wins and the other
// is a no-op. Booking details are rebuilt from booking_sessions.wizard_state
// (looked up by the booking_ref Stripe already carries in its metadata),
// the same record the wizard itself would have submitted.
async function verifyAndConfirmStripePayment(paymentIntentId) {
  const { rows: [existingPayment] } = await pool.query(
    `SELECT booking_id FROM payments WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId]
  );
  if (existingPayment) return { ok: true, alreadyProcessed: true, bookingId: existingPayment.booking_id };

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
  if (pi.status !== 'succeeded') return { ok: false, reason: 'not succeeded' };

  const bookingRef = pi.metadata?.booking_ref;
  if (!bookingRef) return { ok: false, reason: 'no booking_ref in PaymentIntent metadata' };

  const { rows: [alreadyBooked] } = await pool.query(
    `SELECT id FROM bookings WHERE booking_ref = $1`, [bookingRef]
  );
  if (alreadyBooked) return { ok: true, alreadyProcessed: true, bookingId: alreadyBooked.id };

  const { rows: [session] } = await pool.query(
    `SELECT user_id, wizard_state FROM booking_sessions WHERE booking_ref = $1`, [bookingRef]
  );
  if (!session) {
    await refundOrphan(paymentIntentId, pi.amount / 100, null,
      'No booking_sessions row found for this booking_ref — cannot reconstruct booking details.', bookingRef, null);
    return { ok: false, reason: 'no session data' };
  }

  const s   = session.wizard_state || {};
  const uid = session.user_id;

  try {
    const { rows: [room] } = await pool.query(
      `SELECT id, name, base_price_per_child, min_guests, max_guests,
              pricing_model, flat_price, allowed_days_of_week
       FROM party_rooms WHERE id = $1 AND is_active = true LIMIT 1`,
      [s.partyRoomDbId]
    );
    if (!room) throw new Error('Room no longer exists or is inactive.');

    const guests = parseInt(s.guests, 10);
    if (!guests || guests < room.min_guests || guests > room.max_guests) {
      throw new Error(`Guest count ${s.guests} is outside room limits (${room.min_guests}-${room.max_guests}).`);
    }
    assertBookingAllowedOnDate(room, s.selectedTime, s.selectedDate);

    if (room.pricing_model === 'flat') {
      if (!['self_catering', 'venue_menu'].includes(s.cateringChoice)) {
        throw new Error('Missing catering choice for flat-rate room.');
      }
      if (!s.noAlcoholAck) throw new Error('Missing no-alcohol acknowledgement for flat-rate room.');
    }

    const baseAmount   = room.pricing_model === 'flat' ? parseFloat(room.flat_price) : parseFloat(room.base_price_per_child) * guests;
    const addonsAmount = getAddonTotal(s.addons);
    const expectedCents = Math.round((baseAmount + addonsAmount) * 100);
    if (pi.amount !== expectedCents) {
      throw new Error(`Amount mismatch: Stripe charged $${(pi.amount / 100).toFixed(2)}, expected $${(expectedCents / 100).toFixed(2)}.`);
    }

    const { rows: [user] } = await pool.query(`SELECT email, phone, first_name, last_name FROM users WHERE id = $1`, [uid]);

    const bookingId = await createConfirmedBooking({
      bookingRef, uid, room,
      partyDate: s.selectedDate, partyTime: s.selectedTime, guestCount: guests,
      foodChoice: s.selectedFood, allergyNotes: s.allergyNotes || '',
      addonsSummary: buildAddonsSummary(s),
      baseAmount, addonsAmount, totalAmount: pi.amount / 100,
      contactEmail: s.confirmEmail || user?.email || pi.receipt_email || null,
      contactPhone: s.confirmPhone ? ('+64' + String(s.confirmPhone).replace(/\s/g, '')) : (user?.phone || null),
      slotHoldId: s.slotHoldId,
      cardholderName: pi.payment_method?.billing_details?.name || null,
      cardBrand: pi.payment_method?.card?.brand || null,
      cardLast4: pi.payment_method?.card?.last4 || null,
      paymentProvider: 'stripe', stripePaymentIntentId: paymentIntentId,
      cateringChoice: room.pricing_model === 'flat' ? s.cateringChoice : null,
      noAlcoholAck: room.pricing_model === 'flat' ? !!s.noAlcoholAck : false,
    });

    pool.query(
      `UPDATE booking_sessions SET status = 'completed', updated_at = now() WHERE booking_ref = $1`,
      [bookingRef]
    ).catch(err => console.error('Failed to mark booking_session completed:', err));

    // Unlike the normal client-driven path, the browser may never come back
    // to send this itself — send it now, server-side, since we already have
    // everything we need (same reasoning as POLi's return handler).
    sendBookingConfirmation({
      bookingRef, bookingId,
      email: s.confirmEmail || user?.email || pi.receipt_email,
      phone: s.confirmPhone || user?.phone,
      firstName: user?.first_name || '', lastName: user?.last_name || '',
      roomName: room.name, partyDate: s.selectedDate, partyTime: s.selectedTime,
      guestCount: guests, foodChoice: s.selectedFood, addonsSummary: buildAddonsSummary(s),
      totalAmount: pi.amount / 100,
      cateringChoice: room.pricing_model === 'flat' ? s.cateringChoice : null,
      noAlcoholAck: !!s.noAlcoholAck,
    }).catch(err => console.error('Stripe safety-net confirmation notification failed:', err));

    await alertAdmin(
      `Auto-recovered a stranded Stripe payment — ${bookingRef}`,
      `PaymentIntent ${paymentIntentId} succeeded but the customer's browser never confirmed the booking (tab closed / connection dropped right after payment). The server-side safety net created it automatically — no action needed, flagging for visibility.

Booking: ${bookingRef}
Room: ${room.name}
Date/time: ${s.selectedDate} at ${s.selectedTime}
Guests: ${guests}
Amount: $${(pi.amount / 100).toFixed(2)} NZD`
    );

    return { ok: true, bookingId };
  } catch (err) {
    const reason = err instanceof SlotHoldExpiredError
      ? `Slot hold expired or no longer matched by the time the safety net ran: ${err.message}`
      : `Safety-net booking confirmation failed: ${err.message}`;
    await refundOrphan(paymentIntentId, pi.amount / 100, uid, reason, bookingRef, s);
    return { ok: false, reason };
  }
}

// Backstop for the (rare) case where the webhook itself never fires at all
// — delivery failure, endpoint downtime, Stripe having exhausted its retry
// schedule. Scans succeeded PaymentIntents from the last day and runs the
// same idempotent reconciliation on any that don't yet have a `payments`
// row; a no-op for everything the webhook already handled. Not a substitute
// for the webhook (which reacts within seconds) — this just bounds how long
// a payment can stay stranded if the fast path is ever unavailable.
async function reconcileRecentOrphans() {
  const sinceUnix = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  let scanned = 0, recovered = 0;
  try {
    for await (const pi of stripe.paymentIntents.list({ created: { gte: sinceUnix }, limit: 100 })) {
      if (pi.status !== 'succeeded' || !pi.metadata?.booking_ref) continue;
      scanned++;
      const { rows: [existing] } = await pool.query(
        `SELECT 1 FROM payments WHERE stripe_payment_intent_id = $1`, [pi.id]
      );
      if (existing) continue;
      const outcome = await verifyAndConfirmStripePayment(pi.id).catch(err => {
        console.error(`Backstop reconciliation failed for ${pi.id}:`, err);
        return { ok: false };
      });
      if (outcome.ok && !outcome.alreadyProcessed) recovered++;
    }
  } catch (err) {
    console.error('reconcileRecentOrphans failed:', err.message);
  }
  if (recovered > 0) console.log(`Stripe backstop reconciliation: scanned ${scanned}, recovered ${recovered}.`);
}

module.exports = { verifyAndConfirmStripePayment, reconcileRecentOrphans, refundOrphan };
