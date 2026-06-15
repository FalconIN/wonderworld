-- ============================================================
-- Row Level Security Policies — Wonder World Westgate
-- Run this AFTER schema.sql
-- ============================================================

-- ── users ────────────────────────────────────────────────────
alter table public.users enable row level security;

-- Users can read/update their own row
create policy "users: read own" on public.users
  for select using (auth.uid() = id);

create policy "users: update own" on public.users
  for update using (auth.uid() = id);

-- Admins can read every user
create policy "users: admin read all" on public.users
  for select using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- Service role can do anything (Edge Functions use service role key)
-- Covered by Supabase default: service_role bypasses RLS

-- ── party_rooms ──────────────────────────────────────────────
alter table public.party_rooms enable row level security;

-- Anyone (including anon) can read rooms
create policy "party_rooms: public read" on public.party_rooms
  for select using (true);

-- Only admins can modify rooms
create policy "party_rooms: admin write" on public.party_rooms
  for all using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- ── booking_timeslots ────────────────────────────────────────
alter table public.booking_timeslots enable row level security;

-- Anyone can read timeslots (needed to show availability)
create policy "booking_timeslots: public read" on public.booking_timeslots
  for select using (true);

-- Authenticated users can insert a hold for themselves
create policy "booking_timeslots: auth insert hold" on public.booking_timeslots
  for insert with check (
    auth.uid() is not null
    and status = 'held'
  );

-- Users can update/delete their own held slots (release hold)
create policy "booking_timeslots: own hold update" on public.booking_timeslots
  for update using (held_by_user_id = auth.uid());

create policy "booking_timeslots: own hold delete" on public.booking_timeslots
  for delete using (held_by_user_id = auth.uid() and status = 'held');

-- Admins can do anything with slots
create policy "booking_timeslots: admin all" on public.booking_timeslots
  for all using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- ── bookings ─────────────────────────────────────────────────
alter table public.bookings enable row level security;

-- Users can read their own bookings
create policy "bookings: read own" on public.bookings
  for select using (user_id = auth.uid());

-- Authenticated users can insert bookings for themselves
create policy "bookings: insert own" on public.bookings
  for insert with check (user_id = auth.uid());

-- Users can update their own pending bookings (e.g. cancel before confirmation)
create policy "bookings: update own pending" on public.bookings
  for update using (
    user_id = auth.uid()
    and status in ('pending', 'confirmed')
  );

-- Admins can read and update all bookings
create policy "bookings: admin all" on public.bookings
  for all using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- ── payments ─────────────────────────────────────────────────
alter table public.payments enable row level security;

-- Users can read their own payments
create policy "payments: read own" on public.payments
  for select using (user_id = auth.uid());

-- Authenticated users can insert payment records
create policy "payments: insert own" on public.payments
  for insert with check (user_id = auth.uid());

-- Admins can read and update all payments
create policy "payments: admin all" on public.payments
  for all using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- ── email_logs ───────────────────────────────────────────────
alter table public.email_logs enable row level security;

-- Only admins can read email logs
create policy "email_logs: admin read" on public.email_logs
  for select using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );
-- Inserts handled by service role in Edge Functions only

-- ── sms_logs ─────────────────────────────────────────────────
alter table public.sms_logs enable row level security;

create policy "sms_logs: admin read" on public.sms_logs
  for select using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- ── scheduled_sms ────────────────────────────────────────────
alter table public.scheduled_sms enable row level security;

create policy "scheduled_sms: admin read" on public.scheduled_sms
  for select using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );

-- ── Realtime publication ─────────────────────────────────────
-- Allow frontend to subscribe to timeslot changes (availability updates)
alter publication supabase_realtime add table public.booking_timeslots;
