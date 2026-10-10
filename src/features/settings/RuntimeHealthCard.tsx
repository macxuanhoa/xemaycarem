import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { Button, Card, ErrorState, Loading } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { isOwner } from "@/lib/permissions";
import type { RuntimeIssue } from "@/lib/runtimeIssueCore";

export type RuntimeIssueDigest = {
  items: (RuntimeIssue & {
    occurrences: number;
    first_seen: string;
    last_seen: string;
  })[];
  total_occurrences: number;
  days: number;
};
const labels: Record<RuntimeIssue["code"], string> = {
  JS_ERROR: "Lỗi ứng dụng",
  UNHANDLED_REJECTION: "Thao tác bị gián đoạn",
  RENDER_ERROR: "Không hiển thị được trang",
  NETWORK_ERROR: "Không kết nối được dịch vụ",
  RPC_SERVER_ERROR: "Lỗi xử lý ở máy chủ",
  EDGE_SERVER_ERROR: "Lỗi dịch vụ hỗ trợ",
  EDGE_RELAY_ERROR: "Dịch vụ hỗ trợ gián đoạn",
};
export function RuntimeHealthCard() {
  const { profile } = useAuth();
  const owner = isOwner(profile);
  const query = useQuery({
    queryKey: ["client-issues", 7],
    queryFn: () =>
      api.call<RuntimeIssueDigest>("list_client_issues", { p_days: 7 }),
    enabled: owner,
    refetchOnWindowFocus: false,
    staleTime: 60000,
  });
  if (!owner) return null;
  return (
    <Card className="stack">
      <div
        className="row"
        style={{ justifyContent: "space-between", flexWrap: "wrap" }}
      >
        <h2 className="row">
          <Activity size={20} aria-hidden="true" /> Theo dõi hoạt động
        </h2>
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} aria-hidden="true" /> Làm mới
        </Button>
      </div>
      <p className="muted small">
        Các sự cố đã ghi nhận trong 7 ngày. Chỉ lưu loại lỗi, màn hình và phiên
        bản ứng dụng.
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : query.data ? (
        <>
          <p>
            <strong>{query.data.total_occurrences}</strong> lần ghi nhận
          </p>
          {query.data.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sự cố</th>
                    <th>Số lần</th>
                    <th>Gần nhất</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((item) => (
                    <tr
                      key={`${item.source}:${item.code}:${item.operation}:${item.route}:${item.release}:${item.environment}`}
                    >
                      <td>
                        <strong>{labels[item.code] ?? "Sự cố ứng dụng"}</strong>
                        <details className="muted small">
                          <summary>Chi tiết kỹ thuật</summary>
                          <div>
                            {item.route} · {item.operation}
                            <br />
                            {item.code} · {item.release} · {item.environment}
                          </div>
                        </details>
                      </td>
                      <td>{item.occurrences}</td>
                      <td>
                        {new Date(item.last_seen).toLocaleString("vi-VN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">
              Chưa ghi nhận sự cố trong khoảng thời gian này.
            </p>
          )}
          {query.data.items.length >= 50 ? (
            <p className="muted small">
              Hiển thị 50 nhóm sự cố thường gặp nhất.
            </p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
