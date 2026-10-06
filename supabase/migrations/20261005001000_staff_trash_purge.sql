-- Migration: 20261005001000_staff_trash_purge.sql
-- Description: Nhân sự thùng rác — đánh dấu tài khoản đã "dọn vĩnh viễn".
--   * Xóa mềm (delete) đặt deleted_at => vào thùng rác, khôi phục được trong 30 ngày.
--   * Quá 30 ngày (sweep khi OWNER mở trang Nhân sự) hoặc "Xóa luôn mất luôn" (purge):
--       - Tài khoản CHƯA phát sinh nghiệp vụ: xóa sạch profile + auth (xử lý ở Edge).
--       - Tài khoản ĐÃ có lịch sử nghiệp vụ: tombstone — giữ profile để đối soát, đặt
--         purged_at, đăng nhập đã bị chặn bởi deleted_at, không khôi phục được.
--   Không xóa auth.users bằng SQL (FK profiles.id -> auth.users là ON DELETE RESTRICT,
--   và xóa raw SQL làm hỏng GoTrue), nên tombstone giữ nguyên hàng auth nhưng không login được.
-- Forward-only. list_profiles dùng to_jsonb(profiles) nên cột mới tự động có trong output.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

COMMENT ON COLUMN public.profiles.purged_at IS
  'Thời điểm tài khoản thùng rác bị dọn vĩnh viễn. NULL = chưa dọn; đã set = tombstone, không khôi phục.';

COMMIT;
