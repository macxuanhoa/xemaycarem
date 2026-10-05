/**
 * Vocabulary for the shorthand vehicle-intake notes parser.
 * All lookups happen on `normalizeKey` output: lowercase, no diacritics,
 * `đ` → `d`, so "SH", "sh", "Đen", "den" all match the same entry.
 */

export function normalizeKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/** Normalized alias → canonical brand. */
export const BRAND_ALIASES: Record<string, string> = {
  honda: "Honda",
  hd: "Honda",
  yamaha: "Yamaha",
  yam: "Yamaha",
  ym: "Yamaha",
  sym: "SYM",
  suzuki: "Suzuki",
  sz: "Suzuki",
  piaggio: "Piaggio",
  vespa: "Piaggio",
  vb: "Vinfast",
  vinfast: "Vinfast",
};

/** Normalized alias → canonical model (brand inferred via MODEL_BRANDS). */
export const MODEL_ALIASES: Record<string, string> = {
  sh: "SH",
  shmode: "SH Mode",
  vision: "Vision",
  vis: "Vision",
  wave: "Wave",
  rsx: "Wave RSX",
  wsx: "Wave RSX",
  blade: "Blade",
  future: "Future",
  lead: "Lead",
  ab: "Air Blade",
  airblade: "Air Blade",
  aireblade: "Air Blade",
  janus: "Janus",
  nvx: "NVX",
  exciter: "Exciter",
  ex: "Exciter",
  r15: "R15",
  sirius: "Sirius",
  sir: "Sirius",
  click: "Click",
  cerberus: "Cerberus",
  nox: "Noxx",
  angela: "Angela",
  elysian: "Elysian",
  star80: "Star 80",
  fine: "Fine",
  revo: "Revo",
  axelo: "Axelo",
  glazer: "Glazer",
  ufix: "Uix",
  pegaso: "Pegaso",
  zongshen: "Zongshen",
};

/** Canonical model → canonical brand, used to complete half-written lines. */
export const MODEL_BRANDS: Record<string, string> = {
  SH: "Honda",
  "SH Mode": "Honda",
  Vision: "Honda",
  Wave: "Honda",
  "Wave RSX": "Honda",
  Blade: "Honda",
  Future: "Honda",
  Lead: "Honda",
  "Air Blade": "Honda",
  Zoomer: "Honda",
  Exciter: "Yamaha",
  Sirius: "Yamaha",
  Janus: "Yamaha",
  NVX: "Yamaha",
  Click: "Yamaha",
  R15: "Yamaha",
  Freego: "Yamaha",
  Noxx: "Yamaha",
  Angela: "SYM",
  Elysian: "SYM",
  "Star 80": "SYM",
  Fine: "SYM",
  Revo: "Suzuki",
  Axelo: "Suzuki",
  Glazer: "Suzuki",
  Uix: "Suzuki",
  Pegaso: "Suzuki",
};

/** Normalized alias → canonical color. */
export const COLOR_ALIASES: Record<string, string> = {
  den: "Đen",
  trang: "Trắng",
  do: "Đỏ",
  dodon: "Đỏ đô",
  xanh: "Xanh",
  xanhla: "Xanh lá",
  xanhduong: "Xanh dương",
  nau: "Nâu",
  bac: "Bạc",
  xam: "Xám",
  vang: "Vàng",
  cam: "Cam",
  hong: "Hồng",
  tim: "Tím",
  kem: "Kem",
};

/**
 * Normalized keyword → field the NEXT token belongs to.
 * `notes` swallows the rest of the line.
 */
export const KEYWORD_FIELDS: Record<string, string> = {
  fk: "frame_number",
  khung: "frame_number",
  chassi: "frame_number",
  gm: "engine_number",
  may: "engine_number",
  bs: "license_plate",
  bien: "license_plate",
  bienso: "license_plate",
  sdt: "supplier_phone",
  dt: "supplier_phone",
  phone: "supplier_phone",
  dienthoai: "supplier_phone",
  tel: "supplier_phone",
  gia: "price",
  giathu: "price",
  thu: "price",
  giasale: "price2",
  giaban: "price2",
  giabannoi: "price2",
  niemyet: "price2",
  banra: "price2",
  km: "odometer",
  van: "odometer",
  nam: "year",
  yr: "year",
  ngay: "purchase_date",
  date: "purchase_date",
  ten: "supplier_name",
  chu: "supplier_name",
  cua: "supplier_name",
  anh: "supplier_name",
  chi: "supplier_name",
  em: "supplier_name",
  fn: "supplier_name",
  ghcn: "notes",
  ghichu: "notes",
  note: "notes",
  notes: "notes",
};

/** Tokens that carry no field meaning and can be dropped silently. */
export const STOP_TOKENS = new Set([
  "va",
  "voi",
  "cung",
  "them",
  "co",
  "khong",
  "dc",
  "ok",
  "aloo",
  "alo",
  "ca",
  "nua",
]);

/** Normalized variant/option tokens kept out of the model name. */
export const VARIANT_TOKENS: Record<string, string> = {
  abs: "ABS",
  pbs: "CBS/ABS",
  cbs: "CBS",
  phunxe: "Phun xăng",
  cb: "CB",
  "1d": "1 đĩa",
  "2d": "2 đĩa",
  disco: "Disc",
  lazang: "Mâm đúc",
  mamduc: "Mâm đúc",
};
