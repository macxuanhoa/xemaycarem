import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Banknote,
  Calendar,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Landmark,
  Printer,
  Scale,
} from "lucide-react";
import { api } from "@/lib/api";
import { money, today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage } from "@/lib/permissions";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { DailyReconciliation } from "@/types";

export function ReconciliationPage() {
  const { profile } = useAuth();
  const [selectedDate, setSelectedDate] = useState(today());

  const query = useQuery({
    queryKey: ["daily-reconciliation", selectedDate],
    queryFn: () =>
      api.call<DailyReconciliation>("daily_reconciliation", {
        p_date: selectedDate,
      }),
  });

  const d = query.data;

  const handlePrevDay = () => {
    const cur = new Date(selectedDate);
    cur.setUTCDate(cur.getUTCDate() - 1);
    setSelectedDate(cur.toISOString().slice(0, 10));
  };

  const handleNextDay = () => {
    const cur = new Date(selectedDate);
    cur.setUTCDate(cur.getUTCDate() + 1);
    const nextStr = cur.toISOString().slice(0, 10);
    if (nextStr <= today()) {
      setSelectedDate(nextStr);
    }
  };

  if (!canManage(profile)) {
    return (
      <EmptyState
        title="Quyền truy cập bị giới hạn"
        description="Chức năng đối soát cuối ngày chỉ dành cho chủ cửa hàng và quản lý."
      />
    );
  }

  return (
    <div className="stack page-stack">
      <PageHeader
        title="Đối soát cuối ngày"
        description="Kiểm tra tiền thực tế thu vào, doanh thu bán hàng, thu hồi nợ và chi phí trong ngày kinh doanh."
        actions={
          <div className="row" style={{ gap: "8px" }}>
            <Button
              variant="secondary"
              onClick={() => window.print()}
              title="In bảng đối soát"
            >
              <Printer size={16} /> In đối soát
            </Button>
          </div>
        }
      />

      {/* Date selector toolbar */}
      <Card className="no-print">
        <div
          className="row between"
          style={{ flexWrap: "wrap", gap: "12px", alignItems: "center" }}
        >
          <div className="row" style={{ gap: "8px", alignItems: "center" }}>
            <Button
              variant="secondary"
              className="small"
              onClick={handlePrevDay}
              title="Ngày trước"
            >
              <ChevronLeft size={16} /> Ngày trước
            </Button>
            <div className="row" style={{ gap: "6px", alignItems: "center" }}>
              <Calendar size={18} className="muted" />
              <input
                type="date"
                max={today()}
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ fontWeight: 600, padding: "6px 12px" }}
              />
            </div>
            <Button
              variant="secondary"
              className="small"
              disabled={selectedDate >= today()}
              onClick={handleNextDay}
              title="Ngày sau"
            >
              Ngày sau <ChevronRight size={16} />
            </Button>
            {selectedDate !== today() && (
              <Button
                variant="ghost"
                className="small"
                onClick={() => setSelectedDate(today())}
              >
                Về hôm nay
              </Button>
            )}
          </div>
          <span className="muted small">
            Múi giờ chuẩn: <strong>Asia/Ho_Chi_Minh</strong>
          </span>
        </div>
      </Card>

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : d ? (
        <div className="stack">
          {/* CRITICAL NOTE: SALES REVENUE VS CASH COLLECTED */}
          <div
            className="notice row"
            style={{ gap: "10px", alignItems: "flex-start" }}
          >
            <Scale size={22} style={{ flexShrink: 0, marginTop: "2px" }} />
            <div>
              <strong>Lưu ý nghiệp vụ đối soát:</strong>
              <p style={{ margin: "4px 0 0" }}>
                <strong>Tiền thực thu ({money(d.total_collected)})</strong> là
                số tiền thực tế khách đã trả (tiền mặt / chuyển khoản) trong
                ngày hôm nay, bao gồm cả tiền bán xe hôm nay (
                {money(d.today_sales_collected)}) và tiền thu nợ từ các ngày
                trước ({money(d.debt_collected_today)}). Khác biệt hoàn toàn với{" "}
                <strong>Doanh thu bán xe ({money(d.sales_revenue)})</strong> là
                tổng giá trị các hợp đồng bán lập trong ngày hôm nay.
              </p>
            </div>
          </div>

          {/* ═══ PRIMARY FINANCIAL KPI GRID ═══ */}
          <div className="kpi-grid">
            <div
              className="card metric-card"
              style={{ borderLeft: "4px solid var(--color-success, #16a34a)" }}
            >
              <span className="metric-title">
                TỔNG TIỀN THỰC THU TRONG NGÀY
              </span>
              <strong
                className="metric-value price"
                style={{ color: "#16a34a" }}
              >
                {money(d.total_collected)}
              </strong>
              <div
                className="metric-sub"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  marginTop: "4px",
                }}
              >
                <span>
                  • Thu từ xe bán hôm nay:{" "}
                  <strong>{money(d.today_sales_collected)}</strong>
                </span>
                <span>
                  • Thu hồi nợ xe bán trước đó:{" "}
                  <strong>{money(d.debt_collected_today)}</strong>
                </span>
              </div>
            </div>

            <Card className="metric-card">
              <span className="metric-title">PHÂN THEO HÌNH THỨC THU</span>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  marginTop: "8px",
                }}
              >
                <div className="row between">
                  <span
                    className="row"
                    style={{ gap: "6px", alignItems: "center" }}
                  >
                    <Banknote size={16} /> Tiền mặt:
                  </span>
                  <strong>{money(d.cash_collected)}</strong>
                </div>
                <div className="row between">
                  <span
                    className="row"
                    style={{ gap: "6px", alignItems: "center" }}
                  >
                    <Landmark size={16} /> Chuyển khoản ngân hàng:
                  </span>
                  <strong>{money(d.bank_transfer_collected)}</strong>
                </div>
                {d.other_collected > 0 && (
                  <div className="row between">
                    <span
                      className="row"
                      style={{ gap: "6px", alignItems: "center" }}
                    >
                      <CreditCard size={16} /> Khác:
                    </span>
                    <strong>{money(d.other_collected)}</strong>
                  </div>
                )}
              </div>
            </Card>

            <Card className="metric-card">
              <span className="metric-title">DOANH THU & CÔNG NỢ MỚI</span>
              <strong className="metric-value price">
                {money(d.sales_revenue)}
              </strong>
              <span className="metric-sub">
                {d.sales_count} xe đã chốt bán hôm nay
              </span>
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "12px",
                  color: d.new_debt_created > 0 ? "#ea580c" : "inherit",
                }}
              >
                Nợ mới phát sinh: <strong>{money(d.new_debt_created)}</strong>
              </div>
            </Card>

            <div
              className="card metric-card"
              style={{
                borderLeft:
                  d.net_cash_movement >= 0
                    ? "4px solid #16a34a"
                    : "4px solid #dc2626",
              }}
            >
              <span className="metric-title">
                THU KHÁCH TRỪ CHI PHÍ GHI NHẬN
              </span>
              <strong
                className="metric-value price"
                style={{
                  color: d.net_cash_movement >= 0 ? "#16a34a" : "#dc2626",
                }}
              >
                {money(d.net_cash_movement)}
              </strong>
              <span className="metric-sub">
                Thu {money(d.total_collected)} − Chi {money(d.total_expenses)}
              </span>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "12px",
                  color: "var(--muted, #79857e)",
                }}
              >
                Chi cửa hàng: {money(d.business_expenses)} · Chi xe:{" "}
                {money(d.vehicle_expenses)}. Chưa gồm tiền mua xe hoặc đối chiếu
                việc trả chi phí.
              </div>
            </div>
          </div>

          {/* ═══ TRANSACTION SECTIONS ═══ */}

          {/* 1. Payments Collected Today */}
          <Card>
            <div className="row between" style={{ marginBottom: "12px" }}>
              <div>
                <h2 className="section-title">
                  1. Các khoản tiền thu trong ngày ({d.payments.length} phiếu
                  thu)
                </h2>
                <p className="muted small">
                  Danh sách chi tiết tiền thu từ khách hàng
                </p>
              </div>
              <strong className="price" style={{ color: "#16a34a" }}>
                Tổng: {money(d.total_collected)}
              </strong>
            </div>

            {d.payments.length === 0 ? (
              <p className="muted">
                Không có khoản tiền thu nào trong ngày này.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Mã bán / Xe</th>
                      <th>Khách hàng</th>
                      <th>Phân loại</th>
                      <th>Hình thức</th>
                      <th>Chứng từ / Ghi chú</th>
                      <th className="numeric">Số tiền thu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.payments.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link
                            to={`/sales/${p.sale_id}`}
                            className="text-link"
                          >
                            {p.sale_code}
                          </Link>
                          <small>
                            {p.vehicle_name} ({p.internal_code})
                          </small>
                        </td>
                        <td>
                          <strong>{p.customer_name}</strong>
                          {p.customer_phone && (
                            <small>{p.customer_phone}</small>
                          )}
                        </td>
                        <td>
                          {p.is_prior_debt ? (
                            <span className="badge badge-reserved">
                              <span /> Thu nợ cũ
                            </span>
                          ) : (
                            <span className="badge badge-completed">
                              <span /> Bán hôm nay
                            </span>
                          )}
                        </td>
                        <td>
                          {p.payment_method === "CASH" ? (
                            <span className="row small" style={{ gap: "4px" }}>
                              <Banknote size={14} /> Tiền mặt
                            </span>
                          ) : p.payment_method === "BANK_TRANSFER" ? (
                            <span className="row small" style={{ gap: "4px" }}>
                              <Landmark size={14} /> Chuyển khoản
                            </span>
                          ) : (
                            "Khác"
                          )}
                        </td>
                        <td>
                          <span>{p.reference || "—"}</span>
                          {p.notes && (
                            <small className="muted">{p.notes}</small>
                          )}
                        </td>
                        <td
                          className="numeric font-semibold"
                          style={{ color: "#16a34a" }}
                        >
                          {money(p.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* 2. Sales Made Today */}
          <Card>
            <div className="row between" style={{ marginBottom: "12px" }}>
              <div>
                <h2 className="section-title">
                  2. Giao dịch bán xe trong ngày ({d.sales.length} xe)
                </h2>
                <p className="muted small">
                  Các hợp đồng mua bán hoàn tất trong ngày
                </p>
              </div>
              <strong className="price">
                Tổng doanh số: {money(d.sales_revenue)}
              </strong>
            </div>

            {d.sales.length === 0 ? (
              <p className="muted">
                Không có giao dịch bán xe nào trong ngày này.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Mã HĐ</th>
                      <th>Khách hàng</th>
                      <th>Xe</th>
                      <th className="numeric">Giá bán</th>
                      <th className="numeric">Đã thu hôm nay</th>
                      <th className="numeric">Nợ để lại</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.sales.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link to={`/sales/${s.id}`} className="text-link">
                            {s.sale_code}
                          </Link>
                        </td>
                        <td>
                          <strong>{s.customer_name}</strong>
                          {s.customer_phone && (
                            <small>{s.customer_phone}</small>
                          )}
                        </td>
                        <td>
                          <strong>{s.vehicle_name}</strong>
                          <small>
                            {s.internal_code} · {s.license_plate || "Chưa biển"}
                          </small>
                        </td>
                        <td className="numeric price">{money(s.sale_price)}</td>
                        <td
                          className="numeric text-success"
                          style={{ color: "#16a34a" }}
                        >
                          {money(s.paid_amount)}
                        </td>
                        <td className="numeric">
                          {s.remaining_amount > 0 ? (
                            <strong style={{ color: "#ea580c" }}>
                              {money(s.remaining_amount)}
                            </strong>
                          ) : (
                            <span className="badge badge-completed">Đã đủ</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* 3. Expenses Today */}
          <Card>
            <div className="row between" style={{ marginBottom: "12px" }}>
              <div>
                <h2 className="section-title">
                  3. Chi phí phát sinh trong ngày ({d.expenses.length} khoản)
                </h2>
                <p className="muted small">
                  Chi phí cửa hàng và chi phí bảo dưỡng xe
                </p>
              </div>
              <strong className="price" style={{ color: "#dc2626" }}>
                Tổng chi: {money(d.total_expenses)}
              </strong>
            </div>

            {d.expenses.length === 0 ? (
              <p className="muted">
                Không có chi phí nào phát sinh trong ngày này.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Loại chi phí</th>
                      <th>Đối tượng</th>
                      <th>Mô tả</th>
                      <th className="numeric">Số tiền</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.expenses.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <Badge
                            status={e.category || e.expense_type || "ACTIVE"}
                          />
                        </td>
                        <td>
                          {e.vehicle_name ? (
                            <span>
                              {e.vehicle_name} ({e.internal_code})
                            </span>
                          ) : (
                            <span className="muted">Cửa hàng</span>
                          )}
                        </td>
                        <td>{e.description}</td>
                        <td
                          className="numeric font-semibold"
                          style={{ color: "#dc2626" }}
                        >
                          {money(e.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
export default ReconciliationPage;
