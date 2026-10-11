import { useEffect, useState } from "react";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useDialog } from "@/lib/useDialog";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bike,
  History,
  Phone,
  Search,
  User,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { dateLabel, money } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { Highlight } from "@/components/search/Highlight";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";
import type { CustomerSummary, Paged, ShowroomLead, ShowroomLeadStatus } from "@/types";

const pageSize = 6;

export function CustomersPage() {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPhone =
    searchParams.get("phone") || searchParams.get("search") || "";
  const [search, setSearch] = useState(initialPhone);
  const deferredSearch = useDebouncedValue(search.trim());
  const [page, setPage] = useState(1);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(
    searchParams.get("phone") || null,
  );

  useEffect(() => {
    setSelectedPhone(searchParams.get("phone"));
  }, [searchParams]);
  const query = useQuery({
    queryKey: ["customers", deferredSearch, page],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.call<Paged<CustomerSummary>>("list_customers", {
        p_filters: {
          search: deferredSearch,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
  });

  useEffect(() => {
    if (query.data && page * pageSize < query.data.total) {
      void client.prefetchQuery({
        queryKey: ["customers", deferredSearch, page + 1],
        queryFn: () =>
          api.call<Paged<CustomerSummary>>("list_customers", {
            p_filters: {
              search: deferredSearch,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [query.data, page, deferredSearch, client]);

  const detailQuery = useQuery({
    queryKey: ["customer-history", selectedPhone],
    queryFn: () =>
      api.call<CustomerSummary>("get_customer_history", {
        p_phone: selectedPhone!,
      }),
    enabled: !!selectedPhone,
  });

  // A2: lead thật từ Showroom — nhân sự thấy và xử lý ngay tại đây.
  const leadsQuery = useQuery({
    queryKey: ["showroom-leads"],
    queryFn: () =>
      api.call<Paged<ShowroomLead>>("list_showroom_leads", {
        p_filters: { status: "NEW", limit: 10 },
      }),
  });
  const leadStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ShowroomLeadStatus }) =>
      api.call("update_showroom_lead_status", { p_id: id, p_status: status }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["showroom-leads"] }),
  });
  const communicationQuery = useQuery({
    queryKey: ["customer-communications", selectedPhone],
    queryFn: () => api.call<Array<{ id: string; channel: string; message_type: string; status: string; created_at: string; message_preview: string }>>("list_customer_communications", { p_phone: selectedPhone! }),
    enabled: !!selectedPhone,
  });

  const handleSelectCustomer = (phone: string) => {
    const trimmed = phone.trim();
    if (!trimmed) return;
    setSelectedPhone(trimmed);
    setSearchParams({ phone: trimmed });
  };

  const handleCloseDetail = () => {
    setSelectedPhone(null);
    setSearchParams({});
  };
  const dialogRef = useDialog(!!selectedPhone, handleCloseDetail);

  const data = query.data;
  const detail = detailQuery.data;

  return (
    <div className="stack">
      <PageHeader
        title="Khách hàng & Lịch sử mua xe"
        description="Tra cứu lịch sử mua bán, số tiền đã giao dịch và tình trạng công nợ theo từng khách hàng."
      />

      <Card>
        <div className="row filter-row">
          <label className="search-field" style={{ flex: 1 }}>
            <Search size={19} />
            <input
              aria-label="Tìm khách hàng"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Tìm theo số điện thoại hoặc tên khách hàng…"
            />
          </label>
        </div>
      </Card>

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !data?.items.length ? (
        <EmptyState
          title="Không tìm thấy khách hàng nào"
          description="Dữ liệu khách hàng được tự động tổng hợp từ các giao dịch bán xe hoàn tất."
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
                  <th>Khách hàng</th>
                  <th>Số điện thoại</th>
                  <th className="numeric">Số xe đã mua</th>
                  <th className="numeric">Tổng chi tiêu</th>
                  <th className="numeric">Đã thanh toán</th>
                  <th className="numeric">Còn nợ</th>
                  <th>Mua gần nhất</th>
                  <th style={{ width: "120px" }}>Lịch sử</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.customer_phone || c.customer_name}>
                    <td>
                      <div className="row" style={{ gap: "6px" }}>
                        <User size={16} className="muted" />
                        <strong><Highlight text={c.customer_name} query={deferredSearch} /></strong>
                      </div>
                    </td>
                    <td>
                      {c.customer_phone ? (
                        <a
                          href={`tel:${c.customer_phone}`}
                          className="muted small row"
                          style={{ gap: "4px" }}
                        >
                          <Phone size={13} /> <Highlight text={c.customer_phone} query={deferredSearch} />
                        </a>
                      ) : (
                        <small className="muted">—</small>
                      )}
                    </td>
                    <td className="numeric font-medium">
                      {c.purchases_count} xe
                    </td>
                    <td className="numeric font-semibold">
                      {money(c.total_spent)}
                    </td>
                    <td
                      className="numeric text-success"
                      style={{ color: "#16a34a" }}
                    >
                      {money(c.total_paid)}
                    </td>
                    <td className="numeric">
                      <strong
                        style={{
                          color:
                            c.total_debt > 0
                              ? "var(--color-danger, #dc2626)"
                              : "inherit",
                        }}
                      >
                        {money(c.total_debt)}
                      </strong>
                    </td>
                    <td>
                      <small>{dateLabel(c.latest_purchase_date)}</small>
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        className="small"
                        disabled={!c.customer_phone}
                        title={
                          !c.customer_phone
                            ? "Khách chưa có số điện thoại để tra cứu lịch sử"
                            : "Xem chi tiết lịch sử mua xe"
                        }
                        onClick={() =>
                          c.customer_phone &&
                          handleSelectCustomer(c.customer_phone)
                        }
                      >
                        <History size={14} /> Chi tiết
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mobile-cards">
            {data.items.map((c) => (
              <div
                key={c.customer_phone || c.customer_name}
                className="mobile-record"
              >
                <div className="row between">
                  <strong><Highlight text={c.customer_name} query={deferredSearch} /></strong>
                  <span className="badge badge-completed">
                    {c.purchases_count} xe
                  </span>
                </div>
                {c.customer_phone && (
                  <span className="muted small row" style={{ gap: "4px" }}>
                    <Phone size={13} /> <Highlight text={c.customer_phone} query={deferredSearch} />
                  </span>
                )}
                <div className="row between price-row">
                  <div>
                    <small className="muted">
                      Tổng chi: {money(c.total_spent)}
                    </small>
                    <br />
                    <small className="muted">
                      Gần nhất: {dateLabel(c.latest_purchase_date)}
                    </small>
                  </div>
                  <div className="align-right">
                    <small className="muted">Còn nợ</small>
                    <br />
                    <strong
                      className="price"
                      style={{
                        color:
                          c.total_debt > 0
                            ? "var(--color-danger, #dc2626)"
                            : "inherit",
                      }}
                    >
                      {money(c.total_debt)}
                    </strong>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="full-width"
                  disabled={!c.customer_phone}
                  aria-label={`Xem lịch sử mua xe của ${c.customer_name}`}
                  onClick={() =>
                    c.customer_phone && handleSelectCustomer(c.customer_phone)
                  }
                >
                  <History size={16} aria-hidden="true" /> Xem lịch sử
                </Button>
              </div>
            ))}
          </div>

          <Pagination
            page={page}
            total={data.total}
            pageSize={pageSize}
            onChange={setPage}
          />
        </Card>
      )}

      {(leadsQuery.isPending ||
        leadsQuery.isError ||
        leadStatusMutation.isError ||
        (leadsQuery.data?.items.length ?? 0) > 0) && (
        <Card>
          <div className="row between" style={{ marginBottom: "10px" }}>
            <h3 style={{ margin: 0 }}>Yêu cầu mới từ Showroom</h3>
            {leadsQuery.data && (
              <small className="muted">
                {leadsQuery.data.total} yêu cầu chờ xử lý
              </small>
            )}
          </div>
          {leadStatusMutation.isPending && (
            <p role="status">Đang cập nhật trạng thái yêu cầu…</p>
          )}
          {leadStatusMutation.isError && (
            <ErrorState
              error={leadStatusMutation.error}
              retry={() => {
                if (leadStatusMutation.variables)
                  leadStatusMutation.mutate(leadStatusMutation.variables);
              }}
            />
          )}
          {leadsQuery.isPending ? (
            <Loading />
          ) : leadsQuery.isError ? (
            <ErrorState error={leadsQuery.error} retry={() => void leadsQuery.refetch()} />
          ) : (
          <div className="compact-list">
            {leadsQuery.data?.items.map((lead) => (
              <div key={lead.id} className="card" style={{ padding: "12px" }}>
                <div className="row between">
                  <strong>
                    {lead.customer_name} ·{" "}
                    {lead.kind === "BUYBACK" ? "Cần bán xe" : "Hỏi mua xe"}
                  </strong>
                  <small className="muted">{dateLabel(lead.created_at)}</small>
                </div>
                <div className="row" style={{ gap: "10px", marginTop: "4px" }}>
                  <a href={`tel:${lead.phone}`} className="muted small row" style={{ gap: "4px" }}>
                    <Phone size={13} /> {lead.phone}
                  </a>
                  {lead.vehicle_name && (
                    <small className="muted">
                      Xe: {lead.vehicle_name}
                      {lead.vehicle_year ? ` (${lead.vehicle_year})` : ""}
                      {lead.expected_price ? ` · Mong muốn ${money(lead.expected_price)}` : ""}
                    </small>
                  )}
                  {lead.vehicle_id && (
                    <Link to={`/vehicles/${lead.vehicle_id}`} className="small row" style={{ gap: "4px" }}>
                      <Bike size={13} /> Xem xe
                    </Link>
                  )}
                </div>
                {lead.message && <p className="small muted" style={{ margin: "6px 0 0" }}>{lead.message}</p>}
                <div className="row" style={{ gap: "6px", marginTop: "8px", justifyContent: "flex-end" }}>
                  <Button
                    variant="secondary"
                    className="small"
                    disabled={leadStatusMutation.isPending}
                    onClick={() =>
                      leadStatusMutation.mutate({ id: lead.id, status: "CONTACTED" })
                    }
                  >
                    Đã liên hệ
                  </Button>
                  <Button
                    variant="ghost"
                    className="small"
                    disabled={leadStatusMutation.isPending}
                    onClick={() =>
                      leadStatusMutation.mutate({ id: lead.id, status: "CLOSED" })
                    }
                  >
                    Đã chốt
                  </Button>
                  <Button
                    variant="ghost"
                    className="small"
                    disabled={leadStatusMutation.isPending}
                    onClick={() =>
                      leadStatusMutation.mutate({ id: lead.id, status: "SPAM" })
                    }
                  >
                    Spam
                  </Button>
                </div>
              </div>
            ))}
          </div>
          )}
        </Card>
      )}

      {/* Customer Purchase History Modal */}
      {selectedPhone && (
        <div
          className="modal-backdrop"
          onClick={handleCloseDetail}
          role="presentation"
        >
          <div
            className="modal-card"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-history-title"
            tabIndex={-1}
            style={{
              maxWidth: "780px",
              width: "100%",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ marginBottom: "16px" }}>
              <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                <History size={20} />
                <h2
                  id="customer-history-title"
                  style={{ margin: 0, fontSize: "18px" }}
                >
                  Lịch sử mua hàng: {detail?.customer_name || selectedPhone}
                </h2>
              </div>
              <button
                className="icon-button small"
                aria-label="Đóng lịch sử khách hàng"
                onClick={handleCloseDetail}
              >
                <X size={18} />
              </button>
            </div>

            {detailQuery.isPending ? (
              <Loading />
            ) : detailQuery.isError ? (
              <ErrorState error={detailQuery.error} />
            ) : detail ? (
              <div className="stack">
                {detail.identity_warning && (
                  <p className="notice">
                    Số điện thoại này có nhiều tên khách:{" "}
                    {detail.customer_names?.join(", ")}. Kiểm tra từng giao dịch
                    trước khi thu tiền; đây là nhóm tra cứu theo số điện thoại.
                  </p>
                )}
                <div className="kpi-grid">
                  <Card className="metric-card">
                    <span className="metric-title">Tổng xe đã mua</span>
                    <strong className="metric-value">
                      {detail.purchases_count} xe
                    </strong>
                    <span className="metric-sub">
                      Lần đầu: {dateLabel(detail.first_purchase_date)}
                    </span>
                  </Card>
                  <Card className="metric-card">
                    <span className="metric-title">Tổng chi tiêu</span>
                    <strong className="metric-value price">
                      {money(detail.total_spent)}
                    </strong>
                    <span className="metric-sub">
                      Đã thanh toán: {money(detail.total_paid)}
                    </span>
                  </Card>
                  <Card className="metric-card">
                    <span className="metric-title">Công nợ hiện tại</span>
                    <strong
                      className="metric-value"
                      style={{
                        color:
                          detail.total_debt > 0
                            ? "var(--color-danger, #dc2626)"
                            : "#16a34a",
                      }}
                    >
                      {money(detail.total_debt)}
                    </strong>
                    <span className="metric-sub">
                      {detail.total_debt > 0
                        ? "Còn khoản chưa trả hết"
                        : "Đã thanh toán đầy đủ"}
                    </span>
                  </Card>
                </div>

                <h3>Danh sách các xe đã mua</h3>
                <div className="compact-list">
                  {detail.sales?.map((s) => (
                    <div
                      key={s.id}
                      className="card"
                      style={{ padding: "14px" }}
                    >
                      <div className="row between">
                        <Link to={`/sales/${s.id}`} className="text-link">
                          <strong>Mã giao dịch: {s.sale_code}</strong> ·{" "}
                          {dateLabel(s.sale_date)}
                        </Link>
                        {s.status !== "COMPLETED" && <Badge status={s.status} />}
                      </div>
                      <div className="row between" style={{ marginTop: "6px" }}>
                        <div
                          className="row"
                          style={{ gap: "8px", alignItems: "center" }}
                        >
                          <Bike size={18} className="muted" />
                          <span>
                            <strong>{vehicleTitle(s)}</strong>{" "}
                            {s.internal_code ? `(${s.internal_code})` : ""}
                          </span>
                          {vehicleSubtitle(s) && (
                            <small className="muted">· {vehicleSubtitle(s)}</small>
                          )}
                        </div>
                        <div className="align-right">
                          <strong className="price">
                            {money(s.sale_price)}
                          </strong>
                        </div>
                      </div>
                      <div
                        className="row between small muted"
                        style={{ marginTop: "6px" }}
                      >
                        <span>Đã thu: {money(s.paid_amount)}</span>
                        {s.remaining_amount > 0 ? (
                          <span
                            style={{
                              color: "var(--color-danger, #dc2626)",
                              fontWeight: 600,
                            }}
                          >
                            Còn nợ: {money(s.remaining_amount)}
                          </span>
                        ) : (
                          <span style={{ color: "#16a34a" }}>
                            Đã thanh toán đủ
                          </span>
                        )}
                      </div>
                      {s.payments && s.payments.length > 0 && (
                        <div
                          style={{
                            marginTop: "8px",
                            borderTop: "1px dashed var(--line, #e4e9e2)",
                            paddingTop: "8px",
                          }}
                        >
                          <small
                            className="muted"
                            style={{ display: "block", marginBottom: "4px" }}
                          >
                            Lịch sử trả tiền ({s.payments.length} lần):
                          </small>
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "3px",
                            }}
                          >
                            {s.payments.map((p) => (
                              <div
                                key={p.id}
                                className="row between small muted"
                              >
                                <span>
                                  {dateLabel(p.payment_date)} ·{" "}
                                  {p.payment_method === "CASH"
                                    ? "Tiền mặt"
                                    : p.payment_method === "BANK_TRANSFER"
                                      ? "Chuyển khoản"
                                      : "Khác"}
                                  {p.reference ? ` (${p.reference})` : ""}
                                </span>
                                <strong>{money(p.amount)}</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div
                        className="row"
                        style={{ marginTop: "8px", justifyContent: "flex-end" }}
                      >
                        <Link
                          to={`/sales/${s.id}`}
                          className="button secondary small"
                        >
                          Xem giao dịch <ArrowRight size={14} />
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
                <h3>Lịch sử liên hệ</h3>
                {communicationQuery.isPending ? <Loading /> : communicationQuery.isError ? (
                  <ErrorState
                    error={communicationQuery.error}
                    retry={() => void communicationQuery.refetch()}
                  />
                ) : communicationQuery.data?.length ? (
                  <div className="compact-list">
                    {communicationQuery.data.map((item) => (
                      <div key={item.id} className="card" style={{ padding: "12px" }}>
                        <div className="row between">
                          <strong>{dateLabel(item.created_at)}</strong>
                          <Badge status={item.status} />
                        </div>
                        <small className="muted">{item.channel === "ZALO_ZNS" ? "Zalo" : item.channel} · {item.message_type === "THANK_YOU" ? "Cảm ơn sau mua xe" : item.message_type}</small>
                        <p className="small">{item.message_preview}</p>
                      </div>
                    ))}
                  </div>
                ) : <p className="muted">Chưa có lịch sử liên hệ.</p>}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
export default CustomersPage;
