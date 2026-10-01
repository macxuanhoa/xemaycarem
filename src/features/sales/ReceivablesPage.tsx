import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Phone,
  Search,
  User,
} from "lucide-react";
import { api } from "@/lib/api";
import { canOperate } from "@/lib/permissions";
import { dateLabel, money, shiftDate, today } from "@/lib/format";
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
import type { ReceivablesSummary, Sale } from "@/types";
import { PaymentEditor } from "./SaleDetailPage";

const pageSize = 6;

export function ReceivablesPage({
  hideHeader = false,
}: {
  hideHeader?: boolean;
} = {}) {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const deferredSearch = useDebouncedValue(search);
  const paymentStatus = params.get("payment_status") || "DEBT_ONLY";
  const setPaymentStatus = (value: string) =>
    setParams({ payment_status: value });
  const [sort, setSort] = useState("highest_debt");
  const [range, setRange] = useState({ from: "", to: "" });
  const [page, setPage] = useState(1);
  const [payingSale, setPayingSale] = useState<Sale | null>(null);
  const [editingDueDateSale, setEditingDueDateSale] = useState<Sale | null>(
    null,
  );
  const [dueDateInput, setDueDateInput] = useState("");

  const query = useQuery({
    queryKey: [
      "receivables",
      deferredSearch,
      paymentStatus,
      sort,
      range,
      page,
    ],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.call<ReceivablesSummary>("list_receivables", {
        p_filters: {
          search: deferredSearch,
          payment_status: paymentStatus,
          sort,
          from: range.from || undefined,
          to: range.to || undefined,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
  });

  useEffect(() => {
    if (query.data && page * pageSize < query.data.total) {
      void client.prefetchQuery({
        queryKey: [
          "receivables",
          deferredSearch,
          paymentStatus,
          sort,
          range,
          page + 1,
        ],
        queryFn: () =>
          api.call<ReceivablesSummary>("list_receivables", {
            p_filters: {
              search: deferredSearch,
              payment_status: paymentStatus,
              sort,
              from: range.from || undefined,
              to: range.to || undefined,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [query.data, page, deferredSearch, paymentStatus, sort, range, client]);

  const dueDateMutation = useMutation({
    mutationFn: ({ saleId, dueDate }: { saleId: string; dueDate: string }) =>
      api.call("update_sale_due_date", {
        p_sale_id: saleId,
        p_due_date: dueDate || null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["receivables"] });
      await client.invalidateQueries({ queryKey: ["sales"] });
      await Promise.all(
        [
          "sale",
          "dashboard",
          "customers",
          "customer-history",
          "global-search",
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
      setEditingDueDateSale(null);
    },
  });

  const data = query.data;

  const filterPills = [
    { key: "DEBT_ONLY", label: "Tất cả còn nợ" },
    { key: "OVERDUE", label: "Quá hạn thanh toán" },
    { key: "PARTIALLY_PAID", label: "Đã trả một phần" },
    { key: "UNPAID", label: "Chưa trả" },
    { key: "PAID", label: "Đã thanh toán đủ" },
    { key: "ALL", label: "Toàn bộ" },
  ];

  return (
    <div className="stack">
      {!hideHeader && (
        <PageHeader
          title="Công nợ khách hàng"
          description="Theo dõi các khoản tiền bán xe chưa thu, quản lý hạn thanh toán và thu hồi nợ."
        />
      )}

      {data && (
        <div className="executive-kpi-grid">
          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Tổng công nợ</span>
              <span className="executive-metric-icon indigo">
                <CreditCard size={18} />
              </span>
            </div>
            <strong className="executive-metric-val price" style={{ color: "#4f46e5" }}>
              {money(data.total_receivable)}
            </strong>
            <span className="executive-metric-sub">
              <strong>{data.unpaid_count}</strong> giao dịch đang còn nợ
            </span>
          </div>

          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Nợ đã quá hạn</span>
              <span className="executive-metric-icon rose">
                <Clock size={18} />
              </span>
            </div>
            <strong
              className="executive-metric-val"
              style={{ color: data.total_overdue > 0 ? "#dc2626" : "inherit" }}
            >
              {money(data.total_overdue)}
            </strong>
            <span className="executive-metric-sub">
              <strong style={{ color: data.overdue_count > 0 ? "#dc2626" : "inherit" }}>
                {data.overdue_count}
              </strong>{" "}
              khách đã trễ hạn hẹn trả
            </span>
          </div>

          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Nợ trong hạn hẹn</span>
              <span className="executive-metric-icon amber">
                <Calendar size={18} />
              </span>
            </div>
            <strong className="executive-metric-val">
              {money(Math.max(0, data.total_receivable - data.total_overdue))}
            </strong>
            <span className="executive-metric-sub">
              <strong>{Math.max(0, data.unpaid_count - data.overdue_count)}</strong> khoản nợ đang đúng hạn
            </span>
          </div>

          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Tình trạng nợ</span>
              <span className={`executive-metric-icon ${data.overdue_count === 0 ? "emerald" : "rose"}`}>
                <CheckCircle2 size={18} />
              </span>
            </div>
            <strong
              className="executive-metric-val"
              style={{
                fontSize: "20px",
                color: data.overdue_count === 0 ? "#16a34a" : "#dc2626",
              }}
            >
              {data.overdue_count === 0 ? "Đảm bảo an toàn" : `${data.overdue_count} khoản quá hạn`}
            </strong>
            <span className="executive-metric-sub">
              {data.overdue_count > 0 ? "Cần liên hệ đôn đốc khách" : "100% nợ đang trong hạn"}
            </span>
          </div>
        </div>
      )}

      <Card>
        <div className="receivables-filter-container">
          <div className="filter-pills-bar" role="group" aria-label="Bộ lọc trạng thái nợ">
            {filterPills.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={paymentStatus === p.key}
                className={`filter-pill ${paymentStatus === p.key ? "active" : ""}`}
                onClick={() => {
                  setPaymentStatus(p.key);
                  setPage(1);
                }}
              >
                <span>{p.label}</span>
              </button>
            ))}
          </div>

          <div className="receivables-filter-controls">
            <div className="receivables-search-wrap">
              <Search size={18} className="search-icon" />
              <input
                aria-label="Tìm công nợ"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Tên khách, SĐT, mã xe, biển số, mã giao dịch…"
              />
              {search && (
                <button
                  type="button"
                  className="receivables-clear-btn"
                  onClick={() => setSearch("")}
                  aria-label="Xóa tìm kiếm"
                >
                  <Search size={14} style={{ display: "none" }} />
                  ✕
                </button>
              )}
            </div>

            <Field label="Sắp xếp">
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(1);
                }}
              >
                <option value="highest_debt">Tiền nợ cao nhất</option>
                <option value="due_date">Hạn thanh toán gần nhất</option>
                <option value="newest">Ngày bán mới nhất</option>
                <option value="oldest">Ngày bán cũ nhất</option>
              </select>
            </Field>

            <DateRange
              value={range}
              onChange={(val) => {
                setRange(val);
                setPage(1);
              }}
            />
          </div>
        </div>
      </Card>

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !data?.items.length ? (
        <EmptyState
          title="Không tìm thấy khoản công nợ phù hợp"
          description="Hiện tại không có khoản nợ nào theo tiêu chí tìm kiếm hoặc tất cả đã thanh toán đủ."
        />
      ) : (
        <Card className="table-card">
          {query.isFetching && !query.isPending && (
            <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
          )}
          <div className={`table-wrap desktop-table ${query.isFetching && !query.isPending ? "is-updating" : ""}`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Giao dịch / Ngày bán</th>
                  <th>Khách hàng</th>
                  <th>Xe</th>
                  <th className="numeric">Giá bán</th>
                  <th className="numeric">Đã thu</th>
                  <th className="numeric">Còn phải thu</th>
                  <th>Hạn thanh toán</th>
                  <th>Trạng thái</th>
                  <th style={{ width: "130px" }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((sale) => {
                  const isOverdue =
                    sale.is_overdue ||
                    (sale.due_date &&
                      sale.due_date < today() &&
                      sale.remaining_amount > 0);
                  return (
                    <tr
                      key={sale.id}
                      className={isOverdue ? "row-warning" : undefined}
                    >
                      <td>
                        <Link className="text-link" to={`/sales/${sale.id}`}>
                          {sale.sale_code}
                        </Link>
                        <small>{dateLabel(sale.sale_date)}</small>
                      </td>
                      <td>
                        <div className="row" style={{ gap: "4px" }}>
                          <User size={15} className="muted" />
                          <strong>{sale.customer_name}</strong>
                        </div>
                        {sale.customer_phone ? (
                          <a
                            href={`tel:${sale.customer_phone}`}
                            className="muted small row"
                            style={{ gap: "4px", textDecoration: "none" }}
                          >
                            <Phone size={13} /> {sale.customer_phone}
                          </a>
                        ) : (
                          <small className="muted">Chưa có SĐT</small>
                        )}
                      </td>
                      <td>
                        <strong>
                          {sale.brand} {sale.model}
                        </strong>
                        <small>
                          {sale.internal_code} ·{" "}
                          {sale.license_plate || "Chưa biển"}
                        </small>
                      </td>
                      <td className="numeric">{money(sale.sale_price)}</td>
                      <td
                        className="numeric"
                        style={{ color: "var(--color-success, #16a34a)" }}
                      >
                        {money(sale.paid_amount)}
                      </td>
                      <td className="numeric">
                        <strong
                          style={{
                            color:
                              sale.remaining_amount > 0
                                ? isOverdue
                                  ? "#dc2626"
                                  : "#ea580c"
                                : "inherit",
                          }}
                        >
                          {money(sale.remaining_amount)}
                        </strong>
                      </td>
                      <td>
                        {sale.due_date ? (
                          <div className="row between" style={{ gap: "4px" }}>
                            <span className={isOverdue ? "text-danger" : ""}>
                              {dateLabel(sale.due_date)}
                            </span>
                            {canOperate(profile) &&
                              sale.remaining_amount > 0 && (
                                <button
                                  className="icon-button small"
                                  title="Đổi ngày hẹn trả"
                                  onClick={() => {
                                    setEditingDueDateSale(sale);
                                    setDueDateInput(sale.due_date || "");
                                  }}
                                >
                                  <Clock size={14} />
                                </button>
                              )}
                          </div>
                        ) : canOperate(profile) && sale.remaining_amount > 0 ? (
                          <Button
                            variant="ghost"
                            className="small"
                            onClick={() => {
                              setEditingDueDateSale(sale);
                              setDueDateInput("");
                            }}
                          >
                            <Calendar size={13} /> Hẹn ngày
                          </Button>
                        ) : (
                          <small className="muted">—</small>
                        )}
                      </td>
                      <td>
                        {isOverdue ? (
                          <span className="badge badge-cancelled">
                            <span /> Quá hạn
                          </span>
                        ) : (
                          <Badge
                            status={
                              sale.debt_status ||
                              (sale.remaining_amount <= 0
                                ? "PAID"
                                : sale.paid_amount > 0
                                  ? "PARTIALLY_PAID"
                                  : "UNPAID")
                            }
                          />
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: "6px" }}>
                          {canOperate(profile) &&
                            sale.status === "COMPLETED" &&
                            sale.remaining_amount > 0 && (
                              <Button
                                variant="secondary"
                                className="small"
                                onClick={() => setPayingSale(sale)}
                                title="Thu thêm tiền"
                              >
                                <CreditCard size={15} /> Thu tiền
                              </Button>
                            )}
                          <Link
                            className="icon-button"
                            to={`/sales/${sale.id}`}
                            aria-label={`Xem ${sale.sale_code}`}
                          >
                            <ArrowRight size={17} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mobile-cards">
            {data.items.map((sale) => {
              const isOverdue =
                sale.is_overdue ||
                (sale.due_date &&
                  sale.due_date < today() &&
                  sale.remaining_amount > 0);
              return (
                <div
                  key={sale.id}
                  className={`mobile-record ${isOverdue ? "record-warning" : ""}`}
                >
                  <div className="row between">
                    <Link to={`/sales/${sale.id}`} className="text-link">
                      <strong>{sale.sale_code}</strong>
                    </Link>
                    {isOverdue ? (
                      <span className="badge badge-cancelled">
                        <span /> Quá hạn
                      </span>
                    ) : (
                      <Badge
                        status={
                          sale.debt_status ||
                          (sale.remaining_amount <= 0
                            ? "PAID"
                            : "PARTIALLY_PAID")
                        }
                      />
                    )}
                  </div>
                  <div className="row between small">
                    <span>
                      {sale.brand} {sale.model} ({sale.internal_code})
                    </span>
                    <span className="muted">{dateLabel(sale.sale_date)}</span>
                  </div>
                  <div className="row between">
                    <span>
                      {sale.customer_name}
                      {sale.customer_phone && ` · ${sale.customer_phone}`}
                    </span>
                  </div>
                  <div className="row between price-row">
                    <div>
                      <small className="muted">
                        Giá bán: {money(sale.sale_price)}
                      </small>
                      <br />
                      <small className="muted">
                        Đã thu: {money(sale.paid_amount)}
                      </small>
                    </div>
                    <div className="align-right">
                      <small className="muted">Còn phải thu</small>
                      <br />
                      <strong
                        className="price"
                        style={{ color: isOverdue ? "#dc2626" : "#ea580c" }}
                      >
                        {money(sale.remaining_amount)}
                      </strong>
                    </div>
                  </div>
                  {sale.due_date && (
                    <div
                      className="row between small muted"
                      style={{ marginTop: "4px" }}
                    >
                      <span>Hạn trả: {dateLabel(sale.due_date)}</span>
                      {isOverdue && (
                        <span style={{ color: "#dc2626" }}>Đã quá hạn</span>
                      )}
                    </div>
                  )}
                  {canOperate(profile) && sale.remaining_amount > 0 && (
                    <div
                      className="row"
                      style={{ marginTop: "8px", gap: "8px" }}
                    >
                      <Button
                        variant="secondary"
                        className="full-width"
                        onClick={() => setPayingSale(sale)}
                      >
                        <CreditCard size={16} /> Thu thêm tiền
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEditingDueDateSale(sale);
                          setDueDateInput(sale.due_date || "");
                        }}
                      >
                        <Clock size={16} /> Hạn trả
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <Pagination
            page={page}
            total={data.total}
            pageSize={pageSize}
            onChange={setPage}
          />
        </Card>
      )}

      {/* Due Date Modal */}
      {editingDueDateSale && (
        <div
          className="modal-backdrop"
          onClick={() => setEditingDueDateSale(null)}
          role="presentation"
        >
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <Card>
            <h3>Hẹn ngày thanh toán</h3>
            <p className="muted small">
              Giao dịch: <strong>{editingDueDateSale.sale_code}</strong> ·
              Khách: <strong>{editingDueDateSale.customer_name}</strong>
            </p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                dueDateMutation.mutate({
                  saleId: editingDueDateSale.id,
                  dueDate: dueDateInput,
                });
              }}
            >
              <Field
                label="Hạn trả tiền *"
                error={
                  dueDateMutation.error instanceof Error
                    ? dueDateMutation.error.message
                    : undefined
                }
              >
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
                  {[
                    { label: "+3 ngày", days: 3 },
                    { label: "+7 ngày (1 tuần)", days: 7 },
                    { label: "+15 ngày", days: 15 },
                    { label: "+30 ngày (1 tháng)", days: 30 },
                  ].map((preset) => {
                    const target = shiftDate(today(), preset.days);
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        className="filter-pill"
                        style={{ fontSize: "11.5px", padding: "4px 10px" }}
                        onClick={() => setDueDateInput(target)}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <DatePicker
                  autoFocus
                  required
                  min={editingDueDateSale.sale_date}
                  value={dueDateInput}
                  onChange={setDueDateInput}
                  aria-label="Hạn trả tiền *"
                />
              </Field>
              <div className="form-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditingDueDateSale(null)}
                >
                  Đóng
                </Button>
                <Button type="submit" disabled={dueDateMutation.isPending}>
                  {dueDateMutation.isPending ? "Đang lưu…" : "Lưu hạn trả"}
                </Button>
              </div>
            </form>
            </Card>
          </div>
        </div>
      )}

      {/* Existing Payment Modal */}
      {payingSale && (
        <div
          className="modal-backdrop"
          onClick={() => setPayingSale(null)}
          role="presentation"
        >
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <Card>
              <div className="row between" style={{ marginBottom: "12px" }}>
                <div>
                  <h3>Thu thêm tiền công nợ</h3>
                  <p className="muted small">
                    {payingSale.sale_code} · {payingSale.customer_name} (
                    {payingSale.brand} {payingSale.model})
                  </p>
                </div>
              </div>
              <PaymentEditor
                sale={payingSale}
                onClose={() => {
                  setPayingSale(null);
                  void client.invalidateQueries({ queryKey: ["receivables"] });
                }}
              />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
