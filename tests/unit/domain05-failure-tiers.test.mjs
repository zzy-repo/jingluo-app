// [layer: unit | 依赖: 无（纯 Node；分类器是纯函数，终态映射只替换 Capacitor 原生桥） | 耗时: <5s]
//
// 域 5 / N2：**失败原因分档矩阵**（docs/testing/coverage/domain-05.md §6.2 N2，14 行）。
//
// 覆盖功能点：
//   F-05-08 失败原因分档与文案（offline / unreachable / refused / server / 超时（有·无已下载）/
//           连接中断 / 非 ZIP / 403（过期·签名·其他）各一句不同人话）+ 服务层「非原生平台」拒绝
//
// 为什么最脆弱（#111 → #18 → #154 → #203 → #195，同一句用户提示改了 5 轮）：
//   分类输入是**异常字符串匹配**，各 WebView / 各厂商 ROM 措辞不同；认不出来时 classifyImportFailure
//   返回 null → 退化成通用文案，既不抛错也不会红。所以这张表做两件事：
//   ① 把 8 类原因 × 中文/英文文案**逐句**钉住（改文案就红，改分类就红）；
//   ② 把「认不出来」显式断言成「不硬说是断网」——这条负向断言才是 #111 的真正防线。
//
//   node --test tests/unit/domain05-failure-tiers.test.mjs
import { test } from 'node:test'
import { installHooks, placeholders, render, stubOf } from '../fixtures/domain05/hooks.mjs'
import { expectDeepEqual, expectEqual, expectMatch, expectOk, runTable } from '../fixtures/domain05/table.mjs'

installHooks((specifier) => {
  if (specifier === '@capacitor/core') {
    return stubOf('../url-import-stubs/capacitor.mjs')
  }
  if (specifier === '../../diagnostics/collector.js') {
    return stubOf('../url-import-stubs/collector.mjs')
  }
  if (specifier === '../backup.js') {
    return stubOf('../url-import-stubs/backup.mjs')
  }
  if (specifier === './errors.js') {
    return stubOf('../url-import-stubs/errors.mjs')
  }
  return null
})

const { classifyImportFailure, IMPORT_FAILURE_KEYS } = await import(
  '../../src/services/chat/history/importFailure.ts'
)
const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const HAN = /[\u4e00-\u9fff]/
const base64 = (text) => btoa(text)
const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

/** 一次导入的终态（失败返回错误对象，成功返回 null）。 */
const runImport = (link, options = {}) =>
  importHistoryFromUrl(link, options).then(
    () => null,
    (error) => error
  )

/**
 * 文案契约：zh / en 都有一句、占位符对齐、en 里不出现中文。
 * 每一行都调它——「分档」不只是分类函数返回不同字符串，用户看到的那一句也必须真的不一样。
 */
const assertCopy = (key, expectedPattern) => {
  const zhText = zh[key]
  const enText = en[key]
  expectEqual(typeof zhText, 'string', `zh.${key} 必须存在`)
  expectEqual(typeof enText, 'string', `en.${key} 必须存在`)
  expectDeepEqual(placeholders(zhText), placeholders(enText), `${key} 的 zh/en 占位符必须一致`)
  if (expectedPattern !== undefined) {
    expectMatch(zhText, expectedPattern, `zh.${key} 文案`)
  }
  expectEqual(HAN.test(enText), false, `en.${key} 不得出现中文`)
  return zhText
}

const stubNative = (get) => {
  const native = { native: true, calls: [], get }
  globalThis.__native = native
  return native
}

const zipHead = (size = 4096) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4])
  return bytes
}

