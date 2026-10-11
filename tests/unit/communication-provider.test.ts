import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMessagingProvider,
  DisabledMessagingProvider,
  MockMessagingProvider,
} from "../../supabase/functions/process-message/provider";

afterEach(() => vi.unstubAllGlobals());

describe("transactional messaging provider modes", () => {
  it("uses the mock provider only when MOCK is explicitly selected", async () => {
    const provider = createMessagingProvider("MOCK");
    expect(provider).toBeInstanceOf(MockMessagingProvider);
    const result = await provider.sendTransactionalMessage({
      recipient: "+84912345678",
      channel: "SMS",
      template: "sale_thank_you_v1",
      variables: { customer_name: "Khách" },
      idempotencyKey: "outbox-id",
    });
    expect(result.status).toBe("SENT");
    expect(result.providerMessageId).toMatch(/^mock_/);
  });

  it("fails closed for disabled and unrecognised provider modes", async () => {
    // A bare getter (no env) is the default: unknown/disabled modes never fake a send.
    for (const mode of [undefined, "", "ZALO"]) {
      const provider = createMessagingProvider(mode);
      expect(provider).toBeInstanceOf(DisabledMessagingProvider);
      await expect(
        provider.sendTransactionalMessage({
          recipient: "+84912345678",
          channel: "SMS",
          template: "sale_thank_you_v1",
          variables: {},
          idempotencyKey: "outbox-id",
        }),
      ).rejects.toThrow("PROVIDER_NOT_CONFIGURED");
    }
  });

  it("wires V2 official adapters but keeps them fail-closed without credentials", async () => {
    // V2 gives SMS/ZALO_OA/FB_MESSENGER real adapters. With no env injected they must
    // still throw PROVIDER_NOT_CONFIGURED — the system NEVER pretends a send succeeded.
    const cases: { mode: string; name: string; channel: "SMS" | "ZALO_OA" | "FB_MESSENGER" }[] = [
      { mode: "SMS", name: "SMS", channel: "SMS" },
      { mode: "ZALO_OA", name: "ZALO_OA", channel: "ZALO_OA" },
      { mode: "FB_MESSENGER", name: "FB_MESSENGER", channel: "FB_MESSENGER" },
    ];
    for (const { mode, name, channel } of cases) {
      const provider = createMessagingProvider(mode);
      expect(provider.name).toBe(name);
      expect(provider).not.toBeInstanceOf(DisabledMessagingProvider);
      await expect(
        provider.sendTransactionalMessage({
          recipient: "+84912345678",
          channel,
          template: "thank_you_v1",
          variables: { customer_name: "Khách" },
          idempotencyKey: "outbox-id",
        }),
      ).rejects.toThrow("PROVIDER_NOT_CONFIGURED");
    }
  });
});

describe("official provider acceptance is never invented", () => {
  const config: Record<string, string> = {
    SMS_API_ACCESS_KEY: "synthetic-key", SMS_API_SECRET_KEY: "synthetic-secret", SMS_SENDER_NUMBER: "CAREM",
    SMS_API_URL: "https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/",
    ZALO_OA_ID: "synthetic-oa", ZALO_OA_ACCESS_TOKEN: "synthetic-token", ZALO_OA_TEMPLATE_ID: "433555",
    FB_PAGE_ACCESS_TOKEN: "synthetic-token", FB_GRAPH_API_VERSION: "v24.0",
  };
  const env = (name: string) => config[name];
  const message = { recipient: "+84912345678", channel: "SMS" as const,
    template: "thank_you_sms_v1", variables: { message: "Cam on!" }, idempotencyKey: "outbox-id" };

  it.each([{}, { code: 0 }, { CodeResult: "100" }, { CodeResult: "101", SMSID: "actual-provider-id" },
    { CodeResult: "100", SMSID: {} }, [], null])("SMS rejects absent or unproven provider acceptance: %s", async (reply) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(reply), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createMessagingProvider("SMS", env).sendTransactionalMessage(message)).rejects.toThrow("PROVIDER_ERROR");
  });

  it("SMS accepts only its real provider ID and sends the documented eSMS fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ CodeResult: "100", SMSID: "real-sms-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await createMessagingProvider("SMS", env).sendTransactionalMessage(message))
      .toEqual({ providerMessageId: "real-sms-id", status: "SENT" });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ ApiKey: "synthetic-key", SecretKey: "synthetic-secret",
      Brandname: "CAREM", Phone: "+84912345678", Content: "Cam on!", RequestId: "outbox-id" });
  });

  it("rejects unsafe or unknown SMS endpoints before sending secrets", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const endpoint of ["http://rest.esms.vn/api", "https://unknown.example/send", "https://rest.esms.vn/wrong",
      "https://user:password@rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/"]) {
      await expect(createMessagingProvider("SMS", name => name === "SMS_API_URL" ? endpoint : env(name))
        .sendTransactionalMessage(message)).rejects.toThrow("PROVIDER_NOT_CONFIGURED");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("OA and Messenger refuse phone-only routing even when credentials exist", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const channel of ["ZALO_OA", "FB_MESSENGER"] as const) {
      await expect(createMessagingProvider(channel, env).sendTransactionalMessage({ ...message, channel }))
        .rejects.toThrow("PROVIDER_NOT_CONFIGURED");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("OA uses the official template API and never treats request IDs as message IDs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: 0, data: { request_id: "request-only" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createMessagingProvider("ZALO_OA", env).sendTransactionalMessage({ ...message,
      channel: "ZALO_OA", recipient: "3485904339058348590" })).rejects.toThrow("PROVIDER_ERROR");
    expect(fetch.mock.calls[0][0]).toBe("https://openapi.zalo.me/v3.0/oa/message/template");
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ access_token: "synthetic-token" });
  });
});
