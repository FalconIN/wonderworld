const express = require('express');
const router  = express.Router();
require('../middleware/auth'); // ensures firebase-admin is initialised (idempotent)
const admin   = require('firebase-admin');
const pool    = require('../db');
const { passwordResetLimiter } = require('../middleware/rateLimit');

const RESET_PASSWORD_URL = 'https://wonderworldwestgate.co.nz/reset-password';

// POST /api/auth/forgot-password
// Generates a Firebase password-reset link via the Admin SDK and emails it
// through Resend with our own branding, instead of Firebase's default email.
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  // Always respond generically, whether or not the account exists, to avoid
  // leaking which emails have accounts.
  try {
    // generatePasswordResetLink() always points at Firebase's own hosted
    // /__/auth/action page regardless of actionCodeSettings (handleCodeInApp
    // only affects client-SDK-generated links) — pull out just the oobCode
    // and build our own URL so the email lands on our branded page instead.
    const rawLink = await admin.auth().generatePasswordResetLink(email);
    const oobCode = new URL(rawLink).searchParams.get('oobCode');
    const link = `${RESET_PASSWORD_URL}?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`;

    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { data, error } = await resend.emails.send({
      from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
      to:      email,
      subject: '🔑 Reset your Wonder World Westgate password',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
          <div style="background:linear-gradient(135deg,#1E3A8A,#3B82F6);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
            <div style="font-size:40px;margin-bottom:8px">🔑</div>
            <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Reset your password</h1>
            <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
          </div>

          <p style="font-size:15px;margin-bottom:24px">Hi there! We received a request to reset the password for your Wonder World Westgate account (<strong>${email}</strong>).</p>

          <div style="text-align:center;margin-bottom:24px">
            <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#F97316,#EA6000);color:white;font-weight:700;font-size:15px;text-decoration:none;border-radius:14px;padding:14px 32px">Reset My Password</a>
          </div>

          <p style="font-size:13px;color:#6B7280">This link will expire soon for security. If you didn't ask to reset your password, you can safely ignore this email — your password won't change.</p>
          <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
        </div>
      `,
    });

    if (error) throw new Error(error.message);

    await pool.query(
      'INSERT INTO email_logs (email_type, recipient, resend_id, status) VALUES ($1, $2, $3, $4)',
      ['password_reset', email, data?.id || null, 'sent']
    );
  } catch (err) {
    // auth/user-not-found lands here too — swallow it, log server-side only.
    console.error('Password reset email failed:', err.message);
  }

  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
});

module.exports = router;
