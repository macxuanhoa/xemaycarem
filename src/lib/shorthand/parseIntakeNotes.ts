/**
 * Turns free-form shorthand notes (typed on a phone in Notes/Zalo/Messenger)
 * into structured vehicle-intake drafts, one draft per line.
 *
 * The parser is pure: the learned dictionary is injected so the same module
 * works in the page, in unit tests and offline. Unknown tokens are never
 * guessed into a financial field — they surface as `unknownTokens` for the
 * user to assign or teach.
 */
import {
  COLOR_ALIASES,
  DEFAULT_VEHICLE_TYPE_NAMES,
  KEYWORD_FIELDS,
  STOP_TOKENS,
  VEHICLE_TYPE_ALIASES,
  matchVehicleType,
  normalizeKey,
  vehicleTypeKey,
} from "./vocabulary";
import { normalizePlate } from "@/lib/plate";
import { normalizeVehicleYear } from "@/lib/vehicleInputFormatting";

export type IntakeFieldKey =
  | "vehicle_type"
  | "color"
  | "frame_number"
  | "license_plate"
  | "year"
  | "purchase_date"
  | "purchase_price"
  | "supplier_name"
  | "supplier_phone"
  | "notes";

export const INTAKE_FIELDS: { key: IntakeFieldKey; label: string }[] = [
  { key: "vehicle_type", label: "Loại xe" },
  { key: "color", label: "Màu sắc" },
  { key: "frame_number", label: "Số khung" },
  { key: "license_plate", label: "Biển số" },
  { key: "year", label: "Năm sản xuất" },
  { key: "purchase_date", label: "Ngày thu" },
  { key: "purchase_price", label: "Giá thu" },
  { key: "supplier_name", label: "Tên người bán" },
  { key: "supplier_phone", label: "SĐT người bán" },
  { key: "notes", label: "Ghi chú" },
];

export type LearnedRule = {
  key: string;
  field: IntakeFieldKey;
  value: string;
  count?: number;
  updatedAt?: number;
};
export type LearnedDictionary = Record<string, LearnedRule>;

export type IntakeEntry = {
  id: string;
  sourceLine: string;
  fields: Partial<Record<IntakeFieldKey, string>>;
  /** Which raw token produced each field — powers "teach this abbreviation". */
  provenance: Partial<Record<IntakeFieldKey, string>>;
  unknownTokens: string[];
  /**
   * Smart Camera provenance per field (see `@/lib/smartcam/recognition`).
   * The shorthand parser never sets it; only the camera handoff does, so the
   * review cards can highlight values that still need a human check.
   */
  fieldStatus?: Partial<Record<IntakeFieldKey, "VERIFIED" | "SUGGESTED" | "UNREADABLE" | "CONFLICT">>;
  /** Approved Smart Camera photos (dataURLs) uploaded after the save. */
  photos?: string[];
};

/** VND shorthand: "18tr5" → 18_500_000, "1.2ty" → 1_200_000_000, "450k" → 450_000. */
export function parseShorthandMoney(raw: string): number | null {
  let t = normalizeKey(raw)
    .replace(/\s+/g, "")
    .replaceAll("trieu", "tr")
    .replaceAll("nghin", "k")
    .replaceAll("ngan", "k")
    .replaceAll("ty", "ty");
  if (!t || t.length > 24) return null;
  const shorthand = t.match(/^(\d+(?:[.,]\d{1,6})?)(k|tr|m|ty|b)(\d{1,2})?$/);
  if (shorthand) {
    const unit =
      shorthand[2] === "k"
        ? 1_000
        : shorthand[2] === "ty" || shorthand[2] === "b"
          ? 1_000_000_000
          : 1_000_000;
    const base = Number(shorthand[1].replace(",", "."));
    if (!Number.isFinite(base)) return null;
    let value = base * unit;
    if (shorthand[3]) value += (Number(shorthand[3]) / 10 ** shorthand[3].length) * unit;
    value = Math.round(value);
    return value >= 0 && value <= 1_000_000_000_000 ? value : null;
  }
  // Grouped full amount: 18.000.000 / 18,000,000 / 18 000 000
  if (/^\d{1,3}([., ]\d{3})+$/.test(t)) return Number(t.replaceAll(/[., ]/g, ""));
  t = t.replaceAll(/[., ]/g, "");
  // Bare large amounts are prices; small bare numbers are handled elsewhere.
  if (/^\d{6,12}$/.test(t)) return Number(t);
  return null;
}

