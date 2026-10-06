// Deterministic, provider-free draft-action detection for the copilot.
// A typed or dictated command like "chi 500k thay nhớt xe 59-B1 123" is parsed
// here into an editable *draft proposal only*: saving still happens through the
// normal confirmed RPC of the receiving form, exactly like the ai-assist drafts.
import { normalizeKey } from "./vocabulary";
import { parseShorthandMoney } from "./parseIntakeNotes";
import { normalizePlate, isValidMotorbikePlate } from "@/lib/plate";

export type ExpenseDraftAction = {
  kind: "ADD_VEHICLE_EXPENSE";
  license_plate: string;
  amount: number;
  description: string;
  expense_type: string;
  date?: string;
};
export type SaleDraftAction = {
  kind: "PREPARE_SALE";
  license_plate: string;
  customer_name?: string;
  customer_phone?: string;
  sale_price?: number;
};
export type AcquisitionDraftAction = { kind: "CREATE_ACQUISITION"; seed_text: string };
export type DraftAction = ExpenseDraftAction | SaleDraftAction | AcquisitionDraftAction;

/** Interrogations are copilot questions, never commands (tested on folded text). */
const QUESTION = /[?]\s*$|\bbao nhieu|\bmay xe|\bmay cai|\bco khong|\bphai khong|\bdang the nao|\bra sao|\bkiem tra|\bthong ke|\btinh hinh\b/i;
const PLATE = /\b\d{2,3}[-\s.]?[a-z0-9]{1,3}[-\s.]?\d{3,6}(?:[-.\s]\d{1,2})?\b/gi;
const PHONE_TOKEN = /^(?:\+?84|0)\d{9}$/;
const EXPENSE_VERB = /\b(chi|xuat chi|tra|nop|thanh toan|do|lanh|nhom|han|danh bong|bao tri|danh bon|song)\b/;
const REPAIR_VERB = /\b(thay|sua|ran|han que|danh bong|ve sinh|rua xe|bao tri|nop dien)\b/;
// A sentence that *starts* with a spending verb is an expense even if the
// plate or money is missing; it must never be re-read as buying a bike.
const LEADING_EXPENSE = /^\s*(?:\w+\s){0,2}(chi|xuat|tra|nop|thanh|toan|danh|bao|ve|rua|song|do|lanh|nhom|han|thay|sua|ran)\b/;
const SELL_VERB = /\b(ban|nhuong|xuat ban)\b/;
// Bare "thu" is excluded on purpose: "doanh thu", "thu chi", "thu hộ" are not purchases.
const BUY_VERB = /\b(thu mua|mua|bao thu|nho thu|ke thu|can thu|thu xe|lam thu|nhan thu)\b/;

const EXPENSE_TYPES: [RegExp, string][] = [
  [/lop|ac quy|den|pin|phu tung|bo nang|nhon|srom/, "PARTS"],
  [/rua xe|giat|ve sinh|han dan\b|danh bong/, "CLEANING"],
  [/van chuyen|chuyen xe|chuyen ve|bac|ship|taxi|vex/, "TRANSPORT"],
  [/ho so|giay to|tru ba|cong chung|dang ky|xac nhan|\bphi\b|trc|giam dang/, "PAPERWORK"],
  [/kiem dinh|dang kiem|\bdk.t\b/, "INSPECTION"],
];

function findPlate(text: string): string | null {
  for (const candidate of text.match(PLATE) ?? []) {
    const plate = normalizePlate(candidate);
    if (plate && isValidMotorbikePlate(plate)) return plate;
  }
  return null;
}

function findAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    const clean = token.replace(/[.đd:;!?]+$/g, "");
    if (!/^\d/.test(clean)) continue;
    // Phone numbers are contacts, never money.
    if (PHONE_TOKEN.test(clean.replace(/\D/g, ""))) continue;
    const value = parseShorthandMoney(normalizeKey(clean));
    if (value != null && value >= 1_000 && value <= 500_000_000_000) amounts.push(value);
  }
  return amounts;
}

function findDate(text: string): string | undefined {
  const key = normalizeKey(text);
  const now = new Date();
  if (/\bhom nay\b/.test(key)) return now.toISOString().slice(0, 10);
  if (/\bhom qua\b/.test(key)) return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const m = text.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (!m) return undefined;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) year += year > 80 ? 1900 : 2000;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function expenseType(description: string): string {
  const key = normalizeKey(description);
  for (const [pattern, type] of EXPENSE_TYPES) if (pattern.test(key)) return type;
  return "REPAIR";
}

