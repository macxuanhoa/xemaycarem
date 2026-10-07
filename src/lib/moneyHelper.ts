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

  // A trailing digit tail is the decimal of the unit itself: 82tr5 = 82.500.000.
  const shorthand = text.match(
    /^(\d+)(?:[.,](\d{1,6}))?\s*(tr|m|k|ty|tỷ|b)(\d{1,2})?$/u,
  );
  if (shorthand) {
    const multiplier =
      shorthand[3] === "k"
        ? 1_000n
        : ["tr", "m"].includes(shorthand[3])
          ? 1_000_000n
          : 1_000_000_000n;
    const fraction = shorthand[2] ?? "";
    const tail = shorthand[4] ?? "";
    const denominator = 10n ** BigInt(fraction.length + tail.length);
    const numerator =
      BigInt(shorthand[1]) * denominator +
      BigInt(fraction || "0") * 10n ** BigInt(tail.length) +
      BigInt(tail || "0") * 10n ** BigInt(fraction.length);
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
  const integer = Math.floor(Math.abs(val));
  const formatted = integer.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return val < 0 ? `-${formatted}` : formatted;
}

export function formatVndDisplay(val: number | undefined | null): string {
  if (val == null || !Number.isFinite(val)) return "0 ₫";
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(val);
}

const VN_DIGITS = [
  "không",
  "một",
  "hai",
  "ba",
  "bốn",
  "năm",
  "sáu",
  "bảy",
  "tám",
  "chín",
];

function readThreeDigits(
  hundreds: number,
  tens: number,
  units: number,
  readZeroHundred: boolean,
): string {
  let result = "";
  if (hundreds === 0 && tens === 0 && units === 0) return "";
  if (hundreds > 0 || readZeroHundred) {
    result += `${VN_DIGITS[hundreds]} trăm `;
    if (tens === 0 && units > 0) result += "lẻ ";
  }
  if (tens > 1) {
    result += `${VN_DIGITS[tens]} mươi `;
    if (units === 1) result += "mốt ";
    else if (units === 4) result += "tư ";
    else if (units === 5) result += "lăm ";
    else if (units > 0) result += `${VN_DIGITS[units]} `;
  } else if (tens === 1) {
    result += "mười ";
    if (units === 1) result += "một ";
    else if (units === 5) result += "lăm ";
    else if (units > 0) result += `${VN_DIGITS[units]} `;
  } else if (tens === 0 && units > 0) {
    result += `${VN_DIGITS[units]} `;
  }
  return result.trim();
}

/** Converts integer VND amount to natural Vietnamese words (e.g. 82.000.000 -> "Tám mươi hai triệu đồng") */
export function formatVndWords(val: number | undefined | null): string {
  if (val == null || !Number.isFinite(val) || val < 0) return "";
  const num = Math.floor(val);
  if (num === 0) return "Không đồng";
  if (num > 1_000_000_000_000) return "";

  const units = num % 1000;
  const thousands = Math.floor(num / 1_000) % 1000;
  const millions = Math.floor(num / 1_000_000) % 1000;
  const billions = Math.floor(num / 1_000_000_000) % 1000;
  const trillions = Math.floor(num / 1_000_000_000_000);

  const parts: string[] = [];
  if (trillions > 0) {
    parts.push(`${VN_DIGITS[trillions]} nghìn tỷ`);
  }
  if (billions > 0) {
    const h = Math.floor(billions / 100);
    const t = Math.floor((billions % 100) / 10);
    const u = billions % 10;
    parts.push(`${readThreeDigits(h, t, u, parts.length > 0)} tỷ`);
  }
  if (millions > 0) {
    const h = Math.floor(millions / 100);
    const t = Math.floor((millions % 100) / 10);
    const u = millions % 10;
    parts.push(`${readThreeDigits(h, t, u, parts.length > 0)} triệu`);
  }
  if (thousands > 0) {
    const h = Math.floor(thousands / 100);
    const t = Math.floor((thousands % 100) / 10);
    const u = thousands % 10;
    parts.push(`${readThreeDigits(h, t, u, parts.length > 0)} nghìn`);
  }
  if (units > 0) {
    const h = Math.floor(units / 100);
    const t = Math.floor((units % 100) / 10);
    const u = units % 10;
    parts.push(readThreeDigits(h, t, u, parts.length > 0));
  }

  const raw = `${parts.join(" ").trim()} đồng`;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Formats VND amount to human-readable compact approximation (e.g. 82000000 -> "≈ 82 triệu đồng") */
export function formatVndApproxText(val: number | undefined | null): string {
  if (val == null || !Number.isFinite(val) || val <= 0) return "";
  if (val >= 1_000_000_000) {
    const ty = val / 1_000_000_000;
    const formatted =
      ty % 1 === 0
        ? ty.toString()
        : ty.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
    return `≈ ${formatted} tỷ đồng`;
  }
  if (val >= 1_000_000) {
    const tr = val / 1_000_000;
    const formatted =
      tr % 1 === 0
        ? tr.toString()
        : tr.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
    return `≈ ${formatted} triệu đồng`;
  }
  if (val >= 1_000) {
    const k = val / 1_000;
    const formatted =
      k % 1 === 0
        ? k.toString()
        : k.toFixed(1).replace(/\.?0+$/, "").replace(".", ",");
    return `≈ ${formatted} nghìn đồng`;
  }
  return `${val.toLocaleString("vi-VN")} đồng`;
}

