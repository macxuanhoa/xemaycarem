import type { DebtStatus, Sale } from "@/types";
import { today } from "@/lib/format";

/**
 * One canonical debt-status resolver shared by desktop tables and mobile
 * cards (A3). The server (`private.sale_json`) is authoritative: it already
 * ships `debt_status`/`is_overdue` computed in one place. The client-side
 * fallback below only runs for legacy payloads and MUST match the server
 * semantics exactly.
 */
type DebtLike = Pick<Sale, "status"> &
  Partial<
    Pick<
      Sale,
      "debt_status" | "is_overdue" | "paid_amount" | "remaining_amount" | "due_date"
    >
  >;

export function resolveDebtStatus(sale: DebtLike): DebtStatus {
  if (sale.status === "CANCELLED") return "CANCELLED";
  // Prefer the server-computed status whenever present.
  if (sale.debt_status) return sale.debt_status;
  const remaining = sale.remaining_amount ?? 0;
  // Overpaid sales clamp to remaining = 0 on the server, so they land on PAID.
  if (remaining <= 0) return "PAID";
  return (sale.paid_amount ?? 0) > 0 ? "PARTIALLY_PAID" : "UNPAID";
}

/** True when the receivable passed its due date with money still owing. */
export function resolveIsOverdue(sale: DebtLike, todayIso: string = today()): boolean {
  if (typeof sale.is_overdue === "boolean") return sale.is_overdue;
  if (sale.status === "CANCELLED") return false;
  return (
    !!sale.due_date &&
    sale.due_date < todayIso &&
    (sale.remaining_amount ?? 0) > 0
  );
}
