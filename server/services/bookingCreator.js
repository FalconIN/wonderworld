const pool = require('../db');
const eventBus = require('../eventBus');
const { roomDisplayName } = require('../roomDisplayNames');

// Shared by both the Stripe path (server/routes/bookings.js, verified via
// paymentIntents.retrieve before calling this) and the POLi path
// (server/routes/poli.js, verified via getTransaction before calling this).
// Caller is responsible for verifying payment success and the charged
// amount BEFORE calling this — this function trusts its inputs completely.
async function createConfirmedBooking({
  bookingRef, uid, room, partyDate, partyTime, guestCount, foodChoice,
  allergyNotes, addonsSummary, baseAmount, addonsAmount, totalAmount,
  contactEmail, contactPhone, slotHoldId, cardholderName, cardBrand, cardLast4,
  paymentProvider, stripePaymentIntentId, poliTransactionToken, poliTransactionRef,
}) {
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
       totalAmount, contactEmail, contactPhone, stripePaymentIntentId || null]
    );

    if (slotHoldId) {
      await client.query(
        `UPDATE booking_timeslots SET status = 'confirmed', booking_id = $1 WHERE id = $2`,
        [booking.id, slotHoldId]
      );
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

module.exports = { createConfirmedBooking };
