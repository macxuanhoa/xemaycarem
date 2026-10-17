import type { Gray } from "./frames";

export type RegionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type DetectedRegion = {
  bounds: RegionBounds;
  /** Coordinates relative to the input image; useful for a viewfinder overlay. */
  normalized: RegionBounds;
  /** Clockwise text-baseline angle. Rotate by its negative before recognition. */
  angleDegrees: number;
  confidence: number;
  characterHeight: number;
  kind: "line" | "block";
};
export type QualityIssue = "dark" | "glare" | "blur" | "too-far";
export type FrameQuality = {
  score: number;
  meanLuma: number;
  contrast: number;
  /** Normalized second-derivative energy; guidance, not an OCR acceptance gate. */
  sharpness: number;
  darkFraction: number;
  brightFraction: number;
  issues: QualityIssue[];
  message: string;
};
export type FrameAnalysis = {
  width: number;
  height: number;
  regions: DetectedRegion[];
  quality: FrameQuality;
};

type Component = RegionBounds & { area: number; cx: number; cy: number };
type TextLine = {
  bounds: RegionBounds;
  angle: number;
  height: number;
  count: number;
  confidence: number;
};
const MAX_ANALYSIS_EDGE = 480;
const MAX_COMPONENTS = 700;
const RAD = Math.PI / 180;
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const median = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
};

/** Analysis costs at most 480² pixels regardless of the uploaded image size. */
function boundedGray(gray: Gray): { image: Gray; scale: number } {
  const scale = Math.min(
    1,
    MAX_ANALYSIS_EDGE / Math.max(gray.width, gray.height),
  );
  if (scale === 1) return { image: gray, scale };
  const width = Math.max(1, Math.round(gray.width * scale));
  const height = Math.max(1, Math.round(gray.height * scale));
  const data = new Uint8ClampedArray(width * height);
  // Four samples retain narrow strokes better than one nearest-neighbour sample.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) / scale;
      const sy = (y + 0.5) / scale;
      let sum = 0;
      for (const dy of [-0.25, 0.25])
        for (const dx of [-0.25, 0.25]) {
          const ix = clamp(Math.floor(sx + dx / scale), 0, gray.width - 1);
          const iy = clamp(Math.floor(sy + dy / scale), 0, gray.height - 1);
          sum += gray.data[iy * gray.width + ix];
        }
      data[y * width + x] = sum / 4;
    }
  return { image: { width, height, data }, scale };
}

function histogram(gray: Gray): Uint32Array {
  const result = new Uint32Array(256);
  for (const value of gray.data) result[value]++;
  return result;
}

function percentile(
  hist: Uint32Array,
  count: number,
  fraction: number,
): number {
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += hist[value];
    if (seen >= count * fraction) return value;
  }
  return 255;
}

/** Otsu plus local contrast handles clean plates and unevenly lit metal stamps. */
function foreground(gray: Gray, hist: Uint32Array): Uint8Array {
  const { width, height, data } = gray;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = 0;
  let threshold = 0;
  for (let value = 0; value < 255; value++) {
    backgroundWeight += hist[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = data.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * hist[value];
    const delta =
      backgroundSum / backgroundWeight -
      (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * delta * delta;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const mask = new Uint8Array(data.length);
  const radius = Math.max(8, Math.round(Math.min(width, height) * 0.035));
  const spread =
    percentile(hist, data.length, 0.98) - percentile(hist, data.length, 0.02);
  const localDelta = Math.max(12, spread * 0.1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius),
        y0 = Math.max(0, y - radius);
      const x1 = Math.min(width, x + radius + 1),
        y1 = Math.min(height, y + radius + 1);
      const average =
        (integral[y1 * stride + x1] -
          integral[y0 * stride + x1] -
          integral[y1 * stride + x0] +
          integral[y0 * stride + x0]) /
        ((x1 - x0) * (y1 - y0));
      const value = data[y * width + x];
      mask[y * width + x] = Number(
        (bestVariance > 0 && value <= threshold) ||
          value < average - localDelta,
      );
    }
  return mask;
}

function components(gray: Gray, mask: Uint8Array): Component[] {
  const { width, height } = gray;
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const result: Component[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    let head = 0,
      tail = 1;
    queue[0] = start;
    let x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0,
      sx = 0,
      sy = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width,
        y = Math.floor(index / width);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      sx += x;
      sy += y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= height)
            continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
    }
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1;
    if (
      h < 4 ||
      h > height * 0.4 ||
      w < 1 ||
      w > width * 0.24 ||
      w / h > 1.7 ||
      w / h < 0.06 ||
      tail < 5 ||
      tail / (w * h) < 0.08
    )
      continue;
    result.push({
      x: x0,
      y: y0,
      width: w,
      height: h,
      area: tail,
      cx: sx / tail,
      cy: sy / tail,
    });
    // Highly textured scenes are not safe regions. Keep the whole-frame fallback.
    if (result.length > MAX_COMPONENTS) return [];
  }
  return result;
}

