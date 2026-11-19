import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, access, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { listenFetchablePort, listenFreePort } from './ports.mjs'

/**
 * 每个用例进程的预加载：把 rspack DefinePlugin 在打包期注入的 `__ENDPOINTS__` 挂到 globalThis
 * （src 里几个模块顶层就在读它）。只设这一个标识符，`__API_ORIGIN__` / `__INTERNAL_BUILD__`
 * 仍然由各用例自己按需 `??=`，见 ./injected.mjs 的文件头。
 * 用 file URL 传参：Windows 盘符路径带 `D:` 会被当成「未知选项的值」。
 */
const PRELOAD = new URL('./injected.mjs', import.meta.url)
// 沙箱用例会把 runtime.mjs 拷到临时目录单独跑（tests/unit/test-runtime.test.mjs），
// 那里没有这份预加载文件 —— 缺了就不带这个参数，不因为它而改掉用例的既有行为。
const preloadArgs = existsSync(PRELOAD) ? ['--import', PRELOAD.href] : []

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
    child = spawn(process.execPath, [...(nodeTest ? ['--test'] : []), ...preloadArgs, file], {
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

export async function serveDist(dir, { port = 0, choosePort } = {}) {
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
  // listen(0) 不等于「能连上」：Windows 的动态端口从 1024 起，会把 WHATWG/undici 的 bad port
  // （6566 / 6666 / 6697 …）当空闲端口发出来，fetch 直接 cause: bad port —— 并发跑套件时的偶发假红。
  const actualPort =
    Number(port) === 0 ? await listenFreePort(server, { choosePort }) : await listenFetchablePort(server, port)
  return { url: `http://127.0.0.1:${actualPort}`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  }) }
}
