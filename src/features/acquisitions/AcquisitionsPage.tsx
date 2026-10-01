import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CirclePlus, Search } from "lucide-react";
import { api } from "@/lib/api";
import { canFinance, canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
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
import type { Acquisition, Paged } from "@/types";

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
  const [search, setSearch] = useState(() => params.get("search") || params.get("q") || "");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);

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
        description="Danh sách xe đã thu mua, từ lúc nhận xe đến khi nhập kho."
        actions={
          canOperate(profile) ? (
            <Link className="button primary" to="/acquisitions/new">
              <CirclePlus size={18} /> Thu xe mới
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="row filter-row">
          <label className="search-field">
            <Search size={19} aria-hidden="true" />
            <input
              aria-label="Tìm kiếm xe thu vào"
              placeholder="Tìm số khung, biển số, hãng, dòng xe, người bán…"
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
            <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
          )}
          <div className={`table-wrap desktop-table ${query.isFetching && !query.isPending ? "is-updating" : ""}`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Xe</th>
                  <th>Số khung / Biển số</th>
                  <th>Ngày thu</th>
                  <th>Người bán</th>
                  {canFinance(profile) && <th className="numeric">Giá thu</th>}
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
                        <strong>
                          {acq.brand} {acq.model}
                        </strong>
                      </Link>
                      <small className="muted">{acq.internal_code || "—"}</small>
                    </td>
                    <td>
                      <div className="table-meta-row">
                        <span className="table-sublabel">Khung:</span>
                        <code>{acq.frame_number}</code>
                      </div>
                      <small className="table-meta-row">
                        <span className="table-sublabel">BS:</span>
                        <span>{acq.license_plate || "Chưa có biển số"}</span>
                      </small>
                    </td>
                    <td>{dateLabel(acq.acquisition_date)}</td>
                    <td>
                      <div>{acq.seller_name || "—"}</div>
                      <small className="muted">{acq.seller_phone || "—"}</small>
                    </td>
                    {canFinance(profile) && (
                      <td className="numeric price">
                        {acq.purchase_price != null
                          ? money(acq.purchase_price)
                          : "—"}
                      </td>
                    )}
                    <td>
                      <Badge status={acq.status} />
                    </td>
                    <td>
                      <Link
                        className="icon-button"
                        aria-label={`Xem chi tiết xe ${acq.brand} ${acq.model}`}
                        title={`Xem chi tiết xe ${acq.brand} ${acq.model}`}
                        to={`/vehicles/${acq.vehicle_id}`}
                      >
                        <ArrowRight size={18} />
                      </Link>
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
                  <strong>
                    {acq.brand} {acq.model}
                  </strong>
                  <Badge status={acq.status} />
                </div>
                <div className="mobile-meta-subline">
                  <span className="table-sublabel">Khung:</span>
                  <code className="mobile-code">{acq.frame_number}</code>
                  <span className="bullet-sep" aria-hidden="true">·</span>
                  <span className="table-sublabel">BS:</span>
                  <span>{acq.license_plate || "Chưa có biển số"}</span>
                </div>
                <div className="row between">
                  <span>{dateLabel(acq.acquisition_date)}</span>
                  {canFinance(profile) && acq.purchase_price != null && (
                    <strong className="price">
                      {money(acq.purchase_price)}
                    </strong>
                  )}
                </div>
                <small className="muted">
                  Người bán: {acq.seller_name || "—"}
                  {acq.seller_phone ? ` (${acq.seller_phone})` : ""} · Nhập bởi:{" "}
                  {acq.creator_name || "—"}
                </small>
              </Link>
            ))}
          </div>
          <Pagination
            page={page}
            total={query.data?.total ?? 0}
            pageSize={pageSize}
            onChange={setPage}
          />
        </Card>
      )}
    </div>
  );
}
