-- EUS Workstations v2 – maintenance blocks, auto-release, editable bookings, audit log.
-- Run once in Supabase SQL Editor AFTER workstations.sql.

alter table ws_settings add column if not exists auto_release_hours int not null default 10 check (auto_release_hours between 0 and 48);
alter table ws_sessions add column if not exists confirmed_at timestamptz;

create table if not exists ws_blocks (            -- maintenance windows
  id uuid primary key default gen_random_uuid(),
  station_id int not null references ws_stations on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_by_name text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists ws_blocks_time_idx on ws_blocks (ends_at);

create table if not exists ws_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_name text,
  action text not null,
  detail text,
  meta jsonb
);
create index if not exists ws_audit_at_idx on ws_audit (at desc);

alter table ws_blocks enable row level security;
alter table ws_audit enable row level security;
drop policy if exists ws_blocks_read on ws_blocks;
create policy ws_blocks_read on ws_blocks for select to anon, authenticated
  using (ws_can_view() or (ws_public() and ends_at > now()));
drop policy if exists ws_audit_read on ws_audit;
create policy ws_audit_read on ws_audit for select to authenticated using (ws_is_admin());

create or replace function ws_log(p_action text, p_detail text, p_meta jsonb default null) returns void
language sql security definer set search_path = public as $$
  insert into ws_audit (actor_id, actor_name, action, detail, meta)
  values ((select auth.uid()), coalesce(ws_my_name(), 'system'), p_action, p_detail, p_meta) $$;

-- automatic audit of admin-side table edits
create or replace function ws_audit_members() returns trigger language plpgsql security definer set search_path = public as $$
declare u text;
begin
  select coalesce(nullif(full_name, ''), username) || ' (@' || username || ')' into u from profiles where id = coalesce(new.user_id, old.user_id);
  if tg_op = 'DELETE' then perform ws_log('access', format('%s: access removed (was %s)', u, old.role));
  elsif tg_op = 'INSERT' then perform ws_log('access', format('%s: set to %s', u, new.role));
  elsif new.role is distinct from old.role then perform ws_log('access', format('%s: %s → %s', u, old.role, new.role)); end if;
  return null;
end $$;
drop trigger if exists ws_members_audit on ws_members;
create trigger ws_members_audit after insert or update or delete on ws_members for each row execute function ws_audit_members();

create or replace function ws_audit_stations() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.name, new.kvm_group, new.hdmi_ports, new.notes, new.enabled) is distinct from (old.name, old.kvm_group, old.hdmi_ports, old.notes, old.enabled) then
    perform ws_log('station', format('%s edited (enabled=%s, KVM group=%s, HDMI ports=%s)', new.name, new.enabled, coalesce(new.kvm_group, '-'), coalesce(new.hdmi_ports::text, '-')));
  end if;
  return null;
end $$;
drop trigger if exists ws_stations_audit on ws_stations;
create trigger ws_stations_audit after update on ws_stations for each row execute function ws_audit_stations();

create or replace function ws_audit_settings() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.public_display is distinct from old.public_display then perform ws_log('settings', 'Public display ' || case when new.public_display then 'ON' else 'OFF' end); end if;
  if new.auto_release_hours is distinct from old.auto_release_hours then perform ws_log('settings', 'Auto-release set to ' || new.auto_release_hours || ' h'); end if;
  return null;
end $$;
drop trigger if exists ws_settings_audit on ws_settings;
create trigger ws_settings_audit after update on ws_settings for each row execute function ws_audit_settings();

-- ---------- auto-release of forgotten sessions ----------
create or replace function ws_sweep() returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; hrs int; s ws_sessions; sname text;
begin
  select auto_release_hours into hrs from ws_settings where id = 1;
  if coalesce(hrs, 0) = 0 then return 0; end if;
  for s in select * from ws_sessions where ended_at is null and coalesce(confirmed_at, started_at) + make_interval(hours => hrs) <= now() for update skip locked loop
    update ws_sessions set ended_at = coalesce(s.confirmed_at, s.started_at) + make_interval(hours => hrs), ended_by = 'auto-release' where id = s.id;
    if s.reservation_id is not null then update ws_reservations set status = 'done' where id = s.reservation_id and status = 'booked'; end if;
    select name into sname from ws_stations where id = s.station_id;
    perform ws_log('auto_release', format('%s on %s (case %s) was released after %s h without confirmation', s.user_name, sname, s.case_number, hrs));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function ws_confirm_session(p_id uuid) returns ws_sessions
