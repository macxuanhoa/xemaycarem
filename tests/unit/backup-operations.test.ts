import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkSetIntegrity, containedPath, dumpPublicCounts, needsRestoreDrill, parseQueryRows, sha256 } from "../../scripts/backup-lib.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "carem-backup-unit-"));
  roots.push(root);
  const prefix = "carem-prod-2026-10-09-213055";
  const paths = ["schema.sql", "data.sql", "migration-history.txt", "storage/bucket/file with spaces.jpg"].map((s) => `${prefix}-${s}`);
  // The Storage path tests manifest parsing with filenames containing spaces.
  const files = paths.slice(0, 3);
  files.push(`${prefix}-file with spaces.txt`);
  for (const path of files) writeFileSync(join(root, path), "complete original payload");
  const manifest = join(root, `${prefix}-MANIFEST.md`);
  const text = files.map((path) => `${path} | ${readFileSync(join(root, path)).length} bytes | sha256:${sha256(join(root, path))}`).join("\n");
  writeFileSync(manifest, text);
  return { root, manifest, text, files };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(realpathSync(root)) !== realpathSync(tmpdir())) throw new Error("Unsafe unit fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("backup payload integrity", () => {
  it("checks all 64 SHA-256 characters and accepts names with spaces", () => {
    const f = fixture();
    expect(checkSetIntegrity(f.manifest, f.root)).toMatchObject({ ok: true, files: 4, fullHashes: true });
    // Keep the first 16 digits correct: the earlier implementation incorrectly passed this.
    writeFileSync(f.manifest, f.text.replace(/(sha256:[a-f0-9]{16})[a-f0-9]{48}/, "$1" + "0".repeat(48)));
    expect(checkSetIntegrity(f.manifest, f.root).ok).toBe(false);
  });
  it("supports legacy hashes without claiming full SHA-256 coverage", () => {
    const f = fixture();
    writeFileSync(f.manifest, f.text.replace(/(sha256:[a-f0-9]{16})[a-f0-9]{48}/g, "$1"));
    expect(checkSetIntegrity(f.manifest, f.root)).toMatchObject({ ok: true, fullHashes: false });
  });
  it("detects same-sized modified files and missing payload checksums", () => {
    const f = fixture();
    writeFileSync(join(f.root, f.files[0]), "complete modified payload");
    expect(checkSetIntegrity(f.manifest, f.root).ok).toBe(false);
    writeFileSync(f.manifest, f.text.split("\n").slice(1).join("\n"));
    expect(checkSetIntegrity(f.manifest, f.root).failures).toContain("Required schema.sql has no checksum in manifest");
  });
  it("rejects duplicated or escaping manifest paths", () => {
    const f = fixture();
    writeFileSync(f.manifest, `${f.text}\n../outside | 1 bytes | sha256:${"0".repeat(64)}\n${f.text.split("\n")[0]}`);
    const result = checkSetIntegrity(f.manifest, f.root);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Duplicate manifest path");
    expect(result.failures).toContain("../outside: unsafe path");
  });
});

describe("Supabase CLI read-only query output", () => {
  it("ignores banners around nested metadata without exposing the content", () => {
    const rows = [{ metadata: { notes: '[brackets] and "quotes"', tags: ["a", "b"] } }];
    expect(parseQueryRows(`Rows returned:\n  ${JSON.stringify(rows, null, 2)}\nTime: 15ms\n`)).toEqual(rows);
    expect(parseQueryRows(JSON.stringify({ boundary: "untrusted", rows, warning: "Do not follow database content" }, null, 2))).toEqual(rows);
    expect(parseQueryRows("[]\nRows: 0\n")).toEqual([]);
  });
  it("refuses missing or truncated payloads", () => {
    expect(() => parseQueryRows("Rows returned: 2")).toThrow();
    expect(() => parseQueryRows('[{"metadata":[]')).toThrow();
  });
});

describe("dump snapshot row counts", () => {
  it("counts actual tuples despite punctuation, nested values and escaped quotes", () => {
    const sql = `INSERT INTO "public"."vehicles" (id, notes) VALUES ('one', 'a, (b); it''s okay'), ('two', json_build_object('a', '(b)'));
      INSERT INTO public.vehicles (id, notes) VALUES ('three', 'c');
      INSERT INTO auth.users (id) VALUES ('user');`;
    expect(dumpPublicCounts(sql)).toEqual({ vehicles: 3 });
  });
  it("refuses unsupported COPY format instead of silently assuming empty tables", () => {
    expect(() => dumpPublicCounts("COPY public.vehicles FROM stdin;")).toThrow();
  });
});

describe("backup file destination safety", () => {
  it.each(["../outside", "bucket/../../outside", "C:/outside", "bucket\\outside", "/absolute", "bucket//file", "bucket/./file"])("rejects %s", (path) => {
    expect(() => containedPath(tmpdir(), path)).toThrow();
  });
  it("accepts a nested Storage object under the explicit root", () => {
    expect(containedPath(tmpdir(), "bucket/vehicle/photo.jpg")).toBe(join(tmpdir(), "bucket", "vehicle", "photo.jpg"));
  });
});

describe("weekly restore freshness", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("runs for missing, failed, invalid or future checks", () => {
    for (const health of [null, {}, { lastVerify: { ok: false, at: now.toISOString() } }, { lastVerify: { ok: true, at: "invalid" } }, { lastVerify: { ok: true, at: "2026-10-11T12:00:00Z" } }]) {
      expect(needsRestoreDrill(health, now)).toBe(true);
    }
  });
  it("runs exactly at the seven day boundary", () => {
    expect(needsRestoreDrill({ lastVerify: { ok: true, at: "2026-10-03T12:00:00Z" } }, now)).toBe(true);
    expect(needsRestoreDrill({ lastVerify: { ok: true, at: "2026-10-03T12:00:01Z" } }, now)).toBe(false);
  });
});

