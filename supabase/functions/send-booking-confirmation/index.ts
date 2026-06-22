// send-booking-confirmation — sends customer confirmation + admin notification via Resend
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const body = await req.json();
    const { bookingRef, email, firstName, lastName, phone, roomName, partyDate, partyTime, guestCount, foodChoice, totalAmount} = body;

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!
    );

    // ── 1. Customer confirmation email ──────────────────────────
    const customerHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:linear-gradient(135deg,#4F46E5,#0E9F6E);padding:30px;border-radius:16px;text-align:center;margin-bottom:24px">
          <h1 style="color:white;margin:0;font-size:28px">🎉 Booking Confirmed!</h1>
          <p style="color:rgba(255,255,255,0.9);margin:8px 0 0">Wonder World Westgate</p>
        </div>
        <p>Hi ${firstName}!</p>
        <p>Your party booking is confirmed. Here are your details:</p>
        <div style="background:#F9FAFB;border-radius:12px;padding:20px;margin:20px 0">
          <p><strong>Booking Ref:</strong> ${bookingRef}</p>
          <p><strong>Room:</strong> ${roomName}</p>
          <p><strong>Date & Time:</strong> ${partyDate} at ${partyTime}</p>
                    <p><strong>Guests:</strong> ${guestCount} children</p>
          <p><strong>Food:</strong> ${foodChoice}</p>
          <p><strong>Total Paid:</strong> $${parseFloat(totalAmount).toFixed(2)} NZD</p>
        </div>
        <div style="background:#FEF3C7;border-radius:12px;padding:16px;margin:20px 0">
          <p><strong>🧦 Remember:</strong> All guests must wear grip or non-slip socks. No shoes in the playground.</p>
          <p><strong>🎂 Outside birthday cake is welcome!</strong></p>
        </div>
        <p>Our team will contact you within 24 hours to finalise details.</p>
        <p>Questions? Email us at <a href="mailto:hello@wonderworldwestgate.co.nz">hello@wonderworldwestgate.co.nz</a></p>
        <p>See you soon! 🎠</p>
        <p><em>Wonder World Westgate Team</em></p>
      </div>`;

    const customerRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
        to: [email],
        subject: `🎉 Booking Confirmed — ${bookingRef} | Wonder World Westgate`,
        html: customerHtml,
      }),
    });

    const customerData = await customerRes.json();

    await supabase.from('email_logs').insert({
      to_email: email,
      subject: `Booking Confirmed — ${bookingRef}`,
      status: customerRes.ok ? 'sent' : 'failed',
      provider_response: JSON.stringify(customerData),
    });

    // ── 2. Notify all admin accounts ────────────────────────────
    const { data: admins } = await supabase
      .from('users')
      .select('email')
      .eq('is_admin', true);

    if (admins && admins.length > 0) {
      const adminEmails = admins.map((a: { email: string }) => a.email).filter(Boolean);

      const adminHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <div style="background:linear-gradient(135deg,#F59E0B,#EF4444);padding:24px;border-radius:16px;text-align:center;margin-bottom:24px">
            <h1 style="color:white;margin:0;font-size:24px">🔔 New Reservation</h1>
            <p style="color:rgba(255,255,255,0.9);margin:8px 0 0">Wonder World Westgate Admin Alert</p>
          </div>
          <p>A new party booking has just come in.</p>
          <div style="background:#F9FAFB;border-radius:12px;padding:20px;margin:20px 0">
            <p><strong>Booking Ref:</strong> ${bookingRef}</p>
            <p><strong>Customer:</strong> ${firstName} ${lastName || ''}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> +64 ${phone || '—'}</p>
            <p><strong>Room:</strong> ${roomName}</p>
            <p><strong>Date & Time:</strong> ${partyDate} at ${partyTime}</p>
                        <p><strong>Guests:</strong> ${guestCount} children</p>
            <p><strong>Food:</strong> ${foodChoice}</p>
            <p><strong>Total Paid:</strong> $${parseFloat(totalAmount).toFixed(2)} NZD</p>
          </div>
          <p><a href="https://wonderworldwestgate.co.nz/admin" style="background:#4F46E5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">View in Admin Dashboard →</a></p>
        </div>`;

      const adminRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Wonder World Westgate <bookings@wonderworldwestgate.co.nz>',
          to: adminEmails,
          subject: `🔔 New Reservation — ${bookingRef} (${guestCount} kids, ${roomName})`,
          html: adminHtml,
        }),
      });

      const adminData = await adminRes.json();

      await supabase.from('email_logs').insert({
        to_email: adminEmails.join(', '),
        subject: `New Reservation Alert — ${bookingRef}`,
        status: adminRes.ok ? 'sent' : 'failed',
        provider_response: JSON.stringify(adminData),
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('send-booking-confirmation error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});