// supabase/functions/send-booking-confirmation/index.ts
// Sends:
//   1. Booking confirmation email (via Resend)
//   2. Booking confirmation SMS (via Twilio)
//   3. Payment receipt email (via Resend)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const body = await req.json();
    const {
      bookingRef,
      bookingId,
      email,
      phone,
      firstName,
      roomName,
      partyDate,
      partyTime,
      guestCount,
      foodChoice,
      totalAmount,
    } = body;

    const foodLabels: Record<string, string> = {
      nuggets: 'Chicken Nuggets',
      burgers: 'Kid-Sized Burgers',
      pizza:   'Mini Pizzas',
    };

    const results: string[] = [];

    // ── 1. Booking confirmation email (Resend) ─────────────
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (RESEND_API_KEY) {
      const emailHtml = buildBookingEmailHtml({
        firstName, bookingRef, roomName, partyDate, partyTime,
        guestCount, foodChoice: foodLabels[foodChoice] || foodChoice,
        totalAmount,
      });

      const emailRes = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
          to:      [email],
          subject: `🎉 Booking Confirmed! ${bookingRef} — ${roomName}`,
          html:    emailHtml,
        }),
      });

      const emailData = await emailRes.json();
      if (emailData.id) {
        results.push('email_sent');
        // Log email record
        await supabase.from('email_logs').insert({
          booking_id: bookingId,
          email_type: 'booking_confirmation',
          recipient:  email,
          resend_id:  emailData.id,
          status:     'sent',
        });
      } else {
        console.error('Resend email failed:', emailData);
        results.push('email_failed');
      }
    }

    // ── 2. SMS confirmation (Twilio) ───────────────────────
    const TWILIO_SID   = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
    const TWILIO_FROM  = Deno.env.get('TWILIO_PHONE_NUMBER');

    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && phone) {
      const smsBody = `🎉 Wonder World Booking Confirmed!\n\nRef: ${bookingRef}\nRoom: ${roomName}\nDate: ${partyDate} @ ${partyTime}\nGuests: ${guestCount} kids\n\nSee you there! Questions? Call (09) 555 0123`;

      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method:  'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
            'Content-Type':  'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            From: TWILIO_FROM,
            To:   phone,
            Body: smsBody,
          }),
        }
      );

      const smsData = await twilioRes.json();
      if (smsData.sid) {
        results.push('sms_sent');
        await supabase.from('sms_logs').insert({
          booking_id: bookingId,
          sms_type:   'booking_confirmation',
          recipient:  phone,
          twilio_sid: smsData.sid,
          status:     'sent',
        });
      } else {
        console.error('Twilio SMS failed:', smsData);
        results.push('sms_failed');
      }
    }

    // ── 3. Schedule reminder SMS (24 hrs before) ──────────
    // In production, use a pg_cron job or Supabase scheduled function.
    // Here we insert a scheduled_sms row for a separate cron to process.
    const partyDateTime = new Date(`${partyDate}T${convertTimeTo24(partyTime)}:00`);
    const reminderAt    = new Date(partyDateTime.getTime() - 24 * 60 * 60 * 1000);

    await supabase.from('scheduled_sms').insert({
      booking_id:   bookingId,
      phone,
      message:      `⏰ Reminder: Your Wonder World party is TOMORROW!\n\nRef: ${bookingRef}\nRoom: ${roomName}\n${partyDate} @ ${partyTime}\n\nSee you then! 🎉`,
      scheduled_at: reminderAt.toISOString(),
      status:       'pending',
    });

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('send-booking-confirmation error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// ---------------------------------------------------------------------------
// Email HTML template
// ---------------------------------------------------------------------------
function buildBookingEmailHtml(data: {
  firstName: string;
  bookingRef: string;
  roomName: string;
  partyDate: string;
  partyTime: string;
  guestCount: number;
  foodChoice: string;
  totalAmount: number;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booking Confirmed</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:'Inter',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">
    
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e1b4b,#0E9F6E);padding:40px 32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="color:white;font-size:28px;font-weight:700;margin:0 0 8px;font-family:'Fredoka',Arial,sans-serif;">Booking Confirmed!</h1>
      <p style="color:rgba(255,255,255,0.85);font-size:16px;margin:0;">Get ready for an incredible party, ${data.firstName}!</p>
    </div>

    <!-- Body -->
    <div style="padding:32px;">
      <div style="background:#EEF2FF;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6B7280;font-weight:600;margin-bottom:4px;">Booking Reference</div>
        <div style="font-size:24px;font-weight:700;color:#4F46E5;letter-spacing:.04em;">${data.bookingRef}</div>
      </div>

      <h2 style="font-size:18px;font-weight:600;color:#374151;margin:0 0 16px;">Your Party Details</h2>
      
      <table style="width:100%;border-collapse:collapse;">
        ${[
          ['🏰 Room', data.roomName],
          ['📅 Date', data.partyDate],
          ['⏰ Time', data.partyTime],
          ['👦 Guests', `${data.guestCount} children`],
          ['🍕 Food', data.foodChoice],
          ['💰 Total Paid', `$${parseFloat(String(data.totalAmount)).toFixed(2)} NZD`],
        ].map(([label, value]) => `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;color:#6B7280;font-size:14px;width:40%">${label}</td>
            <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;color:#111827;font-size:14px;font-weight:600;">${value}</td>
          </tr>`).join('')}
      </table>

      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:16px;margin:24px 0;">
        <div style="font-weight:700;color:#92400E;margin-bottom:6px;">📅 What happens next?</div>
        <div style="color:#B45309;font-size:14px;">Our events team will call you within 24 hours to finalise room decorations, confirm food quantities, and answer any questions.</div>
      </div>

      <p style="color:#6B7280;font-size:14px;margin:0;">Questions? Contact us at <a href="tel:+6495550123" style="color:#4F46E5;">(09) 555 0123</a> or <a href="mailto:hello@wonderworldwestgate.co.nz" style="color:#4F46E5;">hello@wonderworldwestgate.co.nz</a>.</p>
    </div>

    <!-- Footer -->
    <div style="background:#F9FAFB;padding:24px 32px;text-align:center;border-top:1px solid #F3F4F6;">
      <div style="font-weight:700;color:#374151;margin-bottom:4px;">Wonder World Westgate</div>
      <div style="color:#9CA3AF;font-size:13px;">Westgate Shopping Centre, 1 Fernhill Drive, Auckland 0814</div>
      <div style="color:#9CA3AF;font-size:12px;margin-top:12px;">© 2025 Wonder World Westgate. All rights reserved.</div>
    </div>
  </div>
</body>
</html>`;
}

// Convert "2:30 PM" → "14:30"
function convertTimeTo24(timeStr: string): string {
  const [time, period] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2,'0')}:${String(minutes || 0).padStart(2,'0')}`;
}
