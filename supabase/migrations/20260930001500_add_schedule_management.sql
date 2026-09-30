-- Migration: Add schedule management and soft delete features to profiles
-- This migration adds:
--   - disabled_until: Temporary disable with expiration
--   - allowed_from / allowed_until: Working hours
--   - working_days: Allowed working days (1=Monday, 7=Sunday)
--   - deleted_at: Soft delete timestamp (keeps data for 30 days)
--   - disable_reason: Reason for disabling account

-- ============================================================
-- STEP 1: Add new columns to profiles
-- ============================================================

-- Temporary disable with expiration
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS disabled_until TIMESTAMPTZ DEFAULT NULL;

-- Working hours
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS allowed_from TIME DEFAULT '00:00:00';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS allowed_until TIME DEFAULT '23:59:59';

-- Working days (1=Monday, 2=Tuesday, ..., 7=Sunday)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS working_days INTEGER[] DEFAULT ARRAY[1,2,3,4,5,6,7];

-- Soft delete timestamp
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Reason for disabling account
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS disable_reason TEXT DEFAULT NULL;

-- ============================================================
-- STEP 2: Add indexes for deleted accounts cleanup
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at ON public.profiles(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================
-- STEP 3: Create function to check if user can login
-- ============================================================

CREATE OR REPLACE FUNCTION private.can_user_login()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_profile RECORD;
  v_current_time TIME;
  v_current_day INTEGER;
BEGIN
  -- Get current user's profile
  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = auth.uid();

  -- If no profile, deny login
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Check if account is soft deleted
  IF v_profile.deleted_at IS NOT NULL THEN
    RETURN FALSE;
  END IF;

  -- Check if account is active
  IF NOT v_profile.active THEN
    RETURN FALSE;
  END IF;

  -- Check temporary disable
  IF v_profile.disabled_until IS NOT NULL AND v_profile.disabled_until > now() THEN
    RETURN FALSE;
  END IF;

  -- Check working hours
  v_current_time := now()::time;

  IF v_current_time < v_profile.allowed_from OR v_current_time > v_profile.allowed_until THEN
    RETURN FALSE;
  END IF;

  -- Check working days
  v_current_day := EXTRACT(ISODOW FROM now())::INTEGER;

  IF NOT (v_current_day = ANY(v_profile.working_days)) THEN
    RETURN FALSE;
  END IF;

  -- All checks passed
  RETURN TRUE;
END $$;

-- ============================================================
-- STEP 4: Create function to cleanup soft-deleted accounts (older than 30 days)
-- ============================================================

CREATE OR REPLACE FUNCTION private.cleanup_deleted_accounts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Count accounts to be deleted
  SELECT COUNT(*) INTO v_count
  FROM public.profiles
  WHERE deleted_at IS NOT NULL
    AND deleted_at < (now() - INTERVAL '30 days');

  -- Delete accounts older than 30 days
  -- This will cascade to auth.users through the profile deletion
  DELETE FROM public.profiles
  WHERE deleted_at IS NOT NULL
    AND deleted_at < (now() - INTERVAL '30 days');

  RETURN v_count;
END $$;

-- ============================================================
-- STEP 5: Update auth trigger to set default values for new fields
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
  
  -- Insert profile with default schedule values
  INSERT INTO public.profiles(
    id,
    full_name,
    role,
    active,
    username,
    must_change_password,
    disabled_until,
    allowed_from,
    allowed_until,
    working_days,
    deleted_at,
    disable_reason
  )
  VALUES(
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),'Người dùng mới'),120),
    'VIEWER',
    false,
    v_username,
    false,
    NULL,
    '00:00:00',
    '23:59:59',
    ARRAY[1,2,3,4,5,6,7],
    NULL,
    NULL
  );
  RETURN new;
END $$;

-- ============================================================
-- STEP 6: Set default values for existing profiles
-- ============================================================

UPDATE public.profiles
SET
  disabled_until = NULL,
  allowed_from = '00:00:00',
  allowed_until = '23:59:59',
  working_days = ARRAY[1,2,3,4,5,6,7],
  deleted_at = NULL,
  disable_reason = NULL
WHERE
  disabled_until IS NULL
  OR allowed_from IS NULL
  OR allowed_until IS NULL
  OR working_days IS NULL
  OR deleted_at IS NULL
  OR disable_reason IS NULL;