function unionBounds(items: RegionBounds[]): RegionBounds {
  const x = Math.min(...items.map((item) => item.x));
  const y = Math.min(...items.map((item) => item.y));
  return {
    x,
    y,
    width: Math.max(...items.map((item) => item.x + item.width)) - x,
    height: Math.max(...items.map((item) => item.y + item.height)) - y,
  };
}

function textLines(chars: Component[]): TextLine[] {
  const parents = chars.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  // Local neighbours, not fixed screen bands: a line can appear anywhere.
  for (let i = 0; i < chars.length; i++)
    for (let j = i + 1; j < chars.length; j++) {
      const a = chars[i],
        b = chars[j];
      const h = Math.max(a.height, b.height);
      const dx = Math.abs(a.cx - b.cx),
        dy = Math.abs(a.cy - b.cy);
      const gap = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
      if (
        Math.min(a.height, b.height) / h < 0.48 ||
        dx < h * 0.2 ||
        gap > h * 2.2 ||
        dy > h * 0.65 ||
        dx > h * 3.4
      )
        continue;
      parents[root(j)] = root(i);
    }
  const groups = new Map<number, Component[]>();
  chars.forEach((item, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  });
  const result: TextLine[] = [];
  for (const group of groups.values()) {
    if (group.length < 4 || group.length > 30) continue;
    const cx = group.reduce((sum, item) => sum + item.cx, 0) / group.length;
    const cy = group.reduce((sum, item) => sum + item.cy, 0) / group.length;
    const xx = group.reduce((sum, item) => sum + (item.cx - cx) ** 2, 0);
    const xy = group.reduce(
      (sum, item) => sum + (item.cx - cx) * (item.cy - cy),
      0,
    );
    if (!xx) continue;
    const slope = xy / xx;
    const angle = Math.atan(slope) / RAD;
    if (Math.abs(angle) > 20) continue;
    const height = median(group.map((item) => item.height));
    const residual = median(
      group.map((item) => Math.abs(item.cy - cy - slope * (item.cx - cx))),
    );
    const bounds = unionBounds(group);
    if (residual > height * 0.32 || bounds.width / height < 2.8) continue;
    const consistency =
      1 -
      Math.min(
        1,
        median(group.map((item) => Math.abs(item.height - height))) / height,
      );
    const confidence = clamp(
      0.46 +
        Math.min(0.24, group.length * 0.025) +
        consistency * 0.18 -
        (residual / height) * 0.3,
      0,
      1,
    );
    result.push({ bounds, angle, height, count: group.length, confidence });
  }
  return result;
}

/**
 * Dark-ink-on-light-background evidence, sampled at a stride so it costs a
 * couple of hundred pixel reads. A motorbike plate (black on reflective white)
 * and a chassis stamp (engraved shadow on bright metal) both qualify; a glowing
 * sign, a wheel or a shadowed fairing does not. Purely a ranking signal — it
 * never vetoes a region, because a dirty plate is still the plate.
 */
