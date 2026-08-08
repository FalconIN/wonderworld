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
  -- 'flat' rooms (currently just whole-venue hire) charge flat_price
  -- regardless of guest_count instead of base_price_per_child * guests.
  pricing_model         text        NOT NULL DEFAULT 'per_child'
                                     CHECK (pricing_model IN ('per_child', 'flat')),
  flat_price            numeric(10,2),
  -- NULL = bookable any day. Otherwise an array of Postgres/JS-style
  -- day-of-week ints (0=Sun .. 6=Sat) this room can be booked on at all —
  -- e.g. whole-venue hire is Sun/Mon/Tue only. Server-side enforcement
  -- lives in server/services/bookingRules.js.
  allowed_days_of_week  integer[],
  created_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.party_rooms (slug, name, emoji, tag_line, color, min_guests, max_guests, base_price_per_child, weekday_total, weekend_total, description, sort_order, pricing_model, flat_price, allowed_days_of_week)
VALUES
  ('big',      'The Big Room',         '🌟', 'Exclusive Extra Large Zone', 'indigo', 16, 24, 39.00, 49.00, 59.00, 'Our flagship space — private stage, expanded play zone.',         1, 'per_child', null,    null),
  ('sunshine', 'Sunshine Room',        '☀️', 'Yellow · Warm & Cheerful',  'yellow',  8, 15, 39.00, null,  null,  'Bright, sunny, and full of energy.',                              2, 'per_child', null,    null),
  ('dream',    'Dream Room',           '🌙', 'Purple · Magical & Dreamy', 'purple',  8, 15, 39.00, null,  null,  'Soft lighting, dreamy decor.',                                    3, 'per_child', null,    null),
  ('forest',   'Wonder Forest Room',   '🌿', 'Green · Nature Adventure',  'green',   8, 15, 39.00, null,  null,  'An immersive forest theme.',                                      4, 'per_child', null,    null),
  -- Whole-venue exclusive hire — Sun/Mon/Tue only, flat $2,899 rental
  -- (excludes food/drink; see bookings.catering_choice). min/max guests
  -- are a placeholder pending the real venue capacity — see
  -- migration-whole-venue-and-evening-slot.sql for how to adjust it.
  ('whole-venue', 'Whole Venue Hire',  '🏛️', 'Exclusive Full-Venue Buyout', 'slate', 1, 300, 0.00, null, null, 'The entire venue, exclusively yours — Sunday, Monday or Tuesday evenings only.', 5, 'flat', 2899.00, '{0,1,2}')
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
  status                   text        NOT NULL DEFAULT 'confirmed'
                           CHECK (status IN ('pending', 'confirmed', 'cancelled', 'refunded')),
  contact_email            text        NOT NULL,
  contact_phone            text,
  stripe_payment_intent_id text,
  cancelled_at             timestamptz,
  notes                    text,
  admin_notes              text,                    -- internal only, never shown to the customer
  -- Only set for 'flat'-priced rooms (whole-venue hire). NULL/false for
  -- every ordinary per-child room booking.
  catering_choice          text        CHECK (catering_choice IN ('self_catering', 'venue_menu')),
  no_alcohol_ack           boolean     NOT NULL DEFAULT false,
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
  refunded_at              timestamptz,
  payment_provider         text        NOT NULL DEFAULT 'stripe',
  poli_transaction_token   text        UNIQUE,
  poli_transaction_ref     text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON public.payments (booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id    ON public.payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_pi  ON public.payments (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON public.payments (status);

-- ── 5b. POLI PENDING BOOKINGS ────────────────────────────────
-- Temporary staging for a booking's full payload while the customer is away
-- at their bank during a POLi redirect flow — Stripe doesn't need this since
-- Stripe Elements confirms in-page. Row is deleted once the booking is
-- confirmed (or the slot hold it references expires).
CREATE TABLE IF NOT EXISTS public.poli_pending_bookings (
  slot_hold_id  uuid        PRIMARY KEY REFERENCES public.booking_timeslots(id) ON DELETE CASCADE,
  payload       jsonb       NOT NULL,
  poli_token    text        UNIQUE,
  poli_ref      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poli_pending_token ON public.poli_pending_bookings (poli_token);

DROP TRIGGER IF EXISTS set_payments_updated_at ON public.payments;
CREATE TRIGGER set_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 5c. BOOKING_SESSIONS ─────────────────────────────────────
-- In-progress wizard drafts, keyed by the (Firebase-verified) customer uid.
-- Lets the wizard resume where a customer left off within a 15-minute window
-- instead of starting over, and caps them to one active attempt at a time.
-- Not the source of truth for a booking — that's still `bookings`, only ever
-- written after payment is verified. `expires_at` is fixed at creation and
-- never extended, so a session always dies exactly 15 minutes after it opened
-- regardless of autosave activity.
CREATE TABLE IF NOT EXISTS public.booking_sessions (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      text        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  booking_ref  text        NOT NULL UNIQUE,
  wizard_state jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status       text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'completed', 'expired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

-- Enforces "max 1 active attempt per customer" at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_sessions_active_user
  ON public.booking_sessions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_booking_sessions_expires
  ON public.booking_sessions (expires_at) WHERE status = 'active';

DROP TRIGGER IF EXISTS set_booking_sessions_updated_at ON public.booking_sessions;
CREATE TRIGGER set_booking_sessions_updated_at
  BEFORE UPDATE ON public.booking_sessions
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

-- ── 8. BOOKING_EDITS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_edits (
  id                 uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id         uuid          NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  changed_by         text          NOT NULL REFERENCES public.users(id),
  change_type        text          NOT NULL CHECK (change_type IN ('add_kids', 'add_addons', 'both', 'reschedule', 'admin_edit', 'room_change')),
  delta_amount       numeric(10,2) NOT NULL DEFAULT 0,
  new_guest_count    integer,
  new_food_choice    text,
  new_addons_summary text,
  payment_intent_id  text,
  old_party_date     date,
  old_party_time     text,
  new_party_date     date,
  new_party_time     text,
  old_party_room_id  uuid          REFERENCES public.party_rooms(id),
  new_party_room_id  uuid          REFERENCES public.party_rooms(id),
  created_at         timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_edits_booking ON public.booking_edits (booking_id);

-- ── 9. GOOGLE_REVIEWS ────────────────────────────────────────
-- Populated by a node-cron job (server/services/googleReviewsSync.js) every 24h.
CREATE TABLE IF NOT EXISTS public.google_reviews (
  id                uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  google_review_id  text          UNIQUE,
  author_name       text          NOT NULL,
  rating            integer       NOT NULL,
  text              text          NOT NULL,
  time              bigint        NOT NULL,
  profile_photo_url text,
  visible           boolean       NOT NULL DEFAULT true,
  is_manual         boolean       NOT NULL DEFAULT false,  -- true for admin-pasted reviews (not from the Places API sync)
  created_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_google_reviews_visible_time ON public.google_reviews (visible, time DESC);

-- ── 10. SITE_RATING ─────────────────────────────────────────
-- Single admin-editable row for the aggregate rating shown on the public site
-- (replaces a live Google Places lookup — admin sets this manually).
CREATE TABLE IF NOT EXISTS public.site_rating (
  id           integer      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rating       numeric(2,1) NOT NULL,
  review_count integer      NOT NULL DEFAULT 0,
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
