import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  ScanLine,
  X,
} from "lucide-react";
import { QuickVehicleScannerModal, type ScannedVehicleFields } from "@/components/QuickVehicleScannerModal";
import { api } from "@/lib/api";
import { executeOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { AppError, mapDuplicateReviewError } from "@/lib/errors";
import { canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { canonicalizePlate, PLATE_EXAMPLE } from "@/lib/plate";
import { formatVndApproxText, formatVndWords } from "@/lib/moneyHelper";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Button,
  Card,
  ColorSwatchAction,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
} from "@/components/ui";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { AutocompleteInput } from "@/components/ui/AutocompleteInput";
import { saveRecentValue } from "@/lib/recentVehicles";
import { toast } from "@/lib/toast";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
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
import { compactFrame } from "@/lib/frameNumber";
import { useFormDraft } from "@/lib/useFormDraft";
import { draftFields } from "@/lib/formDrafts";
import { normalizeVehicleYear } from "@/lib/vehicleInputFormatting";
import { useDialog } from "@/lib/useDialog";
import type { Paged, Vehicle } from "@/types";
import {
  acquisitionSchema,
  type AcquisitionFormValues,
} from "./acquisitionSchema";

export function AcquisitionFormPage() {
  const { profile } = useAuth();
  if (!canOperate(profile))
    return <EmptyState title="Bạn không có quyền thu xe." />;
  return <AcquisitionEditor key={profile?.id} />;
}

function AcquisitionEditor() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [pendingConfirmation, setPendingConfirmation] =
    useState<AcquisitionFormValues | null>(null);
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  // Luồng nghi trùng PLATE_AND_LAST5: giữ bản đã soạn để gửi yêu cầu (STAFF)
  // hoặc lưu ngoại lệ (OWNER/MANAGER) mà không tạo xe trước khi duyệt.
  const [pendingDuplicateValues, setPendingDuplicateValues] =
    useState<AcquisitionFormValues | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  const form = useForm<AcquisitionFormValues>({
    resolver: zodResolver(acquisitionSchema),
    mode: "onBlur",
    defaultValues: {
      frame_number: "",
      duplicate_ack: false,
      license_plate: "",
      vehicle_type: "",
      year: undefined,
      color: "",
      acquisition_date: today(),
      purchase_price: undefined,
      seller_name: "",
      seller_phone: "",
      notes: "",
      ...draftFields(
        location.state?.aiDraft && typeof location.state.aiDraft === "object"
          ? location.state.aiDraft
          : {},
      ),
    },
  });

  // Tự động điền thông tin khi được điều hướng từ camera thông minh (/capture)
  useEffect(() => {
    const aiDraft = location.state?.aiDraft as Record<string, unknown> | undefined;
    if (!aiDraft || typeof aiDraft !== "object") return;
    if (typeof aiDraft.license_plate === "string" && aiDraft.license_plate) {
      form.setValue("license_plate", aiDraft.license_plate, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
    if (typeof aiDraft.frame_number === "string" && aiDraft.frame_number) {
      form.setValue("frame_number", aiDraft.frame_number, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
    if (typeof aiDraft.vehicle_type === "string" && aiDraft.vehicle_type) {
      form.setValue("vehicle_type", aiDraft.vehicle_type, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
    if (typeof aiDraft.color === "string" && aiDraft.color) {
      form.setValue("color", aiDraft.color, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
    if (typeof aiDraft.year === "number" && aiDraft.year) {
      form.setValue("year", aiDraft.year, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [location.state, form]);

  const handleScanSuccess = (scanned: ScannedVehicleFields) => {
    let filledCount = 0;
    if (scanned.license_plate) {
      form.setValue("license_plate", scanned.license_plate, {
        shouldValidate: true,
        shouldDirty: true,
      });
      filledCount++;
    }
    if (scanned.frame_number) {
      form.setValue("frame_number", scanned.frame_number, {
        shouldValidate: true,
        shouldDirty: true,
      });
      filledCount++;
    }
    if (scanned.vehicle_type && !form.getValues("vehicle_type")) {
      form.setValue("vehicle_type", scanned.vehicle_type, {
        shouldValidate: true,
        shouldDirty: true,
      });
      filledCount++;
    }
    if (scanned.color && !form.getValues("color")) {
      form.setValue("color", scanned.color, {
        shouldValidate: true,
        shouldDirty: true,
      });
      filledCount++;
    }
    if (scanned.year && !form.getValues("year")) {
      form.setValue("year", scanned.year, {
        shouldValidate: true,
        shouldDirty: true,
      });
      filledCount++;
    }
    if (filledCount > 0) {
      toast.success("Đã quét và điền thông tin xe vào form thành công!", {
        description: [scanned.license_plate, scanned.frame_number].filter(Boolean).join(" · "),
      });
    }
  };

  const draft = useFormDraft("acquisition", profile?.id, form);
  const rawFrame = form.watch("frame_number");
  const rawPlate = form.watch("license_plate");
  // Một ô số khung duy nhất, MỘT nguồn phân loại: máy chủ tự suy FULL/PARTIAL theo
  // độ dài (`private.frame_kind`). Nhân viên không chọn tay nữa; `dupCheck.kind`
  // chỉ là giá trị mirror để hiển thị dòng "Nhận diện:" cho dễ hiểu.

  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const dupCheck = useVehicleDuplicateCheck({
    frameNumber: rawFrame,
    licensePlate: rawPlate,
  });
  const frameKind = dupCheck.kind;
  // Xác nhận YELLOW gắn với đúng chữ ký đang hiện; đổi nội dung thì hạ ack.
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
  // require-ack và hard-block là hai trạng thái khóa nút; request-review và
  // override-save MỞ hộp thoại nên nút vẫn bấm được.
  const blockSave =
    dupCheck.settled &&
    (dupAction.kind === "require-ack" || dupAction.kind === "hard-block");

  const suggestions = (field: "color" | "vehicle_type") =>
    vehicleSuggestions(catalog.data?.items ?? [], field, profile?.id);

  const setText = (field: "color" | "vehicle_type", value: string) =>
    form.setValue(field, value, {
      shouldDirty: true,
      shouldValidate: !!form.formState.errors[field],
    });

  type SaveArg = {
    values: AcquisitionFormValues;
    override?: { reason: string; reviewedVehicleId: string };
  };
  const mutation = useMutation({
    mutationFn: async ({ values, override }: SaveArg) => {
      const data: Record<string, unknown> = {
        ...values,
        year: values.year ?? null,
      };
      // OWNER/MANAGER lưu ngoại lệ: gửi kèm bộ ba override mà server bắt buộc
      // (lý do + hồ sơ đã đối chiếu ∈ candidate). Server vẫn tái kiểm tra trùng
      // trong cùng transaction, FULL_FRAME_MATCH không bao giờ qua được.
      if (override) {
        data.duplicate_override = true;
        data.duplicate_override_reason = override.reason;
        data.duplicate_reviewed_vehicle_id = override.reviewedVehicleId;
        data.duplicate_ack = true;
      }
      if (!profile)
        throw new AppError("Vui lòng đăng nhập lại trước khi thu xe.");
      return executeOperation<string>(
        profile.id,
        "acquire_vehicle",
        "new",
        (requestId) =>
          api.call<string>("acquire_vehicle", {
            p_data: { ...data, request_id: requestId },
          }),
      );
    },
    onSuccess: async (vehicleId, { values, override }) => {
      setPendingConfirmation(null);
      setOverrideOpen(false);
      setPendingDuplicateValues(null);
      draft.complete();
      saveRecentValue("color", values.color, profile?.id);
      saveRecentValue("vehicle_type", values.vehicle_type, profile?.id);
      await client.invalidateQueries();
      if (override) {
        toast.success("Đã lưu ngoại lệ nghi trùng.", {
          description:
            "Chủ/Quản lý đã trực tiếp thu xe kèm lý do ngoại lệ được ghi nhận vào kiểm toán.",
          duration: 6000,
        });
      } else {
        toast.success("Thu xe thành công.", {
          description: "Xe và phiếu thu đã sẵn sàng trong kho.",
          duration: 5000,
          action: { label: "Thu xe tiếp", onClick: () => navigate("/acquisitions/new") },
        });
      }
      navigate(`/vehicles/${vehicleId}`);
    },
  });

  // STAFF gặp nghi trùng PLATE_AND_LAST5: KHÔNG lưu xe, chỉ gửi toàn bộ dữ liệu
  // đang soạn sang hàng đợi xác minh. request_id chống bấm đúp; ALREADY_PENDING
  // (đã có đơn mở cho cùng hồ sơ) được đọc đúng ngữ cảnh qua mapDuplicateReviewError.
  const requestReview = useMutation({
    mutationFn: async (arg: SaveArg & { staffNote: string }) => {
      if (!profile)
        throw new AppError("Vui lòng đăng nhập lại trước khi gửi yêu cầu.");
      const data: Record<string, unknown> = {
        ...arg.values,
        year: arg.values.year ?? null,
        _op: "ACQUIRE",
        staff_note: arg.staffNote,
      };
      return executeOperation<string>(
        profile.id,
        "request_vehicle_duplicate_review",
        "new",
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
          "Xe chưa được lưu vào kho. Chủ/Quản lý sẽ đối chiếu; bạn nhận thông báo khi có quyết định.",
        duration: 6000,
      });
      navigate("/acquisitions");
    },
  });

  const confirmDialogRef = useDialog(
    !!pendingConfirmation,
    () => {
      if (!mutation.isPending) setPendingConfirmation(null);
    },
    mutation.isPending,
  );

  const error = (key: keyof AcquisitionFormValues) =>
    form.formState.errors[key]?.message;

  const handleValidSubmit = (values: AcquisitionFormValues) => {
    const normalized: AcquisitionFormValues = {
      ...values,
      frame_number: compactFrame(values.frame_number)
        ? values.frame_number.trim().toUpperCase()
        : "",
      duplicate_ack: acknowledged,
      license_plate: canonicalizePlate(values.license_plate),
      year: normalizeVehicleYear(values.year) ?? values.year,
      color: values.color.trim(),
      seller_name: values.seller_name.trim(),
      seller_phone: values.seller_phone.trim(),
      notes: values.notes.trim(),
    };
    // Nghi trùng PLATE_AND_LAST5: điều hướng theo vai trò thay vì lưu thẳng.
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
    setPendingConfirmation(normalized);
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
      <Link className="back-link" to="/acquisitions">
        <ArrowLeft size={16} /> Thu vào
      </Link>
      <PageHeader
        title="Thu xe mới"
        description="Nhập thông tin xe và giá thu để tạo xe cùng phiếu thu."
      />
      <OperationRecoveryNotice<string>
        userId={profile?.id}
        operation="acquire_vehicle"
        scope="new"
        onConfirmed={async (vehicleId) => {
          draft.complete();
          await client.invalidateQueries();
          toast.success("Thu xe thành công.", {
            description: "Xe và phiếu thu đã sẵn sàng trong kho.",
            duration: 5000,
            action: { label: "Thu xe tiếp", onClick: () => navigate("/acquisitions/new") },
          });
          navigate(`/vehicles/${vehicleId}`);
        }}
      />
      {location.state?.aiDraft && (
        <p className="notice">
          Bản nháp từ ảnh/giọng nói: kiểm tra lại số khung và giá thu trước khi
          xác nhận.
        </p>
      )}
      {draft.draft && (
        <div className="notice draft-notice" role="alert">
          <div className="row" style={{ gap: "8px", alignItems: "center" }}>
            <Clock size={16} />
            <p>
              Có bản nháp lần trước chưa hoàn tất.
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
              onClick={() => {
                draft.discard();
                setIsDraftRestored(false);
              }}
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
          {/* Card 1: Thông tin xe & định giá */}
          <Card>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
              <h2 className="section-title" style={{ margin: 0 }}>1. Thông tin xe</h2>
              <Button
                type="button"
                variant="secondary"
                className="quick-scan-btn"
                onClick={() => setScannerOpen(true)}
                title="Mở camera quét nhanh biển số và số khung"
              >
                <ScanLine size={16} />
                <span>Quét camera (Biển số / Số khung)</span>
              </Button>
            </div>
            <div className="form-grid">
              <Field label="Loại xe *" error={error("vehicle_type")}>
                <AutocompleteInput
                  autoFocus
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
                  số đó để cảnh báo. */}
              <Field label="Giá thu (₫) *" error={error("purchase_price")}>
                <MoneyInput
                  aria-label="Giá thu (₫) *"
                  placeholder="12.000.000 hoặc 12tr5"
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
              </Field>

              <Field label="Ngày thu xe *" error={error("acquisition_date")}>
                <DatePicker
                  aria-label="Ngày thu xe *"
                  value={form.watch("acquisition_date")}
                  onChange={(value) => {
                    form.setValue("acquisition_date", value, {
                      shouldDirty: true,
                      shouldValidate: !!error("acquisition_date"),
                    });
                  }}
                  onBlur={() => void form.trigger("acquisition_date")}
                  max={today()}
                  required
                />
              </Field>
            </div>

            <Field label="Ghi chú" error={error("notes")}>
              <textarea
                rows={3}
                {...form.register("notes")}
                placeholder="Tình trạng xe, giấy tờ, phụ kiện, trầy xước, lỗi cần sửa…"
              />
            </Field>
          </Card>

          {/* Card 2: Thông tin người bán */}
          <Card>
            <h2 className="section-title">2. Thông tin người bán</h2>
            <div className="form-grid">
              <Field label="Tên người bán" error={error("seller_name")}>
                <input
                  enterKeyHint="next"
                  {...form.register("seller_name")}
                  onBlur={() => {
                    const val = form.getValues("seller_name");
                    form.setValue("seller_name", val.trim(), {
                      shouldValidate: true,
                      shouldTouch: true,
                    });
                  }}
                  placeholder="Họ và tên người bán"
                />
              </Field>
              <Field
                label="Số điện thoại người bán"
                error={error("seller_phone")}
              >
                <input
                  type="tel"
                  enterKeyHint="done"
                  {...form.register("seller_phone")}
                  onBlur={() => {
                    const val = form.getValues("seller_phone");
                    form.setValue("seller_phone", val.trim(), {
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

        <div className="form-actions form-actions-acquisition form-footer-actions">
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
                  Đã dùng lại bản nháp lần trước.
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
            <Link className="button secondary" to="/acquisitions">
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
                    ? "Cần xác nhận để thu xe"
                    : dupAction.kind === "request-review"
                      ? "Gửi yêu cầu xác minh"
                      : "Thu xe & tạo phiếu"}
            </Button>
          </div>
        </div>
      </form>

      {/* Confirmation Dialog before financial submission */}
      {pendingConfirmation && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!mutation.isPending) setPendingConfirmation(null);
          }}
          role="presentation"
        >
          <div
            ref={confirmDialogRef}
            className="modal-card acquisition-confirm-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-modal-title"
          >
            <div className="modal-header">
              <div>
                <h3 id="confirm-modal-title">Xác nhận thu xe</h3>
                <p className="modal-subtitle">
                  Kiểm tra thông tin trước khi lưu xe vào kho và lập phiếu thu:
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPendingConfirmation(null)}
                disabled={mutation.isPending}
                aria-label="Đóng"
              >
                <X size={18} />
              </button>
            </div>

            <div className="confirm-summary-list">
              <div className="confirm-identity-highlight-card">
                <div className="confirm-identity-header">
                  <span className="confirm-identity-tag">Định danh xe</span>
                </div>
                <div className="confirm-identity-rows">
                  <div className="confirm-highlight-item">
                    <span className="confirm-label">Loại xe:</span>
                    <strong className="confirm-value confirm-value-highlight-type">
                      {pendingConfirmation.vehicle_type || "—"}
                    </strong>
                  </div>
                  <div className="confirm-highlight-item">
                    <span className="confirm-label">Biển số:</span>
                    <span className="confirm-value">
                      <span className="identity-chip-plate confirm-plate-chip">
                        <strong>{pendingConfirmation.license_plate || "Chưa có"}</strong>
                      </span>
                    </span>
                  </div>
                  <div className="confirm-highlight-item">
                    <span className="confirm-label">Số khung:</span>
                    <code className="confirm-code confirm-code-highlight">
                      {pendingConfirmation.frame_number}
                    </code>
                  </div>
                </div>
              </div>
              <div className="confirm-summary-row highlight-price">
                <span className="confirm-label">Giá thu xe:</span>
                <div className="confirm-price-col">
                  <strong className="price-big">
                    {money(pendingConfirmation.purchase_price)}
                  </strong>
                  <span className="price-words">
                    {formatVndApproxText(pendingConfirmation.purchase_price)} {" "}
                    ({formatVndWords(pendingConfirmation.purchase_price)})
                  </span>
                </div>
              </div>
              <div className="confirm-summary-row">
                <span className="confirm-label">Người bán:</span>
                <span className="confirm-value">
                  {pendingConfirmation.seller_name || "—"}
                  {pendingConfirmation.seller_phone
                    ? ` · ${pendingConfirmation.seller_phone}`
                    : ""}
                </span>
              </div>
              <div className="confirm-summary-row">
                <span className="confirm-label">Ngày thu xe:</span>
                <span className="confirm-value">
                  {dateLabel(pendingConfirmation.acquisition_date)}
                </span>
              </div>
            </div>

            {mutation.isError && <ErrorState error={mutation.error} />}

            <div className="modal-footer-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPendingConfirmation(null)}
                disabled={mutation.isPending}
              >
                Quay lại chỉnh sửa
              </Button>
              <Button
                type="button"
                onClick={() => mutation.mutate({ values: pendingConfirmation })}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Đang xử lý…" : "Xác nhận thu xe"}
              </Button>
            </div>
          </div>
        </div>
      )}

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

      <QuickVehicleScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanSuccess={handleScanSuccess}
      />
    </div>
  );
}
