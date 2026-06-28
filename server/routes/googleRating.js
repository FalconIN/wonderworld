const express = require('express');
const router  = require('express').Router();
const https   = require('https');

let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function fetchFromPlacesAPI(apiKey, placeId) {
  return new Promise((resolve, reject) => {
    const url = `https://maps.googleapis.com/maps/api/place/details/json` +
                `?place_id=${encodeURIComponent(placeId)}` +
                `&fields=rating,user_ratings_total` +
                `&key=${apiKey}`;
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.status !== 'OK') return reject(new Error('Places API: ' + json.status));
          resolve({
            rating:           json.result.rating,
            userRatingsTotal: json.result.user_ratings_total,
          });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
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
