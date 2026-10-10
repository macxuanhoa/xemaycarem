import { describe, expect, it, vi } from "vitest";
import { parseEnvironment, probeStaging, validateStaging } from "../../scripts/staging-lib.mjs";

const productionRef = "productionprojectaaa";
const stagingRef = "stagingprojectaaaaaa";
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const values = () => ({ CAREM_PRODUCTION_PROJECT_REF: productionRef, CAREM_STAGING_PROJECT_REF: stagingRef, VITE_SUPABASE_URL: `https://${stagingRef}.supabase.co`, VITE_SUPABASE_ANON_KEY: jwt({ ref: stagingRef, role: "anon" }) });

describe("staging isolation", () => {
  it("accepts only a separately named project and its own anon key", () => {
    expect(validateStaging(values(), productionRef)).toMatchObject({ stagingRef, productionRef, appEnv: "staging" });
  });
  it("refuses production URLs, keys, project refs and elevated keys", () => {
    for (const patch of [
      { CAREM_STAGING_PROJECT_REF: productionRef },
      { VITE_SUPABASE_URL: `https://${productionRef}.supabase.co` },
      { VITE_SUPABASE_ANON_KEY: jwt({ ref: productionRef, role: "anon" }) },
      { VITE_SUPABASE_ANON_KEY: jwt({ ref: stagingRef, role: "service_role" }) },
      { VITE_SUPABASE_ANON_KEY: "sb_secret_never_in_frontend" },
      { CAREM_PRODUCTION_PROJECT_REF: "differentprojectaaaa" },
      { VITE_SUPABASE_URL: `https://user:password@${stagingRef}.supabase.co/` },
    ]) expect(() => validateStaging({ ...values(), ...patch }, productionRef)).toThrow();
  });
  it("requires production identification when the workspace has no CLI link", () => {
    expect(() => validateStaging({ ...values(), CAREM_PRODUCTION_PROJECT_REF: "" })).toThrow();
  });
  it("does not expand environment variables or accept duplicate assignments", () => {
    expect(parseEnvironment("# comment\nVITE_APP_ENV='staging'\n")).toEqual({ VITE_APP_ENV: "staging" });
    expect(() => parseEnvironment("KEY=${PRODUCTION_KEY}")).toThrow();
    expect(() => parseEnvironment("KEY=first\nKEY=second")).toThrow();
  });
});

describe("staging readiness is read-only and never logs response data", () => {
  it("accepts safe RLS/permission responses and uses only the staging URL", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })).mockResolvedValueOnce(new Response("[]", { status: 200 })).mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const result = await probeStaging(validateStaging(values()), request);
    expect(result.ok).toBe(true);
    expect(request.mock.calls).toHaveLength(3);
    for (const [url, options] of request.mock.calls) {
      expect(url).toMatch(new RegExp(`^https://${stagingRef}\\.supabase\\.co/`));
      expect(options).not.toHaveProperty("method");
      expect(options).not.toHaveProperty("body");
    }
  });
  it("fails when anonymous callers can read rows, tables are missing or Auth is unhealthy", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 })).mockResolvedValueOnce(new Response('[{"id":"private-data"}]', { status: 200 })).mockResolvedValueOnce(new Response("{}", { status: 404 }));
    const result = await probeStaging(validateStaging(values()), request);
    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-data");
  });
});
