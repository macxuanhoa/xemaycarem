import { describe, expect, it } from "vitest";
import {
  INTAKE_FIELDS,
  normalizePlate,
  parseShorthandMoney,
  parseIntakeNotes,
  type IntakeFieldKey,
  type LearnedDictionary,
} from "@/lib/shorthand/parseIntakeNotes";
import {
  forgetRule,
  learnRule,
  listRules,
  loadDictionary,
  type ShorthandStorage,
} from "@/lib/shorthand/learnedDictionary";
import { entryToImportRow, validateIntakeEntry } from "@/lib/shorthand/intakeRows";

function parseFirst(
  line: string,
  dict: LearnedDictionary = {},
  vehicleTypes?: readonly string[],
) {
  const entries = parseIntakeNotes(line, dict, vehicleTypes);
  expect(entries).toHaveLength(1);
  return entries[0].fields;
}

function parseSingle(
  line: string,
  dict: LearnedDictionary = {},
  vehicleTypes?: readonly string[],
) {
  const entries = parseIntakeNotes(line, dict, vehicleTypes);
  expect(entries).toHaveLength(1);
  return entries[0];
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
  it("normalizes common phone-note spellings to the real VN format", () => {
    expect(normalizePlate("29b1-123.45")).toBe("29B1-123.45");
    expect(normalizePlate("51X1-887.65")).toBe("51X1-887.65");
    expect(normalizePlate("29-A1-1234")).toBe("29A1-1234");
    expect(normalizePlate("29b1.123.45")).toBe("29B1-123.45");
    // Space-separated input and the pre-overhaul stored canonical form must
    // keep folding to the dash form (existing rows are only re-saved lazily).
    expect(normalizePlate("29b1 123.45")).toBe("29B1-123.45");
    expect(normalizePlate("59-A1 234.56")).toBe("59A1-234.56");
  });
  it("does not treat frames or plain numbers as plates", () => {
    expect(normalizePlate("RLH160-001")).toBeNull();
    expect(normalizePlate("18000000")).toBeNull();
  });
});

