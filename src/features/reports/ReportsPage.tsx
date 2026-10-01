import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banknote,
  Download,
  FileBarChart,
  LockKeyhole,
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
  Pagination,
  statusLabels,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { canFinance } from "@/lib/permissions";
import { dateLabel, monthRange, money } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import type { DashboardData, Paged } from "@/types";
type ReportRow = Record<string, string | number | null>;
const labels: Record<string, string> = {
  internal_code: "Mã xe",
  vehicle_code: "Mã xe",
  sale_code: "Mã giao dịch",
  brand: "Hãng",
  model: "Dòng xe",
  vehicle_name: "Xe",
  license_plate: "Biển số",
  customer_name: "Khách hàng",
  customer_phone: "Điện thoại",
  sale_price: "Giá bán",
  sale_date: "Ngày bán",
  gross_profit: "Lợi nhuận gộp",
  total_cost_snapshot: "Giá vốn khi bán",
  purchase_cost_snapshot: "Giá mua khi bán",
  expense_cost_snapshot: "Chi phí khi bán",
  paid_amount: "Đã thu",
  remaining_amount: "Còn phải thu",
  status: "Trạng thái",
  purchase_date: "Ngày nhập",
  purchase_price: "Giá mua",
  total_cost: "Giá vốn",
  expense_total: "Chi phí xe",
  asking_price: "Giá niêm yết",
  days_in_inventory: "Ngày tồn",
  amount: "Số tiền",
  description: "Nội dung",
  expense_type: "Loại chi phí",
  category: "Danh mục",
  expense_date: "Ngày chi",
  cost_pending: "Chờ giá mua",
  frame_number: "Số khung",
  acquisition_date: "Ngày thu",
  seller_name: "Người bán",
  seller_phone: "SĐT người bán",
  creator_name: "Người nhập",
};
const moneyKeys = new Set([
  "sale_price",
  "gross_profit",
  "total_cost_snapshot",
  "purchase_cost_snapshot",
  "expense_cost_snapshot",
  "paid_amount",
  "remaining_amount",
  "purchase_price",
  "total_cost",
  "expense_total",
  "asking_price",
  "amount",
]);
const preferred = [
  "frame_number",
  "internal_code",
  "vehicle_code",
  "sale_code",
  "brand",
  "model",
  "vehicle_name",
  "license_plate",
  "customer_name",
  "sale_date",
  "acquisition_date",
  "purchase_date",
  "description",
  "expense_date",
  "seller_name",
  "seller_phone",
  "creator_name",
  "status",
  "sale_price",
  "purchase_price",
  "paid_amount",
  "remaining_amount",
  "expense_total",
  "total_cost",
  "total_cost_snapshot",
  "gross_profit",
  "amount",
  "days_in_inventory",
];
export default function ReportsPage() {
  const pageSize = 6;
  const { profile } = useAuth();
  const client = useQueryClient();
  const [kind, setKind] = useState("sales"),
    [range, setRange] = useState(monthRange),
    [page, setPage] = useState(1),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ["report", kind, range, page],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.call<Paged<ReportRow>>("report", {
        p_kind: kind,
        p_filters: {
          ...range,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
  });

  useEffect(() => {
    if (q.data && page * pageSize < q.data.total) {
      void client.prefetchQuery({
        queryKey: ["report", kind, range, page + 1],
        queryFn: () =>
          api.call<Paged<ReportRow>>("report", {
            p_kind: kind,
            p_filters: {
              ...range,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [q.data, page, kind, range, client]);
  const dashboardQuery = useQuery({
    queryKey: ["report-pnl-summary", range],
    queryFn: () =>
      api.call<DashboardData>("dashboard", {
        p_from: range.from,
        p_to: range.to,
      }),
    enabled: canFinance(profile),
  });
  const pnl = dashboardQuery.data;
  const types = [
    ["acquisitions", "Thu vào"],
    ["sales", "Bán ra"],
    ["inventory", "Tồn kho"],
    ...(canFinance(profile) ? [["profit", "Lợi nhuận gộp"]] : []),
    ["vehicle_expenses", "Chi phí xe"],
    ["business_expenses", "Chi phí cửa hàng"],
  ];
  const keys = preferred.filter((k) => q.data?.items.some((r) => k in r));
  async function exportData() {
    setExporting(true);
    setExportError(null);
    try {
      const all: ReportRow[] = [];
      let offset = 0,
        total = 1;
      while (offset < total) {
        const data = await api.call<Paged<ReportRow>>("report", {
          p_kind: kind,
          p_filters: { ...range, offset, limit: 100 },
        });
        all.push(...data.items);
        total = data.total;
        offset += data.items.length;
        if (!data.items.length) break;
      }
      downloadCsv(
        `carem-${kind}-${range.from}-${range.to}.csv`,
        all.map((row) =>
          Object.fromEntries(
            Object.entries(row)
              .filter(([k]) => labels[k])
              .map(([k, v]) => [
                labels[k],
                k === "status" ? (statusLabels[String(v)] ?? v) : v,
              ]),
          ),
        ),
      );
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="stack">
      <PageHeader
        title="Báo cáo"
        description="Nhìn rõ số liệu, đưa ra quyết định có cơ sở."
        actions={
          <Button
            variant="secondary"
            onClick={() => void exportData()}
            disabled={exporting || !q.data?.total}
          >
            <Download size={17} />
            {exporting ? "Đang xuất…" : "Xuất CSV"}
          </Button>
        }
      />
      {canFinance(profile) && pnl && (
        <div className="executive-kpi-grid">
          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Doanh thu bán xe</span>
              <span className="executive-metric-icon indigo">
                <Wallet size={18} />
              </span>
            </div>
            <strong className="executive-metric-val price">
              {money(pnl.revenue)}
            </strong>
            <span className="executive-metric-sub">
              <strong>{pnl.sales_count}</strong> xe chốt bán trong kỳ
            </span>
          </div>

          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Lợi nhuận gộp từ xe</span>
              <span className="executive-metric-icon emerald">
                <TrendingUp size={18} />
              </span>
            </div>
            <strong className="executive-metric-val price" style={{ color: "#16a34a" }}>
              {money(pnl.gross_profit)}
            </strong>
            <span className="executive-metric-sub">
              Doanh thu trừ giá vốn chốt
            </span>
          </div>

          <div className="executive-metric-card">
            <div className="executive-metric-header">
              <span className="executive-metric-title">Chi phí vận hành tiệm</span>
              <span className="executive-metric-icon slate">
                <Banknote size={18} />
              </span>
            </div>
            <strong className="executive-metric-val price" style={{ color: "#dc2626" }}>
              {money(pnl.business_expenses ?? 0)}
            </strong>
            <span className="executive-metric-sub">
              Mặt bằng, điện nước, vận hành
            </span>
          </div>

          <div
            className="executive-metric-card"
            style={{
              background: "linear-gradient(135deg, #064e3b 0%, #047857 100%)",
              color: "#ffffff",
            }}
          >
            <div className="executive-metric-header">
              <span className="executive-metric-title" style={{ color: "#a7f3d0" }}>
                Lợi nhuận ròng thực tế
              </span>
              <span
                className="executive-metric-icon"
                style={{ background: "rgba(255,255,255,0.2)", color: "#ffffff" }}
              >
                <Scale size={18} />
              </span>
            </div>
            <strong className="executive-metric-val price" style={{ color: "#ffffff" }}>
              {money((pnl.gross_profit ?? 0) - (pnl.business_expenses ?? 0))}
            </strong>
            <span className="executive-metric-sub" style={{ color: "#d1fae5" }}>
              Lãi gộp xe − Chi phí vận hành
            </span>
          </div>
        </div>
      )}
      <Card>
        <div className="section-heading">
          <div className="row">
            <FileBarChart size={22} />
            <h2>Báo cáo hoạt động</h2>
          </div>
          <DateRange
            value={range}
            onChange={(v) => {
              setRange(v);
              setPage(1);
            }}
          />
        </div>
        <div className="tabs">
          {types.map(([value, label]) => (
            <button
              className={`tab ${kind === value ? "active" : ""}`}
              key={value}
              onClick={() => {
                setKind(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>
      {kind === "inventory" && (
        <p className="notice">
          Tồn kho hiện tại của các xe nhập trong khoảng ngày đã chọn. Báo cáo
          này không tái dựng số dư tồn kho lịch sử.
        </p>
      )}
      {kind === "profit" && (
        <p className="notice">
          Lợi nhuận gộp = giá bán − giá vốn đã chốt tại thời điểm bán. Chi phí
          vận hành cửa hàng được báo cáo riêng.
        </p>
      )}
      {!canFinance(profile) && (
        <p className="row muted small">
          <LockKeyhole size={15} /> Giá mua và lợi nhuận chỉ hiển thị khi bạn
          được cấp quyền.
        </p>
      )}
      {exportError != null && <ErrorState error={exportError} />}
      <Card className="table-card">
        {q.isFetching && !q.isPending && (
          <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
        )}
        {q.isPending ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState
            title="Chưa có dữ liệu trong kỳ"
            description="Thử chọn khoảng thời gian khác."
          />
        ) : (
          <>
            <div className={`table-wrap ${q.isFetching && !q.isPending ? "is-updating" : ""}`}>
              <table className="data-table">
                <thead>
                  <tr>
                    {keys.map((k) => (
                      <th key={k}>{labels[k] ?? k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((r, i) => (
                    <tr key={r.id ?? i}>
                      {keys.map((k) => (
                        <td
                          key={k}
                          className={moneyKeys.has(k) ? "numeric" : ""}
                        >
                          {k === "status" ? (
                            <Badge status={String(r[k])} />
                          ) : moneyKeys.has(k) ? (
                            money(r[k])
                          ) : k.endsWith("_date") ? (
                            dateLabel(String(r[k]))
                          ) : (
                            (r[k] ?? "—")
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              total={q.data.total}
              pageSize={pageSize}
              onChange={setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}
