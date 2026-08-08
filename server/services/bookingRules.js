// Day-of-week booking restrictions, shared by every server-side entry point
// that can create/hold a booking_timeslots row (customer checkout in
// server/routes/bookings.js and the admin manual-booking path in
// server/routes/admin.js) so a restricted slot/room can't be booked on the
// wrong day no matter which path is used — mirrors the client-side copies
// of this same data in booking.js / admin.js, which exist only for UI
// (greying out options); this file is the actual source of truth.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// slot_time values (independent of room) that are only bookable on certain
// days, regardless of which ordinary per-child room they're booked against.
const RESTRICTED_SLOT_DAYS = {
  '5:30 PM': [5, 6], // Friday & Saturday only
};

function describeDays(days) {
  return days.map(d => DAY_NAMES[d]).join('/');
}

// Parses a 'YYYY-MM-DD' date string into a day-of-week int (0=Sun..6=Sat)
// without going through the server host's local timezone — party_date is
// already the NZ wall-clock calendar date, so this just reads the Y/M/D
// components directly rather than letting `new Date(dateStr)` reinterpret
// them against UTC or the host's TZ.
function dayOfWeekFromDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Throws a customer-facing Error if `room` (a party_rooms row with at least
// `name` and `allowed_days_of_week`) can't be booked for `slotTime` on
// `dateStr`. Called before any hold/booking row is written.
function assertBookingAllowedOnDate(room, slotTime, dateStr) {
  const dow = dayOfWeekFromDateStr(dateStr);

  if (Array.isArray(room.allowed_days_of_week) && room.allowed_days_of_week.length > 0
      && !room.allowed_days_of_week.includes(dow)) {
    throw new Error(`${room.name} can only be booked on ${describeDays(room.allowed_days_of_week)}.`);
  }

  const restrictedDays = RESTRICTED_SLOT_DAYS[slotTime];
  if (restrictedDays && !restrictedDays.includes(dow)) {
    throw new Error(`The ${slotTime} time slot is only available on ${describeDays(restrictedDays)}.`);
  }
}

module.exports = { RESTRICTED_SLOT_DAYS, dayOfWeekFromDateStr, assertBookingAllowedOnDate, describeDays };
