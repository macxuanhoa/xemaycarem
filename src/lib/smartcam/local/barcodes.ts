/**
 * QR/barcode recognition. The browser-native BarcodeDetector API is tried
 * first — it is a hardware-accelerated system service on Chrome/Edge/Android
 * and decodes a frame in milliseconds. Browsers without it (iOS Safari) fall
 * back to ZXing (pure JS, lazy-loaded). A frame is decoded on two regions —
 * the whole picture and the lower band where stickers usually sit — and
 * distinct payloads are merged, so multiple visible codes in one frame are
 * all reported.
 */
import { sourceCanvas, toGray } from "./frames";

type NativeBarcode = { rawValue?: string };
type NativeBarcodeDetectorLike = {
  detect: (image: CanvasImageSource) => Promise<NativeBarcode[]>;
};
type NativeBarcodeDetectorCtor = new (
  options?: { formats?: string[] },
) => NativeBarcodeDetectorLike;

/** Undefined = not probed yet; null = native decoding not usable here. */
let nativeDetector: NativeBarcodeDetectorLike | null | undefined;

function getNativeDetector(): NativeBarcodeDetectorLike | null {
  if (nativeDetector === undefined) {
    const Ctor =
      typeof window === "undefined"
        ? undefined
        : (
            window as unknown as {
              BarcodeDetector?: NativeBarcodeDetectorCtor;
            }
          ).BarcodeDetector;
    try {
      // No explicit formats: every code type the browser supports.
      nativeDetector = Ctor ? new Ctor() : null;
    } catch {
      nativeDetector = null;
    }
  }
  return nativeDetector;
}

/** Reusable module handle; a failed import disables codes for the session. */
let zxDynamic: Promise<typeof import("@zxing/library") | null> | null = null;

function zxing() {
  if (!zxDynamic)
    zxDynamic = import("@zxing/library").catch(() => null);
  return zxDynamic;
}

let reader: InstanceType<typeof import("@zxing/library").MultiFormatReader> | null = null;
let pureQrReader: InstanceType<typeof import("@zxing/library").QRCodeReader> | null = null;
let hints: Map<import("@zxing/library").DecodeHintType, unknown> | null = null;

function buildHints(mod: typeof import("@zxing/library")): Map<import("@zxing/library").DecodeHintType, unknown> {
  const map = new Map<import("@zxing/library").DecodeHintType, unknown>();
  map.set(mod.DecodeHintType.POSSIBLE_FORMATS, [
    mod.BarcodeFormat.QR_CODE,
    mod.BarcodeFormat.AZTEC,
    mod.BarcodeFormat.DATA_MATRIX,
    mod.BarcodeFormat.CODE_128,
    mod.BarcodeFormat.CODE_39,
    mod.BarcodeFormat.CODE_93,
    mod.BarcodeFormat.ITF,
    mod.BarcodeFormat.EAN_8,
    mod.BarcodeFormat.EAN_13,
    mod.BarcodeFormat.UPC_A,
  ]);
  map.set(mod.DecodeHintType.TRY_HARDER, true);
  return map;
}

/** The lower-middle band where vehicle stickers usually sit below the plate. */
function lowerBand(full: HTMLCanvasElement): HTMLCanvasElement | null {
  const band = document.createElement("canvas");
  band.width = full.width;
  band.height = Math.round(full.height * 0.45);
  const ctx = band.getContext("2d", { willReadFrequently: true });
  if (!ctx || band.width <= 0 || band.height <= 0) return null;
  ctx.drawImage(
    full,
    0,
    Math.round(full.height * 0.4),
    full.width,
    band.height,
    0,
    0,
    band.width,
    band.height,
  );
  return band;
}

/** Decode every configured region of one frame; returns distinct payloads. */
export async function detectCodes(
  video: HTMLVideoElement | HTMLCanvasElement,
): Promise<string[]> {
  const full =
    video instanceof HTMLCanvasElement ? video : sourceCanvas(video, 640);
  if (!full) return [];
  const regions: HTMLCanvasElement[] = [full];
  const band = lowerBand(full);
  if (band) regions.push(band);

  const native = getNativeDetector();
  if (native) {
    try {
      const found = new Set<string>();
      for (const region of regions)
        for (const code of await native.detect(region)) {
          const text = code.rawValue?.trim();
          if (text) found.add(text);
        }
      return [...found];
    } catch {
      // Construction succeeded but runtime decoding is broken (common on
      // desktop Safari) — ZXing takes the rest of this session.
      nativeDetector = null;
    }
  }

  const mod = await zxing();
  if (!mod) return [];
  reader ??= new mod.MultiFormatReader();
  hints ??= buildHints(mod);
  const found = new Set<string>();
  for (const region of regions) {
    const gray = toGray(region);
    if (!gray) continue;
    const source = new mod.RGBLuminanceSource(gray.data, gray.width, gray.height);
    const bitmap = new mod.BinaryBitmap(new mod.HybridBinarizer(source));
    try {
      const result = reader.decode(bitmap, hints);
      const text = result.getText()?.trim();
      if (text) found.add(text);
    } catch {
      // NotFoundException/ChecksumException are the normal "no code here".
      // A clean gallery screenshot can defeat the perspective/finder-pattern
      // detector even when its QR modules are intact. The QR-only pure path
      // bypasses that detector and still validates the QR payload/checksum.
      // Real photos retain the normal detection pass above.
      pureQrReader ??= new mod.QRCodeReader();
      try {
        const pureHints = new Map<import("@zxing/library").DecodeHintType, unknown>();
        pureHints.set(mod.DecodeHintType.PURE_BARCODE, true);
        const text = pureQrReader.decode(bitmap, pureHints).getText()?.trim();
        if (text) found.add(text);
      } catch { /* The region is neither a detectable code nor a pure QR. */ }
      pureQrReader.reset();
    }
    reader.reset();
  }
  return [...found];
}
