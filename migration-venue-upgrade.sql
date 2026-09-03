-- Admin-initiated "extra kids" whole-venue-hire upgrade for 24+ kid bookings.
-- See server/routes/admin.js (POST /bookings/:id/upgrade-to-venue,
-- /send-upgrade-payment-link), server/services/roomPricing.js,
-- server/services/venueUpgradeExpiry.js.
-- Run as the wonderworld DB user:
--   psql -U wonderworld -d wonderworld -f migration-venue-upgrade.sql
BEGIN;

ALTER TABLE public.bookings
  -- NULL = never upgraded. 'pending_payment' = room/count already switched,
  -- awaiting the extra-kids payment before the 1-week-before-party deadline.
  -- 'completed' = paid in full. Presence of a non-null value is what gates
  -- customer edits to guest_count in POST /bookings/:id/edit and
  -- /reduce-guests (room/date/time are already admin-only for every
  -- booking, system-wide, independent of this).
  ADD COLUMN IF NOT EXISTS upgrade_status text
    CHECK (upgrade_status IN ('pending_payment', 'completed')),
  -- The per-child overage rate locked in at upgrade time — the original
  -- room's base_price_per_child, captured once so a later price change to
  -- that room doesn't retroactively alter what this customer owes.
  ADD COLUMN IF NOT EXISTS upgrade_overage_rate numeric(10,2),
  -- Always party_date - 7 days, computed once at upgrade time — the
  -- "at least one week before the party date" cutoff from the spec.
  ADD COLUMN IF NOT EXISTS upgrade_deadline_at timestamptz,
  -- Snapshot of pre-upgrade state, needed to revert cleanly if the deadline
  -- passes unpaid (see venueUpgradeExpiry.js) — booking_edits also records
  -- this history, but reading it back out of an audit-log table to drive a
  -- revert felt fragile, so it's duplicated here as the operational copy.
  ADD COLUMN IF NOT EXISTS pre_upgrade_party_room_id uuid REFERENCES public.party_rooms(id),
  ADD COLUMN IF NOT EXISTS pre_upgrade_guest_count integer,
  ADD COLUMN IF NOT EXISTS pre_upgrade_base_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS pre_upgrade_total_amount numeric(10,2);

ALTER TABLE public.booking_edits
  DROP CONSTRAINT IF EXISTS booking_edits_change_type_check;
ALTER TABLE public.booking_edits
  ADD CONSTRAINT booking_edits_change_type_check
  CHECK (change_type IN ('add_kids', 'add_addons', 'both', 'reschedule', 'admin_edit', 'room_change', 'reduce_kids', 'venue_upgrade'));

-- Dedicated system actor for the auto-revert cron job, which has no admin to
-- attribute the change to — booking_edits.changed_by is NOT NULL. Never
-- logs in (no Firebase identity), is_admin stays false (nothing grants it
-- privileges; it's only ever referenced as an FK target, never
-- authenticated against).
INSERT INTO public.users (id, first_name, last_name, email)
VALUES ('system', 'System', '', 'system@wonderworldwestgate.co.nz')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.booking_payment_links (
  id                   uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id           uuid          NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  token_hash           text          NOT NULL UNIQUE,
  amount_cents         integer       NOT NULL,
  stripe_payment_intent_id text,
  paid_at              timestamptz,
  invalidated_at       timestamptz,
  deadline_at          timestamptz   NOT NULL,
  created_by_admin_id  text          NOT NULL REFERENCES public.users(id),
  created_at           timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_payment_links_booking ON public.booking_payment_links (booking_id);

COMMIT;
