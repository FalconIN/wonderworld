// A Firebase-authenticated request can reach booking endpoints before the
// client's POST /api/users/profile call (fired right after signup) has
// landed — blocked Google-popup, network hiccup, or just a slow race — so
// req.user.uid is a valid Firebase user with no matching `users` row yet.
// Every write that stores a users(id) FK'd column (booking_sessions.user_id,
// booking_timeslots.held_by_user_id, ...) needs that row to exist first, so
// this bridges the gap with a no-op-if-present placeholder rather than
// making every writer duplicate the same upsert. Never overwrites a profile
// that already exists (ON CONFLICT DO NOTHING) — POST /users/profile remains
// the only place real profile fields get set.
async function ensureUserRow(pool, uid, email) {
  await pool.query(
    `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [uid, email || '']
  );
}

module.exports = { ensureUserRow };
