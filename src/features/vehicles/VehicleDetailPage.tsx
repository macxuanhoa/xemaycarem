import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  CirclePlus,
  MoreHorizontal,
  Pencil,
  SendHorizontal,
  ShoppingBag,
  Copy,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { money, dateLabel, daysInStock } from "@/lib/format";
import {
  canDeleteVehicle,
  canFinance,
  canManage,
  canOperate,
  canRequestVehicleDelete,
} from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { toast } from "@/lib/toast";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { Vehicle } from "@/types";
import { actionLabels } from "./vehicleSchema";
import { vehicleExpenseLabels } from "@/features/expenses/expenseSchema";
import { VehiclePhotoDisplay } from "./VehiclePhoto";
import { addRecentVehicle } from "@/lib/recentVehicles";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import {
  DeleteVehicleDialog,
  RequestDeleteVehicleDialog,
} from "./VehicleDeleteDialogs";
import { VehicleImageUpload } from "./VehicleImageUpload";
import { VehicleQr } from "./VehicleQr";
import { IdentityDocumentPanel } from "@/components/IdentityDocumentPanel";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";

const identifierLabels = new Set([
  "Biển số",
  "Số khung",
  "SĐT nhà cung cấp",
]);

export function VehicleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const location = useLocation();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [message, setMessage] = useState("");

  const query = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: id }),
  });

  // Resolve the acquisition (người bán) behind this vehicle for its CCCD panel.
  const acquisitionQuery = useQuery({
    queryKey: ["vehicle-acquisition", id],
    queryFn: () =>
      api.call<string | null>("get_acquisition_for_vehicle", {
        p_vehicle_id: id,
      }),
    enabled: canManage(profile) && !!id,
  });

  useEffect(() => {
    if (query.data) addRecentVehicle(query.data, profile?.id);
  }, [query.data, profile?.id]);
  useEffect(() => {
    if (query.data && ["#vehicle-history", "#photos"].includes(location.hash)) {
      const frame = requestAnimationFrame(() =>
        document.getElementById(location.hash.slice(1))?.scrollIntoView(),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [query.data, location.hash]);
  useEffect(() => {
    if (!actionsOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actionsOpen]);
  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Đã sao chép ${label.toLowerCase()}.`);
    } catch {
      toast.error("Chưa sao chép được.", {
        description: "Hãy chọn và sao chép thông tin trên màn hình.",
      });
    }
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
  const hasSales = !!vehicle.sales?.length;
  // A queued deletion (STAFF request pending OWNER approval) locks the record:
  // the vehicle is hidden from inventory and only reachable by its detail link.
  const pending = !!vehicle.pending_deletion;
  const canAddExpense = canOperate(profile) && available && !pending;
  const canEditVehicle =
    !pending &&
    canOperate(profile) &&
    vehicle.status !== "SOLD" &&
    (vehicle.status !== "CANCELLED" || canManage(profile));
  const canSellVehicle =
    canOperate(profile) && available && !vehicle.cost_pending && !pending;
  // MANAGER/OWNER purge directly; STAFF files a request the OWNER resolves.
  const canDirectDelete = canDeleteVehicle(profile) && !hasSales && !pending;
  const canRequestDelete =
    canRequestVehicleDelete(profile) && available && !hasSales && !pending;
  const hasVehicleActions =
    canAddExpense ||
    canEditVehicle ||
    canSellVehicle ||
    canDirectDelete ||
    canRequestDelete;

  return (
    <div className="stack vehicle-detail-page">
      <Link
        className="back-link"
        to={location.state?.fromInventory || "/vehicles"}
        state={{ restoreInventory: true }}
      >
        <ArrowLeft size={16} /> Tồn kho
      </Link>
      <div className="vehicle-identity">
        <PageHeader
          title={vehicleTitle(vehicle)}
          description={[
            vehicle.internal_code || "Chưa có mã xe",
            vehicleSubtitle(vehicle),
          ]
            .filter(Boolean)
            .join(" · ")}
          actions={
            hasVehicleActions ? (
              <div className="vehicle-actions-menu-wrap">
                <button
                  type="button"
                  className="icon-button vehicle-actions-trigger"
                  aria-label="Thao tác trên xe"
                  aria-haspopup="true"
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen((v) => !v)}
                >
                  <MoreHorizontal size={22} />
                </button>
                {actionsOpen && (
                  <>
                    <div
                      className="vehicle-actions-scrim"
                      role="presentation"
                      onClick={() => setActionsOpen(false)}
                    />
                    <div className="vehicle-actions-menu">
                      {canSellVehicle && (
                        <Link
                          className="vehicle-actions-menu-item vehicle-actions-menu-primary"
                          to={`/vehicles/${id}/sell`}
                          onClick={() => setActionsOpen(false)}
                        >
                          <ShoppingBag size={17} /> Bán xe này
                        </Link>
                      )}
                      {canAddExpense && (
                        <button
                          type="button"
                          className="vehicle-actions-menu-item"
                          onClick={() => {
                            setActionsOpen(false);
                            setExpenseOpen(true);
                          }}
                        >
                          <CirclePlus size={16} /> Thêm chi phí
                        </button>
                      )}
                      {canEditVehicle && (
                        <Link
                          className="vehicle-actions-menu-item"
                          to={`/vehicles/${id}/edit`}
                          onClick={() => setActionsOpen(false)}
                        >
                          <Pencil size={16} />
                          {vehicle.status === "CANCELLED"
                            ? "Khôi phục / Sửa"
                            : "Chỉnh sửa"}
                        </Link>
                      )}
                      {canDirectDelete && (
                        <button
                          type="button"
                          className="vehicle-actions-menu-item vehicle-actions-menu-danger"
                          onClick={() => {
                            setActionsOpen(false);
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2 size={16} /> Xóa xe khỏi kho
                        </button>
                      )}
                      {canRequestDelete && (
                        <button
                          type="button"
                          className="vehicle-actions-menu-item vehicle-actions-menu-danger"
                          onClick={() => {
                            setActionsOpen(false);
                            setRequestOpen(true);
                          }}
                        >
                          <SendHorizontal size={16} /> Gửi yêu cầu xóa
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : undefined
          }
        />
        <div className="row vehicle-identity-meta">
          <Badge status={vehicle.status} />
          {available && (
            <span className="muted">
              {daysInStock(vehicle.purchase_date)} ngày trong kho
            </span>
          )}
        </div>
      </div>
      {pending && (
        <div className="notice warning" role="status">
          <TriangleAlert size={16} aria-hidden="true" />{" "}
          Đang chờ chủ cửa hàng duyệt xóa. Xe đã tạm ẩn khỏi tồn kho và không
          thể chỉnh sửa, bán hay thêm chi phí cho tới khi yêu cầu được duyệt.
        </div>
      )}
      {location.state?.acquisitionConfirmed && (
        <div className="notice" role="status">
          Đã thu xe thành công.{" "}
          <Link to="/acquisitions/new" className="text-link">
            + Thu xe tiếp
          </Link>{" "}
          · <Link to={`/capture?vehicle=${id}`}>Thêm ảnh</Link>
        </div>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {/* Vehicle value leads the page: one horizontal strip so the money
          figures are the first thing owners scan, on every screen size. */}
      <Card>
        <h2 className="section-title">Giá trị xe</h2>
        <div className="value-summary">
          {financial && (
            <>
              <div className="value-item">
                <span>Giá mua</span>
                <strong>
                  {vehicle.cost_pending
                    ? "Chờ bổ sung"
                    : money(vehicle.purchase_price)}
                </strong>
              </div>
              <div className="value-item total">
                <span>Tổng giá vốn</span>
                <strong>
                  {vehicle.cost_pending
                    ? "Chờ bổ sung"
                    : money(vehicle.total_cost)}
                </strong>
              </div>
            </>
          )}
        </div>
      </Card>
      <div className="detail-grid">
        <div className="stack">
          <section id="photos">
            <Card>
              <div className="row between">
                <h2 className="section-title">Hình ảnh xe</h2>
              </div>
              {vehicle.images?.length ? (
                <VehiclePhotoDisplay
                  photos={vehicle.images}
                  vehicleName={vehicleTitle(vehicle)}
                  removable={canOperate(profile)}
                  addPhotoHref={
                    canOperate(profile) ? `/capture?vehicle=${id}` : undefined
                  }
                />
              ) : (
                <div className="vehicle-empty-photo">
                  <Bike size={74} strokeWidth={1.2} />
                  <p>Thêm ảnh để dễ nhận diện xe trong kho</p>
                </div>
              )}
              {canOperate(profile) && (
                <VehicleImageUpload key={vehicle.id} vehicleId={vehicle.id} />
              )}
            </Card>
          </section>
          <Card>
            <h2 className="section-title">Thông tin chi tiết</h2>
            <dl className="details-list">
              {[
                ["Loại xe", vehicle.vehicle_type],
                ["Năm sản xuất", vehicle.year],
                ["Màu sắc", vehicle.color],
                ["Biển số", vehicle.license_plate],
                ["Số khung", vehicle.frame_number],
                ["Ngày nhập kho", dateLabel(vehicle.purchase_date)],
                ["Nhà cung cấp", vehicle.supplier_name],
                ["SĐT nhà cung cấp", vehicle.supplier_phone],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt>{label}</dt>
                  <dd>
                    <span
                      className={`vehicle-detail-value${identifierLabels.has(String(label)) ? " vehicle-identifier" : ""}`}
                    >
                      {value == null || value === "" ? "Chưa cập nhật" : value}
                    </span>
                    {typeof value === "string" &&
                      value &&
                      identifierLabels.has(String(label)) && (
                        <button
                          className="icon-button copy-button"
                          type="button"
                          aria-label={`Sao chép ${String(label).toLowerCase()}`}
                          onClick={() => void copyValue(String(label), value)}
                        >
                          <Copy size={15} />
                        </button>
                      )}
                  </dd>
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
          {canManage(profile) && acquisitionQuery.data && (
            <IdentityDocumentPanel
              subjectType="acquisition"
              subjectId={acquisitionQuery.data}
              title="CCCD người bán"
              personLabel="Người bán"
            />
          )}
          {canManage(profile) && (
            <Card>
              <h2 className="section-title">Chi phí của xe</h2>
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
        </div>
        <aside className="stack">
          <VehicleQr vehicle={vehicle} />
          <section id="vehicle-history">
            <Card>
              <h2 className="section-title">Lịch sử hoạt động</h2>
              {vehicle.activity?.length ? (
                <div className="timeline-scroll">
                  <ol className="timeline">
                    {vehicle.activity.map((entry) => (
                      <li key={entry.id}>
                        <span className="timeline-dot" />
                        <div>
                          <strong>
                            {actionLabels[entry.action] ??
                              "Cập nhật dữ liệu xe"}
                          </strong>
                          <p>
                            {entry.actor_name || "Người dùng hệ thống"} ·{" "}
                            {dateLabel(entry.created_at)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="muted">
                  Lịch sử được ghi nhận tự động khi có thay đổi.
                </p>
              )}
            </Card>
          </section>
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
      {deleteOpen && (
        <DeleteVehicleDialog
          vehicle={vehicle}
          onClose={() => setDeleteOpen(false)}
        />
      )}
      {requestOpen && (
        <RequestDeleteVehicleDialog
          vehicle={vehicle}
          onClose={() => setRequestOpen(false)}
        />
      )}
      <QuickExpenseModal
        vehicleId={vehicle.id}
        vehicleName={vehicleTitle(vehicle)}
        vehicleCode={vehicle.internal_code}
        purchaseDate={vehicle.purchase_date}
        isOpen={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        onSuccess={() => setMessage("Đã lưu chi phí cho xe.")}
      />
    </div>
  );
}
