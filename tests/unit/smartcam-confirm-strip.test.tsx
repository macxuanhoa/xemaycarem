/**
 * The ask-a-human surface. Rendered to markup because what must be proven here
 * is the contract with the staff: only the character the camera could not
 * resolve is marked, the runner-up reading is shown, an in-stock near match is
 * offered as a question, and nothing proceeds without a tap.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ScanConfirmStrip from "@/features/capture/ScanConfirmStrip";
import type { NearMatch } from "@/lib/smartcam/inventoryPrior";

const vehicle = {
  id: "22222222-2222-4222-8222-222222222222",
  internal_code: "XE-2026-0007",
  license_plate: "59B1-234.56",
  frame_number: "RLH160KD12345",
  vehicle_type: "Xe tay ga",
  status: "IN_STOCK",
};

const near: NearMatch = {
  field: "license_plate",
  vehicle,
  position: 7,
  readGlyph: "S",
  storedGlyph: "5",
  matched: 8,
  total: 9,
};

const render = (over = {}) =>
  renderToStaticMarkup(
    <ScanConfirmStrip
      confirmation={{
        fields: { license_plate: "59B1-234.S6", frame_number: "" },
        disputed: { license_plate: [7], frame_number: [] },
        alternatives: { license_plate: ["59B1-234.56"], frame_number: [] },
        near: [],
        ...over,
      }}
      onAccept={() => {}}
      onRescan={() => {}}
      onUseInventory={() => {}}
    />,
  );

describe("scan confirm strip", () => {
  it("marks exactly the unresolved character", () => {
    const html = render();
    expect(html).toContain("smartcam-confirm-glyph");
    expect(html.match(/smartcam-confirm-glyph/g)).toHaveLength(1);
    expect(html).toContain(">S<");
    expect(html).toContain("Camera chưa chắc chắn 100%");
  });
  it("shows the alternative reading it ranked second", () => {
    expect(render()).toContain("Cách đọc khác: 59B1-234.56");
  });
  it("offers the in-stock record as a question, never as an answer", () => {
    const html = render({ near: [near] });
    expect(html).toContain("Trong kho có xe 59B1-234.56 khớp 8/9 ký tự biển số");
    expect(html).toContain("Đúng xe này");
  });
  it("always gives the staff a way out", () => {
    const html = render();
    expect(html).toContain("Đúng, dùng kết quả này");
    expect(html).toContain("Quét lại");
  });
  it("renders no warning mark for a field with nothing disputed", () => {
    const html = render({ disputed: { license_plate: [], frame_number: [] } });
    expect(html).not.toContain("smartcam-confirm-glyph");
  });
  it("keeps the long chassis number on its own row", () => {
    const html = render({
      fields: { license_plate: "59B1-234.56", frame_number: "RLH160KD1234S" },
      disputed: { license_plate: [], frame_number: [12] },
    });
    expect(html).toContain("smartcam-field tone-warn wide");
    expect(html.match(/smartcam-confirm-glyph/g)).toHaveLength(1);
  });
});
