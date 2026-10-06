import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { resolveVehicleQr } from "@/lib/qrcode";
import SmartVehicleScan from "./SmartVehicleScan";
import type { Html5Qrcode } from "html5-qrcode";

export default function CapturePage() {
  const navigate = useNavigate();
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
        title="Camera thông minh"
        description="Nhận diện xe bằng ảnh, quét QR mở hồ sơ, hoặc nhập biển số/số khung."
      />
      <SmartVehicleScan />
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
    </div>
  );
}
