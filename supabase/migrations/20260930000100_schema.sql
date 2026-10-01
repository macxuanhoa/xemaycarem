-- Sensitive amounts are isolated from operational rows: RLS filters rows, not columns.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.user_role as enum ('OWNER','MANAGER','STAFF');
create type public.vehicle_status as enum ('IN_STOCK','RESERVED','SOLD','CANCELLED');
create type public.record_status as enum ('ACTIVE','CANCELLED');
create type public.sale_status as enum ('COMPLETED','CANCELLED');
create type public.payment_method as enum ('CASH','BANK_TRANSFER','OTHER');
create type public.payment_status as enum ('ACTIVE','VOIDED');
create type public.vehicle_expense_type as enum ('REPAIR','TRANSPORT','PAPERWORK','PARTS','CLEANING','INSPECTION','OTHER');
create type public.business_expense_category as enum ('RENT','ELECTRICITY','SALARY','MARKETING','OFFICE','TRANSPORT','OTHER');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  role public.user_role not null default 'STAFF',
  active boolean not null default true,
  can_view_financials boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create sequence private.vehicle_code_seq;
create sequence private.sale_code_seq;
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  internal_code text not null unique default ('XE-' || to_char(now() at time zone 'Asia/Ho_Chi_Minh','YYYY') || '-' || lpad(nextval('private.vehicle_code_seq')::text,6,'0')),
  license_plate text not null default '' check (length(license_plate)<=30),
  brand text not null check (char_length(btrim(brand)) between 1 and 80),
  model text not null check (char_length(btrim(model)) between 1 and 120),
  variant text not null default '' check (length(variant)<=120),
  year integer check (year between 1900 and 2100),
  color text not null default '' check (length(color)<=80),
  frame_number text not null default '' check (length(frame_number)<=100),
  engine_number text not null default '' check (length(engine_number)<=100),
  odometer integer not null default 0 check (odometer between 0 and 10000000),
  purchase_date date not null default (now() at time zone 'Asia/Ho_Chi_Minh')::date,
  asking_price bigint not null check (asking_price between 0 and 1000000000000),
  status public.vehicle_status not null default 'IN_STOCK',
  supplier_name text not null default '' check (length(supplier_name)<=200),
  supplier_phone text not null default '' check (length(supplier_phone)<=40),
  notes text not null default '' check (length(notes)<=10000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.vehicle_financials (
  vehicle_id uuid primary key references public.vehicles(id),
  purchase_price bigint check (purchase_price between 0 and 1000000000000),
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now()
);
create table public.vehicle_expenses (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id),
  expense_type public.vehicle_expense_type not null,
  description text not null check (char_length(btrim(description)) between 1 and 1000),
  amount bigint not null check (amount between 1 and 1000000000000),
  expense_date date not null,
  status public.record_status not null default 'ACTIVE',
  cancellation_reason text check (length(cancellation_reason)<=1000),
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_code text not null unique default ('BH-' || to_char(now() at time zone 'Asia/Ho_Chi_Minh','YYYY') || '-' || lpad(nextval('private.sale_code_seq')::text,6,'0')),
  vehicle_id uuid not null references public.vehicles(id),
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 200),
  customer_phone text not null default '' check (length(customer_phone)<=40),
  sale_price bigint not null check (sale_price between 0 and 1000000000000),
  sale_date date not null,
  sold_by uuid not null references public.profiles(id),
  status public.sale_status not null default 'COMPLETED',
  notes text not null default '' check (length(notes)<=10000),
  cancellation_reason text check (length(cancellation_reason)<=1000),
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_completed_sale_per_vehicle on public.sales(vehicle_id) where status='COMPLETED';
create table public.sale_financials (
  sale_id uuid primary key references public.sales(id),
  purchase_cost_snapshot bigint not null check (purchase_cost_snapshot>=0),
  expense_cost_snapshot bigint not null check (expense_cost_snapshot>=0),
  total_cost_snapshot bigint generated always as (purchase_cost_snapshot+expense_cost_snapshot) stored,
  -- Sale price is duplicated in this immutable snapshot so profit cannot drift.
  sale_price_snapshot bigint not null check (sale_price_snapshot>=0),
  gross_profit bigint generated always as (sale_price_snapshot-purchase_cost_snapshot-expense_cost_snapshot) stored,
  created_at timestamptz not null default now()
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  amount bigint not null check (amount between 1 and 1000000000000),
  payment_method public.payment_method not null,
  payment_date date not null,
  reference text not null default '' check (length(reference)<=200),
  notes text not null default '' check (length(notes)<=2000),
  status public.payment_status not null default 'ACTIVE',
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create table public.business_expenses (
  id uuid primary key default gen_random_uuid(),
  category public.business_expense_category not null,
  description text not null check (char_length(btrim(description)) between 1 and 1000),
  amount bigint not null check (amount between 1 and 1000000000000),
  expense_date date not null,
  status public.record_status not null default 'ACTIVE',
  cancellation_reason text check (length(cancellation_reason)<=1000),
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.vehicle_images (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id),
  storage_path text not null unique check (length(storage_path)<=300),
  display_order integer not null default 0 check (display_order between 0 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);
create table public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create table public.vehicle_activity (
  id bigint generated always as identity primary key,
  vehicle_id uuid not null references public.vehicles(id),
  user_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  created_at timestamptz not null default now()
);
create table public.system_settings (
  id boolean primary key default true check (id),
  store_name text not null default 'Quản Lý Cửa Hàng Xe' check (char_length(btrim(store_name)) between 1 and 200),
  phone text not null default '' check (length(phone)<=40),
  address text not null default '' check (length(address)<=500),
  low_stock_threshold integer not null default 5 check (low_stock_threshold between 0 and 10000),
  high_stock_threshold integer not null default 100 check (high_stock_threshold between 0 and 100000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  check (high_stock_threshold>=low_stock_threshold)
);
insert into public.system_settings(id) values(true);

create index vehicles_status_purchase on public.vehicles(status,purchase_date);
create index vehicles_license_plate on public.vehicles(license_plate);
create index vehicles_frame_number on public.vehicles(frame_number);
create index vehicles_engine_number on public.vehicles(engine_number);
create index vehicles_created_at on public.vehicles(created_at desc);
create index vehicle_expenses_vehicle on public.vehicle_expenses(vehicle_id,status);
create index vehicle_expenses_date on public.vehicle_expenses(expense_date desc);
create index business_expenses_date on public.business_expenses(expense_date desc);
create index sales_date on public.sales(sale_date desc);
create index sales_vehicle on public.sales(vehicle_id);
create index sales_customer_phone on public.sales(customer_phone);
create index payments_sale on public.payments(sale_id);
create index vehicle_images_vehicle on public.vehicle_images(vehicle_id,display_order);
create index audit_entity on public.audit_logs(entity_id);
create index audit_created on public.audit_logs(created_at desc);
create index activity_vehicle on public.vehicle_activity(vehicle_id,created_at desc);

create function private.current_role() returns public.user_role language sql stable security definer set search_path='' as $$
  select role from public.profiles where id=auth.uid() and active
$$;
create function private.is_active() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.profiles where id=auth.uid() and active)
$$;
create function private.can_financials() returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select role='OWNER' or (role='MANAGER' and can_view_financials) from public.profiles where id=auth.uid() and active),false)
$$;
create function private.require_role(p_roles public.user_role[]) returns uuid language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not coalesce(private.current_role()=any(p_roles),false) then
    raise exception using errcode='42501',message='ACCESS_DENIED';
  end if;
  return auth.uid();
