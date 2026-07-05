const https = require('https');

function placesDetailsRequest(apiKey, placeId, fields) {
  return new Promise((resolve, reject) => {
    const url = `https://maps.googleapis.com/maps/api/place/details/json` +
                `?place_id=${encodeURIComponent(placeId)}` +
                `&fields=${encodeURIComponent(fields)}` +
                `&key=${apiKey}`;
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.status !== 'OK') return reject(new Error('Places API: ' + json.status));
          resolve(json.result);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

module.exports = { placesDetailsRequest };
