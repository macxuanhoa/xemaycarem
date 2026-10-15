import QRCode from "qrcode";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vehicleQrPrefix = "carem:vehicle:v1:";

/** Printed identity survives domain changes and contains no session or PII. */
export function vehicleQrPayload(id: string): string {
  if (!uuid.test(id)) throw new Error("Mã xe không hợp lệ.");
  return `${vehicleQrPrefix}${id.toLowerCase()}`;
}

export function vehicleQrUrl(
  id: string,
  origin = window.location.origin,
): string {
  if (!uuid.test(id)) throw new Error("Mã xe không hợp lệ.");
  return new URL(`/vehicles/${id}`, origin).href;
}

/** Accept our own vehicle identity only; never follow an arbitrary scanned URL. */
export function resolveVehicleQr(value: string, origin: string): string | null {
  const text = value.trim();
  if (text.startsWith(vehicleQrPrefix)) {
    const id = text.slice(vehicleQrPrefix.length);
    return uuid.test(id) ? id.toLowerCase() : null;
  }
  if (uuid.test(text)) return text.toLowerCase();
  try {
    const url = new URL(text, origin);
    if (url.origin !== new URL(origin).origin || url.search || url.hash)
      return null;
    const match = /^\/vehicles\/([^/]+)\/?$/.exec(url.pathname);
    return match && uuid.test(match[1]) ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function generateQrSvg(value: string, size = 240): Promise<string> {
  return QRCode.toString(value, {
    type: "svg",
    width: size,
    margin: 4,
    errorCorrectionLevel: "M",
  });
}

/** PNG dùng cho tải về/in tem: mở được trên mọi điện thoại, máy in tem không đọc được SVG. */
export function generateQrPng(value: string, size = 480): Promise<string> {
  return QRCode.toDataURL(value, {
    width: size,
    margin: 4,
    errorCorrectionLevel: "M",
  });
}

/**
 * Tải data URL xuống thành file mà không điều hướng sang trang khác.
 * Anchor phải nằm trong DOM và blob chỉ được thu hồi sau khi trình duyệt
 * đã đọc xong — thu hồi sớm làm Safari/iPad mở tab lỗi.
 */
export function downloadQrDataUrl(dataUrl: string, filename: string): void {
  const [head, base64] = dataUrl.split(",");
  const mime = /^data:(.*?)(;|$)/.exec(head)?.[1] ?? "application/octet-stream";
  const binary = atob(base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
