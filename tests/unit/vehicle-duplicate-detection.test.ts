import { afterEach, expect, it, vi } from "vitest";
import {
  compactFrame,
  frameLast5,
  frameKindFromCompact,
  frameKindFromFrame,
  duplicateReasonCopy,
} from "@/lib/frameNumber";
import { friendlyError } from "@/lib/errors";

afterEach(() => vi.unstubAllGlobals());

// The client must mirror private.frame_compact_of / frame_last5_of exactly, so
// the signature shown while typing equals the one the server re-checks on save.

it("compacts a frame to uppercase alphanumerics", () => {
  expect(compactFrame("  rlce32-p1234567 ")).toBe("RLCE32P1234567");
  expect(compactFrame("")).toBe("");
});

it("keeps leading zeros inside the last-5 tail as text", () => {
  expect(frameLast5("xy-00012")).toBe("00012");
  expect(frameLast5("AB 0000")).toBe("B0000");
  expect(frameLast5("")).toBeNull();
});

it("classifies a VIN as FULL at 11+ alphanumerics and a fragment as PARTIAL", () => {
  expect(frameKindFromCompact("RLCE32P1234")).toBe("FULL"); // exactly 11
  expect(frameKindFromCompact("RLCE32P123")).toBe("PARTIAL"); // 10
  expect(frameKindFromCompact("")).toBe("FULL"); // empty ⇒ treated as FULL placeholder
  expect(frameKindFromFrame("KS77712345")).toBe("PARTIAL");
});

it("explains each server reason in Vietnamese", () => {
  expect(duplicateReasonCopy("FULL_FRAME_MATCH")).toMatch(/hồ sơ hiện có/);
  expect(duplicateReasonCopy("PLATE_AND_LAST5")).toMatch(/cùng một xe/);
  expect(duplicateReasonCopy("NEED_VERIFY_PARTIAL_FULL")).toMatch(/đối chiếu/);
  // Unknown / empty reasons fall back to the gentle "similar bike" wording.
  expect(duplicateReasonCopy("")).toBe(duplicateReasonCopy("PARTIAL_MATCH"));
});

it("maps the new tri-state server errors to distinct wording", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(
    friendlyError({ code: "23505", message: "DUPLICATE_VEHICLE_SUSPECTED" }),
  ).toMatch(/nhập số khung đầy đủ hoặc mở hồ sơ hiện có/);
  expect(
    friendlyError({ code: "23505", message: "DUPLICATE_VEHICLE_NEEDS_CONFIRM" }),
  ).toMatch(/xác nhận lưu/);
  // A raw PLATE_AND_LAST5 leaking through the message must not be read as a
  // username clash.
  expect(friendlyError({ message: "PLATE_AND_LAST5" })).toMatch(/5 ký tự cuối/);
});
