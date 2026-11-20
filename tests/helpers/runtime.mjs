import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, access, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { listenFetchablePort, listenFreePort } from './ports.mjs'
import { tapCounts } from './tap.mjs'

/**
 * 每个用例进程的预加载：把 rspack DefinePlugin 在打包期注入的 `__ENDPOINTS__` 挂到 globalThis
 * （src 里几个模块顶层就在读它）。只设这一个标识符，`__API_ORIGIN__` / `__INTERNAL_BUILD__`
 * 仍然由各用例自己按需 `??=`，见 ./injected.mjs 的文件头。
 * 用 file URL 传参：Windows 盘符路径带 `D:` 会被当成「未知选项的值」。
 */
const PRELOAD = new URL('./injected.mjs', import.meta.url)
/** 进程合并入口（#366 第二批）：一个进程内顺序跑同一批测试文件 */
const MERGED_ENTRY = fileURLToPath(new URL('./merged-entry.mjs', import.meta.url))
// 沙箱用例会把 runtime.mjs 拷到临时目录单独跑（tests/unit/test-runtime.test.mjs），
// 那里没有这份预加载文件 —— 缺了就不带这个参数，不因为它而改掉用例的既有行为。
const preloadArgs = existsSync(PRELOAD) ? ['--import', PRELOAD.href] : []

/**
 * #287：`toLocal.ts` / `store.ts` / `client.ts` 的依赖链含 TS 非可擦语法（enum / 参数属性等），
 * 裸 node 的 strip-only 模式 import 会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 * 以前两条用例在 catch 里 `t.skip()` 兜底，于是 CI 唯一跑法（`pnpm test`）下它们**永远是 SKIP**，
 * `toSorted`/`toReversed` 的旧内核回退坏了也照样全绿。现在开关收敛在 runner 里：每个用例子进程都带上它，
 * 用例加载即真实执行，加载失败就是失败 —— 不再存在「带开关」和「不带开关」两套跑法。
 */
const TRANSFORM_TYPES_ARGS = ['--experimental-transform-types']

/**
 * 起一个用例子进程并把落点收齐（单文件与「合并批次」共用这一段，避免两套 spawn 逻辑各自漂移）。
 *
 * `output` 决定子进程输出是**实时转发**还是**攒起来**（并行跑时按条缓冲，免得几个文件的输出
 * 交错成一团；串行跑时仍然实时转发，方便盯日志）。
 */
