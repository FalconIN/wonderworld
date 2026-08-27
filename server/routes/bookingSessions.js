const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');
const { bookingLimiter } = require('../middleware/rateLimit');

// Same ref scheme booking.js used client-side — now generated once, here,
// server-side, so the same ref flows through to the PaymentIntent and the
// final `bookings` row instead of drifting.
function generateBookingRef() {
  return 'WW-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// POST /api/booking-sessions/open — resume an in-progress wizard attempt, or
// start a new one. "Max 1 active attempt per customer" is enforced by the
// partial unique index on booking_sessions (user_id) WHERE status = 'active',
// not by this route's logic — the INSERT below just races against it.
router.post('/open', requireAuth, bookingLimiter, async (req, res) => {
  const uid = req.user.uid;
  try {
    // Lazy sweep, scoped to this user — mirrors the expired-slot-hold cleanup
    // in bookings.js. No cron; a session only gets marked expired when someone
    // next asks about it.
    await pool.query(
      `UPDATE booking_sessions SET status = 'expired', updated_at = now()
       WHERE user_id = $1 AND status = 'active' AND expires_at < now()`,
      [uid]
    );

    const { rows: [active] } = await pool.query(
      `SELECT id, booking_ref as "bookingRef", wizard_state as "wizardState", expires_at as "expiresAt"
       FROM booking_sessions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [uid]
    );

    let session = active;
    let resumed = !!active;

    if (!session) {
      try {
        const { rows: [created] } = await pool.query(
          `INSERT INTO booking_sessions (user_id, booking_ref, wizard_state)
           VALUES ($1, $2, '{}'::jsonb)
           RETURNING id, booking_ref as "bookingRef", wizard_state as "wizardState", expires_at as "expiresAt"`,
          [uid, generateBookingRef()]
        );
        session = created;
      } catch (err) {
        if (err.code !== '23505') throw err;
        // Lost a race (two tabs opening at once, or the rare booking_ref
        // collision) — someone else's insert already won, resume that one.
        const { rows: [winner] } = await pool.query(
          `SELECT id, booking_ref as "bookingRef", wizard_state as "wizardState", expires_at as "expiresAt"
           FROM booking_sessions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
          [uid]
        );
        if (!winner) throw err;
        session = winner;
        resumed = true;
      }
    }

    // The slot hold and the session both run ~30 minutes but don't start in
    // lockstep (the hold only begins at step 2), so on resume the hold can
    // have already lapsed even though the session hasn't.
    let holdExpired = false;
    const wizardState = session.wizardState || {};
    if (wizardState.slotHoldId) {
      const { rows: [hold] } = await pool.query(
        `SELECT id FROM booking_timeslots WHERE id = $1 AND status = 'held' AND hold_expires_at > now()`,
        [wizardState.slotHoldId]
      );
      if (!hold) {
        holdExpired = true;
        delete wizardState.slotHoldId;
        delete wizardState.selectedDate;
        delete wizardState.selectedTime;
      }
    }

    res.json({
      sessionId: session.id,
      bookingRef: session.bookingRef,
      resumed,
      wizardState,
      expiresAt: session.expiresAt,
      holdExpired,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/booking-sessions/:id — autosave wizard progress as the customer
// moves between steps. Draft convenience state only, so last-write-wins under
// concurrent tabs is an acceptable tradeoff.
router.patch('/:id', requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const { wizardState } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE booking_sessions SET wizard_state = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3 AND status = 'active' AND expires_at > now()
       RETURNING id`,
      [JSON.stringify(wizardState || {}), req.params.id, uid]
    );
    if (!rows[0]) return res.status(410).json({ error: 'Session expired or not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
