// [layer: unit | 依赖: 无（纯 Node：假 transport + 注入全局，零网络） | 耗时: <0.5s]
//
// 明文联调包的 **三层一致** 接缝（Issue #601 守卫的补正面 / #651 的发版铁律）。
//
// 为什么这个文件必须存在：只放行一层会做出比「构建失败」坏得多的产物。
//   · 只放行 ① 构建期（gradle）→ 包打得出来，但 web 层仍然拒明文；
//   · 只放行 ①+② 构建期 → **装上了、一开就白屏**：`src/main.tsx` 在模块级就调 `getConsumeClient()`
//     → `readConsumeEndpoints()` 抛 `ConsumeConfigError` → 整个 bundle 没跑起来。
//     这正是 #601 的形状（"发出去的包不能用"），所以运行时那一层是**必须**的，不是优化。
//
// 三层与各自的载体：
//   ① 原生构建期  android/app/build.gradle       -PallowInsecureConsume=true      → APK 标记 INSECURE_CONSUME
//   ② web 构建期  scripts/lib/consumeEndpoints   ALLOW_INSECURE_CONSUME=true      → __ENDPOINTS__.insecureConsume
//   ③ 运行时      src/services/consume/http.ts   读 ②注入的标记（产物自证）        → 肯不肯接受明文 base
//
// 断言口径：每一层都要有「默认拒绝」与「显式放行」两侧；只看一侧的门禁等于没有门禁（#95 的教训）。
//
//   node --test tests/unit/insecure-consume-seam.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT, installResolveHooks, readJson } from '../helpers/contract.mjs'

installResolveHooks()

// `src/services/consumeClient.ts` 会经 apiConfig.ts 在**模块级**读 `__API_ORIGIN__` / `__INTERNAL_BUILD__`
// （那两条是「按用例取值」的构建期常量，不在预加载里给默认值）。本文件要验的是冷启动链路，
// 所以这里**显式**给出中性值，而不是把整条链路 mock 掉 —— mock 掉就证明不了「真链路会不会抛」。
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false

const {
  ALLOW_INSECURE_ENV,
  allowInsecureFromEnv,
  parseAllowInsecure,
  validateConsumePay,
} = await import('../../scripts/lib/consumeEndpoints.mjs')
const { ConsumeConfigError, createConsumeHttp, readConsumeEndpoints } = await import('../../src/services/consume/http.ts')
const { getConsumeClient, setConsumeClient } = await import('../../src/services/consumeClient.ts')

const CONFIG = readJson('config/endpoints.json')
/** staging 明文地址（与 #651 的发版铁律同形：非回环 + 明文 + 命中废弃域黑名单） */
const STAGING_HTTP = 'http://140.210.13.146:16000'
const PROD_HTTPS = CONFIG.consume.baseUrl

/** 造一份注入端点（形状与 `__ENDPOINTS__.consume` 一致） */
const consumeOf = (baseUrl) => ({
  baseUrl,
  apiV1Prefix: CONFIG.consume.apiV1Prefix,
  gatewayPrefix: CONFIG.consume.gatewayPrefix,
  timeoutMs: CONFIG.consume.timeoutMs,
})

/** 在给定全局注入下跑一段代码，结束时还原（并清掉共享单例，避免用例间串味） */
const withGlobals = (injected, run) => {
  const saved = globalThis.__ENDPOINTS__
  try {
    globalThis.__ENDPOINTS__ = injected
    setConsumeClient(null)
    return run()
  } finally {
    globalThis.__ENDPOINTS__ = saved
    setConsumeClient(null)
  }
}

const errorOf = (fn) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

// ─────────────────────────── ③ 运行时：产物标记决定肯不肯接受明文 ───────────────────────────

test('R1 运行时：没有 insecureConsume 标记时，明文 base 抛 ConsumeConfigError（默认口径不变）', () => {
  const thrown = withGlobals(
    { ...globalThis.__ENDPOINTS__, insecureConsume: false, consume: consumeOf(STAGING_HTTP) },
    () => errorOf(() => readConsumeEndpoints()),
  )
  assert.ok(thrown, '默认必须拒绝非回环明文（#484 §6.3）')
  assert.equal(thrown.name, 'ConsumeConfigError')
  assert.ok(thrown instanceof ConsumeConfigError)
  assert.ok(thrown.missing.includes('consume.baseUrl'), '报错要点名是哪个键')
})

