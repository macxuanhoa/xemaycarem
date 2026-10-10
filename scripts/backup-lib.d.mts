export function sha256(file: string): string;
export function parseQueryRows(stdout: string): unknown[];
export function dumpPublicCounts(sql: string): Record<string, number>;
export function containedPath(root: string, portablePath: string): string;
export function checkSetIntegrity(manifestPath: string, root?: string): { ok: boolean; files: number; fullHashes: boolean; failures: string[] };
export function needsRestoreDrill(health: { lastVerify?: { ok?: boolean; at?: string } } | null, now?: Date): boolean;
