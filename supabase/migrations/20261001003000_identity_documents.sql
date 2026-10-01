-- Migration: 20261001003000_identity_documents.sql
-- Description: Căn cước công dân (CCCD) hồ sơ pháp lý cho thu mua và bán xe.
--   * identity_documents table: one row per acquisition (seller) or sale (buyer),
--     storing the identity text and the two private card image paths.
--   * Sensitive by design: PII is isolated in its own table because RLS filters rows,
--     not columns. Only OWNER and MANAGER may read it; STAFF and disabled accounts see nothing.
--   * A private `identity-documents` Storage bucket holds the card photos. The browser
--     views them only through short-lived signed URLs, guarded by Storage RLS policies.
--   * Every write goes through a SECURITY DEFINER RPC that re-checks the active role,
--     normalizes the 12-digit id number and records an audit entry.
-- This migration never touches the vehicle-images bucket or public showroom data.

-- ============================================================
-- STEP 1: identity_documents table (PII, row-level isolation)
-- ============================================================

CREATE TABLE public.identity_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one subject: the acquisition (người bán) or the sale (người mua).
  acquisition_id UUID REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES public.sales(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '' CHECK (char_length(full_name) <= 200),
  -- Normalized to bare digits; empty string means "not captured yet".
  id_number TEXT NOT NULL DEFAULT '' CHECK (id_number = '' OR id_number ~ '^[0-9]{12}$'),
  dob DATE,
  issued_date DATE,
  place_of_issue TEXT NOT NULL DEFAULT '' CHECK (char_length(place_of_issue) <= 200),
  address TEXT NOT NULL DEFAULT '' CHECK (char_length(address) <= 500),
  -- Private Storage object paths inside the identity-documents bucket.
  front_image_path TEXT CHECK (front_image_path IS NULL OR char_length(front_image_path) <= 300),
  back_image_path TEXT CHECK (back_image_path IS NULL OR char_length(back_image_path) <= 300),
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_document_one_subject CHECK (
    (acquisition_id IS NULL) <> (sale_id IS NULL)
  ),
  CONSTRAINT identity_document_dob_sane CHECK (dob IS NULL OR dob < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
);

-- One CCCD record per subject.
CREATE UNIQUE INDEX identity_documents_acquisition_unique
  ON public.identity_documents(acquisition_id) WHERE acquisition_id IS NOT NULL;
CREATE UNIQUE INDEX identity_documents_sale_unique
  ON public.identity_documents(sale_id) WHERE sale_id IS NOT NULL;

ALTER TABLE public.identity_documents ENABLE ROW LEVEL SECURITY;

-- Only OWNER and MANAGER can read. private.current_role() is NULL for disabled,
-- out-of-schedule or deleted accounts, which fails the IN test and hides every row.
CREATE POLICY identity_documents_read ON public.identity_documents
  FOR SELECT TO authenticated
  USING (private.current_role() IN ('OWNER', 'MANAGER'));

REVOKE ALL ON public.identity_documents FROM public, anon, authenticated;
GRANT SELECT ON public.identity_documents TO authenticated;

-- ============================================================
-- STEP 2: private Storage bucket for card images
-- ============================================================

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('identity-documents', 'identity-documents', false, 8388608, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
ON CONFLICT(id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Upload is allowed only for an already-registered subject document whose path is
-- `<subject-uuid>/<uuid>.<ext>`. The document row is created by save_identity_document.
CREATE FUNCTION private.can_upload_identity_document_image(p_path text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(private.current_role() IN ('OWNER', 'MANAGER'), false)
    AND p_path ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp|avif)$'
    AND EXISTS (
      SELECT 1 FROM public.identity_documents
      WHERE acquisition_id::text = split_part(p_path, '/', 1)
         OR sale_id::text = split_part(p_path, '/', 1)
    );
$$;

-- Read (which also gates signed-URL creation) requires the object to be referenced by
-- an existing document and the caller to be OWNER/MANAGER.
CREATE FUNCTION private.can_read_identity_document_image(p_path text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(private.current_role() IN ('OWNER', 'MANAGER'), false)
    AND EXISTS (
      SELECT 1 FROM public.identity_documents
      WHERE front_image_path = p_path OR back_image_path = p_path
    );
$$;

CREATE POLICY identity_document_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'identity-documents' AND private.can_upload_identity_document_image(name));
CREATE POLICY identity_document_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'identity-documents' AND private.can_read_identity_document_image(name));
-- No browser UPDATE or DELETE policy: a replacement upload uses a fresh path and the
-- old object is retained for administrative retention.

-- Grant execute on the private helpers the Storage policies evaluate as the caller.
GRANT EXECUTE ON FUNCTION private.can_upload_identity_document_image(text), private.can_read_identity_document_image(text) TO authenticated;

-- ============================================================
-- STEP 3: write RPCs (SECURITY DEFINER, re-check the active role)
-- ============================================================

-- Create or update the identity text for an acquisition (seller) or sale (buyer).
CREATE OR REPLACE FUNCTION public.save_identity_document(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_kind text := btrim(coalesce(p_data->>'subject_type', ''));
  v_subject uuid := nullif(p_data->>'subject_id', '')::uuid;
  v_existing public.identity_documents;
  v_new public.identity_documents;
  v_id_number text := regexp_replace(coalesce(p_data->>'id_number', ''), '[^0-9]', '', 'g');
  v_name text := left(btrim(coalesce(p_data->>'full_name', '')), 200);
  v_place text := left(btrim(coalesce(p_data->>'place_of_issue', '')), 200);
  v_address text := left(btrim(coalesce(p_data->>'address', '')), 500);
  v_dob date := nullif(coalesce(p_data->>'dob', ''), '')::date;
  v_issued date := nullif(coalesce(p_data->>'issued_date', ''), '')::date;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  IF v_kind NOT IN ('acquisition', 'sale') OR v_subject IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SUBJECT';
  END IF;
  IF v_id_number <> '' AND length(v_id_number) <> 12 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_ID_NUMBER';
  END IF;
  IF v_dob IS NOT NULL AND v_dob >= private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DOB';
  END IF;
  IF v_issued IS NOT NULL AND v_issued > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  -- Confirm the subject exists before storing anything against it.
  IF v_kind = 'acquisition' THEN
    IF NOT EXISTS (SELECT 1 FROM public.acquisitions WHERE id = v_subject) THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.sales WHERE id = v_subject) THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND';
    END IF;
  END IF;

  IF v_kind = 'acquisition' THEN
    SELECT * INTO v_existing FROM public.identity_documents WHERE acquisition_id = v_subject FOR UPDATE;
  ELSE
    SELECT * INTO v_existing FROM public.identity_documents WHERE sale_id = v_subject FOR UPDATE;
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.identity_documents(
      acquisition_id, sale_id, full_name, id_number, dob, issued_date, place_of_issue, address, created_by
    ) VALUES (
      CASE WHEN v_kind = 'acquisition' THEN v_subject END,
      CASE WHEN v_kind = 'sale' THEN v_subject END,
      v_name, v_id_number, v_dob, v_issued, v_place, v_address, v_actor
    ) RETURNING * INTO v_new;
    PERFORM private.audit('SAVE_IDENTITY_DOCUMENT', 'identity_documents', v_new.id, null,
      jsonb_build_object('subject_type', v_kind, 'subject_id', v_subject, 'full_name', v_new.full_name, 'id_number', v_new.id_number));
    RETURN v_new.id;
  ELSE
    UPDATE public.identity_documents SET
      full_name = v_name,
      id_number = v_id_number,
      dob = v_dob,
      issued_date = v_issued,
      place_of_issue = v_place,
      address = v_address,
      updated_at = now()
    WHERE id = v_existing.id RETURNING * INTO v_new;
    PERFORM private.audit('SAVE_IDENTITY_DOCUMENT', 'identity_documents', v_new.id,
      to_jsonb(v_existing), to_jsonb(v_new));
    RETURN v_new.id;
  END IF;
END $$;

-- Attach a previously uploaded card photo (front/back) to the subject's document.
CREATE OR REPLACE FUNCTION public.register_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text, p_storage_path text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_document public.identity_documents;
  v_new public.identity_documents;
  v_updated jsonb;
BEGIN
  IF p_subject_type NOT IN ('acquisition', 'sale') OR p_subject_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SUBJECT';
  END IF;
  IF p_side NOT IN ('front', 'back') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SIDE';
  END IF;
  IF split_part(p_storage_path, '/', 1) <> p_subject_id::text OR NOT private.can_upload_identity_document_image(p_storage_path) THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'INVALID_IMAGE_PATH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'identity-documents' AND name = p_storage_path) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'IMAGE_UPLOAD_REQUIRED';
  END IF;

  IF p_subject_type = 'acquisition' THEN
    SELECT * INTO v_document FROM public.identity_documents WHERE acquisition_id = p_subject_id FOR UPDATE;
  ELSE
    SELECT * INTO v_document FROM public.identity_documents WHERE sale_id = p_subject_id FOR UPDATE;
  END IF;
  IF v_document.id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'IDENTITY_DOCUMENT_NOT_FOUND';
  END IF;

  IF p_side = 'front' THEN
    UPDATE public.identity_documents SET front_image_path = p_storage_path, updated_at = now()
    WHERE id = v_document.id RETURNING * INTO v_new;
  ELSE
    UPDATE public.identity_documents SET back_image_path = p_storage_path, updated_at = now()
    WHERE id = v_document.id RETURNING * INTO v_new;
  END IF;
  PERFORM private.audit('ADD_IDENTITY_DOCUMENT_IMAGE', 'identity_documents', v_document.id,
    to_jsonb(v_document), to_jsonb(v_new) || jsonb_build_object('side', p_side));
  RETURN v_document.id;
END $$;

-- Detach a card photo path. The object itself is retained for administrative retention.
CREATE OR REPLACE FUNCTION public.remove_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_document public.identity_documents;
  v_new public.identity_documents;
BEGIN
  IF p_side NOT IN ('front', 'back') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SIDE';
  END IF;
  IF p_subject_type = 'acquisition' THEN
    SELECT * INTO v_document FROM public.identity_documents WHERE acquisition_id = p_subject_id FOR UPDATE;
  ELSE
    SELECT * INTO v_document FROM public.identity_documents WHERE sale_id = p_subject_id FOR UPDATE;
  END IF;
  IF v_document.id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'IDENTITY_DOCUMENT_NOT_FOUND';
  END IF;
  IF p_side = 'front' THEN
    UPDATE public.identity_documents SET front_image_path = NULL, updated_at = now() WHERE id = v_document.id RETURNING * INTO v_new;
  ELSE
    UPDATE public.identity_documents SET back_image_path = NULL, updated_at = now() WHERE id = v_document.id RETURNING * INTO v_new;
  END IF;
  PERFORM private.audit('REMOVE_IDENTITY_DOCUMENT_IMAGE', 'identity_documents', v_document.id, to_jsonb(v_document), to_jsonb(v_new) || jsonb_build_object('side', p_side));
END $$;

-- Read one document for the detail panel. Returns null when none exists yet.
CREATE OR REPLACE FUNCTION public.get_identity_document(p_subject_type text, p_subject_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_document public.identity_documents;
BEGIN
  IF p_subject_type = 'acquisition' THEN
    SELECT * INTO v_document FROM public.identity_documents WHERE acquisition_id = p_subject_id;
  ELSIF p_subject_type = 'sale' THEN
    SELECT * INTO v_document FROM public.identity_documents WHERE sale_id = p_subject_id;
  ELSE
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SUBJECT';
  END IF;
  RETURN to_jsonb(v_document);
END $$;

-- Resolve the acquisition (seller) behind a vehicle so the detail page can show its CCCD panel.
CREATE OR REPLACE FUNCTION public.get_acquisition_for_vehicle(p_vehicle_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.acquisitions
  WHERE vehicle_id = p_vehicle_id AND status = 'COMPLETED'
  ORDER BY acquisition_date DESC, created_at DESC LIMIT 1;
  RETURN v_id;
END $$;

-- ============================================================
-- STEP 4: grants for the new RPCs
-- ============================================================

GRANT EXECUTE ON FUNCTION
  public.save_identity_document(jsonb),
  public.register_identity_document_image(text, uuid, text, text),
  public.remove_identity_document_image(text, uuid, text),
  public.get_identity_document(text, uuid),
  public.get_acquisition_for_vehicle(uuid)
TO authenticated;
