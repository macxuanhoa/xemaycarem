import { describe, expect, it } from "vitest";
import {
  INTAKE_FIELDS,
  normalizePlate,
  parseShorthandMoney,
  parseIntakeNotes,
  type LearnedDictionary,
} from "@/lib/shorthand/parseIntakeNotes";
import {
  forgetRule,
  learnRule,
  listRules,
  loadDictionary,
  type ShorthandStorage,
} from "@/lib/shorthand/learnedDictionary";
import {
  entryToAcquisitionDraft,
  entryToImportRow,
  validateIntakeEntry,
} from "@/lib/shorthand/intakeRows";

function parseFirst(line: string, dict: LearnedDictionary = {}) {
  const entries = parseIntakeNotes(line, dict);
  expect(entries).toHaveLength(1);
  return entries[0].fields;
}

describe("parseShorthandMoney", () => {
  it("understands triệu/ký/tỷ shorthand including decimals", () => {
    expect(parseShorthandMoney("18tr5")).toBe(18_500_000);
    expect(parseShorthandMoney("12tr")).toBe(12_000_000);
    expect(parseShorthandMoney("1.2ty")).toBe(1_200_000_000);
    expect(parseShorthandMoney("450k")).toBe(450_000);
    expect(parseShorthandMoney("8triệu5")).toBe(8_500_000);
    expect(parseShorthandMoney("2,5tr")).toBe(2_500_000);
  });
  it("understands grouped full amounts", () => {
    expect(parseShorthandMoney("18.000.000")).toBe(18_000_000);
    expect(parseShorthandMoney("18,000,000")).toBe(18_000_000);
    expect(parseShorthandMoney("35000000")).toBe(35_000_000);
  });
  it("rejects ambiguous or unsafe input instead of guessing", () => {
    expect(parseShorthandMoney("xe")).toBeNull();
    expect(parseShorthandMoney("999")).toBeNull();
    expect(parseShorthandMoney("20000000000000")).toBeNull();
  });
});

describe("normalizePlate", () => {
  it("normalizes common phone-note spellings", () => {
    expect(normalizePlate("29b1-123.45")).toBe("29B1-123.45");
    expect(normalizePlate("51X1-887.65")).toBe("51X1-887.65");
    expect(normalizePlate("29-A1-1234")).toBe("29A1-1234");
    expect(normalizePlate("29b1.123.45")).toBe("29B1-123.45");
  });
  it("does not treat frames or plain numbers as plates", () => {
    expect(normalizePlate("RLH160-001")).toBeNull();
    expect(normalizePlate("18000000")).toBeNull();
  });
});

