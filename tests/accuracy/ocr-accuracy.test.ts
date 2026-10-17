/**
 * Smart Camera accuracy harness — `npm run test:ocr-accuracy`.
 *
 * The point of this file is that the accuracy claim is *measured*, not
 * asserted in prose. Every entry of `tests/fixtures/ocr-corpus/manifest.json`
 * is one look at one identifier: a ground-truth string plus what the engine
 * reported on each live tick. The frames are replayed through the real shipped
 * path — `chooseIdentifierRead` → `pushEvidence` → `readEvidence` →
 * `decisionTier` — so what is scored is the camera's actual decision, not a
 * reimplementation of it.
 *
 * Two numbers are separated deliberately:
 *   - detectable silent errors: the camera auto-locked a wrong identifier while
 *     the burst itself contained contradicting evidence. This must be zero.
 *   - residual risk: every frame said the same wrong thing clearly, so no
 *     text-layer evidence existed to object. That is what an on-device classical
 *     engine cannot see, and it is reported instead of hidden.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseIdentifierRead, type OcrPass } from "../../src/lib/smartcam/local/ocr";
import {
  pushEvidence,
  readEvidence,
  type FieldEvidence,
} from "../../src/lib/smartcam/local/voting";
import { decisionTier, type DecisionTier } from "../../src/lib/smartcam/recognition";

type FrameReport = { observed: string; confidence: number; glyphs?: string };
type Entry = {
  id: string;
  truth: string | null;
  source?: string;
  comment?: string;
  frames: FrameReport[];
};
type Corpus = { plates: Entry[]; frames: Entry[] };

const corpus = JSON.parse(
  readFileSync(new URL("../fixtures/ocr-corpus/manifest.json", import.meta.url), "utf8"),
) as Corpus;

const compact = (value: string) => value.replace(/[^A-Z0-9]/g, "").toUpperCase();

/** One frame of one look, replayed exactly as the live loop consumes it. */
function readFrame(frame: FrameReport, field: "license_plate" | "frame_number") {
  const observed = compact(frame.observed);
  const marks = frame.glyphs?.split(",").map(Number);
  const glyphs = marks?.length
    ? [...observed].map((character, index) => ({
        character,
        confidence: Number.isFinite(marks[index]) ? marks[index] : frame.confidence,
      }))
    : undefined;
  const pass: OcrPass = {
    text: frame.observed,
    confidence: frame.confidence,
    ms: 20,
    ...(glyphs ? { glyphs } : {}),
  };
  const read = chooseIdentifierRead([pass], field === "license_plate" ? "both" : "frame");
  return {
    value: field === "license_plate" ? read.license_plate : read.frame_number,
    confidence: field === "license_plate" ? read.plateConfidence : read.frameConfidence,
    disputed: field === "license_plate" ? read.warnings.license_plate : read.warnings.frame_number,
    autoEligible:
      field === "license_plate"
        ? read.autoEligible.license_plate
        : read.autoEligible.frame_number,
    ambiguous: read.ambiguous.length > 0,
  };
}

type Outcome = {
  id: string;
  field: "license_plate" | "frame_number";
  truth: string | null;
  value: string;
  tier: DecisionTier | "NO_READ";
  correct: boolean;
  /** The burst itself offered evidence against the locked reading. */
  contradicted: boolean;
};

function replay(entry: Entry, field: "license_plate" | "frame_number"): Outcome {
  let evidence: FieldEvidence | null = null;
  let sawContradiction = false;
  for (const frame of entry.frames) {
    const read = readFrame(frame, field);
    if (!read.value) {
      evidence = pushEvidence(evidence, null);
      continue;
    }
    // A burst where two ticks disagree at all is, by definition, evidence that
    // no single reading in it may be trusted without a human.
    if (evidence && evidence.tallies.every((tally) => tally.compact !== compact(read.value)))
      sawContradiction = true;
    evidence = pushEvidence(evidence, {
      value: read.value,
      compact: compact(read.value),
      confidence: read.confidence,
      disputed: read.disputed,
      autoEligible: read.autoEligible && !read.ambiguous,
    });
  }
  const outcome = readEvidence(evidence);
  const value = outcome.value;
  const fields = {
    license_plate: field === "license_plate" ? value : "",
    frame_number: field === "frame_number" ? value : "",
  };
  const tier = value
    ? decisionTier(
        fields,
        outcome.disputed.length ? { [field]: outcome.disputed } : {},
        { license_plate: outcome.autoEligible, frame_number: outcome.autoEligible },
        // The corpus has no CRM behind it, so nothing here can be corroborated
        // by an exact stored record: this measures the evidence path alone —
        // exactly the route a vehicle that is not in stock yet takes.
        { state: "none" },
      )
    : "NO_READ";
  return {
    id: entry.id,
    field,
    truth: entry.truth,
    value,
    tier,
    correct: !!entry.truth && value === entry.truth,
    contradicted: sawContradiction,
  };
}

