import { useDeferredValue, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CirclePlus, Pencil, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { canManage } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Button,
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import type { Expense, Paged, Vehicle } from "@/types";
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
const pageSize = 20;

export function ExpensesPage() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const kind: ExpenseKind =
    params.get("kind") === "business" ? "business" : "vehicle";
  const selectedVehicle = params.get("vehicle") ?? "";
  const [range, setRange] = useState({
    from: `${today().slice(0, 7)}-01`,
    to: today(),
  });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [editing, setEditing] = useState<ExpenseRecord | null>(null);
  const [adding, setAdding] = useState(params.get("new") === "1");
  useEffect(() => {
    if (params.get("new") === "1") setAdding(true);
  }, [params]);
  const query = useQuery({
    queryKey: ["expenses", kind, range, selectedVehicle, deferredSearch, page],
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
    setAdding(false);
  }
  if (!canManage(profile))
    return (
      <EmptyState
        title="Chi phí dành cho chủ cửa hàng và quản lý"
        description="Liên hệ chủ cửa hàng nếu cần bổ sung quyền truy cập."
      />
    );
  const labels =
    kind === "vehicle" ? vehicleExpenseLabels : businessExpenseLabels;
  return (
    <div className="stack">
      <PageHeader
        title="Quản lý chi phí"
        description="Tách biệt chi phí của từng xe và chi phí vận hành cửa hàng."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            <CirclePlus size={18} /> Thêm chi phí
          </Button>
        }
      />
      <Card>
        <div className="tabs" aria-label="Loại chi phí">
          <button
            className={`tab ${kind === "vehicle" ? "active" : ""}`}
            aria-pressed={kind === "vehicle"}
            onClick={() => changeKind("vehicle")}
          >
            Chi phí xe
          </button>
          <button
            className={`tab ${kind === "business" ? "active" : ""}`}
            aria-pressed={kind === "business"}
            onClick={() => changeKind("business")}
          >
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
          <div className="table-wrap desktop-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ngày chi</th>
                  <th>Nội dung</th>
                  {kind === "vehicle" && <th>Xe</th>}
                  <th>Phân loại</th>
                  <th className="numeric">Số tiền</th>
                  <th>Trạng thái</th>
                  <th />
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
                      {expense.status === "ACTIVE" && (
                        <Button
                          variant="ghost"
                          aria-label={`Sửa chi phí ${expense.description}`}
                          onClick={() => {
                            setAdding(false);
                            setEditing(expense);
                          }}
                        >
                          <Pencil size={16} />
                        </Button>
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
                  {expense.status === "ACTIVE" && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setAdding(false);
                        setEditing(expense);
                      }}
                    >
                      <Pencil size={16} /> Chỉnh sửa
                    </Button>
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
  const [vehicleSearch, setVehicleSearch] = useState("");
  const deferredSearch = useDeferredValue(vehicleSearch);
  const [showCancel, setShowCancel] = useState(false);
  const [reason, setReason] = useState("");
  const initialVehicle = expense?.vehicle_id ?? vehicleId;
  const currentVehicle = useQuery({
    queryKey: ["vehicle", initialVehicle],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: initialVehicle }),
    enabled: kind === "vehicle" && !!initialVehicle,
  });
  const vehicleChoices = useQuery({
    queryKey: ["expense-vehicle-picker", deferredSearch],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: {
          search: deferredSearch,
          status: "AVAILABLE",
          limit: 30,
          offset: 0,
        },
      }),
    enabled: kind === "vehicle" && !initialVehicle,
  });
  const form = useForm<ExpenseValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      vehicle_id: initialVehicle,
      type: expense?.expense_type ?? expense?.category ?? "OTHER",
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
    kind === "vehicle" &&
    !!initialVehicle &&
    !!currentVehicle.data &&
    !["IN_STOCK", "RESERVED"].includes(currentVehicle.data.status);
  const vehicleUnavailable =
    kind === "vehicle" &&
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
      if (kind === "vehicle") {
        data.vehicle_id = values.vehicle_id;
        data.expense_type = values.type;
      } else data.category = values.type;
      return api.call("save_expense", {
        p_kind: kind,
        p_data: data,
        ...(expense ? { p_id: expense.id } : {}),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries();
      onClose();
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      api.call("cancel_expense", {
        p_kind: kind,
        p_id: expense!.id,
        p_reason: reason.trim(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries();
      onClose();
    },
  });
  const labels =
    kind === "vehicle" ? vehicleExpenseLabels : businessExpenseLabels;
  return (
    <Card>
      <div className="row between">
        <h2 className="section-title">
          {expense ? "Chỉnh sửa" : "Thêm"}{" "}
          {kind === "vehicle" ? "chi phí xe" : "chi phí cửa hàng"}
        </h2>
        <Button
          variant="ghost"
          aria-label="Đóng biểu mẫu chi phí"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </div>
      <form
        className="stack"
        onSubmit={form.handleSubmit((values) => {
          if (vehicleUnavailable || save.isPending || cancel.isPending) return;
          if (
            kind === "vehicle" &&
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
        {kind === "vehicle" &&
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
              <input
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                {...form.register("amount", { valueAsNumber: true })}
              />
            </Field>
            <Field
              label="Ngày chi *"
              error={form.formState.errors.expense_date?.message}
            >
              <input type="date" {...form.register("expense_date")} />
            </Field>
          </div>
          <Field
            label="Nội dung chi phí *"
            error={form.formState.errors.description?.message}
          >
            <textarea
              rows={2}
              placeholder={
                kind === "vehicle"
                  ? "Ví dụ: thay lốp trước, vận chuyển xe về kho…"
                  : "Ví dụ: tiền thuê mặt bằng tháng này…"
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
