// Canonical add-on catalog for server-side pricing. Mirrors booking.js's
// ADDON_PRICES (customer wizard) — kept in sync manually, same
// two-copies-by-hand convention already used for the FEATURE_* flags in
// admin.js/server/routes/admin.js.
//
// gf_nuggets is a hybrid food+addon item in the wizard: folded into the
// nugget count for kitchen prep, but priced as a $5/kid upcharge carried in
// state.addons.gf_nuggets. It used to be left out of this catalog entirely,
// which made the Stripe webhook safety net see every GF order as a $5/kid
// "amount mismatch" and auto-refund it (WW-RPDM07, WW-PADY8M on 2026-09-12).
// It's only accepted when the caller passes opts.maxGfNuggets (the booking's
// guest count) — contexts with no food split, like upgrade payment links,
// don't offer it.
//
// opts.lenientFlavours: price a pizza/soda whose flavour split doesn't add up
// instead of throwing. Only for post-charge callers (POST /bookings, the
// webhook safety net), where rejecting means auto-refunding a paying
// customer over a missing flavour; pre-charge callers stay strict so the
// customer is asked to pick one.
const ADDON_PRICES = {
  pizza_11:        { label: '11-inch Pizza',              price: 25 },
  platter_chicken: { label: 'Fried Chicken Platter',      price: 39 },
  platter_seafood: { label: 'Seafood Platter',            price: 49 },
  adult_sandwich:  { label: 'Adult Sandwich Platter',     price: 60 },
  sushi_40:        { label: 'Sushi Platter (40 pcs)',     price: 60 },
  sushi_24:        { label: 'Sushi Platter (24 pcs)',     price: 30 },
  sushi_salmon:    { label: 'Salmon Supreme Platter',     price: 28.90 },
  sushi_ocean:     { label: 'Ocean Deluxe Set',           price: 39.90 },
  sushi_kids48:    { label: 'Kids Party Platter (48pcs)', price: 49.90 },
  sushi_garden28:  { label: 'Green Garden Platter (28pcs)', price: 42.90 },
  drinks_soda:     { label: 'Soft Drink', price: 10 },
  nuggets_15pc:    { label: 'Chicken Nuggets (15pc)', price: 20 },
  fries_large:     { label: 'Large Fries', price: 20 },
  gf_nuggets:      { label: 'Gluten-Free Nuggets', price: 5 },
};

const PIZZA_TYPES = ['Ham & Cheese', 'Salami & Cheese', 'Chorizo & Cheese', 'Plain Cheese', 'Vege Pizza'];
const SODA_TYPES  = ['Coke', 'Sprite', 'Fanta', 'L&P'];

// Prices and validates a customer's add-on selection — never trusts a
// client-submitted dollar amount, only known addon ids at their canonical
// prices (see /upgrade-link/:token/create-intent's comment on why: this
// codebase already has one known gap elsewhere, the general edit-addons
// flow, where the client's own delta is trusted; not repeating that here).
function priceAddons(addons, pizzaTypes, sodaTypes, opts = {}) {
  addons = addons && typeof addons === 'object' ? addons : {};
  pizzaTypes = pizzaTypes && typeof pizzaTypes === 'object' ? pizzaTypes : {};
  sodaTypes  = sodaTypes && typeof sodaTypes === 'object' ? sodaTypes : {};

  let amount = 0;
  const lines = [];
  const cleanAddons = {};

  for (const [id, rawQty] of Object.entries(addons)) {
    const item = ADDON_PRICES[id];
    const qty = parseInt(rawQty, 10) || 0;
    if (!item || qty <= 0) continue;
    if (qty > 500) throw new Error(`Unreasonable quantity for ${item.label}.`);
    if (id === 'gf_nuggets') {
      if (opts.maxGfNuggets === undefined) continue;
      if (qty > opts.maxGfNuggets) throw new Error('Gluten-free nuggets can\'t exceed the number of kids.');
    }

    cleanAddons[id] = qty;
    amount += item.price * qty;

    let label = item.label;
    if (id === 'drinks_soda') {
      const total = Object.values(sodaTypes).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
      if (total !== qty && !opts.lenientFlavours) throw new Error('Soft drink flavour selections must add up to the soft drink quantity.');
      const parts = Object.entries(sodaTypes)
        .filter(([t, n]) => SODA_TYPES.includes(t) && (parseInt(n, 10) || 0) > 0)
        .map(([t, n]) => (n > 1 ? `${t} x${n}` : t));
      label = parts.length ? `Soft Drink (${parts.join(', ')})` : 'Soft Drink';
    }
    if (id === 'pizza_11') {
      const total = Object.values(pizzaTypes).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
      if (total !== qty && !opts.lenientFlavours) throw new Error('Pizza flavour selections must add up to the pizza quantity.');
      const parts = Object.entries(pizzaTypes)
        .filter(([t, n]) => PIZZA_TYPES.includes(t) && (parseInt(n, 10) || 0) > 0)
        .map(([t, n]) => (n > 1 ? `${t} x${n}` : t));
      label = parts.length ? `11-inch Pizza (${parts.join(', ')})` : '11-inch Pizza';
    }
    // Unicode "×" like every other addons_summary writer — admin.js's
    // food-prep tally only recognises "×" as the outer quantity.
    lines.push(`${label} ×${qty} ($${(item.price * qty).toFixed(2)})`);
  }

  return { amount, amountCents: Math.round(amount * 100), summary: lines.join(', '), cleanAddons };
}

// Prices a customer checkout's add-ons server-side (create-intent, POLi
// initiate, POST /bookings) instead of trusting a client-sent addonsAmount,
// which previously let a tampered request pay only the room price while the
// booking still listed the add-ons. Current front-ends send the structured
// selection (addons/pizzaTypes/sodaTypes) in the body; browsers still running
// an older cached payment.js/booking.js don't, so fall back to the booking
// session's saved wizard_state (same source the Stripe webhook safety net
// prices from). Throws if neither is available or the selection is invalid.
async function priceCheckoutAddons(pool, body, bookingRef, uid, guests, { lenientFlavours = false } = {}) {
  let src = body && body.addons && typeof body.addons === 'object' ? body : null;
  if (!src && bookingRef) {
    const { rows: [session] } = await pool.query(
      `SELECT wizard_state FROM booking_sessions WHERE booking_ref = $1 AND user_id = $2`,
      [bookingRef, uid]
    );
    src = session ? (session.wizard_state || {}) : null;
  }
  if (!src) throw new Error('Missing add-on selection — please refresh the page and try again.');
  return priceAddons(src.addons, src.pizzaTypes, src.sodaTypes, { maxGfNuggets: guests, lenientFlavours });
}

module.exports = { ADDON_PRICES, PIZZA_TYPES, SODA_TYPES, priceAddons, priceCheckoutAddons };
