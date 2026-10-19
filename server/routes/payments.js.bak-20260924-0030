const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter, publicTokenLimiter } = require('../middleware/rateLimit');
const { verifyAndConfirmStripePayment } = require('../services/stripeReconcile');
const { ADDON_PRICES, priceAddons } = require('../services/addonPricing');

function hashUpgradeToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

// Mirrors bookings.js's parseFoodChoiceForTrim (vege match stripped out of
// the string first, so it can't also be picked up by the plain burger
// match) just enough to re-derive a total kid-count from the canonical
// "X Nuggets + Y Mini Burgers + Z Vege Burgers" string — used here only to
// verify the food step was actually completed for the FULL new headcount
// before letting a venue-upgrade payment proceed (a server-side re-check,
// not just relying on the pay page having gated its own button).
function foodChoiceTotal(foodChoice) {
  let remaining = String(foodChoice || '');
  let total = 0;
  const vegeMatch = remaining.match(/(\d+)\s*Ve(?:gie|ggie|ge)\s*Burgers?/i);
  if (vegeMatch) {
    total += parseInt(vegeMatch[1], 10);
    remaining = remaining.slice(0, vegeMatch.index) + remaining.slice(vegeMatch.index + vegeMatch[0].length);
  }
  const burMatch = remaining.match(/(\d+)\s*(?:Mini\s*)?Burgers?/i);
  if (burMatch) total += parseInt(burMatch[1], 10);
  const nugMatch = remaining.match(/(\d+)\s*Nuggets?/i);
  if (nugMatch) total += parseInt(nugMatch[1], 10);
  return total;
}

// Finalizes a completed venue-upgrade payment from the webhook. Guards on
// `paid_at IS NULL` in its own UPDATE...RETURNING so a Stripe retry
// redelivering the same event (or the customer somehow re-triggering
// payment) finds nothing left to do the second time — idempotent by
// construction, not by a separate "already processed?" check.
async function finalizeVenueUpgradePayment(pi) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [link] } = await client.query(
      `UPDATE booking_payment_links SET paid_at = now()
       WHERE stripe_payment_intent_id = $1 AND paid_at IS NULL AND invalidated_at IS NULL
       RETURNING id, booking_id as "bookingId", amount_cents as "amountCents",
                 additional_addons as "additionalAddons", additional_addons_summary as "additionalAddonsSummary"`,
      [pi.id]
    );
    if (!link) { await client.query('ROLLBACK'); return; }

    const { rows: [booking] } = await client.query(
      `SELECT user_id as "userId", pre_upgrade_party_room_id as "preRoomId"
       FROM bookings WHERE id = $1 AND upgrade_status = 'pending_payment'
       FOR UPDATE`,
      [link.bookingId]
    );
    if (!booking) { await client.query('ROLLBACK'); return; }

    await client.query(
      `INSERT INTO payments (booking_id, user_id, stripe_payment_intent_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, 'nzd', 'succeeded')`,
      [link.bookingId, booking.userId, pi.id, link.amountCents / 100]
    );

    // Anything the customer had already paid for before the venue upgrade
    // (food, addons) is untouched — bookings.addons_amount was never
    // written to while this link was outstanding (see /addons below), so
    // it's still exactly the pre-upgrade value. Only the addons newly
    // picked on THIS payment link get folded in now, re-priced from the
    // canonical table rather than trusting the link's stored amount.
    const additionalAddonsAmount = Object.entries(link.additionalAddons || {})
      .reduce((sum, [id, qty]) => sum + (ADDON_PRICES[id]?.price || 0) * (parseInt(qty, 10) || 0), 0);
    if (additionalAddonsAmount > 0) {
      await client.query(
        `UPDATE bookings SET
           addons_amount = addons_amount + $1,
           addons_summary = NULLIF(TRIM(BOTH ', ' FROM CONCAT_WS(', ', addons_summary, $2)), ''),
           total_amount = total_amount + $1,
           updated_at = now()
         WHERE id = $3`,
        [additionalAddonsAmount, link.additionalAddonsSummary, link.bookingId]
      );
    }

    await client.query(
      `UPDATE bookings SET upgrade_status = 'completed', updated_at = now() WHERE id = $1`,
      [link.bookingId]
    );

    // The original room/slot was held (not released) for the pending-
    // payment window (see /upgrade-to-venue) — now that the upgrade is
    // paid in full, free it for good.
    await client.query(
      `UPDATE booking_timeslots
       SET status = 'released', booking_id = NULL, held_by_user_id = NULL, hold_expires_at = NULL
       WHERE booking_id = $1 AND party_room_id = $2 AND status = 'held'`,
      [link.bookingId, booking.preRoomId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Returns a valid Stripe customer id for this user, healing the stored id if
// it's stale (e.g. left over from Stripe test mode — customer ids don't carry
// over between test and live mode, so a switch to live keys orphans every
// previously-stored id).
async function resolveStripeCustomer(uid, email) {
  const { rows: [user] } = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [uid]);
  if (user?.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(user.stripe_customer_id);
      if (!existing.deleted) return existing.id;
    } catch (e) {
      // Stale/invalid id — fall through and create a fresh one below.
    }
  }
  if (!email) return null;
  const customer = await stripe.customers.create({ email, metadata: { firebase_uid: uid } });
  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, uid]);
  return customer.id;
}

