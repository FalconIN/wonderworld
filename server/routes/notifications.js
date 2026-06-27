const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const pool    = require('../db');

// POST /api/notifications/booking-confirmation
// Sends confirmation email via Resend and SMS via Twilio
router.post('/booking-confirmation', requireAuth, async (req, res) => {
  const {
    bookingRef, bookingId, email, phone,
    firstName, lastName, roomName,
    partyDate, partyTime, guestCount, foodChoice, addonsSummary, totalAmount,
  } = req.body;

  const results = { email: null, sms: null };

  // ── Email via Resend ─────────────────────────────────────
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { data, error } = await resend.emails.send({
      from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
      to:      email,
      subject: `🎉 Party Booking Confirmed! Ref: ${bookingRef}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
          <div style="background:linear-gradient(135deg,#4F46E5,#7C3AED);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
            <div style="font-size:40px;margin-bottom:8px">🎉</div>
            <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Party Booking Confirmed!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
          </div>

          <p style="font-size:15px;margin-bottom:20px">Hi <strong>${firstName}</strong>! Your party is all locked in. Here's your summary:</p>

          <div style="background:#F9FAFB;border-radius:16px;padding:24px;margin-bottom:20px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:6px">Booking Reference</div>
            <div style="font-size:22px;font-weight:700;color:#4F46E5;margin-bottom:20px">${bookingRef}</div>
            <table style="width:100%;font-size:14px;border-collapse:collapse">
              <tr><td style="padding:6px 0;color:#6B7280;width:40%">Room</td><td style="font-weight:600">${roomName}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Date &amp; Time</td><td style="font-weight:600">${partyDate} at ${partyTime}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Guests</td><td style="font-weight:600">${guestCount} kids</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Food</td><td style="font-weight:600">${foodChoice || '—'}</td></tr>
              ${addonsSummary ? `<tr><td style="padding:6px 0;color:#6B7280">Add-ons</td><td style="font-weight:600">${addonsSummary}</td></tr>` : ''}
              <tr><td style="padding:10px 0 6px;color:#6B7280;border-top:1px solid #E5E7EB">Total Paid</td><td style="padding-top:10px;font-weight:700;font-size:16px;color:#4F46E5;border-top:1px solid #E5E7EB">$${parseFloat(totalAmount).toFixed(2)} NZD</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Receipt to</td><td style="font-weight:600">${email}</td></tr>
            </table>
          </div>

          <div style="background:#FEF3C7;border-radius:12px;padding:16px;margin-bottom:20px;font-size:14px">
            <strong>📌 Good to know:</strong><br>
            All guests must wear grip or non-slip socks. No outdoor shoes in the playground.<br>
            Outside birthday cake is welcome! 🎂
          </div>

          <p style="font-size:13px;color:#6B7280">Our team will be in touch within 24 hours to confirm the final details.<br>Questions? Email us at <a href="mailto:hello@wonderworldwestgate.co.nz" style="color:#4F46E5">hello@wonderworldwestgate.co.nz</a></p>

          <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
        </div>
      `,
    });

    if (error) throw new Error(error.message);
    results.email = 'sent';

    if (bookingId) {
      await pool.query(
        'INSERT INTO email_logs (booking_id, email_type, recipient, resend_id, status) VALUES ($1, $2, $3, $4, $5)',
        [bookingId, 'booking_confirmation', email, data?.id || null, 'sent']
      );
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
    results.email = 'failed: ' + err.message;
  }

  // ── SMS via Twilio ───────────────────────────────────────
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const nzPhone = phone.startsWith('+') ? phone : '+64' + phone.replace(/^0/, '');
    const msg = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   nzPhone,
      body: `Wonder World Westgate: Hi ${firstName}! Your party is confirmed 🎉 Ref: ${bookingRef}. ${roomName} on ${partyDate} @ ${partyTime}. Total: $${parseFloat(totalAmount).toFixed(2)}. See you soon!`,
    });

    results.sms = 'sent';

    if (bookingId) {
      await pool.query(
        'INSERT INTO sms_logs (booking_id, sms_type, recipient, twilio_sid, status) VALUES ($1, $2, $3, $4, $5)',
        [bookingId, 'booking_confirmation', nzPhone, msg.sid, 'sent']
      );
    }
  } catch (err) {
    console.error('SMS send failed:', err.message);
    results.sms = 'failed: ' + err.message;
  }

  res.json({ ok: true, results });
});

