import { useEffect, useRef, useState } from "react";
import { WifiOff, RefreshCw, Wifi } from "lucide-react";
import {
  useNetworkStatus,
  retryConnection,
} from "@/lib/networkStatus";

/** Show connection state concisely: 'Kiểm tra lại kết nối mạng' + countdown timer. */
export function NetworkGuard() {
  const net = useNetworkStatus();
  const previousOnline = useRef(net.online);
  const [recovered, setRecovered] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const retryInFlight = useRef(false);

  // The timer depends on the actual transition only.
  useEffect(() => {
    const wasOnline = previousOnline.current;
    previousOnline.current = net.online;
    if (!net.online) {
      setRecovered(false);
      setRetryFailed(false);
      return;
    }
    if (wasOnline) return;
    setRecovered(true);
    setRetryFailed(false);
    const timer = window.setTimeout(() => setRecovered(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [net.online]);

  const handleRetry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryFailed(false);
    try {
      const ok = await retryConnection();
      setRetryFailed(!ok);
    } catch {
      setRetryFailed(true);
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
      setCountdown(5);
    }
  };

  // Countdown timer tự động thử kết nối lại mỗi 5s khi mất mạng
  useEffect(() => {
    if (net.online) {
      setCountdown(5);
      return;
    }
    const timer = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          void handleRetry();
          return 5;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [net.online]);

  if (net.online) {
    return recovered ? (
      <div
        className="network-banner network-banner--recovered"
        role="status"
        aria-atomic="true"
      >
        <Wifi size={18} aria-hidden="true" />
        <div className="network-banner-body">
          <strong>Đã kết nối lại</strong>
        </div>
      </div>
    ) : null;
  }

  const checking = retrying || net.checking;

  return (
    <section
      className="network-banner network-banner--offline"
      aria-label="Trạng thái kết nối"
    >
      <WifiOff size={18} aria-hidden="true" />
      <div className="network-banner-body network-banner-body--compact">
        <div role="status" aria-live="polite" aria-atomic="true">
          <strong>Kiểm tra lại kết nối mạng</strong>
          <span className="network-countdown-text">
            {checking ? "Đang thử lại…" : `Tự thử lại sau ${countdown}s`}
          </span>
          {retryFailed && (
            <span className="network-banner-feedback" style={{ display: "none" }}>
              Chưa thể kết nối
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="network-banner-retry"
        onClick={handleRetry}
        disabled={checking}
        aria-label={checking ? "Đang kiểm tra kết nối" : "Thử kết nối lại ngay"}
      >
        <RefreshCw
          size={14}
          className={checking ? "spin" : ""}
          aria-hidden="true"
        />
        <span>{checking ? "Đang thử…" : "Thử lại"}</span>
      </button>
    </section>
  );
}
