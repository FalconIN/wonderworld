-- ============================================================
-- Wonder World Westgate — Supabase Database Schema
-- Run in: Supabase Dashboard > SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── 1. USERS ────────────────────────────────────────────────
-- Extends Supabase auth.users with our custom profile data
create table if not exists public.users (
  id                uuid primary key references auth.users(id) on delete cascade,
  first_name        text not null default '',
  last_name         text not null default '',
  email             text not null,
  phone             text,
  stripe_customer_id text,
  is_admin          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Automatically create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.users (id, first_name, last_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', split_part(coalesce(new.raw_user_meta_data->>'full_name', ''), ' ', 1), ''),
    coalesce(new.raw_user_meta_data->>'last_name',  split_part(coalesce(new.raw_user_meta_data->>'full_name', ''), ' ', 2), ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 2. PARTY_ROOMS ─────────────────────────────────────────
create table if not exists public.party_rooms (
  id                  uuid primary key default uuid_generate_v4(),
  slug                text not null unique,         -- matches JS room.id: 'big', 'sunshine', etc.
  name                text not null,
  emoji               text not null default '🎉',
  tag_line            text,
  color               text,
  min_guests          integer not null default 8,
  max_guests          integer not null default 15,
  base_price_per_child numeric(10,2) not null default 39.00,
  weekday_total       numeric(10,2),                -- Big Room only
  weekend_total       numeric(10,2),                -- Big Room only
  description         text,
  is_active           boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now()
);

-- Seed default rooms
insert into public.party_rooms (slug, name, emoji, tag_line, color, min_guests, max_guests, base_price_per_child, weekday_total, weekend_total, description, sort_order)
values
  ('big',      'The Big Room',          '🌟', 'Exclusive Extra Large Zone', 'indigo', 16, 24, 39.00, 49.00, 59.00,  'Our flagship space — private stage, expanded play zone.', 1),
  ('sunshine', 'Sunshine Room',         '☀️', 'Yellow · Warm & Cheerful',  'yellow',  8, 15, 39.00, null,  null,   'Bright, sunny, and full of energy.',                    2),
  ('dream',    'Dream Room',            '🌙', 'Purple · Magical & Dreamy', 'purple',  8, 15, 39.00, null,  null,   'Soft lighting, dreamy decor.',                          3),
  ('forest',   'Wonder Forest Room',    '🌿', 'Green · Nature Adventure',  'green',   8, 15, 39.00, null,  null,   'An immersive forest theme.',                            4)
on conflict (slug) do nothing;

-- ── 3. BOOKING_TIMESLOTS ────────────────────────────────────
-- Prevents double-bookings. One row per slot per room per date.
create table if not exists public.booking_timeslots (
  id              uuid primary key default uuid_generate_v4(),
  party_room_id   uuid not null references public.party_rooms(id) on delete cascade,
  slot_date       date not null,
  slot_time       text not null,          -- e.g. "9:30 AM"
  status          text not null default 'held'
                  check (status in ('held', 'confirmed', 'released')),
  held_by_user_id uuid references auth.users(id) on delete set null,
  booking_id      uuid,                   -- set once booking is confirmed
  hold_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  
  -- Prevent duplicate slot per room per date
  unique (party_room_id, slot_date, slot_time)
);

create index if not exists idx_timeslots_room_date
  on public.booking_timeslots (party_room_id, slot_date);
create index if not exists idx_timeslots_status
  on public.booking_timeslots (status);
create index if not exists idx_timeslots_expires
  on public.booking_timeslots (hold_expires_at)
  where status = 'held';

-- ── 4. BOOKINGS ─────────────────────────────────────────────
create table if not exists public.bookings (
  id                       uuid primary key default uuid_generate_v4(),
  booking_ref              text not null unique,    -- e.g. 'WW-X7K3P1'
  user_id                  uuid not null references auth.users(id) on delete restrict,
  party_room_id            uuid not null references public.party_rooms(id) on delete restrict,
  party_date               date not null,
  party_time               text not null,
  guest_count              integer not null check (guest_count >= 1),
  food_choice              text check (food_choice in ('nuggets', 'burgers', 'pizza')),
  allergy_notes            text,
  allergies                text[] default '{}',
  total_amount             numeric(10,2) not null,
  is_weekend               boolean not null default false,
  status                   text not null default 'confirmed'
                           check (status in ('pending', 'confirmed', 'cancelled', 'refunded')),
  contact_email            text not null,
  contact_phone            text,
  stripe_payment_intent_id text,
  cancelled_at             timestamptz,
  refunded_at              timestamptz,
  notes                    text,                    -- internal admin notes
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_bookings_user_id
  on public.bookings (user_id);
create index if not exists idx_bookings_party_date
  on public.bookings (party_date);
create index if not exists idx_bookings_status
  on public.bookings (status);
create index if not exists idx_bookings_booking_ref
  on public.bookings (booking_ref);

-- Auto-update updated_at
create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_bookings_updated_at on public.bookings;
create trigger set_bookings_updated_at
  before update on public.bookings
  for each row execute function public.update_updated_at_column();

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
  before update on public.users
  for each row execute function public.update_updated_at_column();

-- ── 5. PAYMENTS ─────────────────────────────────────────────
create table if not exists public.payments (
  id                       uuid primary key default uuid_generate_v4(),
  booking_id               uuid references public.bookings(id) on delete set null,
  user_id                  uuid references auth.users(id) on delete set null,
  stripe_payment_intent_id text unique,
  amount                   numeric(10,2) not null,
  currency                 text not null default 'nzd',
  status                   text not null default 'pending'
                           check (status in ('pending', 'succeeded', 'failed', 'refunded', 'cancelled')),
  error_message            text,
  metadata                 jsonb default '{}',
  refunded_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_payments_booking_id
  on public.payments (booking_id);
create index if not exists idx_payments_user_id
  on public.payments (user_id);
create index if not exists idx_payments_stripe_pi
  on public.payments (stripe_payment_intent_id);
create index if not exists idx_payments_status
  on public.payments (status);

drop trigger if exists set_payments_updated_at on public.payments;
create trigger set_payments_updated_at
  before update on public.payments
  for each row execute function public.update_updated_at_column();

-- ── 6. EMAIL_LOGS ───────────────────────────────────────────
create table if not exists public.email_logs (
  id          uuid primary key default uuid_generate_v4(),
  booking_id  uuid references public.bookings(id) on delete set null,
  email_type  text not null,  -- 'booking_confirmation', 'payment_receipt', 'reminder'
  recipient   text not null,
  resend_id   text,
  status      text not null default 'sent',
  created_at  timestamptz not null default now()
);

-- ── 7. SMS_LOGS ─────────────────────────────────────────────
create table if not exists public.sms_logs (
  id          uuid primary key default uuid_generate_v4(),
  booking_id  uuid references public.bookings(id) on delete set null,
  sms_type    text not null,  -- 'booking_confirmation', 'reminder', 'payment_confirmation'
  recipient   text not null,
  twilio_sid  text,
  status      text not null default 'sent',
  created_at  timestamptz not null default now()
);

-- ── 8. SCHEDULED_SMS ────────────────────────────────────────
-- For 24-hour party reminders. Process with a pg_cron job.
create table if not exists public.scheduled_sms (
  id           uuid primary key default uuid_generate_v4(),
  booking_id   uuid references public.bookings(id) on delete cascade,
  phone        text not null,
  message      text not null,
  scheduled_at timestamptz not null,
  status       text not null default 'pending'
               check (status in ('pending', 'sent', 'failed', 'cancelled')),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_scheduled_sms_pending
  on public.scheduled_sms (scheduled_at)
  where status = 'pending';

-- ── Automatic slot expiry cleanup (optional pg_cron) ────────
-- Run this with pg_cron every 5 minutes:
-- SELECT cron.schedule('release-expired-holds', '*/5 * * * *',
--   $$ DELETE FROM public.booking_timeslots WHERE status = 'held' AND hold_expires_at < now() $$);
