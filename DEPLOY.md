# Wonder World Westgate — Deployment Guide

Complete setup from zero to live. Estimated time: ~2 hours.

---

## Prerequisites

Install these before starting:

```bash
npm install -g vercel
npm install -g supabase
```

You'll also need accounts at:
- [supabase.com](https://supabase.com) (free tier is fine)
- [stripe.com](https://stripe.com) (NZ business account)
- [resend.com](https://resend.com) (free tier: 3,000 emails/month)
- [twilio.com](https://twilio.com) (pay-as-you-go, ~$0.08/SMS)
- [vercel.com](https://vercel.com) (free tier is fine)

---

## Step 1 — Supabase Project Setup

### 1.1 Create project

1. Go to [app.supabase.com](https://app.supabase.com) → New project
2. Name: `wonderworld-westgate`
3. Region: **Southeast Asia (Singapore)** — closest to NZ
4. Generate a strong database password and save it somewhere safe
5. Wait ~2 minutes for provisioning

### 1.2 Run database schema

1. In Supabase Dashboard → **SQL Editor** → New query
2. Paste the contents of `supabase/schema.sql`
3. Click **Run** — you should see "Success. No rows returned"

### 1.3 Run RLS policies

1. New query in SQL Editor
2. Paste the contents of `supabase/policies.sql`
3. Click **Run**

### 1.4 Get your API keys

Go to **Settings → API** and copy:
- `Project URL` → this is your `SUPABASE_URL`
- `anon public` key → this is your `SUPABASE_ANON_KEY`
- `service_role` key → this is your `SUPABASE_SERVICE_ROLE_KEY` (keep secret)

---

## Step 2 — Google OAuth Setup

### 2.1 Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use existing): `Wonder World Westgate`
3. Navigate to **Branding** — fill in app name, support email, authorized domain
4. Navigate to **Audience** — set to External
5. Navigate to **Data Access** — add scopes: `email`, `profile`, `openid`
6. Navigate to **Clients → Create OAuth Client**
   - Application type: **Web application**
   - Name: `Wonder World Web`
   - Authorised redirect URIs — add both:
     ```
     https://your-project-ref.supabase.co/auth/v1/callback
     http://localhost:54321/auth/v1/callback
     ```
7. Copy the **Client ID** and **Client Secret**

### 2.2 Enable in Supabase

1. Supabase Dashboard → **Authentication → Providers → Google**
2. Toggle **Enable**
3. Paste your Client ID and Client Secret
4. Click **Save**

---

## Step 3 — Stripe Setup

### 3.1 Get API keys

1. [dashboard.stripe.com](https://dashboard.stripe.com) → Developers → API keys
2. Copy **Publishable key** (`pk_live_...`) → `STRIPE_PUBLIC_KEY`
3. Copy **Secret key** (`sk_live_...`) → `STRIPE_SECRET_KEY`

> Use `pk_test_` / `sk_test_` keys during testing. Switch to live keys for production.

### 3.2 Create webhook

1. Stripe Dashboard → Developers → **Webhooks → Add endpoint**
2. Endpoint URL: `https://your-project-ref.supabase.co/functions/v1/stripe-webhook`
3. Events to listen to:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `customer.created`
4. Click **Add endpoint**
5. Copy the **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`

---

## Step 4 — Resend (Email) Setup

1. Go to [resend.com](https://resend.com) → API Keys → Create API Key
2. Copy the key → `RESEND_API_KEY`
3. Go to **Domains → Add Domain** → enter `wonderworldwestgate.co.nz`
4. Add the DNS records shown to your domain registrar (usually takes <1 hour to verify)
5. Once verified, you can send from `bookings@wonderworldwestgate.co.nz`

---

## Step 5 — Twilio (SMS) Setup

1. Go to [console.twilio.com](https://console.twilio.com)
2. Copy **Account SID** and **Auth Token** from the dashboard
3. Go to **Phone Numbers → Buy a number**
   - Country: New Zealand
   - Capabilities: SMS ✅
   - Buy a number (~$3 NZD/month)
4. Copy the number in E.164 format (e.g. `+6498765432`) → `TWILIO_PHONE_NUMBER`

---

## Step 6 — Deploy Edge Functions

Make sure you're logged in to Supabase CLI:

```bash
supabase login
supabase link --project-ref your-project-ref
```

Set secrets (these go into the Edge Function environment, never into frontend):

```bash
supabase secrets set \
  SUPABASE_SERVICE_ROLE_KEY=your_service_role_key \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  RESEND_API_KEY=re_... \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_PHONE_NUMBER=+64...
```

Deploy all four functions:

```bash
supabase functions deploy create-payment-intent
supabase functions deploy send-booking-confirmation
supabase functions deploy stripe-webhook
supabase functions deploy refund-payment
```

Verify they're live:

```bash
supabase functions list
```

---

## Step 7 — Deploy Frontend to Vercel

### 7.1 Push to GitHub

```bash
cd wonderworld
git init
git add .
git commit -m "initial commit"
git push -u origin main
```

### 7.2 Import to Vercel

1. Go to [vercel.com](https://vercel.com) → Add New Project
2. Import your GitHub repo
3. Framework Preset: **Other**
4. Build Command: `node scripts/inject-env.js`
5. Output Directory: `.`

### 7.3 Add environment variables

In Vercel → Settings → **Environment Variables**, add:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://your-ref.supabase.co` |
| `SUPABASE_ANON_KEY` | your anon key |
| `STRIPE_PUBLIC_KEY` | `pk_live_...` |
| `ENVIRONMENT` | `production` |

> Do NOT add secret keys here — they go in Supabase secrets (Step 6).

### 7.4 Set custom domain

1. Vercel → Settings → Domains → Add `wonderworldwestgate.co.nz`
2. Add the CNAME record to your DNS registrar
3. Vercel handles SSL automatically

### 7.5 Add Vercel URL to Supabase redirect allowlist

1. Supabase → Authentication → **URL Configuration**
2. Site URL: `https://wonderworldwestgate.co.nz`
3. Redirect URLs — add:
   ```
   https://wonderworldwestgate.co.nz
   https://wonderworldwestgate.co.nz/**
   ```

---

## Step 8 — Create Admin User

1. Have your admin sign up normally through the site
2. In Supabase → **Table Editor → users**
3. Find the row for that email
4. Set `is_admin = true`
5. Save

The admin dashboard is now accessible at `/admin`

---

## Step 9 — Test the Full Flow

Use Stripe test cards (only works with `pk_test_` keys):

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 0002` | Payment declined |
| `4000 0025 0000 3155` | Requires 3D Secure |

Any future expiry date and any 3-digit CVV will work.

**Checklist:**
- [ ] Sign up via email
- [ ] Sign in via Google
- [ ] Select a room, date, and time slot
- [ ] Complete payment with test card
- [ ] Confirmation email received
- [ ] SMS confirmation received
- [ ] Booking appears in admin dashboard
- [ ] Admin can view and cancel a booking
- [ ] Admin can refund a payment

---

## Optional: SMS Reminders via pg_cron

To send 24-hour reminder SMS automatically:

1. Supabase Dashboard → **Database → Extensions** → enable `pg_cron`
2. Run in SQL Editor:

```sql
select cron.schedule(
  'send-sms-reminders',
  '0 * * * *',  -- every hour
  $$
  select net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/send-sms-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

---

## Troubleshooting

**"Invalid API key" on Stripe payment**
→ Check that `STRIPE_PUBLIC_KEY` in Vercel env matches the mode (test/live) of your `STRIPE_SECRET_KEY` in Supabase secrets.

**Google sign-in redirect error**
→ Double-check the redirect URI in Google Cloud Console exactly matches `https://your-ref.supabase.co/auth/v1/callback`.

**Emails not sending**
→ Verify your domain in Resend. Check `email_logs` table in Supabase for error details.

**Slot holds not releasing**
→ The `hold_expires_at` column handles expiry, but you can manually clean up with:
```sql
delete from public.booking_timeslots
where status = 'held' and hold_expires_at < now();
```
Consider scheduling this as a pg_cron job too.

**Edge Function errors**
→ View logs in Supabase Dashboard → Edge Functions → select function → Logs.
