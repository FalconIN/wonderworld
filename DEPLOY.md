# Wonder World Westgate — Deployment Guide

Self-hosted setup: Node/Express + local PostgreSQL, run via PM2 behind nginx.
(This replaces an earlier Supabase + Vercel + Edge Functions design — that
architecture is no longer used.)

---

## Prerequisites

On the server:

```bash
sudo apt install -y postgresql nginx nodejs npm
sudo npm install -g pm2
```

Accounts you'll need:
- A Firebase project (Authentication enabled) — [console.firebase.google.com](https://console.firebase.google.com)
- [stripe.com](https://stripe.com) (NZ business account)
- [resend.com](https://resend.com) (free tier: 3,000 emails/month)
- [twilio.com](https://twilio.com) (pay-as-you-go, ~$0.08/SMS)
- A domain with DNS pointed at this server

---

## Step 1 — Database Setup

### 1.1 Create the database and user

```bash
sudo -u postgres psql -c "CREATE USER wonderworld WITH PASSWORD 'your_strong_password_here';"
sudo -u postgres psql -c "CREATE DATABASE wonderworld OWNER wonderworld;"
```

### 1.2 Run the schema

```bash
psql -U wonderworld -d wonderworld -f server/schema.sql
```

`server/schema.sql` is the canonical schema — `schema.sql` and
`schema-postgres.sql` at the repo root are kept as exact mirrors of it for
convenience. Always edit `server/schema.sql` first, then copy any change into
the other two so all three stay in sync (there's no migration tool).

---

## Step 2 — Firebase Auth Setup

1. [console.firebase.google.com](https://console.firebase.google.com) → Create project
2. **Authentication → Sign-in method** → enable Email/Password and Google
3. **Project Settings → General → Your apps** → add a Web app, copy the client config (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`) — these go in `.env` as `FIREBASE_*`
4. **Project Settings → Service Accounts → Generate new private key** — this JSON gives you `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` for the server-side Admin SDK

Admin accounts and customer accounts share the same `users` table — an admin
is just a row with `is_admin = true` (see Step 7).

---

## Step 3 — Stripe Setup

### 3.1 Get API keys

1. [dashboard.stripe.com](https://dashboard.stripe.com) → Developers → API keys
2. Copy **Publishable key** → `STRIPE_PUBLIC_KEY`
3. Copy **Secret key** → `STRIPE_SECRET_KEY`

> Use `pk_test_...` / `sk_test_...` while testing. Switch to `pk_live_...` /
> `sk_live_...` only when you're ready to accept real payments.

### 3.2 Create webhook

1. Stripe Dashboard → Developers → **Webhooks → Add endpoint**
2. Endpoint URL: `https://yourdomain.co.nz/api/stripe/webhook`
3. Events to listen to:
   - `payment_intent.succeeded`
   - `charge.refunded`
4. Copy the **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`

The webhook is handled directly in `server/routes/payments.js` (no separate
Edge Function) — it verifies the Stripe signature and updates the `payments`
table.

---

## Step 4 — Resend (Email) Setup

1. Go to [resend.com](https://resend.com) → API Keys → Create API Key
2. Copy the key → `RESEND_API_KEY`
3. **Domains → Add Domain** → enter your domain, add the DNS records shown (usually verifies within an hour)
4. Once verified, you can send from `bookings@yourdomain.co.nz`

---

## Step 5 — Twilio (SMS) Setup

1. Go to [console.twilio.com](https://console.twilio.com)
2. Copy **Account SID** and **Auth Token** from the dashboard
3. **Phone Numbers → Buy a number** — Country: New Zealand, Capabilities: SMS
4. Copy the number in E.164 format (e.g. `+6498765432`) → `TWILIO_PHONE_NUMBER`

---

## Step 6 — Configure and Start the App

### 6.1 Environment variables

```bash
cp .env.example .env
```

Fill in every value in `.env` — see `.env.example` for the full list
(Postgres creds, Firebase, Stripe, Resend, Twilio, and optionally
`GOOGLE_PLACES_API_KEY` / `GOOGLE_PLACE_ID` for the live Google reviews sync,
which degrades gracefully if left unset).

### 6.2 Install dependencies and start with PM2

```bash
cd server && npm install
cd .. && pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` runs the app as a single fork-mode process named
`wonderworld` on port 3000, with `autorestart: true`. Any change to files
under `server/` requires `pm2 restart wonderworld` to take effect — there's
no watch/reload in production.

### 6.3 nginx + SSL

The live nginx config lives at `/etc/nginx/sites-available/wonderworld`
(symlinked from `sites-enabled/`) — it is **not** deployed automatically from
the `nginx.conf` copy in this repo. After editing the repo copy:

```bash
sudo cp nginx.conf /etc/nginx/sites-available/wonderworld
sudo nginx -t && sudo systemctl reload nginx
```

Get an SSL cert with certbot (`sudo certbot --nginx -d yourdomain.co.nz -d www.yourdomain.co.nz`)
if one isn't already provisioned.

---

## Step 7 — Create Admin User

1. Have your admin sign up normally through the site
2. Find their row in the `users` table and set `is_admin = true`:
   ```sql
   UPDATE users SET is_admin = true WHERE email = 'admin@yourdomain.co.nz';
   ```

The admin dashboard is now accessible at `/admin`.

---

## Step 8 — Test the Full Flow

Use Stripe test cards (only works with `pk_test_...` keys):

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

## Troubleshooting

**"Invalid API key" on Stripe payment**
→ Check that `STRIPE_PUBLIC_KEY` and `STRIPE_SECRET_KEY` in `.env` are from the same mode (both `test` or both `live`).

**Emails not sending**
→ Verify your domain in Resend. Check the `email_logs` table for error details.

**Slot holds not releasing**
→ The `hold_expires_at` column on `booking_timeslots` handles expiry logic in the app, but you can manually clean up stale holds with:
```sql
delete from public.booking_timeslots
where status = 'held' and hold_expires_at < now();
```

**Server not picking up code changes**
→ Run `pm2 restart wonderworld`. There is no auto-reload in production.

**Reviews not syncing**
→ Confirm `GOOGLE_PLACES_API_KEY` and `GOOGLE_PLACE_ID` are set in `.env`, then `pm2 restart wonderworld`.
