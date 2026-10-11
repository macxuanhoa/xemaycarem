import { useQuery } from "@tanstack/react-query";
import { Button, ErrorState } from "@/components/ui";
import { generateQrSvg, vehicleQrPayload } from "@/lib/qrcode";
import { QrCode, Printer, Download } from "lucide-react";
import type { Vehicle } from "@/types";

export function VehicleQr({ vehicle }: { vehicle: Vehicle }) {
  const query = useQuery({
    queryKey: ["vehicle-qr", 1, vehicle.id],
    queryFn: () => generateQrSvg(vehicleQrPayload(vehicle.id)),
    staleTime: Infinity,
  });
  const download = () => {
    if (!query.data) return;
    const url = URL.createObjectURL(
      new Blob([query.data], { type: "image/svg+xml" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${vehicle.internal_code || "vehicle"}-QR.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const print = () => {
    document.body.dataset.printTarget = "vehicle-label";
    window.print();
    delete document.body.dataset.printTarget;
  };
  return (
    <div className="vehicle-qr-compact">
      <div className="vehicle-qr-header">
        <QrCode size={16} />
        <span>{vehicle.internal_code || "Mã xe"}</span>
      </div>
      <div className="vehicle-qr-body print-vehicle-label">
        {query.data ? (
          <img
            width={140}
            height={140}
            alt="Mã QR xe"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(query.data)}`}
          />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : (
          <div className="vehicle-qr-skeleton" />
        )}
      </div>
      <div className="vehicle-qr-actions">
        <Button
          variant="ghost"
          className="btn-xs"
          disabled={!query.data}
          onClick={download}
        >
          <Download size={14} /> Tải
        </Button>
        <Button
          variant="ghost"
          className="btn-xs"
          disabled={!query.data}
          onClick={print}
        >
          <Printer size={14} /> In tem
        </Button>
      </div>
    </div>
  );
}