test('R1b 运行时：标记字段缺失（老产物 / 未注入）同样按 false 处理（fail-closed，不默认放行）', () => {
  const injected = { ...globalThis.__ENDPOINTS__ }
  delete injected.insecureConsume
  const thrown = withGlobals({ ...injected, consume: consumeOf(STAGING_HTTP) }, () => errorOf(() => readConsumeEndpoints()))
  assert.ok(thrown, '没有这个字段 = 这是老产物 = 不许明文')
  assert.equal(thrown.name, 'ConsumeConfigError')
})

test('R2 运行时：insecureConsume=true 时明文 base 被接受，且 URL 真的按它拼', async () => {
  const endpoints = withGlobals(
    { ...globalThis.__ENDPOINTS__, insecureConsume: true, consume: consumeOf(STAGING_HTTP) },
    () => readConsumeEndpoints(),
  )
  assert.equal(endpoints.baseUrl, STAGING_HTTP)

  const calls = []
  const http = createConsumeHttp({
    endpoints,
    transport: async (req) => {
      calls.push(req)
      return { kind: 'response', status: 200, text: '{"data":null}', headers: { 'content-type': 'application/json' } }
    },
  })
  await http.request({ method: 'GET', path: `${CONFIG.consume.apiV1Prefix}/user/profile` })
  assert.equal(calls[0].url, `${STAGING_HTTP}${CONFIG.consume.apiV1Prefix}/user/profile`, '请求必须发到明文 staging 地址')
})

test('R3 冷启动链路：src/main.tsx 模块级调用的 getConsumeClient() 只在有标记时不抛（否则就是白屏）', () => {
  // 这条是「三层真的联动」的负向对照：只放行构建期 → 这里会抛 → 整个 bundle 起不来 = 白屏。
  const withoutMarker = withGlobals(
    { ...globalThis.__ENDPOINTS__, insecureConsume: false, consume: consumeOf(STAGING_HTTP) },
    () => errorOf(() => getConsumeClient()),
  )
  assert.ok(withoutMarker, '只放行构建期、不放行运行时 → 冷启动必抛 ConsumeConfigError（= 白屏，#601 形状）')
  assert.equal(withoutMarker.name, 'ConsumeConfigError')

  const withMarker = withGlobals(
    { ...globalThis.__ENDPOINTS__, insecureConsume: true, consume: consumeOf(STAGING_HTTP) },
    () => errorOf(() => getConsumeClient()),
  )
  assert.equal(withMarker, null, '有标记时冷启动不许抛（否则包是「装上了但一开就白屏」）')
})

test('R4 运行时：https 生产地址与回环地址的旧口径不变（没被这次改动放宽）', () => {
  const cases = [
    { base: PROD_HTTPS, marker: false },
    { base: 'http://127.0.0.1:18000', marker: false },
    { base: 'http://localhost:18000', marker: false },
  ]
  for (const item of cases) {
    const endpoints = withGlobals(
      { ...globalThis.__ENDPOINTS__, insecureConsume: item.marker, consume: consumeOf(item.base) },
      () => readConsumeEndpoints(),
    )
    assert.equal(endpoints.baseUrl, item.base, `${item.base} 在标记 ${item.marker} 时应被接受`)
  }
})

// ─────────────────────────── ② web 构建期：ALLOW_INSECURE_CONSUME ───────────────────────────

test('B1 构建期脚本：默认拒绝非回环明文，且拒绝文案给出确切解法（env 名 + gradle flag）', () => {
  const raw = { ...CONFIG, consume: { ...CONFIG.consume, baseUrl: STAGING_HTTP } }
  const problems = validateConsumePay(raw, '')
  assert.ok(problems.some((line) => /必须是 https/.test(line)), '默认必须拒绝非回环明文')
  assert.ok(problems.some((line) => /废弃域黑名单/.test(line)), 'staging 机命中旧池域黑名单，默认也要拒')
  assert.ok(
    problems.some((line) => line.includes(ALLOW_INSECURE_ENV) && line.includes('-PallowInsecureConsume=true')),
    '拒绝文案必须同时给出 web 侧 env 与原生侧 -P 两个入口（只给一个就会做出半套包）',
  )
})

