const crypto = require('crypto');
const pool   = require('../db');
const { placesDetailsRequest } = require('./placesApi');

// Places Details returns at most 5 reviews per call (a real API limitation,
// not something fixable client-side) — the stored set only ever grows/refreshes
// with whatever 5 the API currently surfaces as "most relevant."
async function fetchAndStoreReviews() {
  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    console.log('Google reviews sync skipped: GOOGLE_PLACES_API_KEY / GOOGLE_PLACE_ID not configured');
    return { ok: false, reason: 'not_configured' };
  }

  const result = await placesDetailsRequest(apiKey, placeId, 'reviews');
  const reviews = (result.reviews || []).filter(r => r.rating === 5 && r.text && r.text.trim().length > 0);

  let stored = 0;
  for (const r of reviews) {
    // Places API has no guaranteed persistent review id — author_url+time is the
    // most stable pairing available; fall back to a hash of name+time if absent.
    const googleReviewId = r.author_url
      ? `${r.author_url}#${r.time}`
      : crypto.createHash('md5').update(`${r.author_name}:${r.time}`).digest('hex');

    await pool.query(
      `INSERT INTO google_reviews
         (google_review_id, author_name, rating, text, time, profile_photo_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (google_review_id) DO UPDATE
         SET author_name        = EXCLUDED.author_name,
             rating             = EXCLUDED.rating,
             text               = EXCLUDED.text,
             profile_photo_url  = EXCLUDED.profile_photo_url`,
      [googleReviewId, r.author_name, r.rating, r.text, r.time, r.profile_photo_url || null]
    );
    stored++;
  }

  return { ok: true, fetched: reviews.length, stored };
}

module.exports = { fetchAndStoreReviews };
