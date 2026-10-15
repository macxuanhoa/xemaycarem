import { useQuery } from "@tanstack/react-query";
import { Bike } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Ảnh đại diện thu nhỏ cho một chiếc xe trong danh sách. list_vehicles chỉ trả
 * `primary_image_path` (đường dẫn tương đối), còn URL ký ngắn hạn lấy qua cổng
 * lưu trữ tập trung (api.imageUrl) — đúng cùng queryKey ["vehicle-image", path]
 * mà trang chi tiết dùng, nên hai nơi dùng chung cache, không ký lại.
 *
 * Không có ảnh / đang ký URL / ký thất bại đều rơi về ô icon Bike, giữ thẻ luôn
 * có khung hình vuông đều nhau (đúng layout ngang) thay vì sập chiều cao.
 */
export function VehicleThumb({
  path,
  alt,
}: {
  path?: string | null;
  alt: string;
}) {
  const { data, isError } = useQuery({
    queryKey: ["vehicle-image", path],
    queryFn: () => api.imageUrl(path as string),
    enabled: !!path,
    staleTime: 4 * 60 * 1000,
  });
  const url = path && !isError ? data : undefined;
  return (
    <span className="record-thumb" aria-hidden="true">
      {url ? (
        <img src={url} alt={alt} loading="lazy" decoding="async" />
      ) : (
        <Bike size={22} />
      )}
    </span>
  );
}

export default VehicleThumb;
