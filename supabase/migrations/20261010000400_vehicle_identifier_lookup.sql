-- Exact camera identity lookup over all inventory, without search pagination.
-- Existing generated compact columns use the same normalization as intake.
-- Plate index already exists; this index also covers CANCELLED full frames.
BEGIN;

CREATE INDEX IF NOT EXISTS vehicles_identifier_frame_lookup
  ON public.vehicles(frame_compact)
  WHERE frame_input_kind = 'FULL' AND frame_compact <> '';

CREATE OR REPLACE FUNCTION public.lookup_vehicle_identifiers(
  p_license_plate text DEFAULT NULL,
  p_frame_number text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_plate text;
  v_frame text;
  v_plate_matches jsonb;
  v_frame_matches jsonb;
BEGIN
  IF length(coalesce(p_license_plate,'')) > 200 OR length(coalesce(p_frame_number,'')) > 200 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_IDENTIFIER';
  END IF;

  -- Unknown glyphs/wildcards must not be removed to accidentally make a match.
  IF p_license_plate ~ '^[A-Za-z0-9[:space:].-]+$' THEN
    v_plate := private.plate_compact_of(p_license_plate);
    IF v_plate !~ '^[0-9]{2}[A-Z]{1,2}[0-9]{5,7}$' THEN v_plate := NULL; END IF;
  END IF;
  IF p_frame_number ~ '^[A-Za-z0-9[:space:].-]+$'
      AND upper(btrim(p_frame_number)) NOT LIKE 'GEN-%' THEN
    v_frame := private.frame_compact_of(upper(btrim(p_frame_number)));
    IF length(v_frame) NOT BETWEEN 11 AND 100
        OR v_frame !~ '[A-Z]' OR v_frame !~ '[0-9]' THEN v_frame := NULL; END IF;
  END IF;

  WITH matched AS (
    SELECT v.id, v.created_at,
      v_plate IS NOT NULL AND v.plate_compact = v_plate AS plate_match,
      v_frame IS NOT NULL AND v.frame_input_kind = 'FULL' AND v.frame_compact = v_frame AS frame_match,
      jsonb_build_object(
        'id', v.id,
        'internal_code', v.internal_code,
        'license_plate', v.license_plate,
        'frame_number', v.frame_number,
        'vehicle_type', private.vehicle_display(v)->>'vehicle_type',
        'status', v.status
      ) AS brief
    FROM public.vehicles v
    WHERE ((v_plate IS NOT NULL AND v.plate_compact = v_plate)
      OR (v_frame IS NOT NULL AND v.frame_input_kind = 'FULL' AND v.frame_compact = v_frame))
      AND NOT EXISTS (
        SELECT 1 FROM public.approval_requests ar
        WHERE ar.subject_id = v.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING'
      )
  )
  SELECT
    coalesce(jsonb_agg(brief ORDER BY created_at DESC, id) FILTER (WHERE plate_match), '[]'::jsonb),
    coalesce(jsonb_agg(brief ORDER BY created_at DESC, id) FILTER (WHERE frame_match), '[]'::jsonb)
  INTO v_plate_matches, v_frame_matches FROM matched;

  RETURN jsonb_build_object('plate_matches', v_plate_matches, 'frame_matches', v_frame_matches);
END $$;

REVOKE ALL ON FUNCTION public.lookup_vehicle_identifiers(text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_vehicle_identifiers(text,text) TO authenticated;
COMMENT ON FUNCTION public.lookup_vehicle_identifiers(text,text) IS
  'Read-only exact plate/full-frame identity across inventory. No pagination, suffix matching, financial data or pending-deletion records.';

COMMIT;