describe("parseIntakeNotes", () => {
  it("parses a typical shorthand line into the fields the record still has", () => {
    const fields = parseFirst("den bs 29b1-123.45 nam 22 gia 18tr5");
    expect(fields).toMatchObject({
      color: "Đen",
      license_plate: "29B1-123.45",
      year: "2022",
      purchase_price: "18500000",
    });
  });
  it("captures seller and phone, and no longer claims a second price", () => {
    const entries = parseIntakeNotes(
      "xanh tm 19,5tr chu Nam sdt 0901234567 niemyet 22tr",
    );
    expect(entries[0].fields).toMatchObject({
      color: "Xanh",
      supplier_name: "Nam",
      supplier_phone: "0901234567",
      purchase_price: "19500000",
    });
    // Giá bán không còn là trường hồ sơ xe: chỉ sinh ra từ phiếu Bán xe,
    // nên con số thứ hai ở lại trong hàng đợi chip để nhân viên tự gán.
    expect(entries[0].fields).not.toHaveProperty("asking_price");
    expect(entries[0].unknownTokens).toContain("22tr");
    expect(entries[0].unknownTokens).toContain("niemyet");
  });
  it("recognises a vehicle type across tokens and only from the catalogue", () => {
    expect(parseFirst("tay ga den 30tr").vehicle_type).toBe("Xe tay ga");
    expect(parseFirst("xe so trang 12tr").vehicle_type).toBe("Xe số");
    expect(parseFirst("con tay do 45tr").vehicle_type).toBe("Xe côn tay");
    expect(parseFirst("ga 50cc trang 15tr").vehicle_type).toBe("Ga 50cc");
    expect(parseFirst("dien vang 20tr").vehicle_type).toBe("Xe điện");
    // Hàng đợi "Chưa phân loại" không bao giờ được tốc ký tự gán.
    expect(parseFirst("chưa phân loại den 10tr").vehicle_type).toBeUndefined();
  });
  it("honours a shop-specific catalogue without inventing names", () => {
    const fields = parseFirst(
      "ga 50cc den 15tr",
      {},
      ["Ga 50cc", "Chưa phân loại"],
    );
    expect(fields.vehicle_type).toBe("Ga 50cc");
    expect(fields.color).toBe("Đen");
    expect(fields.purchase_price).toBe("15000000");
    // Tên nằm ngoài danh mục đang dùng -> chỉ thành chip lạ.
    const unknown = parseFirst("loai abc den 20tr");
    expect(unknown.vehicle_type).toBeUndefined();
    expect(unknown.license_plate).toBeUndefined();
  });
  it("never reads a type substring inside a frame or plate code", () => {
    // "ga"/"so" chỉ khớp khi nằm gọn trên ranh giới token, nên mã khung
    // chứa chữ tương tự không bị gán thành loại xe.
    const fields = parseFirst("RLHSGA1234567 den 20tr");
    expect(fields.frame_number).toBe("RLHSGA1234567");
    expect(fields.vehicle_type).toBeUndefined();
  });
  it("keeps unrecognized tokens reviewable, never guesses prices", () => {
    const entries = parseIntakeNotes("abdo den 30tr phi dao");
    expect(entries[0].fields.purchase_price).toBe("30000000");
    expect(entries[0].unknownTokens).toContain("phi");
    expect(entries[0].unknownTokens).toContain("dao");
    expect(entries[0].unknownTokens).toContain("abdo");
  });
  it("drops the purged model/variant/engine vocabulary", () => {
    // Trước 08/10/2026 mấy token này đổ vào Hãng/Dòng/Phiên bản/Số máy.
    // Bây giờ chỉ còn một chỗ cho mã: Số khung, nên mã số máy rơi vào đó
    // (nhân viên sửa lại trên thẻ); không trường nào âm thầm nhận nó.
    const entries = parseIntakeNotes("wave rsx 1d abs gm KF16099 den 8tr5");
    expect(entries[0].fields).toEqual({
      frame_number: "KF16099",
      color: "Đen",
      purchase_price: "8500000",
    });
    expect(entries[0].fields).not.toHaveProperty("model");
    expect(entries[0].fields).not.toHaveProperty("brand");
    expect(entries[0].fields).not.toHaveProperty("variant");
    expect(entries[0].fields).not.toHaveProperty("engine_number");
    expect(entries[0].fields).not.toHaveProperty("odometer");
    expect(entries[0].unknownTokens).toContain("wave");
    expect(entries[0].unknownTokens).toContain("rsx");
    expect(entries[0].unknownTokens).toContain("gm");
  });
  it("supports the fk keyword and keeps a second frame code visible", () => {
    const entries = parseIntakeNotes("fk RLH160-001 den 20tr");
    expect(entries[0].fields.frame_number).toBe("RLH160-001");
    expect(entries[0].fields.color).toBe("Đen");
  });
  it("reads dates and leaves leftover words as unknown tokens", () => {
    const entries = parseSingle("lead do 12/03/26 15tr ghcn phu tung zin");
    expect(entries.fields.purchase_date).toBe("2026-03-12");
    expect(entries.fields.color).toBe("Đỏ");
    expect(entries.fields).not.toHaveProperty("notes");
    // "ghcn" không còn là từ khóa — mọi chữ thừa chỉ thành chip chưa nhận diện.
    for (const token of ["ghcn", "phu", "tung", "zin"])
      expect(entries.unknownTokens).toContain(token);
  });
  it("applies learned abbreviations before the built-in vocabulary", () => {
    const dict: LearnedDictionary = {
      den: { key: "den", field: "year", value: "2019" },
    };
    const learned = parseSingle("den 15tr", dict);
    // "den" vốn là màu trong builtin; luật đã học thắng và không còn màu nào.
    expect(learned.fields).toEqual({
      year: "2019",
      purchase_price: "15000000",
    });
    expect(learned.fields.color).toBeUndefined();

    const taught: LearnedDictionary = {
      zx: { key: "zx", field: "color", value: "Xanh ngọc" },
    };
    expect(parseSingle("zx 15tr", taught).fields.color).toBe("Xanh ngọc");
  });
  it("splits one entry per line and skips headings/blank lines", () => {
    const entries = parseIntakeNotes("# đanh sách thu\n\nsh 18tr\ntay ga 9tr\n");
    expect(entries).toHaveLength(2);
    expect(entries[0].fields.purchase_price).toBe("18000000");
    expect(entries[1].fields.vehicle_type).toBe("Xe tay ga");
  });
  it("records provenance for the token that filled each field", () => {
    const entries = parseIntakeNotes("ex den 15tr");
    expect(entries[0].provenance.color).toBe("den");
    expect(entries[0].provenance.purchase_price).toBe("15tr");
    expect(entries[0].unknownTokens).toContain("ex");
  });
  it("keeps a second value for the same field visible instead of silent", () => {
    const entries = parseIntakeNotes("RLH1-1 sdt 0901234567 0987654321");
    expect(entries[0].fields.supplier_phone).toBe("0901234567");
    expect(entries[0].unknownTokens).toContain("0987654321");
  });
  it("detects a plate without the 'bs' keyword, joining a space-split serial", () => {
    // Regression: "29b1 123.45" used to leak "123.45" into the odometer
    // bucket; the odometer field no longer exists at all, so the leak can
    // only ever show up as an unknown token — assert both halves of that.
    const fields = parseFirst("den 29b1 123.45 gia 18tr5");
    expect(fields.license_plate).toBe("29B1-123.45");
    expect(fields).not.toHaveProperty("odometer");
    expect(fields.purchase_price).toBe("18500000");
  });
  it("treats a bare 2- or 4-digit number as the production year", () => {
    expect(parseFirst("den 21 18tr").year).toBe("2021");
    expect(parseFirst("den 2021 18tr").year).toBe("2021");
  });
  it("folds the '#tail' of a line into notes without leaking into other fields", () => {
    const entries = parseSingle("xanh 27tr # chinh chu ban");
    expect(entries.fields.notes).toBe("chinh chu ban");
    expect(entries.fields.purchase_price).toBe("27000000");
    expect(entries.unknownTokens).toEqual([]);
    // Dạng dính "#chinh" cũng được; chữ trong ghi chú không bao giờ được
    // quét loại xe ("xe ga" ở ghi chú KHÔNG được điền vào Loại xe).
    const attached = parseSingle("lead 15tr # xe ga");
    expect(attached.fields.notes).toBe("xe ga");
    expect(attached.fields.vehicle_type).toBeUndefined();
    // Dòng BẮT ĐẦU bằng # vẫn là tiêu đề bị bỏ qua — quy tắc chỉ áp dụng giữa dòng.
    expect(parseIntakeNotes("# đanh sach thu\n\nsh 18tr")).toHaveLength(1);
  });
  it("reads a bare 5-digit number as the compact frame, never as year or price", () => {
    const fields = parseFirst("wave den 23412 15tr");
    expect(fields.frame_number).toBe("23412");
    expect(fields.purchase_price).toBe("15000000");
    expect(fields).not.toHaveProperty("year");
    // Khung đã có (qua "fk") thì số 5 chữ số thứ hai thành chip lạ, không đè.
    const second = parseSingle("fk RLH160-001 23412 15tr");
    expect(second.fields.frame_number).toBe("RLH160-001");
    expect(second.unknownTokens).toContain("23412");
  });
  it("rejects garbage after 'bs' instead of storing it as a plate", () => {
    const fields = parseFirst("den bs abcxyz");
    expect(fields.license_plate).toBeUndefined();
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
    let dict = learnRule("u1", "NXL", "vehicle_type", "Xe côn tay", storage);
    expect(dict["nxl"].value).toBe("Xe côn tay");
    dict = learnRule("u1", "nxl", "vehicle_type", "Xe côn tay", storage);
    expect(dict["nxl"].count).toBe(2);
    expect(Object.keys(loadDictionary("u2", storage))).toHaveLength(0);
    expect(listRules(loadDictionary("u1", storage))[0].key).toBe("nxl");
    dict = forgetRule("u1", "nxl", storage);
    expect(dict).toEqual({});
  });
  it("refuses purged fields and drops stale rules saved before the purge", () => {
    const storage = memory();
    // Luật cũ lưu theo field đã bị xoá khỏi hồ sơ (model/odometer/brand) và
    // cả Màu sắc / Năm sản xuất (bộ nhớ giờ chỉ nhận Loại xe): bị lọc ngay
    // lúc đọc nên không cần đổi khoá localStorage.
    storage.setItem(
      "carem_shorthand_dict_v1:u1",
      JSON.stringify({
        sh: { key: "sh", field: "model", value: "SH 160i" },
        km: { key: "km", field: "odometer", value: "20000" },
        hang: { key: "hang", field: "brand", value: "Honda" },
        den: { key: "den", field: "color", value: "Đen nhám" },
        "22": { key: "22", field: "year", value: "2022" },
        ga: { key: "ga", field: "vehicle_type", value: "Xe tay ga" },
      }),
    );
    const dict = loadDictionary("u1", storage);
    expect(Object.keys(dict)).toEqual(["ga"]);
    const purgedField = "model" as unknown as IntakeFieldKey;
    expect(learnRule("u1", "abc", purgedField, "SH 160i", storage)).toEqual(dict);
    expect(learnRule("u1", "abc", "color", "Đen nhám", storage)["abc"]).toBeUndefined();
    expect(learnRule("u1", "abc", "year", "2022", storage)["abc"]).toBeUndefined();
  });
  it("survives corrupt payloads and anonymous users", () => {
    const storage = memory();
    storage.setItem("carem_shorthand_dict_v1:u1", "{oops");
    expect(loadDictionary("u1", storage)).toEqual({});
    expect(learnRule(undefined, "x", "color", "Honda", storage)).toEqual({});
    // Tên người bán / SĐT / Ghi chú không còn nằm trong danh sách dạy được,
    // nên dữ liệu cá nhân không bao giờ được lưu vào từ điển.
    learnRule("u1", "private", "supplier_name", "Test private seller", storage);
    learnRule("u1", "privatephone", "supplier_phone", "0900000001", storage);
    learnRule("u1", "privatenote", "notes", "Test private note", storage);
    const safe = loadDictionary("u1", storage);
    expect(safe.private).toBeUndefined();
    expect(safe.privatephone).toBeUndefined();
    expect(safe.privatenote).toBeUndefined();
  });
});

