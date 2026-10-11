import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * PwaUpdate: Tự động cập nhật Service Worker trong nền.
 * Khi có bản build mới deploy lên Vercel, ứng dụng tự động nạp code mới ngay lập tức
 * mà không làm phiền người dùng với các thanh banner thủ công.
 */
export function PwaUpdate() {
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

  // Khi phát hiện phiên bản mới, tự động kích hoạt ngay lập tức
  useEffect(() => {
    if (needRefresh) {
      void updateServiceWorker(true);
    }
  }, [needRefresh, updateServiceWorker]);

  return null;
}
