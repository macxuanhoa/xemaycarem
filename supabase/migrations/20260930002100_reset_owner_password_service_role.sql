-- Migration: Reset owner password using a stored procedure
-- This migration creates a procedure that can be called to reset password
-- It requires service role but can be triggered by setting a flag

-- ============================================================
-- STEP 1: Create a table to signal password reset request
-- ============================================================

CREATE TABLE IF NOT EXISTS private.password_reset_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  new_password TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  processed BOOLEAN DEFAULT false
);

-- ============================================================
-- STEP 2: Create function to process password reset requests
-- ============================================================

CREATE OR REPLACE FUNCTION private.process_password_reset()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_request RECORD;
  v_user_id UUID;
  v_count INTEGER := 0;
BEGIN
  -- Find unprocessed requests
  FOR v_request IN 
    SELECT id, username, new_password
    FROM private.password_reset_requests
    WHERE processed = false
    LIMIT 1
  LOOP
    -- Find user by username
    SELECT id INTO v_user_id
    FROM public.profiles
    WHERE username = v_request.username
    LIMIT 1;
    
    IF v_user_id IS NOT NULL THEN
      -- Reset password using direct SQL (requires service role)
      -- This might fail without service role, but we try
      BEGIN
        UPDATE auth.users
        SET encrypted_password = crypt(v_request.new_password, gen_salt('bf'))
        WHERE id = v_user_id;
        
        -- Set must_change_password to true
        UPDATE public.profiles
        SET must_change_password = true
        WHERE id = v_user_id;
        
        -- Mark as processed
        UPDATE private.password_reset_requests
        SET processed = true
        WHERE id = v_request.id;
        
        v_count := v_count + 1;
        
        RAISE NOTICE 'Password reset for user: %', v_request.username;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not reset password for user % (requires service role)', v_request.username;
        -- Mark as processed anyway to avoid infinite loop
        UPDATE private.password_reset_requests
        SET processed = true
        WHERE id = v_request.id;
      END;
    END IF;
  END LOOP;
  
  RETURN v_count;
END $$;

-- ============================================================
-- STEP 3: Insert password reset request for owner
-- ============================================================

DO $$
DECLARE
  v_owner_username TEXT;
BEGIN
  -- Find owner username
  SELECT username INTO v_owner_username
  FROM public.profiles
  WHERE role = 'OWNER' AND active = true
  LIMIT 1;
  
  IF v_owner_username IS NOT NULL THEN
    -- Insert reset request with default password
    INSERT INTO private.password_reset_requests (username, new_password)
    VALUES (v_owner_username, 'password123456789');
    
    RAISE NOTICE '========================================';
    RAISE NOTICE 'PASSWORD RESET REQUEST CREATED';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Username: %', v_owner_username;
    RAISE NOTICE 'New Password: password123456789';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'To complete the reset:';
    RAISE NOTICE '1. Go to Supabase Dashboard';
    RAISE NOTICE '2. Go to SQL Editor';
    RAISE NOTICE '3. Run: SELECT private.process_password_reset();';
    RAISE NOTICE '4. Login with username: %', v_owner_username;
    RAISE NOTICE '5. Password: password123456789';
    RAISE NOTICE '========================================';
  END IF;
END $$;

-- ============================================================
-- STEP 4: Show current owner info
-- ============================================================

DO $$
DECLARE
  v_record RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'CURRENT OWNER INFO';
  RAISE NOTICE '========================================';
  
  FOR v_record IN 
    SELECT p.username, p.full_name, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.role = 'OWNER' AND p.active = true
  LOOP
    RAISE NOTICE 'Username: %', v_record.username;
    RAISE NOTICE 'Full Name: %', v_record.full_name;
    RAISE NOTICE 'Email: %', v_record.email;
  END LOOP;
  
  RAISE NOTICE '========================================';
END $$;
