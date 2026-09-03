// Auto-reverts a whole-venue-hire upgrade (see server/routes/admin.js
// POST /bookings/:id/upgrade-to-venue) whose payment deadline passed
// without full payment — "the party defaults back to the originally-paid
// headcount" per spec. Registered as a node-cron job in server/index.js,
// same shape as the other backstop jobs there (googleReviewsSync,
// stripeReconcile).
const pool = require('../db');
const { sendVenueUpgradeRevertedNotice } = require('./venueUpgradeNotifications');

async function revertExpiredUpgrades() {
  const { rows: expired } = await pool.query(
    `SELECT id FROM bookings WHERE upgrade_status = 'pending_payment' AND upgrade_deadline_at < now()`
  );
  for (const { id } of expired) {
    await revertOne(id).catch(err => console.error(`Venue-upgrade revert failed for booking ${id}:`, err));
  }
}

async function revertOne(bookingId) {
  const client = await pool.connect();
  let emailPayload = null;
  try {
    await client.query('BEGIN');

    // Re-checked inside the row lock (upgrade_status = 'pending_payment'
    // AND deadline passed) in case a webhook completed the payment between
    // the unlocked SELECT above and this transaction acquiring the lock —
    // if so, there's nothing to revert.
    const { rows: [booking] } = await client.query(
      `SELECT booking_ref as "bookingRef", contact_email as "contactEmail", user_id as "userId",
              party_room_id as "currentRoomId", total_amount as "currentTotalAmount",
              pre_upgrade_party_room_id as "preRoomId", pre_upgrade_guest_count as "preGuestCount",
              pre_upgrade_base_amount as "preBaseAmount", pre_upgrade_total_amount as "preTotalAmount"
       FROM bookings
       WHERE id = $1 AND upgrade_status = 'pending_payment' AND upgrade_deadline_at < now()
       FOR UPDATE`,
      [bookingId]
    );
    if (!booking) { await client.query('ROLLBACK'); return; }

    const { rows: [user] } = await client.query(`SELECT first_name as "firstName" FROM users WHERE id = $1`, [booking.userId]);
    const { rows: [origRoom] } = await client.query(`SELECT name FROM party_rooms WHERE id = $1`, [booking.preRoomId]);

    // Release the whole-venue slot claimed at upgrade time.
    await client.query(
      `UPDATE booking_timeslots SET status = 'released', booking_id = NULL, held_by_user_id = NULL, hold_expires_at = NULL
       WHERE booking_id = $1 AND party_room_id = $2 AND status = 'confirmed'`,
      [bookingId, booking.currentRoomId]
    );

    // Restore the original room's held slot to confirmed. It was held
    // (never released, and with hold_expires_at NULL so nothing else could
    // reclaim it — see /upgrade-to-venue) specifically so this restore
    // always succeeds. If it's somehow not there, don't half-revert —
    // leave the booking's upgrade_status alone and flag loudly instead of
    // silently producing an inconsistent (whole-venue room, original
    // pricing) booking.
    const { rowCount: restored } = await client.query(
      `UPDATE booking_timeslots
       SET status = 'confirmed', held_by_user_id = NULL, hold_expires_at = NULL, booking_id = $1
       WHERE booking_id = $1 AND party_room_id = $2 AND status = 'held'`,
      [bookingId, booking.preRoomId]
    );
    if (restored === 0) {
      await client.query('ROLLBACK');
      console.error(`Venue-upgrade revert: original slot for booking ${bookingId} was not found held as expected — needs manual staff review, not auto-reverted.`);
      return;
    }

    await client.query(
      `UPDATE bookings SET
         party_room_id = $1, guest_count = $2, base_amount = $3, total_amount = $4,
         upgrade_status = NULL, upgrade_overage_rate = NULL, upgrade_deadline_at = NULL,
         pre_upgrade_party_room_id = NULL, pre_upgrade_guest_count = NULL,
         pre_upgrade_base_amount = NULL, pre_upgrade_total_amount = NULL,
         updated_at = now()
       WHERE id = $5`,
      [booking.preRoomId, booking.preGuestCount, booking.preBaseAmount, booking.preTotalAmount, bookingId]
    );

    await client.query(
      `UPDATE booking_payment_links SET invalidated_at = now()
       WHERE booking_id = $1 AND paid_at IS NULL AND invalidated_at IS NULL`,
      [bookingId]
    );

    // 'system' is a dedicated seeded actor (migration-venue-upgrade.sql) —
    // booking_edits.changed_by is NOT NULL and there's no admin to
    // attribute an automatic revert to.
    await client.query(
      `INSERT INTO booking_edits
         (booking_id, changed_by, change_type, delta_amount, new_guest_count, old_party_room_id, new_party_room_id)
       VALUES ($1, 'system', 'venue_upgrade', $2, $3, $4, $5)`,
      [bookingId, parseFloat(booking.preTotalAmount) - parseFloat(booking.currentTotalAmount),
       booking.preGuestCount, booking.currentRoomId, booking.preRoomId]
    );

    await client.query('COMMIT');

    if (booking.contactEmail) {
      emailPayload = {
        email: booking.contactEmail, firstName: user?.firstName, bookingRef: booking.bookingRef,
        originalRoomName: origRoom?.name, originalGuestCount: booking.preGuestCount,
      };
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Sent after COMMIT, outside the transaction/connection — a slow email
  // provider shouldn't hold a pool connection open, and the revert itself
  // has already succeeded regardless of whether this send does.
  if (emailPayload) {
    await sendVenueUpgradeRevertedNotice(emailPayload).catch(err =>
      console.error(`Venue-upgrade reverted-notice email failed for booking ${bookingId}:`, err)
    );
  }
}

module.exports = { revertExpiredUpgrades };
