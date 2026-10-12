import { useQuery } from "@tanstack/react-query";
import { Button, Card, ErrorState, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { dateLabel, money } from "@/lib/format";
import { paymentLabels } from "@/features/vehicles/vehicleSchema";
import type { Payment, Sale } from "@/types";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";

type Shop = { store_name: string; phone?: string; address?: string };

/** Customer-facing allowlist: never spread sale/vehicle data or include internal notes. */
export function CustomerReceipt({
  sale,
  payment,
  onClose,
}: {
  sale: Sale;
  payment?: Payment;
  onClose: () => void;
}) {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<Shop>("get_settings"),
  });
  const print = () => {
    document.body.dataset.printTarget = "customer-receipt";
    window.print();
    delete document.body.dataset.printTarget;
  };
  return (
    <Card>
      <div className="row between">
        <h2 className="section-title">Xem trước phiếu in</h2>
        <Button variant="secondary" onClick={onClose}>
          Đóng
        </Button>
      </div>
      {settings.isPending ? (
        <Loading />
      ) : settings.error ? (
        <ErrorState error={settings.error} />
      ) : (
        <>
          <article className="customer-receipt print-customer-receipt">
            <header>
              <h2>Cửa Hàng Xe Máy Cà Rem</h2>
              <p>107 Nguyễn Tất Thành, Hội An</p>
              {settings.data?.phone && <p>Điện thoại: {settings.data.phone}</p>}
            </header>
            <h1>{payment ? "PHIẾU THU TIỀN" : "PHIẾU BÁN XE"}</h1>
            <p>Mã giao dịch: {sale.sale_code}</p>
            {payment && <p>Mã phiếu thu: {payment.id}</p>}
            <p>Ngày: {dateLabel(payment?.payment_date || sale.sale_date)}</p>
            <dl className="summary-list">
              <div>
                <dt>Khách hàng</dt>
                <dd>{sale.customer_name}</dd>
              </div>
              <div>
                <dt>Điện thoại</dt>
                <dd>{sale.customer_phone || "—"}</dd>
              </div>
              <div>
                <dt>Xe</dt>
                <dd>{vehicleTitle(sale)}</dd>
              </div>
              <div>
                <dt>Mã xe</dt>
                <dd>
                  {sale.internal_code || sale.vehicle?.internal_code || "—"}
                </dd>
              </div>
              <div>
                <dt>Biển số</dt>
                <dd>
                  {sale.license_plate || sale.vehicle?.license_plate || "—"}
                </dd>
              </div>
              <div>
                <dt>Số khung</dt>
                <dd>{sale.vehicle?.frame_number || "—"}</dd>
              </div>
              <div>
                <dt>Loại xe · đời · màu</dt>
                <dd>{vehicleSubtitle(sale) || "—"}</dd>
              </div>
              <div>
                <dt>Giá bán</dt>
                <dd>{money(sale.sale_price)}</dd>
              </div>
              {payment && (
                <>
                  <div>
                    <dt>Số tiền thu theo phiếu</dt>
                    <dd>{money(payment.amount)}</dd>
                  </div>
                  <div>
                    <dt>Hình thức</dt>
                    <dd>{paymentLabels[payment.payment_method]}</dd>
                  </div>
                  {payment.reference && (
                    <div>
                      <dt>Tham chiếu</dt>
                      <dd>{payment.reference}</dd>
                    </div>
                  )}
                </>
              )}
              <div>
                <dt>Tổng đã thu hiện tại</dt>
                <dd>{money(sale.paid_amount)}</dd>
              </div>
              <div className="summary-total">
                <dt>Còn phải thu hiện tại</dt>
                <dd>{money(sale.remaining_amount)}</dd>
              </div>
              {(payment?.creator_name || sale.employee_name) && (
                <div>
                  <dt>Người lập phiếu</dt>
                  <dd>{payment?.creator_name || sale.employee_name}</dd>
                </div>
              )}
            </dl>
            <p className="muted">
              Các tổng thanh toán phản ánh dữ liệu tại thời điểm in.
            </p>
            <div className="receipt-signatures">
              <span>
                Khách hàng
                <br />
                (Ký, ghi rõ họ tên)
              </span>
              <span>
                Người lập phiếu
                <br />
                (Ký, ghi rõ họ tên)
              </span>
            </div>
          </article>
          <Button onClick={print}>In / Lưu PDF</Button>
        </>
      )}
    </Card>
  );
}
