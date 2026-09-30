-- Migration: Display owner username for login troubleshooting
-- This migration shows the owner's username so they can login

-- Select and display owner information
DO $$
DECLARE
  v_owner_id UUID;
  v_owner_username TEXT;
  v_owner_email TEXT;
  v_owner_full_name TEXT;
BEGIN
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
    RAISE NOTICE 'Internal Email: %', v_owner_email;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Use this username to login: %', v_owner_username;
    RAISE NOTICE '========================================';
  ELSE
    RAISE NOTICE 'No active owner found in the system!';
  END IF;
END $$;
