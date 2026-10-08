import { test, expect } from "@playwright/test";
import { installUiuxMock, vehicleId } from "../helpers/uiux-fixtures.mjs";

// CCCD capture bar (seller on a vehicle, buyer on a sale): the "Chụp lại" /
// "Ảnh khác" pair must read as ONE stable control row whichever side is the
// current target. The bar used to be a wrapping flex row, so the 12px longer
// "Đang thêm: Mặt trước" caption pushed the whole pair onto a row of its own
// while "Mặt sau" kept it inline — the buttons visibly jumped sideways between
// 399px and 405px (iPhone 16 Pro / 17 Pro class widths). The layout may fold
// only on a hard breakpoint (≤389px), never on label length.

const acquisitionId = "00000000-0000-4000-8000-0000000000aa";
const SUPABASE = /https:\/\/[a-z0-9-]+\.supabase\.co\/.*/;
const documentWith = (paths) => ({
  id: "00000000-0000-4000-8000-0000000000bb",
  front_image_path: paths.front,
  back_image_path: paths.back,
});

async function installIdentityMock(page, doc) {
  await page.route(SUPABASE, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (
      name !== "get_acquisition_for_vehicle" &&
      name !== "get_identity_document"
    )
      return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        name === "get_acquisition_for_vehicle" ? acquisitionId : doc,
      ),
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      },
    });
  });
}

async function barGeometry(page) {
  return page.evaluate(() => {
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        right: r.right,
        bottom: r.bottom,
        centreY: Math.round(r.top + r.height / 2),
      };
    };
    const bar = document.querySelector(".identity-action-bar");
    const group = document.querySelector(".identity-upload-actions");
    return {
      target: bar.querySelector("strong").textContent,
      bar: box(bar),
      caption: box(bar.querySelector(".muted")),
      buttons: [...group.querySelectorAll(".upload-button")].map(box),
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });
}

async function selectSideAndMeasure(page, side) {
  await page.getByRole("button", { name: `Chọn mặt ${side} để chụp` }).click();
  const geometry = await barGeometry(page);
  expect(geometry.target).toBe(side === "trước" ? "Mặt trước" : "Mặt sau");
  return geometry;
}

function expectStablePair(geometry, width) {
  const [first, last] = geometry.buttons;
  // One horizontal line, never a stacked pair.
  expect(Math.abs(first.y - last.y)).toBeLessThanOrEqual(1);
  expect(last.x).toBeGreaterThan(first.x);
  // Comfortable tap target is kept by the compact mobile styling.
  expect(first.h).toBeGreaterThanOrEqual(41);
  expect(last.h).toBeGreaterThanOrEqual(41);
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  if (width >= 390) {
    // Preferred phone layout: caption left, pair right, all on the same row.
    expect(first.centreY).toBe(Math.round(geometry.bar.centreY));
    expect(last.centreY).toBe(first.centreY);
    expect(
      Math.abs(geometry.caption.centreY - first.centreY),
    ).toBeLessThanOrEqual(2);
    // Caption never wraps to a second line, so switching sides cannot nudge it.
    expect(geometry.caption.h).toBeLessThanOrEqual(24);
  } else {
    // Hard-fold tier: the caption owns a row and the pair spreads evenly below.
    expect(geometry.caption.bottom).toBeLessThanOrEqual(first.y + 1);
    expect(Math.abs(first.w - last.w)).toBeLessThanOrEqual(1);
  }
}

for (const [state, doc] of [
  [
    "retake",
    documentWith({
      front: `${acquisitionId}/f.png`,
      back: `${acquisitionId}/b.png`,
    }),
  ],
  ["first capture", documentWith({ front: null, back: null })],
]) {
  test.describe(`CCCD ${state} action bar`, () => {
    for (const width of [320, 360, 375, 390, 393, 402, 430, 440]) {
      test(`keeps the pair identical for both sides at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await installUiuxMock(page);
        await installIdentityMock(page, doc);
        await page.goto(`/vehicles/${vehicleId}`);
        await expect(page.locator(".identity-action-bar")).toBeVisible();

        const front = await selectSideAndMeasure(page, "trước");
        const back = await selectSideAndMeasure(page, "sau");
        expectStablePair(front, width);
        expectStablePair(back, width);
        // Switching the target side must not move the cluster at all.
        expect(back.buttons.map((b) => Math.round(b.y))).toEqual(
          front.buttons.map((b) => Math.round(b.y)),
        );
        expect(Math.round(back.buttons[1].right)).toBe(
          Math.round(front.buttons[1].right),
        );
        expect(back.bar.h).toBe(front.bar.h);
        expect(back.buttons.map((b) => Math.round(b.x))).toEqual(
          front.buttons.map((b) => Math.round(b.x)),
        );
      });
    }
  });
}
