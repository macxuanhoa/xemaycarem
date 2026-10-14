/**
 * InstallHint — hướng dẫn cài đặt PWA khi trình duyệt ỦNG HỘ, không bao giờ
 * làm phiền quá một lần mỗi phiên:
 *  - Desktop/Android Chrome/Edge: bắt sự kiện beforeinstallprompt, bấm "Cài
 *    đặt" là hộp cài đặt chuẩn của trình duyệt hiện ra.
 *  - iOS Safari (chưa standalone): không có beforeinstallprompt — chỉ dẫn
 *    ngắn "Chia sẻ → Thêm vào màn hình chính" (cần thiết cho Web Push iOS).
 *  - Đã cài rồi (standalone/display-mode) → không hiển thị gì.
 */
import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

const DISMISS_KEY = "carem:install-dismissed";

function isStandalone(): boolean {
  // Ngoài trình duyệt (unit test render AppLayout bằng môi trường Node thuần)
  // không có window — coi như "đã standalone" để component tự tàng hình.
  if (typeof window === "undefined") return true;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function InstallHint() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosVisible, setIosVisible] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (isStandalone() || dismissed) return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIos() && !/CriOS|FxiOS/.test(navigator.userAgent)) setIosVisible(true);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, [dismissed]);

  // Người dùng đã bấm cài đặt thành công thì ẩn hẳn (event 'appinstalled').
  useEffect(() => {
    const onInstalled = () => {
      setDeferred(null);
      setIosVisible(false);
      try {
        sessionStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /*private mode*/
      }
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, []);

  if (dismissed || isStandalone()) return null;

  const hide = () => {
    setDismissed(true);
    setDeferred(null);
    setIosVisible(false);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /*private mode*/
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    try {
      const choice = await deferred.userChoice;
      if (choice.outcome !== "accepted") setDismissed(true);
    } catch {
      setDismissed(true);
    }
    setDeferred(null);
  };

  if (!deferred && !iosVisible) return null;

  return (
    <div className="install-banner" role="status" aria-live="polite">
      <Download size={16} aria-hidden="true" />
      <span className="install-banner-text">
        {deferred ? (
          <>
            Cài <strong>Cà Rem</strong> để dùng như ứng dụng — nhanh hơn, bật
            được thông báo đẩy và tra kho cả khi mất mạng.
          </>
        ) : (
          <>
            Trên iPhone/iPad: mở <strong>Safari → Chia sẻ → Thêm vào màn hình
            chính</strong> để dùng Cà Rem như ứng dụng (cần cho thông báo đẩy).
          </>
        )}
      </span>
      {deferred && (
        <button type="button" className="install-banner-action" onClick={() => void install()}>
          Cài đặt
        </button>
      )}
      <button
        type="button"
        className="install-banner-dismiss"
        onClick={hide}
        aria-label="Để sau"
      >
        <X size={14} aria-hidden="true" /> Để sau
      </button>
    </div>
  );
}