describe("intake payload", () => {
  const entry = parseIntakeNotes(
    "tay ga den 29b1-123.45 gia 18tr5 fk RLH160-001",
  )[0];

  it("accepts any non-empty type name and keeps optional fields optional", () => {
    expect(validateIntakeEntry(entry)).toEqual({});
    // Loại xe là tên tự do — một tên mới ngoài danh mục vẫn hợp lệ.
    const invented = {
      ...entry,
      fields: { ...entry.fields, vehicle_type: "Honda SH 160i" },
    };
    expect(validateIntakeEntry(invented)).toEqual({});
    // Số khung, biển số, năm có thể bổ sung sau, riêng giá thu là bắt buộc.
    const sparse = { ...entry, fields: { vehicle_type: "Honda Vision" } };
    expect(Object.values(validateIntakeEntry(sparse)).join(" ")).toMatch(
      /giá thu/i,
    );
    expect(validateIntakeEntry(sparse).purchase_price).toBeDefined();
  });
  it("blocks a row whose type name is empty", () => {
    const none = { ...entry, fields: {} };
    expect(Object.values(validateIntakeEntry(none)).join(" ")).toMatch(/dòng xe/);
    const blank = { ...entry, fields: { vehicle_type: "   " } };
    expect(Object.values(validateIntakeEntry(blank)).join(" ")).toMatch(/dòng xe/);
  });
  it("always sends purchase_price because every role records the intake cost", () => {
    const row = entryToImportRow(entry);
    expect(row.purchase_price).toBe(18_500_000);
    expect(row.vehicle_type).toBe("Xe tay ga");
    expect(row).not.toHaveProperty("vehicle_type_id");
    expect(row.supplier_name).toBe("");
    for (const purged of ["brand", "model", "variant", "engine_number", "odometer", "asking_price"]) {
      expect(row).not.toHaveProperty(purged);
    }
  });
  it("carries the '#' note through to the import payload", () => {
    const [noted] = parseIntakeNotes("tay ga den 15tr # chinh chu gd");
    expect(entryToImportRow(noted).notes).toBe("chinh chu gd");
  });
  it("rejects a garbage plate but keeps the field optional", () => {
    const garbage = {
      ...entry,
      fields: { ...entry.fields, license_plate: "abc xyz" },
    };
    expect(Object.values(validateIntakeEntry(garbage)).join(" ")).toMatch(/Biển số/);
    const blank = {
      ...entry,
      fields: { ...entry.fields, license_plate: "   " },
    };
    expect(validateIntakeEntry(blank)).toEqual({});
  });
  it("INTAKE_FIELDS covers exactly the editable fields that survive the purge", () => {
    expect(INTAKE_FIELDS.map((f) => f.key)).toEqual([
      "vehicle_type",
      "color",
      "frame_number",
      "license_plate",
      "year",
      "purchase_date",
      "purchase_price",
      "supplier_name",
      "supplier_phone",
    ]);
  });
});
