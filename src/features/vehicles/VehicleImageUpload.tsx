import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Upload } from "lucide-react";
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

export function VehicleImageUpload({ vehicleId }: { vehicleId: string }) {
  const client = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const chain = useRef(Promise.resolve());
  const mounted = useRef(true);
  const urls = useRef<string[]>([]);
  const pending = useRef(0);
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
  const schedule = (item: UploadItem) => {
    pending.current++;
    update(item.id, "waiting");
    chain.current = chain.current.then(async () => {
      try {
        update(item.id, "uploading");
        const compressed = await compressImage(item.file);
        await api.uploadVehicleImage(vehicleId, compressed);
        batch.current.ok++;
        retire(item);
        await client.invalidateQueries({ queryKey: ["vehicle", vehicleId] });
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
        if (pending.current === 0) announce();
      }
    });
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
      <div className="row">
        <label className="button secondary upload-button">
          <Upload size={16} /> Thêm ảnh
          <input
            aria-label="Thêm ảnh xe"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={choose}
          />
        </label>
        <label className="button secondary upload-button">
          <Camera size={16} /> Chụp ảnh xe
          <input
            aria-label="Chụp ảnh xe"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={choose}
          />
        </label>
      </div>
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