function inkPolarity(gray: Gray, bounds: RegionBounds): number {
  const step = Math.max(
    1,
    Math.round(Math.min(bounds.width, bounds.height) / 24),
  );
  let dark = 0,
    bright = 0,
    total = 0;
  for (
    let y = Math.max(0, Math.floor(bounds.y));
    y < Math.min(gray.height, Math.ceil(bounds.y + bounds.height));
    y += step
  )
    for (
      let x = Math.max(0, Math.floor(bounds.x));
      x < Math.min(gray.width, Math.ceil(bounds.x + bounds.width));
      x += step
    ) {
      const value = gray.data[y * gray.width + x];
      total++;
      if (value < 110) dark++;
      if (value > 150) bright++;
    }
  if (!total) return 0;
  const darkFraction = dark / total;
  // Real plate and stamp text covers roughly a fifth of its own box.
  if (darkFraction < 0.06 || darkFraction > 0.62) return 0;
  return Math.min(1, darkFraction / 0.18) * (bright / total > 0.2 ? 1 : 0.5);
}

/**
 * How much this line looks like the identifiers the camera is hunting, capped
 * so it can only tip a ranking, never replace legibility. Without it a shop
 * sign with bigger, tidier letters beats the actual plate — which is half of
 * the misreads this pipeline used to produce.
 */
function identifierPrior(
  line: TextLine & { kind: "line" | "block" },
  gray: Gray,
): number {
  const aspect = line.bounds.width / line.bounds.height;
  const plateSizedRun = line.count >= 7 && line.count <= 12;
  let prior = 0;
  // Single-row plate, or the two-row plate a bike actually wears.
  if (plateSizedRun && aspect >= 1.9 && aspect <= 2.6) prior += 0.14;
  else if (
    plateSizedRun &&
    line.kind === "block" &&
    aspect >= 0.7 &&
    aspect <= 1.7
  )
    prior += 0.14;
  // A chassis stamp is a long thin run of more characters than a plate holds.
  if (aspect > 2.6 && line.count >= 11) prior += 0.08;
  return Math.min(0.22, prior + inkPolarity(gray, line.bounds) * 0.08);
}

function regionsFromLines(
  lines: TextLine[],
  gray: Gray,
  scale: number,
): DetectedRegion[] {
  const candidates: (TextLine & { kind: "line" | "block" })[] = lines.map(
    (line) => ({ ...line, kind: "line" }),
  );
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i],
        b = lines[j];
      const h = Math.max(a.height, b.height);
      const overlap =
        Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) -
        Math.max(a.bounds.x, b.bounds.x);
      const cyA = a.bounds.y + a.bounds.height / 2,
        cyB = b.bounds.y + b.bounds.height / 2;
      const bounds = unionBounds([a.bounds, b.bounds]);
      if (
        Math.abs(a.angle - b.angle) > 5 ||
        Math.min(a.height, b.height) / h < 0.6 ||
        Math.abs(cyA - cyB) > h * 2.4 ||
        Math.abs(cyA - cyB) < h * 0.8 ||
        overlap < Math.min(a.bounds.width, b.bounds.width) * 0.45 ||
        bounds.width / bounds.height > 4.5 ||
        a.count + b.count > 22
      )
        continue;
      candidates.push({
        bounds,
        angle: (a.angle + b.angle) / 2,
        height: (a.height + b.height) / 2,
        count: a.count + b.count,
        confidence: Math.min(a.confidence, b.confidence) + 0.05,
        kind: "block",
      });
    }
  const priority = (line: (typeof candidates)[number]) =>
    line.confidence +
    Math.min(0.16, (line.height / Math.min(gray.width, gray.height)) * 2) +
    (line.kind === "block" ? 0.07 : 0) +
    identifierPrior(line, gray);
  // Large readable characters and close two-row blocks deserve focused OCR
  // before tiny background labels; the complete-image pass still checks all.
  candidates.sort(
    (a, b) => priority(b) - priority(a) || b.bounds.width - a.bounds.width,
  );
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    // A two-line plate supersedes its individual lines; separate objects survive.
    if (
      selected.some((existing) => {
        const overlapW = Math.max(
          0,
          Math.min(
            existing.bounds.x + existing.bounds.width,
            candidate.bounds.x + candidate.bounds.width,
          ) - Math.max(existing.bounds.x, candidate.bounds.x),
        );
        const overlapH = Math.max(
          0,
          Math.min(
            existing.bounds.y + existing.bounds.height,
            candidate.bounds.y + candidate.bounds.height,
          ) - Math.max(existing.bounds.y, candidate.bounds.y),
        );
        return (
          (overlapW * overlapH) /
            (candidate.bounds.width * candidate.bounds.height) >
          0.8
        );
      })
    )
      continue;
    selected.push(candidate);
    if (selected.length === 4) break;
  }
  return selected.map((line) => {
    const pad = Math.max(3, line.height * 0.3);
    const x = Math.max(0, line.bounds.x - pad),
      y = Math.max(0, line.bounds.y - pad);
    const width = Math.min(gray.width - x, line.bounds.width + pad * 2);
    const height = Math.min(gray.height - y, line.bounds.height + pad * 2);
    return {
      bounds: {
        x: x / scale,
        y: y / scale,
        width: width / scale,
        height: height / scale,
      },
      normalized: {
        x: x / gray.width,
        y: y / gray.height,
        width: width / gray.width,
        height: height / gray.height,
      },
      angleDegrees: line.angle,
      confidence: clamp(line.confidence, 0, 1),
      characterHeight: line.height / scale,
      kind: line.kind,
    };
  });
}

