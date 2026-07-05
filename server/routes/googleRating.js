const express = require('express');
const router  = express.Router();
const { placesDetailsRequest } = require('../services/placesApi');

let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchFromPlacesAPI(apiKey, placeId) {
  const result = await placesDetailsRequest(apiKey, placeId, 'rating,user_ratings_total');
  return {
    rating:           result.rating,
    userRatingsTotal: result.user_ratings_total,
  };
}

// GET /api/google-rating
router.get('/', async (req, res) => {
  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY / GOOGLE_PLACE_ID not configured' });
  }

  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }

  try {
    const data = await fetchFromPlacesAPI(apiKey, placeId);
    cache     = data;
    cacheTime = now;
    return res.json({ ...data, cached: false });
  } catch (err) {
    console.error('Google Places fetch failed:', err.message);
    // Serve stale cache rather than a hard error
    if (cache) return res.json({ ...cache, cached: true, stale: true });
    return res.status(502).json({ error: err.message });
  }
});

module.exports = router;
