import { useEffect, useState } from "react";
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
  ArrowRight,
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
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import type { Paged, Vehicle } from "@/types";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import { VehicleActionsSheet } from "./VehicleActionsSheet";

const pageSize = 20;
const statusOptions = [
  { value: "", label: "Tất cả xe" },
  { value: "IN_STOCK", label: "Đang tồn kho" },
  { value: "RESERVED", label: "Giữ chỗ" },
  { value: "SOLD", label: "Đã bán" },
  { value: "CANCELLED", label: "Đã hủy" },
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
  const status = params.get("status") ?? "";
  const setStatus = (value: string) => updateParams({ status: value });
  const sort = params.get("sort") ?? "newest";
  const setSort = (value: string) => updateParams({ sort: value });
  const parsedPage = Number(params.get("page") ?? "1");
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  function setPage(nextPage: number) {
    updateParams({ page: nextPage > 1 ? String(nextPage) : "" }, false);
  }
  const filters = {
    brand: params.get("brand") ?? "",
    year: params.get("year") ?? "",
    min_price: params.get("min_price") ?? "",
    max_price: params.get("max_price") ?? "",
    date_from: params.get("date_from") ?? "",
    date_to: params.get("date_to") ?? "",
    cost_pending: params.get("cost_pending") ?? "",
    min_days: params.get("min_days") ?? "",
  };
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
  const vehicles = query.data?.items ?? [];
  return (
    <div className="stack">
      <PageHeader
        title="Tồn kho"
        description="Theo dõi từng chiếc xe, từ lúc thu vào đến khi bán ra."
        actions={
          canOperate(profile) ? (
            <Link className="button primary" to="/acquisitions/new">
              <CirclePlus size={18} /> Thu xe mới
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
            <option value="newest">Mới nhập trước</option>
            <option value="oldest">Cũ nhất trước</option>
            <option value="longest_stock">Tồn kho lâu nhất</option>
            <option value="highest_price">Giá niêm yết cao nhất</option>
            {canFinance(profile) && (
              <option value="highest_cost">Giá vốn cao nhất</option>
            )}
          </select>
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
            <Field label="Giá niêm yết từ (₫)">
              <input
                type="number"
                min="0"
                step="1"
                value={filters.min_price}
                onChange={(e) => filter("min_price", e.target.value)}
              />
            </Field>
            <Field label="Giá niêm yết đến (₫)">
              <input
                type="number"
                min="0"
                step="1"
                value={filters.max_price}
                onChange={(e) => filter("max_price", e.target.value)}
              />
            </Field>
            <Field label="Nhập kho từ ngày">
              <input
                type="date"
                value={filters.date_from}
                onChange={(e) => filter("date_from", e.target.value)}
              />
            </Field>
            <Field label="Nhập kho đến ngày">
              <input
                type="date"
                min={filters.date_from}
                value={filters.date_to}
                onChange={(e) => filter("date_to", e.target.value)}
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
                });
              }}
            >
              Xóa bộ lọc
            </Button>
          </div>
        )}
        <div className="tabs" aria-label="Trạng thái xe">
          {statusOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={status === option.value ? "tab active" : "tab"}
              aria-pressed={status === option.value}
              onClick={() => {
                setStatus(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Card>
      {filters.min_days && (
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
      {filters.cost_pending === "true" && (
        <p className="notice">
          Đang xem xe chờ bổ sung giá thu.{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => filter("cost_pending", "")}
          >
            Bỏ lọc giá thu
          </button>
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {query.isFetching && !query.isPending && (
        <p className="muted small" role="status">
          Đang cập nhật danh sách…
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
            <div className="table-wrap desktop-table">
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
                    <th className="numeric">Giá niêm yết</th>
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
                            <small>
                              {[vehicle.variant, vehicle.year, vehicle.color]
                                .filter(Boolean)
                                .join(" · ") || "Chưa bổ sung phiên bản"}
                            </small>
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
                        <small>{vehicle.internal_code}</small>
                      </td>
                      <td>
                        <Badge status={vehicle.status} />
                      </td>
                      <td>
                        {dateLabel(vehicle.purchase_date)}
                        {["IN_STOCK", "RESERVED"].includes(vehicle.status) && (
                          <small>
                            {vehicle.days_in_inventory ??
                              daysInStock(vehicle.purchase_date)}{" "}
                            ngày
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
                        <Link
                          className="icon-button"
                          to={`/vehicles/${vehicle.id}`}
                          state={{ fromInventory: returnTo }}
                          onClick={rememberPosition}
                          aria-label={`Xem ${vehicle.internal_code}`}
                        >
                          <ArrowRight size={18} />
                        </Link>
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
                    <span className="muted">
                      {vehicle.frame_number || vehicle.internal_code}
                    </span>
                    <span className="muted">
                      {vehicle.license_plate || "Chưa có biển số"} ·{" "}
                      {vehicle.year || ""}
                    </span>
                    <div className="row between">
                      <span>
                        {["IN_STOCK", "RESERVED"].includes(vehicle.status)
                          ? `${daysInStock(vehicle.purchase_date)} ngày trong kho`
                          : dateLabel(vehicle.purchase_date)}
                      </span>
                      <strong className="price">
                        {money(vehicle.asking_price)}
                      </strong>
                    </div>
                    {canFinance(profile) && (
                      <small>
                        Giá vốn:{" "}
                        {vehicle.cost_pending
                          ? "Chờ giá nhập"
                          : money(vehicle.total_cost)}
                      </small>
                    )}
                  </Link>
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
