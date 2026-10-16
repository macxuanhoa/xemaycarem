import { useDialog } from "@/lib/useDialog";
import { Button } from "./button";

/** Tấm ảnh đang chờ người dùng tự lưu, kèm chú thích đọc được trên iOS. */
export type PhotoSaveSheetRequest = { url: string; caption: string };

/**
 * Khung "nhấn giữ để lưu" cho iPhone/iPad không mở được bảng chia sẻ của hệ điều
 * hành (Safari đời cũ, hoặc trang đang mở trong trình duyệt nhúng của app nhắn
 * tin). Ở đó tải tệp chỉ đưa ảnh sang app FILES xa xôi chứ không vào Bộ sưu tập,
 * còn nhấn giữ ảnh là thao tác duy nhất một trang web ghi được vào Photos.
 *
 * Ảnh hiển thị nguyên tấm qua chính liên kết ký đang dùng, và menu ngữ cảnh của
 * ảnh được bật thẳng tay (-webkit-touch-callout) để cú nhấn giữ không bị nuốt.
 */
export function PhotoSaveSheet({
  request,
  onClose,
}: {
  request: PhotoSaveSheetRequest | null;
  onClose: () => void;
}) {
  const panelRef = useDialog(!!request, onClose);
  if (!request) return null;
  return (
    <div
      className="dialog-backdrop photo-save-sheet-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="dialog-panel photo-save-sheet"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Lưu ảnh vào Bộ sưu tập"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="photo-save-sheet-lead">
          <strong>Nhấn giữ vào ảnh</strong> rồi chọn{" "}
          <strong>“Thêm vào Ảnh”</strong> để ảnh hiện trong Bộ sưu tập.
        </p>
        <img
          className="photo-save-sheet-img"
          src={request.url}
          alt={request.caption}
        />
        <p className="photo-save-sheet-caption muted small">
          {request.caption}
        </p>
        <Button variant="secondary" data-dialog-initial-focus onClick={onClose}>
          Đã hiểu
        </Button>
      </div>
    </div>
  );
}
