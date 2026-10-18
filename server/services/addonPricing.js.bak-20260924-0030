// Canonical add-on catalog for server-side pricing. Mirrors booking.js's
// ADDON_PRICES (customer wizard) — kept in sync manually, same
// two-copies-by-hand convention already used for the FEATURE_* flags in
// admin.js/server/routes/admin.js. gf_nuggets is deliberately NOT
// supported here — in the wizard it's a hybrid food+addon item (folded
// into the nugget count for kitchen-prep, priced as a $5/kid upcharge),
// which doesn't fit this module's pure "id -> qty -> price" model without
// coordinating with the food-choice endpoint too. Left out on purpose.
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
};

const PIZZA_TYPES = ['Ham & Cheese', 'Salami & Cheese', 'Chorizo & Cheese', 'Plain Cheese', 'Vege Pizza'];
const SODA_TYPES  = ['Coke', 'Sprite', 'Fanta', 'L&P'];

// Prices and validates a customer's add-on selection — never trusts a
// client-submitted dollar amount, only known addon ids at their canonical
// prices (see /upgrade-link/:token/create-intent's comment on why: this
// codebase already has one known gap elsewhere, the general edit-addons
// flow, where the client's own delta is trusted; not repeating that here).
function priceAddons(addons, pizzaTypes, sodaTypes) {
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

    cleanAddons[id] = qty;
    amount += item.price * qty;

    let label = item.label;
    if (id === 'drinks_soda') {
      const total = Object.values(sodaTypes).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
      if (total !== qty) throw new Error('Soft drink flavour selections must add up to the soft drink quantity.');
      const parts = Object.entries(sodaTypes)
        .filter(([t, n]) => SODA_TYPES.includes(t) && (parseInt(n, 10) || 0) > 0)
        .map(([t, n]) => (n > 1 ? `${t} x${n}` : t));
      label = `Soft Drink (${parts.join(', ')})`;
    }
    if (id === 'pizza_11') {
      const total = Object.values(pizzaTypes).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
      if (total !== qty) throw new Error('Pizza flavour selections must add up to the pizza quantity.');
      const parts = Object.entries(pizzaTypes)
        .filter(([t, n]) => PIZZA_TYPES.includes(t) && (parseInt(n, 10) || 0) > 0)
        .map(([t, n]) => (n > 1 ? `${t} x${n}` : t));
      label = `11-inch Pizza (${parts.join(', ')})`;
    }
    lines.push(`${label} x${qty} ($${(item.price * qty).toFixed(2)})`);
  }

  return { amount, amountCents: Math.round(amount * 100), summary: lines.join(', '), cleanAddons };
}

module.exports = { ADDON_PRICES, PIZZA_TYPES, SODA_TYPES, priceAddons };
