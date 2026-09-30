insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('vehicle-images','vehicle-images',false,8388608,array['image/jpeg','image/png','image/webp','image/avif'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create function private.can_upload_vehicle_image(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(private.current_role() in ('OWNER','MANAGER','STAFF'),false)
    and p_path ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp|avif)$'
    and exists(select 1 from public.vehicles where id::text=split_part(p_path,'/',1)
      and (private.current_role() in ('OWNER','MANAGER') or status in ('IN_STOCK','RESERVED')))
$$;
create function private.can_read_vehicle_image(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.is_active() and exists(select 1 from public.vehicle_images where storage_path=p_path and deleted_at is null)
$$;

create policy vehicle_image_upload on storage.objects for insert to authenticated
  with check(bucket_id='vehicle-images' and private.can_upload_vehicle_image(name));
create policy vehicle_image_read on storage.objects for select to authenticated
  using(bucket_id='vehicle-images' and private.can_read_vehicle_image(name));
-- No browser UPDATE or DELETE policy: replacement uploads receive a fresh path.
-- Business records and private objects are retained for administrative retention.

create function public.register_vehicle_image(p_vehicle_id uuid,p_storage_path text,p_display_order integer default 0) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_image public.vehicle_images;
begin
  perform 1 from public.vehicles where id=p_vehicle_id for update;
  if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
  if split_part(p_storage_path,'/',1)<>p_vehicle_id::text or not private.can_upload_vehicle_image(p_storage_path) then
    raise exception using errcode='42501',message='INVALID_IMAGE_PATH';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='vehicle-images' and name=p_storage_path) then
    raise exception using errcode='22023',message='IMAGE_UPLOAD_REQUIRED';
  end if;
  if (select count(*) from public.vehicle_images where vehicle_id=p_vehicle_id and deleted_at is null)>=20 then raise exception using errcode='22023',message='IMAGE_LIMIT_REACHED'; end if;
  insert into public.vehicle_images(vehicle_id,storage_path,display_order,created_by) values(p_vehicle_id,p_storage_path,p_display_order,v_actor) returning * into v_image;
  perform private.audit('ADD_IMAGE','vehicle_images',v_image.id,null,to_jsonb(v_image),p_vehicle_id);
  return v_image.id;
end $$;

create function public.remove_vehicle_image(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_image public.vehicle_images; v_new public.vehicle_images; v_vehicle uuid;
begin
  select vehicle_id into v_vehicle from public.vehicle_images where id=p_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='IMAGE_NOT_FOUND'; end if;
  perform 1 from public.vehicles where id=v_vehicle for update;
  select * into v_image from public.vehicle_images where id=p_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='IMAGE_NOT_FOUND'; end if;
  if private.current_role()='STAFF' and (v_image.created_by<>v_actor or not private.can_upload_vehicle_image(v_image.storage_path)) then
    raise exception using errcode='42501',message='ACCESS_DENIED';
  end if;
  update public.vehicle_images set deleted_at=now(),deleted_by=v_actor where id=p_id returning * into v_new;
  perform private.audit('REMOVE_IMAGE','vehicle_images',p_id,to_jsonb(v_image),to_jsonb(v_new),v_vehicle);
end $$;

revoke all on all functions in schema private from public,anon,authenticated;
grant execute on function private.current_role(),private.is_active(),private.can_financials(),private.can_upload_vehicle_image(text),private.can_read_vehicle_image(text) to authenticated;

do $$
declare v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array[
      'save_vehicle','save_expense','cancel_expense','sell_vehicle','add_payment','cancel_sale','update_profile','save_settings',
      'list_vehicles','get_vehicle','list_sales','get_sale','list_expenses','dashboard','report','list_profiles','get_settings','list_audit','register_vehicle_image','remove_vehicle_image'])
  loop
    execute format('revoke all on function %s from public, anon, authenticated',v_function.signature);
    execute format('grant execute on function %s to authenticated',v_function.signature);
  end loop;
end $$;
