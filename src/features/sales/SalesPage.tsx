import { useEffect, useDeferredValue, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CirclePlus, CreditCard, Receipt, Search } from "lucide-react";
import { api } from "@/lib/api";
import { canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import type { Paged, ReceivablesSummary, Sale } from "@/types";
import { ReceivablesPage } from "./ReceivablesPage";

const pageSize = 6;
type SaleRecord = Sale & {
  vehicle_code?: string;
  vehicle_name?: string;
  cancellation_reason?: string;
};

export function SalesPage({
  defaultTab,
}: {
  defaultTab?: "sales" | "receivables";
} = {}) {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const currentTab =
    (params.get("tab") as "sales" | "receivables") ||
    defaultTab ||
    (params.has("payment_status") ? "receivables" : "sales");

  const [range, setRange] = useState({
    from: params.get("from") || `${today().slice(0, 7)}-01`,
    to: params.get("to") || today(),
  });
  const [search, setSearch] = useState(params.get("search") || "");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);

  const overdueQuery = useQuery({
    queryKey: ["receivables-overdue-count"],
    queryFn: () =>
      api.call<ReceivablesSummary>("list_receivables", {
        p_filters: { payment_status: "OVERDUE", limit: 1 },
      }),
    staleTime: 30000,
  });
  const overdueCount = overdueQuery.data?.overdue_count ?? 0;

  const query = useQuery({
    queryKey: ["sales", range, deferredSearch, page],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.call<Paged<SaleRecord>>("list_sales", {
        p_filters: {
          ...range,
          search: deferredSearch,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
    enabled: currentTab === "sales",
  });

  useEffect(() => {
    if (query.data && page * pageSize < query.data.total && currentTab === "sales") {
      void client.prefetchQuery({
        queryKey: ["sales", range, deferredSearch, page + 1],
        queryFn: () =>
          api.call<Paged<SaleRecord>>("list_sales", {
            p_filters: {
              ...range,
              search: deferredSearch,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [query.data, page, range, deferredSearch, currentTab, client]);

  const switchTab = (tab: "sales" | "receivables") => {
    const next = new URLSearchParams(params);
    if (tab === "sales") {
      next.delete("tab");
      next.delete("payment_status");
    } else {
      next.set("tab", "receivables");
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="stack">
      <PageHeader
        title="Bán hàng & Thu nợ"
        description="Theo dõi giao dịch bán xe, quản lý thanh toán và thu hồi công nợ khách hàng."
        actions={
          canOperate(profile) ? (
            <Link
              className="button primary"
              to="/sell"
              aria-label="Tạo giao dịch"
            >
              <CirclePlus size={18} />
              <span className="cta-label-full">Tạo giao dịch</span>
              <span className="cta-label-short">Giao dịch</span>
            </Link>
          ) : undefined
        }
      />

      <div className="tabs" role="tablist" style={{ marginTop: 0, marginBottom: 8 }}>
        <button
          type="button"
          role="tab"
          aria-selected={currentTab === "sales"}
          className={`tab ${currentTab === "sales" ? "active" : ""}`}
          onClick={() => switchTab("sales")}
        >
          <Receipt size={17} style={{ verticalAlign: "-3px", marginRight: 6 }} />
          Đơn bán xe
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={currentTab === "receivables"}
          className={`tab ${currentTab === "receivables" ? "active" : ""}`}
          onClick={() => switchTab("receivables")}
        >
          <CreditCard size={17} style={{ verticalAlign: "-3px", marginRight: 6 }} />
          Sổ nợ cần thu
          {overdueCount > 0 && (
            <span
              className="badge danger small"
              style={{
                marginLeft: 8,
                fontSize: "11px",
                padding: "2px 7px",
                borderRadius: "999px",
              }}
            >
              {overdueCount} quá hạn
            </span>
          )}
        </button>
      </div>

      {currentTab === "receivables" ? (
        <ReceivablesPage hideHeader />
      ) : (
        <>
          <Card>
            <div className="row filter-row">
              <label className="search-field">
                <Search size={19} />
                <input
                  aria-label="Tìm giao dịch"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Mã giao dịch, khách hàng, SĐT, mã xe…"
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
          </Card>
          {query.isPending ? (
            <Loading />
          ) : query.isError ? (
            <ErrorState error={query.error} retry={() => void query.refetch()} />
          ) : !query.data.items.length ? (
            <EmptyState
              title="Chưa có giao dịch trong khoảng thời gian này"
              description="Thay đổi bộ lọc ngày hoặc tạo giao dịch bán xe mới."
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
                      <th>Xe</th>
                      <th>Khách hàng</th>
                      <th className="numeric">Giá bán</th>
                      <th className="numeric">Còn phải thu</th>
                      <th>Trạng thái</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.items.map((sale) => (
                      <tr key={sale.id}>
                        <td>
                          <Link className="text-link" to={`/sales/${sale.id}`}>
                            {sale.sale_code}
                          </Link>
                          <small>{dateLabel(sale.sale_date)}</small>
                        </td>
                        <td>
                          <strong>
                            {sale.vehicle_name ||
                              `${sale.vehicle?.brand ?? ""} ${sale.vehicle?.model ?? ""}`}
                          </strong>
                          <small>
                            {sale.vehicle_code || sale.vehicle?.internal_code}
                          </small>
                        </td>
                        <td>
                          <strong>{sale.customer_name}</strong>
                          <small>
                            {sale.customer_phone || "Chưa có số điện thoại"}
                          </small>
                        </td>
                        <td className="numeric price">{money(sale.sale_price)}</td>
                        <td className="numeric">
                          {sale.status === "CANCELLED"
                            ? "—"
                            : money(sale.remaining_amount)}
                        </td>
                        <td>
                          <Badge status={sale.status} />
                        </td>
                        <td>
                          <Link
                            className="icon-button"
                            aria-label={`Xem ${sale.sale_code}`}
                            to={`/sales/${sale.id}`}
                          >
                            <ArrowRight size={18} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mobile-cards">
                {query.data.items.map((sale) => (
                  <Link
                    className="mobile-record"
                    to={`/sales/${sale.id}`}
                    key={sale.id}
                  >
                    <div className="row between">
                      <strong>{sale.sale_code}</strong>
                      <Badge status={sale.status} />
                    </div>
                    <span>{sale.vehicle_name || sale.vehicle_code}</span>
                    <span className="muted">
                      {sale.customer_name} · {dateLabel(sale.sale_date)}
                    </span>
                    <div className="row between">
                      <strong className="price">{money(sale.sale_price)}</strong>
                      <small>
                        {sale.status === "CANCELLED"
                          ? "Đã hủy"
                          : `Còn thu ${money(sale.remaining_amount)}`}
                      </small>
                    </div>
                  </Link>
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
        </>
      )}
    </div>
  );
}
