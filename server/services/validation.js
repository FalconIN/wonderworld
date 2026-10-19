// NZ mobile: 2x followed by 7-9 digits, after stripping any international
// prefix (+64/0064/64) AND a leading domestic 0 (the client's confirmPhone
// field sits next to a fixed "+64" label, so what it sends here normally
// has neither — e.g. "21234 5678" — though a leading 0 or country code is
// still accepted). Mirrors booking.js's isValidNzMobile so client and
// server agree on what counts as valid.
function isValidNzMobile(phone) {
  if (!phone || typeof phone !== 'string') return false;
  let cleaned = phone.replace(/[\s-]/g, '');
  cleaned = cleaned.replace(/^(\+?64|0064)/, '');
  cleaned = cleaned.replace(/^0/, '');
  return /^2[0-9]\d{6,8}$/.test(cleaned);
}

module.exports = { isValidNzMobile };
