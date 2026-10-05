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
  DatePicker,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { RowViewAction } from "@/components/ui/RowActions";
import type { Paged, Vehicle, VehicleStatusFilter } from "@/types";
import {
  VEHICLE_STATUS_OPTIONS,
} from "@/lib/vehicleFilters";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import { VehicleActionsSheet } from "./VehicleActionsSheet";

const pageSize = 6;
const quickPresets: Array<{ id: string; label: string; filters: Record<string, string> }> = [
  { id: "old", label: "Tồn kho lâu > 60 ngày", filters: { sort: "longest_stock", status: "IN_STOCK", min_days: "61" } },
  { id: "cost_pending", label: "Chờ giá nhập", filters: { cost_pending: "true" } },
];
const inventoryFilterKeys = [
  "brand", "year", "min_price", "max_price", "date_from", "date_to",
  "cost_pending", "min_days", "status", "sort", "page",
];

export function InventoryPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
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
  function setSearch(value: string) {
    updateParams({ q: value });
  }
  const deferredSearch = useDebouncedValue(search);
  const status = (params.get("status") ?? "") as VehicleStatusFilter | "";
  const setStatus = (value: VehicleStatusFilter | "") =>
    updateParams({ status: value });
  const sort = params.get("sort") ?? "newest";
  const setSort = (value: string) => updateParams({ sort: value });
  const parsedPage = Number(params.get("page") ?? "1");
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  function setPage(nextPage: number) {
    updateParams({ page: nextPage > 1 ? String(nextPage) : "" }, false);
  }
  const filters = useMemo(
    () => ({
      brand: params.get("brand") ?? "",
      year: params.get("year") ?? "",
      min_price: params.get("min_price") ?? "",
      max_price: params.get("max_price") ?? "",
      date_from: params.get("date_from") ?? "",
      date_to: params.get("date_to") ?? "",
      cost_pending: params.get("cost_pending") ?? "",
      min_days: params.get("min_days") ?? "",
    }),
    [params],
  );
  const [expanded, setExpanded] = useState(() =>
    Object.values(filters).some(Boolean),
  );
  const [actionVehicle, setActionVehicle] = useState<Vehicle | null>(null);
  const [expenseVehicle, setExpenseVehicle] = useState<Vehicle | null>(null);
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
    let frame: number;
    try {
      const top = Number(sessionStorage.getItem(scrollKey) ?? "0");
      if (Number.isFinite(top))
        frame = requestAnimationFrame(() =>
          window.scrollTo({ top, behavior: "instant" }),
        );
    } catch {
      /* Optional storage. */
    }
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
              placeholder="Tìm mã xe, biển số, hãng, số khung, SĐT khách…"
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
            <option value="newest">Mới nhất</option>
            <option value="oldest">Cũ nhất</option>
            <option value="longest_stock">Tồn kho lâu nhất</option>
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
          <div className="form-grid filter-grid">
            <Field label="Hãng xe">
              <input
                placeholder="Honda, Yamaha…"
                value={filters.brand}
                onChange={(e) => filter("brand", e.target.value)}
              />
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
            <Field label="Giá bán dự kiến từ (₫)">
              <input
                type="number"
                min="0"
                step="1"
                value={filters.min_price}
                onChange={(e) => filter("min_price", e.target.value)}
              />
            </Field>
            <Field label="Giá bán dự kiến đến (₫)">
              <input
                type="number"
                min="0"
                step="1"
                value={filters.max_price}
                onChange={(e) => filter("max_price", e.target.value)}
              />
            </Field>
            <Field label="Nhập kho từ ngày">
              <DatePicker
                aria-label="Nhập kho từ ngày"
                value={filters.date_from}
                onChange={(value) => {
                  let nextFrom = value;
                  let nextTo = filters.date_to;
                  if (nextFrom && nextTo && nextFrom > nextTo) {
                    [nextFrom, nextTo] = [nextTo, nextFrom];
                    filter("date_to", nextTo);
                  }
                  filter("date_from", nextFrom);
                }}
              />
            </Field>
            <Field label="Nhập kho đến ngày">
              <DatePicker
                aria-label="Nhập kho đến ngày"
                value={filters.date_to}
                onChange={(value) => {
                  let nextTo = value;
                  let nextFrom = filters.date_from;
                  if (nextFrom && nextTo && nextFrom > nextTo) {
                    [nextFrom, nextTo] = [nextTo, nextFrom];
                    filter("date_from", nextFrom);
                  }
                  filter("date_to", nextTo);
                }}
              />
            </Field>
            <Button
              variant="ghost"
              onClick={() => {
                updateParams({
                  brand: "",
                  year: "",
                  min_price: "",
                  max_price: "",
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
        <>
          <Card className="table-card">
            {query.isFetching && !query.isPending && (
              <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
            )}
            <div className={`table-wrap desktop-table ${query.isFetching && !query.isPending ? "is-updating" : ""}`}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Xe</th>
                    <th>Số khung</th>
                    <th>Biển số</th>
                    <th>Trạng thái</th>
                    <th>Ngày thu</th>
                    {canFinance(profile) && (
                      <th className="numeric">Giá vốn</th>
                    )}
                    <th className="numeric">Giá bán dự kiến</th>
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
                          <span>
                            <strong>
                              {vehicle.brand} {vehicle.model}
                            </strong>
                            {[vehicle.year, vehicle.color, vehicle.variant]
                              .filter(Boolean)
                              .length > 0 && (
                              <small>
                                {[vehicle.year, vehicle.color, vehicle.variant]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                            )}
                            <small className="vehicle-code">{vehicle.internal_code}</small>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <strong className="frame-number">
                          {vehicle.frame_number || "—"}
                        </strong>
                      </td>
                      <td>
                        {vehicle.license_plate || "—"}
                      </td>
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
                      <td className="numeric price">
                        {money(vehicle.asking_price)}
                      </td>
                      <td>
                        <RowViewAction
                          to={`/vehicles/${vehicle.id}`}
                          state={{ fromInventory: returnTo }}
                          onClick={rememberPosition}
                          label={`xe ${vehicle.brand} ${vehicle.model}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-cards">
              {vehicles.map((vehicle) => (
                <article className="mobile-record" key={vehicle.id}>
                  <Link
                    className="vehicle-record-link"
                    to={`/vehicles/${vehicle.id}`}
                    state={{ fromInventory: returnTo }}
                    onClick={rememberPosition}
                    onPointerDown={() => prefetch(vehicle.id)}
                  >
                    <div className="row between">
                      <strong>
                        {vehicle.brand} {vehicle.model}
                      </strong>
                      <Badge status={vehicle.status} />
                    </div>
                    {[vehicle.year, vehicle.color, vehicle.variant].filter(Boolean).length > 0 && (
                      <span className="muted">
                        {[vehicle.year, vehicle.color, vehicle.variant]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                    <div className="record-details muted">
                      <span>Mã xe: {vehicle.internal_code}</span>
                      <span>Số khung: {vehicle.frame_number || "—"}</span>
                      <span>Biển số: {vehicle.license_plate || "—"}</span>
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
                      <strong className="price">
                        {money(vehicle.asking_price)}
                      </strong>
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
                      className="button secondary"
                      aria-label={`Thao tác với ${vehicle.brand} ${vehicle.model}`}
                      onClick={() => {
                        rememberPosition();
                        setActionVehicle(vehicle);
                      }}
                    >
                      <MoreHorizontal size={18} /> Thao tác
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
        </>
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
        />
      )}
      {expenseVehicle && (
        <QuickExpenseModal
          vehicleId={expenseVehicle.id}
          vehicleName={`${expenseVehicle.brand} ${expenseVehicle.model}`}
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
