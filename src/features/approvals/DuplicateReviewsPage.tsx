import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Bike, Check, User, X } from "lucide-react";
import { api } from "@/lib/api";
import { AppError, mapDuplicateReviewError } from "@/lib/errors";
import { executeOperation } from "@/lib/operationRecovery";
import { dateLabel } from "@/lib/format";
import { toast } from "@/lib/toast";
import { canManage } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { ApprovalRequest } from "@/types";

/**
 * Hàng đợi xác minh nghi trùng (PLATE_AND_LAST5) — migration 20261011000400.
 * OWNER và MANAGER xem hồ sơ đang nghi trùng, lý do, người gửi; có thể:
 *   · TỪ CHỐI (REJECT) — không tạo/đổi gì, nhân viên nhận thông báo;
 *   · PHÊ DUYỆT (APPROVE) — bắt buộc lý do ≥ 5 ký tự; server TỰ tái kiểm tra
 *     dữ liệu ứng viên + trạng thái đối chiếu + kết quả trùng trong cùng
 *     transaction rồi lưu ngoại lệ (không bao giờ tạo trùng xe).
 *
 * Không hiển thị giá vốn riêng tư của xe đối chiếu: server đã loại khỏi payload,
 * và UI cũng chỉ đọc chữ ký nhận diện + dữ liệu nhân viên tự nhập cho xe mới.
 */

const pageSize = 50;

/** Xe/đối tác mà nhân viên đã soạn — chỉ trường nhận diện, bỏ qua giá vốn. */
function requestedSummary(payload?: ApprovalRequest["payload"]) {
  const d = (payload?.requested_data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => d[k]).find((v) => typeof v === "string" && v.trim()) ?? "";
  return {
    vehicleType: String(pick("vehicle_type") || ""),
    frame: String(pick("frame_number") || payload?.frame_number || ""),
    plate: String(pick("license_plate") || payload?.license_plate || ""),
    year: d.year != null ? String(d.year) : "",
    color: String(pick("color") || ""),
    seller: String(pick("seller_name", "supplier_name") || ""),
  };
}

export function ReviewRow({ item }: { item: ApprovalRequest }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const candidateId = item.subject_id;
  const summary = requestedSummary(item.payload);
  const isEdit = item.payload?.mode === "SAVE";

  const resolve = useMutation({
    mutationFn: async (action: "APPROVE" | "REJECT") => {
      if (!profile)
        throw new AppError("Vui lòng đăng nhập lại trước khi xử lý yêu cầu.");
      return executeOperation(
        profile.id,
        "resolve_vehicle_duplicate_review",
        item.id,
        (requestId) =>
          api.resolveVehicleDuplicateReview(
            item.id,
            action,
            action === "APPROVE" ? reason.trim() : reason.trim() || undefined,
            requestId,
          ),
      );
    },
    onSuccess: async (result, action) => {
      await client.invalidateQueries({ queryKey: ["duplicate-reviews"] });
      await client.invalidateQueries({ queryKey: ["approvals"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      if (action === "APPROVE") {
        toast.success("Đã phê duyệt và lưu ngoại lệ nghi trùng.", {
          description: "Xe đã được ghi nhận kèm lý do kiểm toán.",
        });
        if (result.vehicle_id) navigate(`/vehicles/${result.vehicle_id}`);
      } else {
        toast.success("Đã từ chối yêu cầu. Không có xe nào được tạo hay thay đổi.");
      }
    },
    onError: (error) =>
      toast.error("Không xử lý được yêu cầu.", {
        description: mapDuplicateReviewError(error),
      }),
  });

  const approveReady = reason.trim().length >= 5;

  return (
    <Card>
      <div className="stack">
        <div className="row between" style={{ gap: 12, alignItems: "start" }}>
          <div>
            <h2 className="section-title" style={{ marginBottom: 4 }}>
              Nghi trùng lúc {isEdit ? "sửa" : "thu"} xe
            </h2>
            <small className="muted">
              <User size={12} style={{ verticalAlign: "-1px" }} />{" "}
              {item.requester_name || "Nhân viên"} · {dateLabel(item.created_at)}
            </small>
          </div>
          <Link className="text-link" to={`/vehicles/${candidateId}`}>
            <Bike size={13} /> Mở hồ sơ nghi trùng
          </Link>
        </div>

        <p className="notice danger" role="alert" style={{ margin: 0 }}>
          {item.reason}
        </p>

        <dl className="summary-list">
          <div>
            <dt>Loại xe nhân viên nhập</dt>
            <dd>{summary.vehicleType || "—"}</dd>
          </div>
          <div>
            <dt>Biển số</dt>
            <dd>{summary.plate || "chưa có"}</dd>
          </div>
          <div>
            <dt>Số khung</dt>
            <dd>{summary.frame || "chưa có"}</dd>
          </div>
          <div>
            <dt>Năm · Màu</dt>
            <dd>{[summary.year, summary.color].filter(Boolean).join(" · ") || "—"}</dd>
          </div>
          <div>
            <dt>Người bán</dt>
            <dd>{summary.seller || "—"}</dd>
          </div>
        </dl>

        <Field
          label="Lý do (bắt buộc ≥ 5 ký tự khi phê duyệt; tùy chọn khi từ chối)"
          error={
            reason.length > 0 && !approveReady
              ? "Ít nhất 5 ký tự."
              : undefined
          }
        >
          <textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="VD: Đã mở hồ sơ cũ, xác nhận đây là xe khác thật (biển mới đổi)…"
          />
        </Field>

        {resolve.isError && <ErrorState error={resolve.error} />}

        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <Button
            type="button"
            variant="secondary"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate("REJECT")}
          >
            <X size={15} /> Từ chối
          </Button>
          <Button
            type="button"
            disabled={resolve.isPending || !approveReady}
            onClick={() => resolve.mutate("APPROVE")}
          >
            <Check size={15} />{" "}
            {resolve.isPending ? "Đang xử lý…" : "Phê duyệt & lưu ngoại lệ"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function DuplicateReviewsPage() {
  const { profile } = useAuth();
  if (!canManage(profile))
    return <EmptyState title="Bạn không có quyền xem hàng đợi xác minh nghi trùng." />;
  return <DuplicateReviewsBoard key={profile?.id} />;
}

function DuplicateReviewsBoard() {
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ["duplicate-reviews", offset],
    queryFn: () => api.listVehicleDuplicateReviews({ limit: pageSize, offset }),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <Loading />;
  if (query.isError)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />;

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  return (
    <div className="stack">
      <PageHeader
        title="Xác minh xe nghi trùng"
        description="Nhân viên gửi hồ sơ nghi trùng (cùng biển số & 5 ký tự cuối số khung). Mở hồ sơ để đối chiếu, rồi phê duyệt lưu ngoại lệ hoặc từ chối."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Không có yêu cầu nghi trùng nào đang chờ"
          description="Khi nhân viên gặp biển số + 5 ký tự cuối trùng một xe đang quản lý, yêu cầu sẽ hiện ở đây."
        />
      ) : (
        items.map((item) => <ReviewRow key={item.id} item={item} />)
      )}
      {total > pageSize && (
        <div className="row between" style={{ marginTop: 12 }}>
          <Button
            type="button"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
          >
            Trang trước
          </Button>
          <span className="muted">
            {offset + 1}–{Math.min(total, offset + pageSize)} / {total}
          </span>
          <Button
            type="button"
            variant="secondary"
            disabled={offset + pageSize >= total}
            onClick={() => setOffset((o) => o + pageSize)}
          >
            Trang sau
          </Button>
        </div>
      )}
    </div>
  );
}

export default DuplicateReviewsPage;
