import { useState } from "react";
import { CaremRideLoader } from "@/components/loader/CaremRideLoader";

/**
 * Trang duyệt prototype CaremRideLoader (tạm thời, chỉ phục vụ review).
 * /loading-demo — không đụng vào Loading hiện hành của app.
 */
export default function LoadingDemoPage() {
  const [overlay, setOverlay] = useState(false);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f1f4f9",
        padding: "32px 20px 80px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto", display: "grid", gap: 28 }}>
        <header>
          <h1 style={{ margin: 0, fontSize: 22 }}>
            Prototype — Loading animation "Nam lái Honda SH"
          </h1>
          <p style={{ color: "#5b6b85", fontSize: 13.5, marginTop: 6 }}>
            Asset tách nền trong suốt từ ảnh tham chiếu thật. Ba biến thể:
            toàn màn hình, theo khu vực, compact.
          </p>
        </header>

        <section>
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>1 · Toàn màn hình</h2>
          <div
            style={{
              height: 560,
              borderRadius: 20,
              overflow: "hidden",
              boxShadow: "0 20px 50px -30px rgba(2,6,23,.6)",
            }}
          >
            <CaremRideLoader variant="fullscreen" />
          </div>
          <button
            type="button"
            onClick={() => setOverlay(true)}
            style={{
              marginTop: 12,
              padding: "9px 16px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              background: "#fff",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Xem overlay phủ toàn bộ trang
          </button>
        </section>

        <section>
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>2 · Theo khu vực</h2>
          <CaremRideLoader variant="section" label="Đang tải danh sách xe…" />
        </section>

        <section>
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>3 · Compact</h2>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <CaremRideLoader variant="compact" label="Đang lưu…" />
            <CaremRideLoader variant="compact" label="Đang tải ảnh…" />
          </div>
        </section>
      </div>

      {overlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "#0a0f1e",
          }}
          onClick={() => setOverlay(false)}
        >
          <CaremRideLoader variant="fullscreen" />
          <span
            style={{
              position: "absolute",
              top: 18,
              right: 22,
              color: "#93a2c4",
              fontSize: 12.5,
            }}
          >
            nhấn để đóng
          </span>
        </div>
      )}
    </div>
  );
}
