import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { executeOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { today } from "@/lib/format";
import { canonicalizePlate, PLATE_EXAMPLE } from "@/lib/plate";
import { canManage, canOperate } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  useVehicleDuplicateCheck,
} from "@/lib/vehicleDuplicateCheck";
import {
  FrameKindAdvanced,
  DuplicateInspector,
} from "@/components/VehicleDuplicateCheck";
import { compactFrame, frameKindFromCompact, type FrameInputKind } from "@/lib/frameNumber";
import {
  Button,
  Card,
  ColorSwatchAction,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { Vehicle } from "@/types";
import { vehicleSchema, type VehicleFormValues } from "./vehicleSchema";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { AutocompleteInput } from "@/components/ui/AutocompleteInput";
import { saveRecentValue } from "@/lib/recentVehicles";
import { useFormDraft } from "@/lib/useFormDraft";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import { compressImage } from "@/lib/imageCompression";
import type { Paged } from "@/types";

export function VehicleFormPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const query = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: id }),
    enabled: !!id,
  });

  const isEditing = !!id;
  const hasPermission = canOperate(profile);

  if (!hasPermission)
    return (
      <EmptyState
        title={isEditing ? "Bạn không có quyền chỉnh sửa thông tin xe." : "Bạn không có quyền tạo xe mới."}
      />
    );
  if (id && query.isPending) return <Loading />;
  if (id && query.isError)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );
  if (query.data?.status === "SOLD")
    return (
      <div className="stack">
        <EmptyState
          title="Xe đã bán"
          description="Thông tin giá vốn và giao dịch được giữ nguyên để bảo toàn lịch sử."
        />
        <Link className="button secondary" to={`/vehicles/${id}`}>
          Về chi tiết xe
        </Link>
      </div>
    );
  if (query.data?.status === "CANCELLED" && !canManage(profile))
    return (
      <div className="stack">
        <EmptyState
          title="Xe đã hủy"
          description="Chỉ quản lý hoặc chủ cửa hàng mới có quyền chỉnh sửa hoặc khôi phục xe này."
        />
        <Link className="button secondary" to={`/vehicles/${id}`}>
          Về chi tiết xe
        </Link>
      </div>
    );

  return <VehicleEditor key={id ?? "new"} vehicle={query.data} />;
}

