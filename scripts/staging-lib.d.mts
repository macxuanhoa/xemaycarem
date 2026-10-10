export type StagingConfig = { stagingRef: string; productionRef: string; url: string; key: string; appEnv: string };
export function parseEnvironment(text: string): Record<string, string>;
export function validateStaging(values: Record<string, string>, linkedProductionRef?: string | null): StagingConfig;
export function loadStaging(file?: string, env?: Record<string, string | undefined>): StagingConfig;
export function probeStaging(config: StagingConfig, fetcher?: typeof fetch): Promise<{ ok: boolean; checks: { name: string; ok: boolean }[] }>;
