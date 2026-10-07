-- EUS Workstations – live occupancy board + reservations.
-- Run once in Supabase SQL Editor AFTER schema.sql (it reuses profiles / is_active() / is_admin()).
-- Purely additive: every object is prefixed ws_.
create extension if not exists btree_gist;

-- ---------- tables ----------
create table if not exists ws_stations (
  id int primary key,
  name text not null,
  kvm_group text,                 -- stations sharing a group share one KVM switch: only ONE can be in use at a time
  hdmi_ports int,                 -- informational (HDMI ports used on the KVM)
  notes text,
  enabled boolean not null default true
);

create table if not exists ws_members (   -- who may use the dashboard, and how
  user_id uuid primary key references profiles on delete cascade,
  role text not null default 'none' check (role in ('none','viewer','user','admin')),
  updated_at timestamptz not null default now()
);

create table if not exists ws_settings (  -- single row
  id int primary key default 1 check (id = 1),
  public_display boolean not null default false   -- allow a read-only wall display without login
);
insert into ws_settings (id) values (1) on conflict do nothing;

create table if not exists ws_reservations (
  id uuid primary key default gen_random_uuid(),
  station_id int not null references ws_stations on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  user_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  case_number text,
  description text,
  status text not null default 'booked' check (status in ('booked','cancelled','done')),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  exclude using gist (station_id with =, tstzrange(starts_at, ends_at) with &&) where (status = 'booked')
);
create index if not exists ws_res_time_idx on ws_reservations (ends_at) where status = 'booked';

create table if not exists ws_sessions (
  id uuid primary key default gen_random_uuid(),
  station_id int not null references ws_stations on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  user_name text not null,
  case_number text not null,
  description text,
  reservation_id uuid references ws_reservations on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by text,
  constraint ws_sessions_case_nonblank check (length(trim(case_number)) > 0)
);
create unique index if not exists ws_one_active_per_station on ws_sessions (station_id) where ended_at is null;
create index if not exists ws_sessions_started_idx on ws_sessions (started_at desc);

insert into ws_stations (id, name, kvm_group, hdmi_ports, notes) values
  (1, 'Workstation 1', null,    null, null),
  (2, 'Workstation 2', null,    3,    null),   -- own KVM switch, 3 HDMI ports (set kvm_group on two stations only if they share one switch)
  (3, 'Workstation 3', null,    3,    null),   -- own KVM switch, 3 HDMI ports
  (4, 'Workstation 4', null,    null, null)
on conflict do nothing;

-- ---------- permission helpers ----------
-- 'none' | 'viewer' | 'user' | 'admin'.  App admins (profiles.role='admin') are always workstation admins.
create or replace function ws_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when not is_active() then 'none'
    when is_admin() then 'admin'
    else coalesce((select role from ws_members where user_id = (select auth.uid())), 'none')
  end $$;
create or replace function ws_can_view() returns boolean language sql stable security definer set search_path = public as
$$ select ws_role() in ('viewer','user','admin') $$;
create or replace function ws_is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select ws_role() = 'admin' $$;
create or replace function ws_public() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select public_display from ws_settings where id = 1), false) $$;

-- ---------- row level security (reads only; all writes go through functions below) ----------
alter table ws_stations enable row level security;
alter table ws_members enable row level security;
alter table ws_settings enable row level security;
alter table ws_reservations enable row level security;
alter table ws_sessions enable row level security;

drop policy if exists ws_stations_read on ws_stations;
create policy ws_stations_read on ws_stations for select to anon, authenticated using (ws_can_view() or ws_public());
drop policy if exists ws_stations_upd on ws_stations;
create policy ws_stations_upd on ws_stations for update to authenticated using (ws_is_admin()) with check (ws_is_admin());

drop policy if exists ws_settings_read on ws_settings;
create policy ws_settings_read on ws_settings for select to anon, authenticated using (true);
drop policy if exists ws_settings_upd on ws_settings;
create policy ws_settings_upd on ws_settings for update to authenticated using (ws_is_admin()) with check (ws_is_admin());

