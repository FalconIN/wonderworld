const pool = require('../db');
const eventBus = require('../eventBus');
const { roomDisplayName } = require('../roomDisplayNames');

// Thrown when the caller's slotHoldId no longer holds the slot (missing,
// expired, or already claimed by someone else) — see the atomic claim below.
// Routes should catch this specifically and respond with a clean "please
// retry" error instead of a generic 500, and MUST NOT treat it as the
// booking having succeeded.
class SlotHoldExpiredError extends Error {
  constructor(message) {
    super(message || 'Your hold on this time slot has expired. Please choose your slot again.');
    this.name = 'SlotHoldExpiredError';
    this.code = 'SLOT_HOLD_EXPIRED';
  }
}

// Thrown when slotHoldId resolves to a live, unexpired hold — but for a
// different room/date/time than the booking being created. This happens
// when a customer's client-side state drifts (e.g. browsing/comparing rooms
// after already holding a slot repoints the room shown in the booking
// payload without re-holding it — see the WW-129HC4 root-cause writeup):
// the customer ends up paying for room/date/time X while only ever actually
// holding room/date/time Y. Extends SlotHoldExpiredError so existing callers
// that catch `instanceof SlotHoldExpiredError` (routes/bookings.js's
// auto-refund handler) keep working unchanged; `.code` distinguishes the
// specific cause for logging.
class SlotHoldMismatchError extends SlotHoldExpiredError {
  constructor(message) {
    super(message || 'Your held time slot no longer matches this booking. Please choose your slot again.');
    this.name = 'SlotHoldMismatchError';
    this.code = 'SLOT_HOLD_MISMATCH';
  }
}

// Shared by both the Stripe path (server/routes/bookings.js, verified via
// paymentIntents.retrieve before calling this) and the POLi path
// (server/routes/poli.js, verified via getTransaction before calling this).
// Caller is responsible for verifying payment success and the charged
// amount BEFORE calling this — this function trusts its inputs completely.
//
// The booking_timeslots row is the exclusivity lock for a (room, date, time)
// slot, so it must be atomically claimed — status 'held' -> 'confirmed' —
// BEFORE the bookings row is written, and the write must abort if the claim
// fails (hold missing/expired/already-claimed). Previously this inserted
// into bookings unconditionally and only optionally, best-effort touched
// booking_timeslots afterwards, which let a booking through with no live
// slot lock behind it at all (see migration-double-booking-guard.sql and
// the WW-129HC4 incident writeup this closed).
async function createConfirmedBooking({
  bookingRef, uid, room, partyDate, partyTime, guestCount, foodChoice,
  allergyNotes, addonsSummary, baseAmount, addonsAmount, totalAmount,
  contactEmail, contactPhone, slotHoldId, cardholderName, cardBrand, cardLast4,
  paymentProvider, stripePaymentIntentId, poliTransactionToken, poliTransactionRef,
  cateringChoice, noAlcoholAck,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!slotHoldId) {
      throw new SlotHoldExpiredError('No active slot hold was supplied for this booking.');
    }

    // Lock the hold row first and confirm it's still live. FOR UPDATE blocks
    // any concurrent claim/expiry-reclaim of this exact row until we commit
    // or roll back, so nothing can steal or invalidate it out from under us
    // between this check and the UPDATE below. We can't set booking_timeslots
    // .booking_id yet — booking_timeslots_booking_id_fkey requires the
    // bookings row to exist first — so the actual claim happens after the
    // INSERT, but the exclusivity guarantee comes from this lock, not from
    // statement ordering.
    const { rows: [lockedHold] } = await client.query(
      `SELECT id, party_room_id, slot_date, slot_time FROM booking_timeslots
       WHERE id = $1 AND status = 'held' AND hold_expires_at > now()
       FOR UPDATE`,
      [slotHoldId]
    );
    if (!lockedHold) {
      throw new SlotHoldExpiredError();
    }
    // The hold being live isn't enough — it must be a hold on THIS booking's
    // room/date/time. slotHoldId is just an opaque id; nothing upstream of
    // this function guarantees it still refers to the same slot the customer
    // is actually paying for (client-side state can drift the displayed
    // room away from the one it originally held — see SlotHoldMismatchError).
    // party_date comes back from Postgres as a Date; compare as ISO date
    // strings rather than assuming partyDate's exact string form matches.
    const lockedDate = lockedHold.slot_date.toISOString().slice(0, 10);
    if (lockedHold.party_room_id !== room.id || lockedDate !== partyDate || lockedHold.slot_time !== partyTime) {
      throw new SlotHoldMismatchError();
    }

    const { rows: [booking] } = await client.query(
      `INSERT INTO bookings
         (booking_ref, user_id, party_room_id, party_date, party_time, guest_count,
          food_choice, allergy_notes, addons_summary, base_amount, addons_amount,
          total_amount, status, contact_email, contact_phone, stripe_payment_intent_id,
          catering_choice, no_alcohol_ack)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'confirmed',$13,$14,$15,$16,$17)
       RETURNING id`,
      [bookingRef, uid, room.id, partyDate, partyTime, guestCount,
       foodChoice, allergyNotes, addonsSummary, baseAmount, addonsAmount,
       totalAmount, contactEmail, contactPhone, stripePaymentIntentId || null,
       cateringChoice || null, !!noAlcoholAck]
    );

    // Re-assert the same conditions here (defense in depth, and to satisfy
    // "abort on 0 rows affected" as a hard rule rather than relying solely on
    // the earlier lock) — under the FOR UPDATE lock this can only fail if the
    // row was deleted between the SELECT and here, which nothing in this
    // codebase does to a row this transaction is holding.
    const { rows: [claimed] } = await client.query(
      `UPDATE booking_timeslots SET status = 'confirmed', booking_id = $1
       WHERE id = $2 AND status = 'held' AND hold_expires_at > now()
         AND party_room_id = $3 AND slot_date = $4 AND slot_time = $5
       RETURNING id`,
      [booking.id, slotHoldId, room.id, partyDate, partyTime]
    );
    if (!claimed) {
      throw new SlotHoldExpiredError();
    }

    await client.query(
      `INSERT INTO payments
         (booking_id, user_id, stripe_payment_intent_id, amount, currency, status, cardholder_name,
          card_brand, card_last4, payment_provider, poli_transaction_token, poli_transaction_ref)
       VALUES ($1,$2,$3,$4,'nzd','succeeded',$5,$6,$7,$8,$9,$10)`,
      [booking.id, uid, stripePaymentIntentId || null, totalAmount, cardholderName || null,
       cardBrand || null, cardLast4 || null, paymentProvider || 'stripe',
       poliTransactionToken || null, poliTransactionRef || null]
    );

    await client.query('COMMIT');

    // No PII in this event — just the room and a timestamp, for the customer-facing
    // "just booked" toast.
    eventBus.emit('booking:confirmed', {
      roomDisplayName: roomDisplayName(room.name),
      time: Date.now(),
    });

    return booking.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createConfirmedBooking, SlotHoldExpiredError, SlotHoldMismatchError };
