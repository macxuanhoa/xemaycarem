import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { resolveVehicleQr } from "@/lib/qrcode";
import { useAuth } from "@/features/auth/AuthProvider";
import { canOperate } from "@/lib/permissions";
import type { Html5Qrcode } from "html5-qrcode";

export default function CapturePage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [params] = useSearchParams();
  const vehicleId = resolveVehicleQr(
    params.get("vehicle") || "",
    window.location.origin,
  );
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const scanner = useRef<Html5Qrcode | null>(null);
  const starting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (scanner.current?.isScanning)
        void scanner.current.stop().catch(() => {});
    };
  }, []);
  const stop = async () => {
    if (scanner.current?.isScanning) await scanner.current.stop();
    if (mounted.current) setRunning(false);
  };
  const resolve = async (text: string) => {
    const id = resolveVehicleQr(text, window.location.origin);
    if (!id) {
      setMessage(
        "QR không thuộc xe của cửa hàng. Bạn có thể nhập số khung hoặc biển số bên dưới.",
      );
      return;
    }
    await stop();
    navigate(`/vehicles/${id}`);
  };
  const start = async () => {
    if (starting.current || scanner.current?.isScanning) return;
    starting.current = true;
    setMessage("");
    setRunning(true);
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } =
        await import("html5-qrcode");
      if (!mounted.current) return;
      const reader = new Html5Qrcode("vehicle-qr-reader", {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      scanner.current = reader;
      await reader.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        (text) => {
          if (mounted.current) void resolve(text);
        },
        () => {},
      );
      if (!mounted.current && reader.isScanning) await reader.stop();
    } catch {
      if (mounted.current) {
        setRunning(false);
        setMessage(
          "Không mở được camera. Kiểm tra quyền camera hoặc nhập mã xe để tìm.",
        );
      }
    } finally {
      starting.current = false;
    }
  };
  return (
    <div className="stack">
      <PageHeader
        title="Quét / Chụp"
        description="Quét QR để mở xe; chụp ảnh trong hồ sơ xe để lưu đúng xe."
      />
      <Card>
        <h2 className="section-title">Quét QR xe</h2>
        <div id="vehicle-qr-reader" className="qr-reader" />
        <Button onClick={() => void (running ? stop() : start())}>
          {running ? "Dừng camera" : "Mở camera quét QR"}
        </Button>
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const id = resolveVehicleQr(code, window.location.origin);
            if (id) void resolve(code);
            else {
              void stop();
              navigate(`/vehicles?q=${encodeURIComponent(code.trim())}`);
            }
          }}
        >
          <Field label="Nhập mã QR, số khung hoặc biển số">
            <input
              type="search"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              enterKeyHint="search"
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={!code.trim()}>
            Tìm xe
          </Button>
        </form>
      </Card>
      {canOperate(profile) && (
        <Card>
          <h2 className="section-title">Thu xe tốc ký</h2>
          <p className="muted">
            Dán tin nhắn hoặc ghi chú viết tắt (mỗi dòng một xe) để Cà Rem tách
            thành danh sách thu xe, kiểm tra rồi thu hàng loạt.
          </p>
          <Button asChild variant="secondary">
            <Link to="/intake">Mở thu xe tốc ký</Link>
          </Button>
        </Card>
      )}
      {canOperate(profile) && (
        <Card>
          <h2 className="section-title">Chụp ảnh xe / đồng hồ km</h2>
          <p className="muted">
            Chọn hồ sơ xe, rồi dùng “Thêm ảnh” để chụp bằng camera. Kiểm tra số
            khung, biển số và số km trước khi nhập.
          </p>
          <Button asChild>
            <Link
              to={vehicleId ? `/vehicles/${vehicleId}#photos` : "/vehicles"}
            >
              {vehicleId ? "Chụp cho xe này" : "Chọn xe để chụp"}
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/acquisitions/new">Thu xe mới</Link>
          </Button>
        </Card>
      )}
      {canOperate(profile) && (
        <Card>
          <h2 className="section-title">Đọc ảnh thành bản nháp</h2>
          <p className="muted">
            Kiểm tra thông tin được đọc trước khi đưa vào biểu mẫu.
          </p>
          <div className="row">
            {[
              ["vehicle_document", "Giấy tờ xe"],
              ["license_plate", "Biển số"],
              ["odometer", "Đồng hồ km"],
              ["receipt", "Hóa đơn"],
            ].map(([task, label]) => (
              <Button key={task} asChild variant="secondary">
                <Link
                  to={`/assist?task=${task}${vehicleId ? `&vehicle=${vehicleId}` : ""}`}
                >
                  {label}
                </Link>
              </Button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
