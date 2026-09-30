import { useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { canFinance, canOperate } from "@/lib/permissions";
import { today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
} from "@/components/ui";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { AutocompleteInput } from "@/components/ui/AutocompleteInput";
import {
  BRAND_CHIPS,
  COLOR_CHIPS,
  QuickChips,
} from "@/components/ui/QuickChips";
import { saveRecentValue } from "@/lib/recentVehicles";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import { useFormDraft } from "@/lib/useFormDraft";
import { draftFields } from "@/lib/formDrafts";
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
      odometer: 0,
      acquisition_date: today(),
      purchase_price: undefined,
      asking_price: 0,
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
  const frame = form.watch("frame_number").trim();
  const checkedFrame = useDebouncedValue(frame, 450);
  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });
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
          (vehicle) => vehicle.frame_number?.trim() === frame,
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
      if (financial && values.purchase_price === undefined)
        throw new AppError("Vui lòng nhập giá thu xe.");
      if (duplicate)
        throw new AppError("Số khung đã tồn tại. Hãy mở xe đã có để tiếp tục.");
      const data: Record<string, unknown> = {
        ...values,
        year: values.year ?? null,
      };
      if (!financial) delete data.purchase_price;
      return api.call<string>("acquire_vehicle", { p_data: data });
    },
    onSuccess: async (vehicleId, values) => {
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
  const error = (key: keyof AcquisitionFormValues) =>
    form.formState.errors[key]?.message;

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
        <div className="notice draft-notice">
          <p>
            Có bản nháp thu xe chưa hoàn tất. Giá tiền cần nhập lại trước khi
            xác nhận.
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
        onSubmit={form.handleSubmit(
          (values) => mutation.mutate(values),
          (errors) => {
            if (
              [
                "engine_number",
                "variant",
                "year",
                "color",
                "odometer",
                "asking_price",
                "notes",
              ].some((field) => field in errors) &&
              advancedRef.current
            )
              advancedRef.current.open = true;
          },
        )}
      >
        <fieldset
          disabled={mutation.isPending}
          className="plain-fieldset stack"
        >
          <Card>
            <h2 className="section-title">Thông tin thu xe</h2>
            {!financial && (
              <p className="notice">
                Người có quyền tài chính sẽ bổ sung giá thu trước khi bán xe.
              </p>
            )}
            <div className="form-grid">
              <Field label="Số khung *" error={error("frame_number")}>
                <input
                  autoFocus
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  {...form.register("frame_number")}
                  placeholder="Số khung là mã nhận dạng duy nhất"
                />
              </Field>
              <Field label="Biển số (nếu có)" error={error("license_plate")}>
                <input
                  autoCapitalize="characters"
                  enterKeyHint="next"
                  {...form.register("license_plate")}
                  placeholder="59-A1 123.45"
                />
              </Field>
              <Field label="Hãng xe *" error={error("brand")}>
                <AutocompleteInput
                  aria-label="Hãng xe *"
                  value={brand}
                  onChange={(value) => setText("brand", value)}
                  onBlur={() => void form.trigger("brand")}
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
                  onBlur={() => void form.trigger("model")}
                  suggestions={suggestions("model")}
                  placeholder="Ví dụ: SH 160i"
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
                <input type="date" {...form.register("acquisition_date")} />
              </Field>
              <Field label="Tên người bán" error={error("seller_name")}>
                <input enterKeyHint="next" {...form.register("seller_name")} />
              </Field>
              <Field
                label="Số điện thoại người bán"
                error={error("seller_phone")}
              >
                <input
                  type="tel"
                  enterKeyHint="done"
                  {...form.register("seller_phone")}
                />
              </Field>
            </div>
            <QuickChips
              label="Chọn hãng nhanh"
              options={BRAND_CHIPS}
              selected={brand}
              onSelect={(value) => setText("brand", value)}
            />
            {duplicate && (
              <div className="notice" role="alert">
                Số khung đã tồn tại: {duplicate.brand} {duplicate.model} ·{" "}
                {duplicate.license_plate || duplicate.internal_code}.{" "}
                <Link to={`/vehicles/${duplicate.id}`}>Xem xe đã có</Link>
              </div>
            )}
          </Card>
          <Card>
            <details ref={advancedRef} className="advanced-fields">
              <summary>
                + Thông tin khác (số máy, màu, phiên bản, ghi chú…)
              </summary>
              <div className="form-grid">
                <Field label="Số máy" error={error("engine_number")}>
                  <input
                    autoCapitalize="characters"
                    {...form.register("engine_number")}
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
                <Field label="Màu sắc" error={error("color")}>
                  <AutocompleteInput
                    aria-label="Màu sắc"
                    value={form.watch("color")}
                    onChange={(value) => setText("color", value)}
                    suggestions={suggestions("color")}
                  />
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
                <Field label="Giá niêm yết (₫)" error={error("asking_price")}>
                  <MoneyInput
                    aria-label="Giá niêm yết (₫)"
                    value={form.watch("asking_price")}
                    onChange={(value) =>
                      form.setValue("asking_price", value ?? Number.NaN, {
                        shouldDirty: true,
                        shouldValidate: !!error("asking_price"),
                      })
                    }
                    showShortcuts={false}
                  />
                </Field>
              </div>
              <QuickChips
                label="Chọn màu nhanh"
                options={COLOR_CHIPS}
                selected={form.watch("color")}
                onSelect={(value) => setText("color", value)}
              />
              <Field label="Ghi chú" error={error("notes")}>
                <textarea
                  rows={3}
                  {...form.register("notes")}
                  placeholder="Tình trạng xe, hồ sơ, phụ kiện đi kèm…"
                />
              </Field>
            </details>
          </Card>
        </fieldset>
        {draft.saved && (
          <p className="muted small" role="status">
            Đã giữ bản nháp thông tin trên thiết bị này. Giá tiền cần nhập lại
            khi tiếp tục bản nháp.
          </p>
        )}
        {mutation.isError && <ErrorState error={mutation.error} />}
        <div className="form-actions mobile-sticky-actions">
          <Link className="button secondary" to="/acquisitions">
            Quay lại
          </Link>
          <Button type="submit" disabled={mutation.isPending || !!duplicate}>
            {mutation.isPending ? "Đang lưu…" : "Xác nhận thu xe"}
          </Button>
        </div>
      </form>
    </div>
  );
}