async function spawnCase(argv, { cwd, timeoutMs = 180000, env = process.env, output = true, tap = false } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'deepseek-case-'))
  /**
   * #501（P0）：合并批次要不要带 node 自己的 TAP 报告。
   *
   * 带：TAP 写进本进程专属的文件（`--test-reporter-destination`），stdout 保持原样（框架行 +
   * 自收摊脚本的输出），两个读者互不打架；`runMergedBatch` 用整份 TAP 复核逐文件计数。
   * 不带：单文件路径（`runCase`）—— 它的退出码本身就是权威判定，TAP 只会多一份噪音。
   */
  const tapLog = tap ? path.join(tempDir, 'node-test.tap') : null
  /**
   * #501：`NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID` 必须从子进程环境里剥掉。
   *
   * 这两个是 node 的「我是某个 runner 的子进程，报告走 v8 序列化回父进程」开关。子进程一旦继承：
   *   · 合并批次：合并入口不再走自己的 reporter（`--test-reporter=tap` 被忽略），逐文件判定失去依据；
   *   · 单文件 `node --test`：node 直接打印「run() is being called recursively…skipping running files」
   *     然后 **exit 0** —— 一条用例都没跑，却报绿（假绿的另一种形态，实测于本单的自检）。
   * 这条继承链真实存在：**从用例里起 runner**（运行器自检、test-runtime 那类沙箱）就是这种进程树。
   */
  const { NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID, ...childEnv } = env
  const started = performance.now()
  let child, timer, escalation, timedOut = false, interrupted = false, spawnError
  const tail = []
  const collected = []
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
    const reporterArgs = tapLog ? ['--test-reporter=tap', `--test-reporter-destination=${tapLog}`] : []
    child = spawn(process.execPath, [...reporterArgs, ...argv], {
      cwd,
      env: {
        ...childEnv, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, TEST_TMP_DIR: tempDir,
        // 合并入口靠它增量朗读 TAP，把「哪条用例红」归到文件上（见 helpers/merged-entry.mjs）
        ...(tapLog ? { MERGED_TAP_LOG: tapLog } : {}),
      },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    // node:test 的 TAP 输出里被跳过的子测试是 `ok 2 - 名字 # SKIP 原因`（末尾还有 `# skipped N` 汇总）。
    // #287：以前跳过在 runner 这一层完全不可见（进程退出码是 0），「看起来全绿、实际一行断言没跑」就藏在这里。
    // 这里按行扫出来交给 run-layer 汇总打印（见 run-layer 的 NODE-SKIP），至少让跳过在报告里露头。
    // #298：只数「有几条跳过」不够 —— `NODE-SKIP 2` 看不出是哪两条门禁没跑。这里连 TAP 行里的
    // 用例名与跳过原因一起带出来，交给 run-layer 具名打印。
    let lineCarry = ''
    const subtestSkipped = []
    const scanSkips = (text) => {
      const lines = (lineCarry + text).split('\n')
      lineCarry = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('# SKIP')) continue
        const match = /^\s*(?:not ok|ok)\s+\d+\s+-\s+(.*?)\s+# SKIP\s*([\s\S]*)$/.exec(line)
        subtestSkipped.push(
          match ? { name: match[1].trim(), reason: match[2].trim() } : { name: line.trim(), reason: '' }
        )
      }
    }
    const keep = (stream, chunk) => {
      const text = chunk.toString()
      // #487：**必须一律收进 `collected`**。这里原来是二选一（实时转发 or 攒起来），
      // 于是 `--jobs 1`（串行）时子进程输出全被转走、`collected` 恒为空 —— 而
      // ./runtime.mjs 的 runMergedBatch 正是从 `collected` 里解析每个文件的 `<< FILE` 收尾行。
      // 结果：串行跑合并批次时**一个收尾行都解析不到**，整批 16 个文件全被报成「批内崩溃」，
      // 再靠单文件重跑兜回绿（实测 `node tests/run-layer.mjs unit --jobs 1` 在干净 main 上
      // 就是 16×「批内崩溃」+ 16×「单文件重跑，与批内结果不同」）。资源不足不是原因，
      // 丢失输出才是。转发与否只影响"要不要同时打到终端"，与「留不留证据」无关。
      collected.push(text)
      if (output) stream.write(chunk)
      scanSkips(text)
      tail.push(text)
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
    // 进程已退出：TAP 文件此刻是完整的，读它不存在「还没写完」的时序问题
    let tapLogText = null
    if (tapLog) {
      try { tapLogText = await readFile(tapLog, 'utf8') } catch { tapLogText = '' }
    }
    return { ok: code === 0 && !signal && !timedOut && !interrupted && !spawnError,
      code, signal, timedOut, interrupted, error: spawnError,
      // skips = 跳过条数（判红门禁不看它）；skipDetails = 逐条的名字与原因（#298 具名上报）
      skips: subtestSkipped.length, skipDetails: subtestSkipped,
      ms: Math.round(performance.now() - started), tail, collected, tempDir, tapLogText }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    signalGroup('SIGKILL')
    await rm(tempDir, { recursive: true, force: true })
  }
}

