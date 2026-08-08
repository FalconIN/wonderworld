-- ============================================================
-- Migration: 5:30–7:00 PM Fri/Sat slot + Whole Venue Hire package
-- (Sun/Mon/Tue, $2,899 flat, catering choice + no-alcohol ack)
--
-- NOT auto-applied. Hand-run against the live DB once approved:
--   psql -U wonderworld -d wonderworld -f migration-whole-venue-and-evening-slot.sql
--
-- Idempotent (safe to re-run) — mirrors the additive changes already
-- made to server/schema.sql / schema.sql / schema-postgres.sql.
--
-- GUEST CAPACITY: no minimum (min_guests=1) / max_guests=300 (confirmed 2026-08-08).
-- ============================================================

BEGIN;

-- ── party_rooms: flat pricing + day-of-week restriction support ──────
ALTER TABLE public.party_rooms
  ADD COLUMN IF NOT EXISTS pricing_model text NOT NULL DEFAULT 'per_child';

DO $$ BEGIN
  ALTER TABLE public.party_rooms
    ADD CONSTRAINT party_rooms_pricing_model_check
    CHECK (pricing_model IN ('per_child', 'flat'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.party_rooms ADD COLUMN IF NOT EXISTS flat_price numeric(10,2);
ALTER TABLE public.party_rooms ADD COLUMN IF NOT EXISTS allowed_days_of_week integer[];

-- ── bookings: catering choice + no-alcohol acknowledgment ────────────
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS catering_choice text;

DO $$ BEGIN
  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_catering_choice_check
    CHECK (catering_choice IN ('self_catering', 'venue_menu'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS no_alcohol_ack boolean NOT NULL DEFAULT false;

-- ── New party_rooms row: Whole Venue Hire ─────────────────────────────
INSERT INTO public.party_rooms
  (slug, name, emoji, tag_line, color, min_guests, max_guests,
   base_price_per_child, weekday_total, weekend_total, description,
   sort_order, pricing_model, flat_price, allowed_days_of_week)
VALUES
  ('whole-venue', 'Whole Venue Hire', '🏛️', 'Exclusive Full-Venue Buyout',
   'slate', 1, 300, 0.00, null, null,
   'The entire venue, exclusively yours — Sunday, Monday or Tuesday evenings only.',
   5, 'flat', 2899.00, '{0,1,2}')
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- Nothing to migrate for the new 5:30 PM Fri/Sat time slot itself —
-- booking_timeslots.slot_time is a free-text column (no CHECK constraint
-- on the value), so no schema change is needed there. Its Fri/Sat-only
-- restriction is enforced in application code
-- (server/services/bookingRules.js), same as every other slot-time
-- constant already hardcoded across this codebase.