language plpgsql security definer set search_path = public as $$
declare s ws_sessions;
begin
  select * into s from ws_sessions where id = p_id and ended_at is null for update;
  if not found then raise exception 'Session already ended'; end if;
  if s.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your session'; end if;
  update ws_sessions set confirmed_at = now() where id = p_id returning * into s;
  return s;
end $$;

-- ---------- maintenance blocks ----------
create or replace function ws_add_block(p_station int, p_start timestamptz, p_end timestamptz, p_reason text)
returns ws_blocks language plpgsql security definer set search_path = public as $$
declare b ws_blocks; who text; sname text;
begin
  if not ws_is_admin() then raise exception 'Admins only'; end if;
  if p_end <= p_start then raise exception 'End time must be after start time'; end if;
  select name into sname from ws_stations where id = p_station;
  if sname is null then raise exception 'Unknown workstation'; end if;
  select user_name into who from ws_reservations
   where station_id = p_station and status = 'booked' and tstzrange(starts_at, ends_at) && tstzrange(p_start, p_end) limit 1;
  if who is not null then raise exception 'Conflicts with a booking by % – cancel it first', who; end if;
  if p_start <= now() then
    select user_name into who from ws_sessions where station_id = p_station and ended_at is null;
    if who is not null then raise exception '% is in use by % right now – release it first', sname, who; end if;
  end if;
  insert into ws_blocks (station_id, starts_at, ends_at, reason, created_by_name)
    values (p_station, p_start, p_end, nullif(trim(p_reason), ''), ws_my_name()) returning * into b;
  perform ws_log('maintenance', format('%s blocked%s', sname, coalesce(' – ' || b.reason, '')), jsonb_build_object('starts', b.starts_at, 'ends', b.ends_at));
  return b;
end $$;

