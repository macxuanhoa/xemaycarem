// Thẻ xem trước "như bài Facebook thật": avatar quán, dòng tên + quyền riêng tư,
// caption giữ nguyên xuống dòng, lưới ảnh theo lối FB. Người bán quyết định đăng
// hay không khi nhìn bài CỦA MÌNH chứ không phải nhìn một textarea trần.
//
// Card này KHÔNG có nút Đăng và không tự gọi Facebook — nó chỉ trưng nội dung.
// Hành động (chuyển bài, lưu nháp, sửa) do trang truyền vào qua `footer`.

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, MoreHorizontal } from "lucide-react";
import { api } from "@/lib/api";

/** Ký URL ảnh tư nhân ngắn hạn — mỗi ảnh một query, STALE 4 phút cho đỡ tốn. */
export function useVehicleImageUrl(path: string | undefined) {
  const query = useQuery({
    queryKey: ["vehicle-image", path],
    queryFn: () => api.imageUrl(path as string),
    enabled: !!path,
    staleTime: 4 * 60 * 1000,
  });
  return query.data ?? null;
}

function MediaCell({ path, order }: { path: string; order: number }) {
  const url = useVehicleImageUrl(path);
  return (
    <figure>
      {url ? (
        <img src={url} alt={`Ảnh xe ${order}`} loading="lazy" />
      ) : (
        <span className="ps-image-empty">…</span>
      )}
    </figure>
  );
}

function MediaGrid({ paths, maxVisible }: { paths: string[]; maxVisible: number }) {
  const shown = paths.slice(0, maxVisible);
  const extra = paths.length - shown.length;
  const layout =
    shown.length === 1 ? "is-single" : shown.length >= 5 ? "is-many" : "";
  return (
    <div className={`fb-post-media ${layout}`.trim()}>
      {shown.map((path, index) => (
        <MediaCell key={path} path={path} order={index + 1} />
      ))}
      {extra > 0 && (
        <span className="fb-post-more" aria-hidden="true">
          +{extra}
        </span>
      )}
    </div>
  );
}

export type FacebookPostCardProps = {
  caption: string;
  /** Tên hiện trên bài: thường là tên quán (lấy từ context/store settings). */
  authorName: string;
  /** Dòng dưới tên: "Bây giờ · Công khai", hoặc nhãn trạng thái nháp. */
  metaLine: string;
  imagePaths?: string[];
  /** FB hiển thị tối đa 5 ảnh trong khung xem trước; phần còn lại tính "+n". */
  maxVisibleImages?: number;
  /** Có hàm này → caption hiện trong ô sửa được (bản chưa chốt vẫn phải sửa được). */
  onEdit?: (value: string) => void;
  ariaLabel?: string;
  /** Hành động dưới bài (chuyển Facebook, lưu nháp, copy…). */
  footer?: ReactNode;
  /** Dòng trạng thái chuyển bài, đặt sát hành động để người dùng thấy ngay. */
  status?: ReactNode;
  /** Nhãn phụ ở góc thẻ, ví dụ "Nháp", "Đã duyệt". */
  badge?: ReactNode;
};

export function FacebookPostCard({
  caption,
  authorName,
  metaLine,
  imagePaths = [],
  maxVisibleImages = 5,
  onEdit,
  ariaLabel,
  footer,
  status,
  badge,
}: FacebookPostCardProps) {
  return (
    <article className="fb-post">
      <header className="fb-post-head">
        <img className="fb-avatar" src="/logo.jpg" alt="" width={40} height={40} />
        <div className="fb-post-who">
          <span className="fb-post-name">{authorName}</span>
          <span className="fb-post-meta">
            {metaLine} · <Globe size={12} aria-hidden="true" />
          </span>
        </div>
        {badge}
        {footer ? null : <MoreHorizontal size={18} aria-hidden="true" />}
      </header>
      <div className="fb-post-body">
        {onEdit ? (
          <textarea
            className="fb-post-edit"
            rows={Math.min(14, Math.max(5, caption.split("\n").length + 2))}
            value={caption}
            aria-label={ariaLabel ?? "Nội dung bài đăng"}
            onChange={(event) => onEdit(event.target.value)}
          />
        ) : (
          <p className="fb-post-caption" aria-label={ariaLabel}>
            {caption}
          </p>
        )}
      </div>
      {imagePaths.length ? (
        <MediaGrid paths={imagePaths} maxVisible={maxVisibleImages} />
      ) : (
        <p className="fb-post-empty">
          Bài này chưa có ảnh — lên Facebook bạn nên đính kèm ảnh xe thật để khách dễ tin.
        </p>
      )}
      {(footer || status) && (
        <footer className="fb-post-foot">
          {footer}
          {status}
        </footer>
      )}
    </article>
  );
}

export default FacebookPostCard;
