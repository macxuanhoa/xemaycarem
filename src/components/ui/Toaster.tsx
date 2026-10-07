import type { CSSProperties } from "react";
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
            className={`toast toast-${t.variant}${t.leaving ? " toast-leaving" : ""}`}
            role={t.variant === "error" ? "alert" : "status"}
            data-paused={t.leaving ? "true" : undefined}
            onMouseEnter={() => toast.pause(t.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement))
                toast.resume(t.id);
            }}
            onFocusCapture={() => toast.pause(t.id)}
            onBlurCapture={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                !(
                  typeof window.matchMedia === "function" &&
                  window.matchMedia("(hover: hover)").matches &&
                  event.currentTarget.matches(":hover")
                )
              )
                toast.resume(t.id);
            }}
          >
            <span className="toast-icon" aria-hidden="true">
              <Icon size={16} />
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
                <X size={14} />
              </button>
            )}
            {!t.leaving && t.duration > 0 && (
              <span
                className="toast-progress"
                aria-hidden="true"
                style={
                  { "--toast-duration": `${t.duration}ms` } as CSSProperties
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
