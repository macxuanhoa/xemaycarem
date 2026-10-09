import { useEffect, useMemo, useState } from "react";
import {
  Link,
  useLocation,
  useNavigationType,
  useSearchParams,
} from "react-router-dom";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Bike,
  Calendar,
  ChevronDown,
  CirclePlus,
  Search,
  SlidersHorizontal,
  MoreHorizontal,
} from "lucide-react";
import { api } from "@/lib/api";
import { money, dateLabel, daysInStock } from "@/lib/format";
import { canFinance, canOperate } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  DateRange,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { RowViewAction } from "@/components/ui/RowActions";
import {
  VehicleIdentityChips,
  vehicleTypeName,
} from "@/components/ui/VehicleIdentityChips";
import type { Paged, Vehicle, VehicleStatusFilter } from "@/types";
import {
  DEFAULT_INVENTORY_STATUS,
  VEHICLE_STATUS_OPTIONS,
} from "@/lib/vehicleFilters";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { Highlight } from "@/components/search/Highlight";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import { VehicleActionsSheet } from "./VehicleActionsSheet";
import { useVehicleTypes } from "@/lib/useVehicleTypes";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";
import {
  DeleteVehicleDialog,
  RequestDeleteVehicleDialog,
} from "./VehicleDeleteDialogs";

const pageSize = 6;
const sortOptions = [
  { value: "newest", label: "Mới nhất" },
  { value: "oldest", label: "Cũ nhất" },
  { value: "longest_stock", label: "Tồn kho lâu nhất" },
];
const quickPresets: Array<{ id: string; label: string; filters: Record<string, string> }> = [
  { id: "old", label: "Tồn kho lâu > 60 ngày", filters: { sort: "longest_stock", status: "IN_STOCK", min_days: "61" } },
];
const inventoryFilterKeys = [
  "vehicle_type_id", "year", "date_from", "date_to",
  "cost_pending", "min_days", "status", "sort", "page",
];