/** Vietnamese plate: 29b1 123.45 / 51X1-887.65 / 29-A1-1234 → "29-B1 123.45".
 *  The canonical implementation lives in `@/lib/plate`; re-exported here so the
 *  shorthand parser and its callers keep a single source of truth. */
export { normalizePlate };

function isoDate(raw: string): string | null {
  const m = raw.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year = m[3] ? Number(m[3]) : new Date().getFullYear();
  if (year < 100) year += year > 80 ? 1900 : 2000;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return iso <= `${new Date().getFullYear() + 1}-12-31` ? iso : null;
}

function parsePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^0\d{9}$/.test(digits)) return digits;
  if (/^\+?84\d{9}$/.test(digits)) return "0" + digits.slice(-9);
  return null;
}

const FRAME_LIKE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,39}$/;

/** True for mixed letter/digit codes like RLH160-001 or MH1JC2116KE... */
function looksLikeFrame(token: string): boolean {
  if (!FRAME_LIKE.test(token)) return false;
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  return normalizePlate(token) === null;
}

type TypeMatch = { name: string; start: number; end: number };

/**
 * Điểm nối của khoá từng token khi ghép cả dòng lại (luôn bắt đầu bằng 0 và
 * kết thúc bằng tổng độ dài) — dùng làm ranh giới để khớp tên loại xe.
 */
function typeKeyBounds(tokens: string[]): number[] {
  const bounds: number[] = [0];
  for (const token of tokens) bounds.push(bounds[bounds.length - 1] + vehicleTypeKey(token).length);
  return bounds;
}

/**
 * Nhận loại xe trên cả dòng, không chỉ từng token một, vì tên danh mục tiếng
 * Việt hay có khoảng trắng ("tay ga", "ga 50 cc"). Các token được nối thành
 * một chuỗi khoá không khoảng trắng; một ứng viên chỉ hợp lệ khi điểm đầu và
 * điểm cuối của nó trùng đúng ranh giới token — nhờ đó "so" trong mã khung hoặc
 * biển số không bị hiểu nhầm là "Xe số".
 *
 * Kết quả luôn là tên có thật trong danh mục đang dùng (matchVehicleType);
 * không khớp thì trả null để token rơi vào hàng đợi chip lạ + Ghi chú. Hãng xe,
 * dòng xe đã bị xoá nên không còn chuyện "token lạ thành Dòng xe".
 */
function findVehicleType(
  tokens: string[],
  bounds: number[],
  catalogue: readonly string[],
): TypeMatch | null {
  const joined = tokens.map((token) => vehicleTypeKey(token)).join("");
  if (!joined) return null;
  const boundary = new Set(bounds);
  const needles = new Set<string>();
  for (const name of catalogue) {
    const key = vehicleTypeKey(name);
    if (key.length >= 2) needles.add(key);
  }
  for (const alias of Object.keys(VEHICLE_TYPE_ALIASES)) {
    if (alias.length >= 2) needles.add(alias);
  }
  let best: TypeMatch | null = null;
  for (const needle of needles) {
    const name = matchVehicleType(needle, catalogue);
    if (!name) continue;
    let at = joined.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      if (boundary.has(at) && boundary.has(end)) {
        if (
          !best ||
          at < best.start ||
          (at === best.start && end - at > best.end - best.start)
        )
          best = { name, start: at, end };
      }
      at = joined.indexOf(needle, at + 1);
    }
  }
  return best;
}

