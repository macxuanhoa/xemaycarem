import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CirclePlus,
  Copy,
  Hash,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  SendHorizontal,
  ShieldCheck,
  ShoppingBag,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { displayFrame } from "@/lib/frameNumber";
import { resolveDebtStatus } from "@/lib/debt";
import { money, dateLabel, daysInStock } from "@/lib/format";
import {
  canDeleteVehicle,
  canFinance,
  canManage,
  canOperate,
  canRequestVehicleDelete,
  isOwner,
} from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { toast } from "@/lib/toast";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Loading,
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
import { VehicleFavoriteButton } from "./VehicleFavoriteButton";
import {
  useToggleVehicleFavorite,
} from "@/lib/useVehicleFavorite";
import { IdentityDocumentPanel } from "@/components/IdentityDocumentPanel";
import { vehicleTitle } from "@/lib/vehicleDisplay";

// The plate and VIN are promoted to the highlight tiles at the top of the page,
// so within the secondary details list only the seller phone keeps the
// monospace + copy treatment.
const identifierLabels = new Set(["SĐT người bán"]);

export function VehicleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const location = useLocation();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [photoChoiceOpen, setPhotoChoiceOpen] = useState(false);
  // Sao yêu thích cá nhân: bản nâng cấp nhẹ cho header, bấm là sáng ngay nhờ
  // optimistic cache của hook (query ["vehicle", id] được vẽ lại tại chỗ).
  const toggleFavorite = useToggleVehicleFavorite();

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
  if (query.isError && !query.data)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );

  const vehicle = query.data;
  if (!vehicle) return <EmptyState title="Không tìm thấy xe" />;

  const activeSale = vehicle.sales?.find((sale) => sale.status === "COMPLETED");
  const cancelledSales =
    vehicle.sales?.filter((sale) => sale.status === "CANCELLED") ?? [];
  const available = ["IN_STOCK", "RESERVED"].includes(vehicle.status);
  const financial = canFinance(profile);
  const hasSales = !!vehicle.sales?.length;
  // A queued deletion (STAFF request pending OWNER approval) locks the record:
  // the vehicle is hidden from inventory and only reachable by its detail link.
  const pending = !!vehicle.pending_deletion;
  // A queued below-cost sale: the bike stays IN_STOCK and earns no revenue
  // until the OWNER resolves the request, so the record has to say so loudly.
  const pendingSale = !!vehicle.pending_sale_approval;
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
        <div className="vehicle-detail-header">
          <div className="vehicle-title-row">
            <div className="vehicle-title-left">
              <div className="vehicle-title-with-tags">
                <h1
                  className="carem-led-title"
                  title={
                    (vehicle.vehicle_type && vehicle.vehicle_type !== "Chưa phân loại" ? vehicle.vehicle_type : "") ||
                    vehicle.license_plate ||
                    vehicle.internal_code ||
                    "Chi tiết xe"
                  }
                >
                  <span className="carem-led-title-text">
                    {(vehicle.vehicle_type && vehicle.vehicle_type !== "Chưa phân loại" ? vehicle.vehicle_type : "") ||
                      vehicle.license_plate ||
                      vehicle.internal_code ||
                      "Chi tiết xe"}
                  </span>
                </h1>
                <div className="vehicle-title-badges">
                  <Badge status={vehicle.status} />
                  {pendingSale && (
                    <span className="badge badge-warning">Chờ duyệt giá</span>
                  )}
                  {pending && (
                    <span className="badge badge-danger">Chờ duyệt xóa</span>
                  )}
                </div>
              </div>
            </div>

            <div className="vehicle-head-actions">
              <VehicleFavoriteButton
                vehicle={vehicle}
                size={19}
                className="vehicle-fav-btn"
              />
              {hasVehicleActions && (
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
                      <button
                        type="button"
                        className="vehicle-actions-menu-item"
                        aria-pressed={!!vehicle.is_favorite}
                        onClick={() => {
                          setActionsOpen(false);
                          toggleFavorite.mutate(vehicle.id);
                        }}
                      >
                        <span
                          className={
                            vehicle.is_favorite
                              ? "vam-tile vam-tile-fav"
                              : "vam-tile vam-tile-neutral"
                          }
                        >
                          <Star size={15} fill={vehicle.is_favorite ? "currentColor" : "none"} />
                        </span>
                        {vehicle.is_favorite ? "Bỏ yêu thích" : "Yêu thích"}
                      </button>
                      {canSellVehicle && (
                        <Link
                          className="vehicle-actions-menu-item vehicle-actions-menu-primary"
                          to={`/vehicles/${id}/sell`}
                          onClick={() => setActionsOpen(false)}
                        >
                          <span className="vam-tile vam-tile-primary"><ShoppingBag size={15} /></span>
                          Bán xe này
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
                          <span className="vam-tile vam-tile-neutral"><CirclePlus size={15} /></span>
                          Thêm chi phí
                        </button>
                      )}
                      {canEditVehicle && (
                        <Link
                          className="vehicle-actions-menu-item"
                          to={`/vehicles/${id}/edit`}
                          onClick={() => setActionsOpen(false)}
                        >
                          <span className="vam-tile vam-tile-neutral"><Pencil size={15} /></span>
                          {vehicle.status === "CANCELLED"
                            ? "Khôi phục / Sửa"
                            : "Chỉnh sửa"}
                        </Link>
                      )}
                      {(canDirectDelete || canRequestDelete) && (
                        <div className="vam-group-label">Vùng nguy hiểm</div>
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
                          <span className="vam-tile vam-tile-danger"><Trash2 size={15} /></span>
                          Xóa xe khỏi kho
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
                          <span className="vam-tile vam-tile-danger"><SendHorizontal size={15} /></span>
                          Gửi yêu cầu xóa
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
              )}
            </div>
          </div>
        </div>

        {/* Thanh định danh xe chuẩn mực, đẳng cấp: Biển số & Số khung */}
        <div className="vehicle-id-showcase">
          {/* Cột Biển số */}
          <div className="vehicle-id-item vehicle-id-item-plate">
            <div className="vehicle-id-item-header">
              <span className="vehicle-id-item-label">
                <Hash size={13} className="vehicle-id-item-icon" />
                Biển số đăng ký
              </span>
              {vehicle.license_plate && (
                <button
                  type="button"
                  className="vehicle-id-item-copy"
                  aria-label="Sao chép biển số"
                  title="Sao chép biển số"
                  onClick={() => void copyValue("Biển số", vehicle.license_plate)}
                >
                  <Copy size={12} />
                  <span>Sao chép</span>
                </button>
              )}
            </div>
            <div className={`vehicle-plate-badge${!vehicle.license_plate ? " is-empty" : ""}`}>
              {vehicle.license_plate && (
                <span className="vehicle-plate-screw vehicle-plate-screw-left" aria-hidden="true" />
              )}
              <span className="vehicle-plate-text">
                {vehicle.license_plate || "Chưa đăng ký biển"}
              </span>
              {vehicle.license_plate && (
                <span className="vehicle-plate-screw vehicle-plate-screw-right" aria-hidden="true" />
              )}
            </div>
          </div>

          <div className="vehicle-id-showcase-divider" aria-hidden="true" />

          {/* Cột Số khung */}
          <div className="vehicle-id-item vehicle-id-item-frame">
            <div className="vehicle-id-item-header">
              <span className="vehicle-id-item-label">
                <ShieldCheck size={13} className="vehicle-id-item-icon" />
                Số khung (VIN)
              </span>
              {!!displayFrame(vehicle.frame_number) && (
                <button
                  type="button"
                  className="vehicle-id-item-copy"
                  aria-label="Sao chép số khung"
                  title="Sao chép số khung"
                  onClick={() => void copyValue("Số khung", displayFrame(vehicle.frame_number))}
                >
                  <Copy size={12} />
                  <span>Sao chép</span>
                </button>
              )}
            </div>
            <div className={`vehicle-frame-badge${!displayFrame(vehicle.frame_number) ? " is-empty" : ""}`}>
              <span className="vehicle-frame-text">
                {displayFrame(vehicle.frame_number) ? (
                  displayFrame(vehicle.frame_number).length > 6 ? (
                    <>
                      <span className="vehicle-frame-prefix">
                        {displayFrame(vehicle.frame_number).slice(0, -6)}
                      </span>
                      <strong className="vehicle-frame-highlight">
                        {displayFrame(vehicle.frame_number).slice(-6)}
                      </strong>
                    </>
                  ) : (
                    <strong className="vehicle-frame-highlight">
                      {displayFrame(vehicle.frame_number)}
                    </strong>
                  )
                ) : (
                  "Chưa có số khung"
                )}
              </span>
            </div>
          </div>
        </div>
      </div>
      {/* Xe đã bán: hero tóm tắt giao dịch ngay đầu hồ sơ, đúng một đề xuất
          điều hướng sang trang giao dịch — tiền bạc chỉ nói đủ ở đó. */}
      {vehicle.status === "SOLD" && activeSale && (
        <Card className="vehicle-sold-hero">
          <div className="vehicle-sold-hero-head">
            <h2 className="section-title">
              <ShoppingBag size={18} aria-hidden="true" /> Đã bán
            </h2>
            <Badge status={resolveDebtStatus(activeSale)} />
          </div>
          <div className="vehicle-sold-hero-buyer">
            <strong>{activeSale.customer_name}</strong>
            {activeSale.customer_phone ? (
              <a
                className="muted small"
                href={`tel:${activeSale.customer_phone}`}
                style={{ textDecoration: "none" }}
              >
                {activeSale.customer_phone}
              </a>
            ) : (
              <span className="muted small">Chưa có SĐT</span>
            )}
          </div>
          <p className="vehicle-sold-hero-meta muted small">
            {activeSale.sale_code} · {dateLabel(activeSale.sale_date)}
            {activeSale.employee_name ? ` · ${activeSale.employee_name}` : ""}
          </p>
          <dl className="summary-list">
            <div>
              <dt>Giá bán</dt>
              <dd>
                {activeSale.sale_price_hidden
                  ? "Cà Rem nhập"
                  : money(activeSale.sale_price ?? 0)}
              </dd>
            </div>
            <div>
              <dt>Đã thu</dt>
              <dd>
                {activeSale.sale_price_hidden
                  ? "Cà Rem nhập"
                  : money(activeSale.paid_amount)}
              </dd>
            </div>
            <div className="summary-total">
              <dt>Còn phải thu</dt>
              <dd>
                {activeSale.sale_price_hidden
                  ? "Cà Rem nhập"
                  : money(activeSale.remaining_amount)}
              </dd>
            </div>
            {financial && activeSale.gross_profit != null && (
              <div>
                <dt>Lợi nhuận gộp</dt>
                <dd>{money(activeSale.gross_profit)}</dd>
              </div>
            )}
          </dl>
          <Link className="button primary" to={`/sales/${activeSale.id}`}>
            Xem giao dịch <ArrowRight size={16} />
          </Link>
        </Card>
      )}
      {pending && (
        <div className="notice warning" role="status">
          <TriangleAlert size={16} aria-hidden="true" />{" "}
          Đang chờ chủ cửa hàng duyệt xóa. Xe đã tạm ẩn khỏi tồn kho và không
          thể chỉnh sửa, bán hay thêm chi phí cho tới khi yêu cầu được duyệt.
        </div>
      )}
      {pendingSale && (
        <div className="notice warning" role="status">
          <TriangleAlert size={16} aria-hidden="true" />{" "}
          Đang chờ chủ cửa hàng duyệt bán dưới giá thu. Xe vẫn nằm trong kho và
          chưa ghi nhận doanh thu; muốn đổi giá bán hãy rút yêu cầu rồi gửi lại.
          {isOwner(profile) && (
            <>
              {" "}
              <Link to="/approvals" className="text-link">
                Mở mục Chờ duyệt
              </Link>
            </>
          )}
        </div>
      )}
      {/* Vehicle value leads the page: one horizontal strip so the money
          figures are the first thing owners scan, on every screen size. */}
      <Card>
        <h2 className="section-title">Giá trị xe</h2>
        <div className="value-summary">
          {/* Chỉ hiển thị giá thu vào của chiếc xe */}
          <div className="value-item">
            <span>Giá thu vào</span>
            <strong>
              {vehicle.cost_pending
                ? "Chưa có giá thu"
                : money(vehicle.purchase_price)}
            </strong>
          </div>
        </div>
      </Card>
      <div className="detail-grid">
        <div className="stack">
          <section id="photos">
            <Card>
              <div className="row between" style={{ alignItems: "center", marginBottom: 12 }}>
                <h2 className="section-title" style={{ margin: 0 }}>Hình ảnh xe</h2>
                {canOperate(profile) && (
                  <button
                    type="button"
                    className="vehicle-add-photo-btn"
                    onClick={() => setPhotoChoiceOpen(true)}
                  >
                    <ImagePlus size={15} /> Thêm ảnh xe
                  </button>
                )}
              </div>
              {vehicle.images?.length ? (
                <VehiclePhotoDisplay
                  photos={vehicle.images}
                  vehicleName={vehicleTitle(vehicle)}
                  removable={canOperate(profile)}
                  onAddPhoto={
                    canOperate(profile)
                      ? () => setPhotoChoiceOpen(true)
                      : undefined
                  }
                />
              ) : (
                <div
                  className="vehicle-empty-photo"
                  onClick={canOperate(profile) ? () => setPhotoChoiceOpen(true) : undefined}
                  style={{ cursor: canOperate(profile) ? "pointer" : "default" }}
                  role={canOperate(profile) ? "button" : undefined}
                  tabIndex={canOperate(profile) ? 0 : undefined}
                  title="Bấm để tải ảnh xe lên"
                  onKeyDown={
                    canOperate(profile)
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setPhotoChoiceOpen(true);
                          }
                        }
                      : undefined
                  }
                >
                  <div className="vehicle-empty-photo-icon">
                    <Camera size={26} strokeWidth={1.5} />
                  </div>
                  <div className="vehicle-empty-photo-text">
                    <p className="vehicle-empty-photo-title">Chưa có hình ảnh xe</p>
                    <p className="vehicle-empty-photo-sub">Thêm ảnh để nhận diện xe trong kho và theo dõi</p>
                  </div>
                  {canOperate(profile) && (
                    <span className="vehicle-add-photo-btn vehicle-add-photo-btn-inline">
                      <ImagePlus size={14} /> Thêm ảnh xe
                    </span>
                  )}
                </div>
              )}
              {canOperate(profile) && (
                <VehicleImageUpload
                  key={vehicle.id}
                  vehicleId={vehicle.id}
                  isChoiceOpen={photoChoiceOpen}
                  onCloseChoice={() => setPhotoChoiceOpen(false)}
                />
              )}
            </Card>
          </section>
          <Card>
            <h2 className="section-title">Thông tin chi tiết</h2>
            {/* Secondary specs only: biển số and số khung live in the identity
                hero now; mã xe và ngày trong kho dời từ đầu trang xuống đây. */}
            <dl className="details-list">
              {([
                ["Loại xe", vehicle.vehicle_type && vehicle.vehicle_type !== "Chưa phân loại" ? vehicle.vehicle_type : "—"],
                ["Mã xe", vehicle.internal_code],
                ["Năm sản xuất", vehicle.year],
                ["Màu sắc", vehicle.color],
                ["Ngày nhập kho", dateLabel(vehicle.purchase_date)],
                ...(available
                  ? [
                    [
                      "Ngày trong kho",
                      <span className="carem-led-days-badge" title="Thời gian lưu kho">
                        <span className="carem-led-diode" aria-hidden="true" />
                        <span className="carem-led-days-text">
                          <strong className="carem-led-days-num">
                            {daysInStock(vehicle.purchase_date)}
                          </strong>{" "}
                          ngày trong kho
                        </span>
                        <span className="carem-led-border-glow" aria-hidden="true" />
                      </span>,
                    ],
                  ]
                  : []),
                ["Tên người bán", vehicle.supplier_name],
                ["SĐT người bán", vehicle.supplier_phone],
              ] as [string, ReactNode][]).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <span
                      className={`vehicle-detail-value${identifierLabels.has(label) ? " vehicle-identifier" : ""}`}
                    >
                      {value == null || value === "" ? "Chưa cập nhật" : value}
                    </span>
                    {typeof value === "string" &&
                      value &&
                      identifierLabels.has(label) && (
                        <button
                          className="icon-button copy-button"
                          type="button"
                          aria-label={`Sao chép ${label.toLowerCase()}`}
                          onClick={() => void copyValue(label, value)}
                        >
                          <Copy size={15} />
                        </button>
                      )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          {vehicle.notes && (
            <Card className="vehicle-notes-card">
              <div className="vehicle-notes-header">
                <h2 className="section-title" style={{ margin: 0 }}>
                  Ghi chú
                </h2>
                <button
                  type="button"
                  className="vehicle-notes-copy-btn"
                  onClick={() => void copyValue("Ghi chú", vehicle.notes)}
                  aria-label="Sao chép ghi chú"
                  title="Sao chép ghi chú"
                >
                  <Copy size={13} />
                  <span>Sao chép</span>
                </button>
              </div>
              <div className="vehicle-notes-memo">
                <p className="vehicle-notes-body">{vehicle.notes}</p>
              </div>
            </Card>
          )}
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
          {(activeSale || cancelledSales.length > 0) && (
            <Card>
              <h2 className="section-title">Lịch sử giao dịch</h2>
              {activeSale && (
                <Link className="vehicle-sale-row" to={`/sales/${activeSale.id}`}>
                  <span>
                    <strong>{activeSale.sale_code}</strong>
                    <small className="muted">{" "}· {dateLabel(activeSale.sale_date)}</small>{" "}
                    <Badge status={activeSale.status} />
                  </span>
                  <span className={`vehicle-sale-debt-chip${activeSale.remaining_amount > 0 ? " is-due" : ""}`}>
                    {activeSale.remaining_amount > 0 ? "Còn nợ" : "Đã thu đủ"}
                  </span>
                </Link>
              )}
              {cancelledSales.length > 0 && (
                <details className="vehicle-cancelled-history">
                  <summary>Giao dịch đã hủy ({cancelledSales.length})</summary>
                  {cancelledSales.map((sale) => (
                    <Link
                      className="vehicle-cancelled-row"
                      key={sale.id}
                      to={`/sales/${sale.id}`}
                    >
                      <span>
                        {sale.sale_code}
                        <small className="muted">
                          {" · "}{dateLabel(sale.sale_date)}
                        </small>
                      </span>
                      <Badge status="CANCELLED" />
                    </Link>
                  ))}
                </details>
              )}
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
        purchaseDate={vehicle.purchase_date}
        isOpen={expenseOpen}
        onClose={() => setExpenseOpen(false)}
      />
    </div>
  );
}
