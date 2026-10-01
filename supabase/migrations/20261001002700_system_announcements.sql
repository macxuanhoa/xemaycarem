-- Migration: 20261001002700_system_announcements.sql
-- Description: Persistent, scheduled, role-targeted system announcements published by the OWNER.
--   * system_announcements table (title, message, type, display_mode, audience, timing, dismissible)
--   * Owner management RPCs (create/edit/activate/deactivate/delete) audited via the existing audit_logs
--   * Read RPCs that resolve visibility by role + active window (timestamptz, shown in Asia/Ho_Chi_Minh)
-- This is an internal notice channel. It intentionally reuses the audit helper and adds no business logic.

-- ============================================================
-- STEP 1: Enum types (kept small and semantic)
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.announcement_type AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.announcement_display AS ENUM ('STATIC', 'SCROLLING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.announcement_audience AS ENUM ('ALL', 'OWNER', 'MANAGER', 'STAFF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- STEP 2: Table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 120),
  message text NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
  type public.announcement_type NOT NULL DEFAULT 'INFO',
  display_mode public.announcement_display NOT NULL DEFAULT 'STATIC',
  audience public.announcement_audience NOT NULL DEFAULT 'ALL',
  is_active boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  dismissible boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS announcements_active_window
  ON public.system_announcements (is_active, starts_at, ends_at);

-- ============================================================
-- STEP 3: Owner management RPCs (SECURITY DEFINER, OWNER only)
-- ============================================================

-- Create or edit an announcement. When p_data->>'id' is present it updates, otherwise inserts.
CREATE OR REPLACE FUNCTION public.save_announcement(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_id uuid := nullif(p_data->>'id', '')::uuid;
  v_title text := nullif(btrim(coalesce(p_data->>'title', '')), '');
  v_message text := btrim(coalesce(p_data->>'message', ''));
  v_type public.announcement_type := coalesce((p_data->>'type')::public.announcement_type, 'INFO');
  v_display public.announcement_display := coalesce((p_data->>'display_mode')::public.announcement_display, 'STATIC');
  v_audience public.announcement_audience := coalesce((p_data->>'audience')::public.announcement_audience, 'ALL');
  v_active boolean := coalesce((p_data->>'is_active')::boolean, false);
  v_starts timestamptz := nullif(p_data->>'starts_at', '')::timestamptz;
  v_ends timestamptz := nullif(p_data->>'ends_at', '')::timestamptz;
  v_dismissible boolean := coalesce((p_data->>'dismissible')::boolean, true);
  v_old public.system_announcements;
  v_new public.system_announcements;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  IF v_message = '' OR char_length(v_message) > 500 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_ANNOUNCEMENT_MESSAGE';
  END IF;
  IF v_starts IS NOT NULL AND v_ends IS NOT NULL AND v_starts >= v_ends THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.system_announcements (
      title, message, type, display_mode, audience, is_active, starts_at, ends_at, dismissible, created_by
    ) VALUES (
      v_title, v_message, v_type, v_display, v_audience, v_active, v_starts, v_ends, v_dismissible, v_actor
    ) RETURNING * INTO v_new;
    PERFORM private.audit('ANNOUNCEMENT_CREATE', 'system_announcements', v_new.id, null, to_jsonb(v_new));
  ELSE
    SELECT * INTO v_old FROM public.system_announcements WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ANNOUNCEMENT_NOT_FOUND'; END IF;
    UPDATE public.system_announcements SET
      title = v_title, message = v_message, type = v_type, display_mode = v_display,
      audience = v_audience, is_active = v_active, starts_at = v_starts, ends_at = v_ends,
      dismissible = v_dismissible, updated_at = now()
    WHERE id = v_id RETURNING * INTO v_new;
    PERFORM private.audit('ANNOUNCEMENT_UPDATE', 'system_announcements', v_new.id, to_jsonb(v_old), to_jsonb(v_new));
  END IF;

  RETURN to_jsonb(v_new);
END $$;

-- Toggle an announcement on/off. Records ACTIVATE/DEACTIVATE for a clear audit trail.
CREATE OR REPLACE FUNCTION public.set_announcement_active(p_id uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old public.system_announcements;
  v_new public.system_announcements;
BEGIN
  SELECT * INTO v_old FROM public.system_announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ANNOUNCEMENT_NOT_FOUND'; END IF;
  UPDATE public.system_announcements SET is_active = p_active, updated_at = now()
  WHERE id = p_id RETURNING * INTO v_new;
  PERFORM private.audit(
    CASE WHEN p_active THEN 'ANNOUNCEMENT_ACTIVATE' ELSE 'ANNOUNCEMENT_DEACTIVATE' END,
    'system_announcements', v_new.id, to_jsonb(v_old), to_jsonb(v_new));
  RETURN to_jsonb(v_new);
END $$;

CREATE OR REPLACE FUNCTION public.delete_announcement(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old public.system_announcements;
BEGIN
  SELECT * INTO v_old FROM public.system_announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ANNOUNCEMENT_NOT_FOUND'; END IF;
  DELETE FROM public.system_announcements WHERE id = p_id;
  PERFORM private.audit('ANNOUNCEMENT_DELETE', 'system_announcements', v_old.id, to_jsonb(v_old), null);
END $$;

-- Full management list for the OWNER admin screen.
CREATE OR REPLACE FUNCTION public.list_announcements() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_items jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_items
  FROM public.system_announcements a;
  RETURN jsonb_build_object('items', v_items);
END $$;

-- ============================================================
-- STEP 4: Read RPC for the app shell (visible by role + schedule)
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_active_announcements() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role := private.current_role();
  v_items jsonb;
BEGIN
  IF v_role IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'message', a.message, 'type', a.type,
      'display_mode', a.display_mode, 'dismissible', a.dismissible,
      'starts_at', a.starts_at, 'ends_at', a.ends_at, 'updated_at', a.updated_at
    ) ORDER BY
      CASE a.type WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'INFO' THEN 2 ELSE 3 END,
      coalesce(a.starts_at, a.created_at) DESC, a.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM public.system_announcements a
  WHERE a.is_active
    AND (a.starts_at IS NULL OR a.starts_at <= now())
    AND (a.ends_at IS NULL OR a.ends_at >= now())
    AND (a.audience = 'ALL' OR a.audience::text = v_role::text);
  RETURN v_items;
END $$;

-- ============================================================
-- STEP 5: Row level security and privilege lockdown
-- ============================================================

ALTER TABLE public.system_announcements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.system_announcements FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_announcement(jsonb), public.set_announcement_active(uuid, boolean),
  public.delete_announcement(uuid), public.list_announcements(), public.list_active_announcements() FROM public, anon;

GRANT EXECUTE ON FUNCTION public.save_announcement(jsonb), public.set_announcement_active(uuid, boolean),
  public.delete_announcement(uuid), public.list_announcements(), public.list_active_announcements() TO authenticated;
