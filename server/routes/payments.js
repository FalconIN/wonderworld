const express = require('express');
const router  = express.Router();
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');

// POST /api/payments/create-intent
router.post('/create-intent', requireAuth, async (req, res) => {
  const { roomId, roomSlug, guestCount, addonsAmount = 0, currency = 'nzd', bookingRef, customerEmail, metadata = {} } = req.body;
  const uid = req.user.uid;
  try {
    const { rows: [room] } = await pool.query(
      'SELECT base_price_per_child FROM party_rooms WHERE (id = $1 OR slug = $2) AND is_active = true LIMIT 1',
      [roomId || null, roomSlug || null]
    );
    if (!room) return res.status(400).json({ error: 'Invalid room.' });

    const baseAmount = parseFloat(room.base_price_per_child) * parseInt(guestCount, 10);
    const amount = Math.round((baseAmount + parseFloat(addonsAmount || 0)) * 100);
    if (!amount || amount < 100) return res.status(400).json({ error: 'Invalid booking amount.' });

    // Create or retrieve Stripe Customer for saved-card support
    let customerId = null;
    if (customerEmail && uid) {
      try {
        const { rows: [user] } = await pool.query(
          'SELECT stripe_customer_id FROM users WHERE id = $1', [uid]
        );
        if (user?.stripe_customer_id) {
          customerId = user.stripe_customer_id;
        } else {
          const customer = await stripe.customers.create({
            email: customerEmail,
            metadata: { firebase_uid: uid },
          });
          customerId = customer.id;
          await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, uid]);
        }
      } catch (e) {
        // Non-fatal — proceed without customer
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      ...(customerId ? { customer: customerId, setup_future_usage: 'off_session' } : {}),
      description: `Wonder World Westgate — ${bookingRef}`,
      receipt_email: customerEmail || undefined,
      metadata: { booking_ref: bookingRef, ...metadata },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/saved-card — check if user has a saved Stripe payment method
router.get('/saved-card', requireAuth, async (req, res) => {
  const uid = req.user.uid;
  try {
    const { rows: [user] } = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1', [uid]
    );
    if (!user?.stripe_customer_id) return res.json({ hasSavedCard: false });

    const pms = await stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card', limit: 1 });
    if (!pms.data.length) return res.json({ hasSavedCard: false });

    const pm = pms.data[0];
    res.json({
      hasSavedCard: true,
      cardBrand: pm.card?.brand || 'card',
      cardLast4: pm.card?.last4 || '****',
    });
  } catch (err) {
    res.json({ hasSavedCard: false });
  }
});

// POST /api/payments/create-edit-intent — PaymentIntent for the delta amount only
router.post('/create-edit-intent', requireAuth, async (req, res) => {
  const { deltaAmount, bookingId, currency = 'nzd', metadata = {} } = req.body;
  const uid = req.user.uid;

  if (!deltaAmount || deltaAmount <= 0) return res.status(400).json({ error: 'Invalid delta amount.' });

  try {
    // Verify the booking belongs to the user
    const { rows: [booking] } = await pool.query(
      'SELECT b.id, b.contact_email FROM bookings b WHERE b.id = $1 AND b.user_id = $2',
      [bookingId, uid]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    const { rows: [user] } = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [uid]);
    const customerId = user?.stripe_customer_id || null;

    const amount = Math.round(parseFloat(deltaAmount) * 100);
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      ...(customerId ? { customer: customerId } : {}),
      description: `Wonder World Westgate — Edit booking ${bookingId}`,
      receipt_email: booking.contact_email || undefined,
      metadata: { booking_id: bookingId, edit: 'true', ...metadata },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/charge-saved-card — charge the customer's saved payment method off-session
router.post('/charge-saved-card', requireAuth, async (req, res) => {
  const { deltaAmount, bookingId, metadata = {} } = req.body;
  const uid = req.user.uid;

  if (!deltaAmount || deltaAmount <= 0) return res.status(400).json({ error: 'Invalid amount.' });

  try {
    const { rows: [user] } = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [uid]);
    if (!user?.stripe_customer_id) return res.status(404).json({ error: 'No saved card on file.' });

    const pms = await stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card', limit: 1 });
    if (!pms.data.length) return res.status(404).json({ error: 'No saved card on file.' });

    const pmId = pms.data[0].id;
    const amount = Math.round(parseFloat(deltaAmount) * 100);

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'nzd',
      customer: user.stripe_customer_id,
      payment_method: pmId,
      off_session: true,
      confirm: true,
      description: `Wonder World Westgate — Edit booking ${bookingId}`,
      metadata: { booking_id: bookingId, edit: 'true', ...metadata },
    });

    if (intent.status === 'succeeded') {
      res.json({ paymentIntentId: intent.id });
    } else {
      res.status(402).json({ error: 'Payment could not be processed.', requiresAction: true });
    }
  } catch (err) {
    if (err.code === 'authentication_required') {
      return res.status(402).json({ error: 'Your card requires authentication. Please use a new card.', requiresAction: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook — Stripe webhook (raw body, validated with signature)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    await pool.query(
      `UPDATE payments SET status = 'succeeded', updated_at = now()
       WHERE stripe_payment_intent_id = $1`,
      [pi.id]
    ).catch(console.error);
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    await pool.query(
      `UPDATE payments SET status = 'refunded', refunded_at = now(), updated_at = now()
       WHERE stripe_payment_intent_id = $1`,
      [charge.payment_intent]
    ).catch(console.error);
  }

  res.json({ received: true });
});

module.exports = router;
