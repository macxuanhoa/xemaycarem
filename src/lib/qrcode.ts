import QRCode from "qrcode";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function vehicleQrUrl(
  id: string,
  origin = window.location.origin,
): string {
  if (!uuid.test(id)) throw new Error("Mã xe không hợp lệ.");
  return new URL(`/vehicles/${id}`, origin).href;
}

/** Accept our own vehicle identity only; never follow an arbitrary scanned URL. */
export function resolveVehicleQr(value: string, origin: string): string | null {
  if (uuid.test(value.trim())) return value.trim();
  try {
    const url = new URL(value.trim(), origin);
    if (url.origin !== new URL(origin).origin || url.search || url.hash)
      return null;
    const match = /^\/vehicles\/([^/]+)\/?$/.exec(url.pathname);
    return match && uuid.test(match[1]) ? match[1] : null;
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
