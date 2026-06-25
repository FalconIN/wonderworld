require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const ROOT = path.join(__dirname, '..');

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
const bookingsRouter      = require('./routes/bookings');
const adminRouter         = require('./routes/admin');
const notificationsRouter = require('./routes/notifications');

app.use('/api', bookingsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// JSON config endpoint (kept for reference / future use)
app.get('/api/config', (req, res) => res.json(clientConfig()));

// ---------------------------------------------------------------------------
// HTML pages — served dynamically so window.__ENV__ is always injected fresh
// ---------------------------------------------------------------------------
app.get(['/', '/index.html'],       serveHtml('index.html'));
app.get(['/login', '/login.html'],   serveHtml('login.html'));
app.get(['/admin', '/admin.html'],   serveHtml('admin.html'));
app.get(['/prices', '/prices.html'], serveHtml('prices.html'));
app.get(['/rooms', '/rooms.html'],   serveHtml('rooms.html'));
app.get(['/menu', '/menu.html'],     serveHtml('menu.html'));
app.get(['/faq', '/faq.html'],       serveHtml('faq.html'));
app.get(['/hours', '/hours.html'],   serveHtml('hours.html'));
app.get(['/rules', '/rules.html'],   serveHtml('rules.html'));
app.get(['/contact', '/contact.html'], serveHtml('contact.html'));

// All other static assets (JS, CSS, images, fonts, etc.)
app.use(express.static(ROOT));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
