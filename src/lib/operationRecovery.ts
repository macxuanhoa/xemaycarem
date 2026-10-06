import { api } from "./api";
import { AppError } from "./errors";

export type RecoverableOperation = "acquire_vehicle" | "import_vehicles" | "sell_vehicle" | "create_vehicle";
const storageKey = (userId: string, operation: RecoverableOperation, scope: string) =>
  `xe_operation_pending_v1:${userId}:${operation}:${scope}`;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pendingOperation(userId: string, operation: RecoverableOperation, scope: string): string | null {
  let id: string | null;
  try { id = localStorage.getItem(storageKey(userId, operation, scope)); }
  catch { throw new AppError("Không đọc được mã đối soát trên thiết bị. Hãy kiểm tra lịch sử giao dịch và bộ nhớ trình duyệt."); }
  if (id && !validId.test(id)) throw new AppError("Mã đối soát trên thiết bị không hợp lệ. Hãy kiểm tra lịch sử giao dịch trước khi tạo giao dịch mới.");
  return id;
}

export function retainOperation(userId: string, operation: RecoverableOperation, scope: string): string {
  const existing = pendingOperation(userId, operation, scope);
  if (existing) return existing;
  const id = crypto.randomUUID();
  try { localStorage.setItem(storageKey(userId, operation, scope), id); }
  catch { throw new AppError("Bộ nhớ trình duyệt không khả dụng. Giao dịch chưa được gửi; hãy kiểm tra bộ nhớ trước khi tiếp tục."); }
  return id;
}

export function confirmOperation(userId: string, operation: RecoverableOperation, scope: string, id: string): void {
  try {
    if (localStorage.getItem(storageKey(userId, operation, scope)) === id)
      localStorage.removeItem(storageKey(userId, operation, scope));
  } catch { /* Confirmed server outcome remains valid; a retained ID reconciles later. */ }
}

export async function reconcileOperation<T>(userId: string, operation: RecoverableOperation, scope: string): Promise<{ confirmed: boolean; result: T | null }> {
  const id = pendingOperation(userId, operation, scope);
  if (!id) return { confirmed: false, result: null };
  const outcome = await api.call<{ confirmed: boolean; result: T | null }>("get_operation_result", {
    p_operation: operation, p_request_id: id,
  });
  if (outcome.confirmed) confirmOperation(userId, operation, scope, id);
  return outcome;
}

export async function executeOperation<T>(userId: string, operation: RecoverableOperation, scope: string, send: (id: string) => Promise<T>): Promise<T> {
  if (pendingOperation(userId, operation, scope)) {
    const previous = await reconcileOperation<T>(userId, operation, scope);
    if (previous.confirmed) return previous.result as T;
  }
  const id = retainOperation(userId, operation, scope);
  const result = await send(id);
  confirmOperation(userId, operation, scope, id);
  return result;
}
