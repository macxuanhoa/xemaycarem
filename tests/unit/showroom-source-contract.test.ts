import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A1/A2 source contract: the public showroom page must be wired to REAL
 * inventory and REAL lead persistence — with no hardcoded fake stock left
 * anywhere, and success messaging gated on a successful RPC write.
 */

const page = readFileSync("src/features/showroom/ShowroomPage.tsx", "utf8");
const inventoryMigration = readFileSync(
  "supabase/migrations/20261002003200_showroom_public_inventory.sql",
  "utf8",
);
const leadMigration = readFileSync(
  "supabase/migrations/20261002003300_showroom_leads.sql",
  "utf8",
);

describe("A1 showroom real inventory", () => {
  it("no hardcoded fake vehicle records remain", () => {
    expect(page).not.toContain("FEATURED_BIKES");
    expect(page).not.toContain("ShowroomBike");
    // The old fake inventory entries carried a static `photo:` field per bike.
    // Marketing gallery shots of the real store are allowed; fake stock is not.
    expect(page).not.toMatch(/photo:\s*"\//);
  });

  it("reads vehicles through the canonical public RPC", () => {
    expect(page).toContain("list_showroom_vehicles");
    expect(page).toContain("api.call");
  });

  it("renders loading and error states instead of fake fallbacks", () => {
    expect(page).toContain("inventory.isPending");
    expect(page).toContain("inventory.isError");
    expect(page).toContain("inventory.refetch");
  });

  it("the public RPC only exposes IN_STOCK vehicles with safe fields", () => {
    expect(inventoryMigration).toContain("v.status = 'IN_STOCK'");
    expect(inventoryMigration).not.toMatch(/select[\s\S]*?purchase_price/i);
    expect(inventoryMigration).toContain("internal_code"); // only in the exclusion comment
    expect(inventoryMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.list_showroom_vehicles\(jsonb\) TO anon/,
    );
  });
});

describe("A2 showroom lead persistence", () => {
  it("the sell form persists a lead BEFORE showing success", () => {
    expect(page).toContain("create_showroom_lead");
    const successAt = page.indexOf("setSellSubmitted(true)");
    const persistAt = page.indexOf("create_showroom_lead");
    const onSuccessAt = page.indexOf("onSuccess: (leadId");
    expect(successAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(-1);
    expect(onSuccessAt).toBeGreaterThan(-1);
    // Success flag flips inside the mutation onSuccess, after the RPC call.
    expect(onSuccessAt).toBeGreaterThan(persistAt);
    expect(successAt).toBeGreaterThan(onSuccessAt);
    expect(successAt).toBeLessThan(onSuccessAt + 600);
  });

  it("no fake-success path: submit goes through zod validation + mutation", () => {
    expect(page).toContain("buybackLeadSchema.safeParse");
    expect(page).toContain("sellMutation.mutate(parsed.data)");
    // setSellSubmitted(true) appears exactly once — only on persisted success.
    expect(page.match(/setSellSubmitted\(true\)/g)?.length).toBe(1);
  });

  it("the lead RPC validates Vietnamese phones and rate-limits spam", () => {
    expect(leadMigration).toContain("private.normalize_customer_phone");
    expect(leadMigration).toContain("^0[35789][0-9]{8}$");
    expect(leadMigration).toContain("LEAD_TOO_FREQUENT");
    expect(leadMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.create_showroom_lead(jsonb) TO anon",
    );
    // Anon must NOT be able to list or triage leads.
    expect(leadMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.list_showroom_leads[^;]*TO authenticated, service_role;/,
    );
  });
});
