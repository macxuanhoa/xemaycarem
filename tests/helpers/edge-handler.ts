import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

/** Runs the actual Deno handler with local mocks; never reads real credentials. */
export function loadEdgeHandler(path: string, mocks: {
  env: Record<string, string>
  createClient: (...args: unknown[]) => unknown
  fetch?: typeof fetch
  log?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const cache = new Map<string, { exports: Record<string, unknown> }>()
  function load(file: string): Record<string, unknown> {
    const cached = cache.get(file)
    if (cached) return cached.exports
    const module = { exports: {} }
    cache.set(file, module)
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText
    const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
      Deno: { env: { get: (key: string) => mocks.env[key] }, serve: (callback: typeof handler) => { handler = callback } },
      Request, Response, TextDecoder, TextEncoder, Uint8Array, AbortSignal, atob,
      // Some handlers schedule provider retries (post-ai backs off between attempts);
      // vm contexts have no Web APIs unless explicitly bridged.
      setTimeout, clearTimeout,
      // Deno exposes Web Crypto globally; handlers use crypto.randomUUID() for
      // disposable secrets (e.g. scrambling a deleted account's password).
      crypto: globalThis.crypto,
      fetch: mocks.fetch ?? (() => { throw new Error('Unexpected network request') }),
      console: mocks.log ?? { info: () => {}, error: () => {} },
    })
    execute((name: string) => {
      if (name.startsWith('npm:@supabase/supabase-js')) return { createClient: mocks.createClient, corsHeaders: {} }
      if (name.startsWith('.')) return load(resolve(dirname(file), name))
      throw new Error(`Unmocked Edge import: ${name}`)
    }, module, module.exports)
    return module.exports
  }
  load(resolve(path))
  if (!handler) throw new Error('No Edge handler registered')
  return handler
}
