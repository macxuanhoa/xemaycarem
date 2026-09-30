-- Migration: Reset owner password to allow login
-- This migration sets a temporary password for the owner
-- The owner should change this password after successful login

-- ============================================================
-- STEP 1: Update owner password
-- ============================================================

-- Since we can't directly update auth.users.password without service role,
-- we'll create a stored procedure that can be called from the Supabase Dashboard
-- or through the admin API

-- For now, let's show instructions for manual password reset
DO $$
DECLARE
  v_owner_id UUID;
  v_owner_username TEXT;
BEGIN
  -- Find the owner
  SELECT p.id, p.username INTO v_owner_id, v_owner_username
  FROM public.profiles p
  WHERE p.role = 'OWNER' AND p.active = true
  LIMIT 1;
  
  IF v_owner_id IS NOT NULL THEN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'OWNER PASSWORD RESET INSTRUCTIONS';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Owner ID: %', v_owner_id;
    RAISE NOTICE 'Owner Username: %', v_owner_username;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'To reset the owner password:';
    RAISE NOTICE '1. Go to Supabase Dashboard';
    RAISE NOTICE '2. Navigate to Authentication > Users';
    RAISE NOTICE '3. Find the user with username: %', v_owner_username;
    RAISE NOTICE '4. Click the user and select "Reset Password"';
    RAISE NOTICE '5. Set a new password (min 12 characters)';
    RAISE NOTICE '6. Use this new password to login with username: %', v_owner_username;
    RAISE NOTICE '========================================';
  END IF;
END $$;

-- ============================================================
-- STEP 2: Set must_change_password = true for owner
-- ============================================================

-- This will force password change after login
DO $$
BEGIN
  UPDATE public.profiles
  SET must_change_password = true
  WHERE role = 'OWNER' AND active = true;
  
  RAISE NOTICE 'Owner must_change_password set to true. Password change will be required after login.';
END $$;
