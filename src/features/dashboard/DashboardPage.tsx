import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bike,
  Bot,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  CreditCard,
  Receipt,
  Sparkles,
  TrendingUp,
  Wallet,
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
import { canFinance, canManage, canOperate } from "@/lib/permissions";
import {
  compactMoney,
  dateLabel,
  datePreset,
  daysInStock,
  money,
  today,
} from "@/lib/format";
import {
  getRecentVehicles,
  formatRelativeTime,
  type RecentVehicleItem,
} from "@/lib/recentVehicles";
import { useAuth } from "@/features/auth/AuthProvider";
import { DashboardExecutiveBanner } from "./DashboardExecutiveBanner";
import type { DashboardData, DateFilter } from "@/types";

export default function DashboardPage() {
  const { profile } = useAuth();
  // Default to TODAY as explicitly requested by user
  const [range, setRange] = useState<DateFilter>(() => datePreset("today"));
  const [recentVehicles, setRecentVehicles] = useState<RecentVehicleItem[]>([]);
  const [recentExpanded, setRecentExpanded] = useState(true);
  const [activeTxTab, setActiveTxTab] = useState<"sales" | "acquisitions" | "profitable">("sales");

  useEffect(() => {
    setRecentVehicles(getRecentVehicles(profile?.id));
  }, [profile?.id]);

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

  const d = query.data;

  return (
    <div className="stack page-stack">
      {/* ═══ EXECUTIVE HERO BANNER ═══ */}
      <DashboardExecutiveBanner
        profile={profile}
        storeName={settingsQuery.data?.store_name ?? "Cửa hàng Xe Máy Cà Rem"}
        onOpenQuickActions={() => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));
        }}
      />

      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        d && (
          <>
            {/* ═══ AGENT LED DIGEST BANNER (PULSING LED BORDER NOTIFICATION) ═══ */}
            <div className="agent-led-card" role="region" aria-label="Bản tin Trợ lý Cà Rem AI">
              <div className="agent-led-ambient" aria-hidden="true" />
              <div className="agent-led-header">
                <div className="agent-led-badge">
                  <Bot size={17} className="agent-bot-icon" />
                  <span>TRỢ LÝ CÀ REM AI · BẢN TIN TRONG NGÀY</span>
                </div>
                <div className="agent-led-status">
                  <span className="agent-live-dot" aria-hidden="true" />
                  <span>Trực tuyến {dateLabel(today())}</span>
                </div>
              </div>

              <div className="agent-led-body">
                <p className="agent-led-speech">
                  {d.today_revenue && d.today_revenue > 0 ? (
                    <>
                      Hôm nay cửa hàng đã ghi nhận doanh thu{" "}
                      <strong className="agent-highlight-gold">{money(d.today_revenue)}</strong>, hoàn tất{" "}
                      <strong className="agent-highlight-lime">{d.sold_today}</strong> đơn xe xuất kho và thu vào{" "}
                      <strong className="agent-highlight-cyan">{d.acquired_today ?? 0}</strong> xe mới.
                      {canFinance(profile) && d.today_profit != null && (
                        <>
                          {" "}Lợi nhuận gộp hôm nay tạm tính:{" "}
                          <strong className="agent-highlight-emerald">{money(d.today_profit)}</strong>.
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Hôm nay chưa phát sinh giao dịch xuất xe. Hiện đang có{" "}
                      <strong className="agent-highlight-lime">{d.in_stock}</strong> xe sẵn sàng chào bán và{" "}
                      <strong className="agent-highlight-gold">{d.reserved}</strong> xe đang giữ chỗ cọc. Chúc cửa hàng một ngày buôn may bán đắt!
                    </>
                  )}
                </p>

                <div className="agent-led-chips">
                  {canManage(profile) && (
                    <div className="agent-chip">
                      <span className="agent-chip-label">Doanh thu hôm nay</span>
                      <strong className="agent-chip-val gold">{money(d.today_revenue ?? 0)}</strong>
                    </div>
                  )}
                  <div className="agent-chip">
                    <span className="agent-chip-label">Xe bán hôm nay</span>
                    <strong className="agent-chip-val lime">{d.sold_today} xe</strong>
                  </div>
                  <div className="agent-chip">
                    <span className="agent-chip-label">Thu vào hôm nay</span>
                    <strong className="agent-chip-val cyan">{d.acquired_today ?? 0} xe</strong>
                  </div>
                  {canFinance(profile) && (
                    <div className="agent-chip">
                      <span className="agent-chip-label">Lợi nhuận hôm nay</span>
                      <strong className="agent-chip-val emerald">{money(d.today_profit ?? 0)}</strong>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ═══ TWO-SIDES BALANCED DASHBOARD: FIXED KHO VS FILTERABLE KỲ ═══ */}
            <div className="dashboard-two-sides">
              {/* ══════════════════════════════════════════════════════════════
                  PHÍA 1: CỐ ĐỊNH KHO XE & HIỆN TRẠNG TỨC THỜI (REAL-TIME SNAPSHOT)
                  ══════════════════════════════════════════════════════════════ */}
              <div className="dashboard-side-fixed">
                <div className="side-zone-header">
                  <div className="side-zone-title-row">
                    <span className="side-zone-icon blue">
                      <Boxes size={18} />
                    </span>
                    <div>
                      <h2 className="side-zone-title">Kho xe &amp; Hiện trạng</h2>
                      <span className="side-zone-sub">
                        Cố định · Số liệu thời gian thực tại tiệm
                      </span>
                    </div>
                  </div>
                  <span className="live-snapshot-badge">Snapshot thực tế</span>
                </div>

                {/* 1.1 THẺ TỒN KHO HIỆN TẠI */}
                <div className="stock-overview-card">
                  <div className="row between" style={{ alignItems: "center" }}>
                    <span className="metric-label" style={{ margin: 0, fontWeight: 650, fontSize: "12.5px" }}>
                      Tồn kho hiện tại
                    </span>
                    <Bike size={18} style={{ color: "#2563eb" }} />
                  </div>

                  <div className="stock-headline-wrap">
                    <span className="stock-total-num">
                      {d.in_stock + d.reserved}
                    </span>
                    <span className="stock-unit-label">xe đang trong kho</span>
                  </div>

                  <div className="stock-split-row">
                    <div className="stock-split-box available">
                      <span className="stock-split-title">Sẵn sàng bán</span>
                      <strong className="stock-split-val">{d.in_stock} xe</strong>
                    </div>
                    <div className="stock-split-box reserved">
                      <span className="stock-split-title">Đang giữ chỗ</span>
                      <strong className="stock-split-val">{d.reserved} xe</strong>
                    </div>
                  </div>

                  {canFinance(profile) && (
                    <div className="stock-valuation-bar">
                      <span className="muted">Giá vốn tồn kho:</span>
                      <strong>{money(d.inventory_cost)}</strong>
                    </div>
                  )}

                  <Link
                    to="/vehicles?status=AVAILABLE"
                    className="button secondary"
                    style={{ width: "100%", justifyContent: "center", gap: "6px" }}
                  >
                    Xem toàn bộ kho xe
                    <ArrowRight size={15} />
                  </Link>
                </div>

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

                {/* 1.3 THẺ TUỔI TỒN KHO & XE LƯU KHO LÂU NHẤT */}
                <Card>
                  <div className="section-heading" style={{ marginBottom: "10px" }}>
                    <div>
                      <h3 style={{ fontSize: "14.5px", margin: 0 }}>Tuổi tồn kho</h3>
                      <p className="muted small" style={{ margin: 0 }}>Chủ động luân chuyển xe</p>
                    </div>
                    <Clock3 size={17} style={{ color: "#64748b" }} />
                  </div>

                  <div className="aging-stats">
                    {(d.aging ?? []).map((a) => (
                      <div key={a.bucket}>
                        <strong>{a.count}</strong>
                        <span>{a.bucket} ngày</span>
                      </div>
                    ))}
                  </div>

                  {d.longest_stock?.length ? (
                    <div className="compact-list" style={{ marginTop: "12px" }}>
                      <span className="small muted" style={{ fontWeight: 600 }}>Xe lưu kho lâu nhất:</span>
                      {d.longest_stock.slice(0, 3).map((v) => (
                        <Link className="compact-row" key={v.id} to={"/vehicles/" + v.id}>
                          <div>
                            <strong>{v.brand} {v.model}</strong>
                            <small>{v.license_plate || v.frame_number || v.internal_code}</small>
                          </div>
                          <span className="age-badge">
                            {v.days_in_inventory ?? daysInStock(v.purchase_date)} ngày
                          </span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </Card>

                {/* 1.4 XE VỪA THAO TÁC */}
                {recentVehicles.length > 0 && (
                  <Card className="recent-vehicles-card">
                    <button
                      type="button"
                      className="section-heading"
                      onClick={() => setRecentExpanded(!recentExpanded)}
                      style={{
                        width: "100%",
                        cursor: "pointer",
                        textAlign: "left",
                        background: "none",
                        border: "none",
                        padding: 0,
                      }}
                    >
                      <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                        <Clock3 size={16} />
                        <h3 style={{ fontSize: "14.5px", margin: 0 }}>Xe vừa thao tác</h3>
                        {recentExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </div>
                      <span className="muted small">1 chạm mở lại</span>
                    </button>
                    {recentExpanded && (
                      <div className="stack" style={{ gap: "8px", marginTop: "12px" }}>
                        {recentVehicles.slice(0, 4).map((item) => (
                          <Link
                            key={item.id}
                            to={`/vehicles/${item.id}`}
                            className="compact-row"
                            style={{ padding: "8px 10px" }}
                          >
                            <div>
                              <strong>{item.brand} {item.model}</strong>
                              <small>{item.license_plate || item.frame_number}</small>
                            </div>
                            <span className="small muted">{formatRelativeTime(item.updated_at)}</span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </Card>
                )}
              </div>

              {/* ══════════════════════════════════════════════════════════════
                  PHÍA 2: BIẾN ĐỘNG THEO KỲ LỌC (MẶC ĐỊNH LÀ HÔM NAY - RENDER CHUNG)
                  ══════════════════════════════════════════════════════════════ */}
              <div className="dashboard-side-filterable">
                <div className="dashboard-period-toolbar">
                  <DateRange value={range} onChange={setRange} />
                </div>

                {/* All financial metrics are fetched together for the selected date range. */}
                <div className="period-kpi-grid">
                  {canManage(profile) ? (
                    <Metric
                      to={`/sales?from=${range.from}&to=${range.to}`}
                      label="Doanh thu"
                      value={compactMoney(d.revenue)}
                      detail={`${d.sales_count} xe đã bán chốt`}
                      icon={<Wallet size={20} />}
                      featured
                    />
                  ) : (
                    <Metric
                      to={`/sales?from=${range.from}&to=${range.to}`}
                      label="Xe bán trong kỳ"
                      value={String(d.sales_count)}
                      detail="Giao dịch chốt thành công"
                      icon={<Receipt size={20} />}
                      featured
                    />
                  )}

                  <Metric
                    to={canFinance(profile) ? "/reports" : `/acquisitions?from=${range.from}&to=${range.to}`}
                    label={canFinance(profile) ? "Lợi nhuận" : "Xe thu vào trong kỳ"}
                    value={canFinance(profile) ? compactMoney(d.gross_profit) : String(d.acquisitions_count ?? 0)}
                    detail={canFinance(profile) ? "Doanh thu trừ giá vốn" : "Xe thu mua nhập kho"}
                    icon={canFinance(profile) ? <TrendingUp size={20} /> : <ArrowDownLeft size={20} />}
                  />

                  {canFinance(profile) && (
                    <Metric
                      to={`/acquisitions?from=${range.from}&to=${range.to}`}
                      label="Tổng tiền thu mua xe"
                      value={compactMoney(d.acquisition_cost)}
                      detail={`${d.acquisitions_count ?? 0} xe thu trong kỳ`}
                      icon={<ArrowDownLeft size={20} />}
                    />
                  )}
                  {canFinance(profile) && (
                    <Metric
                      to="/expenses"
                      label="Các chi phí khác"
                      value={compactMoney(d.business_expenses ?? 0)}
                      detail="Mặt bằng, vận hành"
                      icon={<CreditCard size={20} />}
                    />
                  )}
                </div>

                {/* 2.2 BIỂU ĐỒ NHỊP KINH DOANH TRONG KỲ */}
                {canManage(profile) ? (
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
                ) : (
                  <Card>
                    <h2>Công việc trong ngày</h2>
                    <p className="muted">
                      Tìm nhanh xe trong kho, bổ sung thông tin xe hoặc ghi nhận giao dịch khi khách nhận xe.
                    </p>
                    <div className="quick-actions" style={{ marginTop: 18 }}>
                      <Link to="/vehicles">
                        Mở kho xe <ArrowRight size={16} />
                      </Link>
                      {canOperate(profile) && (
                        <Link to="/sell">
                          Tạo giao dịch bán <ArrowUpRight size={16} />
                        </Link>
                      )}
                    </div>
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
                              <strong>{s.brand} {s.model || s.sale_code}</strong>
                              <small>{s.customer_name} · {dateLabel(s.sale_date)}</small>
                            </div>
                            <div className="align-right">
                              <strong>{money(s.sale_price)}</strong>
                              <Badge status={s.status} />
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
                              <strong>{a.brand} {a.model}</strong>
                              <small>{a.frame_number} · {dateLabel(a.acquisition_date)}</small>
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
                              <strong>{s.brand} {s.model || s.sale_code}</strong>
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
                        Quản lý chi phí <ArrowRight size={14} />
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
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  featured = false,
  to,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  featured?: boolean;
  to?: string;
}) {
  const content = (
    <>
      <div className="metric-label">
        <span>{label}</span>
        <span className="metric-icon-box">{icon}</span>
      </div>
      <div className="metric-value-wrap">
        <strong className="metric-value">{value}</strong>
      </div>
      <div className="metric-detail-row">
        <p>{detail}</p>
        {to && <ArrowUpRight size={14} className="metric-arrow" aria-hidden="true" />}
      </div>
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className={`metric-link card metric ${featured ? "featured" : ""}`}
      >
        {content}
      </Link>
    );
  }

  return (
    <Card className={`metric ${featured ? "featured" : ""}`}>{content}</Card>
  );
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
              stroke="#f1f3f7"
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
                    stroke="#ffffff"
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
