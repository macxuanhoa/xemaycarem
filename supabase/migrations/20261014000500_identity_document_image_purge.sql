-- Migration: 20261014000500_identity_document_image_purge.sql
-- Description: Gỡ hẳn một ảnh CCCD khỏi hồ sơ và khỏi kho lưu trữ.
--   * `remove_identity_document_image` (20261001003000) chỉ rút đường dẫn khỏi hàng
--     `identity_documents`; object vẫn nằm lại bucket `identity-documents` theo chính
--     sách retention, và chủ ý không có policy DELETE cho vai trò trình duyệt.
--   * CCCD là PII của người thật, nên "chụp nhầm / khách yêu cầu xóa" phải xóa được
--     ngay trong hồ sơ, không chờ dọn orphan. Nghiệp vụ giữ nguyên phạm vi:
--     OWNER/MANAGER, STAFF và tài khoản bị vô hiệu không bao giờ chạm tới.
--   * Bước ghi được tách làm hai nửa để vẫn tôn trọng cổng lưu trữ tập trung:
--     1) Trình duyệt DELETE chính object đang hiển thị trong hồ sơ. Policy
--        `identity_document_purge` chỉ cho phép khi `can_read_identity_document_image`
--        còn đúng — tức là lúc hồ sơ vẫn đang trỏ vào ảnh.
--     2) RPC `delete_identity_document_image` rút đường dẫn, ghi audit và TRẢ VỀ
--        chính đường dẫn đó để trình duyệt đối chiếu.
--   * Thứ tự "xóa tệp trước, rút tham chiếu sau" là bắt buộc, không phải tùy hứng:
--     PostgreSQL áp cả USING của policy SELECT lẫn policy DELETE khi thực thi DELETE
--     (Row Security Introduction, bảng "Policies for Commands"). Một object đã bị rút
--     tham chiếu vì thế không còn xóa được từ trình duyệt — đúng như ý đồ retention
--     của 20261001003000. Nếu nửa (2) lỗi thì ảnh đã biến mất khỏi kho, hàng đợi một
--     đường dẫn hỏng; người dùng bấm "Gỡ ảnh" lần nữa là hoàn tất, không bao giờ có
--     tình trạng hồ sơ trỏ vào ảnh vẫn còn đọc được trên kho.
-- Forward-only. Migration đã áp dụng `20261001003000_identity_documents.sql` không bị sửa.

-- ============================================================
-- STEP 1: policy DELETE cho object CCCD đang được hồ sơ tham chiếu
-- ============================================================

-- Tái sử dụng `can_read_identity_document_image` (OWNER/MANAGER + còn được tham chiếu)
-- thay vì viết helper riêng theo subject: khi purge diễn ra trước bước detach thì điều
-- kiện tham chiếu vẫn còn đúng, và policy đọc với policy xóa không bao giờ lệch nhau
-- về sau.
CREATE POLICY identity_document_purge ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'identity-documents' AND private.can_read_identity_document_image(name));

-- ============================================================
-- STEP 2: detach + audit, trả về đường dẫn vừa gỡ
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_document public.identity_documents;
  v_new public.identity_documents;
  v_path text;
BEGIN
  IF p_side NOT IN ('front', 'back') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SIDE';
  END IF;
  IF p_subject_type = 'acquisition' THEN
    SELECT * INTO v_document FROM public.identity_documents WHERE acquisition_id = p_subject_id FOR UPDATE;
  ELSIF p_subject_type = 'sale' THEN
    SELECT * INTO v_document FROM public.identity_documents WHERE sale_id = p_subject_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SUBJECT';
  END IF;
  IF v_document.id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'IDENTITY_DOCUMENT_NOT_FOUND';
  END IF;

  v_path := CASE WHEN p_side = 'front' THEN v_document.front_image_path ELSE v_document.back_image_path END;
  -- Idempotent: a double tap or a replay after the storage purge found nothing to
  -- detach. No audit, no error, no path — the caller simply has nothing to delete.
  IF v_path IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_side = 'front' THEN
    UPDATE public.identity_documents SET front_image_path = NULL, updated_at = now() WHERE id = v_document.id RETURNING * INTO v_new;
  ELSE
    UPDATE public.identity_documents SET back_image_path = NULL, updated_at = now() WHERE id = v_document.id RETURNING * INTO v_new;
  END IF;

  PERFORM private.audit('DELETE_IDENTITY_DOCUMENT_IMAGE', 'identity_documents', v_document.id,
    to_jsonb(v_document), to_jsonb(v_new) || jsonb_build_object('side', p_side, 'purged_path', v_path));

  RETURN v_path;
END $$;

REVOKE ALL ON FUNCTION public.delete_identity_document_image(text, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_identity_document_image(text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_identity_document_image(text, uuid, text) TO service_role;