end $$;
create function private.today() returns date language sql stable set search_path='' as $$
  select (now() at time zone 'Asia/Ho_Chi_Minh')::date
$$;
create function private.safe_money(p_value numeric) returns bigint language plpgsql immutable set search_path='' as $$
begin
  if p_value is null then return null; end if;
  if p_value != trunc(p_value) or abs(p_value)>9007199254740991 then
    raise exception using errcode='22003',message='MONEY_OUT_OF_RANGE';
  end if;
  return p_value::bigint;
end $$;
create function private.money_input(p_data jsonb,p_key text,p_default bigint default null) returns bigint language plpgsql immutable set search_path='' as $$
declare v_text text := p_data->>p_key; v_value numeric;
begin
  if v_text is null then return p_default; end if;
  if v_text !~ '^[0-9]{1,13}$' then raise exception using errcode='22023',message='INVALID_MONEY'; end if;
  v_value:=v_text::numeric;
  if v_value>1000000000000 then raise exception using errcode='22023',message='INVALID_MONEY'; end if;
  return v_value::bigint;
end $$;
create function private.audit(p_action text,p_type text,p_id uuid,p_old jsonb,p_new jsonb,p_vehicle uuid default null) returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_logs(user_id,action,entity_type,entity_id,old_data,new_data) values(auth.uid(),p_action,p_type,p_id,p_old,p_new);
  if p_vehicle is not null then
    insert into public.vehicle_activity(vehicle_id,user_id,action,entity_type,entity_id) values(p_vehicle,auth.uid(),p_action,p_type,p_id);
  end if;
