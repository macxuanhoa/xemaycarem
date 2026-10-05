-- 041 · Shop-customizable quick-pick catalog for brand and model chips.
--
-- Motivation: staff fill the acquisition (Thu vào) and vehicle-intake forms
-- dozens of times per day. Free-typed brand/model is error-prone (Honda vs
-- "honda" vs "Hoong da" fragments recentVehicles history), and hard-coded
-- chip sets cannot follow the shop's shifting stock. OWNER edits the catalog
-- from Cài đặt → "Chọn nhanh xe"; every authenticated user reads it when the
-- forms render, so the chip row and its autocomplete fallback stay in sync
-- across devices without localStorage drift.
--
-- Storage shape:
--   quickpick_brands  text[]   ordered list of brand names shown as chips
--                              under "Chọn nhanh hãng xe".
--   quickpick_models  jsonb    { "honda": ["SH 125i", …], "piaggio": […] }
--                              keyed by LOWERCASE, whitespace-trimmed brand
--                              so lookup survives casing differences.
--
-- Both columns seed with the shop's opening list. Existing rows receive the
-- same defaults via DEFAULT on ADD COLUMN, so no UPDATE is required.
--
-- save_settings is REPLACED (never ALTER, never drop) with an extended body
-- that keeps every prior rule intact and additionally validates/normalizes
-- the two new fields. Values are trimmed and de-duplicated case-insensitively
-- before storage. get_settings already returns `to_jsonb(s)` on the whole row,
-- so the new columns are automatically visible to every authenticated role.

-- ============================================================
-- STEP 1 · New columns on system_settings
-- ============================================================

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS quickpick_brands text[] NOT NULL DEFAULT ARRAY[
    'Honda','Piaggio','Suzuki','Yamaha'
  ]::text[],
  ADD COLUMN IF NOT EXISTS quickpick_models jsonb NOT NULL DEFAULT
    '{
      "honda":   ["SH 125i","SH 150i","SH 160i","SH Mode","Vision","Air Blade","Lead","Wave","Future","Dax ST125"],
      "piaggio": ["Vespa Sprint","Vespa Primavera"],
      "suzuki":  ["Satria","Raider"],
      "yamaha":  ["Exciter"]
    }'::jsonb;

COMMENT ON COLUMN public.system_settings.quickpick_brands IS
  'Ordered brand names surfaced as quick-pick chips in intake forms; OWNER edits via save_settings.';
COMMENT ON COLUMN public.system_settings.quickpick_models IS
  'Quick-pick model names grouped by lowercased brand, e.g. {"honda":["SH 160i","Vision"]}. OWNER edits via save_settings.';

-- ============================================================
-- STEP 2 · save_settings accepts and normalizes the catalog
-- ============================================================
-- Body is copied from 20261002003600 (shared schedule) with two extra
-- validation blocks and two extra SET clauses. Rules that must NOT regress:
--   * OWNER-only (private.require_role ARRAY['OWNER']);
--   * INVALID_SCHEDULE on malformed staff_allowed_from/until/working_days;
--   * INVALID_INPUT on non-object p_data;
--   * advisory row lock via FOR UPDATE; audit snapshot written every time.
-- New rules:
--   * INVALID_INPUT when quickpick_brands is present but not a JSON array of
--     strings, or contains blank/whitespace-only entries, or exceeds 30 items.
--   * INVALID_INPUT when quickpick_models is present but not a JSON object,
--     or any value is not a string array, or a single brand has > 60 models.
--   * Empty arrays and empty objects are allowed (hides the chip row).
--   * Both fields are trimmed and de-duplicated case-insensitively.

CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old jsonb; v_new jsonb;
  v_from time; v_until time; v_days integer[];
  v_brands text[]; v_models jsonb;
  v_key text; v_value jsonb; v_items text[]; v_clean jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;

  -- Validate the shared working-time fields before touching the row.
  IF p_data ? 'staff_allowed_from' AND nullif(btrim(coalesce(p_data->>'staff_allowed_from','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_from')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_from := (p_data->>'staff_allowed_from')::time;
  ELSIF p_data ? 'staff_allowed_from' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_allowed_until' AND nullif(btrim(coalesce(p_data->>'staff_allowed_until','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_until')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_until := (p_data->>'staff_allowed_until')::time;
  ELSIF p_data ? 'staff_allowed_until' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_working_days' THEN
    IF jsonb_typeof(p_data->'staff_working_days') <> 'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_data->'staff_working_days') e WHERE e !~ '^[1-7]$') THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (e)::int), ARRAY[]::integer[]) INTO v_days
      FROM jsonb_array_elements_text(p_data->'staff_working_days') e;
  END IF;

  -- Quick-pick brands: array of non-blank strings, trimmed, case-sensitive
  -- unique, ordered as supplied. Cap at 30 to keep the chip row usable.
  IF p_data ? 'quickpick_brands' THEN
    IF jsonb_typeof(p_data->'quickpick_brands') <> 'array' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
    END IF;
    IF jsonb_array_length(p_data->'quickpick_brands') > 30 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_data->'quickpick_brands') e
      WHERE jsonb_typeof(e) <> 'string' OR btrim(e #>> '{}') = '' OR length(btrim(e #>> '{}')) > 40
    ) THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
    END IF;
    -- Preserve original order while dropping case-insensitive duplicates.
    SELECT array_agg(v ORDER BY ordinality) INTO v_brands
    FROM (
      SELECT btrim(value #>> '{}') AS v, ordinality,
             row_number() OVER (PARTITION BY lower(btrim(value #>> '{}')) ORDER BY ordinality) AS rn
      FROM jsonb_array_elements(p_data->'quickpick_brands') WITH ORDINALITY
    ) ranked WHERE rn = 1;
    v_brands := COALESCE(v_brands, ARRAY[]::text[]);
  END IF;

  -- Quick-pick models: object brand(lower) -> array of strings.
  IF p_data ? 'quickpick_models' THEN
    IF jsonb_typeof(p_data->'quickpick_models') <> 'object' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
    END IF;
    FOR v_key, v_value IN
      SELECT key, value FROM jsonb_each(p_data->'quickpick_models')
    LOOP
      IF jsonb_typeof(v_value) <> 'array' THEN
        RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
      END IF;
      IF jsonb_array_length(v_value) > 60 THEN
        RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_value) e
        WHERE jsonb_typeof(e) <> 'string' OR btrim(e #>> '{}') = '' OR length(btrim(e #>> '{}')) > 60
      ) THEN
        RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
      END IF;
      SELECT array_agg(v ORDER BY ordinality) INTO v_items
      FROM (
        SELECT btrim(value #>> '{}') AS v, ordinality,
               row_number() OVER (PARTITION BY lower(btrim(value #>> '{}')) ORDER BY ordinality) AS rn
        FROM jsonb_array_elements(v_value) WITH ORDINALITY
      ) ranked WHERE rn = 1;
      v_clean := jsonb_set(
        v_clean,
        ARRAY[lower(btrim(v_key))],
        to_jsonb(COALESCE(v_items, ARRAY[]::text[])),
        true
      );
    END LOOP;
    v_models := v_clean;
  END IF;

  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;
  UPDATE public.system_settings SET
    store_name=btrim(coalesce(p_data->>'store_name',store_name)),
    phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),
    low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),
    customer_messaging_enabled=coalesce((p_data->>'customer_messaging_enabled')::boolean,customer_messaging_enabled),
    sale_thank_you_enabled=coalesce((p_data->>'sale_thank_you_enabled')::boolean,sale_thank_you_enabled),
    primary_message_channel=coalesce(p_data->>'primary_message_channel',primary_message_channel),
    fallback_channel=coalesce(p_data->>'fallback_channel',fallback_channel),
    support_phone=btrim(coalesce(p_data->>'support_phone',support_phone)),
    staff_allowed_from=coalesce(v_from,staff_allowed_from),
    staff_allowed_until=coalesce(v_until,staff_allowed_until),
    staff_working_days=coalesce(v_days,staff_working_days),
    quickpick_brands=coalesce(v_brands,quickpick_brands),
    quickpick_models=coalesce(v_models,quickpick_models),
    updated_by=v_actor,updated_at=now()
  WHERE id RETURNING to_jsonb(system_settings) INTO v_new;
  PERFORM private.audit(
    CASE
      WHEN (v_old->>'staff_allowed_from') <> (v_new->>'staff_allowed_from')
        OR (v_old->>'staff_allowed_until') <> (v_new->>'staff_allowed_until')
        OR (v_old->'staff_working_days') <> (v_new->'staff_working_days')
        THEN 'STAFF_SCHEDULE_CHANGED'
      WHEN (v_old->'quickpick_brands') <> (v_new->'quickpick_brands')
        OR (v_old->'quickpick_models') <> (v_new->'quickpick_models')
        THEN 'QUICKPICK_CATALOG_CHANGED'
      ELSE 'MESSAGE_SETTING_CHANGED'
    END,
    'system_settings',null,v_old,v_new);
END $function$;
