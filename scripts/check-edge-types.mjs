// Local TypeScript verification when Deno is unavailable. Hosted Deno module
// resolution and live service behavior still require a deployment integration check.
import { resolve } from 'node:path'
import ts from 'typescript'

const shimPath = resolve('supabase/functions/.local-runtime-types.d.ts')
const shim = `
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}
declare module 'npm:@supabase/supabase-js@2.117.2' {
  import { createClient as localCreateClient } from '@supabase/supabase-js';
  export const createClient: typeof localCreateClient;
  export type { SupabaseClient } from '@supabase/supabase-js';
}
declare module 'npm:@supabase/supabase-js@2.117.2/cors' {
  export const corsHeaders: Record<string, string>;
}
`
const options = { strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] }
const host = ts.createCompilerHost(options)
const isShim = file => resolve(file).toLowerCase() === shimPath.toLowerCase()
const originalFileExists = host.fileExists.bind(host)
host.fileExists = file => isShim(file) || originalFileExists(file)
const originalGetSourceFile = host.getSourceFile.bind(host)
host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => isShim(file)
  ? ts.createSourceFile(file, shim, languageVersion)
  : originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
const sourceFiles = ['manage-users/index.ts', 'reset-owner/index.ts', 'ai-assist/index.ts', 'ai-assist/contracts.ts', 'ai-assist/copilot.ts', 'process-message/index.ts']
  .concat(['bank-webhook/index.ts', 'post-ai/index.ts'])
  .map(file => resolve('supabase/functions', file))
const program = ts.createProgram([shimPath, ...sourceFiles], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
for (const diagnostic of diagnostics) {
  const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null
  console.error(`${diagnostic.file?.fileName ?? 'Edge'}${position ? `:${position.line + 1}` : ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
}
if (diagnostics.length) process.exitCode = 1
else console.log(`Edge TypeScript passes for ${sourceFiles.length} files with local platform types. Deno/deployed integration remains unverified.`)
