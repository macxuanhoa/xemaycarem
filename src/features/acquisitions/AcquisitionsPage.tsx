import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CirclePlus,
  NotebookPen,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { canDeleteVehicle, canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useDialog } from "@/lib/useDialog";
import { useAuth } from "@/features/auth/AuthProvider";
import { toast } from "@/lib/toast";
import {
  Badge,
  Button,
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { RowDeleteAction, RowViewAction } from "@/components/ui/RowActions";
import { Highlight } from "@/components/search/Highlight";
import type { Acquisition, Paged } from "@/types";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import {
  VehicleIdentityChips,
  vehicleTypeName,
} from "@/components/ui/VehicleIdentityChips";

const pageSize = 6;

export function AcquisitionsPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const rawFrom = params.get("from") || `${today().slice(0, 7)}-01`;
  const rawTo = params.get("to") || today();
  const [range, setRange] = useState(() => {
    if (rawFrom && rawTo && rawFrom > rawTo) {
      return { from: rawTo, to: rawFrom };
    }
    return { from: rawFrom, to: rawTo };
  });
  const [search, setSearch] = useState(
    () => params.get("search") || params.get("q") || "",
  );
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<Acquisition | null>(null);

  const query = useQuery({
    queryKey: ["acquisitions", range, debouncedSearch, page],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.call<Paged<Acquisition>>("list_acquisitions", {
        p_filters: {
          ...range,
          search: debouncedSearch,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
  });

  useEffect(() => {
    if (query.data && page * pageSize < query.data.total) {
      void client.prefetchQuery({
        queryKey: ["acquisitions", range, debouncedSearch, page + 1],
        queryFn: () =>
          api.call<Paged<Acquisition>>("list_acquisitions", {
            p_filters: {
              ...range,
              search: debouncedSearch,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [query.data, page, range, debouncedSearch, client]);

  const items = query.data?.items ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Thu vào"
        description="Nhập từng xe hoặc dán nhanh danh sách nhiều xe."
        actions={
          canOperate(profile) ? (
            <div className="row">
              <Link className="button secondary" to="/intake">
                <NotebookPen size={18} /> Thu xe tốc ký
              </Link>
              <Link className="button primary" to="/acquisitions/new">
                <CirclePlus size={18} /> Thu xe mới
              </Link>
            </div>
          ) : undefined
        }
      />
      <Card>
        <div className="row filter-row">
          <label className="search-field">
            <Search size={19} aria-hidden="true" />
            <input
              aria-label="Tìm kiếm xe thu vào"
              placeholder="Tìm số khung, biển số, loại xe, người bán…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
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
      ) : !items.length ? (
        <EmptyState
          title="Chưa có dữ liệu thu xe trong khoảng thời gian này"
          description={
            debouncedSearch
              ? "Thay đổi từ khóa tìm kiếm, khoảng ngày hoặc tạo giao dịch thu xe mới."
              : "Thay đổi bộ lọc ngày hoặc tạo giao dịch thu xe mới."
          }
        />
      ) : (
        <Card className="table-card">
          {query.isFetching && !query.isPending && (
            <div
              className="table-updating-bar"
              role="progressbar"
              aria-label="Đang cập nhật danh sách"
            />
          )}
          <div
            className={`table-wrap desktop-table ${query.isFetching && !query.isPending ? "is-updating" : ""}`}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Xe</th>
                  <th>Số khung / Biển số</th>
                  <th>Ngày thu</th>
                  <th>Người bán</th>
                  {/* Giá thu do chính người thao tác xe nhập nên lịch sử thu xe
                      hiển thị cho mọi role; tổng chi phí/lợi nhuận vẫn là số nội
                      bộ của quyền tài chính. */}
                  <th className="numeric">Giá thu</th>
                  <th>Trạng thái</th>
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {items.map((acq) => (
                  <tr key={acq.id}>
                    <td>
                      <Link
                        className="text-link"
                        to={`/vehicles/${acq.vehicle_id}`}
                      >
                        <strong className="record-title">
                          <Highlight text={vehicleTypeName(acq)} query={debouncedSearch} />
                        </strong>
                      </Link>
                      {/* Dòng phụ chỉ còn Đời·Màu; mã nội bộ đã ẩn khỏi
                          thẻ danh sách (vẫn tìm xe bằng mã qua ô tìm kiếm). */}
                      {(acq.year || acq.color) && (
                        <small className="muted">
                          {[
                            acq.year ? `Đời ${acq.year}` : null,
                            acq.color || null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      )}
                    </td>
                    <td>
                      <VehicleIdentityChips vehicle={acq} query={debouncedSearch} />
                    </td>
                    <td>{dateLabel(acq.acquisition_date)}</td>
                    <td>
                      <div>{acq.seller_name ? <Highlight text={acq.seller_name} query={debouncedSearch} /> : "—"}</div>
                      <small className="muted">{acq.seller_phone ? <Highlight text={acq.seller_phone} query={debouncedSearch} /> : "—"}</small>
                    </td>
                    <td className="numeric price">
                      {acq.purchase_price != null
                        ? money(acq.purchase_price)
                        : "—"}
                    </td>
                    <td>
                      <Badge status={acq.status} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <RowViewAction
                          to={`/vehicles/${acq.vehicle_id}`}
                          label={`xe ${vehicleTitle(acq)}`}
                        />
                        {canDeleteVehicle(profile) && (
                          <RowDeleteAction
                            label={`phiếu thu xe ${vehicleTitle(acq)}`}
                            title="Xóa phiếu thu (kèm xóa xe đã thu, không hoàn tác)"
                            onClick={() => setDeleting(acq)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="mobile-cards">
            {items.map((acq) => (
              <Link
                className="mobile-record"
                key={acq.id}
                to={`/vehicles/${acq.vehicle_id}`}
              >
                <div className="row between">
                  <strong className="record-title">
                    <Highlight text={vehicleTypeName(acq)} query={debouncedSearch} />
                  </strong>
                  <Badge status={acq.status} />
                </div>
                <VehicleIdentityChips vehicle={acq} query={debouncedSearch} />
                {(acq.year || acq.color) && (
                  <span className="muted">
                    {[
                      acq.year ? `Đời ${acq.year}` : null,
                      acq.color || null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
                <div className="row between">
                  <span>{dateLabel(acq.acquisition_date)}</span>
                  {acq.purchase_price != null && (
                    <strong className="price">
                      {money(acq.purchase_price)}
                    </strong>
                  )}
                </div>
                <small className="muted">
                  Người bán: {acq.seller_name ? <Highlight text={acq.seller_name} query={debouncedSearch} /> : "—"}
                  {acq.seller_phone ? <>{" ("}<Highlight text={acq.seller_phone} query={debouncedSearch} />{")}"}</> : ""} · Nhập bởi:{" "}
                  {acq.creator_name || "—"}
                </small>
              </Link>
            ))}
          </div>
          {(query.data?.total ?? 0) > pageSize && (
            <Pagination
              page={page}
              total={query.data?.total ?? 0}
              pageSize={pageSize}
              onChange={setPage}
            />
          )}
        </Card>
      )}
      {deleting && (
        <DeleteAcquisitionDialog
          acquisition={deleting}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// Xóa cứng phiếu thu: kéo theo xóa vĩnh viễn chiếc xe đã thu (OWNER/MANAGER).
// Server chặn nếu xe từng có giao dịch bán để giữ lịch sử kế toán.
function DeleteAcquisitionDialog({
  acquisition,
  onClose,
}: {
  acquisition: Acquisition;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const remove = useMutation({
    mutationFn: () => api.deleteAcquisition(acquisition.id, reason.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["acquisitions"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Đã xóa phiếu thu và xe tương ứng khỏi kho.");
      onClose();
    },
  });
  const close = () => {
    if (!remove.isPending) onClose();
  };
  const panelRef = useDialog(true, close, remove.isPending);

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        className="dialog-panel delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-acq-title"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="delete-dialog-head">
          <span className="delete-dialog-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <div className="delete-dialog-heading">
            <h2 id="delete-acq-title">Xóa phiếu thu</h2>
            <p>
              {vehicleTitle(acquisition)}
              {acquisition.frame_number ? ` · ${acquisition.frame_number}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={remove.isPending}
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-dialog-warn">
          Xóa phiếu thu sẽ xóa vĩnh viễn chiếc xe đã thu cùng toàn bộ chi phí,
          hình ảnh và lịch sử liên quan. Không thể hoàn tác. Nếu xe đã bán, hệ
          thống sẽ chặn thao tác này.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length >= 3 && !remove.isPending) remove.mutate();
          }}
        >
          <Field
            label="Lý do xóa (ít nhất 3 ký tự) *"
            error={
              reason.length > 0 && reason.trim().length < 3
                ? "Lý do xóa cần ít nhất 3 ký tự."
                : undefined
            }
          >
            <textarea
              minLength={3}
              maxLength={1000}
              required
              disabled={remove.isPending}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Thu nhầm xe, trùng lặp phiếu, hủy thương vụ…"
              rows={2}
            />
          </Field>
          {remove.isError && <ErrorState error={remove.error} />}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={close}
              disabled={remove.isPending}
            >
              Giữ lại
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={remove.isPending || reason.trim().length < 3}
            >
              {remove.isPending ? "Đang xóa…" : "Xác nhận xóa phiếu thu"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
