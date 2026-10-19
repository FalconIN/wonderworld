const pool = require('../db');
const { escapeHtml } = require('../utils/escapeHtml');

const PAY_UPGRADE_URL = 'https://wonderworldwestgate.co.nz/pay-upgrade';

function fmtMoney(n) {
  return `$${parseFloat(n).toFixed(2)}`;
}

function fmtDeadline(deadlineAt) {
  return new Date(deadlineAt).toLocaleDateString('en-NZ', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Pacific/Auckland',
  });
}

// Sent when an upgrade requires an additional payment — price breakdown
// (per-child rate only, no flat fee shown, per spec) plus a payment link
// that charges just the delta, plus the 1-week-before-party deadline
// warning.
async function sendVenueUpgradePaymentLinkEmail({
  email, firstName, bookingRef, roomName, newGuestCount, overageRate,
  newTotalAmount, amountPaid, amountDue, deadlineAt, rawToken,
}) {
  const link = `${PAY_UPGRADE_URL}?token=${encodeURIComponent(rawToken)}`;
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
    to:      email,
    subject: `🏛️ Your party is upgrading to Whole Venue Hire — Ref: ${bookingRef}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
        <div style="background:linear-gradient(135deg,#334155,#0F172A);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
          <div style="font-size:40px;margin-bottom:8px">🏛️</div>
          <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Whole Venue Hire Upgrade</h1>
          <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
        </div>

        <p style="font-size:15px;margin-bottom:20px">Hi <strong>${escapeHtml(firstName || 'there')}</strong>! Your party (Ref: <strong>${bookingRef}</strong>) is being upgraded to <strong>${escapeHtml(roomName)}</strong> for <strong>${newGuestCount} kids</strong>.</p>

        <div style="background:#F9FAFB;border-radius:16px;padding:24px;margin-bottom:20px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:6px">Price Breakdown</div>
          <table style="width:100%;font-size:14px;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#6B7280;width:55%">Per-child rate</td><td style="font-weight:600">${fmtMoney(overageRate)} / child</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280">Guests</td><td style="font-weight:600">${newGuestCount} kids</td></tr>
            <tr><td style="padding:10px 0 6px;color:#6B7280;border-top:1px solid #E5E7EB">New Total</td><td style="padding-top:10px;font-weight:700;border-top:1px solid #E5E7EB">${fmtMoney(newTotalAmount)} NZD</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280">Already paid</td><td style="font-weight:600">${fmtMoney(amountPaid)}</td></tr>
            <tr><td style="padding:10px 0 6px;color:#6B7280;border-top:1px solid #E5E7EB">Amount Due</td><td style="padding-top:10px;font-weight:700;font-size:16px;color:#334155;border-top:1px solid #E5E7EB">${fmtMoney(amountDue)} NZD</td></tr>
          </table>
        </div>

        <div style="text-align:center;margin-bottom:24px">
          <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#F97316,#EA6000);color:white;font-weight:700;font-size:15px;text-decoration:none;border-radius:14px;padding:14px 32px">Pay the Difference →</a>
        </div>

        <div style="background:#FEE2E2;border:1px solid #FECACA;border-radius:12px;padding:16px;margin-bottom:20px;font-size:13px;color:#991B1B">
          <strong>⚠️ Please pay by ${fmtDeadline(deadlineAt)}</strong> (at least one week before your party). If payment isn't completed in full by then, this upgrade won't go ahead and your party will default back to your originally-paid headcount and room.
        </div>

        <p style="font-size:13px;color:#6B7280">Questions? Email us at <a href="mailto:bookings@wonderworldwestgate.co.nz" style="color:#334155">bookings@wonderworldwestgate.co.nz</a></p>
        <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
      </div>
    `,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Sent when the upgrade needed no additional payment (rare — only when
// whatever was already paid already covers the new per-child total).
async function sendVenueUpgradeNotice({ email, firstName, bookingRef, roomName, newGuestCount, overageRate, newTotalAmount }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
    to:      email,
    subject: `🏛️ Your party is now Whole Venue Hire — Ref: ${bookingRef}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
        <div style="background:linear-gradient(135deg,#334155,#0F172A);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
          <div style="font-size:40px;margin-bottom:8px">🏛️</div>
          <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Whole Venue Hire Upgrade</h1>
          <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
        </div>
        <p style="font-size:15px;margin-bottom:20px">Hi <strong>${escapeHtml(firstName || 'there')}</strong>! Your party (Ref: <strong>${bookingRef}</strong>) is now <strong>${escapeHtml(roomName)}</strong> for <strong>${newGuestCount} kids</strong>, at ${fmtMoney(overageRate)}/child (${fmtMoney(newTotalAmount)} total). No additional payment is required — you're all set.</p>
        <p style="font-size:13px;color:#6B7280">Questions? Email us at <a href="mailto:bookings@wonderworldwestgate.co.nz" style="color:#334155">bookings@wonderworldwestgate.co.nz</a></p>
        <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
      </div>
    `,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Sent by the auto-revert cron job when an upgrade's payment deadline lapses
// unpaid — see server/services/venueUpgradeExpiry.js.
async function sendVenueUpgradeRevertedNotice({ email, firstName, bookingRef, originalRoomName, originalGuestCount }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
    to:      email,
    subject: `Your party booking has reverted — Ref: ${bookingRef}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827">
        <div style="background:linear-gradient(135deg,#334155,#0F172A);border-radius:20px;padding:32px;text-align:center;margin-bottom:28px">
          <div style="font-size:40px;margin-bottom:8px">↩️</div>
          <h1 style="color:white;font-size:24px;font-weight:700;margin:0 0 4px">Booking Reverted</h1>
          <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px">Wonder World Westgate</p>
        </div>
        <p style="font-size:15px;margin-bottom:20px">Hi <strong>${escapeHtml(firstName || 'there')}</strong>! We didn't receive payment for the Whole Venue Hire upgrade on your party (Ref: <strong>${bookingRef}</strong>) before the deadline, so it's reverted back to your originally-paid booking: <strong>${escapeHtml(originalRoomName)}</strong> for <strong>${originalGuestCount} kids</strong>. No further action is needed — this is what you originally paid for.</p>
        <p style="font-size:13px;color:#6B7280">If you still want the whole-venue upgrade, contact us and we can send a new payment link if there's time before your party. Questions? Email us at <a href="mailto:bookings@wonderworldwestgate.co.nz" style="color:#334155">bookings@wonderworldwestgate.co.nz</a></p>
        <p style="font-size:13px;color:#9CA3AF;margin-top:24px">See you soon! 🎠<br><strong>Wonder World Westgate Team</strong></p>
      </div>
    `,
  });
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { sendVenueUpgradePaymentLinkEmail, sendVenueUpgradeNotice, sendVenueUpgradeRevertedNotice };
