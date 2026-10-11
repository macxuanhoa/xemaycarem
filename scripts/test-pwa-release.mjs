// Validate the actual built PWA on an isolated loopback preview, with lifecycle
// managed here so CI and Windows use the same gate and never reuse an old server.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { once } from 'node:events'

const portProbe = createServer()
await new Promise((done) => portProbe.listen(0, '127.0.0.1', done))
const port = portProbe.address().port
await new Promise((done, reject) => portProbe.close(error => error ? reject(error) : done()))
const url = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true })
let startupError
server.on('error', error => { startupError = error })

function run(script) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PWA_TEST_URL: url } })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? done() : reject(new Error(`${script} failed (${code})`)))
  })
}

try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startupError) throw startupError
    if (server.exitCode !== null) throw new Error('Isolated preview exited before startup')
    try { ready = (await fetch(url, { signal: AbortSignal.timeout(500) })).ok } catch { /* startup only */ }
    if (ready) break
    await new Promise(done => setTimeout(done, 250))
  }
  if (!ready) throw new Error('Isolated preview failed to start')
  await run('scripts/check-pwa.mjs')
  await run('scripts/check-pwa-upgrade.mjs')
  console.log('PASS isolated built PWA, offline shell and explicit update gate')
} finally {
  if (server.exitCode === null) {
    const stopped = once(server, 'exit')
    server.kill()
    await stopped
  }
}
