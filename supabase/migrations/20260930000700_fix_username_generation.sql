-- Migration: Fix username generation and ensure existing users can login
-- This migration:
--   1. Simplifies username generation to avoid conflicts
--   2. Ensures all profiles have valid usernames
--   3. Makes username check more lenient during transition

-- ============================================================
-- STEP 1: Drop the strict username constraint temporarily
-- ============================================================

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_format;

-- ============================================================
-- STEP 2: Ensure all profiles have usernames (more lenient backfill)
-- ============================================================

-- For profiles without username, generate from email or full_name
UPDATE public.profiles
SET username = CASE
  -- Try to extract from auth.users email if available
  WHEN username IS NULL OR username = '' THEN
    COALESCE(
      -- Try to get email from auth.users
      (SELECT email FROM auth.users WHERE auth.users.id = profiles.id LIMIT 1),
      -- Otherwise generate from full_name
      'user_' || substr(id::text, 1, 8)
    )
  ELSE username
END
WHERE username IS NULL OR username = '';

-- Normalize all usernames to lowercase and remove special chars
UPDATE public.profiles
SET username = lower(regexp_replace(
  regexp_replace(username, '[^a-z0-9_]', '', 'g'),
  ' ', '_', 'g'
))
WHERE username !~ '^[a-z0-9_]+$';

-- Handle duplicates by appending numbers
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
        -- If we can't resolve duplicates, use UUID-based username
        UPDATE public.profiles
        SET username = 'user_' || substr(id::text, 1, 12)
        WHERE username = v_username || CASE WHEN v_count > 1 THEN (v_count - 1)::text ELSE '' END;
        EXIT;
      END IF;
    END LOOP;
    
    -- Update duplicates
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

-- ============================================================
-- STEP 3: Make username NOT NULL
-- ============================================================

-- For any remaining NULL usernames, use UUID-based fallback
UPDATE public.profiles
SET username = 'user_' || substr(id::text, 1, 12)
WHERE username IS NULL OR username = '';

ALTER TABLE public.profiles
  ALTER COLUMN username SET NOT NULL;

-- ============================================================
-- STEP 4: Re-add username constraint (more lenient for now)
-- ============================================================

-- Add back a simpler constraint: just length and non-empty
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_valid CHECK (
    length(username) BETWEEN 1 AND 50
  );

-- Keep the unique constraint (drop if exists first to avoid error)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_unique;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_unique UNIQUE (username);

-- ============================================================
-- STEP 5: Update auth trigger to handle edge cases
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
  
  INSERT INTO public.profiles(id,full_name,role,active,username,must_change_password)
  VALUES(
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'),120),
    'VIEWER',
    false,
    v_username,
    true  -- New users must change password on first login
  );
  RETURN new;
END $$;
