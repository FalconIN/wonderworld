// supabase/functions/stripe-webhook/index.ts
// Stripe webhook handler — verifies signature, updates DB.
// This is the source of truth for payment status.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@13.10.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

serve(async (req: Request) => {
  const body      = await req.text();
  const signature = req.headers.get('stripe-signature');

  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return new Response(`Webhook error: ${err instanceof Error ? err.message : 'Unknown'}`, { status: 400 });
  }

  // Service role client — bypasses RLS for admin operations
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    switch (event.type) {

      // ── PaymentIntent Succeeded ────────────────────────
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        
        // Update payment record
        await supabase
          .from('payments')
          .update({
            status:      'succeeded',
            updated_at:  new Date().toISOString(),
          })
          .eq('stripe_payment_intent_id', pi.id);

        // Confirm booking if it exists
        await supabase
          .from('bookings')
          .update({ status: 'confirmed' })
          .eq('stripe_payment_intent_id', pi.id);

        console.log(`✅ Payment succeeded: ${pi.id} — $${(pi.amount / 100).toFixed(2)} ${pi.currency.toUpperCase()}`);
        break;
      }

      // ── PaymentIntent Failed ───────────────────────────
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const failReason = pi.last_payment_error?.message || 'Unknown failure';
        
        await supabase
          .from('payments')
          .update({
            status:        'failed',
            error_message: failReason,
            updated_at:    new Date().toISOString(),
          })
          .eq('stripe_payment_intent_id', pi.id);

        console.log(`❌ Payment failed: ${pi.id} — ${failReason}`);
        break;
      }

      // ── Refund Created ─────────────────────────────────
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        
        await supabase
          .from('payments')
          .update({
            status:      'refunded',
            refunded_at: new Date().toISOString(),
            updated_at:  new Date().toISOString(),
          })
          .eq('stripe_payment_intent_id', charge.payment_intent as string);

        // Also mark booking as refunded
        const { data: payment } = await supabase
          .from('payments')
          .select('booking_id')
          .eq('stripe_payment_intent_id', charge.payment_intent as string)
          .single();

        if (payment?.booking_id) {
          await supabase
            .from('bookings')
            .update({ status: 'refunded' })
            .eq('id', payment.booking_id);
        }

        console.log(`💸 Refund processed: ${charge.id}`);
        break;
      }

      // ── Customer Created ───────────────────────────────
      case 'customer.created': {
        const customer = event.data.object as Stripe.Customer;
        // Optionally store Stripe customer ID in users table
        if (customer.metadata?.supabase_user_id) {
          await supabase
            .from('users')
            .update({ stripe_customer_id: customer.id })
            .eq('id', customer.metadata.supabase_user_id);
        }
        break;
      }

      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Return 200 so Stripe doesn't retry — log the error
    return new Response('Webhook processing error (logged)', { status: 200 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
