import { parseMoneyInput } from "./moneyHelper";
import { dateValue } from "./validation";
import { today } from "./format";
import type { ImportVehicleRow } from "@/types";

export function csvCell(value: unknown) {
  let text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const csv =
    "\uFEFF" +
    [
      keys.map(csvCell).join(","),
      ...rows.map((row) => keys.map((k) => csvCell(row[k])).join(",")),
    ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Robust CSV parser handling quotes, commas, CRLF, and UTF-8 BOM
 */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let closedQuote = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const nextChar = clean[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        if (currentField || closedQuote)
          throw new Error("Dấu ngoặc kép không hợp lệ trong CSV.");
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
        closedQuote = false;
      } else if (char === "\r") {
        if (nextChar === "\n") i++;
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c !== "")) rows.push(currentRow);
        currentRow = [];
        currentField = "";
        closedQuote = false;
      } else if (char === "\n") {
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c !== "")) rows.push(currentRow);
        currentRow = [];
        currentField = "";
        closedQuote = false;
      } else {
        if (closedQuote && !/\s/.test(char))
          throw new Error("Dữ liệu thừa sau dấu ngoặc kép CSV.");
        currentField += char;
      }
    }
  }

  if (inQuotes) throw new Error("CSV thiếu dấu ngoặc kép đóng.");
  if (currentField !== "" || currentRow.length > 0 || closedQuote) {
    currentRow.push(currentField.trim());
    if (currentRow.some((c) => c !== "")) rows.push(currentRow);
  }

  return rows;
}

const headerMap: Record<string, string> = {
  // Frame number / Chassis
  "số khung": "frame_number",
  "so khung": "frame_number",
  chassis: "frame_number",
  frame_number: "frame_number",
  vin: "frame_number",

  // Engine number
  "số máy": "engine_number",
  "so may": "engine_number",
  engine: "engine_number",
  engine_number: "engine_number",

  // License plate
  "biển số": "license_plate",
  "bien so": "license_plate",
  plate: "license_plate",
  license_plate: "license_plate",

  // Brand
  hãng: "brand",
  hang: "brand",
  "hãng xe": "brand",
  brand: "brand",
  make: "brand",

  // Model
  "dòng xe": "model",
  "dong xe": "model",
  model: "model",
  loại: "model",

  // Variant
  "phiên bản": "variant",
  "phien ban": "variant",
  variant: "variant",

  // Year
  "năm sx": "year",
  "nam sx": "year",
  năm: "year",
  year: "year",

  // Color
  "màu sắc": "color",
  "mau sac": "color",
  màu: "color",
  color: "color",

  // Odometer
  odo: "odometer",
  "số km": "odometer",
  odometer: "odometer",

  // Purchase date
  "ngày mua": "purchase_date",
  "ngay mua": "purchase_date",
  "ngày nhập": "purchase_date",
  purchase_date: "purchase_date",

  // Purchase price
  "giá mua": "purchase_price",
  "gia mua": "purchase_price",
  "giá nhập": "purchase_price",
  purchase_price: "purchase_price",

  // Asking price
  "giá bán": "asking_price",
  "gia ban": "asking_price",
  "giá niêm yết": "asking_price",
  asking_price: "asking_price",

  // Seller / Supplier name
  "người bán": "supplier_name",
  "nguoi ban": "supplier_name",
  "nhà cung cấp": "supplier_name",
  supplier_name: "supplier_name",

  // Seller phone
  "sđt người bán": "supplier_phone",
  "sdt nguoi ban": "supplier_phone",
  sđt: "supplier_phone",
  supplier_phone: "supplier_phone",

  // Notes
  "ghi chú": "notes",
  "ghi chu": "notes",
  notes: "notes",
};

export function parseVehiclesCsv(csvText: string): {
  headers: string[];
  rawRows: Array<Record<string, string>>;
} {
  const table = parseCsv(csvText);
  if (table.length === 0) return { headers: [], rawRows: [] };

  const rawHeaders = table[0];
  const normalizedHeaders = rawHeaders.map((h) => {
    const clean = h.trim().toLowerCase();
    return headerMap[clean] || clean;
  });

  const rawRows: Array<Record<string, string>> = [];
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length)
    throw new Error("CSV có cột bị trùng.");
  for (const required of ["frame_number", "brand", "model"]) {
    if (!normalizedHeaders.includes(required))
      throw new Error(`CSV thiếu cột ${required}.`);
  }
  if (table.length > 201) throw new Error("Mỗi lần nhập tối đa 200 xe.");
  for (let i = 1; i < table.length; i++) {
    const row = table[i];
    if (row.length !== normalizedHeaders.length)
      throw new Error(`Dòng ${i + 1} có số cột không khớp.`);
    const obj: Record<string, string> = {};
    for (let j = 0; j < normalizedHeaders.length; j++) {
      const key = normalizedHeaders[j];
      obj[key] = row[j] || "";
    }
    rawRows.push(obj);
  }

  return { headers: normalizedHeaders, rawRows };
}

