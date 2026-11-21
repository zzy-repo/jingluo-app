// [layer: unit | 依赖: 无（纯 Node，零浏览器零网络） | 耗时: <1s | Issue #651]
//
// `CONSUME_BASE_OVERRIDE`（web 层唯一的换地址通道）+ `-PconsumeBase` 交叉核对 的判据守卫。
//
// 病灶（#651，车道 A 在 #651 实测报出，形状同 #601）：
//   `-PconsumeBase` 只写 `BuildConfig.CONSUME_BASE`，**没有任何 Java/Kotlin 读它**；
//   真正发请求的是 web 层 `__ENDPOINTS__.consume.baseUrl`，那个值在 `pnpm build` 时就注进产物了。
//   于是「-PconsumeBase 出包」得到的是「看起来改了、实际仍打生产」的包 —— 比直接报错危险得多。
//
// 本文件锁三件事（每条都带负向对照，只跑正例等于没有对照，见 #369）：
//   O 组 `applyBaseOverrides`：覆盖生效 / 优先级高于配置 / pay 不受牵连 / 空值视为没传；
//   V 组 校验同源：非回环明文、废弃域黑名单、覆盖后与 pay 相同 → 一律抛（**不放宽**既有三条），
//        本机回环明文仍放行（既有例外也**不收紧**），并用一份「砍掉校验的可执行副本」证明断言不空；
//   G 组 drift 守卫：`android/app/build.gradle` 的交叉核对与 `rspack.config.ts` 的注入点必须还在，
//        且环境变量名与 `BASE_OVERRIDE_ENV` 是同一对（改单边直接红）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BASE_OVERRIDE_ENV,
  ENDPOINTS_LABEL,
  applyBaseOverrides,
  loadConsumePay,
  normalizeBaseForCompare,
} from '../../scripts/lib/consumeEndpoints.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** 仓库里那份真实配置（只读；不合法会在这里就抛，那是另一条门禁的事） */
const config = loadConsumePay()
const raw = JSON.parse(read(ENDPOINTS_LABEL))

/** 期望的抛错文案片段（判据必须点到「哪一条规则」被违反，而不是笼统的「不合法」） */
const expectThrows = (env, pattern) => {
  assert.throws(
    () => applyBaseOverrides(config, raw, env),
    (error) => {
      assert.match(String(error.message), pattern)
      return true
    }
  )
}

// ---------------------------------------------------------------------------
// O 组：覆盖语义（优先级 / 作用域 / 空值）
// ---------------------------------------------------------------------------
test('O1：不传环境变量 → 生效值就是配置值，overrides 为空（构建日志不会谎报 override）', () => {
  const result = applyBaseOverrides(config, raw, {})
  assert.equal(result.config.consume.baseUrl, config.consume.baseUrl)
  assert.equal(result.config.pay.baseUrl, config.pay.baseUrl)
  assert.deepEqual({ ...result.overrides }, {})
})

test('O2：CONSUME_BASE_OVERRIDE 优先于配置，且只改 consume（pay / 前缀 / 超时一律不动）', () => {
  const result = applyBaseOverrides(config, raw, { [BASE_OVERRIDE_ENV.consume]: 'https://example-staging.test' })
  assert.equal(result.config.consume.baseUrl, 'https://example-staging.test')
  assert.equal(result.overrides.consume, 'https://example-staging.test')
  assert.equal(result.config.pay.baseUrl, config.pay.baseUrl)
  assert.equal(result.overrides.pay, undefined)
  assert.equal(result.config.consume.apiV1Prefix, config.consume.apiV1Prefix)
  assert.equal(result.config.consume.gatewayPrefix, config.consume.gatewayPrefix)
  assert.deepEqual({ ...result.config.consume.timeoutMs }, { ...config.consume.timeoutMs })
})

test('O3：PAY_BASE_OVERRIDE 同法作用于支付侧，且不碰 consume', () => {
  const result = applyBaseOverrides(config, raw, { [BASE_OVERRIDE_ENV.pay]: 'https://pay-staging.test' })
  assert.equal(result.config.pay.baseUrl, 'https://pay-staging.test')
  assert.equal(result.config.consume.baseUrl, config.consume.baseUrl)
})

