/**
 * Per-user learned abbreviations for the shorthand intake parser.
 * Every time the user corrects a token or teaches an abbreviation, the rule
 * is stored locally so the next paste parses smarter automatically.
 * Storage is keyed by account id and stays on the device (no PII leaves it).
 */
import type {
  IntakeFieldKey,
  LearnedDictionary,
  LearnedRule,
} from "./parseIntakeNotes";
import { normalizeKey } from "./vocabulary";

const PREFIX = "carem_shorthand_dict_v1";
// Hãng/Dòng/Phiên bản/Số máy/Số km đã bị xoá vĩnh viễn nên không còn là ô nào
// để "dạy" nữa. Bộ lọc này chạy lúc đọc, vì vậy luật cũ đã lưu tự bị loại thay
// vì nạp giá trị vô nghĩa vào form — không cần đổi khoá lưu trữ.
export const LOCAL_LEARNING_FIELDS = new Set<IntakeFieldKey>([
  "vehicle_type",
  "color",
  "year",
]);

export type ShorthandStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Reads the learned dictionary. Safe on unknown users and broken payloads. */
export function loadDictionary(
  userId: string | undefined,
  storage: ShorthandStorage,
): LearnedDictionary {
  if (!userId) return {};
  try {
    const raw = storage.getItem(`${PREFIX}:${userId}`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const dict: LearnedDictionary = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const rule = value as Partial<LearnedRule>;
      if (
        typeof rule.value === "string" &&
        rule.value.trim() &&
        typeof rule.field === "string" &&
        LOCAL_LEARNING_FIELDS.has(rule.field as IntakeFieldKey)
      )
        dict[key] = {
          key,
          field: rule.field as IntakeFieldKey,
          value: rule.value.trim().slice(0, 250),
          count: Number(rule.count ?? 0) || 0,
          updatedAt: Number(rule.updatedAt ?? 0) || 0,
        };
    }
    return dict;
  } catch {
    return {};
  }
}

function save(
  userId: string,
  dict: LearnedDictionary,
  storage: ShorthandStorage,
): void {
  try {
    // Keep the newest 300 rules so one account cannot bloat localStorage.
    const entries = Object.values(dict)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 300);
    storage.setItem(
      `${PREFIX}:${userId}`,
      JSON.stringify(Object.fromEntries(entries.map((r) => [r.key, r]))),
    );
  } catch {
    // Quota errors must never break the intake flow itself.
  }
}

/** Adds or refreshes "key = value (field)" and returns the updated dictionary. */
export function learnRule(
  userId: string | undefined,
  abbreviation: string,
  field: IntakeFieldKey,
  value: string,
  storage: ShorthandStorage,
): LearnedDictionary {
  const dict = loadDictionary(userId, storage);
  const key = normalizeKey(abbreviation);
  const trimmed = value.trim();
  if (!userId || !key || key.length > 40 || !trimmed || !LOCAL_LEARNING_FIELDS.has(field)) return dict;
  const previous = dict[key];
  dict[key] = {
    key,
    field,
    value: trimmed.slice(0, 250),
    count: (previous?.count ?? 0) + 1,
    updatedAt: Date.now(),
  };
  save(userId, dict, storage);
  return dict;
}

export function forgetRule(
  userId: string | undefined,
  abbreviation: string,
  storage: ShorthandStorage,
): LearnedDictionary {
  const dict = loadDictionary(userId, storage);
  delete dict[normalizeKey(abbreviation)];
  if (userId) save(userId, dict, storage);
  return dict;
}

export function listRules(dict: LearnedDictionary): LearnedRule[] {
  return Object.values(dict).sort(
    (a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
}
