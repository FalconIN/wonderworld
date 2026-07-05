const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Booking/payment creation is authenticated, so key on the Firebase uid when
// present (falls back to IP for the rare case req.user isn't set yet) — IPv6
// addresses must go through ipKeyGenerator to normalize to a /64 subnet.
function keyByUserOrIp(req) {
  return req.user?.uid || ipKeyGenerator(req.ip);
}

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: 'Too many booking requests. Please wait a few minutes and try again.' },
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: 'Too many payment requests. Please wait a few minutes and try again.' },
});

module.exports = { bookingLimiter, paymentLimiter };
