const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const pool    = require('../db');
const { sendBookingConfirmation } = require('../services/bookingNotifications');

// Referenced below but was never defined in this file — every SMS branch
// (booking-modified, booking-rescheduled) threw an unhandled ReferenceError
// for any customer with a phone number on file, before ever reaching the
// Twilio call. Mirrors the same derivation already used in
// services/bookingNotifications.js.
const TWILIO_CONFIGURED = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

// Converts whatever partyDate arrives as (JS Date object serialised to ISO string,
// or a plain "YYYY-MM-DD" string) into a clean "3 July 2026" display string.
// We build the Date from year/month/day parts to avoid any UTC-offset shifts.
function fmtDate(raw) {
  const ymd = String(raw).slice(0, 10); // "2026-07-03" from either format
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-NZ', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// POST /api/notifications/booking-confirmation
// Sends confirmation email via Resend and SMS via Twilio
router.post('/booking-confirmation', requireAuth, async (req, res) => {
  const results = await sendBookingConfirmation(req.body);
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
              <tr><td style="padding:6px 0;color:#6B7280">Date &amp; Time</td><td style="font-weight:600">${fmtDate(partyDate)} at ${partyTime}</td></tr>
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

  if (phone && !TWILIO_CONFIGURED) {
    results.sms = 'skipped: Twilio not configured';
  } else if (phone) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const nzPhone = phone.startsWith('+') ? phone : '+64' + phone.replace(/^0/, '');
      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   nzPhone,
        body: `Wonder World Westgate: Hi ${firstName}! Your booking ${bookingRef} has been updated ✏️. ${newGuestCount} kids on ${fmtDate(partyDate)} @ ${partyTime}. New total: $${parseFloat(newTotalAmount).toFixed(2)} NZD.`,
      });
      results.sms = 'sent';
    } catch (err) {
      results.sms = 'failed: ' + err.message;
    }
  }

  res.json({ ok: true, results });
});

// POST /api/notifications/booking-rescheduled
router.post('/booking-rescheduled', requireAuth, async (req, res) => {
  const {
    bookingId, bookingRef, email, phone,
    firstName, roomName, partyDate, oldDate, oldTime, newTime,
  } = req.body;

  // partyDate is the new date (kept under its original name for backward
  // compatibility with the time-only reschedule path); oldDate is optional —
  // omitted when only the time changed on the same date.
  const dateChanged = !!oldDate && String(oldDate).slice(0, 10) !== String(partyDate).slice(0, 10);
  const heading = dateChanged ? 'Party Date & Time Updated!' : 'Party Time Updated!';

  const results = { email: null, sms: null };

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { data, error } = await resend.emails.send({
      from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
      to:      email,
      subject: `🕐 ${heading} — Ref: ${bookingRef}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
          <div style="background:linear-gradient(135deg,#1E3A8A,#2563EB);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
            <div style="font-size:40px;margin-bottom:8px">🕐</div>
            <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">${heading}</h1>
            <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
          </div>

          <p style="font-size:15px;margin-bottom:20px">Hi <strong>${firstName}</strong>! We've rescheduled your party. Everything else stays the same — here's what changed:</p>

          <div style="background:#F9FAFB;border-radius:16px;padding:24px;margin-bottom:20px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:6px">Booking Reference</div>
            <div style="font-size:22px;font-weight:700;color:#1E3A8A;margin-bottom:20px">${bookingRef}</div>
            <table style="width:100%;font-size:14px;border-collapse:collapse">
              <tr><td style="padding:6px 0;color:#6B7280;width:40%">Room</td><td style="font-weight:600">${roomName}</td></tr>
              ${dateChanged ? `
              <tr><td style="padding:6px 0;color:#6B7280">Previous date</td><td style="font-weight:600;text-decoration:line-through;color:#9CA3AF">${fmtDate(oldDate)}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">New date</td><td style="font-weight:700;color:#1E3A8A;font-size:16px">${fmtDate(partyDate)}</td></tr>
              ` : `
              <tr><td style="padding:6px 0;color:#6B7280">Date</td><td style="font-weight:600">${fmtDate(partyDate)}</td></tr>
              `}
              <tr><td style="padding:6px 0;color:#6B7280">Previous time</td><td style="font-weight:600;text-decoration:line-through;color:#9CA3AF">${oldTime}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">New time</td><td style="font-weight:700;color:#1E3A8A;font-size:16px">${newTime}</td></tr>
            </table>
          </div>

          <p style="font-size:13px;color:#6B7280">Questions? Email us at <a href="mailto:hello@wonderworldwestgate.co.nz" style="color:#1E3A8A">hello@wonderworldwestgate.co.nz</a></p>
          <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
        </div>
      `,
    });

    if (error) throw new Error(error.message);
    results.email = 'sent';

    if (bookingId) {
      await pool.query(
        'INSERT INTO email_logs (booking_id, email_type, recipient, resend_id, status) VALUES ($1, $2, $3, $4, $5)',
        [bookingId, 'booking_rescheduled', email, data?.id || null, 'sent']
      );
    }
  } catch (err) {
    console.error('Reschedule email failed:', err.message);
    results.email = 'failed: ' + err.message;
  }

  if (phone && !TWILIO_CONFIGURED) {
    results.sms = 'skipped: Twilio not configured';
  } else if (phone) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const nzPhone = phone.startsWith('+') ? phone : '+64' + phone.replace(/^0/, '');
      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   nzPhone,
        body: `Wonder World Westgate: Hi ${firstName}! Your party has been rescheduled. Ref: ${bookingRef} — ${roomName} is now on ${fmtDate(partyDate)} at ${newTime}. See you soon!`,
      });
      results.sms = 'sent';
    } catch (err) {
      results.sms = 'failed: ' + err.message;
    }
  }

  res.json({ ok: true, results });
});

module.exports = router;
