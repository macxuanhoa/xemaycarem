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
export const dateLabel = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "Asia/Ho_Chi_Minh",
      }).format(
        new Date(value.length === 10 ? value + "T00:00:00+07:00" : value),
      )
    : "—";
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
    return { from: iso(now), to: iso(now) };
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
  return monthRange();
};