describe("parseIntakeNotes", () => {
  it("parses a typical shorthand line into structured fields", () => {
    const fields = parseFirst("sh den bs 29b1-123.45 nam 22 2v gia 18tr5");
    expect(fields).toMatchObject({
      brand: "Honda",
      model: "SH",
      color: "Đen",
      license_plate: "29B1-123.45",
      year: "2022",
      odometer: "20000",
      purchase_price: "18500000",
    });
  });
  it("captures seller, phone and second price", () => {
    const fields = parseFirst(
      "ex 155 abs xanh tm 19,5tr chu Nam sdt 0901234567 niemyet 22tr",
    );
    expect(fields).toMatchObject({
      brand: "Yamaha",
      model: "Exciter 155",
      variant: "ABS",
      color: "Xanh",
      supplier_name: "Nam",
      supplier_phone: "0901234567",
      purchase_price: "19500000",
      asking_price: "22000000",
    });
  });
  it("upgrades wave → wave rsx instead of dropping the token", () => {
    const fields = parseFirst("wave rsx 1d trang 8tr5");
    expect(fields.model).toBe("Wave RSX");
    expect(fields.brand).toBe("Honda");
    expect(fields.variant).toBe("1 đĩa");
  });
  it("keeps unrecognized tokens reviewable, never guesses prices", () => {
    const entries = parseIntakeNotes("abdo den 30tr phi dao");
    expect(entries[0].fields.purchase_price).toBe("30000000");
    expect(entries[0].unknownTokens).toContain("phi dao".split(" ")[0]);
  });
  it("supports fk/gm keywords and detects frame codes", () => {
    const fields = parseFirst("fk RLH160-001 gm KF16099 vision den 20tr");
    expect(fields.frame_number).toBe("RLH160-001");
    expect(fields.engine_number).toBe("KF16099");
    expect(fields.model).toBe("Vision");
  });
  it("reads dates and trailing free text as notes", () => {
    const fields = parseFirst("lead do 12/03/26 15tr ghcn phu tung zin");
    expect(fields.purchase_date).toBe("2026-03-12");
    expect(fields.notes).toBe("phu tung zin");
  });
  it("applies learned abbreviations before the built-in vocabulary", () => {
    const dict: LearnedDictionary = {
      nxs: { key: "nxs", field: "model", value: "NVX 155" },
      muabannhan: { key: "muabannhan", field: "notes", value: "Mua bán nhanh" },
    };
    const fields = parseFirst("nxs den 40tr muabannhan", dict);
    expect(fields).toMatchObject({
      model: "NVX 155",
      brand: "Yamaha",
      color: "Đen",
      purchase_price: "40000000",
      notes: "Mua bán nhanh",
    });
  });
  it("splits one entry per line and skips headings/blank lines", () => {
    const entries = parseIntakeNotes("# đanh sách thu\n\nsh 18tr\nwave 9tr\n");
    expect(entries.map((e) => e.fields.model)).toEqual(["SH", "Wave"]);
  });
  it("records provenance so the UI can suggest teaching edits", () => {
    const entries = parseIntakeNotes("ex den 15tr");
    expect(entries[0].provenance.model).toBe("ex");
    expect(entries[0].provenance.color).toBe("den");
  });
  it("keeps a second value for the same field visible instead of silent", () => {
    const entries = parseIntakeNotes("RLH1-1 sdt 0901234567 0987654321 fk XYZ");
    expect(entries[0].fields.supplier_phone).toBe("0901234567");
    expect(entries[0].unknownTokens).toContain("0987654321");
  });
});

describe("learnedDictionary", () => {
  function memory(): ShorthandStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
    };
  }
  it("learns, persists and forgets rules keyed per account", () => {
    const storage = memory();
    let dict = learnRule("u1", "NXL", "model", "Novux", storage);
    expect(dict["nxl"].value).toBe("Novux");
    dict = learnRule("u1", "nxl", "model", "Novox 155", storage);
    expect(dict["nxl"].count).toBe(2);
    expect(Object.keys(loadDictionary("u2", storage))).toHaveLength(0);
    expect(listRules(loadDictionary("u1", storage))[0].key).toBe("nxl");
    dict = forgetRule("u1", "nxl", storage);
    expect(dict).toEqual({});
  });
  it("survives corrupt payloads and anonymous users", () => {
    const storage = memory();
    storage.setItem("carem_shorthand_dict_v1:u1", "{oops");
    expect(loadDictionary("u1", storage)).toEqual({});
    expect(learnRule(undefined, "x", "brand", "Honda", storage)).toEqual({});
  });
});

describe("intake payload", () => {
  const entry = parseIntakeNotes("sh den 29b1-123.45 gia 18tr5 fk RLH160-001")[0];

  it("requires frame, brand, model and price (for finance) before import", () => {
    expect(validateIntakeEntry(entry, true)).toEqual([]);
    expect(validateIntakeEntry(entry, false)).toEqual([]);
    const missing = { ...entry, fields: { brand: "Honda" } };
    const errors = validateIntakeEntry(missing, true);
    expect(errors.join(" ")).toMatch(/khung/);
    expect(errors.join(" ")).toMatch(/dòng xe/);
    expect(errors.join(" ")).toMatch(/giá thu/);
  });
  it("never sends purchase_price for users without financial rights", () => {
    const row = entryToImportRow(entry, false);
    expect("purchase_price" in row).toBe(false);
    expect(row.brand).toBe("Honda");
    expect(row.supplier_name).toBe("");
    const finRow = entryToImportRow(entry, true);
    expect(finRow.purchase_price).toBe(18_500_000);
  });
  it("maps supplier fields to the single-vehicle form names", () => {
    const draft = entryToAcquisitionDraft(entry);
    expect(draft.frame_number).toBe("RLH160-001");
    expect(draft.license_plate).toBe("29B1-123.45");
  });
  it("INTAKE_FIELDS covers every editable field", () => {
    expect(INTAKE_FIELDS.length).toBe(15);
  });
});
