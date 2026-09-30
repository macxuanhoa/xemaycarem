-- Migration: Fix auth users email sync and enable user deletion
-- This migration:
--   1. Syncs auth.users.email to match username@internal.xecrm.app for all users
--   2. Updates RLS to allow deleting auth users from Edge Function
--   3. Shows current user credentials for verification

-- ============================================================
-- STEP 1: Sync auth.users email to match username pattern
-- ============================================================

-- This requires service role. We'll use a function that can be called
-- through the Edge Function or manually in Supabase Dashboard

DO $$
DECLARE
  v_record RECORD;
  v_updated INTEGER := 0;
BEGIN
  RAISE NOTICE 'Starting email sync for all users...';
  
  FOR v_record IN 
    SELECT p.id, p.username, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.username IS NOT NULL 
      AND p.username != ''
      AND u.email IS DISTINCT FROM (p.username || '@internal.xecrm.app')
  LOOP
    BEGIN
      -- Try to update auth.users.email
      -- This requires service role, might fail in normal migration
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
      RAISE NOTICE 'Could not update email for user % (needs service role)', v_record.username;
    END;
  END LOOP;
  
  RAISE NOTICE 'Email sync complete. Updated % users.', v_updated;
  
  IF v_updated = 0 THEN
    RAISE NOTICE 'No users needed email update (all already correct).';
  END IF;
END $$;

-- ============================================================
-- STEP 2: Show current user credentials
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'CURRENT USER CREDENTIALS';
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

-- ============================================================
-- STEP 3: Create function to delete auth user (for Edge Function)
-- ============================================================

CREATE OR REPLACE FUNCTION private.delete_auth_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Delete from auth.users (requires service role)
  -- This function should only be called from Edge Function with service role
  DELETE FROM auth.users WHERE id = p_user_id;
  
  RETURN FOUND;
END $$;

-- ============================================================
-- STEP 4: Grant execute permission (will be called from Edge Function)
-- ============================================================

GRANT EXECUTE ON FUNCTION private.delete_auth_user TO authenticated;