end $$;
create function private.immutable_history() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='IMMUTABLE_HISTORY'; end $$;
create trigger immutable_audit before update or delete on public.audit_logs for each row execute function private.immutable_history();
create trigger immutable_activity before update or delete on public.vehicle_activity for each row execute function private.immutable_history();
create trigger immutable_sale_snapshot before update or delete on public.sale_financials for each row execute function private.immutable_history();

-- Public signup is disabled in config. Even if enabled accidentally, new accounts
-- default to the lowest operational role (STAFF); user-editable auth metadata never grants OWNER or MANAGER.
create function private.new_auth_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,full_name,role,active)
  values(new.id,left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'),120),'STAFF',true);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.new_auth_user();

alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_financials enable row level security;
alter table public.vehicle_expenses enable row level security;
alter table public.sales enable row level security;
alter table public.sale_financials enable row level security;
alter table public.payments enable row level security;
alter table public.business_expenses enable row level security;
alter table public.vehicle_images enable row level security;
alter table public.audit_logs enable row level security;
alter table public.vehicle_activity enable row level security;
alter table public.system_settings enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (id=auth.uid() or private.current_role()='OWNER');
create policy vehicles_read on public.vehicles for select to authenticated using (private.is_active());
create policy financials_read on public.vehicle_financials for select to authenticated using (private.can_financials());
create policy expenses_read on public.vehicle_expenses for select to authenticated using (private.current_role() in ('OWNER','MANAGER'));
create policy sales_read on public.sales for select to authenticated using (private.is_active());
create policy sale_financials_read on public.sale_financials for select to authenticated using (private.can_financials());
create policy payments_read on public.payments for select to authenticated using (private.is_active());
create policy business_expenses_read on public.business_expenses for select to authenticated using (private.current_role() in ('OWNER','MANAGER'));
create policy images_read on public.vehicle_images for select to authenticated using (private.is_active() and deleted_at is null);
create policy audit_read on public.audit_logs for select to authenticated using (private.current_role()='OWNER');
create policy activity_read on public.vehicle_activity for select to authenticated using (private.is_active());
create policy settings_read on public.system_settings for select to authenticated using (private.is_active());

revoke all on public.profiles,public.vehicles,public.vehicle_financials,public.vehicle_expenses,public.sales,public.sale_financials,public.payments,public.business_expenses,public.vehicle_images,public.audit_logs,public.vehicle_activity,public.system_settings from public,anon,authenticated;
grant select on public.profiles,public.vehicles,public.vehicle_financials,public.vehicle_expenses,public.sales,public.sale_financials,public.payments,public.business_expenses,public.vehicle_images,public.audit_logs,public.vehicle_activity,public.system_settings to authenticated;
revoke all on sequence public.audit_logs_id_seq,public.vehicle_activity_id_seq from public,anon,authenticated;
revoke all on all functions in schema private from public,anon,authenticated;
grant execute on function private.current_role(),private.is_active(),private.can_financials() to authenticated;
-- Explicit RPC grants are made after all definitions in the next migration.
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges in schema private revoke execute on functions from public,anon,authenticated;
