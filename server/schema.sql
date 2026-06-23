-- ============================================================
-- Wonder World Westgate — PostgreSQL Schema (self-hosted)
-- Run as the wonderworld DB user:
--   psql -U wonderworld -d wonderworld -f schema.sql
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 1. USERS ────────────────────────────────────────────────
-- id is the Firebase UID (text), not a UUID
CREATE TABLE IF NOT EXISTS public.users (
  id                text        PRIMARY KEY,
  first_name        text        NOT NULL DEFAULT '',
  last_name         text        NOT NULL DEFAULT '',
  email             text        NOT NULL UNIQUE,
  phone             text,
  stripe_customer_id text,
  is_admin          boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── 2. PARTY_ROOMS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.party_rooms (
  id                    uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug                  text        NOT NULL UNIQUE,
  name                  text        NOT NULL,
  emoji                 text        NOT NULL DEFAULT '🎉',
  tag_line              text,
  color                 text,
  min_guests            integer     NOT NULL DEFAULT 8,
  max_guests            integer     NOT NULL DEFAULT 15,
  base_price_per_child  numeric(10,2) NOT NULL DEFAULT 39.00,
  weekday_total         numeric(10,2),
  weekend_total         numeric(10,2),
  description           text,
  is_active             boolean     NOT NULL DEFAULT true,
  sort_order            integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.party_rooms (slug, name, emoji, tag_line, color, min_guests, max_guests, base_price_per_child, weekday_total, weekend_total, description, sort_order)
VALUES
  ('big',      'The Big Room',         '🌟', 'Exclusive Extra Large Zone', 'indigo', 16, 24, 39.00, 49.00, 59.00, 'Our flagship space — private stage, expanded play zone.',         1),
  ('sunshine', 'Sunshine Room',        '☀️', 'Yellow · Warm & Cheerful',  'yellow',  8, 15, 39.00, null,  null,  'Bright, sunny, and full of energy.',                              2),
  ('dream',    'Dream Room',           '🌙', 'Purple · Magical & Dreamy', 'purple',  8, 15, 39.00, null,  null,  'Soft lighting, dreamy decor.',                                    3),
  ('forest',   'Wonder Forest Room',   '🌿', 'Green · Nature Adventure',  'green',   8, 15, 39.00, null,  null,  'An immersive forest theme.',                                      4)
ON CONFLICT (slug) DO NOTHING;

-- ── 3. BOOKING_TIMESLOTS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_timeslots (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  party_room_id   uuid        NOT NULL REFERENCES public.party_rooms(id) ON DELETE CASCADE,
  slot_date       date        NOT NULL,
  slot_time       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'held'
                              CHECK (status IN ('held', 'confirmed', 'released')),
  held_by_user_id text        REFERENCES public.users(id) ON DELETE SET NULL,
  booking_id      uuid,
  hold_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_room_id, slot_date, slot_time)
);

CREATE INDEX IF NOT EXISTS idx_timeslots_room_date ON public.booking_timeslots (party_room_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_timeslots_status    ON public.booking_timeslots (status);
CREATE INDEX IF NOT EXISTS idx_timeslots_expires   ON public.booking_timeslots (hold_expires_at) WHERE status = 'held';

-- ── 4. BOOKINGS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookings (
  id                       uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_ref              text        NOT NULL UNIQUE,
  user_id                  text        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  party_room_id            uuid        NOT NULL REFERENCES public.party_rooms(id) ON DELETE RESTRICT,
  party_date               date        NOT NULL,
  party_time               text        NOT NULL,
  guest_count              integer     NOT NULL CHECK (guest_count >= 1),
  food_choice              text,
  allergy_notes            text,
  addons_summary           text,
  base_amount              numeric(10,2),
  addons_amount            numeric(10,2) DEFAULT 0,
  total_amount             numeric(10,2) NOT NULL,
  is_weekend               boolean     NOT NULL DEFAULT false,
  status                   text        NOT NULL DEFAULT 'confirmed'
                           CHECK (status IN ('pending', 'confirmed', 'cancelled', 'refunded')),
  contact_email            text        NOT NULL,
  contact_phone            text,
  stripe_payment_intent_id text,
  cancelled_at             timestamptz,
  refunded_at              timestamptz,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_user_id    ON public.bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_party_date ON public.bookings (party_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status     ON public.bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_booking_ref ON public.bookings (booking_ref);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_bookings_updated_at ON public.bookings;
CREATE TRIGGER set_bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS set_users_updated_at ON public.users;
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 5. PAYMENTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id                       uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id               uuid        REFERENCES public.bookings(id) ON DELETE SET NULL,
  user_id                  text        REFERENCES public.users(id) ON DELETE SET NULL,
  stripe_payment_intent_id text        UNIQUE,
  amount                   numeric(10,2) NOT NULL,
  currency                 text        NOT NULL DEFAULT 'nzd',
  status                   text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'cancelled')),
  card_brand               text,
  card_last4               text,
  cardholder_name          text,
  payment_method           text,
  error_message            text,
  metadata                 jsonb       DEFAULT '{}',
  refunded_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON public.payments (booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id    ON public.payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_pi  ON public.payments (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON public.payments (status);

DROP TRIGGER IF EXISTS set_payments_updated_at ON public.payments;
CREATE TRIGGER set_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 6. EMAIL_LOGS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_logs (
  id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id uuid        REFERENCES public.bookings(id) ON DELETE SET NULL,
  email_type text        NOT NULL,
  recipient  text        NOT NULL,
  resend_id  text,
  status     text        NOT NULL DEFAULT 'sent',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 7. SMS_LOGS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_logs (
  id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id uuid        REFERENCES public.bookings(id) ON DELETE SET NULL,
  sms_type   text        NOT NULL,
  recipient  text        NOT NULL,
  twilio_sid text,
  status     text        NOT NULL DEFAULT 'sent',
  created_at timestamptz NOT NULL DEFAULT now()
);
