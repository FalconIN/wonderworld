require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const app = express();

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

// Public client config — serves only the values that are safe for the browser.
// Nothing secret lives here; Firebase client keys and Stripe PK are public by design.
app.get('/api/config', (req, res) => {
  res.json({
    FIREBASE_API_KEY:             process.env.FIREBASE_API_KEY             || '',
    FIREBASE_AUTH_DOMAIN:         process.env.FIREBASE_AUTH_DOMAIN         || '',
    FIREBASE_PROJECT_ID:          process.env.FIREBASE_PROJECT_ID          || '',
    FIREBASE_STORAGE_BUCKET:      process.env.FIREBASE_STORAGE_BUCKET      || '',
    FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    FIREBASE_APP_ID:              process.env.FIREBASE_APP_ID              || '',
    STRIPE_PK:                    process.env.STRIPE_PUBLIC_KEY            || '',
    ENVIRONMENT:                  process.env.ENVIRONMENT                  || 'production',
  });
});

// Serve static frontend files (Nginx handles this in production, but useful for local dev)
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname, '..')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
