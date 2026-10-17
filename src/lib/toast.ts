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
  /** Bỏ trống để dùng mốc cộng dồn; chỉ truyền khi cần ghim vĩnh viễn (0) hoặc ngoài lề. */
  duration?: number;
  /** Toast "cần xem kỹ": mô tả dài hoặc nghiệp vụ phải đối chiếu → +1 giây. */
  important?: boolean;
  closable?: boolean;
  action?: ToastAction;
};

// Một mốc đọc chung cho MỌI toast thường: đủ để đọc xong một dòng tiêu đề và
// một dòng mô tả. Không còn chia tốc độ theo kind (success/info/warning như nhau).
const BASE_MS = 4000;
// Chỉ số cộng dồn bậc 1 — toast "quan trọng, cần xem kỹ" (gửi yêu cầu xác minh,
// lưu ngoại lệ nghi trùng, gửi duyệt lên chủ, cần chủ xác nhận giá bán, đối soát
// khoản thu) được +1 giây.
const READ_CAREFULLY_MS = 1000;
// Chỉ số cộng dồn bậc 2 — lỗi luôn tự tắt lâu nhất: thường kèm mô tả dài và nhân
// viên cần thời gian sao chép mã lỗi.
const ERROR_MS = 4000;

// Thời lượng suy ra từ các bậc cộng dồn (base + bậc), thay cho bảng con số tuỳ ý
// theo kind. Error = BASE + READ + ERROR = 9000ms; important = 5000ms; thường = 4000ms.
function resolveDuration(variant: ToastVariant, important: boolean): number {
  if (variant === "error") return BASE_MS + READ_CAREFULLY_MS + ERROR_MS;
  if (important) return BASE_MS + READ_CAREFULLY_MS;
  return BASE_MS;
}

// Số toast thường hiển thị cùng lúc; vượt trần thì toast cũ trôi đi bằng đúng
// hiệu ứng mờ dần (không gỡ tức thì).
const MAX_VISIBLE = 4;

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
  const duration = input.duration ?? resolveDuration(variant, input.important ?? false);
  const toast: Toast = {
    id,
    variant,
    title: input.title,
    description: input.description,
    duration,
    closable: input.closable ?? (variant === "error" || variant === "warning"),
    action: input.action,
  };
  toasts = [toast, ...toasts];
  emit();
  if (duration > 0) {
    timers.set(id, { timer: null, remaining: duration });
    schedule(id);
  } else {
    timers.set(id, { timer: null, remaining: null });
  }
  // Vượt trần: để đúng số toast thường hiển thị. Toast bị đẩy ra đi qua dismiss()
  // nên vẫn mờ dần và được dọn timer, thay vì gỡ tức thì khi slice mảng.
  const visible = toasts.filter((t) => !t.leaving);
  if (visible.length > MAX_VISIBLE) {
    for (const evicted of visible.slice(MAX_VISIBLE)) dismiss(evicted.id);
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
