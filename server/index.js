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

// Serve static frontend files (Nginx handles this in production, but useful for local dev)
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname, '..')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