test('N2 失败档位矩阵：14 行（F-05-08）', async () => {
  const rows = [
    {
      name: '浏览器明说没网（navigator.onLine=false）→ offline，且优先于任何错误码',
      async run() {
        expectEqual(classifyImportFailure({ error: new TypeError('Failed to fetch'), online: false }), 'offline', '分档')
        expectEqual(classifyImportFailure({ status: 500, online: false }), 'offline', '在线读数优先于状态码')
        expectEqual(IMPORT_FAILURE_KEYS.offline, 'historyImportUrlOffline', '文案 key')
        assertCopy('historyImportUrlOffline', /网络已断开/)
      },
    },
    {
      name: 'CHROMIUM 原文 net::ERR_INTERNET_DISCONNECTED → offline',
      async run() {
        const error = new TypeError('Failed to fetch (net::ERR_INTERNET_DISCONNECTED)')
        expectEqual(classifyImportFailure({ error, online: true }), 'offline', '分档')
      },
    },
    {
      name: 'ECONNREFUSED → refused（链路通、对面没监听；文案指服务端，不许说「检查你的网络」）',
      async run() {
        expectEqual(
          classifyImportFailure({ error: new Error('java.net.ConnectException: Failed to connect to obs.example.test:443: ECONNREFUSED') }),
          'refused',
          '分档'
        )
        expectEqual(IMPORT_FAILURE_KEYS.refused, 'historyImportUrlRefused', '文案 key')
        const text = assertCopy('historyImportUrlRefused', /连接被拒绝/)
        expectMatch(text, /服务器/, '文案必须指向服务端')
        expectMatch(text, /未启动或被防火墙拦截/, '文案必须给出可自查的原因')
      },
    },
    {
      name: 'net::ERR_CONNECTION_REFUSED → refused',
      async run() {
        expectEqual(classifyImportFailure({ error: new TypeError('net::ERR_CONNECTION_REFUSED') }), 'refused', '分档')
      },
    },
    {
      name: 'DNS 解析不到（unknownhost / no address associated）→ unreachable（有网但够不到服务）',
      async run() {
        expectEqual(
          classifyImportFailure({ error: new Error('java.net.UnknownHostException: Unable to resolve host "obs.example.test"') }),
          'unreachable',
          '分档'
        )
        expectEqual(
          classifyImportFailure({ error: new Error('No address associated with hostname') }),
          'unreachable',
          '分档（另一种写法）'
        )
        expectEqual(IMPORT_FAILURE_KEYS.unreachable, 'historyImportUrlUnreachable', '文案 key')
        const text = assertCopy('historyImportUrlUnreachable', /无法连接导入服务/)
        // #18 的核心：有网但够不到服务，不能再劝用户去检查自己的网络
        expectEqual(/检查网络/.test(text), false, 'unreachable 文案不得说「检查网络」')
      },
    },
    {
      name: 'net::ERR_NAME_NOT_RESOLVED → unreachable（不是 offline）',
      async run() {
        expectEqual(
          classifyImportFailure({ error: new TypeError('Failed to fetch (net::ERR_NAME_NOT_RESOLVED)') }),
          'unreachable',
          '分档'
        )
      },
    },
    {
      name: '认不出的错误串 → null（退化成通用文案，绝不硬说成「断网」）#111 / #195',
      async run() {
        expectEqual(classifyImportFailure({ error: new Error('boom') }), null, '必须认不出来')
        expectEqual(classifyImportFailure({}), null, '没有信号时也必须返回 null')
        expectEqual(classifyImportFailure({ error: new DOMException('Aborted', 'AbortError') }), null, '取消不是失败')
        assertCopy('historyImportUrlNetwork', /下载失败/)
      },
    },
    {
      name: '服务端回了错误状态（>=400）→ server，文案带 HTTP {status}',
      async run() {
        expectEqual(classifyImportFailure({ status: 500 }), 'server', '5xx')
        expectEqual(classifyImportFailure({ status: 404 }), 'server', '4xx')
        expectEqual(IMPORT_FAILURE_KEYS.server, 'historyImportUrlHttp', '文案 key')
        const text = assertCopy('historyImportUrlHttp', /异常状态/)
        expectMatch(text, /\{status\}/, '文案必须带状态码占位符')
      },
    },
    {
      name: '超时两档：无已下载 → historyImportUrlTimeout；有已下载 → TimeoutPartial{percent}',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/timeout-nothing.zip'
        stubNative(() => Promise.reject(new Error('Read timed out')))
        const first = await runImport(link, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
        expectEqual(first?.key, 'historyImportUrlTimeout', '首块就超时')
        assertCopy('historyImportUrlTimeout', /下载超时/)

        // 有已下载：先给一块真字节，再让下一次请求超时
        resetEnv()
        const partialLink = 'https://obs.example.test/domain05/timeout-partial.zip'
        stubNative((options) => {
          const { from, to } = rangeOf(options)
          if (from === 0) {
            return Promise.resolve({
              status: 206,
              url: options.url,
              headers: { 'Content-Range': `bytes 0-${to}/65536` },
              data: zipHead(to - from + 1).buffer,
            })
          }
          return Promise.reject(new Error('Read timed out'))
        })
        const second = await runImport(partialLink, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
        expectEqual(second?.key, 'historyImportUrlTimeoutPartial', '有已下载的超时档')
        expectOk(typeof second.params.percent === 'number', '必须带上百分比')
        const text = assertCopy('historyImportUrlTimeoutPartial', /下载超时/)
        expectMatch(text, /已下载 \{percent\}%/, '文案要说明已下载多少')
        expectEqual(render(zh, first) === render(zh, second), false, '两档文案不能是同一句')
      },
    },
    {
      name: '下完但不是 ZIP → historyImportUrlNotZip（包坏了，不是网络问题）',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/not-zip.zip'
        const body = new Uint8Array(1024)
        body.fill(0x41)
        stubNative(() =>
          Promise.resolve({
            status: 200,
            url: link,
            headers: { 'Content-Length': String(body.length) },
            data: body.buffer,
          })
        )
        const error = await runImport(link, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
        expectEqual(error?.key, 'historyImportUrlNotZip', '终态')
        assertCopy('historyImportUrlNotZip', /不是有效的 ZIP/)
        expectEqual(globalThis.__imported.length, 0, '坏包不许进导入')
      },
    },
    {
      name: '断流（unexpected end of stream）→ historyImportUrlInterrupted{percent}',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/interrupted.zip'
        stubNative((options) => {
          const { from, to } = rangeOf(options)
          if (from === 0) {
            return Promise.resolve({
              status: 206,
              url: options.url,
              headers: { 'Content-Range': `bytes 0-${to}/8192` },
              data: zipHead(to - from + 1).buffer,
            })
          }
          return Promise.reject(new Error('unexpected end of stream on com.android.okhttp.Address@1be17ec1'))
        })
        const error = await runImport(link, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
        expectEqual(error?.key, 'historyImportUrlInterrupted', '终态')
        expectOk(typeof error.params.percent === 'number', '必须带上已下载百分比')
        const text = assertCopy('historyImportUrlInterrupted', /连接中断/)
        expectMatch(text, /已下载 \{percent\}%/, '文案要说明进度')
      },
    },
    {
      name: '403 三档：签名错误 / 链接过期 / 其他（OBS 错误码，文案三句不同）',
      async run() {
        const forbiddenXml = (code) =>
          base64(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>denied</Message></Error>`
          )
        const cases = [
          { code: 'SignatureDoesNotMatch', key: 'historyImportUrlBadSignature', pattern: /签名错误/ },
          { code: 'RequestTimeTooSkewed', key: 'historyImportUrlExpired', pattern: /链接已过期/ },
          { code: 'AccessDenied', key: 'historyImportUrlForbidden', pattern: /没有权限访问该链接/ },
        ]
        for (const item of cases) {
          resetEnv()
          const link = `https://obs.example.test/domain05/403-${item.code}.zip`
          stubNative(() =>
            Promise.resolve({ status: 403, url: link, headers: {}, data: forbiddenXml(item.code) })
          )
          const error = await runImport(link, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
          expectEqual(error?.key, item.key, `403 ${item.code} 的终态`)
          assertCopy(item.key, item.pattern)
          expectEqual(globalThis.__imported.length, 0, '403 不许进导入')
        }
        // 「过期」与「签名错误」必须是两句不同的人话：用户看到哪句决定了他下一步做什么
        expectEqual(
          render(zh, { key: 'historyImportUrlExpired' }) === render(zh, { key: 'historyImportUrlBadSignature' }),
          false,
          '两档文案不能相同'
        )
      },
    },
    {
      name: '服务层非原生平台拒绝 → historyImportUrlNativeOnly（不是只靠 UI 不给入口）',
      async run() {
        resetEnv()
        globalThis.__native = { native: false, calls: [] }
        const error = await runImport('https://obs.example.test/domain05/web.zip')
        expectEqual(error?.key, 'historyImportUrlNativeOnly', '服务层守卫')
        assertCopy('historyImportUrlNativeOnly', /网页版不支持链接导入/)
        expectEqual(globalThis.__native.calls.length, 0, '网页版不得发出任何原生请求')
      },
    },
    {
      name: '非法 URL → historyImportUrlInvalid（不发请求，且与下载失败分开记录）',
      async run() {
        resetEnv()
        const native = stubNative(() => Promise.resolve({ status: 200, url: '', headers: {}, data: null }))
        const error = await runImport('obs.example.test/whatever')
        expectEqual(error?.key, 'historyImportUrlInvalid', '终态')
        assertCopy('historyImportUrlInvalid', /请输入以/)
        expectEqual(native.calls.length, 0, '非法地址不得发请求')
        expectEqual(
          globalThis.__log.records.filter((entry) => entry.fields?.reason === 'invalid-url').length,
          1,
          '必须留一条可一眼认出的拒绝记录'
        )
      },
    },
  ]

  await runTable(rows, (row) => row.run())
})
