-- Migration: Create function for direct password reset (no email required)
-- This migration creates a function that allows direct password reset
-- without sending email. Useful for internal systems with fake emails.

-- ============================================================
-- STEP 1: Create function to reset password directly
-- ============================================================

CREATE OR REPLACE FUNCTION private.reset_password_direct(p_user_id UUID, p_new_password TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Reset password directly in auth.users
  -- This requires service role
  UPDATE auth.users
  SET encrypted_password = crypt(p_new_password, gen_salt('bf'))
  WHERE id = p_user_id;
  
  -- Set must_change_password to true
  UPDATE public.profiles
  SET must_change_password = true
  WHERE id = p_user_id;
  
  RETURN FOUND;
END $$;

-- ============================================================
-- STEP 2: Grant execute permission (will be called from Edge Function)
-- ============================================================

GRANT EXECUTE ON FUNCTION private.reset_password_direct TO authenticated;

-- ============================================================
-- STEP 3: Create view to show user credentials for debugging
-- ============================================================

CREATE OR REPLACE VIEW private.user_credentials AS
SELECT 
  p.id,
  p.username,
  p.full_name,
  p.role,
  p.active,
  u.email as auth_email,
  CASE 
    WHEN u.email = p.username || '@internal.xecrm.app' THEN 'SYNCED'
    ELSE 'NEEDS_SYNC'
  END as email_status
FROM public.profiles p
JOIN auth.users u ON u.id = p.id;

-- ============================================================
-- STEP 4: Show current status
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'USER CREDENTIALS STATUS';
  RAISE NOTICE '========================================';
  
  FOR v_record IN 
    SELECT * FROM private.user_credentials
    ORDER BY 
      CASE role WHEN 'OWNER' THEN 1 WHEN 'MANAGER' THEN 2 WHEN 'STAFF' THEN 3 ELSE 4 END,
      active DESC,
      full_name
  LOOP
    RAISE NOTICE 'Username: % | Email: % | Status: % | Active: %',
      v_record.username,
      v_record.auth_email,
      v_record.email_status,
      CASE WHEN v_record.active THEN 'YES' ELSE 'NO' END;
  END LOOP;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Use Edge Function to reset password without email';
  RAISE NOTICE '========================================';
END $$;
