/**
 * Trustworthy correlation between the rows a confirmed `import_vehicles`
 * write created and the intake entries the user submitted. The RPC already
 * returns `vehicle_ids` aligned with row order (and the operation receipt
 * stores that same result, so a replayed/reconciled write returns it too) —
 * searching the inventory by substring afterwards was never necessary and
 * breaks on ambiguous plates or concurrent imports. Only a well-formed,
 * exactly-length-matched id list is trusted; anything else yields nulls and
 * the caller must fall back to a UNIQUE exact identifier match, never a guess.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Align server-returned created ids with the submitted entries by index.
 * A malformed or mis-aligned list is treated as absent, entry by entry.
 */
export function alignCreatedIds(entryCount: number, createdIds: unknown): (string | null)[] {
  const aligned: (string | null)[] = new Array<string | null>(entryCount).fill(null);
  if (!Array.isArray(createdIds) || createdIds.length !== entryCount) return aligned;
  for (const [index, value] of createdIds.entries()) {
    if (typeof value === "string" && UUID_V4.test(value)) aligned[index] = value;
  }
  return aligned;
}

/**
 * Was the whole alignment trustworthy? Photo attachment decides per entry, but
 * reporting distinguishes "server gave us ids" from "we had to re-look-up".
 */
export function hasTrustedIds(ids: (string | null)[]): boolean {
  return ids.length > 0 && ids.every((id) => id !== null);
}
