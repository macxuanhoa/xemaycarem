/**
 * Cài đặt thông báo đẩy — mọi role tự quản máy của mình (không cần quyền
 * OWNER, theo đúng tiền lệ "Bộ nhớ viết tắt"). Push chỉ là kênh thông báo:
 * nội dung hiện trên màn hình khóa CHÍNH LÀ hàng trong chuông thông báo đã
 * được máy chủ gate theo quyền xem tiền của từng người — không bao giờ chứa
 * giá OWNER-private hay giấy tờ khách hàng, và không xác nhận bất kỳ khoản
 * tiền nào.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, BellOff, Smartphone, Trash2, WandSparkles } from "lucide-react";
import { Button, Card, ErrorState } from "@/components/ui";
import { toast } from "@/lib/toast";
import {
  disableThisDevice,
  enablePush,
  listMyPushDevices,
  notificationPermission,
  pushSupportInfo,
  revokeDevice,
  sendTestPush,
  setAllDevicesPushEnabled,
} from "@/lib/push";
import { api } from "@/lib/api";

const permissionLabels: Record<string, string> = {
  granted: "Trình duyệt đã cho phép hiển thị thông báo.",
  default: "Trình duyệt chưa hỏi quyền — bấm nút bên dưới để bật.",
  denied: "Trình duyệt đang CHẶN thông báo của trang (đổi trong Cài đặt trang web).",
  unsupported: "Trình duyệt/môi trường này không hỗ trợ thông báo đẩy.",
};

const blockerMessages: Record<string, string> = {
  "ios-install":
    "iPhone/iPad: Web Push chỉ hoạt động với ứng dụng đã Thêm vào màn hình chính (iOS 16.4 trở lên). Mở Safari → nút Chia sẻ → “Thêm vào MH chính”, vào lại Cà Rem đã cài rồi bật ở đây.",
  "unsupported-browser":
    "Trình duyệt này không có API Push (Firefox trên iOS, trình duyệt ẩn danh…). Chuông thông báo trong app vẫn hoạt động bình thường.",
  "no-vapid": "Máy chủ chưa cấu hình khóa đẩy (VAPID) — hãy báo chủ cửa hàng.",
  "insecure-context": "Trang phải chạy qua HTTPS để bật thông báo đẩy.",
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function PushSettingsCard() {
  const queryClient = useQueryClient();
  const support = pushSupportInfo();
  const [permission, setPermission] = useState(notificationPermission());
  const [deviceState, setDeviceState] = useState<"checking" | "subscribed" | "none">("checking");

  const refreshDeviceState = () => {
    if (!support.supported) {
      setDeviceState("none");
      return;
    }
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setDeviceState(subscription ? "subscribed" : "none"))
      .catch(() => setDeviceState("none"));
  };
  useEffect(refreshDeviceState, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enabledQuery = useQuery({
    queryKey: ["push-enabled"],
    queryFn: () => api.call<boolean>("get_push_enabled"),
  });
  const devicesQuery = useQuery({
    queryKey: ["push-devices"],
    queryFn: listMyPushDevices,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["push-devices"] });
    void queryClient.invalidateQueries({ queryKey: ["push-enabled"] });
    setPermission(notificationPermission());
    refreshDeviceState();
  };

  const enableMutation = useMutation({
    mutationFn: enablePush,
    onSuccess: () => {
      invalidate();
      toast.success("Đã bật thông báo đẩy trên thiết bị này.", {
        description: "Hãy giữ tab mở hoặc mở app định kỳ để nhận đẩy tức thì.",
      });
    },
  });
  const disableMutation = useMutation({
    mutationFn: disableThisDevice,
    onSuccess: () => {
      invalidate();
      toast.success("Đã tắt thông báo đẩy trên thiết bị này.");
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeDevice(id),
    onSuccess: (removed) => {
      invalidate();
      if (removed) toast.success("Đã thu hồi thiết bị.");
      else toast.info("Thiết bị không còn trong danh sách (có thể đã bị thu hồi).");
    },
  });
  const toggleAllMutation = useMutation({
    mutationFn: (enabled: boolean) => setAllDevicesPushEnabled(enabled),
    onSuccess: (_data, enabled) => {
      void queryClient.invalidateQueries({ queryKey: ["push-enabled"] });
      toast.success(enabled ? "Đã bật lại đẩy trên mọi thiết bị." : "Đã tạm tắt đẩy trên mọi thiết bị.");
    },
  });
  const testMutation = useMutation({
    mutationFn: sendTestPush,
    onSuccess: () => {
      toast.success("Đã gửi thông báo thử.", {
        description: "Nếu chưa thấy trên màn hình, kiểm tra quyền hệ thống hoặc mở app thêm lần nữa.",
      });
    },
  });

  const allEnabled = enabledQuery.data ?? true;

  return (
    <Card>
      <h2>Thông báo đẩy (Web Push)</h2>
      <p className="muted small" style={{ marginBottom: "16px" }}>
        Nhận mẹo nhỏ khi có giao dịch chờ đối soát, việc cần làm hoặc cảnh báo
        vận hành — kể cả khi chưa mở app. Nội dung đúng như chuông trong app,
        đã được lọc theo quyền của từng người; không hiện số tiền riêng tư hay
        giấy tờ khách hàng trên màn hình khóa.
      </p>

      {!support.supported && (
        <p className="muted small" role="status" style={{ marginBottom: "12px" }}>
          {blockerMessages[support.blocker ?? "unsupported-browser"]}
        </p>
      )}

      <div className="stack" style={{ gap: "12px" }}>
        <div className="row" style={{ gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <strong className="small">
            {permissionLabels[permission]}
          </strong>
        </div>
        <div className="row" style={{ gap: "10px", flexWrap: "wrap" }}>
          {deviceState === "subscribed" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={disableMutation.isPending}
              onClick={() => disableMutation.mutate()}
            >
              <BellOff size={16} /> Tắt trên thiết bị này
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!support.supported || enableMutation.isPending || permission === "denied"}
              onClick={() => enableMutation.mutate()}
            >
              <BellRing size={16} /> Bật thông báo đẩy
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={!support.supported || deviceState !== "subscribed" || !allEnabled || testMutation.isPending}
            onClick={() => testMutation.mutate()}
          >
            <WandSparkles size={16} /> Gửi thử về máy này
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={enabledQuery.isPending || toggleAllMutation.isPending}
            onClick={() => toggleAllMutation.mutate(!allEnabled)}
          >
            {allEnabled ? "Tạm tắt mọi thiết bị" : "Bật lại mọi thiết bị"}
          </Button>
        </div>
        {(enableMutation.error || disableMutation.error || toggleAllMutation.error || testMutation.error || devicesQuery.error || enabledQuery.error) && (
          <ErrorState
            error={
              enableMutation.error ??
              disableMutation.error ??
              toggleAllMutation.error ??
              testMutation.error ??
              devicesQuery.error ??
              enabledQuery.error
            }
          />
        )}
      </div>

      <h3 style={{ marginTop: "20px" }}>
        <Smartphone size={15} /> Thiết bị đã đăng ký
      </h3>
      {!!devicesQuery.data?.length && (
        <ul className="push-device-list" style={{ listStyle: "none", display: "grid", gap: "8px", padding: 0 }}>
          {devicesQuery.data.map((device) => (
            <li key={device.id} className="row" style={{ gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <span>
                <strong>{device.device_label || `Máy ${device.device_hint}`}</strong>
                <span className="muted small"> · dùng lần cuối {formatTime(device.last_used_at)}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(device.id)}
                aria-label={`Thu hồi ${device.device_label || device.device_hint}`}
              >
                <Trash2 size={15} /> Thu hồi
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!devicesQuery.isPending && !devicesQuery.data?.length && (
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          Chưa có thiết bị nào bật thông báo đẩy cho tài khoản này.
        </p>
      )}
    </Card>
  );
}
