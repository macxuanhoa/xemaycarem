/** Strict VND parsing. Malformed or unsafe input must never become a different amount. */
export function parseMoneyInput(
  raw: string | number | undefined | null,
): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number")
    return Number.isSafeInteger(raw) && raw >= 0 && raw <= 1_000_000_000_000
      ? raw
      : undefined;
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/\s*(?:₫|đ|vnd)$/u, "")
    .trim();
  if (!text || text.length > 40) return undefined;

  const shorthand = text.match(/^(\d+)(?:[.,](\d{1,6}))?\s*(tr|m|k|ty|tỷ|b)$/u);
  if (shorthand) {
    const multiplier =
      shorthand[3] === "k"
        ? 1_000n
        : ["tr", "m"].includes(shorthand[3])
          ? 1_000_000n
          : 1_000_000_000n;
    const fraction = shorthand[2] ?? "";
    const denominator = 10n ** BigInt(fraction.length);
    const numerator =
      BigInt(shorthand[1]) * denominator + BigInt(fraction || "0");
    const result = (numerator * multiplier + denominator / 2n) / denominator;
    const number = Number(result);
    return Number.isSafeInteger(number) && number <= 1_000_000_000_000
      ? number
      : undefined;
  }
  // A separator is valid only as a thousands grouping. Decimal VND is not accepted.
  const valid =
    /^\d+$/.test(text) ||
    /^\d{1,3}(?:\.\d{3})+$/.test(text) ||
    /^\d{1,3}(?:,\d{3})+$/.test(text) ||
    /^\d{1,3}(?: \d{3})+$/.test(text);
  if (!valid) return undefined;
  const number = Number(text.replace(/[., ]/g, ""));
  return Number.isSafeInteger(number) && number <= 1_000_000_000_000
    ? number
    : undefined;
}

export function formatVndNumber(val: number | undefined | null): string {
  if (val == null || !Number.isFinite(val)) return "";
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(
    val,
  );
}

export function formatVndDisplay(val: number | undefined | null): string {
  if (val == null || !Number.isFinite(val)) return "0 ₫";
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(val);
}