/** Everything except the plate, money tokens, date and the leading verbs. */
function expenseDescription(text: string, plate: string): string {
  const rest = text
    .replace(plate, " ")
    .replace(/\b\d{1,2}[/\-.]\d{1,2}([/\-.]\d{2,4})?\b/g, " ")
    .split(/[\s,;]+/)
    .filter((token) => {
      const clean = token.replace(/[.đd:;!?]+$/g, "");
      if (!clean) return false;
      if (/^\d/.test(clean) && parseShorthandMoney(normalizeKey(clean)) != null) return false;
      return !/^(chi|xuat|tra|nop|thanh|toan|cho|cua|xe|ho|va|von|lai|hom|nay|qua)$/i.test(normalizeKey(token));
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!rest) return "Chi ph\u00ed c\u1eeda h\u00e0ng";
  return rest.length > 120 ? `${rest.slice(0, 117)}\u2026` : rest;
}

function findCustomer(text: string): string | undefined {
  const m = text.match(/\b(?:anh|chi|ba|ong|co|cau|em)\s+([^\d\s.,;!?][^\s.,;!?]{1,24}(?:\s+[A-ZÀ-Ỹ][^\s.,;!?]{1,24})?)/);
  if (!m) return undefined;
  const name = m[1].trim();
  return /hom|nay|qua|xe|mai|chieu|sang|toi|ngay|uan|ty|trieu|nghin|ngan|ban|da|di|roi|lun/.test(normalizeKey(name)) ? undefined : name;
}

function findPhone(text: string): string | undefined {
  const digits = text.replace(/[^\d+]/g, "");
  const m = digits.match(/(?:\+?84|0)\d{9}/);
  if (!m) return undefined;
  return m[0].startsWith("0") ? m[0] : `0${m[0].slice(-9)}`;
}

/**
 * Parse one command sentence into an editable draft proposal, or `null` when
 * this reads as a question or plain prose. Detection is intentionally strict:
 * an expense needs a vehicle plate so the modal can bind the real vehicle.
 */
export function detectDraftAction(text: string): DraftAction | null {
  const trimmed = text.trim();
  if (trimmed.length < 6 || trimmed.length > 500) return null;
  const key = normalizeKey(trimmed);
  if (QUESTION.test(key)) return null;
  const plate = findPlate(trimmed);
  const amounts = findAmounts(plate ? trimmed.replace(plate, " ") : trimmed);

  if (SELL_VERB.test(key)) {
    if (!plate) return null;
    const price = amounts.find((value) => value >= 3_000_000);
    const customer_name = findCustomer(trimmed);
    const customer_phone = findPhone(trimmed);
    if (!price && !customer_name && !customer_phone) return null;
    return { kind: "PREPARE_SALE", license_plate: plate, ...(customer_name ? { customer_name } : {}), ...(customer_phone ? { customer_phone } : {}), ...(price ? { sale_price: price } : {}) };
  }

  if (LEADING_EXPENSE.test(key) || (plate && amounts.length && (EXPENSE_VERB.test(key) || REPAIR_VERB.test(key)))) {
    // Spending words never fall through to "buy a bike": without a bound
    // vehicle the proposal is dropped instead of misread as an acquisition.
    if (!plate || !amounts.length) return null;
    const amount = Math.max(...amounts);
    const description = expenseDescription(trimmed, plate);
    const date = findDate(trimmed);
    return { kind: "ADD_VEHICLE_EXPENSE", license_plate: plate, amount, description, expense_type: expenseType(description), ...(date ? { date } : {}) };
  }

  const looksLikeVehiclePurchase =
    /\bxe\b|\bmay\b|\bsh\b|\bwave\b|\bvision\b|\blead\b|\bclick\b|\bair blade\b|\bnovamax\b|\bgnr\b|\blatio\b|\bfazzla\b|\bvecx\b|\bwinner\b|\bsirius\b|\bexciter\b|\by12\b|\ba\d{1,2}\b|\be\d{1,2}\b/.test(key);
  // Parts-and-services money ("chi 500k mua lop xe") is never a bike price;
  // an acquisition needs a vehicle word or a real-sized amount.
  const priceSized = !amounts.length || Math.max(...amounts) >= 3_000_000;
  if (BUY_VERB.test(key) && looksLikeVehiclePurchase && priceSized)
    return { kind: "CREATE_ACQUISITION", seed_text: trimmed };
  return null;
}
