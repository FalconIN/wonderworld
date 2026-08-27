// A held slot's hold_expires_at (30 min) can lapse before its POLi payment
// finishes — POLi's bank-redirect flow can run well past that window. If
// anything reclaims the slot mid-payment, deleting/overwriting the
// booking_timeslots row cascades away the matching poli_pending_bookings
// payload (FK ON DELETE CASCADE), so by the time POLi calls back there's
// nothing left to finalize the booking against — the customer's charged,
// but we never find out (see WW-23LOKH incident, 2026-08-02/03).
//
// Give any slot with a recent pending POLi payment a grace window past its
// nominal 30-minute hold before it's fair game to reclaim. If the attempt
// really was abandoned, it becomes reclaimable again once that window lapses.
const PENDING_POLI_GRACE = "interval '1 hour'";

function reclaimableHoldClause(alias) {
  const col = alias ? `${alias}.` : '';
  return `${col}hold_expires_at < now() AND NOT EXISTS (
    SELECT 1 FROM poli_pending_bookings ppb
    WHERE ppb.slot_hold_id = ${col}id AND ppb.created_at > now() - ${PENDING_POLI_GRACE}
  )`;
}

module.exports = { reclaimableHoldClause };
