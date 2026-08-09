-- ============================================================
-- Migration: partial unique index guarding against double-booked slots
--
-- Incident: WW-129HC4 (2026-08-08) — a customer was charged via Stripe
-- but the booking row was never written (client-side hold-timer race).
-- Investigation found bookings had no DB-level constraint stopping two
-- confirmed rows from ever sharing the same (room, date, time) — only
-- booking_timeslots did, and application code could bypass it. This is
-- the backstop; server/services/bookingCreator.js was also fixed to do
-- an atomic timeslot claim before writing bookings (see that file).
--
-- NOT auto-applied. Hand-run against the live DB once approved:
--   psql -U wonderworld -d wonderworld -f migration-double-booking-guard.sql
--
-- Idempotent (safe to re-run) — mirrors the additive change already made
-- to server/schema.sql / schema.sql / schema-postgres.sql.
--
-- Safe to apply: checked live data first (2026-08-09) — zero existing
-- (party_room_id, party_date, party_time) groups with more than one
-- 'confirmed' row out of 207 confirmed bookings, so the index creation
-- cannot fail against current data.
-- ============================================================

BEGIN;

-- Only 'confirmed' is constrained -- 'pending'/'cancelled'/'refunded' rows
-- are allowed to share a slot (e.g. a cancelled booking freeing it up again).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_confirmed_slot
  ON public.bookings (party_room_id, party_date, party_time)
  WHERE status = 'confirmed';

COMMIT;
