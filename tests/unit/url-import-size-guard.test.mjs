// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #24「链接导入误报文件过大（200MB）」的回归用例：真实 urlImport 代码 + 本地 mock 服务。
//
// 为什么要这一组：
// 1. 现场只有「00:00.0 开始导入」一条详情、日志里一条都没有 → 事后无法判断是「服务器真声明了
//    200MB+」还是「头部解析取错了值」。这里用真实 HTTP 服务的响应头 + Capacitor 原生层的
//    真实 header 形态（HttpRequestHandler.buildResponseHeaders：TextUtils.join(", ")）把
//    每一种可疑形态都跑一遍，并断言「日志里必须有原始 header 值」。
// 2. 旧实现 `state.total = contentRangeTotal() ?? contentLength()` 在 206 但没有 Content-Range 时
//    会把「这一块的长度」当成整包大小（4KB），这里固定成「未知」。
//
// 只替换 Capacitor 原生桥 / diagnostics / backup；分块下载、解码、超限判定全是真实代码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    if (specifier === '../../diagnostics/collector.js') {
      return { url: stub('collector.mjs'), shortCircuit: true }
    }
    if (specifier === '../backup.js') {
      return { url: stub('backup.mjs'), shortCircuit: true }
    }
    if (specifier === './errors.js') {
      return { url: stub('errors.mjs'), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { importHistoryFromUrl, MAX_ARCHIVE_BYTES } =
  await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** 现场真实导出包的字节数（设备实测 467 条目 / 329 会话 / 135 张图片）。 */
const REAL_EXPORT_BYTES = 21195845
/** 一个「声明超过 200MB」的服务器值（250MB）。 */
const OVER_LIMIT_BYTES = 262144000

/** 合法 ZIP 头（urlImport 会校验 PK\x03\x04），其余字节填充。 */
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

/**
 * Capacitor 8.6.2 Android 侧的真实响应形态：
 * - headers：`HttpRequestHandler.buildResponseHeaders` 用 `TextUtils.join(", ", values)`
 *   把 `Map<String,List<String>>` 压成扁平的 string→string，键的大小写按服务端原样；
 * - data：`responseType: 'arraybuffer'` 时是 base64 字符串（设备实测，见 urlImport 注释）。
 */
const capacitorHeaders = (rawHeaders) => {
  const grouped = new Map()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (!grouped.has(name)) {
      grouped.set(name, [])
    }
    grouped.get(name).push(value)
  }
  const headers = {}
  for (const [name, values] of grouped) {
    headers[name] = values.join(', ')
  }
  return headers
}

const startServer = async (handler) => {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}/deepseek_data-2026-11-01.zip`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 原生桥替身：真的发一次 HTTP（带 Range），把响应转成 Capacitor 的形态。 */
const nativeFor = (port) => (options) =>
  new Promise((resolve, reject) => {
    const target = new URL(options.url)
    const headers = {}
    if (options.headers?.Range !== undefined) {
      headers.Range = options.headers.Range
    }
    if (options.headers?.Accept !== undefined) {
      headers.Accept = options.headers.Accept
    }
    const request = http.request(
      { host: '127.0.0.1', port, path: `${target.pathname}${target.search}`, method: 'GET', headers },
      (response) => {
        const chunks = []
        response.on('data', (piece) => chunks.push(piece))
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            url: options.url,
            headers: capacitorHeaders(response.rawHeaders),
            data: Buffer.concat(chunks).toString('base64'),
          })
        })
      }
    )
    request.on('error', reject)
    request.end()
  })

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

/** 跑一次导入：返回错误、真实调用次数、详情条目与诊断记录。 */
const runImport = async (port, url) => {
  const native = { native: true, calls: [], get: nativeFor(port) }
  globalThis.__native = native
  const trace = []
  const error = await importHistoryFromUrl(url, {
    onTrace: (entry) => trace.push(entry),
    downloadBudgetMs: 20_000,
    heartbeatIntervalMs: 500,
  }).then(
    () => null,
    (reason) => reason
  )
  return {
    error,
    calls: native.calls.length,
    trace,
    records: globalThis.__log.records,
    events: globalThis.__log.events,
  }
}

const eventsOf = (events, message) => events.filter((entry) => entry.message === message)

/** 按请求里的 Range 切块返回；headers 回调决定每次响应用什么头。 */
const rangeServer = (body, headerFor) => (request, response) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
  const from = match ? Number(match[1]) : 0
  const to = match ? Math.min(Number(match[2]), body.length - 1) : body.length - 1
  const slice = body.subarray(from, to + 1)
  const extra = headerFor({ from, to, slice, ranged: match !== null }) ?? []
  for (const [name, value] of extra) {
    response.setHeader(name, value)
  }
  response.writeHead(match === null ? 200 : 206)
  response.end(Buffer.from(slice))
}

// ── 1. 现场形态（真包 21,195,845 字节 + 真 Content-Range）：必须成功，且日志留证据 ──────────
test('真包 + 真 Content-Range：正常导入，日志记下原始 header 与推导来源', async () => {
  resetEnv()
  const body = zipBytes(REAL_EXPORT_BYTES)
  const server = await startServer(
    rangeServer(body, ({ from, to, slice }) => [
      ['Content-Range', `bytes ${from}-${to}/${body.length}`],
      ['Content-Length', String(slice.length)],
      ['Content-Type', 'application/zip'],
    ])
  )
  try {
    const { error, trace, events, records } = await runImport(server.port, server.url)
    assert.equal(error, null, `真包必须导入成功（${error?.key ?? ''}）`)
    assert.equal(globalThis.__imported.length, 1)
    assert.equal(globalThis.__imported[0].size, REAL_EXPORT_BYTES)

    const observed = eventsOf(events, 'import: archive size observed')
    assert.equal(observed.length, 1, '首响应必须留下一条大小证据')
    assert.equal(observed[0].fields['size.source'], 'content-range')
    assert.equal(observed[0].fields['declared.bytes'], REAL_EXPORT_BYTES)
    assert.equal(observed[0].fields['observed.content-range'], `bytes 0-4095/${REAL_EXPORT_BYTES}`)
    assert.equal(observed[0].fields['observed.content-length'], '4096')
    assert.equal(observed[0].fields['http.status'], 206)
    assert.equal(observed[0].fields['max.bytes'], MAX_ARCHIVE_BYTES)
    assert.match(observed[0].fields['url.signature'], /^http:\/\/127\.0\.0\.1:\d+\/\*\.zip$/)
    assert.equal(records.filter((entry) => entry.kind === 'import_error').length, 0, '成功路径不能记失败')
    assert.equal(trace.at(-1).kind, 'done')
  } finally {
    await server.close()
  }
})

// ── 2. 服务端忽略 Range：200 + 真 Content-Length，同样不能误判 ──────────────────────────────
test('200（忽略 Range）+ 真 Content-Length：正常导入，来源记为 content-length', async () => {
  resetEnv()
  const body = zipBytes(256 * 1024)
  const server = await startServer((request, response) => {
    response.setHeader('Content-Type', 'application/zip')
    response.setHeader('Content-Length', String(body.length))
    response.writeHead(200)
    response.end(Buffer.from(body))
  })
  try {
    const { error, events } = await runImport(server.port, server.url)
    assert.equal(error, null, `整包 200 必须成功（${error?.key ?? ''}）`)
    const observed = eventsOf(events, 'import: archive size observed')
    assert.equal(observed[0].fields['size.source'], 'content-length')
    assert.equal(observed[0].fields['declared.bytes'], body.length)
  } finally {
    await server.close()
  }
})

// ── 3. 声明 250MB（真超限）：零信息失败 → 可解释失败（Issue #24 的核心回归） ──────────────────
test('服务器声明 250MB：立刻失败，但必须带声明值、上限、原始 header 与脱敏链接', async () => {
  resetEnv()
  const body = zipBytes(REAL_EXPORT_BYTES)
  const server = await startServer(
    rangeServer(body, ({ from, to }) => [
      ['Content-Range', `bytes ${from}-${to}/${OVER_LIMIT_BYTES}`],
      ['Content-Length', '4096'],
      ['Content-Type', 'application/zip'],
    ])
  )
  try {
    const { error, calls, trace, records, events } = await runImport(server.port, server.url)

    // 与现场同形：首响应头阶段就失败，没有下载检查点
    assert.equal(error?.name, 'BackupError')
    assert.equal(error.key, 'historyImportUrlTooLarge')
    assert.equal(calls, 1, `首响应头即拦下，只发 1 次请求（实际 ${calls}）`)
    assert.deepEqual(
      trace.map((entry) => entry.kind),
      ['start', 'error'],
      '详情只应有「开始导入」+ 失败一条（旧行为就是这里零信息）'
    )
    assert.equal(trace[1].message, 'too-large')
    assert.equal(trace[1].totalBytes, OVER_LIMIT_BYTES)
    assert.equal(trace[1].bytes, 0)

    // 文案：服务器声明 vs 上限，两个数字都要有
    assert.match(error.params.declared, /^250\.0MB$/)
    assert.equal(error.params.size, 200)

    // 日志：reason + 原始 header + 上限 + 脱敏链接（不带签名 query）
    const failures = records.filter((entry) => entry.kind === 'import_error')
    assert.equal(failures.length, 1, `超限必须留下且只留一条日志（实际 ${failures.length}）`)
    assert.equal(failures[0].fields.reason, 'too-large')
    assert.equal(failures[0].fields['size.source'], 'content-range')
    assert.equal(failures[0].fields['declared.bytes'], OVER_LIMIT_BYTES)
    assert.equal(failures[0].fields['declared.size'], '250.0MB')
    assert.equal(failures[0].fields['download.bytes'], 0)
    assert.equal(failures[0].fields['max.bytes'], MAX_ARCHIVE_BYTES)
    assert.equal(failures[0].fields['observed.content-range'], `bytes 0-4095/${OVER_LIMIT_BYTES}`)
    assert.equal(failures[0].fields['observed.content-length'], '4096')
    assert.equal(failures[0].fields.stage, 'download')
    assert.doesNotMatch(failures[0].fields['url.signature'] ?? '', /\?/, '链接类别不能带 query')

    // 同一事实也要在 stage 事件里留一份（成功路径的对照）
    const observed = eventsOf(events, 'import: archive size observed')
    assert.equal(observed.length, 1)
    assert.equal(observed[0].fields['declared.bytes'], OVER_LIMIT_BYTES)
  } finally {
    await server.close()
  }
})

// ── 4. Capacitor 头部形态：大小写混合 / 值带空格 / 多值 join / 数组 ──────────────────────────
test('Capacitor 形态的响应头：大小写混合、值带前后空格、同名多值 join 都能正确解析', async () => {
  const cases = [
    {
      name: '大写键 CONTENT-RANGE / CONTENT-LENGTH',
      headers: ({ from, to, slice }) => [
        ['CONTENT-RANGE', `bytes ${from}-${to}/${REAL_EXPORT_BYTES}`],
        ['CONTENT-LENGTH', String(slice.length)],
      ],
    },
    {
      name: '值带前后空格',
      headers: ({ from, to, slice }) => [
        ['Content-Range', `  bytes ${from}-${to}/${REAL_EXPORT_BYTES}  `],
        ['Content-Length', `  ${slice.length}  `],
      ],
    },
    {
      // Content-Range 是允许重复出现的头（HTTP 规范允许），Android 侧会被 join 成 "a, b"
      name: '同名多值被 TextUtils.join(", ") 拼接',
      headers: ({ from, to }) => [
        ['Content-Range', [`bytes ${from}-${to}/${REAL_EXPORT_BYTES}`, `bytes ${from}-${to}/${REAL_EXPORT_BYTES}`]],
      ],
    },
  ]
  for (const item of cases) {
    resetEnv()
    const body = zipBytes(REAL_EXPORT_BYTES)
    const server = await startServer(rangeServer(body, item.headers))
    try {
      const { error, events } = await runImport(server.port, server.url)
      assert.equal(error, null, `${item.name}：必须成功（${error?.key ?? ''}）`)
      const observed = eventsOf(events, 'import: archive size observed')
      assert.equal(observed[0].fields['size.source'], 'content-range', item.name)
      assert.equal(observed[0].fields['declared.bytes'], REAL_EXPORT_BYTES, item.name)
    } finally {
      await server.close()
    }
  }
})

/**
 * 真实 HTTP 栈不允许重复的 Content-Length，所以「值是数组 / 值是数字」这两种 Web 实现形态
 * 直接在桥接层构造响应来验证解析（解析函数与线上同一份代码）。
 */
test('桥接层直接给数组/数字：取值不依赖值是字符串', async () => {
  resetEnv()
  const body = zipBytes(16 * 1024)
  const data = Buffer.from(body).toString('base64')
  globalThis.__native = {
    native: true,
    calls: [],
    get: () =>
      Promise.resolve({
        status: 200,
        url: 'http://127.0.0.1:1/deepseek_data-2026-11-01.zip',
        headers: {
          'CONTENT-RANGE': [`bytes 0-${body.length - 1}/${body.length}`],
          'Content-Length': [body.length],
          'Content-Type': ['application/zip'],
        },
        data,
      }),
  }
  const events = []
  const error = await importHistoryFromUrl('http://127.0.0.1:1/deepseek_data-2026-11-01.zip', {
    onTrace: (entry) => events.push(entry),
    downloadBudgetMs: 5000,
    heartbeatIntervalMs: 500,
  }).then(
    () => null,
    (reason) => reason
  )
  assert.equal(error, null, `数组/数字形态的头部必须能解析（${error?.key ?? ''}）`)
  const observed = eventsOf(globalThis.__log.events, 'import: archive size observed')
  assert.equal(observed[0].fields['size.source'], 'content-range')
  assert.equal(observed[0].fields['declared.bytes'], body.length)
  assert.equal(observed[0].fields['observed.content-length'], String(body.length))
})

// ── 5. 旧解析缺陷回归：206 但没有 Content-Range 时，不能把「这一块」当成整包 ────────────────
test('206 但没有 Content-Range：总量必须记为未知，不能拿块长 4096 冒充整包', async () => {
  resetEnv()
  const body = zipBytes(64 * 1024)
  const server = await startServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    const from = match ? Number(match[1]) : 0
    const to = match ? Math.min(Number(match[2]), body.length - 1) : body.length - 1
    const slice = body.subarray(from, to + 1)
    // 故意只给 Content-Length（某些网关会吃掉 Content-Range）
    response.setHeader('Content-Length', String(slice.length))
    response.setHeader('Content-Type', 'application/zip')
    response.writeHead(206)
    response.end(Buffer.from(slice))
  })
  try {
    const { error, trace, events } = await runImport(server.port, server.url)
    assert.equal(error, null, `能下完就应当成功（${error?.key ?? ''}）`)
    const observed = eventsOf(events, 'import: archive size observed')
    assert.equal(observed[0].fields['size.source'], 'none')
    assert.equal(observed[0].fields['declared.bytes'], undefined, '206 的 Content-Length 只是块长，不能当总量')
    assert.ok(
      trace.every((entry) => entry.totalBytes === undefined),
      '进度里也不能出现 4096 这种假总量'
    )
  } finally {
    await server.close()
  }
})

// ── 6. 边界形态：`bytes 0-1023/*`（总量未知）、Content-Length: 0 ───────────────────────────
test('Content-Range 带 * 通配：总量未知，不触发超限判定', async () => {
  resetEnv()
  const body = zipBytes(32 * 1024)
  const server = await startServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    const from = match ? Number(match[1]) : 0
    const to = match ? Math.min(Number(match[2]), body.length - 1) : body.length - 1
    const slice = body.subarray(from, to + 1)
    response.setHeader('Content-Range', `bytes ${from}-${to}/*`)
    response.setHeader('Content-Length', String(slice.length))
    response.writeHead(206)
    response.end(Buffer.from(slice))
  })
  try {
    const { error, events, records } = await runImport(server.port, server.url)
    assert.equal(error, null, `总量未知时不能拦（${error?.key ?? ''}）`)
    const observed = eventsOf(events, 'import: archive size observed')
    assert.equal(observed[0].fields['size.source'], 'none')
    assert.equal(observed[0].fields['observed.content-range'], 'bytes 0-4095/*')
    assert.equal(records.filter((entry) => entry.kind === 'import_error').length, 0)
  } finally {
    await server.close()
  }
})

test('Content-Length: 0：按「数据无法解析」失败，不能报成文件过大', async () => {
  resetEnv()
  const server = await startServer((request, response) => {
    response.setHeader('Content-Length', '0')
    response.writeHead(200)
    response.end()
  })
  try {
    const { error } = await runImport(server.port, server.url)
    assert.equal(error?.key, 'historyImportUrlBadResponse')
  } finally {
    await server.close()
  }
})

// ── 7. 非 ZIP：失败事实也要进诊断与详情（以前只有界面文案，日志里找不到） ────────────────────
test('下载成功但不是 ZIP：留 reason=not-zip 与详情，不当成文件过大', async () => {
  resetEnv()
  const body = new TextEncoder().encode('<html><body>share page</body></html>')
  const server = await startServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.setHeader('Content-Length', String(body.length))
    response.writeHead(200)
    response.end(Buffer.from(body))
  })
  try {
    const { error, trace, records } = await runImport(server.port, server.url)
    assert.equal(error?.key, 'historyImportUrlNotZip')
    const failures = records.filter((entry) => entry.kind === 'import_error')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].fields.reason, 'not-zip')
    assert.equal(failures[0].fields['download.bytes'], body.length)
    assert.equal(trace.at(-1).kind, 'error')
    assert.equal(trace.at(-1).message, 'not-zip')
  } finally {
    await server.close()
  }
})

// ── 8. 文案：新终态必须有对应 key，且带「声明值 / 上限」占位符 ───────────────────────────────
test('终态文案可读：zh/en 一一对应，超限文案带声明值与上限', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
  for (const dict of [zh, en]) {
    assert.match(dict.historyImportUrlTooLarge, /\{declared\}/)
    assert.match(dict.historyImportUrlTooLarge, /\{size\}/)
    assert.match(dict.historyImportUrlTooLargeDownloaded, /\{done\}/)
    assert.match(dict.historyImportUrlTooLargeDownloaded, /\{size\}/)
    assert.match(dict.importTraceReasonTooLarge, /\{declared\}/)
    assert.match(dict.importTraceReasonTooLarge, /\{size\}/)
    assert.match(dict.importTraceReasonTooLargeDownloaded, /\{done\}/)
  }
})
