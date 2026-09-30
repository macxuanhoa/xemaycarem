import { useDeferredValue, useState, type ChangeEvent } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  Camera,
  ChevronDown,
  CirclePlus,
  Pencil,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { money, dateLabel, today, daysInStock } from "@/lib/format";
import { canFinance, canManage, canOperate } from "@/lib/permissions";
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
import type { Paged, Vehicle, Sale, Expense } from "@/types";
import {
  actionLabels,
  vehicleExpenseLabels,
  vehicleSchema,
  type VehicleFormValues,
} from "./vehicleSchema";

type VehicleImage = { id: string; storage_path: string; display_order: number };
type Activity = {
  id: string;
  action: string;
  actor_name?: string;
  created_at: string;
};
type VehicleDetail = Vehicle & {
  images?: VehicleImage[];
  expenses?: Expense[];
  sales?: Sale[];
  activity?: Activity[];
  cost_pending?: boolean;
};
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
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  function setSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  }
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState({
    brand: "",
    year: "",
    min_price: "",
    max_price: "",
    date_from: "",
    date_to: "",
  });
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
  });
  function filter(key: keyof typeof filters, value: string) {
    setFilters((old) => ({ ...old, [key]: value }));
    setPage(1);
  }
  const vehicles = query.data?.items ?? [];
  return (
    <div className="stack">
      <PageHeader
        title="Kho xe"
        description="Theo dõi từng chiếc xe, từ lúc nhập kho đến khi bàn giao."
        actions={
          canOperate(profile) ? (
            <Link className="button primary" to="/vehicles/new">
              <CirclePlus size={18} /> Nhập xe mới
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
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
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
              setPage(1);
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
                setFilters({
                  brand: "",
                  year: "",
                  min_price: "",
                  max_price: "",
                  date_from: "",
                  date_to: "",
                });
                setSearch("");
                setStatus("");
                setPage(1);
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
                setPage(1);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Card>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : vehicles.length === 0 ? (
        <EmptyState
          title="Chưa có xe phù hợp"
          description="Thử thay đổi bộ lọc hoặc nhập chiếc xe đầu tiên vào kho."
        />
      ) : (
        <>
          <Card className="table-card">
            <div className="table-wrap desktop-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Thông tin xe</th>
                    <th>Biển số / Mã xe</th>
                    <th>Trạng thái</th>
                    <th>Ngày nhập</th>
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
                        <strong>
                          {vehicle.license_plate || "Chưa có biển số"}
                        </strong>
                        <small>{vehicle.internal_code}</small>
                      </td>
                      <td>
                        <Badge status={vehicle.status} />
                      </td>
                      <td>
                        {dateLabel(vehicle.purchase_date)}
                        {["IN_STOCK", "RESERVED"].includes(vehicle.status) && (
                          <small>
                            {daysInStock(vehicle.purchase_date)} ngày trong kho
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
                <Link
                  className="mobile-record"
                  key={vehicle.id}
                  to={`/vehicles/${vehicle.id}`}
                >
                  <div className="row between">
                    <strong>
                      {vehicle.brand} {vehicle.model}
                    </strong>
                    <Badge status={vehicle.status} />
                  </div>
                  <span className="muted">
                    {vehicle.license_plate || vehicle.internal_code} ·{" "}
                    {vehicle.year || "Chưa có năm SX"}
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
    </div>
  );
}

export function VehicleFormPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const query = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<VehicleDetail>("get_vehicle", { p_id: id }),
    enabled: !!id,
  });
  if (!canOperate(profile))
    return <EmptyState title="Bạn không có quyền thay đổi thông tin xe." />;
  if (id && query.isPending) return <Loading />;
  if (id && query.isError)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );
  if (query.data?.status === "SOLD")
    return (
      <div className="stack">
        <EmptyState
          title="Xe đã bán"
          description="Thông tin giá vốn và giao dịch được giữ nguyên để bảo toàn lịch sử."
        />
        <Link className="button secondary" to={`/vehicles/${id}`}>
          Về chi tiết xe
        </Link>
      </div>
    );
  return <VehicleEditor key={id ?? "new"} vehicle={query.data} />;
}

