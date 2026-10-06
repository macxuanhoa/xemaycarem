import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createMessagingProvider, MockMessagingProvider } from "../../supabase/functions/process-message/provider";

const jobId = "00000000-0000-4000-8000-000000000001";
const lease = "00000000-0000-4000-8000-000000000002";
const job = { id: jobId, lease_token: lease, recipient_phone: "+84912345678", channel: "SMS", template_code: "sale_thank_you_v1", template_variables: {} };
type RpcReply = { data: unknown; error: null | { message: string } };

function worker(mode: string | undefined, rpc: (name: string, args: Record<string, unknown>) => Promise<RpcReply>) {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const source = readFileSync("supabase/functions/process-message/index.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, {
    exports: {}, Request, Response, Error,
    require: (name: string) => name === "./provider.ts" ? { createMessagingProvider }
      : name.endsWith("/cors") ? { corsHeaders: {} }
        : { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "synthetic-staff" } }, error: null }) }, rpc }) },
    Deno: {
      env: { get: (name: string) => ({ SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "public-test", MESSAGE_PROVIDER_MODE: mode })[name as "SUPABASE_URL"] },
      serve: (callback: typeof handler) => { handler = callback; },
    },
  });
  return (body: unknown = { message_id: jobId }) => handler!(new Request("https://example.test/process-message", {
    method: "POST", headers: { Authorization: "Bearer synthetic" }, body: JSON.stringify(body),
  }));
}

it("malformed JSON values return 400 before any worker claim", async () => {
  const rpc = vi.fn(async (): Promise<RpcReply> => ({ data: job, error: null }));
  const handle = worker("MOCK", rpc);
  for (const body of [null, [], "message", 123, {}, { message_id: 123 }, { message_id: "-".repeat(36) }]) {
    const response = await handle(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_INPUT" });
  }
  expect(rpc).not.toHaveBeenCalled();
});

it("MOCK replay across provider instances keeps one durable job identity", async () => {
  const message = { recipient: "+84912345678", channel: "SMS" as const, template: "sale_thank_you_v1", variables: {}, idempotencyKey: jobId };
  const first = await new MockMessagingProvider().sendTransactionalMessage(message);
  const restarted = await new MockMessagingProvider().sendTransactionalMessage(message);
  expect(restarted).toEqual(first);
  expect(first.providerMessageId).toBe(`mock_${jobId}`);
});

it("worker claims the configured provider and sends the fencing token when confirming", async () => {
  const rpc = vi.fn(async (name: string): Promise<RpcReply> => ({ data: name === "claim_message" ? job : { status: "SENT" }, error: null }));
  const response = await worker("MOCK", rpc)();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "SENT", provider_message_id: `mock_${jobId}` });
  expect(rpc).toHaveBeenNthCalledWith(1, "claim_message", { p_message_id: jobId, p_provider_mode: "MOCK" });
  expect(rpc).toHaveBeenNthCalledWith(2, "finish_mock_message", { p_message_id: jobId, p_provider_message_id: `mock_${jobId}`, p_lease_token: lease });
});

it("missing lease fails closed before provider completion and exposes the rollout mismatch", async () => {
  const rpc = vi.fn(async (): Promise<RpcReply> => ({ data: { ...job, lease_token: null }, error: null }));
  const response = await worker("MOCK", rpc)();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: "WORKER_SCHEMA_UPGRADE_REQUIRED" });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it("stale completion reports an error and leaves the newer lease untouched", async () => {
  const rpc = vi.fn(async (name: string): Promise<RpcReply> => name === "claim_message"
    ? { data: job, error: null } : { data: null, error: { message: "MESSAGE_LEASE_CONFLICT" } });
  const response = await worker("MOCK", rpc)();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "MESSAGE_STATE_UPDATE_FAILED" });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("finish timeout after commit never declares another queued/sent outcome when fenced failure rejects", async () => {
  const rpc = vi.fn(async (name: string): Promise<RpcReply> => {
    if (name === "claim_message") return { data: job, error: null };
    if (name === "finish_mock_message") throw new Error("SYNTHETIC_TIMEOUT_AFTER_COMMIT");
    return { data: null, error: { message: "MESSAGE_LEASE_CONFLICT" } };
  });
  const response = await worker("MOCK", rpc)();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "MESSAGE_STATE_UPDATE_FAILED" });
  expect(rpc).toHaveBeenLastCalledWith("fail_message", expect.objectContaining({ p_lease_token: lease }));
});

it("disabled provider does not deliver and uses only the fenced skip transition", async () => {
  const rpc = vi.fn(async (name: string): Promise<RpcReply> => ({ data: name === "claim_message" ? job : { status: "SKIPPED" }, error: null }));
  const response = await worker(undefined, rpc)();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "SKIPPED" });
  expect(rpc).toHaveBeenNthCalledWith(1, "claim_message", { p_message_id: jobId, p_provider_mode: "DISABLED" });
  expect(rpc).toHaveBeenNthCalledWith(2, "skip_message", expect.objectContaining({ p_message_id: jobId, p_lease_token: lease }));
});