function VehicleEditor({ vehicle }: { vehicle?: Vehicle }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [savedId, setSavedId] = useState<string>();
  // Keep the version that supplied the form defaults even if queries refetch.
  const [expectedRevision] = useState(vehicle?.updated_at);
  const [uploadError, setUploadError] = useState("");
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    mode: "onBlur",
    defaultValues: {
      vehicle_type: vehicle?.vehicle_type ?? "",
      license_plate: vehicle?.license_plate ?? "",
      year: vehicle?.year ?? undefined,
      color: vehicle?.color ?? "",
      frame_number: vehicle?.frame_number ?? "",
      frame_input_kind: vehicle?.frame_input_kind ?? "FULL",
      duplicate_ack: false,
      purchase_date: vehicle?.purchase_date ?? today(),
      purchase_price: vehicle?.purchase_price ?? undefined,
      supplier_name: vehicle?.supplier_name ?? "",
      supplier_phone: vehicle?.supplier_phone ?? "",
      status:
        vehicle?.status === "RESERVED"
          ? "RESERVED"
          : vehicle?.status === "CANCELLED"
            ? "CANCELLED"
            : "IN_STOCK",
      notes: vehicle?.notes ?? "",
    },
  });
  const draft = useFormDraft(
    `vehicle:${vehicle?.id ?? "new"}`,
    profile?.id,
    form,
  );
  const rawFrame = form.watch("frame_number");
  const rawPlate = form.watch("license_plate");
  // Một ô số khung duy nhất: tự nhận FULL/PARTIAL theo độ dài; chỉ ghi đè tay
  // ở "Nâng cao" cho ngoại lệ (số khung hợp lệ nhưng ngắn, hoặc mảnh dài).
  const [frameKindOverride, setFrameKindOverride] = useState<
    FrameInputKind | null
  >(() => {
    const stored = form.getValues("frame_input_kind");
    const auto = frameKindFromCompact(
      compactFrame(form.getValues("frame_number")),
    );
    return stored && stored !== auto ? stored : null;
  });
  const frameKind: FrameInputKind =
    frameKindOverride ?? frameKindFromCompact(compactFrame(rawFrame));
  useEffect(() => {
    form.setValue("frame_input_kind", frameKind, { shouldDirty: true });
  }, [frameKind, form]);
  const dupCheck = useVehicleDuplicateCheck({
    frameNumber: rawFrame,
    licensePlate: rawPlate,
    frameInputKind: frameKind,
    excludeVehicleId: vehicle?.id ?? null,
  });
  // Xác nhận YELLOW chỉ có giá trị với đúng chữ ký đang hiển thị; đổi
  // biển/khung/loại thì hạ ack để bắt đối chiếu lại.
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [dupCheck.level, rawFrame, rawPlate, frameKind]);
  const blockSave =
    dupCheck.settled &&
    (dupCheck.level === "RED" || (dupCheck.level === "YELLOW" && !acknowledged));

  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });
  const suggestions = (field: "color" | "vehicle_type") =>
    vehicleSuggestions(catalog.data?.items ?? [], field, profile?.id);
  const setText = (field: "color" | "vehicle_type", value: string) =>
    form.setValue(field, value, {
      shouldDirty: true,
      shouldValidate: !!form.formState.errors[field],
    });

  const mutation = useMutation({
    mutationFn: async (values: VehicleFormValues) => {
      // Giá thu là bắt buộc khi đưa xe mới vào kho — mọi role đều nhập được.
      // Khi sửa xe, để trống ô giá nghĩa là "giữ giá thu đang có".
      if (!vehicle && !(values.purchase_price && values.purchase_price > 0))
        throw new AppError(
          "Nhập giá thu mua (lớn hơn 0) trước khi đưa xe vào kho.",
        );
      const data: Record<string, unknown> = {
        ...values,
        license_plate: canonicalizePlate(values.license_plate),
        frame_number: compactFrame(values.frame_number)
          ? values.frame_number.trim().toUpperCase()
          : "",
        duplicate_ack: acknowledged,
        year: values.year ?? null,
        ...(vehicle && expectedRevision ? { expected_updated_at: expectedRevision } : {}),
      };
      if (values.purchase_price === undefined) delete data.purchase_price;
      if (!profile) throw new AppError("Vui lòng đăng nhập lại trước khi lưu xe.");
      const resultId =
        savedId ??
        (vehicle
          ? await api.call<string>("save_vehicle", { p_data: data, p_id: vehicle.id })
          : await executeOperation<string>(profile.id, "create_vehicle", "new", requestId =>
              api.call<string>("save_vehicle", { p_data: { ...data, request_id: requestId } }),
            ));
      setSavedId(resultId);
      draft.complete();
      saveRecentValue("color", values.color, profile?.id);
      saveRecentValue("vehicle_type", values.vehicle_type, profile?.id);
      await client.invalidateQueries();
      if (files.length) {
        const remaining = [...files];
        try {
          for (const file of files) {
            await api.uploadVehicleImage(resultId, await compressImage(file));
            remaining.shift();
            setFiles([...remaining]);
          }
        } catch (error) {
          console.error("Vehicle image upload failed", error);
          setUploadError(
            "Thông tin xe đã được lưu. Một số ảnh chưa tải lên; bạn có thể thử tải lại hoặc mở chi tiết xe.",
          );
          return;
        }
      }
      await client.invalidateQueries();
      navigate(`/vehicles/${resultId}`);
    },
  });

  const error = (key: keyof VehicleFormValues) =>
    form.formState.errors[key]?.message;

  return (
    <div className="stack">
      <Link
        className="back-link"
        to={vehicle ? `/vehicles/${vehicle.id}` : "/vehicles"}
      >
        <ArrowLeft size={16} /> {vehicle ? "Chi tiết xe" : "Kho xe"}
      </Link>
      <PageHeader
        title={vehicle ? "Chỉnh sửa thông tin xe" : "Nhập xe mới"}
        description={
          vehicle
            ? vehicle.internal_code
            : "Lưu thông tin xe để bắt đầu theo dõi nhập, chi phí và bán hàng."
        }
      />
      {!vehicle && (
        <OperationRecoveryNotice<string>
          userId={profile?.id} operation="create_vehicle" scope="new"
          onConfirmed={async vehicleId => {
            draft.complete();
            await client.invalidateQueries();
            navigate(`/vehicles/${vehicleId}`);
          }}
        />
      )}
      {draft.draft && (
        <div className="notice draft-notice">
          <p>
            Có bản nháp thông tin xe. Nhấn tiếp tục để khôi phục đầy đủ giá và
            thông tin đã nhập; kiểm tra lại trước khi lưu.
          </p>
          <div className="row">
            <Button variant="secondary" onClick={draft.resume}>
              Tiếp tục bản nháp
            </Button>
            <Button variant="ghost" onClick={draft.discard}>
              Bỏ bản nháp
            </Button>
          </div>
        </div>
      )}
      <form
        className="stack"
        onSubmit={form.handleSubmit((values) => {
          setUploadError("");
          mutation.mutate(values);
        })}
      >
        <fieldset
          disabled={mutation.isPending || !!savedId}
          className="plain-fieldset stack"
        >
          <Card>
            <div className="section-heading">
              <h2 className="section-title" style={{ margin: 0 }}>1. Thông tin cơ bản</h2>
              <span className="muted small">Bắt buộc: Loại xe</span>
            </div>
            <div className="form-grid">
              <Field label="Loại xe *" error={error("vehicle_type")}>
                <AutocompleteInput
                  aria-label="Loại xe *"
                  value={form.watch("vehicle_type")}
                  onChange={(value) => setText("vehicle_type", value)}
                  onBlur={() => void form.trigger("vehicle_type")}
                  suggestions={suggestions("vehicle_type")}
                  maxSuggestions={10}
                  placeholder="VD: Honda Vision, Wave Alpha…"
                />
              </Field>
              <Field label="Biển số" error={error("license_plate")}>
                <input
                  {...form.register("license_plate")}
                  autoCapitalize="characters"
                  placeholder={PLATE_EXAMPLE}
                  onBlur={(event) => {
                    if (event.target.value.trim()) {
                      form.setValue(
                        "license_plate",
                        canonicalizePlate(event.target.value),
                        { shouldValidate: true, shouldDirty: true },
                      );
                    }
                  }}
                />
              </Field>
              <Field label="Năm sản xuất" error={error("year")}>
                <input
                  type="number"
                  inputMode="numeric"
                  {...form.register("year", {
                    setValueAs: (value) =>
                      value === "" ? undefined : Number(value),
                  })}
                />
              </Field>
              <Field
                label="Màu sắc"
                error={error("color")}
                labelAction={
                  <ColorSwatchAction
                    value={form.watch("color")}
                    onPick={(word) => setText("color", word)}
                  />
                }
              >
                <AutocompleteInput
                  aria-label="Màu sắc"
                  value={form.watch("color")}
                  onChange={(value) => setText("color", value)}
                  suggestions={suggestions("color")}
                  placeholder="VD: Đen, Trắng ngọc trai"
                />
              </Field>
              <Field label="Số khung" error={error("frame_number")}>
                <input
                  {...form.register("frame_number")}
                  autoCapitalize="characters"
                  placeholder="Nhập số khung đầy đủ, hoặc 5 ký tự cuối"
                  onBlur={(event) => {
                    if (event.target.value.trim()) {
                      form.setValue(
                        "frame_number",
                        event.target.value.trim().toUpperCase(),
                        { shouldValidate: true, shouldDirty: true },
                      );
                    }
                  }}
                />
                <FrameKindAdvanced
                  kind={frameKind}
                  selection={frameKindOverride ?? "AUTO"}
                  disabled={mutation.isPending || !!savedId}
                  onSelect={(value) =>
                    setFrameKindOverride(value === "AUTO" ? null : value)
                  }
                />
                <DuplicateInspector
                  checking={dupCheck.isChecking}
                  error={dupCheck.isError}
                  result={dupCheck.result}
                  hasSignal={dupCheck.hasSignal}
                  acknowledged={acknowledged}
                  onAcknowledge={setAcknowledged}
                  onRetry={() => void dupCheck.refetch()}
                />
              </Field>
              <Field label="Trạng thái">
                <select {...form.register("status")}>
                  <option value="IN_STOCK">Sẵn sàng bán</option>
                  <option value="RESERVED">Giữ chỗ</option>
                  {canManage(profile) && (
                    <option value="CANCELLED">Đã hủy</option>
                  )}
                </select>
              </Field>
            </div>
          </Card>
          <Card>
            <div className="section-heading">
              <h2 className="section-title" style={{ margin: 0 }}>2. Giá cả & Nhập kho</h2>
              <span className="muted small">
                Bắt buộc: Ngày nhập · Giá mua{vehicle ? " (khi xe chưa có giá)" : ""}
              </span>
            </div>
            <p className="notice">
              {vehicle
                ? "Để trống giá mua nếu bạn muốn giữ đúng giá thu đang có; muốn đổi giá thì nhập số mới (lớn hơn 0)."
                : "Giá thu mua là bắt buộc khi đưa xe vào kho. Nhân viên nào cũng nhập được vì chính mình là người thu xe."}
            </p>
            <div className="form-grid">
              <Field label="Ngày nhập kho *" error={error("purchase_date")}>
                <DatePicker
                  aria-label="Ngày nhập kho *"
                  value={form.watch("purchase_date")}
                  onChange={(val) =>
                    form.setValue("purchase_date", val, {
                      shouldDirty: true,
                      shouldValidate: !!error("purchase_date"),
                    })
                  }
                  onBlur={() => void form.trigger("purchase_date")}
                  max={today()}
                  required
                />
              </Field>
              <Field label="Giá mua (₫) *" error={error("purchase_price")}>
                <MoneyInput
                  aria-label="Giá mua (₫) *"
                  value={form.watch("purchase_price")}
                  onChange={(value) =>
                    form.setValue("purchase_price", value, {
                      shouldDirty: true,
                      shouldValidate: !!form.formState.errors.purchase_price,
                    })
                  }
                  onBlur={() => void form.trigger("purchase_price")}
                  min={0}
                  required
                />
              </Field>
              <Field label="Tên nhà cung cấp" error={error("supplier_name")}>
                <input {...form.register("supplier_name")} />
              </Field>
              <Field
                label="Số điện thoại nhà cung cấp"
                error={error("supplier_phone")}
              >
                <input type="tel" {...form.register("supplier_phone")} />
              </Field>
            </div>
            <Field label="Ghi chú" error={error("notes")}>
              <textarea
                rows={3}
                {...form.register("notes")}
                placeholder="Tình trạng xe, hồ sơ, phụ kiện đi kèm…"
              />
            </Field>
          </Card>
          <Card>
            <div className="section-heading">
              <h2 className="section-title" style={{ margin: 0 }}>3. Hình ảnh xe</h2>
              <span className="muted small">Tùy chọn - tối đa 20 MB/ảnh</span>
            </div>
            <p className="muted">
              Chọn nhiều ảnh JPG, PNG, WebP tối đa 20 MB mỗi ảnh. Ảnh được nén
              trước khi tải.
            </p>
            <Field label="Chọn ảnh">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  if (
                    selected.some(
                      (file) =>
                        file.size > 20 * 1024 * 1024 ||
                        !["image/jpeg", "image/png", "image/webp"].includes(
                          file.type,
                        ),
                    )
                  ) {
                    setUploadError(
                      "Chỉ chọn ảnh JPG, PNG, WebP nhỏ hơn hoặc bằng 20 MB.",
                    );
                    event.target.value = "";
                    setFiles([]);
                    return;
                  }
                  setUploadError("");
                  setFiles(selected);
                }}
              />
            </Field>
            {files.length > 0 && (
              <p className="muted">
                {files.length} ảnh đã chọn:{" "}
                {files.map((file) => file.name).join(", ")}
              </p>
            )}
            {!!previews.length && (
              <div className="upload-preview-list">
                {previews.map((preview, index) => (
                  <div className="upload-preview-item" key={preview}>
                    <img src={preview} alt={`Ảnh xe đã chọn ${index + 1}`} />
                    <small>Chờ lưu xe để tải ảnh</small>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </fieldset>
        {mutation.isError && <ErrorState error={mutation.error} />}
        {uploadError && (
          <div className="notice" role="status">
            {uploadError}
            {savedId && (
              <Link to={`/vehicles/${savedId}`}> Mở chi tiết xe →</Link>
            )}
          </div>
        )}
        {draft.saved && (
          <p className="muted small" role="status">
            Đã giữ bản nháp thông tin trên thiết bị này.
          </p>
        )}
        <div className="form-actions form-footer-actions">
          <Link
            className="button secondary"
            to={vehicle ? `/vehicles/${vehicle.id}` : "/vehicles"}
          >
            Quay lại
          </Link>
          <Button type="submit" disabled={mutation.isPending || blockSave}>
            {mutation.isPending
              ? "Đang lưu…"
              : blockSave
                ? dupCheck.level === "RED"
                  ? "Nghi trùng — không lưu được"
                  : "Cần xác nhận để lưu"
                : savedId
                  ? "Thử tải ảnh còn lại"
                  : vehicle
                    ? "Lưu thay đổi"
                    : "Lưu xe mới"}
          </Button>
        </div>
      </form>
    </div>
  );
}