drop policy if exists ws_members_read on ws_members;
create policy ws_members_read on ws_members for select to authenticated using (user_id = (select auth.uid()) or ws_is_admin());
drop policy if exists ws_members_ins on ws_members;
create policy ws_members_ins on ws_members for insert to authenticated with check (ws_is_admin());
drop policy if exists ws_members_upd on ws_members;
create policy ws_members_upd on ws_members for update to authenticated using (ws_is_admin()) with check (ws_is_admin());
drop policy if exists ws_members_del on ws_members;
create policy ws_members_del on ws_members for delete to authenticated using (ws_is_admin());

-- Public wall display sees only what is live right now (open sessions, future bookings).
drop policy if exists ws_sessions_read on ws_sessions;
create policy ws_sessions_read on ws_sessions for select to anon, authenticated
  using (ws_can_view() or (ws_public() and ended_at is null));
drop policy if exists ws_res_read on ws_reservations;
create policy ws_res_read on ws_reservations for select to anon, authenticated
  using (ws_can_view() or (ws_public() and status = 'booked' and ends_at > now()));

-- ---------- actions ----------
create or replace function ws_my_name() returns text language sql stable security definer set search_path = public as
$$ select coalesce(nullif(trim(full_name), ''), username) from profiles where id = (select auth.uid()) $$;

-- lock the station and every station sharing its KVM so concurrent requests are serialised
create or replace function ws_lock_group(p_station int) returns ws_stations
language plpgsql security definer set search_path = public as $$
declare st ws_stations;
begin
  select * into st from ws_stations where id = p_station;
  if not found then raise exception 'Unknown workstation'; end if;
  perform 1 from ws_stations
    where id = p_station or (st.kvm_group is not null and kvm_group = st.kvm_group)
    order by id for update;
  if not st.enabled then raise exception '% is disabled by an admin', st.name; end if;
  return st;
end $$;

