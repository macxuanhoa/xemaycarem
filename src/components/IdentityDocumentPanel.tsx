import { useEffect, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Images, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { compressImage } from "@/lib/imageCompression";
import { Card, Loading } from "@/components/ui";
import type { IdentityDocument, IdentitySubject } from "@/types";

type Side = "front" | "back";

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
  // Sequential capture: the single pair of buttons always targets the next
  // pending side (front, then back). Tapping a slot re-points them there for a
  // retake, so the flow stays one camera + one gallery action for the whole card.
  const [manualSide, setManualSide] = useState<Side | null>(null);

  const uploadSide = async (side: Side, file: File) => {
    setUploadError("");
    try {
      // Guard on the persisted row id, not the object's truthiness: get_identity_document
      // returns an all-null jsonb object (not JSON null) before the first save, so a mere
      // `!query.data` check would skip the create and trip the Storage upload RLS policy
      // ("new row violates row-level security policy") that requires a registered row.
      if (!query.data?.id)
        await api.call("save_identity_document", {
          p_data: { subject_type: subjectType, subject_id: subjectId },
        });
      const compressed = await compressImage(file);
      await api.uploadIdentityDocumentImage(subjectType, subjectId, side, compressed);
      await client.invalidateQueries({ queryKey });
      setManualSide(null);
    } catch (reason) {
      setUploadError(
        reason instanceof Error
          ? reason.message
          : "Không tải được ảnh. Kiểm tra kết nối và thử lại.",
      );
    }
  };

  const document = query.data;
  const hasFront = Boolean(document?.front_image_path);
  const hasBack = Boolean(document?.back_image_path);
  const autoSide: Side = hasFront && !hasBack ? "back" : "front";
  const target = manualSide ?? autoSide;
  const targetLabel = target === "front" ? "Mặt trước" : "Mặt sau";
  const targetFilled = target === "front" ? hasFront : hasBack;

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void uploadSide(target, file);
  };

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
            Chụp hoặc chọn ảnh CCCD của {personLabel.toLowerCase()} theo thứ tự:
            mặt trước rồi mặt sau. Ảnh lưu riêng tư, chỉ hiển thị qua liên kết có
            thời hạn ngắn.
          </p>

          <div className="identity-uploads">
            {(["front", "back"] as const).map((side, index) => {
              const label = side === "front" ? "Mặt trước" : "Mặt sau";
              const imagePath =
                side === "front"
                  ? document?.front_image_path
                  : document?.back_image_path;
              const isActive = side === target;
              return (
                <button
                  type="button"
                  key={side}
                  className={`identity-upload-slot${isActive ? " active" : ""}`}
                  onClick={() => setManualSide(side)}
                  aria-pressed={isActive}
                  aria-label={`Chọn ${label.toLowerCase()} để chụp`}
                >
                  <span className="identity-slot-head">
                    <span className="identity-step-badge">
                      {imagePath ? <Check size={13} /> : index + 1}
                    </span>
                    <strong>{label}</strong>
                  </span>
                  {imagePath ? (
                    <IdentityPhoto path={imagePath} alt={`CCCD ${label.toLowerCase()}`} />
                  ) : (
                    <span className="image-placeholder muted">Chưa có ảnh</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="identity-action-bar">
            <span className="muted small">
              Đang thêm: <strong>{targetLabel}</strong>
            </span>
            <div className="identity-upload-actions">
              <label className="button secondary upload-button">
                <Camera size={16} /> {targetFilled ? "Chụp lại" : "Chụp ảnh"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  aria-label={`Chụp ảnh CCCD ${targetLabel.toLowerCase()}`}
                  onChange={onPick}
                />
              </label>
              <label className="button secondary upload-button">
                <Images size={16} /> {targetFilled ? "Ảnh khác" : "Thư viện ảnh"}
                <input
                  type="file"
                  accept="image/*"
                  aria-label={`Chọn ảnh CCCD ${targetLabel.toLowerCase()} từ thư viện`}
                  onChange={onPick}
                />
              </label>
            </div>
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
