import { describe, expect, it } from "vitest";
import {
  analyzeGray,
  chooseBestFrameIndex,
  deskewGeometry,
} from "../../src/lib/smartcam/local/regions";
import type { Gray } from "../../src/lib/smartcam/local/frames";

function image(width = 480, height = 240, background = 235): Gray {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height).fill(background),
  };
}

/** Separate strokes have known coordinates, independent of the detector. */
function glyphLine(
  gray: Gray,
  x: number,
  y: number,
  count = 9,
  size = 24,
  angle = 0,
) {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians),
    sin = Math.sin(radians);
  for (let py = 0; py < gray.height; py++)
    for (let px = 0; px < gray.width; px++) {
      const dx = px - x,
        dy = py - y;
      const localX = dx * cos + dy * sin,
        localY = -dx * sin + dy * cos;
      const index = Math.floor(localX / (size * 0.8));
      if (
        index >= 0 &&
        index < count &&
        localX - index * size * 0.8 >= 0 &&
        localX - index * size * 0.8 < size * 0.48 &&
        localY >= 0 &&
        localY < size
      ) {
        gray.data[py * gray.width + px] = 15;
      }
    }
  return gray;
}

function soften(gray: Gray, radius = 3): Gray {
  let current = gray;
  for (let pass = 0; pass < 3; pass++) {
    const data = new Uint8ClampedArray(current.data.length);
    for (let y = 0; y < gray.height; y++)
      for (let x = 0; x < gray.width; x++) {
        let sum = 0,
          count = 0;
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = Math.max(0, Math.min(gray.width - 1, x + dx));
            const sy = Math.max(0, Math.min(gray.height - 1, y + dy));
            sum += current.data[sy * gray.width + sx];
            count++;
          }
        data[y * gray.width + x] = sum / count;
      }
    current = { ...gray, data };
  }
  return current;
}

describe("content-based text regions", () => {
  it("finds the same text at the top and bottom rather than relying on a fixed scan band", () => {
    const upper = analyzeGray(glyphLine(image(), 130, 18));
    const lower = analyzeGray(glyphLine(image(), 130, 195));
    expect(upper.regions).toHaveLength(1);
    expect(lower.regions).toHaveLength(1);
    expect(upper.regions[0].bounds.y).toBeLessThan(20);
    expect(lower.regions[0].bounds.y).toBeGreaterThan(180);
    expect(lower.regions[0].normalized.y).toBeCloseTo(
      lower.regions[0].bounds.y / 240,
    );
    expect(upper.regions[0].bounds.x).toBeCloseTo(lower.regions[0].bounds.x, 0);
    expect(upper.regions[0].kind).toBe("line");
  });

  it("measures a mild clockwise or counterclockwise baseline tilt", () => {
    for (const angle of [-14, 14]) {
      const analysis = analyzeGray(glyphLine(image(), 100, 100, 12, 24, angle));
      expect(analysis.regions, `angle ${angle}`).toHaveLength(1);
      expect(analysis.regions[0].angleDegrees).toBeCloseTo(angle, 0);
      const geometry = deskewGeometry(
        analysis.regions[0].bounds,
        analysis.regions[0].angleDegrees,
      );
      const baseline = [
        Math.cos((angle * Math.PI) / 180),
        Math.sin((angle * Math.PI) / 180),
      ];
      const straightenedY =
        baseline[0] * Math.sin(geometry.radians) +
        baseline[1] * Math.cos(geometry.radians);
      expect(Math.abs(straightenedY)).toBeLessThan(0.015);
    }
  });

  it("combines two close rows into one block while keeping a separate stamp", () => {
    const gray = image(480, 280);
    glyphLine(gray, 40, 25, 4, 25);
    glyphLine(gray, 30, 65, 5, 25);
    glyphLine(gray, 205, 205, 12, 20);
    const analysis = analyzeGray(gray);
    expect(analysis.regions).toHaveLength(2);
    const block = analysis.regions.find((region) => region.kind === "block");
    const line = analysis.regions.find((region) => region.kind === "line");
    expect(block?.bounds.y).toBeLessThan(25);
    expect(block?.bounds.height).toBeGreaterThan(65);
    expect(line?.bounds.y).toBeGreaterThan(190);
  });

  it("retains two separate text objects so OCR can still detect conflicts", () => {
    const gray = image(480, 300);
    glyphLine(gray, 35, 35, 9, 20);
    glyphLine(gray, 240, 200, 9, 20);
    const regions = analyzeGray(gray).regions;
    expect(regions).toHaveLength(2);
    expect(regions[0].bounds.y).not.toBe(regions[1].bounds.y);
  });

  it("prioritizes a readable two-row block over smaller background labels", () => {
    const gray = image(480, 300);
    glyphLine(gray, 40, 25, 4, 25);
    glyphLine(gray, 30, 65, 5, 25);
    glyphLine(gray, 200, 195, 12, 14);
    glyphLine(gray, 200, 240, 17, 12);
    expect(
      analyzeGray(gray)
        .regions.slice(0, 2)
        .some((region) => region.kind === "block" && region.bounds.y < 25),
    ).toBe(true);
  });

  it("maps bounded analysis back to original image pixels", () => {
    const small = analyzeGray(glyphLine(image(480, 240), 100, 100, 9, 24));
    const large = analyzeGray(glyphLine(image(1440, 720), 300, 300, 9, 72));
    expect(large.regions).toHaveLength(1);
    expect(large.regions[0].normalized.x).toBeCloseTo(
      small.regions[0].normalized.x,
      2,
    );
    expect(large.regions[0].normalized.y).toBeCloseTo(
      small.regions[0].normalized.y,
      2,
    );
    expect(large.regions[0].characterHeight).toBeCloseTo(
      small.regions[0].characterHeight * 3,
      0,
    );
    expect(large.regions[0].bounds.x).toBeGreaterThan(250);
  });

  it("returns no invented region on blank, solid or oversized non-text areas", () => {
    for (const value of [0, 120, 255])
      expect(analyzeGray(image(400, 200, value)).regions).toEqual([]);
    const gray = image(480, 240);
    for (let y = 40; y < 200; y++)
      for (let x = 30; x < 430; x++) gray.data[y * gray.width + x] = 0;
    expect(analyzeGray(gray).regions).toEqual([]);
    expect(
      analyzeGray({ width: 0, height: 0, data: new Uint8ClampedArray() })
        .quality.score,
    ).toBe(0);
  });
});

