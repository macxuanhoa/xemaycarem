import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Exercise the actual Edge HTTP handler with an injected SDK, without Auth/production calls.
it("purge eligibility RPC failure returns HTTP 500 and performs no deletion", async () => {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const remove = vi.fn();
  const target = { id: "00000000-0000-4000-8000-000000000002", role: "STAFF", deleted_at: new Date().toISOString() };
  const caller = {
    auth: { getUser: async () => ({ data: { user: { id: "owner-test" } }, error: null }) },
    from: () => {
      const query = {
        select: () => query, eq: () => query,
        single: async () => ({ data: { role: "OWNER", active: true, deleted_at: null }, error: null }),
      };
      return query;
    },
    rpc: async (name: string) => name === "check_user_access"
      ? { data: { allowed: true }, error: null }
      : { data: null, error: { message: "TEST failure" } },
  };
  const admin = {
    auth: { admin: { deleteUser: remove } },
    from: () => {
      const query = {
        select: () => query, eq: () => query, delete: remove, update: remove,
        single: async () => ({ data: target, error: null }),
      };
      return query;
    },
  };
  const source = readFileSync("supabase/functions/manage-users/index.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, {
    exports: {}, Request, Response, Date, console,
    require: (specifier: string) => specifier.endsWith("/cors")
      ? { corsHeaders: {} }
      : { createClient: (_url: string, key: string) => key === "public-test" ? caller : admin },
    Deno: {
      env: { get: (name: string) => ({ SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "public-test", SUPABASE_SERVICE_ROLE_KEY: "service-test" })[name as "SUPABASE_URL"] },
      serve: (callback: typeof handler) => { handler = callback; },
    },
  });
  expect(handler).toBeDefined();
  const response = await handler!(new Request("https://example.test/manage-users", {
    method: "POST", headers: { Authorization: "Bearer test-token" },
    body: JSON.stringify({ action: "purge", user_id: target.id }),
  }));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "PURGE_CHECK_FAILED" });
  expect(remove).not.toHaveBeenCalled();
});
