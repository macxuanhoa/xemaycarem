import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui";

export function PwaUpdate() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  if (!needRefresh) return null;
  return (
    <div className="update-banner" role="status">
      Có phiên bản mới. Hãy lưu công việc trước khi cập nhật.
      <Button
        variant="secondary"
        onClick={() => void updateServiceWorker(true)}
      >
        Cập nhật
      </Button>
    </div>
  );
}
