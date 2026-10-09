import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { executeOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { AppError } from "@/lib/errors";
import { canFinance, canOperate } from "@/lib/permissions";
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
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import {
  useVehicleDuplicateCheck,
} from "@/lib/vehicleDuplicateCheck";
import {
  FrameKindAdvanced,
  DuplicateInspector,
} from "@/components/VehicleDuplicateCheck";
import {
  compactFrame,
  frameKindFromCompact,
  type FrameInputKind,
} from "@/lib/frameNumber";
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
  const financial = canFinance(profile);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<AcquisitionFormValues | null>(null);
  const [isDraftRestored, setIsDraftRestored] = useState(false);

  const form = useForm<AcquisitionFormValues>({
    resolver: zodResolver(acquisitionSchema),
    mode: "onBlur",
    defaultValues: {
      frame_number: "",
      frame_input_kind: "FULL",
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

  const draft = useFormDraft("acquisition", profile?.id, form);
  const rawFrame = form.watch("frame_number");
  const rawPlate = form.watch("license_plate");
  // Một ô số khung duy nhất: hệ thống tự nhận FULL/PARTIAL theo độ dài; nhân
  // viên chỉ ghi đè tay ở "Nâng cao" khi gặp ngoại lệ (số khung ngắn nhưng hợp lệ).
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
    frameInputKind: frameKind,
  });
  // Xác nhận YELLOW gắn với đúng chữ ký đang hiện; đổi nội dung thì hạ ack.
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [dupCheck.level, rawFrame, rawPlate, frameKind]);
  const blockSave =
    dupCheck.settled &&
    (dupCheck.level === "RED" || (dupCheck.level === "YELLOW" && !acknowledged));

  const suggestions = (field: "color" | "vehicle_type") =>
    vehicleSuggestions(catalog.data?.items ?? [], field, profile?.id);

  const setText = (field: "color" | "vehicle_type", value: string) =>
    form.setValue(field, value, {
      shouldDirty: true,
      shouldValidate: !!form.formState.errors[field],
    });

  const mutation = useMutation({
    mutationFn: async (values: AcquisitionFormValues) => {
      if (
        financial &&
        (values.purchase_price === undefined || values.purchase_price === null)
      ) {
        throw new AppError("Vui lòng nhập giá thu xe.");
      }
      const data: Record<string, unknown> = {
        ...values,
        year: values.year ?? null,
      };
      if (!financial) delete data.purchase_price;
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
    onSuccess: async (vehicleId, values) => {
      setPendingConfirmation(null);
      draft.complete();
      saveRecentValue("color", values.color, profile?.id);
      saveRecentValue("vehicle_type", values.vehicle_type, profile?.id);
      await client.invalidateQueries();
      navigate(`/vehicles/${vehicleId}`, {
        state: { acquisitionConfirmed: true },
      });
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
      frame_input_kind: frameKind,
      duplicate_ack: acknowledged,
      license_plate: canonicalizePlate(values.license_plate),
      year: normalizeVehicleYear(values.year) ?? values.year,
      color: values.color.trim(),
      seller_name: values.seller_name.trim(),
      seller_phone: values.seller_phone.trim(),
      notes: values.notes.trim(),
    };
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
          navigate(`/vehicles/${vehicleId}`, {
            state: { acquisitionConfirmed: true },
          });
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
              Có bản nháp thu xe chưa hoàn tất trên thiết bị này. Nhấn tiếp tục
              để khôi phục đầy đủ, sau đó kiểm tra lại giá thu trước khi xác
              nhận.
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
            <h2 className="section-title">1. Thông tin xe</h2>
            <div className="form-grid">
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
                <FrameKindAdvanced
                  kind={frameKind}
                  selection={frameKindOverride ?? "AUTO"}
                  disabled={mutation.isPending}
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
              {financial && (
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
                </Field>
              )}

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
                  Đã khôi phục bản nháp — kiểm tra lại giá thu trước khi xác nhận.
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
              disabled={mutation.isPending || blockSave}
            >
              {mutation.isPending
                ? "Đang lưu…"
                : blockSave
                  ? dupCheck.level === "RED"
                    ? "Nghi trùng — không lưu được"
                    : "Cần xác nhận để thu xe"
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
              <div className="confirm-summary-row">
                <span className="confirm-label">Loại xe:</span>
                <strong className="confirm-value">
                  {pendingConfirmation.vehicle_type || "—"}
                </strong>
              </div>
              <div className="confirm-summary-row">
                <span className="confirm-label">Biển số:</span>
                <span className="confirm-value">
                  {pendingConfirmation.license_plate || "Chưa có"}
                </span>
              </div>
              <div className="confirm-summary-row">
                <span className="confirm-label">Số khung:</span>
                <code className="confirm-code">
                  {pendingConfirmation.frame_number}
                </code>
              </div>
              {financial && (
                <div className="confirm-summary-row highlight-price">
                  <span className="confirm-label">Giá thu xe:</span>
                  <div className="confirm-price-col">
                    <strong className="price-big">
                      {money(pendingConfirmation.purchase_price)}
                    </strong>
                    <span className="price-words">
                      {formatVndApproxText(pendingConfirmation.purchase_price)}{" "}
                      ({formatVndWords(pendingConfirmation.purchase_price)})
                    </span>
                  </div>
                </div>
              )}
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
                onClick={() => mutation.mutate(pendingConfirmation)}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Đang xử lý…" : "Xác nhận thu xe"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
