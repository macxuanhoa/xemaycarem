// Native Deno verification only. No Supabase credentials or real messages are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { existsSync } from 'node:fs';

function resolveDenoBinary() {
  if (process.env.DENO_BINARY) return process.env.DENO_BINARY;
  if (process.platform === 'win32') {
    const npmDeno = join(process.env.APPDATA || '', 'npm', 'node_modules', 'deno', 'deno.exe');
    if (existsSync(npmDeno)) return npmDeno;
  }
  return 'deno';
}

const binary = resolveDenoBinary();
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, 'carem-edge-native-'));
const configuration = join(temporary, 'deno.json');
await writeFile(configuration, JSON.stringify({ compilerOptions: { strict: true }, nodeModulesDir: 'none', lock: false }));
// Retain operating-system runtime settings, explicitly omit application credentials.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|DENO_DIR)$/i.test(name)));
const functions = ['manage-users', 'process-message', 'ai-assist', 'reset-owner', 'bank-webhook', 'post-ai'];
const entries = functions.map(name => resolve(`supabase/functions/${name}/index.ts`));

async function checkedRun(argumentsList) {
  const child = spawn(binary, argumentsList, { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`Deno verification failed (${code}): ${output}`)));
  });
  console.log(output.trim());
}

async function smoke(name, configured) {
  const reservation = createServer();
  // The raw handlers call Deno.serve without options (native default8000).
  // Check availability; never stop or replace an unrelated listener.
  const port = 8000;
  await new Promise((listen, reject) => { reservation.once('error', reject); reservation.listen(port, '0.0.0.0', listen); });
  await new Promise(close => reservation.close(close));
  const childEnvironment = { ...environment };
  if (configured) Object.assign(childEnvironment, {
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'synthetic-public-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-administrative-key', ALLOWED_ORIGINS: 'http://synthetic.local',
  });
  const child = spawn(binary, ['run', `--allow-net=0.0.0.0:${port}`, '--allow-env', '--cached-only', '--no-lock', '--config', configuration, resolve(`supabase/functions/${name}/index.ts`)],
    { env: childEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let startup = '';
  child.on('exit', () => { exited = true; });
  child.stdout.on('data', chunk => { startup += chunk; });
  child.stderr.on('data', chunk => { startup += chunk; });
  const address = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (exited) throw new Error(`${name} native startup failed: ${startup}`);
      try { await fetch(address, { method: 'OPTIONS', signal: AbortSignal.timeout(500) }); ready = true; break; }
      catch { await delay(50); }
    }
    assert.ok(ready, `${name} must start under native Deno`);
    if (name === 'reset-owner') {
      const retired = await fetch(address, { method: 'POST' });
      assert.equal(retired.status, 410);
      assert.equal((await retired.json()).error, 'ENDPOINT_RETIRED');
      console.log('PASS retired endpoint remains HTTP410 under native Deno');
      return;
    }
    if (name === 'bank-webhook') {
      const health = await fetch(address);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, 'NOT_CONFIGURED');
      const post = await fetch(address, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(post.status, 401);
      assert.equal((await post.json()).status, 'UNAUTHORIZED');
      assert.equal(post.headers.get('Cache-Control'), 'no-store');
      console.log('PASS bank-webhook native startup, no-secret health and unsigned request denial');
      return;
    }
    const preflight = await fetch(address, { method: 'OPTIONS', headers: { Origin: 'http://synthetic.local' } });
    assert.equal(preflight.status, 200);
    const get = await fetch(address);
    assert.equal(get.status, 405);
    const post = await fetch(address, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, configured ? 401 : 503);
    assert.equal((await post.json()).error, configured ? 'AUTH_REQUIRED' : 'SERVER_CONFIGURATION_REQUIRED');
    assert.equal(post.headers.get('Cache-Control'), 'no-store');
    if (name === 'manage-users' && configured) {
      assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://synthetic.local');
      const deniedOrigin = await fetch(address, { method: 'OPTIONS', headers: { Origin: 'http://untrusted.local' } });
      assert.equal(deniedOrigin.headers.get('Access-Control-Allow-Origin'), null);
    }
    console.log(`PASS ${name} native startup, methods, preflight, ${configured ? 'missing-auth' : 'missing-configuration'} fail closed, no-store`);
  } finally {
    if (!exited) {
      const stopped = new Promise(done => child.once('exit', done));
      child.kill();
      await stopped;
    }
  }
}

try {
  await checkedRun(['--version']);
  await checkedRun(['check', '--config', configuration, '--no-lock', ...entries]);
  for (const name of functions) {
    await smoke(name, false);
    if (name !== 'reset-owner') await smoke(name, true);
  }
  console.log('PASS native Deno typecheck for all6 Edge entrypoints and11 isolated HTTP smoke configurations. Hosted JWT/GoTrue/PostgREST/provider behavior NOT VERIFIED.');
} finally {
  // mkdtemp creates only this isolated verification configuration directory.
  assert.equal(dirname(await realpath(temporary)), temporaryRoot);
  await rm(temporary, { recursive: true, force: true });
}
