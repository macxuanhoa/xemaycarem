import {
  CheckCircle2,
  Info,
  OctagonAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast, useToasts, type ToastVariant } from "@/lib/toast";

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  info: Info,
  warning: TriangleAlert,
  error: OctagonAlert,
};

export function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" role="region" aria-label="Thông báo">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <div
            key={t.id}
            className={`toast toast-${t.variant}`}
            role={t.variant === "error" ? "alert" : "status"}
          >
            <span className="toast-icon" aria-hidden="true">
              <Icon size={18} />
            </span>
            <div className="toast-body">
              <strong className="toast-title">{t.title}</strong>
              {t.description && <p className="toast-desc">{t.description}</p>}
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    t.action?.onClick();
                    toast.dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            {t.closable && (
              <button
                type="button"
                className="toast-close"
                aria-label="Đóng thông báo"
                onClick={() => toast.dismiss(t.id)}
              >
                <X size={15} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
