-- Migration: Ensure existing owner can login with username
-- This migration:
--   1. Checks if owner profile has a valid username
--   2. If not, generates a simple username based on their email or UUID
--   3. Ensures all profiles have valid usernames for login

-- ============================================================
-- STEP 1: Find and fix owner username
-- ============================================================

-- Check if owner has a username
DO $$
DECLARE
  v_owner_id UUID;
  v_owner_email TEXT;
  v_owner_username TEXT;
  v_new_username TEXT;
BEGIN
  -- Find the first active owner
  SELECT p.id, u.email, p.username INTO v_owner_id, v_owner_email, v_owner_username
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE p.role = 'OWNER' AND p.active = true
  LIMIT 1;
  
  IF v_owner_id IS NOT NULL THEN
    -- If username is NULL or invalid, generate from email
    IF v_owner_username IS NULL OR v_owner_username = '' OR v_owner_username !~ '^[a-z0-9_]+$' THEN
      v_new_username := lower(regexp_replace(v_owner_email, '@.*$', '', 'g'));
      v_new_username := regexp_replace(v_new_username, '[^a-z0-9_]', '_', 'g');
      
      -- If still empty, use owner_ prefix
      IF v_new_username = '' OR v_new_username IS NULL THEN
        v_new_username := 'owner_' || substr(v_owner_id::text, 1, 8);
      END IF;
      
      -- Update the profile
      UPDATE public.profiles
      SET username = v_new_username
      WHERE id = v_owner_id;
      
      RAISE NOTICE 'Updated owner username to: %', v_new_username;
    END IF;
  END IF;
END $$;

-- ============================================================
-- STEP 2: Ensure all profiles have valid usernames
-- ============================================================

-- For any profiles without valid usernames, generate from UUID
UPDATE public.profiles
SET username = 'user_' || substr(id::text, 1, 12)
WHERE username IS NULL 
   OR username = '' 
   OR username !~ '^[a-z0-9_]+$';

-- ============================================================
-- STEP 3: Handle any remaining username duplicates
-- ============================================================

DO $$
DECLARE
  v_username TEXT;
  v_count INTEGER;
BEGIN
  FOR v_username IN SELECT DISTINCT username FROM public.profiles WHERE username IS NOT NULL AND username != '' LOOP
    v_count := 1;
    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username || CASE WHEN v_count > 1 THEN v_count::text ELSE '' END) LOOP
      v_count := v_count + 1;
      IF v_count > 100 THEN
        UPDATE public.profiles
        SET username = 'user_' || substr(id::text, 1, 12)
        WHERE username = v_username || CASE WHEN v_count > 1 THEN (v_count - 1)::text ELSE '' END;
        EXIT;
      END IF;
    END LOOP;
    
    IF v_count > 1 THEN
      UPDATE public.profiles
      SET username = v_username || (v_count - 1)::text
      WHERE id = (
        SELECT id FROM public.profiles
        WHERE username = v_username
        LIMIT 1 OFFSET (v_count - 2)
      );
    END IF;
  END LOOP;
END $$;
