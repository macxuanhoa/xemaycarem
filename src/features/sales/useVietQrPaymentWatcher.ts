import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useNetworkStatus } from "@/lib/networkStatus";
import { toast } from "@/lib/toast";
import type { VietQrPaymentRequest } from "@/types";
import { isVerifiedReceipt, isWatchableRequest, vietqrActiveQueryKey } from "./vietqrVerification";

/**
 * P1-c: vòng xác minh tiền vào PHẢI sống sót sau khi đóng modal.
 *
 * Bản cũ đặt hai query 5 giây ngay trong modal, mà modal bị mount theo cờ
 * `showVietQr` của trang → nhân viên tắt cửa sổ QR để mở app ngân hàng của khách
 * là mọi theo dõi dừng lại. Tiền về thật trong lúc đó không ai hay, đơn hàng vẫn
 * hiện chưa thu, và rất dễ bấm "Tạo mã mới" chồng lên giao dịch cũ.
 *
 * Theo dõi vì thế dời lên cấp trang: hook dùng ĐÚNG mã cache của modal
 * (`["vietqr-active", ...]`) nên TanStack gộp làm một lần gọi, không nhân đôi
 * tải. Chỉ khi server đã gắn bằng chứng ngân hàng (`bank_transaction_id` +
 * trạng thái RECEIVED/CONFIRMED) mới báo nhận tiền — không có ngoại lệ cho trạng
 * thái tự xưng ở máy khách, và không tự chốt đơn để tránh ghi trùng doanh thu.
 */
export function useVietQrPaymentWatcher({
  vehicleId,
  saleId,
  enabled = true,
  onVerified,
}: {
  vehicleId: string | null | undefined;
  saleId?: string | null;
  enabled?: boolean;
  /** Trang dùng để làm tươi bảng đơn hàng/kho ngay khi tiền về. */
  onVerified?: (request: VietQrPaymentRequest) => void;
}) {
  const client = useQueryClient();
  const network = useNetworkStatus();
  // Mỗi bản ghi chỉ báo một lần, kể cả khi modal và trang cùng thấy nó.
  const announced = useRef<string | null>(null);

  const query = useQuery({
    queryKey: vietqrActiveQueryKey(vehicleId, saleId),
    queryFn: () => api.getActiveVietQrRequest(vehicleId as string, saleId ?? undefined),
    enabled: enabled && !!vehicleId && network.online,
    staleTime: 0,
    refetchOnMount: "always",
    // Chỉ hỏi tiếp khi còn cơ hội nhận tiền. refetchInterval dạng hàm đọc kết quả
    // hiện tại, nên bản ghi đã hủy/xác minh thì vòng lặp tự tắt.
    refetchInterval: (state) => (isWatchableRequest(state.state.data) ? 5_000 : false),
    retry: false,
  });

  const request = query.data ?? null;
  const verified = isVerifiedReceipt(request);

  useEffect(() => {
    if (!request || !verified) return;
    if (announced.current === request.id) return;
    announced.current = request.id;

    toast.success("Đã nhận tiền vào tài khoản", {
      description:
        "Ngân hàng đã xác minh đúng tài khoản, số tiền và nội dung chuyển khoản.",
    });
    for (const queryKey of [
      ["sale"],
      ["sales"],
      ["receivables"],
      ["dashboard"],
      ["payments"],
      ["vehicles"],
      ["inventory"],
    ]) {
      void client.invalidateQueries({ queryKey });
    }
    onVerified?.(request);
  }, [request, verified, client, onVerified]);

  return { request, verified, isWatching: isWatchableRequest(request) };
}
