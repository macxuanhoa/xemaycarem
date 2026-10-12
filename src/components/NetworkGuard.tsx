import { useEffect, useRef, useState } from "react";
import { ServerOff, WifiOff, RefreshCw, Wifi } from "lucide-react";
import {
  useNetworkStatus,
  retryConnection,
  formatOfflineDuration,
} from "@/lib/networkStatus";

// Keep the changing clock outside the live region: screen readers should hear
// a connection transition once, rather than the elapsed time every second.
function OfflineDuration({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!since) return;
    const update = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [since]);

  return since ? (
    <span className="network-banner-elapsed" aria-hidden="true">
      Đã gián đoạn {formatOfflineDuration(elapsed)}
    </span>
  ) : null;
}

/** Show connection state without remounting forms or replaying transactions. */
export function NetworkGuard() {
  const net = useNetworkStatus();
  const previousOnline = useRef(net.online);
  const [recovered, setRecovered] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const retryInFlight = useRef(false);

  // The timer depends on the actual transition only. Clock ticks and the
  // recovered state must not cancel or restart it.
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
    const timer = window.setTimeout(() => setRecovered(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [net.online]);

  const handleRetry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryFailed(false);
    try {
      setRetryFailed(!(await retryConnection()));
    } catch {
      setRetryFailed(true);
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };

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
          <span>
            Bạn có thể tiếp tục. Kiểm tra giao dịch chưa rõ kết quả trước khi
            gửi lại.
          </span>
        </div>
      </div>
    ) : null;
  }

  const checking = retrying || net.checking;
  const ConnectionIcon = net.browserOnline ? ServerOff : WifiOff;

  return (
    <section
      className="network-banner network-banner--offline"
      aria-label="Trạng thái kết nối"
    >
      <ConnectionIcon size={18} aria-hidden="true" />
      <div className="network-banner-body">
        <div role="status" aria-live="polite" aria-atomic="true">
          <strong>
            {!net.browserOnline
              ? "Mất kết nối mạng"
              : net.serviceStatus === "unavailable"
                ? "Máy chủ tạm thời không khả dụng"
                : "Chưa kết nối được máy chủ"}
          </strong>
          <span className="network-banner-description">
            Giữ trang mở để không mất thông tin đang nhập. Hệ thống tự kiểm tra
            kết nối và không tự gửi lại giao dịch.
          </span>
          {retryFailed && (
            <span className="network-banner-feedback">
              Chưa thể kết nối. Hãy kiểm tra mạng hoặc thử lại sau.
            </span>
          )}
        </div>
        <OfflineDuration since={net.offlineSince} />
      </div>
      <button
        type="button"
        className="network-banner-retry"
        onClick={handleRetry}
        disabled={checking}
        aria-label={checking ? "Đang kiểm tra kết nối" : "Thử kết nối lại"}
      >
        <RefreshCw
          size={15}
          className={checking ? "spin" : ""}
          aria-hidden="true"
        />
        <span>{checking ? "Đang kiểm tra…" : "Thử lại"}</span>
      </button>
    </section>
  );
}