test('O4：空串 / 全空白等同于没传（否则 `X= cmd` 会把地址覆盖成空）', () => {
  for (const value of ['', '   ', '\t']) {
    const result = applyBaseOverrides(config, raw, { [BASE_OVERRIDE_ENV.consume]: value })
    assert.equal(result.config.consume.baseUrl, config.consume.baseUrl)
    assert.deepEqual({ ...result.overrides }, {})
  }
})

test('O5：首尾空白被去掉（复制粘贴带的空格不该进产物）', () => {
  const result = applyBaseOverrides(config, raw, { [BASE_OVERRIDE_ENV.consume]: '  https://example-staging.test \n' })
  assert.equal(result.config.consume.baseUrl, 'https://example-staging.test')
})

// ---------------------------------------------------------------------------
// V 组：校验与配置文件同源（三条既有判据一条都不许放宽）
// ---------------------------------------------------------------------------
test('V1：非回环明文 http → 抛（明文出网等于把 Key 交给中间人）', () => {
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'http://8.8.8.8' }, /必须是 https/)
})

test('V2：命中废弃域黑名单 → 抛（旧池域 IP / 旧池域端口都要拦住）', () => {
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'https://140.210.13.146:16000' }, /命中废弃域黑名单/)
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'https://sub2api.example.test:60013' }, /命中废弃域黑名单/)
})

test('V3：覆盖后与 pay 相同 → 抛（两个后端职责不能混）', () => {
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: config.pay.baseUrl }, /与 pay\.baseUrl 相同/)
  expectThrows(
    { [BASE_OVERRIDE_ENV.consume]: 'https://same.test', [BASE_OVERRIDE_ENV.pay]: 'https://same.test' },
    /与 pay\.baseUrl 相同/
  )
})

test('V4：路径 / 查询串 / 凭据 / 末尾斜杠 → 抛（base 只能是 scheme + host + 端口）', () => {
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'https://example-staging.test/api/v1' }, /不许带路径/)
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'https://example-staging.test?a=1' }, /不许带查询串/)
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'https://user:pass@example-staging.test' }, /不许带凭据/)
  expectThrows({ [BASE_OVERRIDE_ENV.consume]: 'https://example-staging.test/' }, /末尾不要带 \//)
})

test('V5：本机回环明文仍放行（本地联调实例是既有例外，覆盖通道不收紧它）', () => {
  const result = applyBaseOverrides(config, raw, { [BASE_OVERRIDE_ENV.consume]: 'http://127.0.0.1:18000' })
  assert.equal(result.config.consume.baseUrl, 'http://127.0.0.1:18000')
})

test('V6：负向对照 —— 砍掉校验的旧写法副本会**放行**上面那些非法值，说明 V1–V4 不是空断言', () => {
  // 旧写法的可执行副本：只 trim + 「有值就用」，没有任何判据（正是 #651 之前 `-PconsumeBase` 的行为）
  const legacyPick = (value) => ({ consume: { baseUrl: (value ?? '').trim() || config.consume.baseUrl } })
  for (const bad of ['http://8.8.8.8', 'https://140.210.13.146:16000', 'https://example-staging.test/api/v1']) {
    assert.equal(legacyPick(bad).consume.baseUrl, bad, '旧写法副本必须原样放行（否则本文件的负向对照失效）')
    assert.throws(() => applyBaseOverrides(config, raw, { [BASE_OVERRIDE_ENV.consume]: bad }), '真实现必须拒')
  }
})

test('V7：normalizeBaseForCompare 忽略末尾斜杠与大小写（gradle 侧同口径，避免「只差一个 / 」判成两台）', () => {
  assert.equal(normalizeBaseForCompare('https://A.Test/'), normalizeBaseForCompare('https://a.test'))
  assert.notEqual(normalizeBaseForCompare('https://a.test'), normalizeBaseForCompare('https://a.test:8443'))
})

