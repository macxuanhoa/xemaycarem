/** Conservative, local CCCD/CMND extraction. Dates and arbitrary QR numbers are not IDs. */
import { riskyGlyphs } from "./candidates";

export type IdentityRead = {
  document_number: string;
  confidence: number;
  uncertainCharacters: number[];
  ocrMs?: number;
};

function fold(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "D").toUpperCase();
}

function plausibleNumber(value: string, legacy: boolean): boolean {
  if (!/^\d+$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  if (value.length === 9) return legacy;
  return value.length === 12 && Number(value.slice(0, 3)) >= 1 && Number(value.slice(0, 3)) <= 96;
}

function dateParts(value: string): { year: number } | null {
  if (!/^\d{8}$/.test(value)) return null;
  const day = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const year = Number(value.slice(4));
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2199 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year } : null;
}

/** Native CCCD QR layout: ID | old CMND | name | birth | sex | address | issue date. */
export function parseIdentityDocumentQr(payload: string): IdentityRead | null {
  const fields = payload.trim().split("|").map((field) => field.trim());
  if (fields.length !== 7) return null;
  const [number, oldNumber, name, birth, sex, address, issued] = fields;
  const birthDate = dateParts(birth);
  const issueDate = dateParts(issued);
  if (!plausibleNumber(number, false) || (oldNumber && !plausibleNumber(oldNumber, true))) return null;
  if (!birthDate || !issueDate || issueDate.year < birthDate.year) return null;
  if (!/^[\p{L} .'-]{4,}$/u.test(name) || !/^(NAM|NU|MALE|FEMALE)$/.test(fold(sex)) || !/[\p{L}]/u.test(address)) return null;
  // A citizen ID encodes birth century and the final two birth-year digits.
  const encodedYear = 1900 + Math.floor(Number(number[3]) / 2) * 100 + Number(number.slice(4, 6));
  if (encodedYear !== birthDate.year) return null;
  return { document_number: number, confidence: 100, uncertainCharacters: [] };
}

/** Accept only a number inside a credible identity-card OCR context. */
export function parseIdentityDocumentText(text: string, confidence = 90): IdentityRead | null {
  const upper = fold(text);
  const legacy = /CHUNG\s+MINH\s+(?:THU\s+)?NHAN\s+DAN|\bCMND\b/.test(upper);
  const citizen = /CAN\s+CUOC|CITIZEN\s+IDENTITY|IDENTITY\s+CARD|\bCCCD\b/.test(upper);
  if (!legacy && !citizen) return null;
  const found = new Map<string, IdentityRead>();
  // The number must occupy a number-labelled field or its own line. This
  // avoids picking phone numbers, address codes or joined birth/issue dates.
  for (const line of upper.split(/[\r\n]+/)) {
    const match = line.match(/^\s*(?:(?:SO|NO\.?|NUMBER|CCCD|CMND)(?:\s*\/?\s*(?:NO\.?|SO|NUMBER))?\s*[:#.-]?\s*)?((?:[0-9OQILSBZ][ ]*){9,12})\s*$/);
    if (!match) continue;
    const raw = match[1].replace(/\s/g, "");
    const risks: number[] = [];
    const substitutions: Record<string, string> = { O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };
    const number = [...raw].map((character, index) => {
      if (substitutions[character]) { risks.push(index); return substitutions[character]; }
      return character;
    }).join("");
    if (!plausibleNumber(number, legacy)) continue;
    const score = confidence * (risks.length ? Math.max(0.65, 1 - risks.length * 0.08) : 1);
    found.set(number, { document_number: number, confidence: score, uncertainCharacters: [...new Set([...risks, ...riskyGlyphs(number, confidence)])] });
  }
  return found.size === 1 ? [...found.values()][0] : null;
}
