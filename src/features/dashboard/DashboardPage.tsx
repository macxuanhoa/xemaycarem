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
  Boxes,
  CalendarDays,
  Clock3,
  CreditCard,
  FileSpreadsheet,
  Plus,
  Receipt,
  Scale,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import { api } from "@/lib/api";
import { canFinance, canManage, canOperate } from "@/lib/permissions";
import {
  compactMoney,
  dateLabel,
  daysInStock,
  money,
  monthRange,
} from "@/lib/format";
import {
  getRecentVehicles,
  formatRelativeTime,
  type RecentVehicleItem,
} from "@/lib/recentVehicles";
import { useAuth } from "@/features/auth/AuthProvider";
import type { DashboardData } from "@/types";
export default function DashboardPage() {
  const { profile } = useAuth();
  const [range, setRange] = useState(monthRange);
  const [recentVehicles, setRecentVehicles] = useState<RecentVehicleItem[]>([]);

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
  const d = query.data;
  return (
    <div className="stack page-stack">
      <PageHeader
        title={`Xin chào, ${profile?.full_name.split(" ").at(-1) ?? "bạn"} ☀`}
        description="Cùng nhìn lại hoạt động cửa hàng của bạn."
        actions={
          canOperate(profile) && (
            <Button asChild>
              <Link to="/acquisitions/new">
                <Plus size={18} />
                Thu xe mới
              </Link>
            </Button>
          )
        }
      />
      <div
        className={`quick-actions mobile-home-actions ${!canManage(profile) ? "operational-home-actions" : ""}`}
      >
        <Link to="/capture">📷 Quét / Chụp</Link>
        {canOperate(profile) && (
          <>
            <Link to="/acquisitions/new">
              <ArrowDownLeft size={18} /> Thu xe
            </Link>
            <Link to="/sell">
              <ArrowUpRight size={18} /> Bán xe
            </Link>
          </>
        )}
        {canManage(profile) && (
          <Link to="/expenses">
            <Plus size={18} /> Chi phí
          </Link>
        )}
        <Link to="/vehicles">
          <Bike size={18} /> Tìm xe
        </Link>
      </div>
      <div className="dashboard-period">
        <div>
          <span className="eyebrow dark">TỔNG QUAN KINH DOANH</span>
          <span className="live-label">
            <i /> Dữ liệu từ cửa hàng
          </span>
        </div>
        <DateRange value={range} onChange={setRange} />
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        d && (
          <>
            {/* ═══ PRIMARY CARDS: THU VÀO – TỒN KHO – BÁN RA ═══ */}
            <div className="metric-grid">
              <Metric
                to={`/acquisitions?from=${monthRange().from}&to=${monthRange().to}`}
                label="Thu vào tháng này"
                value={String(d.acquired_month ?? 0)}
                detail={`${d.acquisitions_count ?? 0} xe trong kỳ đã chọn`}
                icon={<ArrowDownLeft size={21} />}
                featured
              />
              <Metric
                to="/vehicles?status=IN_STOCK"
                label="Tồn kho hiện tại"
                value={String(d.in_stock + d.reserved)}
                detail={`${d.in_stock} sẵn sàng · ${d.reserved} giữ chỗ`}
                icon={<Bike size={21} />}
                featured
              />
              <Metric
                to={`/sales?from=${monthRange().from}&to=${monthRange().to}`}
                label="Bán ra tháng này"
                value={String(d.sold_month)}
                detail={`${d.sales_count} xe trong kỳ đã chọn`}
                icon={<ArrowUpRight size={21} />}
                featured
              />
              {/* Financial KPIs */}
              {canManage(profile) ? (
                <Metric
                  to="/reports"
                  label="Doanh thu trong kỳ"
                  value={compactMoney(d.revenue)}
                  detail={`${d.sales_count} giao dịch hoàn tất`}
                  icon={<Wallet size={21} />}
                />
              ) : (
                <Metric
                  to="/sales"
                  label="Xe bán trong kỳ"
                  value={String(d.sales_count)}
                  detail="Giao dịch đã hoàn tất"
                  icon={<Receipt size={21} />}
                />
              )}
            </div>

            {/* ═══ FINANCIAL KPI ROW (for managers/owners) ═══ */}
            {canFinance(profile) && (
              <div className="metric-grid">
                <Metric
                  to="/reports"
                  label="Lợi nhuận gộp trong kỳ"
                  value={compactMoney(d.gross_profit)}
                  detail="Doanh thu trừ giá vốn đã chốt"
                  icon={<TrendingUp size={21} />}
                />
                <Metric
                  to="/vehicles?status=IN_STOCK"
                  label="Giá vốn tồn kho"
                  value={compactMoney(d.inventory_cost)}
                  detail={
                    d.inventory_cost_pending > 0
                      ? `${d.inventory_cost_pending} xe đang chờ xác nhận giá mua`
                      : "Xe trong kho và đang giữ chỗ"
                  }
                  icon={<Boxes size={21} />}
                />
                {d.acquisition_cost != null && (
                  <Metric
                    to="/acquisitions"
                    label="Tổng giá thu trong kỳ"
                    value={compactMoney(d.acquisition_cost)}
                    detail={`${d.acquisitions_count ?? 0} xe thu vào`}
                    icon={<ArrowDownLeft size={21} />}
                  />
                )}
              </div>
            )}

            {/* ═══ ACTIONABLE BUSINESS ALERTS: CẦN XỬ LÝ ═══ */}
            {(d.inventory_cost_pending > 0 ||
              (d.overdue_sales_count ?? 0) > 0 ||
              (d.unpaid_sales_count ?? 0) > 0 ||
              (d.old_inventory_count ?? 0) > 0) && (
              <section className="business-alerts">
                <div
                  className="section-heading"
                  style={{ marginBottom: "12px" }}
                >
                  <div
                    className="row"
                    style={{ gap: "8px", alignItems: "center" }}
                  >
                    <AlertTriangle
                      size={18}
                      style={{ color: "var(--color-danger, #dc2626)" }}
                    />
                    <h2 style={{ fontSize: "16px", margin: 0 }}>
                      Cần xử lý ngay
                    </h2>
                  </div>
                  <span className="muted small">
                    Công việc và khoản mục cần giải quyết để bảo đảm dòng tiền
                    và tồn kho
                  </span>
                </div>
                <div className="alert-grid">
                  {d.inventory_cost_pending > 0 && canFinance(profile) && (
                    <Link
                      to="/vehicles?cost_pending=true"
                      className="alert-card alert-warning"
                    >
                      <div className="alert-icon">
                        <Clock3 size={20} />
                      </div>
                      <div className="alert-content">
                        <strong>
                          {d.inventory_cost_pending} xe chưa có giá mua
                        </strong>
                        <span>
                          Cần cập nhật giá nhập để mở khóa bán và tính lợi nhuận
                        </span>
                      </div>
                      <ArrowRight size={16} />
                    </Link>
                  )}
                  {(d.overdue_sales_count ?? 0) > 0 && (
                    <Link
                      to="/receivables?payment_status=OVERDUE"
                      className="alert-card alert-danger"
                    >
                      <div className="alert-icon">
                        <AlertCircle size={20} />
                      </div>
                      <div className="alert-content">
                        <strong>
                          {d.overdue_sales_count} khoản nợ quá hạn (
                          {compactMoney(d.total_overdue_debt ?? 0)})
                        </strong>
                        <span>
                          Khách hàng đã quá hạn hẹn trả tiền, cần liên hệ thu
                          hồi
                        </span>
                      </div>
                      <ArrowRight size={16} />
                    </Link>
                  )}
                  {(d.unpaid_sales_count ?? 0) > 0 && (
                    <Link
                      to="/receivables?payment_status=DEBT_ONLY"
                      className="alert-card alert-info"
                    >
                      <div className="alert-icon">
                        <CreditCard size={20} />
                      </div>
                      <div className="alert-content">
                        <strong>
                          {d.unpaid_sales_count} giao dịch còn nợ (
                          {compactMoney(d.total_receivables ?? 0)})
                        </strong>
                        <span>
                          Khoản nợ chưa thanh toán đủ, bấm để theo dõi và thu nợ
                        </span>
                      </div>
                      <ArrowRight size={16} />
                    </Link>
                  )}
                  {(d.old_inventory_count ?? 0) > 0 && (
                    <Link
                      to="/vehicles?status=AVAILABLE&sort=longest_stock&min_days=61"
                      className="alert-card alert-neutral"
                    >
                      <div className="alert-icon">
                        <CalendarDays size={20} />
                      </div>
                      <div className="alert-content">
                        <strong>
                          {d.old_inventory_count} xe tồn kho &gt; 60 ngày
                        </strong>
                        <span>
                          Xe tồn kho lâu ngày, cân nhắc giảm giá hoặc xúc tiến
                          bán
                        </span>
                      </div>
                      <ArrowRight size={16} />
                    </Link>
                  )}
                </div>
              </section>
            )}

            {/* Quick actions */}
            <div className="quick-actions">
              <span>Thao tác nhanh</span>
              {canOperate(profile) && (
                <>
                  <Link to="/acquisitions/new">
                    <ArrowDownLeft size={17} /> Thu xe
                  </Link>
                  <Link to="/sell">
                    <ArrowUpRight size={17} /> Bán xe
                  </Link>
                  <Link to="/receivables">
                    <CreditCard size={17} /> Công nợ
                  </Link>
                </>
              )}
              {canManage(profile) && (
                <>
                  <Link to="/reconciliation">
                    <Scale size={17} /> Đối soát cuối ngày
                  </Link>
                  <Link to="/expenses">
                    <Plus size={17} /> Thêm chi phí
                  </Link>
                </>
              )}
              {canOperate(profile) && (
                <Link to="/import-vehicles">
                  <FileSpreadsheet size={17} /> Nhập xe từ file
                </Link>
              )}
              <Link to="/vehicles">
                <Bike size={17} /> Tìm trong kho
              </Link>
            </div>

            {d.inventory_indicator && d.inventory_indicator !== "NORMAL" && (
              <p className="notice">
                {d.inventory_indicator === "LOW"
                  ? "Lượng xe tồn đang dưới ngưỡng theo dõi của cửa hàng."
                  : "Lượng xe tồn đang trên ngưỡng theo dõi của cửa hàng."}{" "}
                <Link className="text-link" to="/vehicles">
                  Xem kho xe <ArrowRight size={14} />
                </Link>
              </p>
            )}

            {/* ═══ RECENT VEHICLES (XE VỪA THAO TÁC) ═══ */}
            {recentVehicles.length > 0 && (
              <Card className="recent-vehicles-card">
                <div className="section-heading">
                  <div
                    className="row"
                    style={{ gap: "8px", alignItems: "center" }}
                  >
                    <Clock3 size={18} />
                    <h2>Xe vừa thao tác</h2>
                  </div>
                  <span className="muted small">Mở nhanh chỉ với 1 chạm</span>
                </div>
                <div className="recent-vehicles-grid">
                  {recentVehicles.slice(0, 6).map((item) => (
                    <Link
                      key={item.id}
                      to={`/vehicles/${item.id}`}
                      className="recent-vehicle-chip"
                    >
                      <span className="recent-chip-icon">
                        <Bike size={18} />
                      </span>
                      <div className="recent-chip-content">
                        <div className="row between" style={{ gap: "6px" }}>
                          <strong>
                            {item.brand} {item.model}
                          </strong>
                          <Badge status={item.status} />
                        </div>
                        <div className="recent-chip-sub">
                          <span>
                            {item.license_plate ||
                              item.frame_number ||
                              item.internal_code}
                          </span>
                          <span>·</span>
                          <span className="time">
                            {formatRelativeTime(item.updated_at)}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </Card>
            )}

            {/* ═══ MAIN GRID ═══ */}
            <div className="dashboard-main-grid">
              {canManage(profile) ? (
                <Card className="revenue-card">
                  <div className="section-heading">
                    <div>
                      <h2>Nhịp kinh doanh</h2>
                      <p className="muted small">
                        Doanh thu theo ngày trong khoảng đã chọn
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
                    Tìm nhanh xe trong kho, bổ sung thông tin xe hoặc ghi nhận
                    giao dịch khi khách nhận xe.
                  </p>
                  <div className="quick-actions" style={{ marginTop: 24 }}>
                    <Link to="/vehicles">
                      Mở kho xe <ArrowRight size={16} />
                    </Link>
                    {canOperate(profile) && (
                      <Link to="/sell">
                        Tạo giao dịch <ArrowUpRight size={16} />
                      </Link>
                    )}
                  </div>
                </Card>
              )}
              <Card className="today-card">
                <div className="section-heading">
                  <h2>Hôm nay tại cửa hàng</h2>
                  <CalendarDays size={18} />
                </div>
                <div className="today-primary">
                  <span>{d.sold_today}</span>
                  <p>xe đã giao đến khách hàng</p>
                </div>
                <div className="today-line">
                  <span>Thu vào hôm nay</span>
                  <strong>{d.acquired_today ?? 0} xe</strong>
                </div>
                {canManage(profile) && (
                  <div className="today-line">
                    <span>Doanh thu hôm nay</span>
                    <strong>{money(d.today_revenue)}</strong>
                  </div>
                )}
                {canFinance(profile) && (
                  <div className="today-line">
                    <span>Lợi nhuận gộp hôm nay</span>
                    <strong>{money(d.today_profit)}</strong>
                  </div>
                )}
                <div className="today-line">
                  <span>Bán trong tháng này</span>
                  <strong>{d.sold_month} xe</strong>
                </div>
                <div className="today-line">
                  <span>Thu vào tháng này</span>
                  <strong>{d.acquired_month ?? 0} xe</strong>
                </div>
                {canManage(profile) && (
                  <div className="today-line">
                    <span>Doanh thu tháng này</span>
                    <strong>{money(d.month_revenue)}</strong>
                  </div>
                )}
                {canFinance(profile) && (
                  <div className="today-line">
                    <span>Lợi nhuận gộp tháng này</span>
                    <strong>{money(d.month_profit)}</strong>
                  </div>
                )}
                <Link className="text-link row" to="/sales">
                  Xem các giao dịch <ArrowRight size={16} />
                </Link>
              </Card>
            </div>

            {/* ═══ SECONDARY: Recent acquisitions + sales ═══ */}
            <div className="dashboard-secondary-grid">
              <Card>
                <div className="section-heading">
                  <div>
                    <h2>Xe vừa thu vào</h2>
                    <p className="muted small">Các xe thu mua gần đây nhất</p>
                  </div>
                  <Link className="text-link" to="/acquisitions">
                    Xem tất cả <ArrowRight size={15} />
                  </Link>
                </div>
                {d.recent_acquisitions?.length ? (
                  <div className="compact-list">
                    {d.recent_acquisitions.map((a) => (
                      <Link
                        className="compact-row"
                        key={a.id}
                        to={"/vehicles/" + a.vehicle_id}
                      >
                        <div>
                          <strong>
                            {a.brand} {a.model}
                          </strong>
                          <small>
                            {a.frame_number} · {dateLabel(a.acquisition_date)}
                          </small>
                        </div>
                        {canFinance(profile) && a.purchase_price != null && (
                          <strong>{money(a.purchase_price)}</strong>
                        )}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="Sẵn sàng đón chiếc xe đầu tiên" />
                )}
              </Card>

              <Card className="table-card">
                <div className="section-heading padded">
                  <div>
                    <h2>Giao dịch gần đây</h2>
                    <p className="muted small">Các xe đã bán trong kỳ</p>
                  </div>
                  <Link className="text-link" to="/sales">
                    Xem tất cả <ArrowRight size={15} />
                  </Link>
                </div>
                {d.recent_sales?.length ? (
                  <div className="compact-list">
                    {d.recent_sales.map((s) => (
                      <Link
                        to={"/sales/" + s.id}
                        className="recent-sale"
                        key={s.id}
                      >
                        <span className="record-icon">
                          <Receipt size={20} />
                        </span>
                        <div>
                          <strong>
                            {s.brand} {s.model || s.sale_code}
                          </strong>
                          <small>
                            {s.customer_name} · {dateLabel(s.sale_date)}
                          </small>
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
                    title="Chưa có giao dịch trong kỳ"
                    description="Giao dịch bán xe hoàn tất sẽ xuất hiện tại đây."
                  />
                )}
              </Card>
            </div>

            {/* ═══ AGING + LONGEST + PROFITABLE ═══ */}
            <div className="dashboard-secondary-grid">
              <Card>
                <div className="section-heading">
                  <div>
                    <h2>Tuổi tồn kho</h2>
                    <p className="muted small">
                      Chủ động theo dõi xe lưu kho lâu
                    </p>
                  </div>
                  <Clock3 size={19} />
                </div>
                <div className="aging-stats">
                  {(d.aging ?? []).map((a) => (
                    <div key={a.bucket}>
                      <strong>{a.count}</strong>
                      <span>{a.bucket} ngày</span>
                    </div>
                  ))}
                </div>
                <div className="compact-list">
                  {d.longest_stock?.length ? (
                    d.longest_stock.slice(0, 4).map((v) => (
                      <Link
                        className="compact-row"
                        key={v.id}
                        to={"/vehicles/" + v.id}
                      >
                        <div>
                          <strong>
                            {v.brand} {v.model}
                          </strong>
                          <small>{v.frame_number || v.internal_code}</small>
                        </div>
                        <span className="age-badge">
                          {v.days_in_inventory ?? daysInStock(v.purchase_date)}{" "}
                          ngày
                        </span>
                      </Link>
                    ))
                  ) : (
                    <p className="muted small">Kho xe hiện chưa có dữ liệu.</p>
                  )}
                </div>
              </Card>
              <Card>
                <div className="section-heading">
                  <h2>
                    {canFinance(profile)
                      ? "Xe có lợi nhuận cao"
                      : "Theo dõi công việc"}
                  </h2>
                  <TrendingUp size={19} />
                </div>
                {canFinance(profile) ? (
                  d.top_profitable?.length ? (
                    d.top_profitable.slice(0, 4).map((s) => (
                      <Link
                        className="compact-row"
                        key={s.id}
                        to={"/sales/" + s.id}
                      >
                        <div>
                          <strong>
                            {s.brand} {s.model || s.sale_code}
                          </strong>
                          <small>{dateLabel(s.sale_date)}</small>
                        </div>
                        <strong className="positive">
                          {money(s.gross_profit)}
                        </strong>
                      </Link>
                    ))
                  ) : (
                    <EmptyState title="Chưa có dữ liệu lợi nhuận" />
                  )
                ) : (
                  <p className="muted">
                    Mở kho xe để cập nhật thông tin hoặc tạo giao dịch mới khi
                    khách nhận xe.
                  </p>
                )}
              </Card>
            </div>

            {/* ═══ RECENT EXPENSES ═══ */}
            {canManage(profile) && (
              <Card>
                <div className="section-heading">
                  <h2>Chi phí gần đây</h2>
                  <Link className="text-link" to="/expenses">
                    Quản lý chi phí
                  </Link>
                </div>
                {d.recent_expenses?.length ? (
                  d.recent_expenses.map((e) => (
                    <div className="compact-row" key={e.id}>
                      <div>
                        <strong>{e.description}</strong>
                        <small>{dateLabel(e.expense_date)}</small>
                      </div>
                      <strong>{money(e.amount)}</strong>
                    </div>
                  ))
                ) : (
                  <p className="muted">
                    Chưa có chi phí trong khoảng thời gian này.
                  </p>
                )}
              </Card>
            )}
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
        {icon}
      </div>
      <strong className="metric-value">{value}</strong>
      <p>{detail}</p>
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
  if (!points.length)
    return (
      <div className="chart-empty">
        <span>Chưa có doanh thu trong kỳ</span>
        <div />
        <div />
        <div />
      </div>
    );
  const max = Math.max(1, ...points.map((p) => p.revenue));
  const path = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${30 + (i / Math.max(1, points.length - 1)) * 640},${170 - (p.revenue / max) * 135}`,
    )
    .join(" ");
  return (
    <div className="revenue-chart" aria-label="Biểu đồ doanh thu">
      <svg viewBox="0 0 700 210" role="img">
        <title>Doanh thu theo ngày</title>
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#45796b" stopOpacity=".22" />
            <stop offset="100%" stopColor="#45796b" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[35, 80, 125, 170].map((y) => (
          <line
            key={y}
            x1="30"
            x2="670"
            y1={y}
            y2={y}
            stroke="#e9ece5"
            strokeDasharray="4 4"
          />
        ))}
        <path
          d={`${path} L${points.length > 1 ? 670 : 30},170 L30,170 Z`}
          fill="url(#area)"
        />
        <path d={path} fill="none" stroke="#367561" strokeWidth="3" />
        {points.length === 1 && <circle cx="30" cy="35" r="4" fill="#367561" />}
        <text x="30" y="200">
          {dateLabel(points[0].date)}
        </text>
        <text x="670" y="200" textAnchor="end">
          {dateLabel(points.at(-1)!.date)}
        </text>
      </svg>
    </div>
  );
}
