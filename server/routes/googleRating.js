const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/google-rating — the aggregate rating shown on the public site.
// Admin-set (see /api/admin/site-rating), not a live Google Places lookup.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT rating, review_count as "userRatingsTotal" FROM site_rating WHERE id = 1');
    if (!rows[0]) return res.status(404).json({ error: 'Rating not set yet' });
    res.json({ rating: parseFloat(rows[0].rating), userRatingsTotal: rows[0].userRatingsTotal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