function VehicleEditor({ vehicle }: { vehicle?: VehicleDetail }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const financial = canFinance(profile);
  const [files, setFiles] = useState<File[]>([]);
  const [savedId, setSavedId] = useState<string>();
  const [uploadError, setUploadError] = useState("");
  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: {
      brand: vehicle?.brand ?? "",
      model: vehicle?.model ?? "",
      variant: vehicle?.variant ?? "",
      license_plate: vehicle?.license_plate ?? "",
      year: vehicle?.year ?? undefined,
      color: vehicle?.color ?? "",
      frame_number: vehicle?.frame_number ?? "",
      engine_number: vehicle?.engine_number ?? "",
      odometer: vehicle?.odometer ?? 0,
      purchase_date: vehicle?.purchase_date ?? today(),
      purchase_price: vehicle?.purchase_price ?? undefined,
      asking_price: vehicle?.asking_price ?? 0,
      supplier_name: vehicle?.supplier_name ?? "",
      supplier_phone: vehicle?.supplier_phone ?? "",
      status:
        vehicle?.status === "RESERVED"
          ? "RESERVED"
          : vehicle?.status === "CANCELLED"
            ? "CANCELLED"
            : "IN_STOCK",
      notes: vehicle?.notes ?? "",
    },
  });
  const mutation = useMutation({
    mutationFn: async (values: VehicleFormValues) => {
      if (financial && values.purchase_price === undefined)
        throw new AppError("Vui lòng nhập giá mua xe.");
      const data: Record<string, unknown> = {
        ...values,
        year: values.year ?? null,
      };
      if (!financial) delete data.purchase_price;
      const resultId =
        savedId ??
        (await api.call<string>("save_vehicle", {
          p_data: data,
          ...(vehicle ? { p_id: vehicle.id } : {}),
        }));
      setSavedId(resultId);
      await client.invalidateQueries();
      if (files.length) {
        const remaining = [...files];
        try {
          for (const file of files) {
            await api.uploadVehicleImage(resultId, file);
            remaining.shift();
            setFiles([...remaining]);
          }
        } catch (error) {
          console.error("Vehicle image upload failed", error);
          setUploadError(
            "Thông tin xe đã được lưu. Một số ảnh chưa tải lên; bạn có thể thử tải lại hoặc mở chi tiết xe.",
          );
          return;
        }
      }
      await client.invalidateQueries();
      navigate(`/vehicles/${resultId}`);
    },
  });
  const error = (key: keyof VehicleFormValues) =>
    form.formState.errors[key]?.message;
  return (
    <div className="stack">
      <Link
        className="back-link"
        to={vehicle ? `/vehicles/${vehicle.id}` : "/vehicles"}
      >
        <ArrowLeft size={16} /> {vehicle ? "Chi tiết xe" : "Kho xe"}
      </Link>
      <PageHeader
        title={vehicle ? "Chỉnh sửa thông tin xe" : "Nhập xe mới"}
        description={
          vehicle
            ? vehicle.internal_code
            : "Lưu thông tin xe để bắt đầu theo dõi nhập, chi phí và bán hàng."
        }
      />
      <form
        className="stack"
        onSubmit={form.handleSubmit((values) => {
          setUploadError("");
          mutation.mutate(values);
        })}
      >
        <fieldset
          disabled={mutation.isPending || !!savedId}
          className="plain-fieldset stack"
        >
          <Card>
            <h2 className="section-title">Thông tin xe</h2>
            <div className="form-grid">
              <Field label="Hãng xe *" error={error("brand")}>
                <input {...form.register("brand")} placeholder="Ví dụ: Honda" />
              </Field>
              <Field label="Dòng xe *" error={error("model")}>
                <input
                  {...form.register("model")}
                  placeholder="Ví dụ: SH 160i"
                />
              </Field>
              <Field label="Phiên bản" error={error("variant")}>
                <input
                  {...form.register("variant")}
                  placeholder="ABS, Cao cấp…"
                />
              </Field>
              <Field label="Biển số" error={error("license_plate")}>
                <input
                  {...form.register("license_plate")}
                  placeholder="59-A1 123.45"
                />
              </Field>
              <Field label="Năm sản xuất" error={error("year")}>
                <input
                  type="number"
                  inputMode="numeric"
                  {...form.register("year", {
                    setValueAs: (value) =>
                      value === "" ? undefined : Number(value),
                  })}
                />
              </Field>
              <Field label="Màu sắc" error={error("color")}>
                <input {...form.register("color")} />
              </Field>
              <Field label="Số khung" error={error("frame_number")}>
                <input {...form.register("frame_number")} />
              </Field>
              <Field label="Số máy" error={error("engine_number")}>
                <input {...form.register("engine_number")} />
              </Field>
              <Field label="Số km đã đi" error={error("odometer")}>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  {...form.register("odometer", { valueAsNumber: true })}
                />
              </Field>
              <Field label="Trạng thái">
                <select {...form.register("status")}>
                  <option value="IN_STOCK">Đang tồn kho</option>
                  <option value="RESERVED">Giữ chỗ</option>
                  {canManage(profile) && (
                    <option value="CANCELLED">Đã hủy</option>
                  )}
                </select>
              </Field>
            </div>
          </Card>
          <Card>
            <h2 className="section-title">Thông tin nhập kho</h2>
            {!financial && (
              <p className="notice">
                Chủ cửa hàng hoặc người có quyền tài chính sẽ bổ sung giá nhập
                trước khi bán xe.
              </p>
            )}
            <div className="form-grid">
              <Field label="Ngày nhập kho *" error={error("purchase_date")}>
                <input type="date" {...form.register("purchase_date")} />
              </Field>
              {financial && (
                <Field label="Giá mua (₫) *" error={error("purchase_price")}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    required
                    {...form.register("purchase_price", {
                      setValueAs: (value) =>
                        value === "" ? undefined : Number(value),
                    })}
                  />
                </Field>
              )}
              <Field label="Giá niêm yết (₫) *" error={error("asking_price")}>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  {...form.register("asking_price", { valueAsNumber: true })}
                />
              </Field>
              <Field label="Tên nhà cung cấp" error={error("supplier_name")}>
                <input {...form.register("supplier_name")} />
              </Field>
              <Field
                label="Số điện thoại nhà cung cấp"
                error={error("supplier_phone")}
              >
                <input type="tel" {...form.register("supplier_phone")} />
              </Field>
            </div>
            <Field label="Ghi chú" error={error("notes")}>
              <textarea
                rows={3}
                {...form.register("notes")}
                placeholder="Tình trạng xe, hồ sơ, phụ kiện đi kèm…"
              />
            </Field>
          </Card>
          <Card>
            <h2 className="section-title">Hình ảnh xe</h2>
            <p className="muted">
              Có thể chọn nhiều ảnh JPG, PNG, WebP. Tối đa 5 MB mỗi ảnh.
            </p>
            <Field label="Chọn ảnh">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  if (
                    selected.some(
                      (file) =>
                        file.size > 5 * 1024 * 1024 ||
                        !["image/jpeg", "image/png", "image/webp"].includes(
                          file.type,
                        ),
                    )
                  ) {
                    setUploadError(
                      "Chỉ chọn ảnh JPG, PNG, WebP nhỏ hơn hoặc bằng 5 MB.",
                    );
                    event.target.value = "";
                    setFiles([]);
                    return;
                  }
                  setUploadError("");
                  setFiles(selected);
                }}
              />
            </Field>
            {files.length > 0 && (
              <p className="muted">
                {files.length} ảnh đã chọn:{" "}
                {files.map((file) => file.name).join(", ")}
              </p>
            )}
          </Card>
        </fieldset>
        {mutation.isError && <ErrorState error={mutation.error} />}
        {uploadError && (
          <div className="notice" role="status">
            {uploadError}
            {savedId && (
              <Link to={`/vehicles/${savedId}`}> Mở chi tiết xe →</Link>
            )}
          </div>
        )}
        <div className="form-actions">
          <Link
            className="button secondary"
            to={vehicle ? `/vehicles/${vehicle.id}` : "/vehicles"}
          >
            Quay lại
          </Link>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? "Đang lưu…"
              : savedId
                ? "Thử tải ảnh còn lại"
                : vehicle
                  ? "Lưu thay đổi"
                  : "Lưu xe mới"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function VehiclePhoto({
  photo,
  vehicleName,
  removable,
}: {
  photo: VehicleImage;
  vehicleName: string;
  removable: boolean;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ["vehicle-image", photo.storage_path],
    queryFn: () => api.imageUrl(photo.storage_path),
    staleTime: 4 * 60 * 1000,
  });
  const remove = useMutation({
    mutationFn: () => api.call("remove_vehicle_image", { p_id: photo.id }),
    onSuccess: () => client.invalidateQueries(),
  });
  return (
    <div className="vehicle-photo">
      {query.data ? (
        <a href={query.data} target="_blank" rel="noreferrer">
          <img loading="lazy" src={query.data} alt={vehicleName} />
        </a>
      ) : (
        <div className="image-placeholder">
          <Camera size={28} />
          <span>{query.isError ? "Không tải được ảnh" : "Đang tải ảnh…"}</span>
        </div>
      )}
      {removable && (
        <div className="row">
          {confirm ? (
            <>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Gỡ ảnh
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Giữ lại
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Gỡ ảnh này
            </Button>
          )}
        </div>
      )}
      {remove.isError && <ErrorState error={remove.error} />}
    </div>
  );
}

