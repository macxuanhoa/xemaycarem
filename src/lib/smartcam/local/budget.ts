/**
 * Cloud AI budget and cost tracking. Local recognition is free; every paid
 * provider call (the ai-assist `vehicle_scan` task → OpenAI) must pass the
 * budget check and land in the ledger, so "how many API calls did this scan
 * session cost?" is always answerable from real numbers, never estimates.
 */

export type CloudCall = {
  /** Epoch ms of the request. */
  ts: number;
  /** Deduplication target (scanTargetKey) the call was made for. */
  targetKey: string;
  /** Round-trip latency in ms (0 when the call failed before completing). */
  latencyMs: number;
  /** JPEG bytes actually sent. */
  imageBytes: number;
  /** "ok" | "error" — errors are recorded too, they still cost a request. */
  outcome: "ok" | "error";
};

export type BudgetRules = {
  /** Hard cap of paid calls per rolling hour. */
  perHour: number;
  /** Paid calls allowed for the same scan target (one attempt per vehicle). */
  perTarget: number;
};

export const DEFAULT_BUDGET: BudgetRules = { perHour: 6, perTarget: 1 };

export type BudgetVerdict = { ok: true } | { ok: false; reason: "HOURLY_LIMIT" | "TARGET_LIMIT" };

const HOUR_MS = 3_600_000;

/** Pure gate over an existing ledger. */
export function cloudAllowed(calls: CloudCall[], now: number, targetKey: string, rules = DEFAULT_BUDGET): BudgetVerdict {
  const since = now - HOUR_MS;
  const recent = calls.filter((call) => call.ts >= since);
  if (recent.length >= rules.perHour) return { ok: false, reason: "HOURLY_LIMIT" };
  if (targetKey && recent.filter((call) => call.targetKey === targetKey).length >= rules.perTarget)
    return { ok: false, reason: "TARGET_LIMIT" };
  return { ok: true };
}

/** Immutable append with a size cap (newest last). */
export function recordCall(calls: CloudCall[], call: CloudCall, cap = 300): CloudCall[] {
  return [...calls, call].slice(-cap);
}

export type BudgetSummary = { callsLastHour: number; callsToday: number; bytesToday: number; perHour: number };

export function summarize(calls: CloudCall[], now: number, rules = DEFAULT_BUDGET): BudgetSummary {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const since = now - HOUR_MS;
  const today = calls.filter((call) => call.ts >= dayStart.getTime());
  return {
    callsLastHour: calls.filter((call) => call.ts >= since).length,
    callsToday: today.length,
    bytesToday: today.reduce((sum, call) => sum + call.imageBytes, 0),
    perHour: rules.perHour,
  };
}

const LEDGER_KEY = "xe_crm_smartcam_cloud_ledger_v1";

function parseCall(value: unknown): CloudCall | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.ts !== "number" || typeof row.imageBytes !== "number") return null;
  return {
    ts: row.ts,
    targetKey: typeof row.targetKey === "string" ? row.targetKey.slice(0, 160) : "",
    latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : 0,
    imageBytes: row.imageBytes,
    outcome: row.outcome === "error" ? "error" : "ok",
  };
}

export function loadLedger(): CloudCall[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? "null");
    if (!Array.isArray(raw)) return [];
    return raw.map(parseCall).filter((row): row is CloudCall => row !== null);
  } catch {
    return [];
  }
}

export function saveLedger(calls: CloudCall[]): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(calls));
  } catch {
    /* The ledger is observability, not a hard dependency. */
  }
}
