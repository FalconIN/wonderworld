const express = require('express');
const router  = express.Router();
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');

// POST /api/payments/create-intent
router.post('/create-intent', requireAuth, async (req, res) => {
  const { roomId, guestCount, addonsAmount = 0, currency = 'nzd', bookingRef, customerEmail, metadata = {} } = req.body;

  try {
    // Compute price server-side — never trust a client-supplied amount
    const { rows: [room] } = await pool.query(
      'SELECT base_price_per_child FROM party_rooms WHERE id = $1 AND is_active = true',
      [roomId]
    );
    if (!room) return res.status(400).json({ error: 'Invalid room.' });

    const baseAmount = parseFloat(room.base_price_per_child) * parseInt(guestCount, 10);
    const amount = Math.round((baseAmount + parseFloat(addonsAmount || 0)) * 100);
    if (!amount || amount < 100) return res.status(400).json({ error: 'Invalid booking amount.' });

    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      description: `Wonder World Westgate — ${bookingRef}`,
      receipt_email: customerEmail || undefined,
      metadata: {
        booking_ref: bookingRef,
        ...metadata,
      },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
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
