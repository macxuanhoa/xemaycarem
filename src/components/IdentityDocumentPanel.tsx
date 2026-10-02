import { useEffect, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Images, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { compressImage } from "@/lib/imageCompression";
import { Card, Loading } from "@/components/ui";
import type { IdentityDocument, IdentitySubject } from "@/types";

/** Loads a private CCCD image through a short-lived signed URL, never a public link. */
function IdentityPhoto({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setUrl(null);
    setError("");
    api
      .identityImageUrl(path)
      .then((next) => active && setUrl(next))
      .catch(
        (reason) =>
          active &&
          setError(
            reason instanceof Error ? reason.message : "Không tải được ảnh",
          ),
      );
    return () => {
      active = false;
    };
  }, [path]);
  if (error)
    return (
      <p className="field-error" role="alert">
        {error}
      </p>
    );
  if (!url)
    return (
      <div className="image-placeholder">
        <Loading />
      </div>
    );
  return <img src={url} alt={alt} className="identity-photo" />;
}

/**
 * CCCD capture for the legal owner on one side of a deal: the seller on an
 * acquisition, the buyer on a sale. The whole panel is sensitive — the caller
 * renders it only for OWNER/MANAGER, and the server re-checks the role on every
 * read and write. STAFF and disabled accounts never receive this data.
 */
export function IdentityDocumentPanel({
  subjectType,
  subjectId,
  title = "Căn cước công dân",
  personLabel = "Người bán",
}: {
  subjectType: IdentitySubject;
  subjectId: string;
  title?: string;
  personLabel?: string;
}) {
  const client = useQueryClient();
  const queryKey = ["identity-document", subjectType, subjectId];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      api.call<IdentityDocument | null>("get_identity_document", {
        p_subject_type: subjectType,
        p_subject_id: subjectId,
      }),
  });
  // Photo-only capture: the document row is created lazily, empty, right before
  // the first upload because the Storage policy requires a registered row.
  const [uploadError, setUploadError] = useState("");

  const uploadSide = async (side: "front" | "back", file: File) => {
    setUploadError("");
    try {
      if (!query.data)
        await api.call("save_identity_document", {
          p_data: { subject_type: subjectType, subject_id: subjectId },
        });
      const compressed = await compressImage(file);
      await api.uploadIdentityDocumentImage(subjectType, subjectId, side, compressed);
      await client.invalidateQueries({ queryKey });
    } catch (reason) {
      setUploadError(
        reason instanceof Error
          ? reason.message
          : "Không tải được ảnh. Kiểm tra kết nối và thử lại.",
      );
    }
  };

  const onPick =
    (side: "front" | "back") => (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void uploadSide(side, file);
    };

  const document = query.data;

  return (
    <Card>
      <div className="row between">
        <h2 className="section-title">{title}</h2>
        <span className="muted small" title="Chỉ Chủ cửa hàng và Quản lý được xem">
          <ShieldAlert size={14} /> Bảo mật
        </span>
      </div>
      {query.isPending ? (
        <Loading />
      ) : (
        <div className="stack">
          <p className="muted small">
            Ảnh CCCD của {personLabel.toLowerCase()}, chụp hoặc chọn từ thư viện
            ảnh. Ảnh lưu riêng tư, chỉ hiển thị qua liên kết có thời hạn ngắn.
          </p>

          <div className="identity-uploads">
            {(["front", "back"] as const).map(side => {
              const sideLabel = side === "front" ? "mặt trước" : "mặt sau";
              const imagePath =
                side === "front"
                  ? document?.front_image_path
                  : document?.back_image_path;
              return (
                <div className="identity-upload-slot" key={side}>
                  <strong>
                    {side === "front" ? "Mặt trước" : "Mặt sau"}
                  </strong>
                  {imagePath ? (
                    <IdentityPhoto path={imagePath} alt={`CCCD ${sideLabel}`} />
                  ) : (
                    <div className="image-placeholder muted">Chưa có ảnh</div>
                  )}
                  <div className="identity-upload-actions">
                    <label className="button secondary upload-button">
                      <Camera size={16} />{" "}
                      {imagePath ? "Chụp lại" : "Chụp ảnh"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        capture="environment"
                        aria-label={`Chụp ảnh CCCD ${sideLabel}`}
                        onChange={onPick(side)}
                      />
                    </label>
                    <label className="button secondary upload-button">
                      <Images size={16} />{" "}
                      {imagePath ? "Ảnh khác" : "Thư viện ảnh"}
                      <input
                        type="file"
                        accept="image/*"
                        aria-label={`Chọn ảnh CCCD ${sideLabel} từ thư viện`}
                        onChange={onPick(side)}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          {uploadError && (
            <p className="field-error" role="alert">
              {uploadError}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
