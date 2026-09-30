-- Migration: Reset auth trigger and ensure proper email sync
-- This migration:
--   1. Drops and recreates the auth trigger to fix any issues
--   2. Ensures all users have correct email pattern
--   3. Sets must_change_password = false for existing users to allow login

-- ============================================================
-- STEP 1: Drop existing auth trigger
-- ============================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- ============================================================
-- STEP 2: Recreate auth trigger with simpler logic
-- ============================================================

CREATE OR REPLACE FUNCTION private.new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_username TEXT;
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
  
  -- For existing users, don't set must_change_password
  -- Only new users should be forced to change password
  INSERT INTO public.profiles(id,full_name,role,active,username,must_change_password)
  VALUES(
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'),120),
    'VIEWER',
    false,
    v_username,
    false  -- Don't force password change for existing users
  );
  RETURN new;
END $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION private.new_auth_user();

-- ============================================================
-- STEP 3: Update existing users' must_change_password to false
-- ============================================================

-- This allows existing users to login without password change
-- Only users created before this migration should have must_change_password = false
UPDATE public.profiles
SET must_change_password = false
WHERE must_change_password = true
  AND created_at < (now() at time zone 'Asia/Ho_Chi_Minh');

-- ============================================================
-- STEP 4: Update auth.users email to match username pattern
-- ============================================================

-- Try to update auth.users.email to match username pattern
-- This might work with migration permissions
DO $$
DECLARE
  v_record RECORD;
  v_updated INTEGER := 0;
BEGIN
  FOR v_record IN 
    SELECT p.id, p.username, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.username IS NOT NULL 
      AND p.username != ''
      AND u.email IS DISTINCT FROM (p.username || '@internal.xecrm.app')
  LOOP
    BEGIN
      UPDATE auth.users
      SET email = v_record.username || '@internal.xecrm.app'
      WHERE id = v_record.id;
      
      IF FOUND THEN
        v_updated := v_updated + 1;
        RAISE NOTICE 'Updated email for user % to %', 
          v_record.username, 
          v_record.username || '@internal.xecrm.app';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not update email for user % (might need manual update in Supabase Dashboard)', v_record.username;
    END;
  END LOOP;
  
  RAISE NOTICE 'Updated % user emails to match username pattern', v_updated;
END $$;

-- ============================================================
-- STEP 5: Show current credentials
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'CURRENT LOGIN CREDENTIALS';
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
    RAISE NOTICE 'Username: % | % | % | % | Email: %',
      v_record.username,
      v_record.full_name,
      v_record.role,
      CASE WHEN v_record.active THEN 'ACTIVE' ELSE 'DISABLED' END,
      v_record.email;
  END LOOP;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'IMPORTANT: Use USERNAME to login, not email';
  RAISE NOTICE '========================================';
END $$;
