-- Seasonal UI theme (Tết 2027) — presentation-only, shared across every account.
-- The row carries no business data, no money and no PII, so it is readable by every
-- signed-in role (that is the point: OWNER turns the theme on, everyone sees it).
-- Writes stay OWNER-only and go through save_seasonal_theme(); the table itself is
-- SELECT-only for clients, which is also what lets Supabase Realtime deliver the
-- change to already-open sessions without a rebuild or redeploy.
BEGIN;

CREATE TABLE public.seasonal_theme_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL DEFAULT 'DEFAULT' CHECK (mode IN ('DEFAULT','TET_2027','AUTO')),
  tet_start date,
  tet_end date,
  cinematic_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- AUTO is only meaningful with a complete, ordered window. The window itself is
  -- never defaulted here: the dates are the OWNER's schedule, not the code's.
  CONSTRAINT seasonal_theme_auto_window CHECK (mode <> 'AUTO' OR (tet_start IS NOT NULL AND tet_end IS NOT NULL)),
  CONSTRAINT seasonal_theme_sane_window CHECK (
    tet_start IS NULL OR tet_end IS NULL OR (tet_end >= tet_start AND tet_end <= tet_start + 366)
  )
);

-- Seeded to the current product behaviour: no seasonal layer, no cinematic.
INSERT INTO public.seasonal_theme_config(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.seasonal_theme_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seasonal_theme_config FROM public, anon, authenticated;
GRANT SELECT ON public.seasonal_theme_config TO authenticated;

DROP POLICY IF EXISTS seasonal_theme_read ON public.seasonal_theme_config;
CREATE POLICY seasonal_theme_read ON public.seasonal_theme_config
  FOR SELECT TO authenticated USING (true);

-- Read path for every role. `is_active` is resolved server-side in the shop's own
-- timezone so a long-lived tab, a refresh and a brand-new login all agree.
CREATE OR REPLACE FUNCTION public.get_seasonal_theme()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_row public.seasonal_theme_config;
  v_today date := private.today();
BEGIN
  SELECT * INTO v_row FROM public.seasonal_theme_config WHERE id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'SEASONAL_THEME_MISSING'; END IF;
  RETURN jsonb_build_object(
    'mode', v_row.mode,
    'tet_start', v_row.tet_start,
    'tet_end', v_row.tet_end,
    'cinematic_enabled', v_row.cinematic_enabled,
    'is_active', CASE
      WHEN v_row.mode = 'TET_2027' THEN true
      WHEN v_row.mode = 'AUTO' THEN v_today BETWEEN v_row.tet_start AND v_row.tet_end
      ELSE false
    END,
    'updated_at', v_row.updated_at
  );
END $$;

-- Write path for OWNER only. Partial payloads are allowed: absent keys keep their
-- stored value, an explicit null clears a date.
CREATE OR REPLACE FUNCTION public.save_seasonal_theme(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old jsonb;
  v_new jsonb;
  v_mode text := p_data->>'mode';
  v_cinematic jsonb := p_data->'cinematic_enabled';
  v_start date := private.seasonal_theme_date(p_data, 'tet_start');
  v_end date := private.seasonal_theme_date(p_data, 'tet_end');
  -- An absent key keeps the stored value while an explicit null clears it, so the
  -- effective window has to be resolved from the key presence, not from coalesce().
  v_eff_start date := CASE WHEN p_data ? 'tet_start' THEN private.seasonal_theme_date(p_data, 'tet_start')
    ELSE (SELECT c.tet_start FROM public.seasonal_theme_config c WHERE c.id) END;
  v_eff_end date := CASE WHEN p_data ? 'tet_end' THEN private.seasonal_theme_date(p_data, 'tet_end')
    ELSE (SELECT c.tet_end FROM public.seasonal_theme_config c WHERE c.id) END;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k
      WHERE k NOT IN ('mode','tet_start','tet_end','cinematic_enabled'))
    OR (p_data ? 'mode' AND jsonb_typeof(p_data->'mode') <> 'string')
    OR (v_cinematic IS NOT NULL AND jsonb_typeof(v_cinematic) <> 'boolean')
  THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;

  IF p_data ? 'mode' THEN
    IF v_mode IS NULL OR btrim(v_mode) = ''
      OR v_mode NOT IN ('DEFAULT','TET_2027','AUTO')
    THEN RAISE EXCEPTION USING errcode = '22023', message = 'SEASONAL_MODE_INVALID'; END IF;
  END IF;

  -- Validate the resolved window before touching the row, so a rejected payload
  -- never leaves a half-written schedule behind.
  IF coalesce(v_mode, (SELECT mode FROM public.seasonal_theme_config WHERE id)) = 'AUTO'
    AND (v_eff_start IS NULL OR v_eff_end IS NULL)
  THEN RAISE EXCEPTION USING errcode = '22023', message = 'SEASONAL_WINDOW_REQUIRED'; END IF;
  IF v_eff_start IS NOT NULL AND v_eff_end IS NOT NULL AND v_eff_end < v_eff_start THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SEASONAL_WINDOW_REVERSED';
  END IF;
  IF v_eff_start IS NOT NULL AND v_eff_end IS NOT NULL AND v_eff_end > v_eff_start + 366 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SEASONAL_WINDOW_TOO_LONG';
  END IF;

  SELECT to_jsonb(s) INTO v_old FROM public.seasonal_theme_config s WHERE id FOR UPDATE;

  UPDATE public.seasonal_theme_config SET
    mode = coalesce(v_mode, mode),
    tet_start = CASE WHEN p_data ? 'tet_start' THEN v_start ELSE tet_start END,
    tet_end = CASE WHEN p_data ? 'tet_end' THEN v_end ELSE tet_end END,
    cinematic_enabled = coalesce((v_cinematic)::boolean, cinematic_enabled),
    updated_by = v_actor,
    updated_at = now()
    WHERE id
    RETURNING to_jsonb(seasonal_theme_config) INTO v_new;

  PERFORM private.audit('SEASONAL_THEME_CHANGED','seasonal_theme_config',null,v_old,v_new);
  RETURN public.get_seasonal_theme();
END $$;

-- Date inputs are validated as text before the cast so a malformed value reports a
-- clear INVALID_DATE instead of a raw PostgreSQL syntax error.
CREATE OR REPLACE FUNCTION private.seasonal_theme_date(p_data jsonb, p_key text)
RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_value text;
BEGIN
  IF p_data IS NULL OR NOT (p_data ? p_key) THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_data->p_key) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_data->p_key) <> 'string' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE';
  END IF;
  v_value := btrim(p_data->>p_key);
  IF v_value = '' THEN RETURN NULL; END IF;
  IF v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE';
  END IF;
  RETURN v_value::date;
END $$;

REVOKE ALL ON FUNCTION public.get_seasonal_theme() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_seasonal_theme(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION private.seasonal_theme_date(jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_seasonal_theme() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_seasonal_theme(jsonb) TO authenticated;

-- Live delivery to the sessions that are already open. The publication exists only
-- on the managed platform, so disposable test engines skip this block.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'seasonal_theme_config'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seasonal_theme_config;
  END IF;
END $$;

COMMIT;
