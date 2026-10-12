import { useCallback, useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * PwaUpdate: Màn hình cập nhật ứng dụng khi deploy phiên bản mới.
 * Khi deploy lại (phát hiện new build), che toàn màn hình bằng 1 trang trắng,
 * ở giữa là logo Cà Rem và dòng chữ 'Bấm vào logo để cập nhật ứng dụng'.
 * Khi nhấn vào: luồng điện sáng phát ra và tỏa ra xung quanh, decor hiệu ứng,
 * sau đó cập nhật xong và nạp ứng dụng bình thường.
 */
export function PwaUpdate() {
  const [demoScreen, setDemoScreen] = useState(false);
  const [isElectrifying, setIsElectrifying] = useState(false);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        // Tự động kiểm tra bản mới định kỳ mỗi 15 phút hoặc khi người dùng quay lại tab
        const checkUpdate = () => {
          registration.update().catch(() => {});
        };
        const intervalId = setInterval(checkUpdate, 15 * 60 * 1000);
        const handleVisibilityChange = () => {
          if (document.visibilityState === "visible") {
            checkUpdate();
          }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
          clearInterval(intervalId);
          document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
      }
    },
  });

  // Hỗ trợ kiểm thử màn hình deploy update qua sự kiện/hàm toàn cục
  useEffect(() => {
    (window as unknown as { __caremTriggerDeployUpdate?: () => void }).__caremTriggerDeployUpdate = () => {
      setDemoScreen(true);
    };
    const onTrigger = () => setDemoScreen(true);
    window.addEventListener("carem:deploy-update", onTrigger);
    return () => {
      window.removeEventListener("carem:deploy-update", onTrigger);
    };
  }, []);

  const shouldShow = needRefresh || demoScreen;

  const handleLogoClick = useCallback(() => {
    if (isElectrifying) return;
    setIsElectrifying(true);

    // Rung phản hồi haptic nếu thiết bị hỗ trợ
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([40, 60, 100]);
      }
    } catch {
      // Bỏ qua nếu trình duyệt không hỗ trợ haptic
    }

    // Luồng điện sáng tỏa ra trong ~1s trước khi nạp phiên bản mới
    window.setTimeout(() => {
      if (needRefresh) {
        void updateServiceWorker(true);
      } else {
        // Trong chế độ kiểm thử / demo: tải lại trang
        window.location.reload();
      }
    }, 1000);
  }, [isElectrifying, needRefresh, updateServiceWorker]);

  if (!shouldShow) {
    return null;
  }

  return (
    <div
      className="carem-pwa-update-screen"
      role="dialog"
      aria-modal="true"
      aria-label="Cập nhật ứng dụng Cà Rem"
    >
      {/* Background decor field: các chấm decor hào quang năng lượng */}
      <div className="carem-update-decor-field" aria-hidden="true">
        <span className="carem-spark-dot d1" />
        <span className="carem-spark-dot d2" />
        <span className="carem-spark-dot d3" />
        <span className="carem-spark-dot d4" />
      </div>

      <div className={`carem-update-content ${isElectrifying ? "is-electrifying" : ""}`}>
        {/* Nút bấm Logo Cà Rem kích hoạt hiệu ứng điện sáng */}
        <button
          type="button"
          className="carem-update-logo-btn"
          onClick={handleLogoClick}
          disabled={isElectrifying}
          title="Bấm vào logo để cập nhật ứng dụng Cà Rem"
          aria-label="Bấm vào logo để cập nhật ứng dụng Cà Rem"
        >
          {/* Luồng sóng điện tỏa ra 360 độ (Electric shockwaves) */}
          <div className="carem-electric-waves" aria-hidden="true">
            <span className="electric-wave wave-1" />
            <span className="electric-wave wave-2" />
            <span className="electric-wave wave-3" />
            <span className="electric-wave wave-4" />
          </div>

          {/* Tia chớp điện decor xung quanh khi kích hoạt (Electric arcs) */}
          <div className="carem-electric-arcs" aria-hidden="true">
            <svg className="electric-bolt bolt-top" viewBox="0 0 40 100">
              <path
                d="M20,0 L24,40 L16,50 L28,100"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <svg className="electric-bolt bolt-right" viewBox="0 0 100 40">
              <path
                d="M0,20 L40,24 L50,16 L100,28"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <svg className="electric-bolt bolt-bottom" viewBox="0 0 40 100">
              <path
                d="M20,100 L16,60 L24,50 L12,0"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <svg className="electric-bolt bolt-left" viewBox="0 0 100 40">
              <path
                d="M100,20 L60,16 L50,24 L0,12"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          {/* Khung viền và ảnh logo thương hiệu Cà Rem */}
          <div className="carem-update-logo-ring">
            <img
              src="/logo.jpg"
              alt="Logo Cà Rem"
              className="carem-update-logo-img"
            />
          </div>
        </button>

        {/* Dòng chữ bấm vào logo để cập nhật ứng dụng */}
        <div className="carem-update-text-wrap">
          <h1 className="carem-update-title">
            {isElectrifying
              ? "Đang nạp năng lượng cập nhật..."
              : "Bấm vào logo để cập nhật ứng dụng"}
          </h1>
          <p className="carem-update-subtext">
            {isElectrifying
              ? "Hệ thống đang chuẩn bị phiên bản mới nhất cho bạn"
              : "Phiên bản mới đã sẵn sàng · Chạm logo để kích hoạt"}
          </p>
        </div>
      </div>
    </div>
  );
}
