export const money = (value: number | string | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("vi-VN", {
        style: "currency",
        currency: "VND",
        maximumFractionDigits: 0,
      }).format(Number(value));
export const compactMoney = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("vi-VN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value) + " ₫";
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const dateLabel = (value?: string | null) => {
  if (!value) return "—";
  const trimmed = typeof value === "string" ? value.trim() : String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return isoToDisplayDate(trimmed);
  }
  try {
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Asia/Ho_Chi_Minh",
    }).format(d);
  } catch {
    return "—";
  }
};

/** Converts ISO date (YYYY-MM-DD) to Vietnamese display date (DD/MM/YYYY) without timezone drift */
export const isoToDisplayDate = (iso?: string | null): string => {
  if (!iso || typeof iso !== "string") return "";
  const trimmed = iso.trim().slice(0, 10);
  const parts = trimmed.split("-");
  if (parts.length !== 3 || parts[0].length !== 4) return "";
  const [y, m, d] = parts;
  return `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`;
};

/** Converts Vietnamese display date (DD/MM/YYYY) to ISO date (YYYY-MM-DD) with calendar validation and no timezone drift */
export const displayToIsoDate = (display?: string | null): string => {
  if (!display || typeof display !== "string") return "";
  const trimmed = display.trim();
  const match = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return "";
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    year < 1900 ||
    year > 2100
  )
    return "";
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Shifts a date-only YYYY-MM-DD string by a number of days using pure calendar UTC math without timezone shift */
export const shiftDate = (dateStr: string, days: number): string => {
  const trimmed = dateStr.slice(0, 10);
  const parts = trimmed.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr;
  const [y, m, d] = parts;
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
};

export const daysInStock = (value: string) =>
  Math.max(
    0,
    Math.round(
      (Date.parse(today()) - Date.parse(value.slice(0, 10))) / 86400000,
    ),
  );
export const monthRange = () => ({
  from: today().slice(0, 7) + "-01",
  to: today(),
});
export const datePreset = (preset: string) => {
  const now = new Date(today() + "T00:00:00Z");
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = iso(now);
  if (preset === "today") return { from: end, to: end };
  if (preset === "yesterday") {
    now.setUTCDate(now.getUTCDate() - 1);
    const yest = iso(now);
    return { from: yest, to: yest };
  }
  if (preset === "week") {
    now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    return { from: iso(now), to: end };
  }
  if (preset === "last-month")
    return {
      from: iso(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
      ),
      to: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))),
    };
  if (preset === "month" || preset === "this-month") {
    return monthRange();
  }
  return monthRange();
};
