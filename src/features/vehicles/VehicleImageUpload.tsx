import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Upload, X } from "lucide-react";
import { api } from "@/lib/api";
import { compressImage } from "@/lib/imageCompression";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui";

type UploadItem = {
  id: number;
  file: File;
  preview: string;
  state: "waiting" | "uploading" | "uploaded" | "error";
  error?: string;
};
const labels = {
  waiting: "Chờ tải",
  uploading: "Đang tải…",
  uploaded: "Đã tải",
  error: "Chưa tải được",
};
// Small pools stay fast on mobile networks without overwhelming Supabase
// Storage; beyond three in flight the gains flatten and errors cluster.
const UPLOAD_CONCURRENCY = 3;

export function VehicleImageUpload({
  vehicleId,
  isChoiceOpen,
  onCloseChoice,
}: {
  vehicleId: string;
  isChoiceOpen?: boolean;
  onCloseChoice?: () => void;
  onOpenChoice?: () => void;
}) {
  const client = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [error, setError] = useState("");
  const serial = useRef(0);
  // Photos are compressed and uploaded through a small concurrent pool instead
  // of one strict serial chain: a 20-photo batch no longer waits for each
  // previous upload (and its gallery refetch) before the next one starts.
  // Selection order is still preserved because the queue is drained FIFO.
  const queue = useRef<UploadItem[]>([]);
  const active = useRef(0);
  const mounted = useRef(true);
  const urls = useRef<string[]>([]);
  const pending = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // Counts of the current in-flight batch so we can announce one concise
  // confirmation once every queued photo settles.
  const batch = useRef({ ok: 0, fail: 0 });
  useEffect(() => {
    mounted.current = true;
    const previewUrls = urls.current;
    const unload = (event: BeforeUnloadEvent) => {
      if (pending.current > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const update = (id: number, state: UploadItem["state"], error?: string) => {
    if (mounted.current)
      setItems((old) =>
        old.map((item) => (item.id === id ? { ...item, state, error } : item)),
      );
  };
  // A photo that uploaded successfully must leave the queue immediately: the
  // gallery below already re-renders it via the vehicle query invalidation, so
  // keeping it here would show the same image twice (the "3 uploads become 6" bug).
  const retire = (item: UploadItem) => {
    URL.revokeObjectURL(item.preview);
    urls.current = urls.current.filter((url) => url !== item.preview);
    if (mounted.current)
      setItems((old) => old.filter((row) => row.id !== item.id));
  };
  const announce = () => {
    const { ok, fail } = batch.current;
    batch.current = { ok: 0, fail: 0 };
    if (ok)
      toast.success(
        ok === 1 ? "Đã tải ảnh lên xe." : `Đã tải ${ok} ảnh lên xe.`,
      );
    if (fail)
      toast.error(
        fail === 1
          ? "1 ảnh chưa tải được. Bấm nút Thử lại trên ảnh đó."
          : `${fail} ảnh chưa tải được. Bấm nút Thử lại trên từng ảnh.`,
      );
  };
  const runOne = async (item: UploadItem) => {
    try {
      update(item.id, "uploading");
      const compressed = await compressImage(item.file);
      await api.uploadVehicleImage(vehicleId, compressed);
      batch.current.ok++;
      retire(item);
      // Refresh the gallery in the background: awaiting it here used to stall
      // the whole queue behind one refetch per photo.
      void client.invalidateQueries({ queryKey: ["vehicle", vehicleId] });
    } catch (reason) {
      batch.current.fail++;
      update(
        item.id,
        "error",
        reason instanceof Error
          ? reason.message
          : "Không tải được ảnh. Thử lại khi có mạng.",
      );
    } finally {
      pending.current--;
      if (pending.current === 0) {
        // Final guaranteed refetch so the gallery is accurate even if an
        // earlier background invalidation raced with an in-flight fetch.
        void client.invalidateQueries({ queryKey: ["vehicle", vehicleId] });
        announce();
      }
    }
  };
  const pump = () => {
    while (active.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const item = queue.current.shift() as UploadItem;
      active.current++;
      void runOne(item).finally(() => {
        active.current--;
        pump();
      });
    }
  };
  const schedule = (item: UploadItem) => {
    pending.current++;
    update(item.id, "waiting");
    queue.current.push(item);
    pump();
  };
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (
      files.some(
        (file) =>
          !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
          file.size > 20 * 1024 * 1024,
      )
    ) {
      setError(
        "Chọn ảnh JPG, PNG, WebP tối đa 20 MB. Ảnh sẽ được nén trước khi tải.",
      );
      return;
    }
    setError("");
    const next = files.map((file) => {
      const preview = URL.createObjectURL(file);
      urls.current.push(preview);
      return { id: ++serial.current, file, preview, state: "waiting" as const };
    });
    setItems((old) => [...old, ...next]);
    next.forEach(schedule);
  };
  return (
    <div className="stack vehicle-image-upload">
      {/* Hidden native inputs */}
      <input
        ref={fileInputRef}
        aria-label="Thêm ảnh xe từ thiết bị"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={choose}
      />
      <input
        ref={cameraInputRef}
        aria-label="Chụp ảnh xe bằng máy ảnh"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        style={{ display: "none" }}
        onChange={choose}
      />

      {/* Choice Modal */}
      {isChoiceOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={onCloseChoice}
        >
          <div
            className="dialog-panel photo-choice-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="photo-choice-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="photo-choice-header">
              <h3 id="photo-choice-title">Thêm ảnh cho xe</h3>
              <button
                type="button"
                className="icon-button"
                aria-label="Đóng"
                onClick={onCloseChoice}
              >
                <X size={18} />
              </button>
            </div>
            <div className="photo-choice-options">
              <button
                type="button"
                className="photo-choice-btn photo-choice-camera"
                onClick={() => {
                  onCloseChoice?.();
                  cameraInputRef.current?.click();
                }}
              >
                <div className="photo-choice-icon">
                  <Camera size={24} />
                </div>
                <div className="photo-choice-info">
                  <span className="photo-choice-title">Chụp ảnh bằng camera</span>
                  <span className="photo-choice-desc">
                    Mở camera điện thoại để chụp ảnh xe tải lên ngay
                  </span>
                </div>
              </button>
              <button
                type="button"
                className="photo-choice-btn photo-choice-device"
                onClick={() => {
                  onCloseChoice?.();
                  fileInputRef.current?.click();
                }}
              >
                <div className="photo-choice-icon">
                  <Upload size={24} />
                </div>
                <div className="photo-choice-info">
                  <span className="photo-choice-title">Tải ảnh lên từ thiết bị</span>
                  <span className="photo-choice-desc">
                    Chọn một hoặc nhiều ảnh từ thư viện ảnh máy bạn
                  </span>
                </div>
              </button>
            </div>
            <div className="dialog-actions">
              <Button variant="secondary" onClick={onCloseChoice}>
                Hủy
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!!items.length && (
        <div className="upload-preview-list">
          {items.map((item) => (
            <div className="upload-preview-item" key={item.id}>
              <img
                src={item.preview}
                alt={`Ảnh xe đang tải: ${item.file.name}`}
              />
              <span
                className={`upload-status upload-status-${item.state}`}
                role="status"
              >
                {labels[item.state]}
              </span>
              {item.state === "error" && (
                <>
                  <small className="field-error">{item.error}</small>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => schedule(item)}
                  >
                    Thử lại ảnh
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
