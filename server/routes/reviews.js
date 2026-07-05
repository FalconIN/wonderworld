const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/reviews — public, live 5-star Google reviews for the customer carousel
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT author_name as "authorName", rating, text, time,
              profile_photo_url as "profilePhotoUrl"
       FROM google_reviews
       WHERE rating = 5 AND visible = true
       ORDER BY time DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
