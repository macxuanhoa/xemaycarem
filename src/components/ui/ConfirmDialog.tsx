import { useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "./button";
import { useDialog } from "@/lib/useDialog";

export type ConfirmOptions = {
  title: string;
  description?: string;
  /** The specific record being affected, e.g. the vehicle code or account name. */
  entity?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger renders a destructive primary button so it is never ambiguous. */
  tone?: "danger" | "primary";
};

type ActiveRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

let current: ActiveRequest | null = null;
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replaces window.confirm with an accessible, on-brand confirmation dialog. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (current) current.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { ...options, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  if (!current) return;
  current.resolve(ok);
  current = null;
  emit();
}

export function ConfirmDialogHost() {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  const panelRef = useDialog(!!request, () => settle(false));
  if (!request) return null;
  const destructive = request.tone === "danger";
  return (
    <div
      className="dialog-backdrop"
      onClick={() => settle(false)}
      role="presentation"
    >
      <div
        className="dialog-panel confirm-dialog"
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-icon" data-tone={request.tone ?? "primary"}>
          <TriangleAlert size={22} />
        </div>
        <h2 id="confirm-dialog-title" className="confirm-dialog-title">
          {request.title}
        </h2>
        {request.entity && (
          <p className="confirm-dialog-entity">{request.entity}</p>
        )}
        {request.description && (
          <p className="confirm-dialog-desc">{request.description}</p>
        )}
        <div className="confirm-dialog-actions">
          <Button variant="secondary" onClick={() => settle(false)}>
            {request.cancelLabel ?? "Hủy"}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={() => settle(true)}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
