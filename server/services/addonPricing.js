// Server-side mirror of booking.js's ADDON_PRICES / getAddonSummaryLines —
// needed so the Stripe safety-net reconciliation (stripeReconcile.js) can
// rebuild an order summary purely from booking_sessions.wizard_state,
// without the browser ever coming back. Keep in sync with booking.js if
// the menu changes.
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
  drinks_soda:     { label: 'Soft Drink',                 price: 10 },
  nuggets_15pc:    { label: 'Chicken Nuggets (15pc)',     price: 20 },
  fries_large:     { label: 'Large Fries',                price: 20 },
  gf_nuggets:      { label: 'Gluten-Free Nuggets',        price: 5 },
};

function getAddonTotal(addons) {
  if (!addons) return 0;
  return Object.entries(addons).reduce((sum, [id, qty]) => {
    return sum + (ADDON_PRICES[id]?.price || 0) * qty;
  }, 0);
}

// Mirrors booking.js's getAddonSummaryLines()/addonsSummary text format
// exactly, so a server-rebuilt summary reads the same as a customer-built one.
function buildAddonsSummary({ addons, sodaTypes, pizzaTypes }) {
  if (!addons) return '';
  return Object.entries(addons)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => {
      const a = ADDON_PRICES[id];
      if (!a) return null;
      let label = a.label;
      if (id === 'drinks_soda' && sodaTypes && Object.keys(sodaTypes).length > 0) {
        const parts = Object.entries(sodaTypes).filter(([, n]) => n > 0).map(([t, n]) => n > 1 ? `${t} x${n}` : t);
        label = 'Soft Drink (' + parts.join(', ') + ')';
      }
      if (id === 'pizza_11' && pizzaTypes && Object.keys(pizzaTypes).length > 0) {
        const parts = Object.entries(pizzaTypes).filter(([, n]) => n > 0).map(([t, n]) => n > 1 ? `${t} x${n}` : t);
        label = '11-inch Pizza (' + parts.join(', ') + ')';
      }
      const subtotal = a.price * qty;
      return `${label} ×${qty} ($${subtotal.toFixed(2)})`;
    })
    .filter(Boolean)
    .join(', ');
}

module.exports = { ADDON_PRICES, getAddonTotal, buildAddonsSummary };