// POST /api/payments/create-intent
router.post('/create-intent', requireAuth, paymentLimiter, async (req, res) => {
  const { roomId, roomSlug, guestCount, addonsAmount = 0, currency = 'nzd', bookingRef, customerEmail, metadata = {} } = req.body;
  const uid = req.user.uid;
  if (!bookingRef || !bookingRef.trim()) return res.status(400).json({ error: 'Missing booking reference.' });
  try {
    const { rows: [room] } = await pool.query(
      'SELECT base_price_per_child, min_guests, max_guests, pricing_model, flat_price FROM party_rooms WHERE (id = $1 OR slug = $2) AND is_active = true LIMIT 1',
      [roomId || null, roomSlug || null]
    );
    if (!room) return res.status(400).json({ error: 'Invalid room.' });

    const guests = parseInt(guestCount, 10);
    if (!guests || guests < room.min_guests || guests > room.max_guests) {
      return res.status(400).json({ error: `This room requires between ${room.min_guests} and ${room.max_guests} guests.` });
    }

    // 'flat' rooms (whole-venue hire) charge a fixed rental price regardless
    // of guest count — see room.pricing_model.
    const baseAmount = room.pricing_model === 'flat'
      ? parseFloat(room.flat_price)
      : parseFloat(room.base_price_per_child) * guests;
    const amount = Math.round((baseAmount + parseFloat(addonsAmount || 0)) * 100);
    if (!amount || amount < 100) return res.status(400).json({ error: 'Invalid booking amount.' });

    // Create or retrieve Stripe Customer for saved-card support
    let customerId = null;
    if (customerEmail && uid) {
      try {
        customerId = await resolveStripeCustomer(uid, customerEmail);
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
router.post('/create-edit-intent', requireAuth, paymentLimiter, async (req, res) => {
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

    let customerId = null;
    try {
      customerId = await resolveStripeCustomer(uid, booking.contact_email);
    } catch (e) {
      // Non-fatal — proceed without customer
    }

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
router.post('/charge-saved-card', requireAuth, paymentLimiter, async (req, res) => {
  const { deltaAmount, bookingId, metadata = {} } = req.body;
  const uid = req.user.uid;

  if (!deltaAmount || deltaAmount <= 0) return res.status(400).json({ error: 'Invalid amount.' });

  try {
    const { rows: [user] } = await pool.query('SELECT stripe_customer_id, email FROM users WHERE id = $1', [uid]);
    if (!user?.stripe_customer_id) return res.status(404).json({ error: 'No saved card on file.' });

    const customerId = await resolveStripeCustomer(uid, user.email);
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    if (!pms.data.length) return res.status(404).json({ error: 'No saved card on file.' });

    const pmId = pms.data[0].id;
    const amount = Math.round(parseFloat(deltaAmount) * 100);

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'nzd',
      customer: customerId,
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

// GET /api/payments/upgrade-link/:token — public, token-gated. Lets the
// unauthenticated pay-upgrade.html page render the price breakdown before
// the customer pays.
router.get('/upgrade-link/:token', publicTokenLimiter, async (req, res) => {
  try {
    const { rows: [link] } = await pool.query(
      `SELECT l.id, l.amount_cents as "amountCents", l.base_amount_cents as "baseAmountCents",
              l.paid_at as "paidAt", l.invalidated_at as "invalidatedAt", l.deadline_at as "deadlineAt",
              l.additional_addons as "additionalAddons", l.additional_addons_summary as "additionalAddonsSummary",
              b.booking_ref as "bookingRef", b.guest_count as "guestCount",
              b.food_choice as "foodChoice", b.addons_summary as "existingAddonsSummary",
              r.name as "roomName"
       FROM booking_payment_links l
       JOIN bookings b ON b.id = l.booking_id
       JOIN party_rooms r ON r.id = b.party_room_id
       WHERE l.token_hash = $1`,
      [hashUpgradeToken(req.params.token)]
    );
    if (!link) return res.status(404).json({ error: 'This payment link is invalid.' });
    if (link.paidAt) return res.status(410).json({ error: 'This payment has already been completed.' });
    if (link.invalidatedAt) return res.status(410).json({ error: 'This payment link is no longer valid — please contact us for a current one.' });

    res.json({
      bookingRef: link.bookingRef, roomName: link.roomName, guestCount: link.guestCount,
      amountCents: link.amountCents, baseAmountCents: link.baseAmountCents, deadlineAt: link.deadlineAt,
      foodChoice: link.foodChoice || null,
      foodConfirmed: foodChoiceTotal(link.foodChoice) === link.guestCount,
      existingAddonsSummary: link.existingAddonsSummary || null,
      additionalAddons: link.additionalAddons || {},
      additionalAddonsSummary: link.additionalAddonsSummary || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/upgrade-link/:token/addons — public, token-gated.
// Lets the customer optionally add extra food/drinks at upgrade time,
// exactly like the wizard's Add-Ons step. Re-priced here from the
// canonical ADDON_PRICES table (never the client's own numbers) and
// stored separately from the booking's existing addons_amount so nothing
// already paid for gets touched — see finalizeVenueUpgradePayment, which
// folds this in only once the payment actually succeeds. Replaces (not
// appends to) any previous selection on this link, same as the food step.
router.post('/upgrade-link/:token/addons', publicTokenLimiter, async (req, res) => {
  try {
    const { rows: [link] } = await pool.query(
      `SELECT id, base_amount_cents as "baseAmountCents", paid_at as "paidAt", invalidated_at as "invalidatedAt"
       FROM booking_payment_links WHERE token_hash = $1`,
      [hashUpgradeToken(req.params.token)]
    );
    if (!link) return res.status(404).json({ error: 'This payment link is invalid.' });
    if (link.paidAt) return res.status(410).json({ error: 'This payment has already been completed.' });
    if (link.invalidatedAt) return res.status(410).json({ error: 'This payment link is no longer valid — please contact us for a current one.' });

    let priced;
    try {
      priced = priceAddons(req.body?.addons, req.body?.pizzaTypes, req.body?.sodaTypes);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const newAmountCents = link.baseAmountCents + priced.amountCents;

    // The addon change may have altered the amount — drop any
    // not-yet-confirmed PaymentIntent so create-intent mints a fresh one
    // for the new total rather than trying to update one in place.
    await pool.query(
      `UPDATE booking_payment_links
       SET additional_addons = $1, additional_addons_summary = $2, amount_cents = $3, stripe_payment_intent_id = NULL
       WHERE id = $4`,
      [JSON.stringify(priced.cleanAddons), priced.summary || null, newAmountCents, link.id]
    );

    res.json({ ok: true, addonsAmountCents: priced.amountCents, amountCents: newAmountCents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/upgrade-link/:token/food — public, token-gated.
// Required before payment (see create-intent's guard below): the customer
// must specify food for the FULL new headcount, not just the added kids —
// mirrors the existing customer edit-modal pattern (app.js's
// changeEditFoodSplit/editFoodSplitSection), which always has the customer
// rebuild the whole split from scratch when guest count increases, rather
// than pre-filling/appending to what was there before.
router.post('/upgrade-link/:token/food', publicTokenLimiter, async (req, res) => {
  const nuggets = parseInt(req.body?.nuggets, 10) || 0;
  const burgers = parseInt(req.body?.burgers, 10) || 0;
  const veges = parseInt(req.body?.veges, 10) || 0;
  if (nuggets < 0 || burgers < 0 || veges < 0) {
    return res.status(400).json({ error: 'Invalid food counts.' });
  }

  try {
    const { rows: [link] } = await pool.query(
      `SELECT l.id, l.booking_id as "bookingId", l.paid_at as "paidAt", l.invalidated_at as "invalidatedAt",
              b.guest_count as "guestCount"
       FROM booking_payment_links l JOIN bookings b ON b.id = l.booking_id
       WHERE l.token_hash = $1`,
      [hashUpgradeToken(req.params.token)]
    );
    if (!link) return res.status(404).json({ error: 'This payment link is invalid.' });
    if (link.paidAt) return res.status(410).json({ error: 'This payment has already been completed.' });
    if (link.invalidatedAt) return res.status(410).json({ error: 'This payment link is no longer valid — please contact us for a current one.' });

    const total = nuggets + burgers + veges;
    if (total !== link.guestCount) {
      return res.status(400).json({ error: `Food selection must add up to ${link.guestCount} kids (currently ${total}).` });
    }

    const parts = [];
    if (nuggets > 0) parts.push(`${nuggets} Nuggets`);
    if (burgers > 0) parts.push(`${burgers} Mini Burgers`);
    if (veges > 0) parts.push(`${veges} Vege Burgers`);
    const foodChoice = parts.join(' + ');

    await pool.query(`UPDATE bookings SET food_choice = $1, updated_at = now() WHERE id = $2`, [foodChoice, link.bookingId]);
    res.json({ ok: true, foodChoice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/upgrade-link/:token/create-intent — public, token-
// gated. Creates (or reuses) a Stripe PaymentIntent for EXACTLY the
// server-stored amount_cents — the client never supplies an amount here,
// closing the gap in the existing create-edit-intent pattern (which trusts
// a client-submitted deltaAmount) at a much larger dollar value.
router.post('/upgrade-link/:token/create-intent', publicTokenLimiter, async (req, res) => {
  try {
    const { rows: [link] } = await pool.query(
      `SELECT l.id, l.booking_id as "bookingId", l.amount_cents as "amountCents",
              l.paid_at as "paidAt", l.invalidated_at as "invalidatedAt",
              l.stripe_payment_intent_id as "stripePaymentIntentId",
              b.contact_email as "contactEmail", b.guest_count as "guestCount", b.food_choice as "foodChoice"
       FROM booking_payment_links l JOIN bookings b ON b.id = l.booking_id
       WHERE l.token_hash = $1`,
      [hashUpgradeToken(req.params.token)]
    );
    if (!link) return res.status(404).json({ error: 'This payment link is invalid.' });
    if (link.paidAt) return res.status(410).json({ error: 'This payment has already been completed.' });
    if (link.invalidatedAt) return res.status(410).json({ error: 'This payment link is no longer valid — please contact us for a current one.' });
    // Re-checked here, not just gated client-side by the pay page's own
    // "Continue to Payment" button — food for the full new headcount must
    // be confirmed via POST .../food before a PaymentIntent can be created.
    if (foodChoiceTotal(link.foodChoice) !== link.guestCount) {
      return res.status(400).json({ error: 'Please confirm food selection for all guests before paying.' });
    }

    // Reuse an existing not-yet-confirmed intent if one was already created
    // for this link (e.g. the customer reloaded the page) rather than
    // minting a fresh one every time.
    if (link.stripePaymentIntentId) {
      try {
        const existing = await stripe.paymentIntents.retrieve(link.stripePaymentIntentId);
        if (existing.status === 'requires_payment_method' || existing.status === 'requires_confirmation') {
          return res.json({ clientSecret: existing.client_secret });
        }
      } catch (e) {
        // Fall through and create a new one.
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount: link.amountCents,
      currency: 'nzd',
      automatic_payment_methods: { enabled: true },
      description: `Wonder World Westgate — Whole Venue Hire upgrade`,
      receipt_email: link.contactEmail || undefined,
      metadata: { booking_payment_link_id: link.id, booking_id: link.bookingId, venue_upgrade: 'true' },
    });
    await pool.query(`UPDATE booking_payment_links SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, link.id]);

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

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;

      if (pi.metadata?.venue_upgrade === 'true') {
        await finalizeVenueUpgradePayment(pi).catch(err =>
          console.error(`Venue-upgrade payment finalize failed for ${pi.id}:`, err)
        );
      } else {
        // Safety net: finalize the booking here if the customer's browser
        // never called POST /api/bookings after Stripe confirmed the charge
        // (tab closed, connection dropped, app crashed) — see WW-C2PRDY
        // incident, 2026-08-11. Idempotent against the client's own call;
        // whichever gets there first wins, see verifyAndConfirmStripePayment.
        await verifyAndConfirmStripePayment(pi.id).catch(err =>
          console.error(`Stripe safety-net reconciliation failed for ${pi.id}:`, err)
        );

        await pool.query(
          `UPDATE payments SET status = 'succeeded', updated_at = now()
           WHERE stripe_payment_intent_id = $1`,
          [pi.id]
        );
      }
    }

    // Booking confirmation for the common case still happens client-side —
    // the frontend confirms payment in-browser, then calls POST
    // /api/bookings, which independently re-verifies the charge via
    // paymentIntents.retrieve before writing anything. That's still the
    // fast path (the customer sees the confirmation screen instantly instead
    // of waiting on webhook delivery). The safety net above only does
    // anything when that call never arrives. This handler (and succeeded,
    // above) is otherwise a redundant reconciliation pass, and for failures
    // specifically it's usually a no-op: a `payments` row is only ever
    // inserted after a booking is confirmed, so a PaymentIntent that fails
    // before that point has no row here to update yet. Kept anyway so this
    // self-heals if that ever changes, and for admin visibility via
    // `error_message`.
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      await pool.query(
        `UPDATE payments SET status = 'failed', error_message = $2, updated_at = now()
         WHERE stripe_payment_intent_id = $1`,
        [pi.id, pi.last_payment_error?.message || null]
      );
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      await pool.query(
        `UPDATE payments SET status = 'refunded', refunded_at = now(), updated_at = now()
         WHERE stripe_payment_intent_id = $1`,
        [charge.payment_intent]
      );
    }
  } catch (err) {
    // Return non-2xx so Stripe retries this webhook on its own backoff schedule
    // instead of the DB write being silently lost.
    console.error(`Webhook DB update failed for ${event.type} (${event.id}):`, err);
    return res.status(500).json({ error: 'Failed to record webhook event.' });
  }

  res.json({ received: true });
});

module.exports = router;
