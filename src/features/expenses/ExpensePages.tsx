import { useDeferredValue, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Bike,
  CirclePlus,
  Pencil,
  Search,
  Store,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { canManage } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Button,
  Card,
  DatePicker,
  DateRange,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { MoneyInput } from "@/components/ui/MoneyInput";
import type { Expense, Paged, Vehicle } from "@/types";
import { AVAILABLE_VEHICLE_FILTER } from "@/lib/vehicleFilters";
import {
  businessExpenseLabels,
  dateValue,
  moneyValue,
  vehicleExpenseLabels,
} from "@/features/vehicles/vehicleSchema";

type ExpenseKind = "vehicle" | "business";
type ExpenseRecord = Expense & { kind?: ExpenseKind; vehicle_code?: string };

export const expenseSchema = z.object({
  vehicle_id: z.string(),
  type: z.string().min(1, "Chọn loại chi phí."),
  description: z.string().trim().min(1, "Nhập nội dung chi phí.").max(1000),
  amount: moneyValue.refine((amount) => amount > 0, "Chi phí phải lớn hơn 0."),
  expense_date: dateValue,
});
type ExpenseValues = z.infer<typeof expenseSchema>;

const pageSize = 10;

export function ExpensesPage({
  hideHeader = false,
  defaultKind = "vehicle",
}: {
  hideHeader?: boolean;
  defaultKind?: ExpenseKind;
} = {}) {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();

  const kind: ExpenseKind =
    params.get("kind") === "business"
      ? "business"
      : params.get("kind") === "vehicle"
        ? "vehicle"
        : defaultKind;

  const selectedVehicle = params.get("vehicle") ?? "";
  const [range, setRange] = useState({
    from: `${today().slice(0, 7)}-01`,
    to: today(),
  });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [editing, setEditing] = useState<ExpenseRecord | null>(null);
  const [cancelling, setCancelling] = useState<ExpenseRecord | null>(null);
  const [adding, setAdding] = useState(params.get("new") === "1");

  useEffect(() => {
    if (params.get("new") === "1") setAdding(true);
  }, [params]);

  const query = useQuery({
    queryKey: [
      "expenses",
      kind,
      range,
      selectedVehicle,
      deferredSearch,
      page,
    ],
    placeholderData: (prev) => prev,
    queryFn: () =>
      api.call<Paged<ExpenseRecord>>("list_expenses", {
        p_filters: {
          kind,
          ...range,
          vehicle_id: selectedVehicle || undefined,
          search: deferredSearch,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
    enabled: canManage(profile),
  });

  useEffect(() => {
    if (query.data && page * pageSize < query.data.total && canManage(profile)) {
      void client.prefetchQuery({
        queryKey: [
          "expenses",
          kind,
          range,
          selectedVehicle,
          deferredSearch,
          page + 1,
        ],
        queryFn: () =>
          api.call<Paged<ExpenseRecord>>("list_expenses", {
            p_filters: {
              kind,
              ...range,
              vehicle_id: selectedVehicle || undefined,
              search: deferredSearch,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [query.data, page, kind, range, selectedVehicle, deferredSearch, client, profile]);

  function closeEditor() {
    setAdding(false);
    setEditing(null);
    if (params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  }

  function changeKind(value: ExpenseKind) {
    setParams({ kind: value });
    setPage(1);
    setEditing(null);
    setCancelling(null);
    setAdding(false);
  }

  if (!canManage(profile)) {
    return (
      <EmptyState
        title="Chi phí dành cho chủ cửa hàng và quản lý"
        description="Liên hệ chủ cửa hàng nếu cần bổ sung quyền truy cập."
      />
    );
  }

  const labels =
    kind === "vehicle" ? vehicleExpenseLabels : businessExpenseLabels;

  const activeItems = query.data?.items.filter((i) => i.status === "ACTIVE") ?? [];
  const pageActiveTotal = activeItems.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="stack">
      {!hideHeader && (
        <PageHeader
          title="Quản lý chi phí"
          description="Ghi nhận và theo dõi chi phí xe (tân trang, phụ tùng, sửa chữa) và chi phí vận hành cửa hàng."
          actions={
            <Button
              onClick={() => {
                setCancelling(null);
                setEditing(null);
                setAdding(true);
              }}
            >
              <CirclePlus size={18} /> Thêm chi phí
            </Button>
          }
        />
      )}

      <Card>
        <div className="tabs" aria-label="Loại chi phí">
          <button
            className={`tab ${kind === "vehicle" ? "active" : ""}`}
            aria-pressed={kind === "vehicle"}
            onClick={() => changeKind("vehicle")}
          >
            <Bike size={16} />
            Chi phí xe
          </button>
          <button
            className={`tab ${kind === "business" ? "active" : ""}`}
            aria-pressed={kind === "business"}
            onClick={() => changeKind("business")}
          >
            <Store size={16} />
            Chi phí cửa hàng
          </button>
        </div>

        <div className="row filter-row">
          <label className="search-field">
            <Search size={19} />
            <input
              aria-label="Tìm chi phí"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Tìm theo nội dung chi phí…"
            />
          </label>
          <DateRange
            value={range}
            onChange={(value) => {
              setRange(value);
              setPage(1);
            }}
          />
        </div>

        {selectedVehicle && (
          <p className="notice">
            Đang lọc chi phí theo xe đã chọn.{" "}
            <Button
              variant="ghost"
              onClick={() => {
                setParams({ kind });
                setPage(1);
              }}
            >
              Xem tất cả xe
            </Button>
          </p>
        )}
      </Card>

      {(adding || editing) && (
        <ExpenseEditor
          key={`${kind}-${editing?.id ?? selectedVehicle ?? "new"}`}
          kind={kind}
          expense={editing ?? undefined}
          vehicleId={selectedVehicle}
          onClose={closeEditor}
        />
      )}

      {cancelling && (
        <CancelExpenseDialog
          expense={cancelling}
          kind={kind}
          onClose={() => setCancelling(null)}
        />
      )}

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.items.length ? (
        <EmptyState
          title="Chưa có chi phí phù hợp"
          description="Thêm chi phí hoặc chọn khoảng thời gian khác để xem dữ liệu."
        />
      ) : (
        <Card className="table-card">
          <div
            className="row between"
            style={{
              padding: "10px 16px",
              background: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
              borderBottom: "1px solid #e2e8f0",
              fontSize: "13.5px",
              alignItems: "center",
            }}
          >
            <span>
              Tổng cộng: <strong>{query.data.total}</strong> khoản chi (
              {kind === "vehicle" ? "Chi phí xe" : "Chi phí cửa hàng"})
            </span>
            <span>
              Tổng tiền trang này:{" "}
              <strong className="price" style={{ color: "#dc2626", fontSize: "14.5px" }}>
                {money(pageActiveTotal)}
              </strong>
            </span>
          </div>

          {query.isFetching && !query.isPending && (
            <div
              className="table-updating-bar"
              role="progressbar"
              aria-label="Đang cập nhật danh sách"
            />
          )}

          <div
            className={`table-wrap desktop-table ${
              query.isFetching && !query.isPending ? "is-updating" : ""
            }`}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ngày chi</th>
                  <th>Nội dung</th>
                  {kind === "vehicle" && <th>Xe</th>}
                  <th>Phân loại</th>
                  <th className="numeric">Số tiền</th>
                  <th>Trạng thái</th>
                  <th style={{ textAlign: "right", minWidth: "90px" }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((expense) => (
                  <tr key={expense.id}>
                    <td>{dateLabel(expense.expense_date)}</td>
                    <td>
                      <strong>{expense.description}</strong>
                    </td>
                    {kind === "vehicle" && (
                      <td>
                        <Link
                          className="text-link"
                          to={`/vehicles/${expense.vehicle_id}`}
                        >
                          {expense.vehicle_code ||
                            expense.internal_code ||
                            "Chi tiết xe"}
                        </Link>
                        <small>{expense.vehicle_name}</small>
                      </td>
                    )}
                    <td>
                      {labels[
                        expense.expense_type ?? expense.category ?? "OTHER"
                      ] ?? "Khác"}
                    </td>
                    <td className="numeric price">{money(expense.amount)}</td>
                    <td>
                      <Badge status={expense.status} />
                    </td>
                    <td>
                      {expense.status === "ACTIVE" ? (
                        <div
                          className="row"
                          style={{
                            gap: "6px",
                            justifyContent: "flex-end",
                          }}
                        >
                          <Button
                            variant="ghost"
                            aria-label={`Sửa chi phí ${expense.description}`}
                            title="Chỉnh sửa chi phí"
                            onClick={() => {
                              setCancelling(null);
                              setAdding(false);
                              setEditing(expense);
                            }}
                          >
                            <Pencil size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            style={{ color: "#dc2626" }}
                            aria-label={`Hủy chi phí ${expense.description}`}
                            title="Hủy khoản chi"
                            onClick={() => {
                              setEditing(null);
                              setAdding(false);
                              setCancelling(expense);
                            }}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      ) : (
                        <span className="muted small" style={{ display: "block", textAlign: "right" }}>
                          Đã hủy
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mobile-cards">
            {query.data.items.map((expense) => (
              <div key={expense.id} className="mobile-record">
                <div className="row between">
                  <strong>{expense.description}</strong>
                  <Badge status={expense.status} />
                </div>
                <span className="muted">
                  {dateLabel(expense.expense_date)} ·{" "}
                  {labels[
                    expense.expense_type ?? expense.category ?? "OTHER"
                  ] ?? "Khác"}
                </span>
                {kind === "vehicle" && (
                  <Link
                    className="text-link"
                    to={`/vehicles/${expense.vehicle_id}`}
                  >
                    {expense.vehicle_code ||
                      expense.internal_code ||
                      expense.vehicle_name}
                  </Link>
                )}
                <div className="row between">
                  <strong className="price">{money(expense.amount)}</strong>
                  {expense.status === "ACTIVE" ? (
                    <div className="row" style={{ gap: "4px" }}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setCancelling(null);
                          setAdding(false);
                          setEditing(expense);
                        }}
                      >
                        <Pencil size={14} /> Sửa
                      </Button>
                      <Button
                        variant="ghost"
                        style={{ color: "#dc2626" }}
                        onClick={() => {
                          setEditing(null);
                          setAdding(false);
                          setCancelling(expense);
                        }}
                      >
                        <Trash2 size={14} /> Hủy
                      </Button>
                    </div>
                  ) : (
                    <span className="muted small">Đã hủy</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <Pagination
            page={page}
            total={query.data.total}
            pageSize={pageSize}
            onChange={setPage}
          />
        </Card>
      )}
    </div>
  );
}

function CancelExpenseDialog({
  expense,
  kind,
  onClose,
}: {
  expense: ExpenseRecord;
  kind: ExpenseKind;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () =>
      api.call("cancel_expense", {
        p_kind: expense.kind ?? kind,
        p_id: expense.id,
        p_reason: reason.trim(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["expenses"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Đã hủy chi phí thành công.");
      onClose();
    },
  });

  return (
    <Card style={{ borderLeft: "4px solid #dc2626" }}>
      <div className="row between">
        <h2 className="section-title" style={{ color: "#dc2626" }}>
          Xác nhận hủy khoản chi
        </h2>
        <Button variant="ghost" aria-label="Đóng bảng hủy chi phí" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      <p className="notice" style={{ marginTop: "6px" }}>
        Bạn đang thực hiện hủy chi phí: <strong>{expense.description}</strong> (
        {money(expense.amount)}). Khoản chi này sẽ không còn tính vào tổng chi phí nhưng vẫn được lưu vết kiểm toán.
      </p>
      <form
        className="stack"
        style={{ marginTop: "12px" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim().length >= 5 && !cancel.isPending) {
            cancel.mutate();
          }
        }}
      >
        <Field
          label="Lý do hủy (ít nhất 5 ký tự) *"
          error={
            reason.length > 0 && reason.trim().length < 5
              ? "Lý do hủy cần ít nhất 5 ký tự."
              : undefined
          }
        >
          <textarea
            minLength={5}
            maxLength={1000}
            required
            disabled={cancel.isPending}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ví dụ: Nhập nhầm số tiền, chi phí bị trùng lặp, trả hàng…"
            rows={2}
          />
        </Field>
        {cancel.isError && <ErrorState error={cancel.error} />}
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={cancel.isPending}
          >
            Giữ lại
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={cancel.isPending || reason.trim().length < 5}
          >
            {cancel.isPending ? "Đang hủy…" : "Xác nhận hủy chi phí"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ExpenseEditor({
  kind,
  expense,
  vehicleId,
  onClose,
}: {
  kind: ExpenseKind;
  expense?: ExpenseRecord;
  vehicleId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [editorKind, setEditorKind] = useState<ExpenseKind>(
    expense?.kind ?? (expense?.vehicle_id ? "vehicle" : kind),
  );
  const [vehicleSearch, setVehicleSearch] = useState("");
  const deferredSearch = useDeferredValue(vehicleSearch);
  const [showCancel, setShowCancel] = useState(false);
  const [reason, setReason] = useState("");

  const initialVehicle = expense?.vehicle_id ?? vehicleId;
  const currentVehicle = useQuery({
    queryKey: ["vehicle", initialVehicle],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: initialVehicle }),
    enabled: editorKind === "vehicle" && !!initialVehicle,
  });

  const vehicleChoices = useQuery({
    queryKey: ["expense-vehicle-picker", deferredSearch],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: {
          search: deferredSearch,
          status: AVAILABLE_VEHICLE_FILTER,
          limit: 30,
          offset: 0,
        },
      }),
    enabled: editorKind === "vehicle" && !initialVehicle,
  });

  const form = useForm<ExpenseValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      vehicle_id: initialVehicle,
      type:
        expense?.expense_type ??
        expense?.category ??
        (editorKind === "vehicle" ? "PARTS" : "RENT"),
      description: expense?.description ?? "",
      amount: expense?.amount ?? 0,
      expense_date: expense?.expense_date ?? today(),
    },
  });

  const selectedVehicleId = useWatch({
    control: form.control,
    name: "vehicle_id",
  });
  const selectedChoice = vehicleChoices.data?.items.find(
    (vehicle) => vehicle.id === selectedVehicleId,
  );

  const vehicleLocked =
    editorKind === "vehicle" &&
    !!initialVehicle &&
    !!currentVehicle.data &&
    !["IN_STOCK", "RESERVED"].includes(currentVehicle.data.status);
  const vehicleUnavailable =
    editorKind === "vehicle" &&
    !!initialVehicle &&
    (currentVehicle.isPending || currentVehicle.isError || vehicleLocked);
  const choicesLoading =
    vehicleChoices.isFetching || vehicleSearch !== deferredSearch;

  const save = useMutation({
    mutationFn: (values: ExpenseValues) => {
      const data: Record<string, unknown> = {
        description: values.description,
        amount: values.amount,
        expense_date: values.expense_date,
      };
      if (editorKind === "vehicle") {
        data.vehicle_id = values.vehicle_id;
        data.expense_type = values.type;
      } else {
        data.category = values.type;
      }
      return api.call("save_expense", {
        p_kind: editorKind,
        p_data: data,
        ...(expense ? { p_id: expense.id } : {}),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["expenses"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["vehicle"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(
        expense
          ? "Đã cập nhật chi phí thành công."
          : "Đã thêm chi phí thành công.",
      );
      onClose();
    },
  });

  const cancel = useMutation({
    mutationFn: () =>
      api.call("cancel_expense", {
        p_kind: editorKind,
        p_id: expense!.id,
        p_reason: reason.trim(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["expenses"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Đã hủy chi phí thành công.");
      onClose();
    },
  });

  const labels =
    editorKind === "vehicle" ? vehicleExpenseLabels : businessExpenseLabels;

  return (
    <Card>
      <div className="row between" style={{ marginBottom: "12px" }}>
        <h2 className="section-title">
          {expense ? "Chỉnh sửa" : "Thêm"}{" "}
          {editorKind === "vehicle" ? "chi phí xe" : "chi phí cửa hàng"}
        </h2>
        <Button
          variant="ghost"
          aria-label="Đóng biểu mẫu chi phí"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </div>

      {!expense && !vehicleId && (
        <div className="tabs" style={{ marginBottom: "16px" }} aria-label="Chọn loại chi phí">
          <button
            type="button"
            className={`tab ${editorKind === "vehicle" ? "active" : ""}`}
            onClick={() => {
              setEditorKind("vehicle");
              form.setValue("type", "PARTS");
            }}
          >
            <Bike size={15} />
            Chi phí xe
          </button>
          <button
            type="button"
            className={`tab ${editorKind === "business" ? "active" : ""}`}
            onClick={() => {
              setEditorKind("business");
              form.setValue("type", "RENT");
              form.clearErrors("vehicle_id");
            }}
          >
            <Store size={15} />
            Chi phí cửa hàng
          </button>
        </div>
      )}

      <form
        className="stack"
        onSubmit={form.handleSubmit((values) => {
          if (vehicleUnavailable || save.isPending || cancel.isPending) return;
          if (
            editorKind === "vehicle" &&
            (!values.vehicle_id ||
              (!initialVehicle && (!selectedChoice || choicesLoading)))
          ) {
            form.setError("vehicle_id", {
              message: "Chọn xe cần ghi nhận chi phí.",
            });
            return;
          }
          save.mutate(values);
        })}
      >
        {editorKind === "vehicle" &&
          (initialVehicle ? (
            currentVehicle.isPending ? (
              <Loading />
            ) : currentVehicle.isError ? (
              <ErrorState
                error={currentVehicle.error}
                retry={() => void currentVehicle.refetch()}
              />
            ) : (
              <p className="notice">
                {currentVehicle.data?.internal_code} ·{" "}
                {currentVehicle.data?.brand} {currentVehicle.data?.model}
                {currentVehicle.data?.status === "SOLD" &&
                  " — Xe đã bán: các khoản chi đã khóa để giữ nguyên giá vốn giao dịch."}
                {currentVehicle.data?.status === "CANCELLED" &&
                  " — Xe đã hủy: không thể thêm, sửa hoặc hủy chi phí."}
              </p>
            )
          ) : (
            <div className="form-grid">
              <Field label="Tìm xe">
                <input
                  value={vehicleSearch}
                  disabled={save.isPending}
                  onChange={(event) => {
                    setVehicleSearch(event.target.value);
                    form.setValue("vehicle_id", "", { shouldDirty: true });
                    form.clearErrors("vehicle_id");
                  }}
                  placeholder="Mã xe, biển số, hãng…"
                />
              </Field>
              <Field
                label="Chọn xe *"
                error={form.formState.errors.vehicle_id?.message}
              >
                <select
                  aria-label="Chọn xe *"
                  {...form.register("vehicle_id")}
                  value={selectedChoice?.id ?? ""}
                  disabled={
                    choicesLoading || vehicleChoices.isError || save.isPending
                  }
                >
                  <option value="">
                    {vehicleChoices.isPending || choicesLoading
                      ? "Đang tải danh sách…"
                      : vehicleChoices.data?.items.length === 0
                        ? "Không có xe phù hợp"
                        : "Chọn một xe"}
                  </option>
                  {vehicleChoices.data?.items.map((vehicle) => (
                    <option value={vehicle.id} key={vehicle.id}>
                      {vehicle.internal_code} · {vehicle.brand} {vehicle.model}{" "}
                      · {vehicle.license_plate || "Chưa có biển số"}
                    </option>
                  ))}
                </select>
                {vehicleChoices.isError && (
                  <ErrorState
                    error={vehicleChoices.error}
                    retry={() => void vehicleChoices.refetch()}
                  />
                )}
              </Field>
            </div>
          ))}
        <fieldset
          className="plain-fieldset stack"
          disabled={vehicleUnavailable || save.isPending || cancel.isPending}
        >
          <div className="form-grid">
            <Field
              label="Phân loại *"
              error={form.formState.errors.type?.message}
            >
              <select {...form.register("type")}>
                {Object.entries(labels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Số tiền (₫) *"
              error={form.formState.errors.amount?.message}
            >
              <MoneyInput
                aria-label="Số tiền (₫) *"
                value={form.watch("amount")}
                onChange={(value) =>
                  form.setValue("amount", value ?? Number.NaN, {
                    shouldValidate: true,
                    shouldDirty: true,
                  })
                }
                onBlur={() => void form.trigger("amount")}
                min={0}
                required
                showShortcuts={false}
              />
            </Field>
            <Field
              label="Ngày chi *"
              error={form.formState.errors.expense_date?.message}
            >
              <DatePicker
                aria-label="Ngày chi *"
                value={form.watch("expense_date")}
                onChange={(val) =>
                  form.setValue("expense_date", val, {
                    shouldDirty: true,
                    shouldValidate: !!form.formState.errors.expense_date,
                  })
                }
                onBlur={() => void form.trigger("expense_date")}
                max={today()}
                required
              />
            </Field>
          </div>
          <Field
            label="Nội dung chi phí *"
            error={form.formState.errors.description?.message}
          >
            <textarea
              rows={2}
              placeholder={
                editorKind === "vehicle"
                  ? "Ví dụ: thay lốp trước, thay nhớt, bảo dưỡng phanh…"
                  : "Ví dụ: tiền thuê mặt bằng, điện nước tháng này, tiếp khách…"
              }
              {...form.register("description")}
            />
          </Field>
        </fieldset>
        {save.isError && <ErrorState error={save.error} />}
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <Button
            type="submit"
            disabled={vehicleUnavailable || save.isPending || cancel.isPending}
          >
            {save.isPending
              ? "Đang lưu…"
              : expense
                ? "Lưu thay đổi"
                : "Lưu chi phí"}
          </Button>
        </div>
      </form>
      {expense && (
        <div className="cancel-section">
          {!showCancel ? (
            <Button
              variant="danger"
              disabled={vehicleUnavailable || save.isPending}
              onClick={() => setShowCancel(true)}
            >
              Hủy khoản chi này
            </Button>
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !vehicleUnavailable &&
                  !save.isPending &&
                  !cancel.isPending &&
                  reason.trim().length >= 5
                )
                  cancel.mutate();
              }}
            >
              <p className="muted">
                Chi phí đã hủy được lưu trong lịch sử và không tính vào giá vốn
                hoặc tổng chi hiện tại.
              </p>
              <Field label="Lý do hủy *">
                <textarea
                  minLength={5}
                  maxLength={1000}
                  required
                  disabled={
                    vehicleUnavailable || save.isPending || cancel.isPending
                  }
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Nhập lý do (ít nhất 5 ký tự)"
                />
              </Field>
              {cancel.isError && <ErrorState error={cancel.error} />}
              <div className="form-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowCancel(false)}
                >
                  Giữ lại
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  disabled={
                    cancel.isPending ||
                    save.isPending ||
                    vehicleUnavailable ||
                    reason.trim().length < 5
                  }
                >
                  {cancel.isPending ? "Đang hủy…" : "Xác nhận hủy chi phí"}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
