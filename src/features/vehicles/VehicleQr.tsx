import { useQuery } from "@tanstack/react-query";
import { Button, Card, ErrorState } from "@/components/ui";
import { generateQrSvg, vehicleQrUrl } from "@/lib/qrcode";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";
import type { Vehicle } from "@/types";

export function VehicleQr({ vehicle }: { vehicle: Vehicle }) {
  const query = useQuery({
    queryKey: ["vehicle-qr", vehicle.id],
    queryFn: () => generateQrSvg(vehicleQrUrl(vehicle.id)),
    staleTime: Infinity,
  });
  const download = () => {
    if (!query.data) return;
    const url = URL.createObjectURL(
      new Blob([query.data], { type: "image/svg+xml" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${vehicle.internal_code}-QR.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const print = () => {
    document.body.dataset.printTarget = "vehicle-label";
    window.print();
    delete document.body.dataset.printTarget;
  };
  return (
    <Card>
      <h2 className="section-title">QR xe</h2>
      <div className="vehicle-label print-vehicle-label">
        <strong>{vehicleTitle(vehicle)}</strong>
        <span>{vehicleSubtitle(vehicle)}</span>
        {query.data && (
          <img
            width={240}
            height={240}
            alt={`QR mở xe ${vehicleTitle(vehicle)}`}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(query.data)}`}
          />
        )}
      </div>
      {query.error && <ErrorState error={query.error} />}
      <div className="row">
        <Button variant="secondary" disabled={!query.data} onClick={download}>
          Tải QR
        </Button>
        <Button variant="secondary" disabled={!query.data} onClick={print}>
          In tem xe
        </Button>
      </div>
    </Card>
  );
}