create or replace function ws_remove_block(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b ws_blocks; sname text;
begin
  if not ws_is_admin() then raise exception 'Admins only'; end if;
  delete from ws_blocks where id = p_id returning * into b;
  if found then
    select name into sname from ws_stations where id = b.station_id;
    perform ws_log('maintenance', format('Maintenance block removed on %s%s', sname, coalesce(' – ' || b.reason, '')), jsonb_build_object('starts', b.starts_at, 'ends', b.ends_at));
  end if;
end $$;

-- ---------- start / reserve / edit / end / cancel (block + audit aware) ----------
create or replace function ws_start_session(p_station int, p_case text, p_desc text, p_reservation uuid default null)
returns ws_sessions language plpgsql security definer set search_path = public as $$
declare st ws_stations; s ws_sessions; who text; busy text; until_ timestamptz; why text; c text := nullif(trim(p_case), '');
begin
  if ws_role() not in ('user','admin') then raise exception 'You do not have permission to use workstations'; end if;
  if c is null then raise exception 'Case number is required'; end if;
  perform ws_sweep();
  st := ws_lock_group(p_station);

  select coalesce(reason, 'maintenance') into why from ws_blocks where station_id = p_station and starts_at <= now() and ends_at > now() limit 1;
  if why is not null then raise exception '% is under maintenance (%)', st.name, why; end if;

  select x.user_name, t.name into who, busy from ws_sessions x join ws_stations t on t.id = x.station_id
   where x.ended_at is null and (x.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
  if who is not null then raise exception '% is already in use by %', busy, who; end if;

  select v.user_name, v.ends_at into who, until_ from ws_reservations v join ws_stations t on t.id = v.station_id
   where v.status = 'booked' and v.starts_at <= now() and v.ends_at > now() and v.user_id <> auth.uid()
     and (v.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
  if who is not null then raise exception 'Reserved by % until %', who, to_char(until_ at time zone 'UTC', 'HH24:MI "UTC"'); end if;

  if p_reservation is not null and not exists
     (select 1 from ws_reservations where id = p_reservation and user_id = auth.uid() and station_id = p_station and status = 'booked') then
    p_reservation := null;
  end if;

  insert into ws_sessions (station_id, user_id, user_name, case_number, description, reservation_id)
    values (p_station, auth.uid(), ws_my_name(), c, nullif(trim(p_desc), ''), p_reservation) returning * into s;
  return s;
end $$;

create or replace function ws_reserve(p_station int, p_start timestamptz, p_end timestamptz, p_case text, p_desc text)
returns ws_reservations language plpgsql security definer set search_path = public as $$
declare st ws_stations; r ws_reservations; who text; why text; c text := nullif(trim(p_case), '');
begin
  if ws_role() not in ('user','admin') then raise exception 'You do not have permission to reserve workstations'; end if;
  if c is null then raise exception 'Case number is required'; end if;
  if p_end <= p_start then raise exception 'End time must be after start time'; end if;
  if p_start < now() - interval '5 minutes' then raise exception 'Start time is in the past'; end if;
  if p_start > now() + interval '90 days' then raise exception 'Reservations can be made up to 90 days ahead'; end if;
  if p_end - p_start > interval '12 hours' then raise exception 'A single reservation can be at most 12 hours'; end if;
  perform ws_sweep();
  st := ws_lock_group(p_station);

  select coalesce(reason, 'maintenance') into why from ws_blocks where station_id = p_station and tstzrange(starts_at, ends_at) && tstzrange(p_start, p_end) limit 1;
  if why is not null then raise exception '% is under maintenance during that time (%)', st.name, why; end if;

  select v.user_name into who from ws_reservations v join ws_stations t on t.id = v.station_id
   where v.status = 'booked' and tstzrange(v.starts_at, v.ends_at) && tstzrange(p_start, p_end)
     and (v.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group))
   order by v.starts_at limit 1;
  if who is not null then raise exception 'That time overlaps a booking by %', who; end if;

  if p_start <= now() then
    select x.user_name into who from ws_sessions x join ws_stations t on t.id = x.station_id
     where x.ended_at is null and x.user_id <> auth.uid()
       and (x.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
    if who is not null then raise exception 'Currently in use by %', who; end if;
  end if;

  insert into ws_reservations (station_id, user_id, user_name, starts_at, ends_at, case_number, description)
    values (p_station, auth.uid(), ws_my_name(), p_start, p_end, c, nullif(trim(p_desc), '')) returning * into r;
  perform ws_log('booking', format('%s booked %s (case %s)', r.user_name, st.name, c), jsonb_build_object('starts', r.starts_at, 'ends', r.ends_at));
  return r;
end $$;

-- change time / station / details of a booking (extend, shorten or move)
create or replace function ws_update_reservation(p_id uuid, p_station int, p_start timestamptz, p_end timestamptz, p_case text, p_desc text)
returns ws_reservations language plpgsql security definer set search_path = public as $$
declare st ws_stations; old ws_reservations; r ws_reservations; who text; why text; c text := nullif(trim(p_case), '');
begin
  if ws_role() not in ('user','admin') then raise exception 'You do not have permission to change reservations'; end if;
  select * into old from ws_reservations where id = p_id and status = 'booked' for update;
  if not found then raise exception 'Reservation not found'; end if;
  if old.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your reservation'; end if;
  if c is null then raise exception 'Case number is required'; end if;
  if p_end <= p_start then raise exception 'End time must be after start time'; end if;
  if p_end <= now() then raise exception 'End time is in the past'; end if;
  if p_start is distinct from old.starts_at and p_start < now() - interval '5 minutes' then raise exception 'Start time is in the past'; end if;
  if p_start > now() + interval '90 days' then raise exception 'Reservations can be made up to 90 days ahead'; end if;
  if p_end - p_start > interval '12 hours' then raise exception 'A single reservation can be at most 12 hours'; end if;
  perform ws_sweep();
  st := ws_lock_group(p_station);

  select coalesce(reason, 'maintenance') into why from ws_blocks where station_id = p_station and tstzrange(starts_at, ends_at) && tstzrange(p_start, p_end) limit 1;
  if why is not null then raise exception '% is under maintenance during that time (%)', st.name, why; end if;

  select v.user_name into who from ws_reservations v join ws_stations t on t.id = v.station_id
   where v.status = 'booked' and v.id <> p_id and tstzrange(v.starts_at, v.ends_at) && tstzrange(p_start, p_end)
     and (v.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group))
   order by v.starts_at limit 1;
  if who is not null then raise exception 'That time overlaps a booking by %', who; end if;

  if p_start <= now() then
    select x.user_name into who from ws_sessions x join ws_stations t on t.id = x.station_id
     where x.ended_at is null and x.user_id <> old.user_id
       and (x.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
    if who is not null then raise exception 'Currently in use by %', who; end if;
  end if;

  update ws_reservations set station_id = p_station, starts_at = p_start, ends_at = p_end, case_number = c, description = nullif(trim(p_desc), '')
   where id = p_id returning * into r;
  perform ws_log('booking_edit', format('%s''s booking on %s changed%s', r.user_name, st.name, case when old.user_id <> auth.uid() then ' by an admin' else '' end),
    jsonb_build_object('starts', r.starts_at, 'ends', r.ends_at));
  return r;
end $$;

create or replace function ws_end_session(p_id uuid)
returns ws_sessions language plpgsql security definer set search_path = public as $$
declare s ws_sessions; sname text;
begin
  select * into s from ws_sessions where id = p_id and ended_at is null for update;
  if not found then raise exception 'Session already ended'; end if;
  if s.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your session'; end if;
  update ws_sessions set ended_at = now(), ended_by = case when s.user_id = auth.uid() then null else ws_my_name() end
   where id = p_id returning * into s;
  if s.reservation_id is not null then
    update ws_reservations set status = 'done' where id = s.reservation_id and status = 'booked';
  end if;
  if s.user_id <> auth.uid() then
    select name into sname from ws_stations where id = s.station_id;
    perform ws_log('release', format('%s was released from %s (case %s)', s.user_name, sname, s.case_number));
  end if;
  return s;
end $$;

create or replace function ws_cancel_reservation(p_id uuid)
returns ws_reservations language plpgsql security definer set search_path = public as $$
declare r ws_reservations; sname text;
begin
  select * into r from ws_reservations where id = p_id and status = 'booked' for update;
  if not found then raise exception 'Reservation not found'; end if;
  if r.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your reservation'; end if;
  update ws_reservations set status = 'cancelled' where id = p_id returning * into r;
  select name into sname from ws_stations where id = r.station_id;
  perform ws_log('booking_cancel', format('%s''s booking on %s was cancelled%s', r.user_name, sname, case when r.user_id <> auth.uid() then ' by an admin' else '' end),
    jsonb_build_object('starts', r.starts_at, 'ends', r.ends_at));
  return r;
end $$;

-- ---------- grants ----------
revoke execute on function ws_log(text,text,jsonb), ws_audit_members(), ws_audit_stations(), ws_audit_settings(), ws_sweep(), ws_confirm_session(uuid),
  ws_add_block(int,timestamptz,timestamptz,text), ws_remove_block(uuid), ws_update_reservation(uuid,int,timestamptz,timestamptz,text,text) from public, anon, authenticated;
grant execute on function ws_confirm_session(uuid), ws_add_block(int,timestamptz,timestamptz,text), ws_remove_block(uuid),
  ws_update_reservation(uuid,int,timestamptz,timestamptz,text,text) to authenticated;
grant execute on function ws_sweep() to anon, authenticated;   -- idempotent; lets any open board trigger the clean-up

do $$ begin
  begin alter publication supabase_realtime add table ws_blocks; exception when duplicate_object then null; end;
end $$;

-- run the sweep every 10 minutes even when nobody has the app open (needs the pg_cron extension; skipped if unavailable)
do $$ begin
  begin
    create extension if not exists pg_cron;
    perform cron.unschedule('ws-sweep') where exists (select 1 from cron.job where jobname = 'ws-sweep');
    perform cron.schedule('ws-sweep', '*/10 * * * *', 'select public.ws_sweep()');
  exception when others then raise notice 'pg_cron not available - the sweep still runs whenever someone opens the board';
  end;
end $$;
