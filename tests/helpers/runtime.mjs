import { spawn } from 'node:child_process'
import { mkdtemp, rm, access, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'

// One invocation owns one directory and (on POSIX) one process group. Never pkill by name.
export async function runCase(file, { cwd, timeoutMs = 180000, env = process.env, output = true } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'deepseek-case-'))
  const started = performance.now()
  let child, timer, escalation, timedOut = false, interrupted = false, spawnError
  const tail = []
  const signalGroup = (signal) => {
    if (!child?.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const stop = () => {
    signalGroup('SIGTERM')
    escalation ??= setTimeout(() => signalGroup('SIGKILL'), 300)
  }
  const onSignal = () => { interrupted = true; stop() }
  try {
    const source = await readFile(file, 'utf8')
    const nodeTest = /(?:from\s*|import\s*|require\(\s*)['"]node:test['"]/.test(source)
    child = spawn(process.execPath, nodeTest ? ['--test', file] : [file], {
      cwd, env: { ...env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, TEST_TMP_DIR: tempDir },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    const keep = (stream, chunk) => {
      if (output) stream.write(chunk)
      tail.push(chunk.toString())
      if (tail.length > 100) tail.shift()
    }
    child.stdout.on('data', (chunk) => keep(process.stdout, chunk))
    child.stderr.on('data', (chunk) => keep(process.stderr, chunk))
    child.on('error', (error) => { spawnError = String(error) })
    timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    // The direct child may exit while a descendant still owns stdout or a listener.
    child.once('exit', () => stop())
    const { code, signal } = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
    signalGroup('SIGKILL')
    return { ok: code === 0 && !signal && !timedOut && !interrupted && !spawnError,
      code, signal, timedOut, interrupted, error: spawnError, ms: Math.round(performance.now() - started), tail, tempDir }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    signalGroup('SIGKILL')
    await rm(tempDir, { recursive: true, force: true })
  }
}

// No implicit compilation: caller supplies a privately built, immutable artifact.
export async function requireDist(dir) {
  const resolved = path.resolve(dir)
  await access(path.join(resolved, 'index.html')).catch(() => {
    throw new Error(`Missing prebuilt index.html in ${resolved}; provide DIST_DIR / STANDARD_DIST_DIR (no automatic build)`)
  })
  return resolved
}

export async function serveDist(dir, { port = 0 } = {}) {
  const root = await requireDist(dir)
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      let file = path.resolve(root, `.${pathname}`)
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
      res.end(await readFile(file))
    } catch { res.writeHead(404).end() }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port), '127.0.0.1', resolve)
  })
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  }) }
}