function sharpness(gray: Gray, bounds?: RegionBounds): number {
  const { width, height, data } = gray;
  const x0 = Math.max(1, Math.floor(bounds?.x ?? 1)),
    y0 = Math.max(1, Math.floor(bounds?.y ?? 1));
  const x1 = Math.min(
    width - 1,
    Math.ceil(bounds ? bounds.x + bounds.width : width - 1),
  );
  const y1 = Math.min(
    height - 1,
    Math.ceil(bounds ? bounds.y + bounds.height : height - 1),
  );
  let energy = 0,
    count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const laplacian =
        data[i - 1] +
        data[i + 1] +
        data[i - width] +
        data[i + width] -
        4 * data[i];
      energy += laplacian * laplacian;
      count++;
    }
  return clamp(count ? energy / count / 4096 : 0, 0, 1);
}

/** Guidance is deliberately conservative and never blocks a potentially valid read. */
function frameQuality(
  gray: Gray,
  hist: Uint32Array,
  regions: DetectedRegion[],
  scale: number,
): FrameQuality {
  const count = gray.data.length;
  let luma = 0,
    dark = 0,
    bright = 0;
  for (let i = 0; i < 256; i++) {
    luma += i * hist[i];
    if (i < 35) dark += hist[i];
    if (i > 247) bright += hist[i];
  }
  const meanLuma = luma / Math.max(1, count);
  const contrast =
    percentile(hist, count, 0.98) - percentile(hist, count, 0.02);
  const darkFraction = dark / Math.max(1, count),
    brightFraction = bright / Math.max(1, count);
  const regionSharpness = regions.map((region) =>
    sharpness(gray, {
      x: region.normalized.x * gray.width,
      y: region.normalized.y * gray.height,
      width: region.normalized.width * gray.width,
      height: region.normalized.height * gray.height,
    }),
  );
  const edgeEnergy = regionSharpness.length
    ? Math.max(...regionSharpness)
    : sharpness(gray);
  const issues: QualityIssue[] = [];
  if (meanLuma < 52 && darkFraction > 0.42) issues.push("dark");
  // Saturated paper/background alone is not glare. Require both a midtone scene
  // and a substantial flat saturated patch in a coarse spatial grid.
  let saturatedTiles = 0;
  for (let gy = 0; gy < 6; gy++)
    for (let gx = 0; gx < 6; gx++) {
      let saturated = 0,
        pixels = 0;
      for (
        let y = Math.floor((gy * gray.height) / 6);
        y < Math.floor(((gy + 1) * gray.height) / 6);
        y++
      )
        for (
          let x = Math.floor((gx * gray.width) / 6);
          x < Math.floor(((gx + 1) * gray.width) / 6);
          x++
        ) {
          saturated += Number(gray.data[y * gray.width + x] > 247);
          pixels++;
        }
      if (pixels && saturated / pixels > 0.94) saturatedTiles++;
    }
  if (
    brightFraction > 0.12 &&
    brightFraction < 0.65 &&
    saturatedTiles >= 4 &&
    percentile(hist, count, 0.5) < 210
  )
    issues.push("glare");
  if (regions.length && edgeEnergy < 0.055 && contrast > 35)
    issues.push("blur");
  const normalizedHeight = regions.length
    ? Math.max(
        ...regions.map(
          (region) =>
            (region.characterHeight * scale) /
            Math.max(gray.width, gray.height),
        ),
      )
    : 0;
  // Compare sampled character height to sampled frame size; this is independent
  // of the upload's original megapixel count.
  if (regions.length && normalizedHeight < 0.025) issues.push("too-far");
  const exposure = clamp(1 - Math.max(0, 55 - meanLuma) / 55, 0, 1);
  const detail = regions.length
    ? clamp(edgeEnergy / 0.35, 0, 1)
    : clamp(edgeEnergy / 0.2, 0, 1);
  const size = regions.length ? clamp(normalizedHeight / 0.08, 0, 1) : 0.35;
  const score = clamp(
    exposure * 0.25 +
      detail * 0.35 +
      size * 0.25 +
      (regions[0]?.confidence ?? 0.25) * 0.15 -
      Number(issues.includes("glare")) * 0.18,
    0,
    1,
  );
  const messages: Record<QualityIssue, string> = {
    dark: "Ảnh đang tối. Bật đèn pin hoặc đưa xe tới chỗ sáng hơn.",
    glare: "Có vùng chói sáng. Đổi góc camera để thấy rõ các ký tự.",
    blur: "Chữ chưa rõ. Giữ camera ổn định để lấy nét.",
    "too-far": "Chữ đang nhỏ. Đưa camera gần biển số hoặc số khung hơn.",
  };
  return {
    score,
    meanLuma,
    contrast,
    sharpness: edgeEnergy,
    darkFraction,
    brightFraction,
    issues,
    message: issues.length
      ? messages[issues[0]]
      : regions.length
        ? "Đã tìm thấy vùng chữ. Giữ camera ổn định."
        : "Đưa biển số hoặc số khung rõ hơn vào khung.",
  };
}