export type ValidatedImportRow = {
  index: number;
  data: ImportVehicleRow;
  raw: Record<string, string>;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
};

export function validateImportRows(
  rawRows: Record<string, string>[],
  canFinancials: boolean,
  businessDay = today(),
): ValidatedImportRow[] {
  const seen = {
    frame_number: new Set<string>(),
    engine_number: new Set<string>(),
    license_plate: new Set<string>(),
  };
  return rawRows.map((raw, index) => {
    const errors: string[] = [];
    let isDuplicate = false;
    const data: ImportVehicleRow = {
      frame_number: (raw.frame_number || "").trim(),
      brand: (raw.brand || "").trim(),
      model: (raw.model || "").trim(),
    };
    const limits: Record<string, number> = {
      frame_number: 100,
      brand: 80,
      model: 120,
      engine_number: 100,
      license_plate: 30,
      variant: 120,
      color: 60,
      supplier_name: 160,
      supplier_phone: 30,
      notes: 5000,
    };
    for (const [field, limit] of Object.entries(limits)) {
      const value = (raw[field] || "").trim();
      if (value.length > limit) errors.push(`${field}: tối đa ${limit} ký tự.`);
      if (["frame_number", "brand", "model"].includes(field) && !value)
        errors.push(`${field}: bắt buộc.`);
      Object.assign(data, { [field]: value });
    }
    for (const field of [
      "frame_number",
      "engine_number",
      "license_plate",
    ] as const) {
      const value = (raw[field] || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (value && seen[field].has(value)) {
        errors.push(`${field}: trùng với dòng khác.`);
        isDuplicate = true;
      }
      if (value) seen[field].add(value);
    }
    for (const field of ["purchase_price", "asking_price"] as const) {
      if (!raw[field]?.trim()) continue;
      const amount = parseMoneyInput(raw[field]);
      if (amount === undefined)
        errors.push(`${field}: số tiền nguyên đồng không hợp lệ.`);
      else if (field === "purchase_price" && !canFinancials)
        errors.push(
          "Bạn chưa được cấp quyền nhập giá mua. Bỏ cột giá mua để nhập xe chờ xác nhận giá vốn.",
        );
      else data[field] = amount;
    }
    for (const [field, min, max] of [
      ["year", 1950, Number(businessDay.slice(0, 4)) + 1],
      ["odometer", 0, 10000000],
    ] as const) {
      const value = raw[field]?.trim();
      if (!value) continue;
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < min ||
        Number(value) > max
      )
        errors.push(`${field}: số nguyên từ ${min} đến ${max}.`);
      else Object.assign(data, { [field]: Number(value) });
    }
    const date = raw.purchase_date?.trim() || businessDay;
    if (!dateValue.safeParse(date).success || date > businessDay)
      errors.push("Ngày mua không hợp lệ hoặc ở tương lai.");
    else data.purchase_date = date;
    if (raw.status && raw.status.trim() !== "IN_STOCK")
      errors.push("Chỉ nhập xe vào tồn kho (IN_STOCK).");
    return {
      index: index + 1,
      raw,
      data,
      errors,
      isDuplicate,
      isValid: errors.length === 0,
    };
  });
}

export function downloadVehicleImportTemplate() {
  const sampleData = [
    {
      "Số khung": "RLHJA0123456789",
      "Số máy": "JA01E9876543",
      "Biển số": "29B1-12345",
      Hãng: "Honda",
      "Dòng xe": "Wave Alpha 110",
      "Phiên bản": "Tiêu chuẩn",
      "Năm SX": "2023",
      "Màu sắc": "Đỏ đen",
      "Số km": "5000",
      "Ngày mua": "2026-09-01",
      "Giá mua": "12000000",
      "Giá bán": "15500000",
      "Người bán": "Nguyễn Văn A",
      SĐT: "0987654321",
      "Ghi chú": "Xe chính chủ, máy êm, đủ 2 chìa",
    },
    {
      "Số khung": "RLHSH160X998877",
      "Số máy": "KF16E5544332",
      "Biển số": "29A1-99999",
      Hãng: "Honda",
      "Dòng xe": "SH 160i ABS",
      "Phiên bản": "Thể thao",
      "Năm SX": "2024",
      "Màu sắc": "Xám xi măng",
      "Số km": "2500",
      "Ngày mua": "2026-09-15",
      "Giá mua": "82000000",
      "Giá bán": "94000000",
      "Người bán": "Trần Thị B",
      SĐT: "0912345678",
      "Ghi chú": "Bảo dưỡng định kỳ, khóa smartkey",
    },
  ];

  downloadCsv("mau_nhap_xe_crm.csv", sampleData);
}
