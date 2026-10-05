import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
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
import { QuickChips } from "@/components/ui/QuickChips";
import { saveRecentValue } from "@/lib/recentVehicles";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import { useQuickPick } from "@/lib/useQuickPick";
import { useFormDraft } from "@/lib/useFormDraft";
import { draftFields } from "@/lib/formDrafts";
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
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<AcquisitionFormValues | null>(null);
  const [isDraftRestored, setIsDraftRestored] = useState(false);

  const form = useForm<AcquisitionFormValues>({
    resolver: zodResolver(acquisitionSchema),
    mode: "onBlur",
    defaultValues: {
      frame_number: "",
      engine_number: "",
      license_plate: "",
      brand: "",
      model: "",
      variant: "",
      year: undefined,
      color: "",
      odometer: undefined,
      acquisition_date: today(),
      purchase_price: undefined,
      asking_price: undefined,
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
  const brand = form.watch("brand");
  const rawFrame = form.watch("frame_number");
  const frame = (rawFrame || "").trim().toUpperCase();
  const checkedFrame = useDebouncedValue(frame, 450);

  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const quickPick = useQuickPick();

  const duplicateQuery = useQuery({
    queryKey: ["vehicle-frame-check", profile?.id, checkedFrame],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { search: checkedFrame, limit: 100 },
      }),
    enabled: checkedFrame.length > 0 && checkedFrame === frame,
  });

  const duplicate =
    checkedFrame === frame
      ? duplicateQuery.data?.items.find(
          (vehicle) =>
            vehicle.frame_number?.trim().toUpperCase() === frame.toUpperCase(),
        )
      : undefined;

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
    mutationFn: async (values: AcquisitionFormValues) => {
      if (
        financial &&
        (values.purchase_price === undefined || values.purchase_price === null)
      ) {
        throw new AppError("Vui lòng nhập giá thu xe.");
      }
      if (duplicate) {
        throw new AppError(
          "Số khung đã tồn tại. Hãy mở xe đã có để tiếp tục.",
        );
      }
      const data: Record<string, unknown> = {
        ...values,
        year: values.year ?? null,
        odometer: values.odometer ?? null,
        asking_price: values.asking_price ?? 0,
      };
      if (!financial) delete data.purchase_price;
      return api.call<string>("acquire_vehicle", { p_data: data });
    },
    onSuccess: async (vehicleId, values) => {
      setPendingConfirmation(null);
      draft.complete();
      saveRecentValue("brand", values.brand, profile?.id);
      saveRecentValue(
        `model:${values.brand.trim().toLowerCase()}`,
        values.model,
        profile?.id,
      );
      saveRecentValue("variant", values.variant, profile?.id);
      saveRecentValue("color", values.color, profile?.id);
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
      frame_number: values.frame_number.trim().toUpperCase(),
      engine_number: values.engine_number.trim().toUpperCase(),
      license_plate: canonicalizePlate(values.license_plate),
      brand: values.brand.trim(),
      model: values.model.trim(),
      variant: values.variant.trim(),
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
    const field = document.querySelector<HTMLElement>(".field:has(.field-error)");
    if (!field) return;
    const control = field.querySelector<HTMLElement>(
      "input, select, textarea, [role='combobox']",
    );
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    control?.focus({ preventScroll: true });
  };

  const handleValidationErrors = (
    errors: Record<string, { message?: unknown } | undefined>,
  ) => {
    const advancedFields = [
      "variant",
      "year",
      "color",
      "odometer",
      "asking_price",
      "notes",
    ];
    const hasAdvancedError = advancedFields.some((field) => field in errors);
    if (hasAdvancedError && advancedRef.current) {
      advancedRef.current.open = true;
      setMoreOpen(true);
    }
    // Wait for React to commit the expanded <details> before scrolling/focus.
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
      {location.state?.aiDraft && (
        <p className="notice">
          Bản nháp từ ảnh/giọng nói: kiểm tra số khung và nhập giá thu trước khi
          xác nhận.
        </p>
      )}
      {draft.draft && (
        <div className="notice draft-notice" role="alert">
          <div className="row" style={{ gap: "8px", alignItems: "center" }}>
            <Clock size={16} />
            <p>
              Có bản nháp thu xe chưa hoàn tất trên thiết bị này. Vì lý do bảo
              mật, giá thu cần nhập lại trước khi xác nhận.
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
        onSubmit={form.handleSubmit(
          handleValidSubmit,
          handleValidationErrors,
        )}
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
                    if (!val) return;
                    form.setValue(
                      "frame_number",
                      val.trim().toUpperCase(),
                      { shouldValidate: true },
                    );
                  }}
                  placeholder="Nhập số khung (nếu có)"
                />
                {checkedFrame.length >= 3 &&
                  !duplicateQuery.isFetching &&
                  !duplicate && (
                    <span className="inline-check-feedback positive">
                      <CheckCircle2 size={13} /> Số khung chưa có trong hệ thống
                    </span>
                  )}
                {duplicateQuery.isFetching && (
                  <span className="inline-check-feedback muted">
                    <LoaderCircle size={13} className="spin" /> Đang kiểm tra số
                    khung…
                  </span>
                )}
                {duplicate && (
                  <div
                    className="notice danger"
                    role="alert"
                    style={{
                      background: "#fef2f2",
                      borderColor: "#fecdd3",
                      color: "#9c493d",
                      marginTop: "8px",
                    }}
                  >
                    <div
                      className="row"
                      style={{ gap: "8px", alignItems: "center" }}
                    >
                      <AlertTriangle size={18} />
                      <strong>Số khung đã tồn tại trong hệ thống</strong>
                    </div>
                    <div style={{ marginTop: "6px" }}>
                      <strong>
                        {duplicate.brand} {duplicate.model}
                      </strong>{" "}
                      · {duplicate.license_plate || duplicate.internal_code}
                    </div>
                    <div style={{ marginTop: "6px" }}>
                      <Link
                        to={`/vehicles/${duplicate.id}`}
                        className="text-link"
                      >
                        Xem chi tiết xe đã có →
                      </Link>
                    </div>
                  </div>
                )}
              </Field>

              <Field label="Số máy" error={error("engine_number")}>
                <input
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  {...form.register("engine_number")}
                  onBlur={() => {
                    const val = form.getValues("engine_number");
                    if (val) {
                      form.setValue(
                        "engine_number",
                        val.trim().toUpperCase(),
                        { shouldValidate: !!error("engine_number") },
                      );
                    }
                  }}
                  placeholder="Nhập số máy (nếu có)"
                />
              </Field>

              <Field label="Biển số (nếu có)" error={error("license_plate")}>
                <input
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  {...form.register("license_plate")}
                  onBlur={() => {
                    const val = form.getValues("license_plate");
                    if (val.trim()) {
                      form.setValue(
                        "license_plate",
                        canonicalizePlate(val),
                        { shouldValidate: !!error("license_plate") },
                      );
                    }
                  }}
                  placeholder={PLATE_EXAMPLE}
                />
              </Field>

              <Field label="Hãng xe" error={error("brand")}>
                <AutocompleteInput
                  aria-label="Hãng xe"
                  value={brand}
                  onChange={(value) => setText("brand", value)}
                  onBlur={() => {
                    if (brand.trim()) void form.trigger("brand");
                  }}
                  suggestions={suggestions("brand")}
                  placeholder="Ví dụ: Honda"
                  enterKeyHint="next"
                />
              </Field>

              <Field label="Dòng xe *" error={error("model")}>
                <AutocompleteInput
                  aria-label="Dòng xe *"
                  value={form.watch("model")}
                  onChange={(value) => setText("model", value)}
                  onBlur={() => {
                    if (form.getValues("model").trim())
                      void form.trigger("model");
                  }}
                  suggestions={suggestions("model")}
                  placeholder="Ví dụ: SH 160i, Vision…"
                  enterKeyHint="next"
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
                    showShortcuts={false}
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

            <QuickChips
              label="Chọn nhanh hãng xe"
              options={quickPick.brandChips}
              selected={brand}
              onSelect={(value) => setText("brand", value)}
            />
            {brand.trim() && quickPick.modelsFor(brand).length > 0 && (
              <QuickChips
                label="Chọn nhanh dòng xe"
                options={quickPick.modelsFor(brand)}
                selected={form.watch("model")}
                onSelect={(value) => setText("model", value)}
              />
            )}
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
                    if (val) {
                      form.setValue("seller_name", val.trim(), {
                        shouldValidate: !!error("seller_name"),
                      });
                    }
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
                    if (val) {
                      form.setValue("seller_phone", val.trim(), {
                        shouldValidate: !!error("seller_phone"),
                      });
                    }
                  }}
                  placeholder="09xx xxx xxx"
                />
              </Field>
            </div>
          </Card>

          {/* Card 3: Thông tin bổ sung */}
          <Card>
            <details
              ref={advancedRef}
              className="advanced-fields-box"
              open={moreOpen}
              onToggle={(e) => setMoreOpen(e.currentTarget.open)}
            >
              <summary className="advanced-summary">
                {moreOpen ? (
                  <span className="advanced-summary-content">
                    <ChevronDown size={16} /> Thu gọn thông tin thêm
                  </span>
                ) : (
                  <span className="advanced-summary-content">
                    <Plus size={16} /> Thêm thông tin (phiên bản, năm sản xuất,
                    màu sắc, số km, giá bán dự kiến, ghi chú)
                  </span>
                )}
              </summary>
              <div className="form-grid" style={{ marginTop: "16px" }}>
                <Field label="Phiên bản" error={error("variant")}>
                  <AutocompleteInput
                    aria-label="Phiên bản"
                    value={form.watch("variant")}
                    onChange={(value) => setText("variant", value)}
                    suggestions={suggestions("variant")}
                    placeholder="ABS, Cao cấp, Đặc biệt…"
                  />
                </Field>
                <Field label="Năm sản xuất" error={error("year")}>
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="Ví dụ: 2024"
                    {...form.register("year", {
                      setValueAs: (value) =>
                        value === "" || value == null
                          ? undefined
                          : Number(value),
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
                    placeholder="Ví dụ: Đỏ đen, Trắng…"
                  />
                </Field>
                <Field label="Số km đã đi" error={error("odometer")}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="10000000"
                    step="1"
                    placeholder="12.500"
                    {...form.register("odometer", {
                      setValueAs: (value) =>
                        value === "" || value == null
                          ? undefined
                          : Number(value),
                    })}
                  />
                </Field>
                <Field
                  label="Giá bán dự kiến (₫)"
                  error={error("asking_price")}
                >
                  <MoneyInput
                    aria-label="Giá bán dự kiến (₫)"
                    placeholder="Ví dụ: 95tr hoặc 95.000.000"
                    value={form.watch("asking_price")}
                    onChange={(value) =>
                      form.setValue("asking_price", value, {
                        shouldDirty: true,
                        shouldValidate: !!error("asking_price"),
                      })
                    }
                    onBlur={() => void form.trigger("asking_price")}
                    showShortcuts={false}
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
            </details>
          </Card>
        </fieldset>

        {mutation.isError && <ErrorState error={mutation.error} />}

        <div className="form-actions form-actions-acquisition form-footer-actions">
          <div className="form-actions-status">
            {isDraftRestored &&
            financial &&
            (form.watch("purchase_price") === undefined ||
              form.watch("purchase_price") === null ||
              form.watch("purchase_price") === ("" as unknown as number)) ? (
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
                <span className="status-text">Đã khôi phục bản nháp</span>
                <span className="status-reentry-hint">
                  Giá thu cần nhập lại.
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
                mutation.isPending || !!duplicate || duplicateQuery.isFetching
              }
            >
              {mutation.isPending
                ? "Đang lưu…"
                : duplicateQuery.isFetching
                  ? "Đang kiểm tra số khung…"
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
                <span className="confirm-label">Hãng & Dòng xe:</span>
                <strong className="confirm-value">
                  {pendingConfirmation.brand} {pendingConfirmation.model}
                  {pendingConfirmation.variant
                    ? ` (${pendingConfirmation.variant})`
                    : ""}
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
              <div className="confirm-summary-row">
                <span className="confirm-label">Số máy:</span>
                <span className="confirm-value">
                  {pendingConfirmation.engine_number ? (
                    <code className="confirm-code">
                      {pendingConfirmation.engine_number}
                    </code>
                  ) : (
                    "Chưa có"
                  )}
                </span>
              </div>
              {financial && (
                <div className="confirm-summary-row highlight-price">
                  <span className="confirm-label">Giá thu xe:</span>
                  <div className="confirm-price-col">
                    <strong className="price-big">
                      {money(pendingConfirmation.purchase_price)}
                    </strong>
                    <span className="price-words">
                      {formatVndApproxText(
                        pendingConfirmation.purchase_price,
                      )}{" "}
                      (
                      {formatVndWords(
                        pendingConfirmation.purchase_price,
                      )}
                      )
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
              {pendingConfirmation.asking_price ? (
                <div className="confirm-summary-row">
                  <span className="confirm-label">Giá bán dự kiến:</span>
                  <span className="confirm-value">
                    {money(pendingConfirmation.asking_price)}
                  </span>
                </div>
              ) : null}
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