/** Pixel-based text localization. It does not claim to classify a vehicle part. */
export function analyzeGray(gray: Gray): FrameAnalysis {
  if (
    !gray.width ||
    !gray.height ||
    gray.data.length !== gray.width * gray.height
  ) {
    return {
      width: gray.width,
      height: gray.height,
      regions: [],
      quality: {
        score: 0,
        meanLuma: 0,
        contrast: 0,
        sharpness: 0,
        darkFraction: 0,
        brightFraction: 0,
        issues: [],
        message: "Đưa biển số hoặc số khung rõ hơn vào khung.",
      },
    };
  }
  const { image, scale } = boundedGray(gray);
  const hist = histogram(image);
  const lines = textLines(components(image, foreground(image, hist)));
  const regions = regionsFromLines(lines, image, scale);
  return {
    width: gray.width,
    height: gray.height,
    regions,
    quality: frameQuality(image, hist, regions, scale),
  };
}

/** A bounded burst may select its clearest frame without suppressing OCR. */
export function chooseBestFrameIndex(
  analyses: readonly (FrameAnalysis | null)[],
): number {
  let bestIndex = -1,
    bestScore = -1;
  analyses.forEach((analysis, index) => {
    if (analysis && analysis.quality.score > bestScore) {
      bestScore = analysis.quality.score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/** Geometry only, exported so skew correction can be verified without a DOM. */
export function deskewGeometry(
  bounds: RegionBounds,
  angleDegrees: number,
): { width: number; height: number; radians: number } {
  const radians = -clamp(angleDegrees, -20, 20) * RAD;
  const cosine = Math.abs(Math.cos(radians)),
    sine = Math.abs(Math.sin(radians));
  return {
    width: Math.ceil(bounds.width * cosine + bounds.height * sine),
    height: Math.ceil(bounds.width * sine + bounds.height * cosine),
    radians,
  };
}
