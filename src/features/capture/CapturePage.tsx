import { PageHeader } from "@/components/ui";
import SmartVehicleScan from "./SmartVehicleScan";

export default function CapturePage() {
  return (
    <div className="capture-page stack">
      <PageHeader
        title="Camera thông minh"
        description="Quét thông tin xe, QR hoặc căn cước để tìm xe trong kho."
      />
      <SmartVehicleScan />
    </div>
  );
}
