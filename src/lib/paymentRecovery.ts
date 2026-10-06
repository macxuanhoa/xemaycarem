import { AppError } from "./errors";

// Persist only an opaque request UUID. Never amounts, names, phone numbers or notes.
const key = (userId: string, saleId: string) => `xe_payment_pending_v1:${userId}:${saleId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pendingPayment(userId: string, saleId: string): string | null {
  try {
    const value = localStorage.getItem(key(userId, saleId));
    if (value && !uuid.test(value))
      throw new AppError("Mã đối soát khoản thu không hợp lệ. Hãy kiểm tra lịch sử thanh toán trước khi tạo khoản thu mới.");
    return value;
  } catch {
    throw new AppError("Không thể lưu mã đối soát trên thiết bị. Kiểm tra lịch sử thanh toán và cho phép bộ nhớ trình duyệt trước khi thu tiền.");
  }
}

export function retainPayment(userId: string, saleId: string): string {
  const existing = pendingPayment(userId, saleId);
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(key(userId, saleId), id);
  } catch {
    throw new AppError("Bộ nhớ trình duyệt không khả dụng. Giao dịch chưa được gửi; hãy kiểm tra bộ nhớ trước khi thu tiền.");
  }
  return id;
}

export function confirmPayment(userId: string, saleId: string, id: string): void {
  try {
    if (localStorage.getItem(key(userId, saleId)) === id)
      localStorage.removeItem(key(userId, saleId));
  } catch {
    // Keep the server-confirmed outcome; a retained key will reconcile next time.
  }
}
