/**
 * Shared helper for URL query-string updates (A7): setting one filter must
 * never clobber unrelated params (search, page, date range, customer…).
 * A null/undefined/empty value removes the param — the only way a param
 * disappears is an intentional clear.
 */
export type ParamChanges = Record<string, string | null | undefined>;

export function mergeSearchParams(
  prev: URLSearchParams,
  changes: ParamChanges,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }
  return next;
}
