-- Migration: Add username-based authentication
-- This migration:
--   1. Adds username field to profiles (business identity for login)
--   2. Adds must_change_password field for temporary password flow
--   3. Generates usernames for existing users
--   4. Updates auth trigger to support username-based auth

-- ============================================================
-- STEP 1: Add username and must_change_password to profiles
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN username TEXT,
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Add unique constraint for username
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_unique UNIQUE (username);

-- Add check constraint for username format (lowercase, 3-30 chars, letters/numbers/underscore/dot)
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format CHECK (
    username IS NULL OR (
      length(username) BETWEEN 3 AND 30 AND
      username ~ '^[a-z0-9_.]+$'
    )
  );

-- ============================================================
-- STEP 2: Generate usernames for existing users
-- ============================================================

-- For existing users, generate username from email (before @) or from full_name
-- Normalize to lowercase and replace spaces with underscores
UPDATE public.profiles
SET username = CASE
  -- Try to extract from email if auth.users has email
  WHEN EXISTS (
    SELECT 1 FROM auth.users WHERE auth.users.id = profiles.id AND auth.users.email IS NOT NULL
  ) THEN
    lower(regexp_replace(
      (SELECT email FROM auth.users WHERE auth.users.id = profiles.id),
      '@.*$', '', 'g'
    ))
  -- Otherwise generate from full_name
  ELSE
    lower(regexp_replace(
      regexp_replace(full_name, '\s+', '_', 'g'),
      '[^a-z0-9_]', '', 'g'
    ))
END
WHERE username IS NULL;

-- Handle duplicate usernames by appending a number
DO $$
DECLARE
  v_username TEXT;
  v_count INTEGER;
BEGIN
  FOR v_username IN SELECT DISTINCT username FROM public.profiles WHERE username IS NOT NULL LOOP
    v_count := 1;
    FOR i IN 2..100 LOOP
      IF (SELECT COUNT(*) FROM public.profiles WHERE username = v_username) > 1 THEN
        UPDATE public.profiles
        SET username = v_username || i::text
        WHERE id = (
          SELECT id FROM public.profiles
          WHERE username = v_username
          LIMIT 1 OFFSET (i - 2)
        );
      ELSE
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ============================================================
-- STEP 3: Make username NOT NULL after backfill
-- ============================================================

-- For any remaining NULL usernames, generate a fallback
UPDATE public.profiles
SET username = 'user_' || substr(id::text, 1, 8)
WHERE username IS NULL;

ALTER TABLE public.profiles
  ALTER COLUMN username SET NOT NULL;

-- ============================================================
-- STEP 4: Update auth trigger to set default username
-- ============================================================

CREATE OR REPLACE FUNCTION private.new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO public.profiles(id,full_name,role,active,username,must_change_password)
  VALUES(
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'),120),
    'STAFF',
    true,
    -- Generate username from email if available, otherwise from full_name
    coalesce(
      lower(regexp_replace(new.email, '@.*$', '', 'g')),
      lower(regexp_replace(
        regexp_replace(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'), '\s+', '_', 'g'),
        '[^a-z0-9_]', '', 'g'
      ))
    ),
    true  -- New users must change password on first login
  );
  RETURN new;
END $$;

-- ============================================================
-- STEP 5: Update update_profile to handle username changes (OWNER only)
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_profile(p_id uuid,p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.profiles; v_new public.profiles; v_role public.user_role; v_active boolean; v_fin boolean;
  v_username text;
BEGIN
  -- Serialize all role/status transitions so simultaneous demotions cannot remove every owner.
  perform pg_advisory_xact_lock(761482190);
  select * into v_old from public.profiles where id=p_id for update;
  if not found then raise exception using errcode='P0002',message='PROFILE_NOT_FOUND'; end if;
  if private.current_role()<>'OWNER' then
    if p_id<>v_actor or exists(select 1 from jsonb_object_keys(p_data) k where k not in ('full_name')) then raise exception using errcode='42501',message='ACCESS_DENIED'; end if;
  end if;
  v_role:=coalesce((p_data->>'role')::public.user_role,v_old.role);
  v_active:=coalesce((p_data->>'active')::boolean,v_old.active);
  v_fin:=coalesce((p_data->>'can_view_financials')::boolean,v_old.can_view_financials);
  v_username:=coalesce(p_data->>'username',v_old.username);
  
  -- Only OWNER can change username, and only if it doesn't conflict
  if v_username<>v_old.username then
    if private.current_role()<>'OWNER' then raise exception using errcode='42501',message='ACCESS_DENIED'; end if;
    if exists(select 1 from public.profiles where username=v_username and id<>p_id) then
      raise exception using errcode='23505',message='USERNAME_EXISTS';
    end if;
  end if;
  
  if v_old.role='OWNER' and v_old.active and (v_role<>'OWNER' or not v_active) and not exists(select 1 from public.profiles where role='OWNER' and active and id<>p_id) then
    raise exception using errcode='22023',message='LAST_OWNER_REQUIRED';
  end if;
  update public.profiles set 
    full_name=btrim(coalesce(p_data->>'full_name',full_name)),
    role=v_role,
    active=v_active,
    can_view_financials=v_fin,
    username=v_username,
    must_change_password=coalesce((p_data->>'must_change_password')::boolean,v_old.must_change_password),
    updated_at=now()
  where id=p_id returning * into v_new;
  perform private.audit(case when v_old.active and not v_new.active then 'DISABLE_USER' else 'UPDATE_USER' end,'profiles',p_id,to_jsonb(v_old),to_jsonb(v_new));
END $$;

-- ============================================================
-- STEP 6: Update list_profiles to include username
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_profiles() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=private.require_role(array['OWNER']::public.user_role[]); v_result jsonb;
BEGIN
  select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('email',u.email) order by p.created_at),'[]'::jsonb) into v_result
  from public.profiles p join auth.users u on u.id=p.id;
  return v_result;
END $$;