// POST /api/notifications/booking-modification
router.post('/booking-modification', requireAuth, async (req, res) => {
  const {
    bookingId, bookingRef, email, phone,
    firstName, roomName, partyDate, partyTime,
    newGuestCount, newFoodChoice, newAddonsSummary, deltaAmount, newTotalAmount,
  } = req.body;

  const results = { email: null, sms: null };

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const addonLine = newAddonsSummary ? `<tr><td style="padding:6px 0;color:#6B7280">New Add-ons</td><td style="font-weight:600">${newAddonsSummary}</td></tr>` : '';

    const { data, error } = await resend.emails.send({
      from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
      to:      email,
      subject: `✏️ Booking Updated — Ref: ${bookingRef}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
          <div style="background:linear-gradient(135deg,#F97316,#EA6000);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
            <div style="font-size:40px;margin-bottom:8px">✏️</div>
            <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Booking Updated!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
          </div>

          <p style="font-size:15px;margin-bottom:20px">Hi <strong>${firstName}</strong>! Your booking has been updated. Here's your revised summary:</p>

          <div style="background:#F9FAFB;border-radius:16px;padding:24px;margin-bottom:20px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:6px">Booking Reference</div>
            <div style="font-size:22px;font-weight:700;color:#F97316;margin-bottom:20px">${bookingRef}</div>
            <table style="width:100%;font-size:14px;border-collapse:collapse">
              <tr><td style="padding:6px 0;color:#6B7280;width:40%">Room</td><td style="font-weight:600">${roomName}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Date &amp; Time</td><td style="font-weight:600">${partyDate} at ${partyTime}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Guests (updated)</td><td style="font-weight:600">${newGuestCount} kids</td></tr>
              ${newFoodChoice ? `<tr><td style="padding:6px 0;color:#6B7280">Food (updated)</td><td style="font-weight:600">${newFoodChoice}</td></tr>` : ''}
              ${addonLine}
              ${parseFloat(deltaAmount) > 0 ? `<tr><td style="padding:6px 0;color:#6B7280">Additional charge</td><td style="font-weight:600">$${parseFloat(deltaAmount).toFixed(2)} NZD</td></tr>` : ''}
              <tr><td style="padding:10px 0 6px;color:#6B7280;border-top:1px solid #E5E7EB">New Total</td><td style="padding-top:10px;font-weight:700;font-size:16px;color:#F97316;border-top:1px solid #E5E7EB">$${parseFloat(newTotalAmount).toFixed(2)} NZD</td></tr>
            </table>
          </div>

          <p style="font-size:13px;color:#6B7280">Questions? Email us at <a href="mailto:Bookings@wonderworldwestgate.co.nz" style="color:#F97316">Bookings@wonderworldwestgate.co.nz</a></p>
          <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
        </div>
      `,
    });

    if (error) throw new Error(error.message);
    results.email = 'sent';

    if (bookingId) {
      await pool.query(
        'INSERT INTO email_logs (booking_id, email_type, recipient, resend_id, status) VALUES ($1, $2, $3, $4, $5)',
        [bookingId, 'booking_modified', email, data?.id || null, 'sent']
      );
    }
  } catch (err) {
    console.error('Modification email failed:', err.message);
    results.email = 'failed: ' + err.message;
  }

  if (phone) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const nzPhone = phone.startsWith('+') ? phone : '+64' + phone.replace(/^0/, '');
      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   nzPhone,
        body: `Wonder World Westgate: Hi ${firstName}! Your booking ${bookingRef} has been updated ✏️. ${newGuestCount} kids on ${partyDate} @ ${partyTime}. New total: $${parseFloat(newTotalAmount).toFixed(2)} NZD.`,
      });
      results.sms = 'sent';
    } catch (err) {
      results.sms = 'failed: ' + err.message;
    }
  }

  res.json({ ok: true, results });
});

module.exports = router;
