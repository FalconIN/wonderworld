// stripe-webhook — handles Stripe webhook events
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@13.10.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!
  );

  try {
    const signature = req.headers.get('stripe-signature')!;
    const body = await req.text();
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    } catch (err) {
      return new Response(`Webhook signature error: ${err}`, { status: 400 });
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;

      // Pull card details from the latest charge
      let cardBrand: string | null = null;
      let cardLast4: string | null = null;
      const latestChargeId = (pi as any).latest_charge;
      if (latestChargeId) {
        try {
          const charge = await stripe.charges.retrieve(latestChargeId as string);
          cardBrand = charge.payment_method_details?.card?.brand ?? null;
          cardLast4 = charge.payment_method_details?.card?.last4 ?? null;
        } catch (e) {
          console.error('Failed to retrieve charge for card details:', e);
        }
      }

      await supabase.from('payments').update({
        status: 'succeeded',
        card_brand: cardBrand,
        card_last4: cardLast4,
      }).eq('stripe_payment_intent_id', pi.id);

      await supabase.from('bookings').update({ status: 'confirmed' })
        .eq('stripe_payment_intent_id', pi.id);
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      await supabase.from('payments').update({ status: 'failed' })
        .eq('stripe_payment_intent_id', pi.id);
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      await supabase.from('payments').update({ status: 'refunded' })
        .eq('stripe_payment_intent_id', charge.payment_intent);
      await supabase.from('bookings').update({ status: 'refunded' })
        .eq('stripe_payment_intent_id', charge.payment_intent);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('stripe-webhook error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
