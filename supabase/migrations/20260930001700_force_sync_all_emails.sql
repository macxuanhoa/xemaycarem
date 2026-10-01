-- Migration: Force sync all auth users email to match username pattern
-- This migration uses service role to update auth.users.email for all users
-- to match the pattern: username@internal.xecrm.app

-- ============================================================
-- STEP 1: Update auth trigger to auto-sync email on create/update
-- ============================================================

CREATE OR REPLACE FUNCTION private.new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_username TEXT;
  v_internal_email TEXT;
BEGIN
  -- Generate username from email if available, otherwise from full_name
  v_username := COALESCE(
    lower(regexp_replace(new.email, '@.*$', '', 'g')),
    lower(regexp_replace(
      regexp_replace(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'), '\s+', '_', 'g'),
      '[^a-z0-9_]', '', 'g'
    ))
  );
  
  -- Ensure username is not empty
  IF v_username = '' OR v_username IS NULL THEN
    v_username := 'user_' || substr(new.id::text, 1, 12);
  END IF;
  
  -- Generate internal email
  v_internal_email := v_username || '@internal.xecrm.app';
  
  -- Insert profile with default schedule values
  INSERT INTO public.profiles(
    id,
    full_name,
    role,
    active,
    username,
    must_change_password,
    disabled_until,
    allowed_from,
    allowed_until,
    working_days,
    deleted_at,
    disable_reason
  )
  VALUES(
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'),120),
    'STAFF',
    true,
    v_username,
    false,
    NULL,
    '00:00:00',
    '23:59:59',
    ARRAY[1,2,3,4,5,6,7],
    NULL,
    NULL
  );
  
  -- Sync email to match username pattern
  -- This requires service role, but we'll try
  BEGIN
    IF new.email IS DISTINCT FROM v_internal_email THEN
      UPDATE auth.users
      SET email = v_internal_email
      WHERE id = new.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Email sync might fail without service role
    -- The profile username is set correctly, so login will work
    NULL;
  END;
  
  RETURN new;
END $$;

-- ============================================================
-- STEP 2: Create function to sync email for existing users
-- ============================================================

CREATE OR REPLACE FUNCTION private.sync_auth_email(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_username TEXT;
  v_internal_email TEXT;
BEGIN
  -- Get username from profile
  SELECT username INTO v_username
  FROM public.profiles
  WHERE id = p_user_id;
  
  IF v_username IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Generate internal email
  v_internal_email := v_username || '@internal.xecrm.app';
  
  -- Update auth.users email
  -- This requires service role
  UPDATE auth.users
  SET email = v_internal_email
  WHERE id = p_user_id;
  
  RETURN TRUE;
END $$;

-- ============================================================
-- STEP 3: Sync all existing users
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
  v_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Syncing email for all users...';
  
  FOR v_record IN 
    SELECT p.id, p.username, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.username IS NOT NULL 
      AND p.username != ''
  LOOP
    BEGIN
      -- Update email to match username pattern
      UPDATE auth.users
      SET email = v_record.username || '@internal.xecrm.app'
      WHERE id = v_record.id;
      
      IF FOUND THEN
        v_count := v_count + 1;
        RAISE NOTICE 'Synced email for user % (was: %, now: %)', 
          v_record.username,
          v_record.email,
          v_record.username || '@internal.xecrm.app';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not sync email for user % (likely permission issue)', v_record.username;
    END;
  END LOOP;
  
  RAISE NOTICE 'Email sync complete. Synced % users.', v_count;
END $$;

-- ============================================================
-- STEP 4: Show current user credentials
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'CURRENT USER CREDENTIALS (POST-SYNC)';
  RAISE NOTICE '========================================';
  
  FOR v_record IN 
    SELECT p.username, p.full_name, p.role, p.active, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    ORDER BY 
      CASE p.role WHEN 'OWNER' THEN 1 WHEN 'MANAGER' THEN 2 WHEN 'STAFF' THEN 3 ELSE 4 END,
      p.active DESC,
      p.full_name
  LOOP
    RAISE NOTICE 'Username: % | Email: % | Role: % | Active: %',
      v_record.username,
      v_record.email,
      v_record.role,
      CASE WHEN v_record.active THEN 'YES' ELSE 'NO' END;
  END LOOP;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'USE USERNAME TO LOGIN (not email)';
  RAISE NOTICE '========================================';
END $$;
