/** Telemetry has a closed vocabulary: raw errors and record values never leave the device. */
export const RUNTIME_SOURCES = [
  "global",
  "promise",
  "render",
  "rpc",
  "edge",
] as const;
export const RUNTIME_CODES = [
  "JS_ERROR",
  "UNHANDLED_REJECTION",
  "RENDER_ERROR",
  "NETWORK_ERROR",
  "RPC_SERVER_ERROR",
  "EDGE_SERVER_ERROR",
  "EDGE_RELAY_ERROR",
] as const;
export const RUNTIME_OPERATIONS = [
  "other",
  "app",
  "global",
  "ai-assist",
  "manage-users",
  "process-message",
  "dashboard",
  "daily_reconciliation",
  "list_vehicles",
  "get_vehicle",
  "save_vehicle",
  "acquire_vehicle",
  "list_acquisitions",
  "get_acquisition_for_vehicle",
  "delete_acquisition",
  "delete_vehicle",
  "request_delete_vehicle",
  "resolve_vehicle_deletion",
  "check_vehicle_duplicates",
  "lookup_vehicle_identifiers",
  "lookup_identity_document_vehicles",
  "list_sales",
  "get_sale",
  "sell_vehicle",
  "cancel_sale",
  "list_receivables",
  "update_sale_due_date",
  "request_sale_below_cost",
  "resolve_sale_approval",
  "cancel_sale_approval",
  "request_vehicle_duplicate_review",
  "resolve_vehicle_duplicate_review",
  "list_vehicle_duplicate_reviews",
  "list_pending_approvals",
  "save_expense",
  "cancel_expense",
  "list_expenses",
  "add_payment",
  "prepare_payment_receipt",
  "get_payment_receipt_request",
  "list_payment_receipts",
  "reject_payment_receipt",
  "get_operation_result",
  "list_profiles",
  "update_profile",
  "transfer_ownership",
  "get_settings",
  "save_settings",
  "global_search",
  "list_customers",
  "get_customer_history",
  "list_audit",
  "report",
  "import_vehicles",
  "validate_import_vehicles",
  "register_vehicle_image",
  "remove_vehicle_image",
  "register_identity_document_image",
  "get_identity_document",
  "save_identity_document",
  "remove_identity_document_image",
  "delete_identity_document_image",
  "list_notifications",
  "mark_notifications_read",
  "mark_all_notifications_read",
  "list_knowledge",
  "search_knowledge",
  "get_knowledge_article",
  "list_copilot_gaps",
  "list_active_announcements",
  "list_announcements",
  "save_announcement",
  "delete_announcement",
  "set_announcement_active",
  "list_vehicle_types",
  "save_vehicle_type",
  "delete_vehicle_type",
  "list_showroom_vehicles",
  "create_showroom_lead",
  "list_showroom_leads",
  "update_showroom_lead_status",
  "get_sale_communication",
] as const;
const operations = new Set<string>(RUNTIME_OPERATIONS);
export const RUNTIME_ROUTES = [
  "/",
  "/login",
  "/showroom",
  "/reset-password",
  "/change-password",
  "/acquisitions",
  "/acquisitions/new",
  "/vehicles",
  "/vehicles/new",
  "/vehicles/:id",
  "/vehicles/:id/edit",
  "/vehicles/:id/sell",
  "/sales",
  "/sales/:id",
  "/capture",
  "/assist",
  "/copilot",
  "/docs",
  "/docs/:slug",
  "/receivables",
  "/customers",
  "/settings",
  "/intake",
  "/sell",
  "/expenses",
  "/users",
  "/audit",
  "/approvals",
  "/other",
] as const;
const routes = new Set<string>(RUNTIME_ROUTES);
export type RuntimeIssue = {
  source: (typeof RUNTIME_SOURCES)[number];
  code: (typeof RUNTIME_CODES)[number];
  operation: string;
  route: string;
  release: string;
  environment: "production" | "staging" | "development";
};

