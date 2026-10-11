import { describe, expect, it } from "vitest";
import {
  decideDuplicateAction,
  isPrivilegedRole,
  isSaveBlocked,
} from "@/lib/duplicateReviewDecision";

// The client decision must mirror the server rules in migration 20261011000400
// exactly, so the button a role sees always matches what the RPC will accept.

describe("decideDuplicateAction — GREEN / YELLOW", () => {
  it("lets any role save a clean (GREEN) record", () => {
    for (const role of ["OWNER", "MANAGER", "STAFF"] as const) {
      expect(
        decideDuplicateAction({ level: "GREEN", reason: "", role }),
      ).toEqual({ kind: "allow-save" });
    }
  });

  it("requires acknowledgement before saving a YELLOW match", () => {
    expect(
      decideDuplicateAction({
        level: "YELLOW",
        reason: "PARTIAL_MATCH",
        role: "STAFF",
      }),
    ).toEqual({ kind: "require-ack" });
    expect(
      decideDuplicateAction({
        level: "YELLOW",
        reason: "NEED_VERIFY_PARTIAL_FULL",
        role: "STAFF",
        acknowledged: true,
      }),
    ).toEqual({ kind: "allow-save" });
  });
});

describe("decideDuplicateAction — RED FULL_FRAME_MATCH is an absolute block", () => {
  it("hard-blocks every role, including the OWNER, with no bypass", () => {
    for (const role of ["OWNER", "MANAGER", "STAFF"] as const) {
      const action = decideDuplicateAction({
        level: "RED",
        reason: "FULL_FRAME_MATCH",
        role,
      });
      expect(action).toEqual({ kind: "hard-block" });
      expect(isSaveBlocked(action)).toBe(true);
    }
  });
});

describe("decideDuplicateAction — RED PLATE_AND_LAST5 is role-gated", () => {
  it("STAFF may only request verification, never save", () => {
    const action = decideDuplicateAction({
      level: "RED",
      reason: "PLATE_AND_LAST5",
      role: "STAFF",
    });
    expect(action).toEqual({ kind: "request-review" });
    expect(isSaveBlocked(action)).toBe(true);
  });

  it("OWNER and MANAGER may save an audited exception", () => {
    for (const role of ["OWNER", "MANAGER"] as const) {
      expect(
        decideDuplicateAction({
          level: "RED",
          reason: "PLATE_AND_LAST5",
          role,
        }),
      ).toEqual({ kind: "override-save" });
    }
  });

  it("acknowledgement does NOT upgrade STAFF past a RED suspicion", () => {
    expect(
      decideDuplicateAction({
        level: "RED",
        reason: "PLATE_AND_LAST5",
        role: "STAFF",
        acknowledged: true,
      }),
    ).toEqual({ kind: "request-review" });
  });
});

describe("decideDuplicateAction — fail-closed on unknown RED reasons", () => {
  it("blocks a RED signal whose reason is not recognized", () => {
    for (const role of ["OWNER", "MANAGER", "STAFF"] as const) {
      expect(
        decideDuplicateAction({ level: "RED", reason: "SOMETHING_ELSE", role }),
      ).toEqual({ kind: "hard-block" });
    }
  });
});

describe("isPrivilegedRole", () => {
  it("treats OWNER/MANAGER as privileged and STAFF as not", () => {
    expect(isPrivilegedRole("OWNER")).toBe(true);
    expect(isPrivilegedRole("MANAGER")).toBe(true);
    expect(isPrivilegedRole("STAFF")).toBe(false);
  });
});
