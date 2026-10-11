// Đông gói tiện ích "Cà Rem · Cầu đăng Facebook" thành một file .zip đặt trong
// public/ để người bán hàng tải về từ ngay trong CRM.
//
// Vì sao không bỏ thẳng extension/*.js vào public/? Cấu hình PWA precache theo
// mẫu `**/*.{js,css,html,svg,png,woff2}`; ba file của extension sẽ bị đưa vào
// service worker và mỗi lần sửa tiện ích là cả app shell đổi phiên bản cache.
// .zip không khớp mẫu nào nên nằm ngoài vòng đó.
//
// Không dùng thư viện nén: ZIP ở chế độ STORE (không deflate) + CRC32 tự tính là
// đủ để Chrome/Edge giải nén khi "Load unpacked" từ file tải về.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = join(ROOT, "extension", "carem-fb-share");
const OUT_DIR = join(ROOT, "public");
const OUT_FILE = join(OUT_DIR, "carem-fb-extension.zip");
const REQUIRED = ["manifest.json", "background.js", "content.js"];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS timestamp — ZIP không cần chính xác từng giây, chỉ cần không hợp lệ. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll(sep, "/"), "utf8");
    const data = entry.data;
    const stamp = dosDateTime(entry.mtime);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version cần để giải nén
    local.writeUInt16LE(0x0800, 6); // UTF-8 tên tệp
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 30);
    central.writeUInt32LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlob.length, 12);
  end.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, end]);
}

async function main() {
  let names;
  try {
    names = await readdir(SOURCE_DIR);
  } catch {
    console.error(`[fb-extension] Không thấy thư mục tiện ích: ${relative(ROOT, SOURCE_DIR)}`);
    process.exit(1);
  }
  for (const required of REQUIRED) {
    if (!names.includes(required)) {
      console.error(`[fb-extension] Thiếu file bắt buộc: ${required}`);
      process.exit(1);
    }
  }
  // Manifest phải đọc được và là JSON hợp lệ — gói một tiện ích hỏng thì người
  // dùng chỉ mất thời gian nghi ngờ CRM.
  const manifest = JSON.parse(await readFile(join(SOURCE_DIR, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || !manifest.key) {
    console.error("[fb-extension] manifest.json phải là MV3 và có khoá `key` để ID tiện ích ổn định.");
    process.exit(1);
  }

  const entries = [];
  for (const name of names.sort()) {
    const full = join(SOURCE_DIR, name);
    const info = await stat(full);
    if (!info.isFile()) continue;
    entries.push({ name: `carem-fb-share/${name}`, data: await readFile(full), mtime: info.mtime });
  }

  const zip = buildZip(entries);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, zip);
  const digest = createHash("sha256").update(zip).digest("hex").slice(0, 12);
  console.log(
    `[fb-extension] Đã gói ${entries.length} tệp → ${relative(ROOT, OUT_FILE)} (${(zip.length / 1024).toFixed(1)} KB, sha256:${digest})`,
  );
}

main().catch((error) => {
  console.error(`[fb-extension] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