// One invocation owns one directory and (on POSIX) one process group. Never pkill by name.
export async function runCase(file, { cwd, timeoutMs = 180000, env = process.env, output = true, nodeArgs = [] } = {}) {
  const source = await readFile(file, 'utf8')
  const nodeTest = /(?:from\s*|import\s*|require\(\s*)['"]node:test['"]/.test(source)
  const result = await spawnCase(
    [...nodeArgs, ...TRANSFORM_TYPES_ARGS, ...(nodeTest ? ['--test'] : []), ...preloadArgs, file],
    { cwd, timeoutMs, env, output },
  )
  const { collected, ...rest } = result
  return collected.length ? { ...rest, output: collected.join('') } : rest
}

/**
 * #366 第二批：一个进程内顺序跑一批测试文件（装配见 ./merged-entry.mjs）。
 *
 * 返回的 `files` 是**逐文件**结局：`{ file, ok, outcome, tests, pass, fail, skip, ms }`。
 * 批次进程崩了/超时了，没有收尾行的文件不会出现在 `files` 里 —— caller 负责把它们判失败，
 * 「没跑完」不许被当成「通过」。
 *
 * #501（P0）：`files` 里的计数与结局取自 **node 自己的 TAP 报告**（`tap` 选项把它写到临时文件），
 * 另外整批再复核一遍：逐文件计数之和必须等于 TAP 的总数（每条用例恰好归到一处），
 * 失败条数不许少于 TAP 报的 —— 对不上就返回 `unreliable`，**不许当绿**，由 caller 退到单文件复核。
 */
export async function runMergedBatch(files, { cwd, timeoutMs = 180000, env = process.env, output = true, nodeArgs = [] } = {}) {
  const result = await spawnCase(
    [...nodeArgs, ...TRANSFORM_TYPES_ARGS, ...preloadArgs, MERGED_ENTRY, ...files],
    { cwd, timeoutMs, env, output, tap: true },
  )
  const text = result.collected.join('')
  const outcomes = []
  // 逐文件的「跳过明细」按 `>> FILE` / `<< FILE` 帧归属：跳过要指名道姓（#298），
  // 合并后不能把 A 文件的跳过算到 B 文件头上。
  let framing = null
  for (const line of text.split('\n')) {
    const opened = /^>> FILE (\S+)$/.exec(line.trim())
    if (opened) { framing = { file: opened[1], skipDetails: [] }; continue }
    const matched = /^<< FILE (\S+) (PASS|SKIP|FAIL|EMPTY) tests=(\d+) pass=(\d+) fail=(\d+) skip=(\d+) ms=(\d+)(?: script=(-?\d+))?$/.exec(line.trim())
    if (!matched) {
      const skippedLine = /^(?:not ok|ok)\s+\d+\s+-\s+(.*?)\s+# SKIP\s*(.*)$/.exec(line.trim())
      if (skippedLine && framing) framing.skipDetails.push({ name: skippedLine[1].trim(), reason: skippedLine[2].trim() })
      continue
    }
    outcomes.push({
      file: matched[1],
      outcome: matched[2],
      tests: Number(matched[3]),
      pass: Number(matched[4]),
      fail: Number(matched[5]),
      skip: Number(matched[6]),
      ms: Number(matched[7]),
      script: matched[8] === undefined ? undefined : Number(matched[8]),
      skipDetails: framing?.file === matched[1] ? framing.skipDetails : [],
      ok: matched[2] === 'PASS' || matched[2] === 'SKIP',
    })
    framing = null
  }
  /**
   * #501：整批复核（这是「不许假绿」的最后一道闸）。
   *
   * 逐文件计数是 merged-entry 边跑边朗读 TAP 得到的，**朗读时机**理论上可能落后一条
   * （node 在用例落定后的下一轮宏任务才写报告）。所以这里等进程彻底退出、文件完整之后再核一遍：
   *   · `tap.tests` 必须等于逐文件计数之和 —— 不相等说明有事件没归到文件上（或归重了）；
   *   · `tap.fail + tap.suiteFail` 不许大于逐文件 fail 之和 —— 大于说明有失败被漏判。
   * 任一不成立 ⇒ `unreliable`：caller 必须退到单文件进程复核（退出码是权威），不许直接放绿。
   *
   * 「没有收尾行」的文件（批次崩了/超时）不参与这条复核：它们已经由 caller 按 pendingDegrade 处理。
   */
  const tap = tapCounts(result.tapLogText ?? '')
  const framingFail = outcomes.reduce((sum, entry) => sum + entry.fail, 0)
  const framingTests = outcomes.reduce((sum, entry) => sum + entry.tests, 0)
  const missingCount = files.length - outcomes.length
  const problems = []
  if (!missingCount) {
    if (tap.tests !== framingTests) {
      problems.push(`node reporter 报了 ${tap.tests} 条用例，逐文件只归到 ${framingTests} 条`)
    }
    if (tap.fail + tap.suiteFail > framingFail) {
      problems.push(`node reporter 报了 ${tap.fail + tap.suiteFail} 条失败，逐文件只认了 ${framingFail} 条`)
    }
  }
  const { collected, tapLogText, ...rest } = result
  return {
    ...rest,
    output: text,
    files: outcomes,
    tap,
    ...(problems.length
      ? { unreliable: { reason: '合并批次的逐文件判定与 node 的 reporter 对不上', detail: problems, tap, framing: { tests: framingTests, fail: framingFail } } }
      : {}),
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
