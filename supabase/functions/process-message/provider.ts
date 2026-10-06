export type TransactionalMessage = {
  recipient: string;
  channel: 'ZALO_ZNS' | 'SMS';
  template: string;
  variables: Record<string, string>;
  idempotencyKey: string;
};

export type ProviderResult = { providerMessageId: string; status: 'SENT' };

export interface MessagingProvider {
  readonly name: 'MOCK' | 'DISABLED';
  sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult>;
}

export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'MOCK' as const;
  async sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult> {
    // MOCK has no external effect. A stable result lets a new worker reconcile the
    // same outbox operation after a crash without inventing a second delivery.
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(message.idempotencyKey)) throw new Error('INVALID_IDEMPOTENCY_KEY');
    return { providerMessageId: `mock_${message.idempotencyKey}`, status: 'SENT' };
  }
}

export class DisabledMessagingProvider implements MessagingProvider {
  readonly name = 'DISABLED' as const;
  async sendTransactionalMessage(_message: TransactionalMessage): Promise<never> {
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }
}

export function createMessagingProvider(mode: string | undefined): MessagingProvider {
  return mode === 'MOCK' ? new MockMessagingProvider() : new DisabledMessagingProvider();
}
