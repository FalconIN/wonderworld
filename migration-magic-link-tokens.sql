-- Magic-link login for manually-created bookings. See server/services/magicLink.js.
-- Run as the wonderworld DB user:
--   psql -U wonderworld -d wonderworld -f migration-magic-link-tokens.sql
BEGIN;

-- Distinguishes a Postgres-only "premade" account (created by admin manual-
-- booking, id minted to match a real Firebase UID but never actually signed
-- into) from a real one that's been claimed/used. More robust than sniffing
-- the id's shape (the existing PLACEHOLDER_ID_RE regex in bookings.js) and
-- needed so the manual-booking route can tell "attach to an existing real
-- account, no magic link needed" apart from "attach to an existing
-- not-yet-claimed placeholder, a link can still be (re)issued".
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_placeholder boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.magic_link_tokens (
  id                   uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              text        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- sha256(raw token) — the raw token is only ever in the emailed URL, never
  -- stored, so a DB leak alone can't grant login the way a stored raw token
  -- would.
  token_hash           text        NOT NULL UNIQUE,
  expires_at           timestamptz NOT NULL,
  used_at              timestamptz,
  invalidated_at       timestamptz,
  created_by_admin_id  text        NOT NULL REFERENCES public.users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_user ON public.magic_link_tokens (user_id);

COMMIT;