/** Số token bị loại xe ăn mất, tính từ chuỗi khoá đã nối. */
function tokenSpan(bounds: number[], match: TypeMatch): number {
  const from = bounds.indexOf(match.start);
  let to = from;
  while (to + 1 < bounds.length && bounds[to + 1] < match.end) to++;
  return to - from + 1;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `e${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

type Pending =
  | { field: IntakeFieldKey }
  | { field: "price" }
  | { field: "supplier_name"; started: boolean }
  | { field: "notes" }
  | null;

function assign(
  entry: IntakeEntry,
  field: IntakeFieldKey,
  value: string,
  token: string,
): boolean {
  if (entry.fields[field] !== undefined) {
    // A second candidate for the same field is never silently dropped.
    entry.unknownTokens.push(token);
    return false;
  }
  entry.fields[field] = value;
  entry.provenance[field] = token;
  return true;
}

/** Parse one line into an entry; returns null for empty/heading lines. */
function parseLine(
  line: string,
  dictionary: LearnedDictionary,
  yearNow: number,
  catalogue: readonly string[],
): IntakeEntry | null {
  const cleaned = line
    .replace(/^\s*(?:[-*•°·]|(?:\d{1,2}[.)]))\s*/, "")
    .trim();
  if (!cleaned || /^[#=]/.test(cleaned)) return null;

  const entry: IntakeEntry = {
    id: newId(),
    sourceLine: cleaned,
    fields: {},
    provenance: {},
    unknownTokens: [],
  };
  const rawTokens = cleaned
    // "19,5tr" is a decimal amount, and "12/03/26" is a date: commas between
    // digits become dots, slashes stay inside tokens, blanks separate them.
    .replace(/(\d)[_,](\d)/g, "$1.$2")
    .replace(/[,;]+(?=\s|$)/g, "")
    .split(/[\s|]+/u)
    .filter(Boolean);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const current = rawTokens[i];
    const next = normalizeKey(rawTokens[i + 1] ?? "");
    const amount = /^\d+(?:[.,]\d{1,6})?$/.test(current);
    const moneyUnit = /^(?:tr|trieu|m|k|ty|b|nghin|ngan)\d{0,2}$/.test(next);
    if (amount && moneyUnit) {
      tokens.push(current + next);
      i++;
    } else {
      tokens.push(current);
    }
  }
  // Loại xe được quét trước, ngay trên cả dòng, rồi ăn bớt đúng các token đã
  // khớp. Số máy/số km/phiên bản không còn nên không có gì để tách sau đó.
  const bounds = typeKeyBounds(tokens);
  const typeMatch = findVehicleType(tokens, bounds, catalogue);
  let cursor = tokens;
  if (typeMatch) {
    const from = bounds.indexOf(typeMatch.start);
    const count = tokenSpan(bounds, typeMatch);
    cursor = tokens.filter(
      (_, index) => index < from || index >= from + count,
    );
    assign(
      entry,
      "vehicle_type",
      typeMatch.name,
      tokens.slice(from, from + count).join(" "),
    );
  }
  let pending: Pending = null;
  let nameWords: string[] = [];
  const noteChunks: string[] = [];

  const flushName = () => {
    if (nameWords.length) {
      const joined = nameWords.join(" ").trim();
      if (joined) assign(entry, "supplier_name", joined, nameWords[0]);
      nameWords = [];
    }
  };

  for (let i = 0; i < cursor.length; i++) {
    const token = token_surface(cursor[i]);
    const key = normalizeKey(token);
    if (!key) continue;

    // "#ghi chú" flips the rest of the line into the Ghi chú field (and the
    // text glued after "#" seeds it too). A line-leading "#" is still a
    // heading/comment handled by the caller above — this only fires inline.
    if (token.startsWith("#")) {
      const inline = token.slice(1).trim();
      if (inline) noteChunks.push(inline);
      pending = { field: "notes" };
      continue;
    }

    // "ghichu: ..." swallows the remainder of the line verbatim.
    if (pending?.field === "notes") {
      noteChunks.push(token);
      continue;
    }

    // Biển số được thử trước và tham lam: nhân viên không cần viết "bs", và
    // một biển gõ tách khoảng ("59a1 234.56") không được rò sang nhóm năm
    // sản xuất. Nếu token hiện tại chưa phải biển nhưng nối với token kế thì
    // thành biển, ăn cả hai để "bs" thực sự là tuỳ chọn.
    const plateSingle = normalizePlate(token);
    if (plateSingle) {
      assign(entry, "license_plate", plateSingle, token);
      if (pending?.field === "license_plate") pending = null;
      continue;
    }
    if (i + 1 < cursor.length) {
      const next = token_surface(cursor[i + 1]);
      const joined = normalizePlate(token + next);
      if (joined) {
        assign(entry, "license_plate", joined, `${token} ${next}`);
        if (pending?.field === "license_plate") pending = null;
        i++;
        continue;
      }
    }

    // A keyword arms the next token for a specific field.
    if (pending && pending.field !== "supplier_name") {
      const consumed = tryAssignTyped(
        entry,
        pending.field,
        token,
        key,
        yearNow,
        catalogue,
      );
      if (consumed) {
        pending = null;
        continue;
      }
      pending = null; // fall through and classify this token normally
    }

    // Learned abbreviation wins over the built-in vocabulary.
    const rule = dictionary[key];
    if (rule) {
      const learnedYear =
        rule.field === "year" ? normalizeVehicleYear(rule.value) : undefined;
      assign(
        entry,
        rule.field,
        learnedYear == null ? rule.value : String(learnedYear),
        token,
      );
      continue;
    }

    // Name capture accumulates unknown words until a classifiable token.
    if (pending && pending.field === "supplier_name") {
      // Right after "chu/a/chi", "Nam" is almost always a person, not a year.
      const nameLikeYear =
        nameWords.length === 0 && KEYWORD_FIELDS[key] === "year";
      if (
        (nameLikeYear ||
          !isClassifiable(token, key, yearNow)) &&
        !STOP_TOKENS.has(key) &&
        nameWords.length < 4
      ) {
        nameWords.push(token);
        continue;
      }
      flushName();
      pending = null;
    }

    if (STOP_TOKENS.has(key)) continue;

    // Plate was already tested at the top of the loop (with the 2-token
    // look-ahead); these remaining strong patterns are ordered so a phone
    // or date token is never mistaken for money, and a money token is
    // never mistaken for a bare year.
    const phone = parsePhone(token);
    if (phone) {
      // A second phone number lands in unknownTokens via assign(), never as a price.
      assign(entry, "supplier_phone", phone, token);
      continue;
    }
    const date = isoDate(token);
    if (date) {
      assign(entry, "purchase_date", date, token);
      continue;
    }
    const money = parseShorthandMoney(token);
    if (money !== null) {
      // Giá thu là số tiền duy nhất hồ sơ xe giữ. Amount thứ hai là giá bán
      // (thời điểm đó chưa có gì chắc) — giá bán giờ chỉ sinh ra từ phiếu Bán
      // xe, nên số này chỉ còn là chip để nhân viên gán vào Ghi chú.
      if (!entry.fields.purchase_price)
        assign(entry, "purchase_price", String(money), token);
      else entry.unknownTokens.push(token);
      continue;
    }
    if (/^\d{4}$/.test(key)) {
      const value = Number(key);
      if (value >= 1980 && value <= yearNow + 1) {
        assign(entry, "year", String(value), token);
        continue;
      }
    }
    if (/^\d{1,2}$/.test(key) && pending === null) {
      // "22" hoặc "'22" — năm sản xuất viết tắt.
      const value = normalizeVehicleYear(key);
      if (Number(key) <= 30 && value != null && value <= yearNow + 1 && !entry.fields.year) {
        assign(entry, "year", String(value), token);
        continue;
      }
    }

    // Mã khung: chỉ nhận lượt đầu; mã thứ hai thành chip lạ (số máy đã bị xoá
    // vĩnh viễn nên không còn chỗ nào để nhét nó).
    if (looksLikeFrame(token)) {
      if (!entry.fields.frame_number)
        assign(entry, "frame_number", token.toUpperCase(), token);
      else entry.unknownTokens.push(token);
      continue;
    }

    // Vocabulary aliases.
    const keyword = KEYWORD_FIELDS[key];
    if (keyword === "price") {
      pending = { field: "price" };
      continue;
    }
    if (keyword === "supplier_name") {
      pending = { field: "supplier_name", started: false };
      continue;
    }
    if (keyword === "notes") {
      pending = { field: "notes" };
      continue;
    }
    if (keyword) {
      pending = { field: keyword as IntakeFieldKey };
      continue;
    }
    const color = COLOR_ALIASES[key];
    if (color) {
      assign(entry, "color", color, token);
      continue;
    }

    // Không còn quy tắc "token lạ rơi vào Dòng xe": mọi từ chưa nhận diện được
    // chỉ thành chip trong hàng đợi để nhân viên gán vào Ghi chú hoặc dạy lại.
    entry.unknownTokens.push(token);
  }

  if (pending?.field === "supplier_name") flushName();
  if (noteChunks.length)
    assign(
      entry,
      "notes",
      [...noteChunks, ...(entry.fields.notes ? [entry.fields.notes] : [])].join(" "),
      "ghichu",
    );

  return entry;
}

function tryAssignTyped(
  entry: IntakeEntry,
  field: string,
  token: string,
  key: string,
  yearNow: number,
  catalogue: readonly string[],
): boolean {
  if (field === "price") {
    const money = parseShorthandMoney(token);
    if (money === null) return false;
    return assign(entry, "purchase_price", String(money), token);
  }
  if (field === "supplier_phone") {
    const phone = parsePhone(token);
    if (!phone) return false;
    return assign(entry, "supplier_phone", phone, token);
  }
  if (field === "purchase_date") {
    const date = isoDate(token);
    if (!date) return false;
    return assign(entry, "purchase_date", date, token);
  }
  if (field === "year") {
    const value = normalizeVehicleYear(token);
    if (value == null || value < 1980 || value > yearNow + 1) return false;
    return assign(entry, "year", String(value), token);
  }
  if (field === "vehicle_type") {
    // Chỉ nhận đúng một tên có trong danh mục — không bao giờ lưu tên tự gõ.
    const name = matchVehicleType(token, catalogue);
    if (!name) return false;
    return assign(entry, "vehicle_type", name, token);
  }
  if (field === "license_plate") {
    // Strict: the top-of-loop plate detector already tried both the single
    // token and the 2-token join. If we're here, neither worked, so "bs <x>"
    // with a garbage x must NOT become a bogus plate — leave the token for
    // normal classification / unknown-token review instead.
    const plate = normalizePlate(token);
    if (!plate) return false;
    return assign(entry, "license_plate", plate, token);
  }
  if (field === "frame_number") {
    if (!/[A-Za-z0-9]/.test(token) || key.length < 2) return false;
    return assign(entry, "frame_number", token.toUpperCase(), token);
  }
  return false;
}

function isClassifiable(token: string, key: string, yearNow: number): boolean {
  return Boolean(
    /^\d+$/.test(key) ||
      normalizePlate(token) ||
      parsePhone(token) ||
      isoDate(token) ||
      parseShorthandMoney(token) !== null ||
      COLOR_ALIASES[key] ||
      KEYWORD_FIELDS[key] ||
      (/^\d{4}$/.test(key) && Number(key) >= 1980 && Number(key) <= yearNow + 1),
  );
}

/** Keep the typed surface but drop stray trailing punctuation. */
function token_surface(token: string): string {
  return token.replace(/[?:!.,;]+$/, "").replace(/^['":;]+/, "");
}

/**
 * Tách một dòng ghi chú thành một hồ sơ xe.
 * `vehicleTypes` là danh mục đang dùng (tên thuần); thiếu tham số này parser
 * dùng danh mục mặc định đã seed — hữu ích cho unit test và bản nháp offline.
 */
export function parseIntakeNotes(
  raw: string,
  dictionary: LearnedDictionary = {},
  vehicleTypes: readonly string[] = DEFAULT_VEHICLE_TYPE_NAMES,
): IntakeEntry[] {
  const yearNow = new Date().getFullYear();
  const entries: IntakeEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseLine(line, dictionary, yearNow, vehicleTypes);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, 100);
}
