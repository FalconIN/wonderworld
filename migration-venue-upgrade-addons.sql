-- Lets a customer add extra food/drinks on the whole-venue-hire upgrade
-- payment page (pay-upgrade.html), on top of the existing per-child
-- overage charge. Idempotent — safe to run more than once.

ALTER TABLE public.booking_payment_links
  ADD COLUMN IF NOT EXISTS base_amount_cents integer,
  ADD COLUMN IF NOT EXISTS additional_addons jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS additional_addons_summary text;

-- Backfill existing rows (created before this column existed) so
-- base_amount_cents == amount_cents, i.e. "no addons added yet" — correct
-- since no payment link could have had addons before this feature existed.
UPDATE public.booking_payment_links SET base_amount_cents = amount_cents WHERE base_amount_cents IS NULL;

ALTER TABLE public.booking_payment_links ALTER COLUMN base_amount_cents SET NOT NULL;