test('B2 构建期脚本：allowInsecure 时明文 + 黑名单两条都放行，但**必须留痕**（onNotice）', () => {
  const raw = { ...CONFIG, consume: { ...CONFIG.consume, baseUrl: STAGING_HTTP } }
  const notices = []
  const problems = validateConsumePay(raw, '', { allowInsecure: true, onNotice: (msg) => notices.push(msg) })
  assert.deepEqual(problems, [], `显式放行后不该再有硬错误：${problems.join(' | ')}`)
  assert.equal(notices.length, 2, '明文一条 + 黑名单豁免一条，都要打出来（不许静默放宽）')
  assert.ok(notices.some((msg) => msg.includes(ALLOW_INSECURE_ENV)), '放行日志里要点名是哪个开关放的行')
})

test('B3 构建期脚本：放行只覆盖「明文 + 旧池域」两条 —— 形态判据与 consume≠pay 一条不放宽', () => {
  const withPath = { ...CONFIG, consume: { ...CONFIG.consume, baseUrl: `${STAGING_HTTP}/api/v1` } }
  assert.ok(
    validateConsumePay(withPath, '', { allowInsecure: true }).some((line) => /不许带路径/.test(line)),
    '带路径仍然要拒（放行不等于不校验形状）',
  )
  const sameAsPay = { ...CONFIG, consume: { ...CONFIG.consume, baseUrl: CONFIG.pay.baseUrl } }
  assert.ok(
    validateConsumePay(sameAsPay, '', { allowInsecure: true }).some((line) => /相同/.test(line)),
    'consume 与 pay 相同仍然要拒',
  )
})

test('B4 构建期脚本：环境变量只认字面 true（yes / 1 / false 一律报错，不许猜）', () => {
  assert.deepEqual(parseAllowInsecure(undefined), { allowInsecure: false, error: null })
  assert.deepEqual(parseAllowInsecure(''), { allowInsecure: false, error: null })
  assert.deepEqual(parseAllowInsecure('true'), { allowInsecure: true, error: null })
  // 注意 `'true '`（带尾空格）**不**在拒绝名单里：首尾空白会被 trim 掉，与 gradle 的
  // `orNull()?.trim()` 同口径；这里只拒绝「拼写/语义不同」的取值。
  for (const bad of ['yes', '1', 'TRUE', 'false', 'no']) {
    const parsed = parseAllowInsecure(bad)
    assert.equal(parsed.allowInsecure, false, `${JSON.stringify(bad)} 不许被当成 true`)
    assert.match(String(parsed.error), /只接受字面 true/, `${JSON.stringify(bad)} 必须报错（逃生舱不能靠拼写猜）`)
  }
  assert.equal(allowInsecureFromEnv({ [ALLOW_INSECURE_ENV]: 'true' }).allowInsecure, true)
  assert.equal(allowInsecureFromEnv({}).allowInsecure, false)
})

// ─────────────────────────── ① + 接缝：三处落点必须同源 ───────────────────────────

test('S1 接缝：三层的载体都在（gradle flag+标记 / rspack 注入 / env.d.ts 声明 / 运行时读取）', () => {
  const gradle = readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8')
  const rspack = readFileSync(path.join(ROOT, 'rspack.config.ts'), 'utf8')
  const envDts = readFileSync(path.join(ROOT, 'src/env.d.ts'), 'utf8')
  const http = readFileSync(path.join(ROOT, 'src/services/consume/http.ts'), 'utf8')

  // ① 原生构建期
  assert.match(gradle, /def ALLOW_INSECURE_PROP = 'allowInsecureConsume'/)
  assert.match(gradle, /buildConfigField "boolean", "INSECURE_CONSUME"/)
  assert.match(gradle, /insecureBases\['migration\.baseUrl'\]/, 'migration.baseUrl 也要算进「明文 base」')
  assert.match(gradle, /已按 -P\$\{ALLOW_INSECURE_PROP\}=true 显式豁免/, '废弃域黑名单必须能按 flag 豁免（否则 staging 机永远构建不出来）')

  // ② web 构建期：同一个 env 名，注入产物
  assert.match(rspack, /insecureConsume,/, 'rspack 必须把 insecureConsume 注入 __ENDPOINTS__')
  assert.match(rspack, /allowInsecureFromEnv\(\)/, 'rspack 用的必须是 consumeEndpoints 的同一个解析函数（不许各写一套）')

  // ③ 运行时：读产物里的标记
  assert.match(envDts, /readonly insecureConsume: boolean/, '__ENDPOINTS__ 的类型里要有这个字段')
  assert.match(http, /insecureConsume === true/, '运行时判据必须是产物标记（运行时读不到 -P / env）')
})
