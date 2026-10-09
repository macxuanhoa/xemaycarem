import { afterEach, expect, it, vi } from "vitest";
import { friendlyError } from "@/lib/errors";

afterEach(() => vi.unstubAllGlobals());

// Two staff can slip past the client-side pre-check and submit the same
// chassis at the same instant. The database lets one through and rejects the
// other with a unique-violation. Those server failures — whether the RPC's
// own DUPLICATE_FRAME_NUMBER or a raw 23505 index clash — must read as a
// vehicle problem, never the "username already exists" message.

it("maps the RPC DUPLICATE_FRAME_NUMBER to the vehicle-specific wording", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(
    friendlyError({ code: "23505", message: "DUPLICATE_FRAME_NUMBER" }),
  ).toBe("Số khung đã tồn tại trong hệ thống.");
});

it("maps the concurrent-save clash on the canonical frame index", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(
    friendlyError({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "vehicles_canonical_frame_unique"',
      details: "Key (frame_number)=(RLCE3201234567) already exists.",
      hint: "",
    }),
  ).toBe("Số khung đã tồn tại trong hệ thống.");
});

it("maps the legacy frame_number unique clash", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(
    friendlyError({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "vehicles_frame_number_key"',
      details: "Key (frame_number)=(RLCE3201234567) already exists.",
    }),
  ).toBe("Số khung đã tồn tại trong hệ thống.");
});

it("still routes a genuine username clash to the account wording", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(
    friendlyError({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "profiles_username_key"',
      details: "Key (username)=(thanhnv) already exists.",
    }),
  ).toBe("Tên đăng nhập đã tồn tại trong hệ thống.");
});

it("does not hijack the duplicate vehicle-type error", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(
    friendlyError({ code: "23505", message: "DUPLICATE_VEHICLE_TYPE" }),
  ).toBe(
    "Loại xe này đã có trong danh mục (tên chỉ khác hoa/thường hoặc khoảng trắng).",
  );
});
