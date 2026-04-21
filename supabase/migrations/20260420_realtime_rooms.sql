-- Realtime server-authoritative rooms.
--
-- Goal: stop pinning game state to the host's browser tab. Previously
-- the host tab held lobby + game state in memory and broadcast via
-- PeerJS; when iOS suspended the tab (e.g. switching apps to share an
-- invite link) the whole session died. Moving state into Postgres and
-- syncing via Supabase Realtime makes the room survive anyone's
-- backgrounding, including the "host".
--
-- Schema additions:
--   lobby  jsonb  — pre-game seat list, rules, host-seat marker
--   state  jsonb  — engine state once the match starts (null before)
--   version int   — monotonic counter used for optimistic concurrency
--                    on action submits so two simultaneous writers
--                    can't silently clobber each other.
--
-- Every client runs `applyAction` locally (the engine is pure) and
-- writes back with `WHERE version = :expected`. Conflicts manifest as
-- 0 rows affected; the client re-reads and retries. Bot turns are
-- driven by whichever client sees the state first and wins the
-- version race — the staggered-retry collapses to a single winner.

alter table public.rooms
  add column if not exists lobby jsonb,
  add column if not exists state jsonb,
  add column if not exists version integer not null default 0;

-- Supabase Realtime's postgres_changes stream needs the full row for
-- UPDATEs (not just primary-key diffs), otherwise jsonb column changes
-- can't be evaluated against the subscription filter and the channel
-- fails shortly after SUBSCRIBED with CHANNEL_ERROR. REPLICA IDENTITY
-- FULL makes WAL include the whole row on every change.
alter table public.rooms replica identity full;

-- Realtime needs to publish row changes on this table so subscribers
-- see lobby/state updates in real time. Safe to run repeatedly.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end $$;

-- Anyone with the anon key can read rooms (discovery list + join).
-- For MVP, also allow anon to update rooms (optimistic action writes).
-- Rules are enforced by applyAction on the client, not by RLS. A
-- future hardening pass can move applyAction into an RPC/edge function
-- so RLS can restrict writes to that function's role.
drop policy if exists "rooms_select_anon" on public.rooms;
create policy "rooms_select_anon"
  on public.rooms for select
  to anon, authenticated
  using (true);

drop policy if exists "rooms_insert_anon" on public.rooms;
create policy "rooms_insert_anon"
  on public.rooms for insert
  to anon, authenticated
  with check (true);

drop policy if exists "rooms_update_anon" on public.rooms;
create policy "rooms_update_anon"
  on public.rooms for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "rooms_delete_anon" on public.rooms;
create policy "rooms_delete_anon"
  on public.rooms for delete
  to anon, authenticated
  using (true);

alter table public.rooms enable row level security;
