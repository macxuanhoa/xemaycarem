import { createPortal } from "react-dom";
import { useDialog } from "@/lib/useDialog";
import SmartVehicleScan from "@/features/capture/SmartVehicleScan";

export type ScannedVehicleFields = {
  license_plate?: string;
  frame_number?: string;
  vehicle_type?: string;
  color?: string;
  year?: number;
};

type QuickVehicleScannerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (fields: ScannedVehicleFields) => void;
  title?: string;
};

export function QuickVehicleScannerModal({
  isOpen,
  onClose,
  onScanSuccess,
}: QuickVehicleScannerModalProps) {
  const dialogRef = useDialog(isOpen, onClose);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="dialog-backdrop quick-scan-modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="dialog-panel quick-scan-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quét camera biển số và số khung"
        onClick={(event) => event.stopPropagation()}
      >
        <SmartVehicleScan
          isModal={true}
          onClose={onClose}
          onScanComplete={(scanned) => {
            onScanSuccess(scanned);
            onClose();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
