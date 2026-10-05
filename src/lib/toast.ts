import { useSyncExternalStore } from "react";

export type ToastVariant = "success" | "info" | "warning" | "error";

export type ToastAction = { label: string; onClick: () => void };

export type Toast = {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration: number;
  closable: boolean;
  action?: ToastAction;
  /** Set right before removal so the UI can play the exit animation. */
  leaving?: boolean;
};

type Input = {
  title: string;
  description?: string;
  duration?: number;
  closable?: boolean;
  action?: ToastAction;
};

// Defaults follow the agreed feedback language: quick for success, longer and
// manually dismissible for problems. Errors stay on screen long enough to read.
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: 9000,
};

// Entrance/exit keyframe durations in styles.css — keep in sync.
const EXIT_MS = 220;

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
// Per-toast countdown state. remaining === null means the toast is persistent
// (duration 0); a number is the ms still to run (possibly frozen by a hover).
type TimerEntry = { timer: ReturnType<typeof setTimeout> | null; remaining: number | null };
const timers = new Map<string, TimerEntry>();
// Timestamp when the current (unpaused) countdown started, for progress math.
const startedAt = new Map<string, number>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remove(id: string) {
  timers.delete(id);
  startedAt.delete(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

function dismiss(id: string) {
  const entry = timers.get(id);
  if (entry?.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!toasts.some((t) => t.id === id)) return;
  // Mark as leaving so the exit animation plays, then unmount.
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => remove(id), EXIT_MS);
}

function schedule(id: string) {
  const entry = timers.get(id);
  if (!entry || entry.remaining === null || entry.remaining === 0) return;
  startedAt.set(id, Date.now());
  entry.timer = setTimeout(() => dismiss(id), entry.remaining);
}

/** Freeze the auto-dismiss countdown (hover on desktop). */
function pause(id: string) {
  const entry = timers.get(id);
  if (!entry || entry.timer === null || entry.remaining === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  const began = startedAt.get(id);
  entry.remaining = Math.max(0, entry.remaining - (Date.now() - (began ?? Date.now())));
}

/** Resume a frozen countdown. */
function resume(id: string) {
  // The toast may have been removed while the pointer was still over it
  // (auto-dismiss fired, or another code path dismissed it).
  if (!toasts.some((t) => t.id === id)) {
    timers.delete(id);
    return;
  }
  const entry = timers.get(id);
  if (!entry || entry.timer !== null || entry.remaining === null) return;
  if (entry.remaining === 0) {
    dismiss(id);
    return;
  }
  schedule(id);
}

function push(variant: ToastVariant, input: Input) {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const duration = input.duration ?? DEFAULT_DURATION[variant];
  const toast: Toast = {
    id,
    variant,
    title: input.title,
    description: input.description,
    duration,
    closable: input.closable ?? (variant === "error" || variant === "warning"),
    action: input.action,
  };
  // Keep at most 4 visible notices so the stack never becomes noisy.
  toasts = [toast, ...toasts].slice(0, 4);
  emit();
  if (duration > 0) {
    timers.set(id, { timer: null, remaining: duration });
    schedule(id);
  } else {
    timers.set(id, { timer: null, remaining: null });
  }
  return id;
}

export const toast = {
  success: (title: string, input?: Omit<Input, "title">) =>
    push("success", { title, ...input }),
  info: (title: string, input?: Omit<Input, "title">) =>
    push("info", { title, ...input }),
  warning: (title: string, input?: Omit<Input, "title">) =>
    push("warning", { title, ...input }),
  error: (title: string, input?: Omit<Input, "title">) =>
    push("error", { title, ...input }),
  dismiss,
  pause,
  resume,
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts);
}
