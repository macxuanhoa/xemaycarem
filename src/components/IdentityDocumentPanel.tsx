import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { compressImage } from "@/lib/imageCompression";
import { Button, Card, ErrorState, Field, Loading } from "@/components/ui";
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

type FormState = {
  full_name: string;
  id_number: string;
  dob: string;
  issued_date: string;
  place_of_issue: string;
  address: string;
};
const emptyForm: FormState = {
  full_name: "",
  id_number: "",
  dob: "",
  issued_date: "",
  place_of_issue: "",
  address: "",
};

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
  const [form, setForm] = useState<FormState>(emptyForm);
  const [uploadError, setUploadError] = useState("");
  const hydrated = useRef(false);
  useEffect(() => {
    if (query.data && !hydrated.current) {
      hydrated.current = true;
      setForm({
        full_name: query.data.full_name ?? "",
        id_number: query.data.id_number ?? "",
        dob: query.data.dob ?? "",
        issued_date: query.data.issued_date ?? "",
        place_of_issue: query.data.place_of_issue ?? "",
        address: query.data.address ?? "",
      });
    }
  }, [query.data]);

  const set = (key: keyof FormState, value: string) =>
    setForm((old) => ({ ...old, [key]: value }));

  const save = useMutation({
    mutationFn: () =>
      api.call("save_identity_document", {
        p_data: { subject_type: subjectType, subject_id: subjectId, ...form },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });

  const uploadSide = async (side: "front" | "back", file: File) => {
    setUploadError("");
    try {
      // A document row must exist before the Storage upload policy will accept it.
      if (!query.data)
        await api.call("save_identity_document", {
          p_data: {
            subject_type: subjectType,
            subject_id: subjectId,
            ...form,
          },
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
            Hồ sơ pháp lý của {personLabel.toLowerCase()}. Ảnh CCCD lưu riêng tư,
            chỉ hiển thị qua liên kết có thời hạn ngắn.
          </p>
          <div className="form-grid">
            <Field label="Họ và tên trên CCCD">
              <input
                value={form.full_name}
                maxLength={200}
                onChange={(e) => set("full_name", e.target.value)}
              />
            </Field>
            <Field label="Số CCCD (12 số)">
              <input
                inputMode="numeric"
                value={form.id_number}
                maxLength={12}
                placeholder="000000000000"
                onChange={(e) =>
                  set("id_number", e.target.value.replace(/\D/g, "").slice(0, 12))
                }
              />
            </Field>
            <Field label="Ngày sinh">
              <input
                type="date"
                value={form.dob}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => set("dob", e.target.value)}
              />
            </Field>
            <Field label="Ngày cấp">
              <input
                type="date"
                value={form.issued_date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => set("issued_date", e.target.value)}
              />
            </Field>
            <Field label="Nơi cấp">
              <input
                value={form.place_of_issue}
                maxLength={200}
                onChange={(e) => set("place_of_issue", e.target.value)}
              />
            </Field>
            <Field label="Địa chỉ thường trú">
              <input
                value={form.address}
                maxLength={500}
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
          </div>
          {save.isError && <ErrorState error={save.error} />}
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Đang lưu…" : "Lưu thông tin CCCD"}
            </Button>
            {save.isSuccess && (
              <span className="muted small">Đã lưu hồ sơ CCCD.</span>
            )}
          </div>

          <div className="identity-uploads">
            {(["front", "back"] as const).map((side) => (
              <div className="identity-upload-slot" key={side}>
                <strong>
                  {side === "front" ? "Mặt trước" : "Mặt sau"}
                </strong>
                {document?.[side === "front" ? "front_image_path" : "back_image_path"] ? (
                  <IdentityPhoto
                    path={
                      document[
                        side === "front" ? "front_image_path" : "back_image_path"
                      ] as string
                    }
                    alt={`CCCD ${side === "front" ? "mặt trước" : "mặt sau"}`}
                  />
                ) : (
                  <div className="image-placeholder muted">Chưa có ảnh</div>
                )}
                <label className="button secondary upload-button">
                  <Upload size={16} />{" "}
                  {document?.[side === "front" ? "front_image_path" : "back_image_path"]
                    ? "Tải ảnh khác"
                    : "Tải ảnh lên"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    aria-label={`Ảnh CCCD ${side === "front" ? "mặt trước" : "mặt sau"}`}
                    onChange={onPick(side)}
                  />
                </label>
              </div>
            ))}
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
