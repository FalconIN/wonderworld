-- Adds an actor column to email_logs so admin-triggered sends (resend
-- confirmation, magic-link resend, venue-upgrade payment link) record which
-- admin sent them — needed for the audit trail on pricing/access-affecting
-- customer communications. NULL for customer/system-triggered sends
-- (original confirmation, password reset), which have no admin actor.
-- Run as the wonderworld DB user:
--   psql -U wonderworld -d wonderworld -f migration-email-logs-actor.sql
BEGIN;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS sent_by_admin_id text REFERENCES public.users(id);

COMMIT;
