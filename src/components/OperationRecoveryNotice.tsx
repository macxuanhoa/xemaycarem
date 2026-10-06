import { useMutation } from "@tanstack/react-query";
import { Button, ErrorState } from "@/components/ui";
import { pendingOperation, reconcileOperation, type RecoverableOperation } from "@/lib/operationRecovery";
import { toast } from "@/lib/toast";

export function OperationRecoveryNotice<T>({ userId, operation, scope, onConfirmed }: {
  userId?: string;
  operation: RecoverableOperation;
  scope: string;
  onConfirmed: (result: T) => void | Promise<void>;
}) {
  const check = useMutation({
    mutationFn: () => reconcileOperation<T>(userId!, operation, scope),
    onSuccess: async (outcome) => {
      if (outcome.confirmed) {
        toast.success("Giao dịch trước đã được lưu. Đã đối soát kết quả.");
        await onConfirmed(outcome.result as T);
      } else {
        toast.info("Chưa tìm thấy giao dịch đã xác nhận. Bạn có thể kiểm tra lịch sử và gửi lại với mã đối soát đang giữ.");
      }
    },
  });
  if (!userId) return null;
  let id: string | null;
  try { id = pendingOperation(userId, operation, scope); }
  catch (error) { return <ErrorState error={error} />; }
  if (!id) return null;
  return (
    <div className="notice draft-notice" role="status">
      <p>Có giao dịch cần kiểm tra kết quả trên thiết bị này. Hãy đối soát trước khi tạo giao dịch mới.</p>
      <Button type="button" variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? "Đang kiểm tra…" : "Kiểm tra giao dịch trước"}
      </Button>
      {check.isError && <ErrorState error={check.error} />}
    </div>
  );
}