// ---------------------------------------------------------------------------
// G 组：drift 守卫 —— 两侧（node 注入点 / gradle 交叉核对）必须同时存在且同名
// ---------------------------------------------------------------------------
test('G1：rspack 注入点用生效值，并把 endpoints 写进 build-info.json（gradle 的判据来源）', () => {
  const rspack = read('rspack.config.ts')
  assert.match(rspack, /applyBaseOverrides\(loadConsumePay\(ENDPOINTS_FILE\), endpoints\)/)
  assert.match(rspack, /baseUrl: effectiveConsumePay\.config\.consume\.baseUrl/)
  assert.match(rspack, /baseUrl: effectiveConsumePay\.config\.pay\.baseUrl/)
  // build-info.json 必须记 endpoints（否则 gradle 只能猜；删掉这段 = 交叉核对退化成永远「读不到」）
  assert.match(rspack, /endpoints: \{\s*\n\s*consume: \{ baseUrl: injectedEndpoints\.consume\.baseUrl \}/)
})

test('G2：build.mjs 的日志必须写出「谁提供了这个地址」，非法覆盖值必须中止构建', () => {
  const build = read('scripts/build.mjs')
  assert.match(build, /override by \$\{BASE_OVERRIDE_ENV\[section\]\}/)
  assert.match(build, /applyBaseOverrides\(config, raw\)/)
  assert.match(build, /die\(/)
})

test('G3：gradle 侧交叉核对在位，且环境变量名与 BASE_OVERRIDE_ENV 完全一致', () => {
  const gradle = read('android/app/build.gradle')
  assert.match(gradle, /assets\/public\/build-info\.json/, '必须读 cap sync 后的 web 产物自述')
  assert.match(gradle, /crossCheckNativeAgainstWebLayer\('consume', 'consumeBase'/)
  assert.match(gradle, /crossCheckNativeAgainstWebLayer\('pay', 'payBase'/)
  assert.match(gradle, /只影响原生侧 BuildConfig，不会改 web 层/, '报错必须说清「假通道」这件事')
  // 名字是两侧契约：gradle 里写死的那对必须等于 BASE_OVERRIDE_ENV（改单边直接在 L0 红）
  assert.match(gradle, new RegExp(`CONSUME_BASE_ENV_VAR = '${BASE_OVERRIDE_ENV.consume}'`))
  assert.match(gradle, new RegExp(`PAY_BASE_ENV_VAR = '${BASE_OVERRIDE_ENV.pay}'`))
})

test('G4：文档给的唯一正确路径就是 CONSUME_BASE_OVERRIDE + pnpm build + cap sync（不许再教 -P）', () => {
  const manual = read('docs/RELEASE-MANUAL.md')
  assert.match(manual, /### 换消费后端地址/)
  assert.match(manual, /CONSUME_BASE_OVERRIDE=<值> pnpm build:internal && npx cap sync android 之后再 assembleRelease/)

  // 判据是「**代码块里**不许出现 -PconsumeBase」：正文提它可以（要么在解释这条假通道为什么被拦，
  // 要么在报错文案里），但把它写成一条能直接敲的命令，就是在教人重演 #651。
  // 判据取「带 `=` 的形态」（`-PconsumeBase=<值>`）：那才是能照抄去跑的命令；
  // 引用报错原文里的 `-PconsumeBase 只影响原生侧…` 没有 `=`，属于解释，不算教人用。
  const fences = [...manual.matchAll(/```[\s\S]*?```/g)].map((match) => match[0])
  const offenders = fences
    .flatMap((block) => block.split(/\r?\n/))
    .filter((line) => /-P(consume|pay)Base\s*=/.test(line))
  assert.deepEqual(offenders, [], `文档代码块里出现了 -P 假通道用法：${offenders.join(' / ')}`)

  // 正文必须点名这件事（否则「不要用」这条知识没有落点）
  assert.ok(manual.includes('-PconsumeBase'), '§14 必须明确点名这条假通道')
})