export function InventoryPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { items: vehicleTypes } = useVehicleTypes();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const [search, setSearch] = useState(urlQ);
  const deferredSearch = useDebouncedValue(search, 250);

  function updateParams(changes: Record<string, string>, resetPage = true) {
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (resetPage) next.delete("page");
        return next;
      },
      { replace: true },
    );
  }

  // Keep search input synced when URL query param changes externally (e.g. back button)
  useEffect(() => {
    setSearch((prev) => (prev !== urlQ ? urlQ : prev));
  }, [urlQ]);

  // Sync debounced search to URL query param smoothly without blocking typing.
  // Guarded so we only navigate when the URL actually needs to change; calling
  // setParams on a value already present would fire a spurious REPLACE nav that
  // clobbers an in-flight scroll-restore on return from a vehicle detail page.
  useEffect(() => {
    if (deferredSearch === urlQ) return;
    setParams(
      (old) => {
        const currentParam = old.get("q") ?? "";
        if (deferredSearch === currentParam) return old;
        const next = new URLSearchParams(old);
        if (deferredSearch) next.set("q", deferredSearch);
        else next.delete("q");
        next.delete("page");
        return next;
      },
      { replace: true },
    );
  }, [deferredSearch, urlQ, setParams]);
  const status = (params.get("status") ?? DEFAULT_INVENTORY_STATUS) as VehicleStatusFilter;
  const setStatus = (value: VehicleStatusFilter | "") =>
    updateParams({ status: value });
  const sort = params.get("sort") ?? "newest";
  const sortLabel = sortOptions.find((option) => option.value === sort)?.label ?? sortOptions[0].label;
  const setSort = (value: string) => updateParams({ sort: value });
  const parsedPage = Number(params.get("page") ?? "1");
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  function setPage(nextPage: number) {
    updateParams({ page: nextPage > 1 ? String(nextPage) : "" }, false);
  }
  const vehicleTypeId = params.get("vehicle_type_id") ?? "";
  const year = params.get("year") ?? "";
  const date_from = params.get("date_from") ?? "";
  const date_to = params.get("date_to") ?? "";
  const cost_pending = params.get("cost_pending") ?? "";
  const min_days = params.get("min_days") ?? "";

  const filters = useMemo(
    () => ({
      vehicle_type_id: vehicleTypeId,
      year,
      date_from,
      date_to,
      cost_pending,
      min_days,
    }),
    [vehicleTypeId, year, date_from, date_to, cost_pending, min_days],
  );
  const [expanded, setExpanded] = useState(() =>
    Object.values(filters).some(Boolean),
  );
  const [rangeOpen, setRangeOpen] = useState(false);
  const [actionVehicle, setActionVehicle] = useState<Vehicle | null>(null);
  const [expenseVehicle, setExpenseVehicle] = useState<Vehicle | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Vehicle | null>(null);
  const [requestTarget, setRequestTarget] = useState<Vehicle | null>(null);
  const [message, setMessage] = useState("");
  const returnTo = `/vehicles${location.search}`;
  const scrollKey = `xe-crm-inventory-scroll:${profile?.id}:${location.search}`;
  function rememberPosition() {
    try {
      sessionStorage.setItem(scrollKey, String(window.scrollY));
    } catch {
      /* Optional storage. */
    }
  }
  function prefetch(vehicleId: string) {
    void client.prefetchQuery({
      queryKey: ["vehicle", vehicleId],
      queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: vehicleId }),
    });
  }
  const query = useQuery({
    queryKey: ["vehicles", deferredSearch, status, sort, filters, page],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: {
          ...filters,
          search: deferredSearch,
          status,
          sort,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (query.data && page * pageSize < query.data.total) {
      void client.prefetchQuery({
        queryKey: ["vehicles", deferredSearch, status, sort, filters, page + 1],
        queryFn: () =>
          api.call<Paged<Vehicle>>("list_vehicles", {
            p_filters: {
              ...filters,
              search: deferredSearch,
              status,
              sort,
              offset: page * pageSize,
              limit: pageSize,
            },
          }),
      });
    }
  }, [query.data, page, deferredSearch, status, sort, filters, client]);

  useEffect(() => {
    if (!query.isSuccess || query.isPlaceholderData) return;
    if (navigationType !== "POP" && !location.state?.restoreInventory) return;
    let top = 0;
    try {
      const stored = Number(sessionStorage.getItem(scrollKey) ?? "0");
      if (Number.isFinite(stored)) top = stored;
    } catch {
      /* Optional storage. */
      return;
    }
    if (top <= 0) return;
    // Rows finish laying out a frame or two after the query resolves; on a slow
    // run the document is still too short for the saved offset, so one scroll
    // gets clamped back to the top and the spot is lost. Keep retrying until the
    // page can actually hold the position. Bound by wall-clock (not frame count)
    // so a loaded run keeps trying without spinning indefinitely.
    let frame = 0;
    const startedAt = Date.now();
    const restore = () => {
      window.scrollTo({ top, behavior: "instant" });
      if (window.scrollY < top - 1 && Date.now() - startedAt < 2000) {
        frame = requestAnimationFrame(restore);
      }
    };
    frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [
    query.isSuccess,
    query.isPlaceholderData,
    scrollKey,
    navigationType,
    location.state,
  ]);
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(scrollKey, String(window.scrollY));
      } catch {
        /* Optional storage. */
      }
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => window.removeEventListener("scroll", save);
  }, [scrollKey]);
  function filter(key: keyof typeof filters, value: string) {
    updateParams({ [key]: value });
  }
  function applyPreset(preset: (typeof quickPresets)[number], isActive: boolean) {
    updateParams({
      ...Object.fromEntries(inventoryFilterKeys.map((key) => [key, ""])),
      ...(isActive ? {} : preset.filters),
    });
  }
  const vehicles = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const dateRangeSummary =
    filters.date_from && filters.date_to
      ? `${dateLabel(filters.date_from)} – ${dateLabel(filters.date_to)}`
      : filters.date_from
        ? `Từ ${dateLabel(filters.date_from)}`
        : filters.date_to
          ? `Đến ${dateLabel(filters.date_to)}`
          : "Chọn khoảng ngày";
  return (
    <div className="stack">
      <PageHeader
        title="Tồn kho"
        description="Theo dõi từng chiếc xe, từ lúc thu vào đến khi bán ra."
        actions={
          canOperate(profile) ? (
            <Link
              className="button primary"
              to="/acquisitions/new"
              aria-label="Thu xe mới"
            >
              <CirclePlus size={18} />
              <span className="cta-label-full">Thu xe mới</span>
              <span className="cta-label-short">Thu xe</span>
            </Link>
          ) : undefined
        }
      />
      <Card className="inventory-toolbar">
        <div className="row filter-row">
          <label className="search-field">
            <Search size={19} />
            <input
              aria-label="Tìm kiếm xe"
              placeholder="Tìm mã xe, biển số, loại xe, số khung, SĐT khách…"
              type="search"
              enterKeyHint="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            <SlidersHorizontal size={17} /> Bộ lọc <ChevronDown size={15} />
          </Button>
          <select
            aria-label="Sắp xếp xe"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
            }}
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {/* Quick Presets — high-value operational shortcuts only */}
        <div className="quick-presets" aria-label="Lọc nhanh">
          <span className="quick-presets-label">Lọc nhanh</span>
          {quickPresets.map((preset) => {
            const isActive = Object.entries(preset.filters).every(
              ([key, value]) => params.get(key) === value,
            );
            return (
              <button
                key={preset.id}
                type="button"
                className={isActive ? "quick-pill quick-pill-active" : "quick-pill"}
                aria-pressed={isActive}
                onClick={() => {
                  if (isActive) {
                    applyPreset(preset, true);
                  } else {
                    applyPreset(preset, false);
                  }
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        {expanded && (
          <>
            <div className="form-grid filter-grid">
              <Field label="Loại xe">
                <select
                  aria-label="Lọc theo loại xe"
                  value={filters.vehicle_type_id}
                  onChange={(e) => filter("vehicle_type_id", e.target.value)}
                >
                  <option value="">Tất cả loại xe</option>
                  {vehicleTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Năm sản xuất">
                <input
                  type="number"
                  min="1950"
                  max={new Date().getFullYear() + 1}
                  value={filters.year}
                  onChange={(e) => filter("year", e.target.value)}
                />
              </Field>
              <div className="field filter-field-full">
                <label htmlFor="filter-date-range-trigger">Ngày nhập kho</label>
                <button
                  type="button"
                  id="filter-date-range-trigger"
                  className="date-range-trigger"
                  aria-expanded={rangeOpen}
                  onClick={() => setRangeOpen((open) => !open)}
                >
                  <Calendar size={15} />
                  <span className="date-range-trigger-text">
                    {dateRangeSummary}
                  </span>
                  <ChevronDown
                    size={15}
                    className={
                      rangeOpen ? "date-range-chevron open" : "date-range-chevron"
                    }
                  />
                </button>
                {rangeOpen && (
                  <div className="date-range-panel">
                    <DateRange
                      value={{ from: filters.date_from, to: filters.date_to }}
                      onChange={({ from, to }) => {
                        updateParams({ date_from: from, date_to: to });
                        if (from && to) setRangeOpen(false);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="form-actions filter-actions">
              <Button
                variant="ghost"
                onClick={() => {
                  setRangeOpen(false);
                  updateParams({
                    vehicle_type_id: "",
                    year: "",
                    date_from: "",
                    date_to: "",
                    cost_pending: "",
                    min_days: "",
                    q: "",
                    status: "",
                    page: "",
                  });
                }}
              >
                Xóa bộ lọc
              </Button>
            </div>
          </>
        )}
        <div className="tabs" aria-label="Trạng thái xe">
          {VEHICLE_STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={status === option.value ? "tab active" : "tab"}
              aria-pressed={status === option.value}
              title={option.hint}
              onClick={() => {
                setStatus(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Card>
      {filters.min_days && !quickPresets.some((preset) => preset.id === "old" && Object.entries(preset.filters).every(([key, value]) => params.get(key) === value)) && (
        <p className="notice">
          Đang xem xe tồn kho từ {filters.min_days} ngày.{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => filter("min_days", "")}
          >
            Bỏ lọc tuổi tồn kho
          </button>
        </p>
      )}
      {filters.cost_pending === "true" && !quickPresets.some((preset) => preset.id === "cost_pending" && Object.entries(preset.filters).every(([key, value]) => params.get(key) === value)) && (
        <p className="notice">
          Đang xem xe chưa có giá mua.{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => filter("cost_pending", "")}
          >
            Bỏ lọc chờ giá mua
          </button>
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : vehicles.length === 0 ? (
        <Card>
          <EmptyState
            title="Chưa có xe phù hợp"
            description="Thử thay đổi bộ lọc hoặc thu chiếc xe đầu tiên vào kho."
          />
          {canOperate(profile) && (
            <Link className="button primary" to="/acquisitions/new">
              + Thu xe mới
            </Link>
          )}
        </Card>
      ) : (
        <Card className="table-card">
          {query.isFetching && !query.isPending && (
            <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
          )}
          {/* Kết quả tìm kiếm nằm trong thẻ danh sách để thẳng hàng với các
              dòng xe và vạch phân cách ở footer, thay vì lơ lửng giữa hai thẻ. */}
          <div className="table-list-head">
            <p className="result-count" role="status" aria-live="polite">
              Tìm thấy <strong>{total}</strong> xe
              {deferredSearch && (
                <span className="result-count-qual">
                  với từ khóa “{deferredSearch}”
                </span>
              )}
            </p>
            <span className="table-list-sort">Sắp xếp: {sortLabel}</span>
          </div>
          <div className={`table-wrap desktop-table ${query.isFetching && !query.isPending ? "is-updating" : ""}`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Xe</th>
                  <th>Loại xe</th>
                  <th>Trạng thái</th>
                  <th>Ngày thu</th>
                  {canFinance(profile) && (
                    <th className="numeric">Giá vốn</th>
                  )}
                  <th />
                </tr>
              </thead>
              <tbody>
                {vehicles.map((vehicle) => (
                  <tr key={vehicle.id}>
                    <td>
                      <Link
                        className="vehicle-cell"
                        to={`/vehicles/${vehicle.id}`}
                        state={{ fromInventory: returnTo }}
                        onClick={rememberPosition}
                        onMouseEnter={() => prefetch(vehicle.id)}
                        onFocus={() => prefetch(vehicle.id)}
                      >
                        <span className="vehicle-icon">
                          <Bike size={24} />
                        </span>
                        {/* Danh tính ưu tiên: biển số + số khung nổi bật thành
                            chip (navy/mint), tên loại xe·đời·màu là dòng phụ. */}
                        <span>
                          <VehicleIdentityChips
                            vehicle={vehicle}
                            query={deferredSearch}
                          />
                          {vehicleSubtitle(vehicle) && (
                            <small>
                              <Highlight
                                text={vehicleSubtitle(vehicle)}
                                query={deferredSearch}
                              />
                            </small>
                          )}
                          <small className="vehicle-code"><Highlight text={vehicle.internal_code} query={deferredSearch} /></small>
                        </span>
                      </Link>
                    </td>
                    <td>{vehicle.vehicle_type || "Chưa phân loại"}</td>
                    <td>
                      <Badge status={vehicle.status} />
                    </td>
                    <td>
                      {dateLabel(vehicle.purchase_date)}
                      {["IN_STOCK", "RESERVED"].includes(vehicle.status) && (
                        <small>
                          {(vehicle.days_in_inventory ?? daysInStock(vehicle.purchase_date)) === 0
                            ? "Hôm nay"
                            : `${vehicle.days_in_inventory ?? daysInStock(vehicle.purchase_date)} ngày`}
                        </small>
                      )}
                    </td>
                    {canFinance(profile) && (
                      <td className="numeric">
                        {vehicle.cost_pending ? (
                          <span className="muted">Chờ giá nhập</span>
                        ) : (
                          money(vehicle.total_cost)
                        )}
                      </td>
                    )}
                    <td>
                      <RowViewAction
                        to={`/vehicles/${vehicle.id}`}
                        state={{ fromInventory: returnTo }}
                        onClick={rememberPosition}
                        label={`xe ${vehicleTitle(vehicle)}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-cards">
            {vehicles.map((vehicle) => (
              <article className="mobile-record inventory-record" key={vehicle.id}>
                <Link
                  className="vehicle-record-link"
                  to={`/vehicles/${vehicle.id}`}
                  state={{ fromInventory: returnTo }}
                  onClick={rememberPosition}
                  onPointerDown={() => prefetch(vehicle.id)}
                >
                  <div className="row between">
                    <strong className="record-title">
                      <Highlight text={vehicleTypeName(vehicle)} query={deferredSearch} />
                    </strong>
                    <Badge status={vehicle.status} />
                  </div>
                  {/* Ưu tiên thị giác: biển số & số khung dựng thành chip
                      nền màu nổi bật nhưng vẫn nhẹ nhàng, đúng như trang chi tiết. */}
                  <VehicleIdentityChips vehicle={vehicle} query={deferredSearch} />
                  <div className="record-details muted">
                    <span>Mã xe: <Highlight text={vehicle.internal_code} query={deferredSearch} /></span>
                    <span>Đời xe: {vehicle.year ?? "—"}</span>
                    <span>Màu sắc: {vehicle.color ? <Highlight text={vehicle.color} query={deferredSearch} /> : "—"}</span>
                  </div>
                  <div className="row between">
                    <span className="record-date">
                      {dateLabel(vehicle.purchase_date)}
                      {["IN_STOCK", "RESERVED"].includes(vehicle.status) && (
                        <small className="record-age">
                          {(vehicle.days_in_inventory ?? daysInStock(vehicle.purchase_date)) === 0
                            ? "Hôm nay"
                            : `${vehicle.days_in_inventory ?? daysInStock(vehicle.purchase_date)} ngày`}
                        </small>
                      )}
                    </span>
                  </div>
                  {canFinance(profile) && (
                    <small className="record-cost">
                      Giá vốn:{" "}
                      {vehicle.cost_pending
                        ? "Chờ giá nhập"
                        : money(vehicle.total_cost)}
                    </small>
                  )}
                </Link>
                <div className="record-actions">
                  <button
                    type="button"
                    className="record-more-btn"
                    aria-label={`Thao tác với ${vehicleTitle(vehicle)}`}
                    onClick={() => {
                      rememberPosition();
                      setActionVehicle(vehicle);
                    }}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                </div>
              </article>
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
      {actionVehicle && (
        <VehicleActionsSheet
          vehicle={actionVehicle}
          returnTo={returnTo}
          onClose={() => setActionVehicle(null)}
          onExpense={() => {
            setExpenseVehicle(actionVehicle);
            setActionVehicle(null);
          }}
          onDelete={() => {
            setDeleteTarget(actionVehicle);
            setActionVehicle(null);
          }}
          onRequestDelete={() => {
            setRequestTarget(actionVehicle);
            setActionVehicle(null);
          }}
        />
      )}
      {deleteTarget && (
        <DeleteVehicleDialog
          vehicle={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => setDeleteTarget(null)}
        />
      )}
      {requestTarget && (
        <RequestDeleteVehicleDialog
          vehicle={requestTarget}
          onClose={() => setRequestTarget(null)}
          onRequested={() => setRequestTarget(null)}
        />
      )}
      {expenseVehicle && (
        <QuickExpenseModal
          vehicleId={expenseVehicle.id}
          vehicleName={vehicleTitle(expenseVehicle)}
          vehicleCode={expenseVehicle.internal_code}
          isOpen
          onClose={() => setExpenseVehicle(null)}
          onSuccess={() => setMessage("Đã lưu chi phí cho xe.")}
        />
      )}
    </div>
  );
}

export default InventoryPage;