export function VehicleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const client = useQueryClient();
  const [uploadMessage, setUploadMessage] = useState("");
  const query = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<VehicleDetail>("get_vehicle", { p_id: id }),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        if (
          file.size > 5 * 1024 * 1024 ||
          !["image/jpeg", "image/png", "image/webp"].includes(file.type)
        )
          throw new AppError(
            "Chỉ chọn ảnh JPG, PNG, WebP nhỏ hơn hoặc bằng 5 MB.",
          );
      }
      let completed = 0;
      try {
        for (const file of files) {
          await api.uploadVehicleImage(id!, file);
          completed++;
        }
      } finally {
        await client.invalidateQueries({ queryKey: ["vehicle", id] });
        setUploadMessage(
          completed ? `Đã tải lên ${completed}/${files.length} ảnh.` : "",
        );
      }
    },
  });
  function onImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) {
      setUploadMessage("");
      upload.mutate(files);
    }
    event.target.value = "";
  }
  if (query.isPending) return <Loading />;
  if (query.isError)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );
  const vehicle = query.data;
  if (!vehicle) return <EmptyState title="Không tìm thấy xe" />;
  const activeSale = vehicle.sales?.find((sale) => sale.status === "COMPLETED");
  const available = ["IN_STOCK", "RESERVED"].includes(vehicle.status);
  const financial = canFinance(profile);
  return (
    <div className="stack">
      <Link className="back-link" to="/vehicles">
        <ArrowLeft size={16} /> Kho xe
      </Link>
      <PageHeader
        title={`${vehicle.brand} ${vehicle.model}`}
        description={`${vehicle.internal_code} · ${vehicle.license_plate || "Chưa có biển số"}`}
        actions={
          <div className="row">
            {canOperate(profile) && vehicle.status !== "SOLD" && (
              <Link className="button secondary" to={`/vehicles/${id}/edit`}>
                <Pencil size={16} /> Chỉnh sửa
              </Link>
            )}
            {canOperate(profile) && available && !vehicle.cost_pending && (
              <Link className="button primary" to={`/vehicles/${id}/sell`}>
                <ShoppingBag size={17} /> Bán xe này
              </Link>
            )}
          </div>
        }
      />
      <div className="row">
        <Badge status={vehicle.status} />
        {available && (
          <span className="muted">
            {daysInStock(vehicle.purchase_date)} ngày trong kho
          </span>
        )}
      </div>
      {vehicle.cost_pending && (
        <p className="notice">
          Xe đang chờ bổ sung giá nhập.{" "}
          {financial ? (
            <Link to={`/vehicles/${id}/edit`}>
              Cập nhật giá nhập để có thể bán xe.
            </Link>
          ) : (
            "Liên hệ người có quyền tài chính để hoàn tất thông tin."
          )}
        </p>
      )}
      <div className="detail-grid">
        <div className="stack">
          <Card>
            <div className="row between">
              <h2 className="section-title">Hình ảnh xe</h2>
              {canOperate(profile) && (
                <label className="button secondary upload-button">
                  <Upload size={16} />
                  {upload.isPending ? "Đang tải…" : "Thêm ảnh"}
                  <input
                    aria-label="Thêm ảnh xe"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    disabled={upload.isPending}
                    onChange={onImages}
                  />
                </label>
              )}
            </div>
            {vehicle.images?.length ? (
              <div className="vehicle-gallery">
                {vehicle.images.map((photo) => (
                  <VehiclePhoto
                    key={photo.id}
                    photo={photo}
                    vehicleName={`${vehicle.brand} ${vehicle.model}`}
                    removable={canOperate(profile)}
                  />
                ))}
              </div>
            ) : (
              <div className="vehicle-empty-photo">
                <Bike size={74} strokeWidth={1.2} />
                <p>Thêm ảnh để dễ nhận diện xe trong kho</p>
              </div>
            )}
            {uploadMessage && (
              <p role="status" className="notice">
                {uploadMessage}
              </p>
            )}
            {upload.isError && <ErrorState error={upload.error} />}
          </Card>
          <Card>
            <h2 className="section-title">Thông tin chi tiết</h2>
            <dl className="details-list">
              {[
                ["Hãng / Dòng xe", `${vehicle.brand} ${vehicle.model}`],
                ["Phiên bản", vehicle.variant],
                ["Năm sản xuất", vehicle.year],
                ["Màu sắc", vehicle.color],
                ["Biển số", vehicle.license_plate],
                [
                  "Số km đã đi",
                  `${Number(vehicle.odometer ?? 0).toLocaleString("vi-VN")} km`,
                ],
                ["Số khung", vehicle.frame_number],
                ["Số máy", vehicle.engine_number],
                ["Ngày nhập kho", dateLabel(vehicle.purchase_date)],
                ["Nhà cung cấp", vehicle.supplier_name],
                ["SĐT nhà cung cấp", vehicle.supplier_phone],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt>{label}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
            {vehicle.notes && (
              <div className="notes">
                <strong>Ghi chú</strong>
                <p>{vehicle.notes}</p>
              </div>
            )}
          </Card>
          {canManage(profile) && (
            <Card>
              <div className="row between">
                <h2 className="section-title">Chi phí của xe</h2>
                {available && (
                  <Link
                    className="button secondary"
                    to={`/expenses?kind=vehicle&vehicle=${id}&new=1`}
                  >
                    <CirclePlus size={16} /> Thêm chi phí
                  </Link>
                )}
              </div>
              {vehicle.expenses?.length ? (
                <div className="compact-list">
                  {vehicle.expenses.map((expense) => (
                    <div className="compact-row" key={expense.id}>
                      <div>
                        <strong>
                          {expense.description ||
                            vehicleExpenseLabels[
                              expense.expense_type ?? "OTHER"
                            ]}
                        </strong>
                        <small>
                          {dateLabel(expense.expense_date)} ·{" "}
                          {
                            vehicleExpenseLabels[
                              expense.expense_type ?? "OTHER"
                            ]
                          }
                        </small>
                      </div>
                      <div className="align-right">
                        <strong>{money(expense.amount)}</strong>
                        {expense.status === "CANCELLED" && (
                          <Badge status="CANCELLED" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">Chưa ghi nhận chi phí cho xe này.</p>
              )}
            </Card>
          )}
          <Card>
            <h2 className="section-title">Lịch sử hoạt động</h2>
            {vehicle.activity?.length ? (
              <ol className="timeline">
                {vehicle.activity.map((entry) => (
                  <li key={entry.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {actionLabels[entry.action] ?? "Cập nhật dữ liệu xe"}
                      </strong>
                      <p>
                        {entry.actor_name || "Người dùng hệ thống"} ·{" "}
                        {dateLabel(entry.created_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">
                Lịch sử được ghi nhận tự động khi có thay đổi.
              </p>
            )}
          </Card>
        </div>
        <aside className="stack">
          <Card>
            <h2 className="section-title">Giá trị xe</h2>
            <div className="price-hero">
              <span className="muted">Giá niêm yết</span>
              <strong>{money(vehicle.asking_price)}</strong>
            </div>
            {financial && (
              <dl className="summary-list">
                <div>
                  <dt>Giá mua</dt>
                  <dd>
                    {vehicle.cost_pending
                      ? "Chờ bổ sung"
                      : money(vehicle.purchase_price)}
                  </dd>
                </div>
                <div>
                  <dt>Chi phí phát sinh</dt>
                  <dd>{money(vehicle.expense_total ?? 0)}</dd>
                </div>
                <div className="summary-total">
                  <dt>Tổng giá vốn</dt>
                  <dd>
                    {vehicle.cost_pending
                      ? "Chờ bổ sung"
                      : money(vehicle.total_cost)}
                  </dd>
                </div>
              </dl>
            )}
          </Card>
          {activeSale && (
            <Card>
              <h2 className="section-title">Giao dịch bán xe</h2>
              <dl className="summary-list">
                <div>
                  <dt>Mã giao dịch</dt>
                  <dd>{activeSale.sale_code}</dd>
                </div>
                <div>
                  <dt>Khách hàng</dt>
                  <dd>{activeSale.customer_name}</dd>
                </div>
                <div>
                  <dt>Ngày bán</dt>
                  <dd>{dateLabel(activeSale.sale_date)}</dd>
                </div>
                <div>
                  <dt>Giá bán</dt>
                  <dd>{money(activeSale.sale_price)}</dd>
                </div>
                <div>
                  <dt>Đã thu</dt>
                  <dd>{money(activeSale.paid_amount)}</dd>
                </div>
                <div>
                  <dt>Còn phải thu</dt>
                  <dd>{money(activeSale.remaining_amount)}</dd>
                </div>
                {financial && (
                  <div>
                    <dt>Lợi nhuận gộp</dt>
                    <dd>{money(activeSale.gross_profit)}</dd>
                  </div>
                )}
              </dl>
              <Link
                className="button secondary full-width"
                to={`/sales/${activeSale.id}`}
              >
                Xem giao dịch <ArrowRight size={16} />
              </Link>
            </Card>
          )}
          {!!vehicle.sales?.filter((sale) => sale.status === "CANCELLED")
            .length && (
            <Card>
              <h2 className="section-title">Giao dịch đã hủy</h2>
              {vehicle.sales
                .filter((sale) => sale.status === "CANCELLED")
                .map((sale) => (
                  <Link
                    className="compact-row"
                    key={sale.id}
                    to={`/sales/${sale.id}`}
                  >
                    {sale.sale_code}
                    <Badge status="CANCELLED" />
                  </Link>
                ))}
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
