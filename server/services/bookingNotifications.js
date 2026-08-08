const pool = require('../db');

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

// Used by both the client-triggered /api/notifications/booking-confirmation
// route (Stripe/Afterpay path, called after the browser returns) and the
// POLi return handler (server/routes/poli.js — the browser may never come
// back to run JS, so this must be callable directly, server-side).
async function sendBookingConfirmation({
  bookingRef, bookingId, email, phone,
  firstName, lastName, roomName,
  partyDate, partyTime, guestCount, foodChoice, addonsSummary, totalAmount,
  cateringChoice, noAlcoholAck,
}) {
  const results = { email: null, sms: null };

  // Only whole-venue hire bookings carry a catering choice — every ordinary
  // per-child room booking leaves this null, so the block below is skipped.
  const cateringLabel = cateringChoice === 'venue_menu' ? 'Venue menu'
    : cateringChoice === 'self_catering' ? 'Self-catering (you bring your own food/drink)'
    : null;
  const cateringBlock = cateringLabel ? `
          <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:16px;margin-bottom:20px;font-size:14px;color:#1E3A8A">
            <strong>🍽️ Catering:</strong> ${cateringLabel}<br>
            ${cateringChoice === 'venue_menu'
              ? 'No outside food or drink is permitted with the venue menu — birthday cake is always the exception. 🎂'
              : 'You&rsquo;re organising your own food/drink for this event. Birthday cake is welcome either way! 🎂'}
          </div>
          <div style="background:#FEE2E2;border:1px solid #FECACA;border-radius:12px;padding:16px;margin-bottom:20px;font-size:14px;color:#991B1B">
            <strong>🚫 No alcohol:</strong> Alcohol is not permitted on the premises under any circumstances, for either catering option.
          </div>` : '';

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
              <tr><td style="padding:6px 0;color:#6B7280">Date &amp; Time</td><td style="font-weight:600">${fmtDate(partyDate)} at ${partyTime}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Guests</td><td style="font-weight:600">${guestCount} kids</td></tr>
              ${cateringLabel ? '' : `<tr><td style="padding:6px 0;color:#6B7280">Food</td><td style="font-weight:600">${foodChoice || '—'}</td></tr>`}
              ${addonsSummary ? `<tr><td style="padding:6px 0;color:#6B7280">Add-ons</td><td style="font-weight:600">${addonsSummary}</td></tr>` : ''}
              <tr><td style="padding:10px 0 6px;color:#6B7280;border-top:1px solid #E5E7EB">Total Paid</td><td style="padding-top:10px;font-weight:700;font-size:16px;color:#4F46E5;border-top:1px solid #E5E7EB">$${parseFloat(totalAmount).toFixed(2)} NZD</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280">Receipt to</td><td style="font-weight:600">${email}</td></tr>
            </table>
          </div>

          ${cateringBlock}

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

  // ── SMS via Twilio (not yet configured — phone number is contact-only for now) ──
  if (!TWILIO_CONFIGURED) {
    results.sms = 'skipped: Twilio not configured';
  } else {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

      const nzPhone = phone.startsWith('+') ? phone : '+64' + phone.replace(/^0/, '');
      const msg = await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   nzPhone,
        body: `Wonder World Westgate: Hi ${firstName}! Your party is confirmed 🎉 Ref: ${bookingRef}. ${roomName} on ${fmtDate(partyDate)} @ ${partyTime}. Total: $${parseFloat(totalAmount).toFixed(2)}.${cateringLabel ? ` Catering: ${cateringLabel}. No alcohol permitted on-site.` : ''} See you soon!`,
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
  }

  return results;
}

module.exports = { sendBookingConfirmation };
