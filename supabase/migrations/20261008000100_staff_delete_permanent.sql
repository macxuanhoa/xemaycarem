-- Migration: 20261008000100_staff_delete_permanent.sql
-- Description: Xóa nhân sự theo yêu cầu chủ cửa hàng — bấm "Xóa tài khoản" là xóa NGAY khỏi hệ thống,
--   không còn thùng rác 30 ngày và không có khôi phục. Hai nhánh:
--     * Tài khoản CHƯA để lại dấu vết nghiệp vụ: xóa sạch hồ sơ + tài khoản đăng nhập (xóa ở Edge).
--     * Tài khoản ĐÃ có lịch sử: giữ hàng `profiles` làm mộ (tombstone) để xe/bán/chi phí/nhật ký
--       vẫn truy vết được người làm, nhưng đăng nhập bị chặn và tài khoản biến mất khỏi trang Nhân sự.
--   * list_profiles: ẩn mọi hàng đã bị đánh dấu xóa (`deleted_at` hoặc `purged_at`) — "xóa là không còn thấy".
--   * check_user_can_hard_delete: quét ĐẦY ĐỦ các bảng tham chiếu tới profiles (trước đây chỉ bảy bảng),
--     nên phán quyết "chưa có lịch sử" không còn để Edge đụng FK violation giữa chừng khi xóa sạch.
--   * purged_at đổi nghĩa: dấu "đã xóa vĩnh viễn" ghi ngay khi chủ bấm xóa (thay vì sau hạn thùng rác).
-- Forward-only. Không xóa dữ liệu, không sửa migration đã áp.

BEGIN;

COMMENT ON COLUMN public.profiles.purged_at IS
  'Tài khoản đã bị xóa vĩnh viễn khỏi hệ thống (mộ). Hàng profiles giữ lại chỉ để đối soát lịch sử; không đăng nhập được, không khôi phục được.';

-- Trang Nhân sự chỉ còn listing tài khoản đang dùng được.
CREATE OR REPLACE FUNCTION public.list_profiles() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=private.require_role(array['OWNER']::public.user_role[]); v_result jsonb;
BEGIN
  select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('email',u.email) order by p.created_at),'[]'::jsonb) into v_result
  from public.profiles p join auth.users u on u.id=p.id
  where p.deleted_at is null and p.purged_at is null;
  return v_result;
END $$;

-- Phán quyết "có thể xóa sạch hay không" phải nhìn thấy MỌI tham chiếu không cascade tới profiles,
-- gồm cả cột cancel/verify/lease (chỉ được ghi khi người đó thao tác) và nhật ký hoạt động.
CREATE OR REPLACE FUNCTION public.check_user_can_hard_delete(p_user_id UUID) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_caller uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_target public.profiles;
BEGIN
  SELECT * INTO v_target FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  END IF;

  IF v_target.role = 'OWNER' THEN
    RETURN jsonb_build_object('can_delete', false, 'reason', 'CANNOT_DELETE_OWNER', 'message', 'Không thể xóa tài khoản Chủ cửa hàng.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.acquisitions WHERE created_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicles WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_financials WHERE updated_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE created_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_images WHERE created_by = p_user_id OR deleted_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_activity WHERE user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.sales WHERE sold_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.payments WHERE created_by = p_user_id OR voided_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.payment_receipts WHERE created_by = p_user_id OR verified_by = p_user_id)
    OR EXISTS (SELECT 1 FROM private.payment_receipt_requests WHERE actor_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.business_expenses WHERE created_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.customer_communications WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.message_outbox WHERE created_by = p_user_id OR lease_actor = p_user_id)
    OR EXISTS (SELECT 1 FROM public.identity_documents WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.system_announcements WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.system_settings WHERE updated_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.audit_logs WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object(
      'can_delete', false,
      'reason', 'USER_HAS_BUSINESS_HISTORY',
      'message', 'Tài khoản này đã ghi nhận nghiệp vụ. Hệ thống xóa tài khoản đăng nhập nhưng giữ hồ sơ để đối soát.'
    );
  END IF;

  RETURN jsonb_build_object('can_delete', true);
END $$;

GRANT EXECUTE ON FUNCTION public.check_user_can_hard_delete(UUID) TO authenticated;

COMMIT;
