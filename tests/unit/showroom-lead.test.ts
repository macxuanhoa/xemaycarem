import { describe, expect, it } from "vitest";
import {
  buybackLeadSchema,
  inquiryLeadSchema,
  normalizeVietnamPhone,
  zaloConsultLink,
} from "@/features/showroom/showroomLead";

/** A2 regression: showroom lead validation + phone normalization contract. */

describe("normalizeVietnamPhone", () => {
  it("keeps a canonical 0-prefixed mobile number", () => {
    expect(normalizeVietnamPhone("0914929292")).toBe("0914929292");
  });

  it("converts +84 / 84 formats to the 0-prefixed canonical form", () => {
    expect(normalizeVietnamPhone("+84 91 492 9292")).toBe("0914929292");
    expect(normalizeVietnamPhone("84914929292")).toBe("0914929292");
  });

  it("strips separators and re-prefixes bare subscriber numbers", () => {
    expect(normalizeVietnamPhone("0914-929-292")).toBe("0914929292");
    expect(normalizeVietnamPhone("914929292")).toBe("0914929292");
  });
});

describe("buybackLeadSchema", () => {
  const valid = {
    customer_name: "  Nguyễn Văn Hậu ",
    phone: "0914929292",
    vehicle_name: " Honda Wave Alpha ",
    vehicle_year: "2023",
    expected_price: "45000000",
    message: "Xe giữ kỹ",
  };

  it("accepts and normalizes a well-formed buyback lead", () => {
    const parsed = buybackLeadSchema.parse(valid);
    expect(parsed.customer_name).toBe("Nguyễn Văn Hậu");
    expect(parsed.vehicle_name).toBe("Honda Wave Alpha");
    expect(parsed.phone).toBe("0914929292");
  });

  it("normalizes a +84 phone during parse", () => {
    const parsed = buybackLeadSchema.parse({ ...valid, phone: "+84914929292" });
    expect(parsed.phone).toBe("0914929292");
  });

  it("rejects invalid Vietnamese mobile numbers", () => {
    for (const phone of ["123", "0123456789", "0224929292", "091492929"]) {
      const result = buybackLeadSchema.safeParse({ ...valid, phone });
      expect(result.success, `phone ${phone} must be rejected`).toBe(false);
    }
  });

  it("rejects names shorter than 2 characters", () => {
    expect(
      buybackLeadSchema.safeParse({ ...valid, customer_name: " A " }).success,
    ).toBe(false);
  });

  it("allows empty year/price but rejects malformed ones", () => {
    expect(
      buybackLeadSchema.safeParse({ ...valid, vehicle_year: "", expected_price: "" })
        .success,
    ).toBe(true);
    expect(
      buybackLeadSchema.safeParse({ ...valid, vehicle_year: "23" }).success,
    ).toBe(false);
    expect(
      buybackLeadSchema.safeParse({ ...valid, expected_price: "45 triệu" })
        .success,
    ).toBe(false);
  });

  it("caps the message at 1000 characters like the DB CHECK", () => {
    expect(
      buybackLeadSchema.safeParse({ ...valid, message: "x".repeat(1001) })
        .success,
    ).toBe(false);
  });
});

describe("inquiryLeadSchema", () => {
  it("requires a vehicle_id and drops buyback-only fields", () => {
    const parsed = inquiryLeadSchema.parse({
      customer_name: "Trần A",
      phone: "0901234567",
      message: "",
      vehicle_id: "3f9c6b1e-8a1a-4a2b-9c0d-77e1a2b3c4d5",
    });
    expect(parsed.vehicle_id).toBe("3f9c6b1e-8a1a-4a2b-9c0d-77e1a2b3c4d5");
    expect("vehicle_name" in parsed).toBe(false);
  });
});

describe("zaloConsultLink", () => {
  it("builds a Zalo deep link with an encoded message", () => {
    const link = zaloConsultLink("Chào Cà Rem & hỏi xe");
    expect(link.startsWith("https://zalo.me/0914929292?text=")).toBe(true);
    expect(link).toContain(encodeURIComponent("Chào Cà Rem & hỏi xe"));
  });
});
