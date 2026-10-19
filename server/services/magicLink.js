const crypto = require('crypto');
const pool = require('../db');

const MAGIC_LOGIN_URL = 'https://wonderworldwestgate.co.nz/magic-login';
const TOKEN_TTL_HOURS = 24;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Invalidates any outstanding (unused, not-yet-invalidated) token for this
// user and issues a fresh one — resend always mints a brand new token rather
// than extending/reusing the old one, so a leaked-then-expired link can't
// silently become valid again without the customer knowing a new one was
// even sent. Returns the raw token (only ever held in memory here and in the
// emailed URL — never persisted; the DB only ever sees its hash).
async function createMagicLinkToken({ userId, adminUid }) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  await pool.query(
    `UPDATE magic_link_tokens SET invalidated_at = now()
     WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
    [userId]
  );
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token_hash, expires_at, created_by_admin_id)
     VALUES ($1, $2, now() + interval '${TOKEN_TTL_HOURS} hours', $3)`,
    [userId, tokenHash, adminUid]
  );

  return rawToken;
}

// Validates a raw token from the URL and, if valid, marks it used (single-
// use) and returns the row. Returns null on any failure (not found, used,
// invalidated, expired) — callers deliberately don't distinguish which,
// mirroring the anti-enumeration posture of the password-reset flow: a
// definite failure page is unavoidable here (the client needs to show
// something), but there's no reason to tell a caller *why* a token failed.
async function consumeMagicLinkToken(rawToken) {
  const tokenHash = hashToken(String(rawToken || ''));
  const { rows: [row] } = await pool.query(
    `UPDATE magic_link_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
     RETURNING user_id as "userId"`,
    [tokenHash]
  );
  return row || null;
}

function buildMagicLinkUrl(rawToken) {
  return `${MAGIC_LOGIN_URL}?token=${encodeURIComponent(rawToken)}`;
}

async function sendMagicLinkEmail({ email, firstName, rawToken, bookingRef }) {
  const link = buildMagicLinkUrl(rawToken);
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
    to:      email,
    subject: `🔑 Set up online access for your booking — Ref: ${bookingRef}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
        <div style="background:linear-gradient(135deg,#1E3A8A,#3B82F6);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
          <div style="font-size:40px;margin-bottom:8px">🔑</div>
          <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Set up your account</h1>
          <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
        </div>
        <p style="font-size:15px;margin-bottom:24px">Hi <strong>${firstName || 'there'}</strong>! Use the link below to set up online access for booking <strong>${bookingRef}</strong> — no password needed to get in the first time.</p>
        <div style="text-align:center;margin-bottom:24px">
          <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#F97316,#EA6000);color:white;font-weight:700;font-size:15px;text-decoration:none;border-radius:14px;padding:14px 32px">Set Up My Account →</a>
        </div>
        <p style="font-size:13px;color:#6B7280">This link expires in 24 hours and can only be used once. If it expires, contact us and we can send a new one.</p>
        <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
      </div>
    `,
  });
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { createMagicLinkToken, consumeMagicLinkToken, sendMagicLinkEmail, buildMagicLinkUrl, hashToken };