create or replace function ws_start_session(p_station int, p_case text, p_desc text, p_reservation uuid default null)
returns ws_sessions language plpgsql security definer set search_path = public as $$
declare st ws_stations; s ws_sessions; who text; busy text; until_ timestamptz; c text := nullif(trim(p_case), '');
begin
  if ws_role() not in ('user','admin') then raise exception 'You do not have permission to use workstations'; end if;
  if c is null then raise exception 'Case number is required'; end if;
  st := ws_lock_group(p_station);

  select x.user_name, t.name into who, busy from ws_sessions x join ws_stations t on t.id = x.station_id
   where x.ended_at is null and (x.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
  if who is not null then
    raise exception '% is already in use by %', busy, who;
  end if;

  select v.user_name, v.ends_at into who, until_ from ws_reservations v join ws_stations t on t.id = v.station_id
   where v.status = 'booked' and v.starts_at <= now() and v.ends_at > now() and v.user_id <> auth.uid()
     and (v.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
  if who is not null then
    raise exception 'Reserved by % until %', who, to_char(until_ at time zone 'UTC', 'HH24:MI "UTC"');
  end if;

  if p_reservation is not null and not exists
     (select 1 from ws_reservations where id = p_reservation and user_id = auth.uid() and station_id = p_station and status = 'booked') then
    p_reservation := null;
  end if;

  insert into ws_sessions (station_id, user_id, user_name, case_number, description, reservation_id)
    values (p_station, auth.uid(), ws_my_name(), c, nullif(trim(p_desc), ''), p_reservation) returning * into s;
  return s;
end $$;

create or replace function ws_update_session(p_id uuid, p_case text, p_desc text)
returns ws_sessions language plpgsql security definer set search_path = public as $$
declare s ws_sessions; c text := nullif(trim(p_case), '');
begin
  if c is null then raise exception 'Case number is required'; end if;
  select * into s from ws_sessions where id = p_id and ended_at is null for update;
  if not found then raise exception 'Session already ended'; end if;
  if s.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your session'; end if;
  update ws_sessions set case_number = c, description = nullif(trim(p_desc), '') where id = p_id returning * into s;
  return s;
end $$;

create or replace function ws_end_session(p_id uuid)
returns ws_sessions language plpgsql security definer set search_path = public as $$
declare s ws_sessions;
begin
  select * into s from ws_sessions where id = p_id and ended_at is null for update;
  if not found then raise exception 'Session already ended'; end if;
  if s.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your session'; end if;
  update ws_sessions set ended_at = now(),
         ended_by = case when s.user_id = auth.uid() then null else ws_my_name() end
   where id = p_id returning * into s;
  if s.reservation_id is not null then
    update ws_reservations set status = 'done' where id = s.reservation_id and status = 'booked';
  end if;
  return s;
end $$;

create or replace function ws_reserve(p_station int, p_start timestamptz, p_end timestamptz, p_case text, p_desc text)
returns ws_reservations language plpgsql security definer set search_path = public as $$
declare st ws_stations; r ws_reservations; who text; clash timestamptz; c text := nullif(trim(p_case), '');
begin
  if ws_role() not in ('user','admin') then raise exception 'You do not have permission to reserve workstations'; end if;
  if c is null then raise exception 'Case number is required'; end if;
  if p_end <= p_start then raise exception 'End time must be after start time'; end if;
  if p_start < now() - interval '5 minutes' then raise exception 'Start time is in the past'; end if;
  if p_start > now() + interval '90 days' then raise exception 'Reservations can be made up to 90 days ahead'; end if;
  if p_end - p_start > interval '12 hours' then raise exception 'A single reservation can be at most 12 hours'; end if;
  st := ws_lock_group(p_station);

  select v.user_name, v.starts_at into who, clash from ws_reservations v join ws_stations t on t.id = v.station_id
   where v.status = 'booked' and tstzrange(v.starts_at, v.ends_at) && tstzrange(p_start, p_end)
     and (v.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group))
   order by v.starts_at limit 1;
  if who is not null then raise exception 'That time overlaps a booking by % (this station or its shared KVM)', who; end if;

  if p_start <= now() then
    select x.user_name into who from ws_sessions x join ws_stations t on t.id = x.station_id
     where x.ended_at is null and x.user_id <> auth.uid()
       and (x.station_id = p_station or (st.kvm_group is not null and t.kvm_group = st.kvm_group)) limit 1;
    if who is not null then raise exception 'Currently in use by %', who; end if;
  end if;

  insert into ws_reservations (station_id, user_id, user_name, starts_at, ends_at, case_number, description)
    values (p_station, auth.uid(), ws_my_name(), p_start, p_end, c, nullif(trim(p_desc), ''))
    returning * into r;
  return r;
end $$;

create or replace function ws_cancel_reservation(p_id uuid)
returns ws_reservations language plpgsql security definer set search_path = public as $$
declare r ws_reservations;
begin
  select * into r from ws_reservations where id = p_id and status = 'booked' for update;
  if not found then raise exception 'Reservation not found'; end if;
  if r.user_id <> auth.uid() and not ws_is_admin() then raise exception 'Not your reservation'; end if;
  update ws_reservations set status = 'cancelled' where id = p_id returning * into r;
  return r;
end $$;

-- ---------- grants ----------
revoke execute on function ws_role(), ws_can_view(), ws_is_admin(), ws_public(), ws_my_name(), ws_lock_group(int),
  ws_start_session(int,text,text,uuid), ws_update_session(uuid,text,text), ws_end_session(uuid),
  ws_reserve(int,timestamptz,timestamptz,text,text), ws_cancel_reservation(uuid) from public, anon, authenticated;
grant execute on function ws_role(), ws_can_view(), ws_is_admin(), ws_public(), ws_my_name(),
  ws_start_session(int,text,text,uuid), ws_update_session(uuid,text,text), ws_end_session(uuid),
  ws_reserve(int,timestamptz,timestamptz,text,text), ws_cancel_reservation(uuid) to authenticated;
grant execute on function ws_can_view(), ws_public() to anon;   -- evaluated inside the anon RLS policies

-- ---------- live updates ----------
do $$ begin
  begin alter publication supabase_realtime add table ws_stations;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table ws_sessions;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table ws_reservations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table ws_members;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table ws_settings;     exception when duplicate_object then null; end;
end $$;
