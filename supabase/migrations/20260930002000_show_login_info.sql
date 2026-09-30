-- Migration: Show current login information for owner
-- This migration displays the current username and email for the owner
-- It does NOT reset the password (that requires service role outside migration)

-- ============================================================
-- STEP 1: Show current owner information
-- ============================================================

DO $$
DECLARE
  v_owner_id UUID;
  v_owner_username TEXT;
  v_owner_email TEXT;
  v_owner_full_name TEXT;
BEGIN
  -- Find the owner
  SELECT p.id, p.username, u.email, p.full_name 
  INTO v_owner_id, v_owner_username, v_owner_email, v_owner_full_name
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE p.role = 'OWNER' AND p.active = true
  LIMIT 1;
  
  IF v_owner_id IS NOT NULL THEN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'OWNER LOGIN INFORMATION';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Username: %', v_owner_username;
    RAISE NOTICE 'Full Name: %', v_owner_full_name;
    RAISE NOTICE 'Email in Supabase Auth: %', v_owner_email;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'HOW TO RESET PASSWORD:';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Option 1: Supabase Dashboard';
    RAISE NOTICE '1. Go to: https://supabase.com/dashboard';
    RAISE NOTICE '2. Select project: xemaycarem';
    RAISE NOTICE '3. Go to Authentication > Users';
    RAISE NOTICE '4. Find user with email: %', v_owner_email;
    RAISE NOTICE '5. Click "Reset Password"';
    RAISE NOTICE '6. Enter new password (min 12 chars)';
    RAISE NOTICE '7. Login with username: %', v_owner_username;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Option 2: SQL Editor (requires service role)';
    RAISE NOTICE 'Run this in Supabase SQL Editor:';
    RAISE NOTICE 'UPDATE auth.users SET encrypted_password = crypt(''yourpassword'', gen_salt(''bf'')) WHERE id = ''%'';', v_owner_id;
    RAISE NOTICE '========================================';
  ELSE
    RAISE NOTICE 'No active owner found!';
  END IF;
END $$;

-- ============================================================
-- STEP 2: Show all users with their email sync status
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'ALL USERS WITH EMAIL STATUS';
  RAISE NOTICE '========================================';
  
  FOR v_record IN 
    SELECT 
      p.username,
      p.full_name,
      p.role,
      p.active,
      u.email as auth_email,
      CASE 
        WHEN u.email = p.username || '@internal.xecrm.app' THEN '✓ SYNCED'
        ELSE '✗ NEEDS SYNC'
      END as email_status
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    ORDER BY 
      CASE p.role WHEN 'OWNER' THEN 1 WHEN 'MANAGER' THEN 2 WHEN 'STAFF' THEN 3 ELSE 4 END,
      p.active DESC,
      p.full_name
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      v_record.username,
      v_record.full_name,
      v_record.role,
      CASE WHEN v_record.active THEN 'ACTIVE' ELSE 'DISABLED' END,
      v_record.email_status;
  END LOOP;
  
  RAISE NOTICE '========================================';
END $$;
