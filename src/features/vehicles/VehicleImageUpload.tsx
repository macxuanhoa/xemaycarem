import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { compressImage } from "@/lib/imageCompression";
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
  const schedule = (item: UploadItem) => {
    pending.current++;
    update(item.id, "waiting");
    chain.current = chain.current.then(async () => {
      try {
        update(item.id, "uploading");
        const compressed = await compressImage(item.file);
        await api.uploadVehicleImage(vehicleId, compressed);
        update(item.id, "uploaded");
        await client.invalidateQueries({ queryKey: ["vehicle", vehicleId] });
      } catch (reason) {
        update(
          item.id,
          "error",
          reason instanceof Error
            ? reason.message
            : "Không tải được ảnh. Thử lại khi có mạng.",
        );
      } finally {
        pending.current--;
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
              <span role="status">{labels[item.state]}</span>
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
