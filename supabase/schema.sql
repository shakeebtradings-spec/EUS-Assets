-- EUS Assets – database schema. Run once in Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;

create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  location text,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  full_name text,
  role text not null default 'staff' check (role in ('admin','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  tag text unique not null,                 -- the barcode value
  name text not null,
  category text,
  notes text,
  store_id uuid not null references stores on delete restrict,
  status text not null default 'in_store' check (status in ('in_store','checked_out','maintenance','retired')),
  holder_id uuid references profiles on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists assets_store_idx on assets (store_id);
create index if not exists assets_status_idx on assets (status);
create index if not exists assets_holder_idx on assets (holder_id);
create index if not exists assets_name_idx on assets (lower(name));

create table if not exists movements (
  id bigint generated always as identity primary key,
  asset_id uuid not null references assets on delete cascade,
  store_id uuid references stores on delete set null,
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  action text not null check (action in ('check_in','check_out')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists movements_created_idx on movements (created_at desc);
create index if not exists movements_asset_idx on movements (asset_id, created_at desc);
create index if not exists movements_store_idx on movements (store_id);
create index if not exists movements_user_idx on movements (user_id, created_at desc);

-- Create a profile for every new account. The first account (while no active admin exists) becomes admin.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username, full_name, role)
  values (
    new.id,
    lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1))),
    new.raw_user_meta_data->>'full_name',
    case when exists (select 1 from profiles where role='admin' and active) then 'staff' else 'admin' end
  );
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create or replace function is_active() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select active from profiles where id = (select auth.uid())), false) $$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'admin' and active from profiles where id = (select auth.uid())), false) $$;

create or replace function touch_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists assets_touch on assets;
create trigger assets_touch before update on assets for each row execute function touch_updated_at();

-- Check an asset in or out atomically (one call per scan).
create or replace function scan_asset(p_tag text, p_action text, p_store uuid default null, p_note text default null)
returns assets language plpgsql security definer set search_path = public as $$
declare a assets; holder text; sname text;
begin
  if not is_active() then raise exception 'Account is disabled'; end if;
  select * into a from assets where tag = p_tag for update;
  if not found then raise exception 'NOT_FOUND: no asset with barcode %', p_tag; end if;
  if a.status in ('maintenance','retired') then
    raise exception 'Asset is % and cannot be moved', a.status;
  end if;
  if p_action = 'check_out' then
    if a.status = 'checked_out' then
      select coalesce(full_name, username) into holder from profiles where id = a.holder_id;
      raise exception 'Already checked out by %', coalesce(holder,'someone');
    end if;
    update assets set status='checked_out', holder_id=auth.uid() where id=a.id returning * into a;
  elsif p_action = 'check_in' then
    -- Already sitting in the selected store: nothing to do.
    if a.status = 'in_store' and a.store_id = coalesce(p_store, a.store_id) then
      select name into sname from stores where id = a.store_id;
      raise exception 'Already in %', coalesce(sname, 'store');
    end if;
    -- Otherwise (returned from a person, or moved from another store): put it in the selected store.
    update assets set status='in_store', holder_id=null, store_id=coalesce(p_store, a.store_id)
      where id=a.id returning * into a;
  else
    raise exception 'Invalid action';
  end if;
  insert into movements (asset_id, store_id, user_id, action, note)
    values (a.id, coalesce(p_store, a.store_id), auth.uid(), p_action, p_note);
  return a;
end $$;
grant execute on function scan_asset(text,text,uuid,text) to authenticated;

-- Row level security
alter table stores enable row level security;
alter table profiles enable row level security;
alter table assets enable row level security;
alter table movements enable row level security;

drop policy if exists stores_write on stores; drop policy if exists assets_write on assets;
drop policy if exists stores_ins on stores; drop policy if exists stores_upd on stores; drop policy if exists stores_del on stores;
drop policy if exists assets_ins on assets; drop policy if exists assets_upd on assets; drop policy if exists assets_del on assets;
drop policy if exists stores_read on stores;   create policy stores_read on stores for select to authenticated using (is_active());
create policy stores_ins on stores for insert to authenticated with check (is_admin());
create policy stores_upd on stores for update to authenticated using (is_admin()) with check (is_admin());
create policy stores_del on stores for delete to authenticated using (is_admin());

drop policy if exists profiles_read on profiles;   create policy profiles_read on profiles for select to authenticated using (is_active() or id = auth.uid());
drop policy if exists profiles_admin on profiles;  create policy profiles_admin on profiles for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists assets_read on assets;   create policy assets_read on assets for select to authenticated using (is_active());
create policy assets_ins on assets for insert to authenticated with check (is_admin());
create policy assets_upd on assets for update to authenticated using (is_admin()) with check (is_admin());
create policy assets_del on assets for delete to authenticated using (is_admin());

drop policy if exists movements_read on movements; create policy movements_read on movements for select to authenticated using (is_active());
-- no insert policy: movements are only written by scan_asset()

-- Live updates
do $$ begin
  begin alter publication supabase_realtime add table assets; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table movements; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table profiles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table stores; exception when duplicate_object then null; end;
end $$;

insert into stores (name) values ('Main Store') on conflict do nothing;

-- Lock down who can call helper functions
revoke execute on function scan_asset(text,text,uuid,text) from public, anon;
revoke execute on function handle_new_user() from public, anon, authenticated;
revoke execute on function is_active() from public, anon;
revoke execute on function is_admin() from public, anon;
grant execute on function is_active(), is_admin() to authenticated;

-- No email confirmation: mark every new account confirmed.
create or replace function auto_confirm_user() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin new.email_confirmed_at := coalesce(new.email_confirmed_at, now()); return new; end $$;
revoke execute on function auto_confirm_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_autoconfirm on auth.users;
create trigger on_auth_user_autoconfirm before insert on auth.users
  for each row execute function auto_confirm_user();
