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
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { canFinance, canManage, canOperate } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
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
import { QuickChips } from "@/components/ui/QuickChips";
import { saveRecentValue } from "@/lib/recentVehicles";
import { useFormDraft } from "@/lib/useFormDraft";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import { useQuickPick } from "@/lib/useQuickPick";
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
  const financial = canFinance(profile);
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
      brand: vehicle?.brand ?? "",
      model: vehicle?.model ?? "",
      variant: vehicle?.variant ?? "",
      license_plate: vehicle?.license_plate ?? "",
      year: vehicle?.year ?? undefined,
      color: vehicle?.color ?? "",
      frame_number: vehicle?.frame_number ?? "",
      engine_number: vehicle?.engine_number ?? "",
      odometer: vehicle?.odometer ?? 0,
      purchase_date: vehicle?.purchase_date ?? today(),
      purchase_price: vehicle?.purchase_price ?? undefined,
      asking_price: vehicle?.asking_price ?? 0,
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
  const brand = form.watch("brand");
  const rawFrame = form.watch("frame_number").trim();
  const checkedFrame = useDebouncedValue(rawFrame, 450);
  const duplicateQuery = useQuery({
    queryKey: ["vehicle-frame-check", profile?.id, checkedFrame],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { search: checkedFrame, limit: 100 },
      }),
    enabled: checkedFrame.length > 0 && checkedFrame === rawFrame,
  });
  const duplicate =
    checkedFrame === rawFrame && rawFrame.length > 0
      ? duplicateQuery.data?.items.find(
          (item) =>
            item.id !== vehicle?.id &&
            item.frame_number?.trim().toUpperCase() === rawFrame.toUpperCase(),
        )
      : undefined;

  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });
  const quickPick = useQuickPick();
  const suggestions = (field: "brand" | "model" | "variant" | "color") =>
    vehicleSuggestions(catalog.data?.items ?? [], field, profile?.id, brand);
  const setText = (
    field: "brand" | "model" | "variant" | "color",
    value: string,
  ) =>
    form.setValue(field, value, {
      shouldDirty: true,
      shouldValidate: !!form.formState.errors[field],
    });

  const mutation = useMutation({
    mutationFn: async (values: VehicleFormValues) => {
      if (financial && values.purchase_price === undefined)
        throw new AppError("Vui lòng nhập giá mua xe.");
      if (duplicate)
        throw new AppError(
          `Số khung đã tồn tại trên xe khác: ${duplicate.brand} ${duplicate.model} (${duplicate.internal_code}).`,
        );
      const data: Record<string, unknown> = {
        ...values,
        license_plate: canonicalizePlate(values.license_plate),
        year: values.year ?? null,
        ...(vehicle && expectedRevision ? { expected_updated_at: expectedRevision } : {}),
      };
      if (!financial) delete data.purchase_price;
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
      saveRecentValue("brand", values.brand, profile?.id);
      saveRecentValue(
        `model:${values.brand.trim().toLowerCase()}`,
        values.model,
        profile?.id,
      );
      saveRecentValue("color", values.color, profile?.id);
      saveRecentValue("variant", values.variant, profile?.id);
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
            Có bản nháp thông tin xe. Giá tiền và trạng thái cần kiểm tra lại
            trước khi lưu.
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
              <span className="muted small">Bắt buộc: Dòng xe</span>
            </div>
            <div className="form-grid">
              <Field label="Hãng xe" error={error("brand")}>
                <AutocompleteInput
                  aria-label="Hãng xe"
                  value={brand}
                  onChange={(value) => setText("brand", value)}
                  onBlur={() => void form.trigger("brand")}
                  suggestions={suggestions("brand")}
                  placeholder="Ví dụ: Honda"
                />
              </Field>
              <Field label="Dòng xe *" error={error("model")}>
                <AutocompleteInput
                  aria-label="Dòng xe *"
                  value={form.watch("model")}
                  onChange={(value) => setText("model", value)}
                  onBlur={() => void form.trigger("model")}
                  suggestions={suggestions("model")}
                  placeholder="Ví dụ: SH 160i"
                />
              </Field>
              <Field label="Phiên bản" error={error("variant")}>
                <AutocompleteInput
                  aria-label="Phiên bản"
                  value={form.watch("variant")}
                  onChange={(value) => setText("variant", value)}
                  suggestions={suggestions("variant")}
                  placeholder="ABS, Cao cấp…"
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
                <input {...form.register("frame_number")} />
                {duplicate && (
                  <p
                    className="notice danger"
                    style={{
                      marginTop: "6px",
                      fontSize: "12px",
                      background: "#fef2f2",
                      borderColor: "#fecdd3",
                      color: "#9c493d",
                    }}
                  >
                    Số khung này đã tồn tại trên xe: {duplicate.brand}{" "}
                    {duplicate.model} ({duplicate.internal_code})
                  </p>
                )}
              </Field>
              <Field label="Số máy" error={error("engine_number")}>
                <input {...form.register("engine_number")} />
              </Field>
              <Field label="Số km đã đi" error={error("odometer")}>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  {...form.register("odometer", { valueAsNumber: true })}
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
            <QuickChips
              label="Chọn hãng nhanh"
              options={quickPick.brandChips}
              selected={brand}
              onSelect={(value) => setText("brand", value)}
            />
            {brand.trim() && quickPick.modelsFor(brand).length > 0 && (
              <QuickChips
                label="Chọn dòng nhanh"
                options={quickPick.modelsFor(brand)}
                selected={form.watch("model")}
                onSelect={(value) => setText("model", value)}
              />
            )}
          </Card>
          <Card>
            <div className="section-heading">
              <h2 className="section-title" style={{ margin: 0 }}>2. Giá cả & Nhập kho</h2>
              <span className="muted small">Bắt buộc: Ngày nhập, Giá niêm yết</span>
            </div>
            {!financial && (
              <p className="notice">
                Chủ cửa hàng hoặc người có quyền tài chính sẽ bổ sung giá nhập
                trước khi bán xe.
              </p>
            )}
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
              {financial && (
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
              )}
              <Field label="Giá niêm yết (₫) *" error={error("asking_price")}>
                <MoneyInput
                  aria-label="Giá niêm yết (₫) *"
                  value={form.watch("asking_price")}
                  onChange={(value) =>
                    form.setValue("asking_price", value ?? Number.NaN, {
                      shouldDirty: true,
                      shouldValidate: !!form.formState.errors.asking_price,
                    })
                  }
                  onBlur={() => void form.trigger("asking_price")}
                  min={0}
                  required
                />
                {financial &&
                  typeof form.watch("purchase_price") === "number" &&
                  (form.watch("purchase_price") ?? 0) > 0 &&
                  typeof form.watch("asking_price") === "number" &&
                  form.watch("asking_price") > 0 &&
                  form.watch("asking_price") <= (form.watch("purchase_price") ?? 0) && (
                    <p className="notice" style={{ marginTop: "4px", fontSize: "12px" }}>
                      Lưu ý: Giá niêm yết bán đang thấp hơn hoặc bằng giá mua vào.
                    </p>
                  )}
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
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? "Đang lưu…"
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
