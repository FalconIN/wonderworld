require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const ROOT = path.join(__dirname, '..');

// Single reverse proxy hop (nginx) in front of us — needed so req.ip / rate
// limiting see the real client IP from X-Forwarded-For instead of nginx's.
app.set('trust proxy', 1);

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

// ---------------------------------------------------------------------------
// Client-safe config — read from process.env at request time, never hardcoded
// ---------------------------------------------------------------------------
function clientConfig() {
  return {
    FIREBASE_API_KEY:             process.env.FIREBASE_API_KEY             || '',
    FIREBASE_AUTH_DOMAIN:         process.env.FIREBASE_AUTH_DOMAIN         || '',
    FIREBASE_PROJECT_ID:          process.env.FIREBASE_PROJECT_ID          || '',
    FIREBASE_STORAGE_BUCKET:      process.env.FIREBASE_STORAGE_BUCKET      || '',
    FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    FIREBASE_APP_ID:              process.env.FIREBASE_APP_ID              || '',
    STRIPE_PK:                    process.env.STRIPE_PUBLIC_KEY            || '',
    ENVIRONMENT:                  process.env.ENVIRONMENT                  || 'production',
    POLI_CONFIGURED:              !!(process.env.POLI_MERCHANT_CODE && process.env.POLI_AUTH_CODE),
  };
}

// Serves an HTML file with window.__ENV__ injected before </head>
function serveHtml(file) {
  return (req, res) => {
    try {
      let html = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const tag = `<script>\nwindow.__ENV__ = ${JSON.stringify(clientConfig())};\n</script>`;
      html = html.replace('</head>', tag + '\n</head>');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).send('Error loading page');
    }
  };
}

// Stripe webhook needs raw body — mount BEFORE express.json()
const paymentsRouter = require('./routes/payments');
app.use('/api/stripe', paymentsRouter);

// Standard middleware
app.use(express.json());
app.use(cors({ origin: process.env.SITE_URL || '*' }));

// API routes
const bookingsRouter         = require('./routes/bookings');
const adminRouter            = require('./routes/admin');
const notificationsRouter    = require('./routes/notifications');
const liveNotificationsRouter = require('./routes/liveNotifications');
const googleRatingRouter     = require('./routes/googleRating');
const reviewsRouter          = require('./routes/reviews');
const poliRouter              = require('./routes/poli');
const authRouter              = require('./routes/auth');

app.use('/api', bookingsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/notifications', liveNotificationsRouter);
app.use('/api/google-rating', googleRatingRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/poli', poliRouter);
app.use('/api/auth', authRouter);

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------
const cron = require('node-cron');
const { fetchAndStoreReviews } = require('./services/googleReviewsSync');

cron.schedule('0 3 * * *', () => {
  fetchAndStoreReviews().catch(err => console.error('Google reviews sync failed:', err.message));
});
// Run once at boot too, so the table isn't empty until 3am
fetchAndStoreReviews().catch(err => console.error('Initial Google reviews sync failed:', err.message));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// JSON config endpoint (kept for reference / future use)
app.get('/api/config', (req, res) => res.json(clientConfig()));

// ---------------------------------------------------------------------------
// HTML pages — served dynamically so window.__ENV__ is always injected fresh
// ---------------------------------------------------------------------------
app.get(['/', '/index.html'],       serveHtml('index.html'));
app.get(['/login', '/login.html'],   serveHtml('login.html'));
app.get(['/reset-password', '/reset-password.html'], serveHtml('reset-password.html'));
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/admin',      serveHtml('admin.html'));
app.get(['/prices', '/prices.html'], serveHtml('prices.html'));
app.get(['/rooms', '/rooms.html'],   serveHtml('rooms.html'));
app.get(['/gallery', '/gallery.html'], serveHtml('gallery.html'));
app.get(['/menu', '/menu.html'],     serveHtml('menu.html'));
app.get(['/faq', '/faq.html'],       serveHtml('faq.html'));
app.get(['/hours', '/hours.html'],   serveHtml('hours.html'));
app.get(['/rules', '/rules.html'],   serveHtml('rules.html'));
app.get(['/contact', '/contact.html'], serveHtml('contact.html'));
app.get(['/privacy', '/privacy.html'], serveHtml('privacy.html'));

// All other static assets (JS, CSS, images, fonts, etc.)
app.use(express.static(ROOT));

// Global error handler — catches anything a route passed to next(err) or threw
// synchronously that wasn't already caught by its own try/catch.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  // body-parser and other middleware set err.status/statusCode for client errors
  // (e.g. malformed JSON) — respect that instead of always logging as a 500.
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
