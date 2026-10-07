import { useEffect, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronLeft, ChevronRight, X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button, ErrorState } from "@/components/ui";
import type { VehicleImage } from "@/types";

/**
 * Ảnh xe hiển thị dạng bộ sưu tập có ảnh lớn: một ảnh chính chiếm chỗ cố định,
 * dải thu nhỏ nằm ngang bên dưới và ảnh xem lớn toàn màn hình. Số ảnh nhiều
 * đến đâu trang chi tiết cũng không dài thêm theo chiều dọc.
 */
export function VehiclePhotoDisplay({
  photos,
  vehicleName,
  removable,
}: {
  photos: VehicleImage[];
  vehicleName: string;
  removable: boolean;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const urls = useQueries({
    queries: photos.map((photo) => ({
      queryKey: ["vehicle-image", photo.storage_path],
      queryFn: () => api.imageUrl(photo.storage_path),
      staleTime: 4 * 60 * 1000,
    })),
  });
  const count = photos.length;
  // Ảnh vừa bị gỡ có thể đẩy chỉ số cũ ra ngoài danh sách — kẹp lại mọi lần render.
  const current = Math.min(selected, Math.max(count - 1, 0));
  const photo = photos[current];
  const query = urls[current];
  const remove = useMutation({
    mutationFn: () => api.call("remove_vehicle_image", { p_id: photo.id }),
    onSuccess: () => {
      toast.success("Đã gỡ ảnh khỏi xe.");
      setConfirm(false);
      client.invalidateQueries();
    },
  });
  const step = (delta: number) => {
    setConfirm(false);
    setSelected((current + delta + count) % count);
  };
  // Điều hướng bằng phím chỉ bật khi ảnh xem lớn đang mở, tránh xung đột
  // với phím tắt toàn trang (palette tìm kiếm, Escape đóng drawer...).
  useEffect(() => {
    if (!zoom) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoom(false);
      else if (count > 1 && event.key === "ArrowRight") step(1);
      else if (count > 1 && event.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, current, count]);
  if (!count) return null;
  const stage = (
    <div className="vehicle-display-stage">
      {query?.data ? (
        <button
          type="button"
          className="vehicle-display-main"
          onClick={() => setZoom(true)}
          aria-label={`Xem lớn ảnh ${current + 1}/${count}`}
          title="Xem lớn"
        >
          <img src={query.data} alt={vehicleName} />
        </button>
      ) : (
        <div className="image-placeholder">
          <Camera size={28} />
          <span>
            {query?.isError ? "Không tải được ảnh" : "Đang tải ảnh…"}
          </span>
        </div>
      )}
      {count > 1 && (
        <>
          <button
            type="button"
            className="vehicle-display-nav vehicle-display-nav-prev"
            aria-label="Ảnh trước"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            className="vehicle-display-nav vehicle-display-nav-next"
            aria-label="Ảnh tiếp theo"
            onClick={() => step(1)}
          >
            <ChevronRight size={20} />
          </button>
          <span className="vehicle-display-count">
            {current + 1}/{count}
          </span>
        </>
      )}
    </div>
  );
  return (
    <div className="vehicle-display">
      {stage}
      {count > 1 && (
        <div className="vehicle-display-thumbs" aria-label="Dải ảnh thu nhỏ">
          {photos.map((item, index) => {
            const thumbUrl = urls[index]?.data;
            return thumbUrl ? (
              <button
                key={item.id}
                type="button"
                className={`vehicle-display-thumb${index === current ? " is-active" : ""}`}
                aria-label={`Hiển thị ảnh ${index + 1}/${count}`}
                aria-current={index === current}
                onClick={() => {
                  setSelected(index);
                  setConfirm(false);
                }}
              >
                <img src={thumbUrl} alt="" loading="lazy" />
              </button>
            ) : (
              <span
                key={item.id}
                className="vehicle-display-thumb is-empty"
                aria-hidden="true"
              />
            );
          })}
        </div>
      )}
      {removable && (
        <div className="photo-actions">
          {confirm ? (
            <>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Gỡ ảnh
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Giữ lại
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Gỡ ảnh này
            </Button>
          )}
        </div>
      )}
      {remove.isError && <ErrorState error={remove.error} />}
      {zoom && query?.data && (
        <div
          className="vehicle-display-lightbox"
          role="button"
          tabIndex={0}
          aria-label="Đóng ảnh xem lớn"
          onClick={() => setZoom(false)}
        >
          <img
            src={query.data}
            alt={vehicleName}
            onClick={(event) => event.stopPropagation()}
          />
          {count > 1 && (
            <>
              <button
                type="button"
                className="vehicle-display-nav vehicle-display-nav-prev"
                aria-label="Ảnh trước"
                onClick={(event) => {
                  event.stopPropagation();
                  step(-1);
                }}
              >
                <ChevronLeft size={24} />
              </button>
              <button
                type="button"
                className="vehicle-display-nav vehicle-display-nav-next"
                aria-label="Ảnh tiếp theo"
                onClick={(event) => {
                  event.stopPropagation();
                  step(1);
                }}
              >
                <ChevronRight size={24} />
              </button>
              <span className="vehicle-display-count">{current + 1}/{count}</span>
            </>
          )}
          <button
            type="button"
            className="vehicle-display-close"
            aria-label="Đóng ảnh xem lớn"
            onClick={() => setZoom(false)}
          >
            <X size={22} />
          </button>
        </div>
      )}
    </div>
  );
}
