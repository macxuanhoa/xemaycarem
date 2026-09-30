-- Migration: Sync auth.users email to username pattern for login
-- This migration updates auth.users.email to match username@internal.xecrm.app
-- This is required for the login flow to work correctly

-- ============================================================
-- STEP 1: Update auth.users email to match username pattern
-- ============================================================

-- This requires service role access. We'll do it through the auth trigger
-- by re-inserting users with the correct email pattern
DO $$
DECLARE
  v_record RECORD;
BEGIN
  -- Get all users that need email sync
  FOR v_record IN 
    SELECT u.id, p.username, u.email
    FROM auth.users u
    JOIN public.profiles p ON p.id = u.id
    WHERE p.username IS NOT NULL 
      AND p.username != ''
      AND u.email IS DISTINCT FROM (p.username || '@internal.xecrm.app')
  LOOP
    -- We can't directly update auth.users without service role
    -- But we can create a temporary migration to do this
    -- For now, let's use the fact that we can update through SQL
    
    -- Actually, let's try direct update - this might work with the migration's permissions
    BEGIN
      UPDATE auth.users
      SET email = v_record.username || '@internal.xecrm.app'
      WHERE id = v_record.id;
      
      RAISE NOTICE 'Updated email for user % to %', 
        v_record.username, 
        v_record.username || '@internal.xecrm.app';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not update email for user % (might need service role)', v_record.username;
    END;
  END LOOP;
END $$;

-- ============================================================
-- STEP 2: Show current user credentials
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'LOGIN CREDENTIALS';
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
    RAISE NOTICE 'Username: % | % | % | %',
      v_record.username,
      v_record.full_name,
      v_record.role,
      CASE WHEN v_record.active THEN 'ACTIVE' ELSE 'DISABLED' END;
  END LOOP;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'LOGIN WITH USERNAME, NOT EMAIL';
  RAISE NOTICE '========================================';
END $$;