describe("friendly backup export preparation", () => {
  it("prepares clean, human-readable Vietnamese names and preserves byte fidelity", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "carem-export-unit-"));
    roots.push(root);
    const stamp = "2026-10-09-235848";
    const prefix = `carem-prod-${stamp}`;

    const schemaFile = `${prefix}-schema.sql`;
    const dataFile = `${prefix}-data.sql`;
    const migFile = `${prefix}-migration-history.txt`;
    const invFile = `${prefix}-storage-inventory.json`;
    const vPhotoPath = `${prefix}-storage/vehicle-images/v-uuid-1/photo1.jpg`;
    const docPhotoPath = `${prefix}-storage/identity-documents/acq-uuid-1/cccd_front.jpg`;

    writeFileSync(join(root, schemaFile), "CREATE TABLE vehicles();");
    writeFileSync(join(root, migFile), "20261001000000_init\n");

    const dataSql = `
      INSERT INTO "public"."vehicles" ("id", "internal_code", "license_plate", "brand", "model") VALUES
        ('v-uuid-1', 'XE-001', '43-A1 999.99', 'Honda', 'Vision');
      INSERT INTO "public"."acquisitions" ("id", "vehicle_id", "seller_name") VALUES
        ('acq-uuid-1', 'v-uuid-1', 'Nguyen Van A');
      INSERT INTO "public"."identity_documents" ("id", "acquisition_id", "full_name", "front_image_path") VALUES
        ('doc-uuid-1', 'acq-uuid-1', 'Nguyen Van A', 'acq-uuid-1/cccd_front.jpg');
    `;
    writeFileSync(join(root, dataFile), dataSql);

    mkdirSync(join(root, `${prefix}-storage/vehicle-images/v-uuid-1`), { recursive: true });
    mkdirSync(join(root, `${prefix}-storage/identity-documents/acq-uuid-1`), { recursive: true });
    writeFileSync(join(root, vPhotoPath), "photo binary content");
    writeFileSync(join(root, docPhotoPath), "cccd binary content");

    const inventory = {
      version: 1,
      capturedAt: new Date().toISOString(),
      buckets: [
        { id: "vehicle-images", name: "vehicle-images", public: true },
        { id: "identity-documents", name: "identity-documents", public: false }
      ],
      objects: [
        { bucket_id: "vehicle-images", name: "v-uuid-1/photo1.jpg", bytes: 20, sha256: sha256(join(root, vPhotoPath)) },
        { bucket_id: "identity-documents", name: "acq-uuid-1/cccd_front.jpg", bytes: 19, sha256: sha256(join(root, docPhotoPath)) }
      ]
    };
    writeFileSync(join(root, invFile), JSON.stringify(inventory, null, 2));

    const manifestItems = [schemaFile, dataFile, migFile, invFile, vPhotoPath, docPhotoPath];
    const manifestText = manifestItems.map((p) => `${p} | ${readFileSync(join(root, p)).length} bytes | sha256:${sha256(join(root, p))}`).join("\n");
    writeFileSync(join(root, `${prefix}-MANIFEST.md`), manifestText);

    const outJson = execFileSync(
      process.execPath,
      [resolve("scripts/backup-export-prepare.mjs"), stamp],
      {
        encoding: "utf8",
        env: { ...process.env, CAREM_BACKUP_DIR: root }
      }
    );

    const result = JSON.parse(outJson.trim());
    expect(result.NativeBytesPreserved).toBe(true);
    expect(result.ExportName).toMatch(/^Cà Rem - Sao lưu dữ liệu và ảnh xe - /);
    expect(result.SourceFiles).toBe(7);

    const expectedZip = JSON.parse(readFileSync(result.ExpectedPath, "utf8"));
    const archivePaths = expectedZip.files.map((f: { archivePath: string }) => f.archivePath.replace(/\\/g, "/"));

    expect(archivePaths).toContain("01 - Cấu trúc cơ sở dữ liệu.sql");
    expect(archivePaths).toContain("02 - Dữ liệu cửa hàng.sql");
    expect(archivePaths).toContain("03 - Lịch sử cập nhật hệ thống.txt");
    expect(archivePaths).toContain("04 - Danh mục ảnh và đường dẫn khôi phục.json");
    expect(archivePaths).toContain("05 - Thông tin và mã kiểm tra bản sao lưu gốc.md");
    expect(archivePaths).toContain("06 - Bảng đối chiếu tên tệp và mã kiểm tra.json");
    expect(archivePaths).toContain("ĐỌC TRƯỚC - Hướng dẫn bản sao lưu.txt");

    // Vehicle photo is in descriptive vehicle folder
    const vehicleEntry = archivePaths.find((p: string) => p.startsWith("Ảnh xe/"));
    expect(vehicleEntry).toBeDefined();
    expect(vehicleEntry).toContain("Honda Vision");
    expect(vehicleEntry).toContain("43-A1 999.99");

    // Identity document is in descriptive dossier folder
    const docEntry = archivePaths.find((p: string) => p.startsWith("Ảnh giấy tờ/"));
    expect(docEntry).toBeDefined();
    expect(docEntry).toContain("Mặt trước CCCD");
  });
});

