import { useEffect, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Images, ShieldAlert, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { compressImage } from "@/lib/imageCompression";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Button, Card, Field, Loading } from "@/components/ui";
import { toast } from "@/lib/toast";
import type { IdentityDocument, IdentitySubject } from "@/types";

type Side = "front" | "back";

/** CCCD nhập tay hoặc đọc từ ảnh chỉ còn chữ số khi đối chiếu; dấu phân cách là tolerated. */
const digitsOnly = (value: string) => value.replace(/[\s.-]/g, "");

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
  // Số CCCD là khóa để Camera thông minh tìm xe từ căn cước — thiếu nó thì quét
  // ảnh luôn báo "không tìm thấy" dù xe đã lưu căn cước. RPC ghi đè toàn bộ
  // hàng, nên mọi trường giấy tờ khác phải được gửi lại nguyên trạng.
  const [idNumberDraft, setIdNumberDraft] = useState<string | null>(null);
  // Ưu tiên bản người dùng đang gõ; chỉ đồng bộ từ dữ liệu tải về khi chưa chỉnh.
  const shownIdNumber = idNumberDraft ?? query.data?.id_number ?? "";
  const idNumber = digitsOnly(shownIdNumber);
  const idNumberInvalid = idNumber.length > 0 && !/^\d{12}$/.test(idNumber);
  const idNumberUnchanged =
    idNumberDraft === null || idNumber === (query.data?.id_number ?? "");

  const saveIdNumber = useMutation({
    mutationFn: () =>
      api.call("save_identity_document", {
        p_data: {
          subject_type: subjectType,
          subject_id: subjectId,
          full_name: query.data?.full_name ?? "",
          id_number: idNumber,
          dob: query.data?.dob ?? "",
          issued_date: query.data?.issued_date ?? "",
          place_of_issue: query.data?.place_of_issue ?? "",
          address: query.data?.address ?? "",
        },
      }),
    onSuccess: () => {
      setIdNumberDraft(null);
      client.invalidateQueries({ queryKey });
      toast.success(
        idNumber
          ? "Đã lưu số CCCD. Camera sẽ tìm được xe từ căn cước này."
          : "Đã xóa số CCCD khỏi hồ sơ.",
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Không lưu được số CCCD. Kiểm tra kết nối và thử lại.",
      ),
  });
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
      await api.uploadIdentityDocumentImage(
        subjectType,
        subjectId,
        side,
        compressed,
      );
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

  // Gỡ ảnh: trình duyệt xóa tệp trong kho trước khi RPC rút đường dẫn (kèm audit),
  // vì Postgres chỉ cho DELETE một object mà hồ sơ còn đang tham chiếu. Thao tác bất
  // khả nghịch nên luôn đi qua hộp thoại xác nhận — ảnh CCCD là giấy tờ pháp lý
  // của một người thật, bấm nhầm không cứu lại được.
  const remove = useMutation({
    mutationFn: ({ side, path }: { side: Side; path: string }) =>
      api.removeIdentityDocumentImage(subjectType, subjectId, side, path),
    onSuccess: async ({ purged }, { side }) => {
      await client.invalidateQueries({ queryKey });
      setManualSide(null);
      const label = side === "front" ? "mặt trước" : "mặt sau";
      if (purged)
        toast.success(`Đã gỡ ảnh ${label} khỏi hồ sơ và kho ảnh CCCD.`);
      else
        toast.warning(
          `Đã gỡ ảnh ${label} khỏi hồ sơ, nhưng tệp vẫn còn trong kho. Quản trị viên sẽ dọn theo chính sách lưu trữ.`,
        );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Không gỡ được ảnh. Kiểm tra kết nối và thử lại.",
      ),
  });

  const handleRemove = async (side: Side, label: string, path: string) => {
    const ok = await confirmAction({
      title: `Gỡ ảnh ${label.toLowerCase()} của ${personLabel.toLowerCase()}?`,
      entity: title,
      description:
        "Ảnh sẽ bị xóa hẳn khỏi kho lưu trữ và rút khỏi hồ sơ. Thao tác được ghi lại trong nhật ký kiểm toán, nhưng không thể hoàn tác — muốn gắn lại phải chụp ảnh mới.",
      confirmLabel: "Gỡ ảnh",
      cancelLabel: "Giữ lại",
      tone: "danger",
    });
    if (ok) remove.mutate({ side, path });
  };

  return (
    <Card>
      <div className="row between">
        <h2 className="section-title">{title}</h2>
        <span
          className="muted small"
          title="Chỉ Chủ cửa hàng và Quản lý được xem"
        >
          <ShieldAlert size={14} /> Bảo mật
        </span>
      </div>
      {query.isPending ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="identity-number-row">
            <Field
              label={`Số CCCD của ${personLabel.toLowerCase()}`}
              error={idNumberInvalid ? "Số CCCD phải đủ 12 chữ số." : undefined}
            >
              <input
                inputMode="numeric"
                autoComplete="off"
                placeholder="079123456789"
                value={shownIdNumber}
                onChange={(event) => setIdNumberDraft(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              disabled={
                idNumberInvalid || idNumberUnchanged || saveIdNumber.isPending
              }
              onClick={() => void saveIdNumber.mutate()}
            >
              {saveIdNumber.isPending ? "Đang lưu…" : "Lưu số"}
            </Button>
          </div>
          <p className="muted small">
            Camera chỉ tìm được xe từ căn cước khi hồ sơ có đủ 12 số này — ảnh
            không thôi chưa đủ.
          </p>
          <p className="muted small">
            Chụp hoặc chọn ảnh CCCD của {personLabel.toLowerCase()} theo thứ tự:
            mặt trước rồi mặt sau. Ảnh lưu riêng tư, chỉ hiển thị qua liên kết
            có thời hạn ngắn.
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
                <div
                  className={`identity-upload-slot${isActive ? " active" : ""}`}
                  key={side}
                >
                  <button
                    type="button"
                    className="identity-slot-body"
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
                      <IdentityPhoto
                        path={imagePath}
                        alt={`CCCD ${label.toLowerCase()}`}
                      />
                    ) : (
                      <span className="image-placeholder muted">
                        Chưa có ảnh
                      </span>
                    )}
                  </button>
                  {imagePath && (
                    <Button
                      variant="ghost"
                      className="small identity-slot-remove"
                      onClick={() => void handleRemove(side, label, imagePath)}
                      disabled={remove.isPending}
                      aria-label={`Gỡ ảnh CCCD ${label.toLowerCase()}`}
                      title="Gỡ ảnh này khỏi hồ sơ và xóa hẳn khỏi kho"
                    >
                      <Trash2 size={13} /> Gỡ ảnh
                    </Button>
                  )}
                </div>
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
              {/* Nhãn gọn, cân bằng hai trạng thái (Chụp ảnh/Chọn ảnh ↔ Chụp lại/Ảnh
                  khác) để bố cục hàng nút không đổi khi chuyển giữa mặt trước/sau. */}
              <label className="button secondary upload-button">
                <Images size={16} /> {targetFilled ? "Ảnh khác" : "Chọn ảnh"}
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
