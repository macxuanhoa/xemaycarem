import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SendHorizontal, TriangleAlert, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useDialog } from "@/lib/useDialog";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import { toast } from "@/lib/toast";
import { Button, ErrorState, Field } from "@/components/ui";
import type { Vehicle } from "@/types";

// Shared vehicle-removal dialogs so the desktop detail menu and the mobile
// inventory sheet route through one implementation.
//   * DeleteVehicleDialog — OWNER/MANAGER hard purge (irreversible).
//   * RequestDeleteVehicleDialog — STAFF files a request the OWNER resolves.

// Xóa cứng xe kho: chỉ OWNER/MANAGER, xe chưa từng có giao dịch bán.
// Thao tác không thể hoàn tác — toàn bộ chi phí, ảnh, lịch sử xe bị gỡ khỏi
// hệ thống (vết kiểm toán vẫn giữ trong audit_logs).
export function DeleteVehicleDialog({
  vehicle,
  onClose,
  onDeleted,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const remove = useMutation({
    mutationFn: () => api.deleteVehicle(vehicle.id, reason.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["acquisitions"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Đã xóa xe khỏi kho.");
      if (onDeleted) onDeleted();
      else navigate("/vehicles", { state: { fromInventory: true } });
    },
  });
  const close = () => {
    if (!remove.isPending) onClose();
  };
  const panelRef = useDialog(true, close, remove.isPending);

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        className="dialog-panel delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-vehicle-title"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="delete-dialog-head">
          <span className="delete-dialog-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <div className="delete-dialog-heading">
            <h2 id="delete-vehicle-title">Xóa xe khỏi kho</h2>
            <p>{vehicleTitle(vehicle)}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={remove.isPending}
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-dialog-warn">
          Toàn bộ phiếu thu, chi phí, hình ảnh và lịch sử của xe sẽ bị gỡ vĩnh
          viễn và không thể hoàn tác. Hãy dùng thao tác hủy nếu muốn giữ lại vết
          kiểm toán.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length >= 3 && !remove.isPending) remove.mutate();
          }}
        >
          <Field
            label="Lý do xóa (ít nhất 3 ký tự) *"
            error={
              reason.length > 0 && reason.trim().length < 3
                ? "Lý do xóa cần ít nhất 3 ký tự."
                : undefined
            }
          >
            <textarea
              minLength={3}
              maxLength={1000}
              required
              disabled={remove.isPending}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Nhập nhầm xe, trùng lặp phiếu, xe không còn giữ…"
              rows={2}
            />
          </Field>
          {remove.isError && <ErrorState error={remove.error} />}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={close}
              disabled={remove.isPending}
            >
              Giữ lại
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={remove.isPending || reason.trim().length < 3}
            >
              {remove.isPending ? "Đang xóa…" : "Xác nhận xóa xe"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// STAFF gửi yêu cầu xóa: xe tạm ẩn khỏi kho, chờ OWNER duyệt (xóa vĩnh viễn)
// hoặc khôi phục. Không phải xóa cứng — nhân viên không tự gỡ xe khỏi hệ thống.
export function RequestDeleteVehicleDialog({
  vehicle,
  onClose,
  onRequested,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onRequested?: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const submit = useMutation({
    mutationFn: () => api.requestDeleteVehicle(vehicle.id, reason.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["vehicle", vehicle.id] });
      await client.invalidateQueries({ queryKey: ["approvals"] });
      toast.success("Đã gửi yêu cầu xóa. Chờ chủ cửa hàng duyệt.");
      if (onRequested) onRequested();
      else navigate("/vehicles", { state: { fromInventory: true } });
    },
  });
  const close = () => {
    if (!submit.isPending) onClose();
  };
  const panelRef = useDialog(true, close, submit.isPending);

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        className="dialog-panel delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-delete-title"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="delete-dialog-head">
          <span className="delete-dialog-icon" aria-hidden="true">
            <SendHorizontal size={20} />
          </span>
          <div className="delete-dialog-heading">
            <h2 id="request-delete-title">Gửi yêu cầu xóa xe</h2>
            <p>{vehicleTitle(vehicle)}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={submit.isPending}
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>
        <p className="delete-dialog-warn">
          Xe sẽ tạm ẩn khỏi tồn kho và chờ chủ cửa hàng duyệt. Nếu chủ duyệt,
          xe bị gỡ vĩnh viễn; nếu chủ khôi phục, xe trở lại kho.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length >= 3 && !submit.isPending) submit.mutate();
          }}
        >
          <Field
            label="Lý do đề nghị xóa (ít nhất 3 ký tự) *"
            error={
              reason.length > 0 && reason.trim().length < 3
                ? "Lý do cần ít nhất 3 ký tự."
                : undefined
            }
          >
            <textarea
              minLength={3}
              maxLength={1000}
              required
              disabled={submit.isPending}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Nhập nhầm xe, trùng lặp phiếu, xe không còn giữ…"
              rows={2}
            />
          </Field>
          {submit.isError && <ErrorState error={submit.error} />}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={close}
              disabled={submit.isPending}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submit.isPending || reason.trim().length < 3}
            >
              {submit.isPending ? "Đang gửi…" : "Gửi yêu cầu xóa"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
