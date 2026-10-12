import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, CheckCircle2, Clock } from "lucide-react";
import { api } from "@/lib/api";
import { AppError, mapDuplicateReviewError } from "@/lib/errors";
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
  FrameKindHint,
  DuplicateInspector,
} from "@/components/VehicleDuplicateCheck";
import {
  OverrideSaveDialog,
  RequestReviewDialog,
} from "@/components/DuplicateReviewDialog";
import { decideDuplicateAction } from "@/lib/duplicateReviewDecision";
import { compactFrame, displayFrame } from "@/lib/frameNumber";
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
import { toast } from "@/lib/toast";
import { useFormDraft } from "@/lib/useFormDraft";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import { normalizeVehicleYear } from "@/lib/vehicleInputFormatting";
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
  if (id && query.isError && !query.data)
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

// Khuôn form dùng chung 100% với "Thu xe mới" (AcquisitionFormPage): cùng thẻ,
// cùng nhãn, cùng thứ tự input (Loại xe → Biển số → Số khung → Năm sản xuất →
// Màu sắc → Giá thu → Ngày thu xe → Ghi chú). Duy nhất khi SỬA xe thêm trường
// "Trạng thái". Ảnh xe quản lý ở trang chi tiết (/capture?vehicle=id).
function VehicleEditor({ vehicle }: { vehicle?: Vehicle }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  // Keep the version that supplied the form defaults even if queries refetch.
  const [expectedRevision] = useState(vehicle?.updated_at);
  // Luồng nghi trùng PLATE_AND_LAST5 (migration 20261011000400): giữ bản soạn để
  // gửi yêu cầu (STAFF) hoặc lưu ngoại lệ (OWNER/MANAGER), không ghi xe trước duyệt.
  const [pendingDuplicateValues, setPendingDuplicateValues] =
    useState<VehicleFormValues | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    mode: "onBlur",
    defaultValues: {
      vehicle_type: vehicle?.vehicle_type ?? "",
      license_plate: vehicle?.license_plate ?? "",
      year: vehicle?.year ?? undefined,
      color: vehicle?.color ?? "",
      // Xe chưa có khung thật (placeholder GEN-…) mở form với ô trống —
      // lưu mà không điền thì server giữ nguyên placeholder cũ.
      frame_number: displayFrame(vehicle?.frame_number),
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
  // Một ô số khung duy nhất, MỘT nguồn phân loại: máy chủ tự suy FULL/PARTIAL theo
  // độ dài (`private.frame_kind`). Nhân viên không chọn tay nữa; `dupCheck.kind`
  // chỉ là giá trị mirror để hiển thị dòng "Nhận diện:" cho dễ hiểu.
  const dupCheck = useVehicleDuplicateCheck({
    frameNumber: rawFrame,
    licensePlate: rawPlate,
    excludeVehicleId: vehicle?.id ?? null,
  });
  const frameKind = dupCheck.kind;
  // Xác nhận YELLOW chỉ có giá trị với đúng chữ ký đang hiển thị; đổi
  // biển/khung/loại thì hạ ack để bắt đối chiếu lại.
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [dupCheck.level, rawFrame, rawPlate, frameKind]);
  const dupAction = decideDuplicateAction({
    level: dupCheck.level,
    reason: dupCheck.result?.reason ?? "",
    role: profile?.role ?? "STAFF",
    acknowledged,
  });
  const blockSave =
    dupCheck.settled &&
    (dupAction.kind === "require-ack" || dupAction.kind === "hard-block");

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

  type SaveArg = {
    values: VehicleFormValues;
    override?: { reason: string; reviewedVehicleId: string };
  };
  const mutation = useMutation({
    mutationFn: async ({ values, override }: SaveArg) => {
      // Giá thu là bắt buộc khi đưa xe mới vào kho — mọi role đều nhập được.
      // Khi sửa xe, để trống ô giá nghĩa là "giữ giá thu đang có".
      if (!vehicle && !(values.purchase_price && values.purchase_price > 0))
        throw new AppError(
          "Nhập giá thu (lớn hơn 0) trước khi đưa xe vào kho.",
        );
      const data: Record<string, unknown> = {
        ...values,
        year: values.year ?? null,
      };
      if (values.purchase_price === undefined) delete data.purchase_price;
      // Bộ ba override cho phép Chủ/Quản lý lưu ngoại lệ nghi trùng; server vẫn
      // tái kiểm tra trùng + trạng thái đối chiếu trong cùng giao dịch.
      if (override) {
        data.duplicate_override = true;
        data.duplicate_override_reason = override.reason;
        data.duplicate_reviewed_vehicle_id = override.reviewedVehicleId;
        data.duplicate_ack = true;
      }
      if (!profile) throw new AppError("Vui lòng đăng nhập lại trước khi lưu xe.");
      return vehicle
        ? api.call<string>("save_vehicle", {
            p_data: {
              ...data,
              ...(expectedRevision ? { expected_updated_at: expectedRevision } : {}),
            },
            p_id: vehicle.id,
          })
        : executeOperation<string>(profile.id, "create_vehicle", "new", (requestId) =>
            api.call<string>("save_vehicle", {
              p_data: { ...data, request_id: requestId },
            }),
          );
    },
    onSuccess: async (resultId, { values, override }) => {
      setOverrideOpen(false);
      setPendingDuplicateValues(null);
      draft.complete();
      saveRecentValue("color", values.color, profile?.id);
      saveRecentValue("vehicle_type", values.vehicle_type, profile?.id);
      await client.invalidateQueries();
      if (override)
        toast.success("Đã lưu ngoại lệ nghi trùng.", {
          description: "Chủ/Quản lý đã trực tiếp lưu kèm lý do được ghi vào kiểm toán.",
          duration: 6000,
        });
      navigate(`/vehicles/${resultId}`);
    },
  });

  // STAFF gửi yêu cầu xác minh khi nghi trùng PLATE_AND_LAST5: không ghi xe.
  // _op='SAVE' + id (nếu sửa) để lúc duyệt server replay đúng save_vehicle.
  const requestReview = useMutation({
    mutationFn: async (arg: SaveArg & { staffNote: string }) => {
      if (!profile)
        throw new AppError("Vui lòng đăng nhập lại trước khi gửi yêu cầu.");
      const data: Record<string, unknown> = {
        ...arg.values,
        year: arg.values.year ?? null,
        _op: "SAVE",
        staff_note: arg.staffNote,
        ...(vehicle ? { id: vehicle.id } : {}),
      };
      return executeOperation<string>(
        profile.id,
        "request_vehicle_duplicate_review",
        vehicle ? vehicle.id : "new",
        (requestId) => api.requestVehicleDuplicateReview(data, requestId),
      );
    },
    onSuccess: async () => {
      setRequestOpen(false);
      setPendingDuplicateValues(null);
      draft.complete();
      await client.invalidateQueries();
      toast.success("Đã gửi yêu cầu xác minh.", {
        description:
          "Chưa lưu thay đổi vào kho. Chủ/Quản lý sẽ đối chiếu; bạn nhận thông báo khi có quyết định.",
        duration: 6000,
      });
      navigate(vehicle ? `/vehicles/${vehicle.id}` : "/vehicles");
    },
  });

  const error = (key: keyof VehicleFormValues) =>
    form.formState.errors[key]?.message;

  const handleValidSubmit = (values: VehicleFormValues) => {
    const normalized: VehicleFormValues = {
      ...values,
      frame_number: compactFrame(values.frame_number)
        ? values.frame_number.trim().toUpperCase()
        : "",
      duplicate_ack: acknowledged,
      license_plate: canonicalizePlate(values.license_plate),
      year: normalizeVehicleYear(values.year) ?? values.year,
      color: values.color.trim(),
      supplier_name: values.supplier_name.trim(),
      supplier_phone: values.supplier_phone.trim(),
      notes: values.notes.trim(),
    };
    // Nghi trùng PLATE_AND_LAST5: mở hộp thoại theo vai trò thay vì lưu thẳng.
    if (dupAction.kind === "request-review") {
      setPendingDuplicateValues(normalized);
      setRequestOpen(true);
      return;
    }
    if (dupAction.kind === "override-save") {
      setPendingDuplicateValues(normalized);
      setOverrideOpen(true);
      return;
    }
    mutation.mutate({ values: normalized });
  };

  const focusFirstError = () => {
    // The first invalid field is the first .field wrapper that rendered a
    // .field-error message, following the document order of the form.
    const field = document.querySelector<HTMLElement>(
      ".field:has(.field-error)",
    );
    if (!field) return;
    const control = field.querySelector<HTMLElement>(
      "input, select, textarea, [role='combobox']",
    );
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    control?.focus({ preventScroll: true });
  };

  const handleValidationErrors = () => {
    requestAnimationFrame(() => focusFirstError());
  };

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
        <div className="notice draft-notice" role="alert">
          <div className="row" style={{ gap: "8px", alignItems: "center" }}>
            <Clock size={16} />
            <p>
              Có bản nháp thông tin xe chưa hoàn tất trên thiết bị này. Nhấn
              tiếp tục để khôi phục đầy đủ giá và thông tin đã nhập, sau đó
              kiểm tra lại trước khi lưu.
            </p>
          </div>
          <div className="row" style={{ marginTop: "10px" }}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                draft.resume();
                setIsDraftRestored(true);
              }}
            >
              Tiếp tục bản nháp
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={draft.discard}
            >
              Bỏ bản nháp
            </Button>
          </div>
        </div>
      )}
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          const year = normalizeVehicleYear(form.getValues("year"));
          if (year != null && year !== form.getValues("year")) {
            form.setValue("year", year, { shouldDirty: true });
          }
          void form.handleSubmit(
            handleValidSubmit,
            handleValidationErrors,
          )(event);
        }}
      >
        <fieldset
          disabled={mutation.isPending}
          className="plain-fieldset stack"
        >
          {/* Card 1: Thông tin xe — khuôn y hệt form Thu xe mới */}
          <Card>
            <h2 className="section-title">1. Thông tin xe</h2>
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

              <Field label="Biển số (nếu có)" error={error("license_plate")}>
                <input
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  {...form.register("license_plate")}
                  onBlur={() => {
                    const val = form.getValues("license_plate");
                    form.setValue("license_plate", canonicalizePlate(val), {
                      shouldValidate: true,
                      shouldTouch: true,
                    });
                  }}
                  placeholder={PLATE_EXAMPLE}
                />
              </Field>

              <Field label="Số khung" error={error("frame_number")}>
                <input
                  autoFocus
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  {...form.register("frame_number")}
                  onBlur={() => {
                    const val = form.getValues("frame_number");
                    form.setValue("frame_number", val.trim().toUpperCase(), {
                      shouldValidate: true,
                      shouldTouch: true,
                    });
                  }}
                  placeholder="Nhập số khung đầy đủ, hoặc 5 ký tự cuối"
                />
                <FrameKindHint kind={frameKind} />
                <DuplicateInspector
                  checking={dupCheck.isChecking}
                  error={dupCheck.isError}
                  result={dupCheck.result}
                  hasSignal={dupCheck.hasSignal}
                  acknowledged={acknowledged}
                  role={profile?.role ?? "STAFF"}
                  onAcknowledge={setAcknowledged}
                  onRetry={() => void dupCheck.refetch()}
                />
              </Field>

              <Field label="Năm sản xuất" error={error("year")}>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="Ví dụ: 2024"
                  {...form.register("year", {
                    setValueAs: (value) =>
                      value === "" || value == null ? undefined : Number(value),
                    onBlur: (event) => {
                      const normalized = normalizeVehicleYear(
                        event.currentTarget.value,
                      );
                      if (normalized != null) {
                        form.setValue("year", normalized, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                      }
                    },
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
                  onBlur={() => void form.trigger("color")}
                  suggestions={suggestions("color")}
                  placeholder="Ví dụ: Đỏ đen, Trắng…"
                />
              </Field>

              {/* Giá thu hiển thị và bắt buộc với mọi role thao tác xe: nhân viên
                  là người nhập giá này tại quầy, và bán dưới giá thu cần đúng con
                  số đó để cảnh báo. Khi sửa, để trống = giữ giá thu đang có. */}
              <Field label="Giá thu (₫) *" error={error("purchase_price")}>
                <MoneyInput
                  aria-label="Giá thu (₫) *"
                  value={form.watch("purchase_price")}
                  onChange={(value) =>
                    form.setValue("purchase_price", value, {
                      shouldDirty: true,
                      shouldValidate: !!error("purchase_price"),
                    })
                  }
                  onBlur={() => void form.trigger("purchase_price")}
                  required
                  min={0}
                />
                {vehicle ? (
                  <small className="muted">
                    Muốn giữ nguyên giá thu đang có thì xóa sạch ô này.
                  </small>
                ) : null}
              </Field>

              <Field label="Ngày thu xe *" error={error("purchase_date")}>
                <DatePicker
                  aria-label="Ngày thu xe *"
                  value={form.watch("purchase_date")}
                  onChange={(value) => {
                    form.setValue("purchase_date", value, {
                      shouldDirty: true,
                      shouldValidate: !!error("purchase_date"),
                    });
                  }}
                  onBlur={() => void form.trigger("purchase_date")}
                  max={today()}
                  required
                />
              </Field>

              {vehicle && (
                <Field label="Trạng thái">
                  <select {...form.register("status")}>
                    <option value="IN_STOCK">Sẵn sàng bán</option>
                    <option value="RESERVED">Giữ chỗ</option>
                    {canManage(profile) && (
                      <option value="CANCELLED">Đã hủy</option>
                    )}
                  </select>
                </Field>
              )}
            </div>

            <Field label="Ghi chú" error={error("notes")}>
              <textarea
                rows={3}
                {...form.register("notes")}
                placeholder="Tình trạng xe, giấy tờ, phụ kiện, trầy xước, lỗi cần sửa…"
              />
            </Field>
          </Card>

          {/* Card 2: Thông tin người bán — khuôn y hệt form Thu xe mới */}
          <Card>
            <h2 className="section-title">2. Thông tin người bán</h2>
            <div className="form-grid">
              <Field label="Tên người bán" error={error("supplier_name")}>
                <input
                  enterKeyHint="next"
                  {...form.register("supplier_name")}
                  onBlur={() => {
                    const val = form.getValues("supplier_name");
                    form.setValue("supplier_name", val.trim(), {
                      shouldValidate: true,
                      shouldTouch: true,
                    });
                  }}
                  placeholder="Họ và tên người bán"
                />
              </Field>
              <Field
                label="Số điện thoại người bán"
                error={error("supplier_phone")}
              >
                <input
                  type="tel"
                  enterKeyHint="done"
                  {...form.register("supplier_phone")}
                  onBlur={() => {
                    const val = form.getValues("supplier_phone");
                    form.setValue("supplier_phone", val.trim(), {
                      shouldValidate: true,
                      shouldTouch: true,
                    });
                  }}
                  placeholder="09xx xxx xxx"
                />
              </Field>
            </div>
          </Card>
        </fieldset>

        {mutation.isError && <ErrorState error={mutation.error} />}

        <div className="form-actions form-actions-acquisition form-actions-vehicle form-footer-actions">
          <div className="form-actions-status">
            {isDraftRestored ? (
              <div
                className="draft-status-subtle"
                role="status"
                aria-live="polite"
              >
                <CheckCircle2
                  size={14}
                  className="status-icon positive"
                  aria-hidden="true"
                />
                <span className="status-text">
                  Đã khôi phục bản nháp — kiểm tra lại trước khi lưu.
                </span>
              </div>
            ) : draft.saved ? (
              <div
                className="draft-status-subtle"
                role="status"
                aria-live="polite"
              >
                <CheckCircle2
                  size={14}
                  className="status-icon positive"
                  aria-hidden="true"
                />
                <span className="status-text">Đã lưu bản nháp</span>
              </div>
            ) : null}
          </div>

          <div className="form-actions-buttons">
            <Link
              className="button secondary"
              to={vehicle ? `/vehicles/${vehicle.id}` : "/vehicles"}
            >
              Quay lại
            </Link>
            <Button
              type="submit"
              disabled={
                mutation.isPending || requestReview.isPending || blockSave
              }
            >
              {mutation.isPending || requestReview.isPending
                ? "Đang xử lý…"
                : dupAction.kind === "hard-block"
                  ? "Trùng số khung — không lưu được"
                  : dupAction.kind === "require-ack"
                    ? "Cần xác nhận để lưu"
                    : dupAction.kind === "request-review"
                      ? "Gửi yêu cầu xác minh"
                      : vehicle
                        ? "Lưu thay đổi"
                        : "Lưu xe mới"}
            </Button>
          </div>
        </div>
      </form>

      <RequestReviewDialog
        open={requestOpen}
        candidates={dupCheck.result?.candidates ?? []}
        reason={dupCheck.result?.reason ?? "PLATE_AND_LAST5"}
        submitting={requestReview.isPending}
        error={
          requestReview.error
            ? new AppError(mapDuplicateReviewError(requestReview.error))
            : undefined
        }
        onClose={() => {
          if (!requestReview.isPending) setRequestOpen(false);
        }}
        onSubmit={(staffNote) => {
          if (!pendingDuplicateValues) return;
          requestReview.mutate({ values: pendingDuplicateValues, staffNote });
        }}
      />

      <OverrideSaveDialog
        open={overrideOpen}
        candidates={dupCheck.result?.candidates ?? []}
        reason={dupCheck.result?.reason ?? "PLATE_AND_LAST5"}
        submitting={mutation.isPending}
        error={
          overrideOpen && mutation.error
            ? new AppError(mapDuplicateReviewError(mutation.error))
            : undefined
        }
        onClose={() => {
          if (!mutation.isPending) setOverrideOpen(false);
        }}
        onSubmit={({ reason, reviewedVehicleId }) => {
          if (!pendingDuplicateValues) return;
          mutation.mutate({
            values: pendingDuplicateValues,
            override: { reason, reviewedVehicleId },
          });
        }}
      />
    </div>
  );
}
