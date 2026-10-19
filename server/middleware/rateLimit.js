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

// Password reset is unauthenticated (no req.user yet), so key by IP only.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Too many password reset requests. Please wait a few minutes and try again.' },
});

// Magic-link verification and the venue-upgrade payment-link endpoints are
// both unauthenticated (a public token in a URL is the only credential) —
// same shape as passwordResetLimiter, defense in depth against token
// guessing even though both token spaces are large random values.
const publicTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

module.exports = { bookingLimiter, paymentLimiter, passwordResetLimiter, publicTokenLimiter };
