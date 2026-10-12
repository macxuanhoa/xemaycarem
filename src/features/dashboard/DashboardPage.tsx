import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  Receipt,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  Badge,
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Loading,
} from "@/components/ui";
import { api } from "@/lib/api";
import { canFinance, canManage } from "@/lib/permissions";
import { resolveInventoryStatus } from "@/lib/inventory-status";
import {
  compactMoney,
  dateLabel,
  datePreset,
  money,
  today,
} from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import { useValueLedFlash } from "@/lib/useValueLedFlash";
import { DashboardExecutiveBanner } from "./DashboardExecutiveBanner";
import type { DashboardData, DailyReconciliation, DateFilter } from "@/types";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";

export default function DashboardPage() {
  const { profile } = useAuth();
  // Default to TODAY as explicitly requested by user
  const [range, setRange] = useState<DateFilter>(() => datePreset("today"));
  const [activeTxTab, setActiveTxTab] = useState<"sales" | "acquisitions" | "profitable">("sales");

  // The digest follows the filter bar inside "Bản tin trong ngày"; while the
  // chosen period is today both queries share one cache entry.
  const digestRange = range;

  const query = useQuery({
    queryKey: ["dashboard", range],
    queryFn: () =>
      api.call<DashboardData>("dashboard", {
        p_from: range.from,
        p_to: range.to,
      }),
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<{ store_name: string }>("get_settings"),
  });

  // Reuses the existing reconciliation RPC for true cash collected today.
  // OWNER/MANAGER only server-side, so STAFF never triggers the call.
  const reconciliationQuery = useQuery({
    queryKey: ["daily-reconciliation", today()],
    queryFn: () =>
      api.call<DailyReconciliation>("daily_reconciliation", {
        p_date: today(),
      }),
    enabled: canManage(profile),
  });

  const d = query.data;
  const period = periodDisplay(digestRange);
  const recon = reconciliationQuery.data;
  // Server-authoritative stock badge (LOW/NORMAL/HIGH on at-store vehicles);
  // thresholds are absent client-side, so no fallback inputs here.
  const stockStatus = d
    ? resolveInventoryStatus({
        inventory_indicator: d.inventory_indicator,
        in_stock: d.in_stock,
        reserved: d.reserved,
      })
    : null;

  // Một nhịp LED viền khi số liệu mốc nhảy lên (refetch sau đơn mới, đổi kỳ).
  // Load đầu tiên không nhấp: undefined = "chưa có số" trong hook.
  const stockCountBeat = useValueLedFlash(
    d ? d.in_stock + d.reserved : undefined,
  );
  const stockValueBeat = useValueLedFlash(d ? d.inventory_cost : undefined);

  return (
    <div className="stack page-stack">
      {/* ═══ EXECUTIVE HERO BANNER ═══ */}
      <DashboardExecutiveBanner
        profile={profile}
        storeName={settingsQuery.data?.store_name ?? "Cửa hàng Xe Máy Cà Rem"}
      />

      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        d && (
          <>
            {/* ═══ BẢN TIN TRONG NGÀY (soft animated LED-border digest) ═══ */}
            <section
              className="carem-digest"
              role="region"
              aria-label="Bản tin trong ngày"
            >
              <header className="carem-digest-head">
                <h2 className="carem-digest-title">
                  <span className="carem-digest-led" aria-hidden="true" />
                  Bản tin trong ngày
                </h2>
                <span className="carem-digest-meta">
                  Cập nhật {dateLabel(today())}
                </span>
              </header>

              {/* Quick period filter: yesterday → custom range drives the digest and every period panel below. */}
              <div className="carem-digest-filter">
                <DateRange value={digestRange} onChange={setRange} />
              </div>

              <div className="carem-digest-grid">
                {/* A. THỐNG KÊ THEO KỲ (mặc định: hôm nay) */}
                <div className="carem-digest-col">
                  <h3 className="carem-digest-section-label">
                    Thống kê {period.lower}
                  </h3>
                  <div className="digest-row">
                    <span className="digest-row-label">
                      Xe thu vào {period.lower}
                    </span>
                    <strong className="digest-row-value cyan">
                      {d.acquisitions_count ?? 0} xe
                    </strong>
                  </div>
                  {canFinance(profile) && (
                    <div className="digest-row">
                      <span className="digest-row-label">
                        Tổng tiền mua xe {period.lower}
                      </span>
                      <strong className="digest-row-value gold">
                        {money(d.acquisition_cost ?? 0)}
                      </strong>
                    </div>
                  )}
                  <div className="digest-row">
                    <span className="digest-row-label">
                      Xe bán ra {period.lower}
                    </span>
                    <strong className="digest-row-value lime">
                      {d.sales_count} xe
                    </strong>
                  </div>
                  {canManage(profile) && (
                    <div className="digest-row">
                      <span className="digest-row-label">
                        Doanh thu {period.lower}
                      </span>
                      <strong className="digest-row-value gold">
                        {money(d.revenue ?? 0)}
                      </strong>
                    </div>
                  )}
                  {canFinance(profile) && (
                    <div className="digest-row">
                      <span className="digest-row-label">
                        Lợi nhuận {period.lower}
                      </span>
                      <strong className="digest-row-value emerald">
                        {money(d.gross_profit ?? 0)}
                      </strong>
                    </div>
                  )}
                  {canManage(profile) && isTodayPeriod(digestRange) && (
                    <div className="digest-row">
                      <span className="digest-row-label">
                        Tiền đã thu hôm nay
                      </span>
                      <strong className="digest-row-value gold">
                        {money(recon?.total_collected)}
                      </strong>
                    </div>
                  )}
                </div>

                {/* B. KHO XE HIỆN TẠI */}
                <div className="carem-digest-col">
                  <h3 className="carem-digest-section-label">
                    Kho xe hiện tại
                  </h3>
                  <div className="digest-row digest-row--total">
                    {stockCountBeat > 0 && (
                      <span key={stockCountBeat} className="led-beat" aria-hidden="true" />
                    )}
                    <span className="digest-row-label">Tồn kho hiện tại</span>
                    <strong className="digest-row-value">
                      {d.in_stock + d.reserved} xe
                    </strong>
                  </div>
                  {stockStatus && (
                    <span
                      className={`digest-status digest-status--${stockStatus.tone}`}
                      title="Số xe đang tại cửa hàng (gồm xe đang giữ chỗ) so với ngưỡng trong Cài đặt; bằng đúng ngưỡng vẫn là Tồn kho bình thường"
                    >
                      {stockStatus.label}
                    </span>
                  )}
                  <div className="digest-row">
                    <span className="digest-row-label">Sẵn sàng bán</span>
                    <strong className="digest-row-value lime">
                      {d.in_stock} xe
                    </strong>
                  </div>
                  <div className="digest-row">
                    <span className="digest-row-label">Đang giữ chỗ</span>
                    <strong className="digest-row-value gold">
                      {d.reserved} xe
                    </strong>
                  </div>
                  {d.inventory_cost_pending > 0 && (
                    <div className="digest-row">
                      <span className="digest-row-label">
                        Chờ xác nhận giá mua
                      </span>
                      <strong className="digest-row-value amber">
                        {d.inventory_cost_pending} xe
                      </strong>
                    </div>
                  )}
                  {canFinance(profile) && (
                    <div className="digest-row digest-row--total">
                      {stockValueBeat > 0 && (
                        <span key={stockValueBeat} className="led-beat" aria-hidden="true" />
                      )}
                      <span className="digest-row-label">
                        Tổng giá trị tồn kho
                      </span>
                      <strong className="digest-row-value gold">
                        {money(d.inventory_cost)}
                      </strong>
                    </div>
                  )}
                  {canFinance(profile) && d.inventory_cost == null && d.inventory_cost_pending > 0 && (
                    <p className="digest-note">
                      Giá trị tồn kho chưa khả dụng vì còn{" "}
                      {d.inventory_cost_pending} xe chưa có giá mua.
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* ═══ SUPPORT CARDS: CẦN XỬ LÝ ═══ */}
            <div className="digest-support-grid">
                {/* 1.2 THẺ VIỆC CẦN XỬ LÝ NGAY (ACTIONABLE ALERTS) */}
                <Card>
                  <div className="section-heading" style={{ marginBottom: "12px" }}>
                    <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                      <AlertTriangle size={17} style={{ color: "#d97706" }} />
                      <h3 style={{ fontSize: "14.5px", margin: 0 }}>Cần xử lý tức thời</h3>
                    </div>
                    {(d.inventory_cost_pending > 0 ||
                      (d.overdue_sales_count ?? 0) > 0 ||
                      (d.unpaid_sales_count ?? 0) > 0 ||
                      (d.old_inventory_count ?? 0) > 0) && (
                      <span className="alert-count-chip">
                        {(d.inventory_cost_pending > 0 ? 1 : 0) +
                          ((d.overdue_sales_count ?? 0) > 0 ? 1 : 0) +
                          ((d.unpaid_sales_count ?? 0) > 0 ? 1 : 0) +
                          ((d.old_inventory_count ?? 0) > 0 ? 1 : 0)}{" "}
                        mục
                      </span>
                    )}
                  </div>

                  {d.inventory_cost_pending > 0 ||
                  (d.overdue_sales_count ?? 0) > 0 ||
                  (d.unpaid_sales_count ?? 0) > 0 ||
                  (d.old_inventory_count ?? 0) > 0 ? (
                    <div className="stack" style={{ gap: "8px" }}>
                      {d.inventory_cost_pending > 0 && canFinance(profile) && (
                        <Link
                          to="/vehicles?cost_pending=true"
                          className="alert-card alert-warning"
                          style={{ padding: "10px 12px" }}
                        >
                          <div className="alert-icon">
                            <Clock3 size={18} />
                          </div>
                          <div className="alert-content">
                            <strong>{d.inventory_cost_pending} xe chưa có giá mua</strong>
                            <span>Cần cập nhật giá nhập</span>
                          </div>
                          <ArrowRight size={14} />
                        </Link>
                      )}

                      {(d.overdue_sales_count ?? 0) > 0 && (
                        <Link
                          to="/receivables?payment_status=OVERDUE"
                          className="alert-card alert-danger"
                          style={{ padding: "10px 12px" }}
                        >
                          <div className="alert-icon">
                            <AlertCircle size={18} />
                          </div>
                          <div className="alert-content">
                            <strong>
                              {d.overdue_sales_count} khoản nợ quá hạn (
                              {compactMoney(d.total_overdue_debt ?? 0)})
                            </strong>
                            <span>Khách trễ hẹn, cần liên hệ thu</span>
                          </div>
                          <ArrowRight size={14} />
                        </Link>
                      )}

                      {(d.unpaid_sales_count ?? 0) > 0 && (
                        <Link
                          to="/receivables?payment_status=DEBT_ONLY"
                          className="alert-card alert-info"
                          style={{ padding: "10px 12px" }}
                        >
                          <div className="alert-icon">
                            <CreditCard size={18} />
                          </div>
                          <div className="alert-content">
                            <strong>
                              {d.unpaid_sales_count} khoản nợ đang theo dõi (
                              {compactMoney(d.total_receivables ?? 0)})
                            </strong>
                            <span>Bấm để mở sổ nợ cần thu</span>
                          </div>
                          <ArrowRight size={14} />
                        </Link>
                      )}

                      {(d.old_inventory_count ?? 0) > 0 && (
                        <Link
                          to="/vehicles?status=AVAILABLE&sort=longest_stock&min_days=61"
                          className="alert-card alert-neutral"
                          style={{ padding: "10px 12px" }}
                        >
                          <div className="alert-icon">
                            <CalendarDays size={18} />
                          </div>
                          <div className="alert-content">
                            <strong>{d.old_inventory_count} xe tồn kho &gt; 60 ngày</strong>
                            <span>Cân nhắc giảm giá hoặc xúc tiến</span>
                          </div>
                          <ArrowRight size={14} />
                        </Link>
                      )}
                    </div>
                  ) : (
                    <div className="row" style={{ gap: "8px", alignItems: "center", color: "#16a34a", padding: "10px 0" }}>
                      <CheckCircle2 size={18} />
                      <span className="small">Mọi công việc kho &amp; công nợ đang trơn tru!</span>
                    </div>
                  )}
                </Card>
              </div>

                {/* 2.2 BIỂU ĐỒ NHỊP KINH DOANH TRONG KỲ */}
                {canManage(profile) && (
                  <Card className="revenue-card">
                    <div className="section-heading">
                      <div>
                        <h2>Nhịp kinh doanh theo ngày</h2>
                        <p className="muted small">
                          Doanh thu từng ngày trong kỳ đang xem ({dateLabel(range.from)} – {dateLabel(range.to)})
                        </p>
                      </div>
                      <span className="chart-legend">
                        <i /> Doanh thu
                      </span>
                    </div>
                    <div className="revenue-total">
                      {money(d.revenue)}
                      <span>{d.sales_count} xe đã bán</span>
                    </div>
                    <RevenueChart points={d.daily_sales ?? []} />
                  </Card>
                )}

                {/* 2.3 GIAO DỊCH HOÀN TẤT TRONG KỲ (TABS GIAO DỊCH) */}
                <Card className="table-card">
                  <div className="tx-tabs-header padded">
                    <div className="tx-tab-nav" role="tablist">
                      <button
                        type="button"
                        className={`tx-tab-btn ${activeTxTab === "sales" ? "active" : ""}`}
                        onClick={() => setActiveTxTab("sales")}
                      >
                        <Receipt size={16} />
                        Xe đã bán trong kỳ ({d.recent_sales?.length ?? 0})
                      </button>
                      <button
                        type="button"
                        className={`tx-tab-btn ${activeTxTab === "acquisitions" ? "active" : ""}`}
                        onClick={() => setActiveTxTab("acquisitions")}
                      >
                        <ArrowDownLeft size={16} />
                        Xe vừa thu vào ({d.recent_acquisitions?.length ?? 0})
                      </button>
                      {canFinance(profile) && (d.top_profitable?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          className={`tx-tab-btn ${activeTxTab === "profitable" ? "active" : ""}`}
                          onClick={() => setActiveTxTab("profitable")}
                        >
                          <TrendingUp size={16} />
                          Top lợi nhuận ({d.top_profitable?.length ?? 0})
                        </button>
                      )}
                    </div>

                    <Link
                      className="text-link"
                      to={activeTxTab === "acquisitions" ? "/acquisitions" : "/sales"}
                    >
                      Xem tất cả <ArrowRight size={14} />
                    </Link>
                  </div>

                  {activeTxTab === "sales" && (
                    d.recent_sales?.length ? (
                      <div className="compact-list">
                        {d.recent_sales.map((s) => (
                          <Link to={"/sales/" + s.id} className="recent-sale" key={s.id}>
                            <span className="record-icon">
                              <Receipt size={18} />
                            </span>
                            <div>
                              <strong>{vehicleTitle(s)}</strong>
                              <small>{s.sale_code ? `Mã giao dịch: ${s.sale_code} · ` : ""}{s.customer_name} · {dateLabel(s.sale_date)}</small>
                            </div>
                            <div className="align-right">
                              <strong>{money(s.sale_price)}</strong>
                              {s.status !== "COMPLETED" && <Badge status={s.status} />}
                            </div>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        title="Chưa có giao dịch bán xe trong kỳ"
                        description="Các đơn bán xe hoàn tất trong khoảng ngày đã chọn sẽ hiển thị tại đây."
                      />
                    )
                  )}

                  {activeTxTab === "acquisitions" && (
                    d.recent_acquisitions?.length ? (
                      <div className="compact-list">
                        {d.recent_acquisitions.map((a) => (
                          <Link className="compact-row" key={a.id} to={"/vehicles/" + a.vehicle_id}>
                            <div>
                              <strong>{vehicleTitle(a)}</strong>
                              <small>{vehicleSubtitle(a) || a.frame_number} · {dateLabel(a.acquisition_date)}</small>
                            </div>
                            {canFinance(profile) && a.purchase_price != null && (
                              <strong>{money(a.purchase_price)}</strong>
                            )}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        title="Chưa có xe thu mua trong kỳ"
                        description="Các xe thu vào trong khoảng ngày đã chọn sẽ xuất hiện tại đây."
                      />
                    )
                  )}

                  {activeTxTab === "profitable" && canFinance(profile) && (
                    d.top_profitable?.length ? (
                      <div className="compact-list">
                        {d.top_profitable.map((s) => (
                          <Link className="compact-row" key={s.id} to={"/sales/" + s.id}>
                            <div>
                              <strong>{vehicleTitle(s)}</strong>
                              <small>{dateLabel(s.sale_date)}</small>
                            </div>
                            <strong className="positive" style={{ color: "#16a34a" }}>
                              +{money(s.gross_profit)}
                            </strong>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <EmptyState title="Chưa có dữ liệu lợi nhuận trong kỳ" />
                    )
                  )}
                </Card>

                {/* 2.4 CHI PHÍ TRONG KỲ (nếu có) */}
                {canManage(profile) && (d.recent_expenses?.length ?? 0) > 0 && (
                  <Card>
                    <div className="section-heading">
                      <div>
                        <h2>Chi phí trong kỳ</h2>
                        <p className="muted small">Các khoản chi ghi nhận trong khoảng thời gian này</p>
                      </div>
                      <Link className="text-link" to="/expenses">
                        Chi phí cửa hàng <ArrowRight size={14} />
                      </Link>
                    </div>
                    <div className="compact-list">
                      {d.recent_expenses.map((e) => (
                        <div className="compact-row" key={e.id}>
                          <div>
                            <strong>{e.description}</strong>
                            <small>{dateLabel(e.expense_date)}</small>
                          </div>
                          <strong style={{ color: "#dc2626" }}>-{money(e.amount)}</strong>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
          </>
        )
      )}
    </div>
  );
}

/** True when the chosen period is exactly the current day. */
function isTodayPeriod(range: DateFilter) {
  const day = today();
  return range.from === day && range.to === day;
}

/**
 * Period phrase reused inside digest labels: "hôm nay", "hôm qua", "tuần này",
 * "tháng này", "tháng trước", or "[dd/MM] – [dd/MM]" for a custom range.
 */
function periodDisplay(range: DateFilter): { lower: string } {
  for (const preset of ["today", "yesterday", "week", "month", "last-month"]) {
    const p = datePreset(preset);
    if (p.from === range.from && p.to === range.to)
      return {
        lower: {
          today: "hôm nay",
          yesterday: "hôm qua",
          week: "tuần này",
          month: "tháng này",
          "last-month": "tháng trước",
        }[preset as "today" | "yesterday" | "week" | "month" | "last-month"],
      };
  }
  return { lower: `${dateLabel(range.from)} – ${dateLabel(range.to)}` };
}

function RevenueChart({
  points,
}: {
  points: { date: string; revenue: number; count: number }[];
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!points.length)
    return (
      <div className="chart-empty">
        <Sparkles size={22} style={{ color: "#4f46e5", opacity: 0.7, marginBottom: 6 }} />
        <span>Chưa có doanh thu trong kỳ đã chọn</span>
      </div>
    );

  const max = Math.max(1, ...points.map((p) => p.revenue));
  const n = points.length;
  const getX = (i: number) => 30 + (i / Math.max(1, n - 1)) * 640;
  const getY = (rev: number) => 165 - (rev / max) * 130;

  let dPath = `M ${getX(0)},${getY(points[0].revenue)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = getX(i);
    const y0 = getY(points[i].revenue);
    const x1 = getX(i + 1);
    const y1 = getY(points[i + 1].revenue);
    const cpx1 = x0 + (x1 - x0) / 2;
    const cpy1 = y0;
    const cpx2 = x0 + (x1 - x0) / 2;
    const cpy2 = y1;
    dPath += ` C ${cpx1},${cpy1} ${cpx2},${cpy2} ${x1},${y1}`;
  }

  const endX = getX(n - 1);
  const startX = getX(0);
  const areaPath = `${dPath} L ${endX},170 L ${startX},170 Z`;

  const peakIndex = points.reduce(
    (maxIdx, p, idx, arr) => (p.revenue > arr[maxIdx].revenue ? idx : maxIdx),
    0,
  );
  const peakPoint = points[peakIndex];
  const activeIdx = hoveredIndex ?? (peakPoint.revenue > 0 ? peakIndex : null);
  const activePoint = activeIdx != null ? points[activeIdx] : null;

  return (
    <div className="revenue-chart-container" aria-label="Biểu đồ doanh thu">
      <div className="chart-hud-row">
        {activePoint ? (
          <div className="chart-active-hud">
            <span className="hud-date">{dateLabel(activePoint.date)}:</span>
            <strong className="hud-val">{money(activePoint.revenue)}</strong>
            <span className="hud-count">({activePoint.count} xe)</span>
          </div>
        ) : (
          <div className="chart-active-hud">
            <span className="hud-date">Đỉnh cao:</span>
            <strong className="hud-val">{money(peakPoint.revenue)}</strong>
          </div>
        )}
        <span className="chart-period-hint">Rê chuột xem từng ngày</span>
      </div>

      <div className="revenue-chart">
        <svg viewBox="0 0 700 205" role="img">
          <title>Doanh thu theo ngày</title>
          <defs>
            <linearGradient id="irisArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.22" />
              <stop offset="65%" stopColor="#4f46e5" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#4f46e5" stopOpacity="0" />
            </linearGradient>
            <filter id="irisGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#4f46e5" floodOpacity="0.25" />
            </filter>
          </defs>
          {[35, 78, 122, 165].map((y) => (
            <line
              key={y}
              x1="30"
              x2="670"
              y1={y}
              y2={y}
              style={{ stroke: 'var(--chart-grid, #f1f3f7)' }}
              strokeDasharray="4 4"
            />
          ))}
          <path d={areaPath} fill="url(#irisArea)" />
          <path
            d={dPath}
            fill="none"
            stroke="#4f46e5"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#irisGlow)"
          />

          {points.map((p, i) => {
            const cx = getX(i);
            const cy = getY(p.revenue);
            const isHovered = activeIdx === i;
            return (
              <g
                key={p.date}
                className="chart-point-group"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <rect
                  x={cx - 16}
                  y="20"
                  width="32"
                  height="150"
                  fill="transparent"
                  cursor="pointer"
                />
                {isHovered && (
                  <line
                    x1={cx}
                    x2={cx}
                    y1="25"
                    y2="165"
                    stroke="rgba(79, 70, 229, 0.4)"
                    strokeWidth="1.5"
                    strokeDasharray="2 2"
                  />
                )}
                {(isHovered || (i === peakIndex && peakPoint.revenue > 0)) && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isHovered ? "5" : "3.5"}
                    fill="#4f46e5"
                    style={{ stroke: 'var(--chart-point-ring, #ffffff)' }}
                    strokeWidth="2"
                    cursor="pointer"
                  />
                )}
              </g>
            );
          })}

          <text x="30" y="195" className="chart-axis-text">
            {dateLabel(points[0].date)}
          </text>
          {n > 2 && (
            <text x="350" y="195" textAnchor="middle" className="chart-axis-text">
              {dateLabel(points[Math.floor(n / 2)].date)}
            </text>
          )}
          <text x="670" y="195" textAnchor="end" className="chart-axis-text">
            {dateLabel(points.at(-1)!.date)}
          </text>
        </svg>
      </div>
    </div>
  );
}
