#!/usr/bin/env node
/**
 * Copies the Tesseract WASM runtime out of node_modules into public/tesseract
 * so the Smart Camera's on-device OCR loads locally instead of from a CDN.
 * Generated, git-ignored and idempotent — runs automatically before dev and
 * build via the npm pre-hooks. (The ~2 MB language model still comes from
 * jsDelivr on first use and is then cached; see src/lib/smartcam/local/ocr.ts.)
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "tesseract");
const coreDir = join(outDir, "core");

async function copy(prefixLabel, fromDir, toDir, filter) {
  await mkdir(toDir, { recursive: true });
  const files = (await readdir(fromDir)).filter(filter);
  if (!files.length) {
    console.error(`prepare-ocr-assets: no ${prefixLabel} files found in ${fromDir}`);
    process.exitCode = 1;
    return;
  }
  for (const file of files)
    await copyFile(join(fromDir, file), join(toDir, file));
  console.log(`prepare-ocr-assets: ${prefixLabel} -> ${files.length} file(s)`);
}

// Worker script (single file) + every LSTM core variant (simd / relaxedsimd /
// plain, .js loader + .wasm binary) so whichever the runtime feature-detects
// is served from the same origin.
await copy("worker", join(root, "node_modules", "tesseract.js", "dist"), outDir, (f) => f === "worker.min.js");
await copy(
  "core",
  join(root, "node_modules", "tesseract.js-core"),
  coreDir,
  (f) => f.includes("lstm") && (f.endsWith(".wasm.js") || f.endsWith(".wasm")),
);
