import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  CirclePlus,
  Pencil,
  ShoppingBag,
  Copy,
} from "lucide-react";
import { api } from "@/lib/api";
import { money, dateLabel, daysInStock } from "@/lib/format";
import { canFinance, canManage, canOperate } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { Vehicle } from "@/types";
import { actionLabels } from "./vehicleSchema";
import { vehicleExpenseLabels } from "@/features/expenses/expenseSchema";
import { VehiclePhoto } from "./VehiclePhoto";
import { addRecentVehicle } from "@/lib/recentVehicles";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import { VehicleImageUpload } from "./VehicleImageUpload";
import { VehicleQr } from "./VehicleQr";
import { IdentityDocumentPanel } from "@/components/IdentityDocumentPanel";

export function VehicleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const location = useLocation();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [message, setMessage] = useState("");

  const query = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: id }),
  });

  // Resolve the acquisition (người bán) behind this vehicle for its CCCD panel.
  const acquisitionQuery = useQuery({
    queryKey: ["vehicle-acquisition", id],
    queryFn: () =>
      api.call<string | null>("get_acquisition_for_vehicle", { p_vehicle_id: id }),
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
  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`Đã sao chép ${label.toLowerCase()}.`);
    } catch {
      setMessage(
        "Chưa sao chép được. Hãy chọn và sao chép thông tin trên màn hình.",
      );
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

  return (
    <div className="stack">
      <Link
        className="back-link"
        to={location.state?.fromInventory || "/vehicles"}
        state={{ restoreInventory: true }}
      >
        <ArrowLeft size={16} /> Tồn kho
      </Link>
      <PageHeader
        title={`${vehicle.brand} ${vehicle.model}`}
        description={`Số khung: ${vehicle.frame_number || "—"} · ${vehicle.license_plate || "Chưa có biển số"} · ${vehicle.internal_code}`}
        actions={
          <div className="row">
            {canManage(profile) && available && (
              <Button variant="secondary" onClick={() => setExpenseOpen(true)}>
                <CirclePlus size={16} /> + Chi phí
              </Button>
            )}
            {canOperate(profile) &&
              vehicle.status !== "SOLD" &&
              (vehicle.status !== "CANCELLED" || canManage(profile)) && (
                <Link className="button secondary" to={`/vehicles/${id}/edit`}>
                  <Pencil size={16} />{" "}
                  {vehicle.status === "CANCELLED"
                    ? "Khôi phục / Sửa"
                    : "Chỉnh sửa"}
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
      {location.state?.acquisitionConfirmed && (
        <div className="notice" role="status">
          Đã thu xe thành công.{" "}
          <Link to="/acquisitions/new" className="text-link">
            + Thu xe tiếp
          </Link>{" "}
          · <Link to={`/capture?vehicle=${id}`}>Thêm ảnh</Link>
          {canManage(profile) && (
            <>
              {" "}
              ·{" "}
              <button
                type="button"
                className="text-link"
                onClick={() => setExpenseOpen(true)}
              >
                + Chi phí
              </button>
            </>
          )}
        </div>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
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
          <section id="photos">
            <Card>
              <div className="row between">
                <h2 className="section-title">Hình ảnh xe</h2>
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
              {canOperate(profile) && (
                <VehicleImageUpload key={vehicle.id} vehicleId={vehicle.id} />
              )}
            </Card>
          </section>
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
                ["Mã xe", vehicle.internal_code],
                ["Ngày nhập kho", dateLabel(vehicle.purchase_date)],
                ["Nhà cung cấp", vehicle.supplier_name],
                ["SĐT nhà cung cấp", vehicle.supplier_phone],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt>{label}</dt>
                  <dd>
                    {value || "—"}
                    {typeof value === "string" &&
                      value &&
                      [
                        "Biển số",
                        "Số khung",
                        "Số máy",
                        "Mã xe",
                        "SĐT nhà cung cấp",
                      ].includes(String(label)) && (
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
              <div className="row between">
                <h2 className="section-title">Chi phí của xe</h2>
                {available && (
                  <Button
                    variant="secondary"
                    onClick={() => setExpenseOpen(true)}
                  >
                    <CirclePlus size={16} /> Thêm chi phí
                  </Button>
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
          <section id="vehicle-history">
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
          </section>
        </div>
        <aside className="stack">
          <VehicleQr vehicle={vehicle} />
          <Card>
            <h2 className="section-title">Giá trị xe</h2>
            <div className="price-hero">
              <span className="muted">Giá bán dự kiến</span>
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
      <QuickExpenseModal
        vehicleId={vehicle.id}
        vehicleName={`${vehicle.brand} ${vehicle.model}`}
        vehicleCode={vehicle.internal_code}
        purchaseDate={vehicle.purchase_date}
        isOpen={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        onSuccess={() => setMessage("Đã lưu chi phí cho xe.")}
      />
    </div>
  );
}
