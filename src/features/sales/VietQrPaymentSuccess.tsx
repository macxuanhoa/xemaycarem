import { useEffect, useRef } from "react";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui";
import { money } from "@/lib/format";
import "./VietQrPaymentSuccess.css";

type VietQrPaymentSuccessProps = {
  amount: number;
  reference: string;
  transferContent: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  onAcknowledge: () => void;
};

/** Presentation for an already verified receipt; verification stays in the modal. */
export function VietQrPaymentSuccess({
  amount,
  reference,
  transferContent,
  bankName,
  accountNo,
  accountName,
  onAcknowledge,
}: VietQrPaymentSuccessProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="vietqr-success">
      <div className="vietqr-success-scroll">
        <div className="vietqr-success-result" role="status" aria-live="polite">
          <span className="vietqr-success-seal" aria-hidden="true">
            <Check size={32} strokeWidth={2.5} />
          </span>
          <h3 ref={headingRef} tabIndex={-1} data-dialog-initial-focus>
            Thanh toán thành công
          </h3>
          <p>Đã nhận tiền vào tài khoản</p>
        </div>

        <div className="vietqr-success-amount">
          <span>Số tiền đã nhận</span>
          <strong>{money(amount)}</strong>
        </div>

        <div className="vietqr-success-receipt">
          <div className="vietqr-success-receipt-heading">
            <span>Chi tiết giao dịch</span>
            <span className="vietqr-success-verified">
              <ShieldCheck size={13} aria-hidden="true" /> Đã xác minh
            </span>
          </div>
          <dl>
            <div className="vietqr-success-row">
              <dt>Mã thanh toán</dt>
              <dd className="vietqr-success-reference">{reference}</dd>
            </div>
            <div className="vietqr-success-row vietqr-success-row--memo">
              <dt>Nội dung</dt>
              <dd>{transferContent}</dd>
            </div>
            <div className="vietqr-success-row vietqr-success-row--bank">
              <dt>Tài khoản nhận</dt>
              <dd>
                <span>{bankName}</span>
                <span className="vietqr-success-account">{accountNo || "—"}</span>
              </dd>
            </div>
            <div className="vietqr-success-row">
              <dt>Người nhận</dt>
              <dd>{accountName || "—"}</dd>
            </div>
          </dl>
        </div>

        <p className="vietqr-success-assurance">
          <ShieldCheck size={14} aria-hidden="true" />
          Đã đối chiếu tài khoản, số tiền và nội dung.
        </p>
      </div>

      <div className="vietqr-success-footer">
        <Button className="vietqr-success-done vietqr-btn-confirm" onClick={onAcknowledge}>
          Xác nhận và đóng <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <p>Cà Rem · Cảm ơn bạn đã tin tưởng</p>
      </div>
    </div>
  );
}