const all = [
  ...corpus.plates.map((entry) => ({ entry, field: "license_plate" as const })),
  ...corpus.frames.map((entry) => ({ entry, field: "frame_number" as const })),
];
const outcomes = all.map(({ entry, field }) => replay(entry, field));
const report = (title: string, rows: Outcome[]) => {
  if (!rows.length) return;
  console.warn(
    `[ocr-accuracy] ${title}\n` +
      rows
        .map(
          (row) =>
            `  ${row.id}: tier=${row.tier} truth=${row.truth ?? "—"} read=${row.value || "—"}`,
        )
        .join("\n"),
  );
};

describe("smart camera accuracy", () => {
  const locked = outcomes.filter((row) => row.tier === "AUTO");
  const silent = locked.filter((row) => !row.correct);
  const detectable = silent.filter((row) => row.contradicted || row.truth === null);

  it("auto-locks nothing the corpus contradicts", () => {
    report("detectable silent errors", detectable);
    expect(detectable.map((row) => row.id)).toEqual([]);
  });
  it("reports the residual risk it cannot see, instead of hiding it", () => {
    const residual = silent.filter((row) => !detectable.includes(row));
    report("residual (every frame agreed, wrongly) — classical engine ceiling", residual);
    // Honest ceiling for this corpus: at most one undetectable case, and it
    // must be a case the manifest itself documents as such.
    expect(residual.length).toBeLessThanOrEqual(1);
    for (const row of residual) expect(row.id).toContain("undetectable");
  });
  it("reads the corpus identifiers it is supposed to read", () => {
    const missed = outcomes.filter(
      (row) => row.truth && row.tier === "NO_READ",
    );
    report("no read where a truth exists", missed);
    expect(missed.map((row) => row.id)).toEqual([]);
  });
  it("never locks an impossible province code or a signboard", () => {
    for (const id of ["13B1-impossible-province", "signboard-not-a-frame"]) {
      const row = outcomes.find((item) => item.id === id);
      expect(row?.tier, id).toBe("NO_READ");
    }
  });
  it("routes a genuinely ambiguous read to a human rather than a coin flip", () => {
    const wobble = outcomes.find((row) => row.id === "49D1-wobble-last-digit");
    expect(wobble?.value).toBe("49D1-837.87");
    expect(wobble?.tier).toBe("CONFIRM");
  });
  it("locks a clean production identifier without asking", () => {
    for (const id of ["59A1-clean", "92D1-clean-dashed", "RLH-clean-stamp"])
      expect(outcomes.find((row) => row.id === id)?.tier, id).toBe("AUTO");
  });
  it("shows the decision split the owner is buying", () => {
    const confirmed = outcomes.filter((row) => row.tier === "CONFIRM");
    console.warn(
      `[ocr-accuracy] ${outcomes.length} looks — AUTO ${locked.length} ` +
        `(${Math.round((locked.length / outcomes.length) * 100)}%), ` +
        `one tap ${confirmed.length}, no read ${outcomes.filter((r) => r.tier === "NO_READ").length}, ` +
        `detectable silent errors ${detectable.length}, residual ${silent.length - detectable.length}`,
    );
    // A harness where nothing ever needs a human is a harness that is not
    // testing anything; a harness that needs a human every time is too slow to
    // be used. Both extremes are failures here. The corpus is deliberately
    // adversarial (most entries are stress cases), so this AUTO share is a
    // floor for the shipped code, not what a clean plate at the shop gets.
    expect(locked.length).toBeGreaterThan(outcomes.length / 2);
    expect(confirmed.length).toBeGreaterThan(0);
  });
});

describe("smart camera decode cost (the speed promise)", () => {
  it("costs a rounding error against the 160 ms tick", () => {
    const samples: number[] = [];
    for (const { entry, field } of all) {
      for (const frame of entry.frames) {
        const started = performance.now();
        readFrame(frame, field);
        samples.push(performance.now() - started);
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    console.warn(
      `[ocr-accuracy] grammar decode: mean ${mean.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms ` +
        `over ${samples.length} frames (tick budget 160 ms)`,
    );
    // The claim in the plan was "pure arithmetic cannot move the tick". Measured
    // against the real pipeline, the whole text layer must stay under 1% of it.
    expect(p95).toBeLessThan(1.6);
  });
});
