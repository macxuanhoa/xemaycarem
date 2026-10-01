import { describe, expect, it } from "vitest";
import {
  createMessagingProvider,
  DisabledMessagingProvider,
  MockMessagingProvider,
} from "../../supabase/functions/process-message/provider";

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

  it("fails closed for disabled and unconfigured provider modes", async () => {
    for (const mode of [undefined, "", "ZALO", "SMS"]) {
      const provider = createMessagingProvider(mode);
      expect(provider).toBeInstanceOf(DisabledMessagingProvider);
      await expect(provider.sendTransactionalMessage({
        recipient: "+84912345678",
        channel: "SMS",
        template: "sale_thank_you_v1",
        variables: {},
        idempotencyKey: "outbox-id",
      })).rejects.toThrow("PROVIDER_NOT_CONFIGURED");
    }
  });
});