describe("quality guidance and best-frame ranking", () => {
  it("guides dark capture without flagging ordinary white paper as glare", () => {
    expect(analyzeGray(image(480, 240, 20)).quality.issues).toContain("dark");
    const white = analyzeGray(glyphLine(image(480, 240, 255), 100, 100));
    expect(white.quality.issues).not.toContain("glare");
    expect(white.quality.issues).not.toContain("dark");
  });

  it("warns about a broad saturated patch in a midtone scene", () => {
    const gray = image(480, 240, 110);
    for (let y = 30; y < 210; y++)
      for (let x = 150; x < 350; x++) gray.data[y * gray.width + x] = 255;
    expect(analyzeGray(gray).quality.issues).toContain("glare");
  });

  it("ranks sharp strokes above a blurred observation and warns when text is too small", () => {
    const clear = glyphLine(image(), 120, 100, 9, 24);
    const blurred = analyzeGray(soften(clear));
    const sharp = analyzeGray(clear);
    expect(blurred.quality.sharpness).toBeLessThan(sharp.quality.sharpness);
    expect(blurred.quality.issues).toContain("blur");
    expect(sharp.quality.score).toBeGreaterThan(blurred.quality.score);
    expect(
      analyzeGray(glyphLine(image(), 120, 100, 9, 7)).quality.issues,
    ).toContain("too-far");
    expect(chooseBestFrameIndex([blurred, null, sharp])).toBe(2);
    expect(chooseBestFrameIndex([null, null])).toBe(-1);
  });

  it("preserves source extents when straightening and bounds extreme input angles", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 40 };
    expect(deskewGeometry(bounds, 0)).toEqual({
      width: 200,
      height: 40,
      radians: -0,
    });
    expect(deskewGeometry(bounds, 40)).toEqual(deskewGeometry(bounds, 20));
    const rotated = deskewGeometry(bounds, -14);
    expect(rotated.width).toBeGreaterThan(200);
    expect(rotated.height).toBeGreaterThan(40);
  });
});
