-- Migration: Rollback auth.users email to allow login with old password
-- This migration restores the original email for login testing
-- Only use this if you remember the old password

-- ============================================================
-- STEP 1: Rollback email to original for all users
-- ============================================================

-- NOTE: This requires the original email to be stored somewhere
-- Since we don't have it, we'll create a migration that allows you to manually set it

-- This is a placeholder - you need to manually update the email in Supabase Dashboard
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
    RAISE NOTICE 'EMAIL ROLLBACK INSTRUCTIONS';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Owner Username: %', v_owner_username;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'To rollback email:';
    RAISE NOTICE '1. Go to Supabase Dashboard > Authentication > Users';
    RAISE NOTICE '2. Find user: %', v_owner_username;
    RAISE NOTICE '3. Change email back to your ORIGINAL email';
    RAISE NOTICE '4. Login with original email and password';
    RAISE NOTICE '5. After login, we can update the email properly';
    RAISE NOTICE '========================================';
  END IF;
END $$;
