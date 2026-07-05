const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const eventBus = require('../eventBus');
const { roomDisplayName } = require('../roomDisplayNames');

// GET /api/notifications/live — SSE stream of booking-confirmed events
router.get('/live', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection:      'keep-alive',
  });
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const listener = (payload) => send(payload);
  eventBus.on('booking:confirmed', listener);

  // Heartbeat comment so intermediary proxies don't idle-time out the connection
  const heartbeat = setInterval(() => res.write(':hb\n\n'), 30000);

  req.on('close', () => {
    eventBus.removeListener('booking:confirmed', listener);
    clearInterval(heartbeat);
  });
});

// GET /api/notifications/recent — most recent confirmed booking, for the
// "seed" toast shown a few seconds after page load
router.get('/recent', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.name as "roomName", b.created_at as "createdAt"
       FROM bookings b
       JOIN party_rooms r ON r.id = b.party_room_id
       WHERE b.status = 'confirmed'
       ORDER BY b.created_at DESC
       LIMIT 1`
    );
    if (!rows[0]) return res.json(null);
    res.json({
      roomDisplayName: roomDisplayName(rows[0].roomName),
      time: new Date(rows[0].createdAt).getTime(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
