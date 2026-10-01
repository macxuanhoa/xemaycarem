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
  async sendTransactionalMessage(_message: TransactionalMessage): Promise<ProviderResult> {
    return { providerMessageId: `mock_${crypto.randomUUID()}`, status: 'SENT' };
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
