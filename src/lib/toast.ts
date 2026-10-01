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

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dismiss(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
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
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration),
    );
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
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts);
}
