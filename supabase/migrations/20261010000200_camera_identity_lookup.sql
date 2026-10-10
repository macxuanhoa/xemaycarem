-- Exact CCCD -> at-store vehicle lookup for the camera. Identity documents
-- keep their existing OWNER/MANAGER restriction; no document PII is returned.
CREATE INDEX IF NOT EXISTS identity_documents_id_number_lookup
  ON public.identity_documents(id_number) WHERE id_number <> '';

CREATE OR REPLACE FUNCTION public.lookup_identity_document_vehicles(p_id_number text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_number text;
  v_items jsonb;
BEGIN
  -- Separators may come from OCR. Letters and partial/guessed identifiers
  -- never become a search query, even if stripping them would leave 12 digits.
  IF p_id_number IS NULL OR p_id_number !~ '^[0-9[:space:].-]+$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_ID_NUMBER';
  END IF;
  v_number := regexp_replace(p_id_number, '[[:space:].-]', '', 'g');
  IF v_number !~ '^[0-9]{12}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_ID_NUMBER';
  END IF;

  WITH linked_vehicle_ids AS (
    SELECT a.vehicle_id
    FROM public.identity_documents d
    JOIN public.acquisitions a ON a.id = d.acquisition_id
    WHERE d.id_number = v_number AND a.status = 'COMPLETED'
    UNION
    SELECT s.vehicle_id
    FROM public.identity_documents d
    JOIN public.sales s ON s.id = d.sale_id
    WHERE d.id_number = v_number
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'internal_code', v.internal_code,
    'license_plate', coalesce(v.license_plate, ''),
    'frame_number', v.frame_number,
    'vehicle_type', private.vehicle_display(v)->>'vehicle_type',
    'status', v.status
  ) ORDER BY v.created_at DESC, v.id), '[]'::jsonb)
  INTO v_items
  FROM linked_vehicle_ids linked
  JOIN public.vehicles v ON v.id = linked.vehicle_id
  WHERE v.status IN ('IN_STOCK','RESERVED')
    AND NOT EXISTS (
      SELECT 1 FROM public.approval_requests ar
      WHERE ar.subject_id = v.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING'
    );

  RETURN v_items;
END $$;

REVOKE ALL ON FUNCTION public.lookup_identity_document_vehicles(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_identity_document_vehicles(text) TO authenticated;