export function runtimeRoute(path: string): string {
  const clean = path.split(/[?#]/, 1)[0].replace(/\/$/, "") || "/";
  if (routes.has(clean)) return clean;
  if (/^\/vehicles\/[^/]+\/edit$/.test(clean)) return "/vehicles/:id/edit";
  if (/^\/vehicles\/[^/]+\/sell$/.test(clean)) return "/vehicles/:id/sell";
  if (/^\/vehicles\/[^/]+$/.test(clean)) return "/vehicles/:id";
  if (/^\/sales\/[^/]+$/.test(clean)) return "/sales/:id";
  if (/^\/docs\/[^/]+$/.test(clean)) return "/docs/:slug";
  return "/other";
}

export function runtimeRelease(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return /^v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z]{1,12})?$/.test(value) ||
    (/^[a-f0-9]{7,40}$/i.test(value) && /[a-f]/i.test(value))
    ? value.toLowerCase()
    : "unknown";
}

export function safeRuntimeIssue(
  input: Record<string, unknown>,
): RuntimeIssue | null {
  if (
    !(RUNTIME_SOURCES as readonly unknown[]).includes(input.source) ||
    !(RUNTIME_CODES as readonly unknown[]).includes(input.code)
  )
    return null;
  return {
    source: input.source as RuntimeIssue["source"],
    code: input.code as RuntimeIssue["code"],
    operation:
      typeof input.operation === "string" && operations.has(input.operation)
        ? input.operation
        : "other",
    route: runtimeRoute(
      typeof input.route === "string" ? input.route : "/other",
    ),
    release: runtimeRelease(input.release),
    environment:
      input.environment === "staging" || input.environment === "development"
        ? input.environment
        : "production",
  };
}

type Delivery = "sent" | "retry" | "disabled";
/** A tiny memory-only queue; it does not persist data or block the user workflow. */
export function createRuntimeReporter(options: {
  send: (issue: RuntimeIssue) => Promise<Delivery>;
  now?: () => number;
  online?: () => boolean;
  schedule?: boolean;
}) {
  const now = options.now ?? Date.now;
  const queue: { issue: RuntimeIssue; attempts: number }[] = [];
  const seen = new Map<string, number>();
  const sends: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false,
    disabled = false,
    disposed = false;
  const schedule = (delay = 5000) => {
    if (
      options.schedule === false ||
      timer ||
      disposed ||
      disabled ||
      !queue.length
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };
  const flush = async () => {
    if (busy || disabled || disposed || !queue.length) return;
    if (options.online && !options.online()) {
      schedule(20000);
      return;
    }
    const time = now();
    while (sends.length && sends[0] <= time - 600000) sends.shift();
    if (sends.length >= 20) {
      schedule(20000);
      return;
    }
    busy = true;
    const entry = queue[0];
    sends.push(time);
    let outcome: Delivery;
    try {
      outcome = await options.send(entry.issue);
    } catch {
      outcome = "retry";
    }
    if (outcome === "disabled") {
      disabled = true;
      queue.length = 0;
    } else if (outcome === "sent" || ++entry.attempts >= 3) queue.shift();
    busy = false;
    schedule(outcome === "retry" ? 20000 : 5000);
  };
  return {
    report(input: Record<string, unknown>): boolean {
      if (disabled || disposed) return false;
      const issue = safeRuntimeIssue(input);
      if (!issue) return false;
      const time = now(),
        key = JSON.stringify(issue);
      for (const [item, last] of seen)
        if (last <= time - 60000) seen.delete(item);
      if (seen.has(key) || queue.length >= 20) return false;
      seen.set(key, time);
      queue.push({ issue, attempts: 0 });
      schedule();
      return true;
    },
    flush,
    dispose() {
      disposed = true;
      queue.length = 0;
      if (timer) clearTimeout(timer);
    },
  };
}
