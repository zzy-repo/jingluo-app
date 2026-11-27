// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #909（3/5 满盘保护）：保存前读 freeBytes，低于阈值就把保存横幅升到「存储空间不足，新内容可能无法保存」档；
// freeBytes 读不到不得当成「空间足够」；现有三档（retry / quota / unavailable）口径不变。
//
//   [L1] 阈值边界：阈值 - 1 → low；恰好阈值 → ok
//   [L2] freeBytes 为 undefined / 抛错 / 非法值 → unknown（不是 ok），抛错记诊断，不抛出
//   [L3] 10s 缓存：窗口内不再跨桥，窗口后重读
//   [L4] 非 native（fs.supported=false）：freeBytes 为 undefined → unknown
//   [B1] 横幅选档：lowSpace 只在没有任何真实失败时出现；有 quota/unavailable/retry 失败时原档位不变
//   [B2] lowSpace 档不给重试按钮、文案 zh/en 成对存在
//
// 负向对照：把 `free < minBytes` 改成 `free <= minBytes` → L1 变红；把 unknown 分支改成返回 ok → L2/L4 变红。
//
//   node tests/run-layer.mjs unit --only protection-freespace-909
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from '../helpers/dom-env.mjs'
import { loadProtection, records, resetRecords, setupProtection } from '../helpers/protection-env.mjs'

const P = await loadProtection()
const { createFreeSpace, resetProtectionDiagnosticsForTests, FREE_SPACE_MIN_BYTES, FREE_SPACE_CACHE_MS } = P
const db = await loadTsModule('src/services/chat/db.ts')
const { zh } = await loadTsModule('src/i18n/zh.ts')
const { en } = await loadTsModule('src/i18n/en.ts')

const make = (freeBytes) => {
  resetProtectionDiagnosticsForTests()
  resetRecords()
  const env = setupProtection(P, { freeBytes })
  return { ...env, space: createFreeSpace({ fs: env.fs, storage: env.protection, now: () => env.now.value, local: undefined }) }
}

test('L1 阈值边界：默认 64MiB；阈值-1 → low，恰好阈值 → ok', async () => {
  assert.equal(FREE_SPACE_MIN_BYTES, 64 * 1024 * 1024)
  assert.deepEqual(await make(FREE_SPACE_MIN_BYTES - 1).space.check(), { status: 'low', freeBytes: FREE_SPACE_MIN_BYTES - 1 })
  assert.deepEqual(await make(FREE_SPACE_MIN_BYTES).space.check(), { status: 'ok', freeBytes: FREE_SPACE_MIN_BYTES })
  assert.equal((await make(0).space.check()).status, 'low')
})

test('L2 读不到 / 抛错 / 非法值 → unknown，不是 ok；抛错记诊断且不抛出', async () => {
  assert.deepEqual(await make(null).space.check(), { status: 'unknown' }, 'freeBytes 不支持：unknown')
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal((await make(bad).space.check()).status, 'unknown', `非法值 ${bad} 不得当成足够`)
  }
  const env = make(10)
  env.fs.freeBytes = async () => {
    throw new P.FsError('unavailable', 'injected')
  }
  assert.deepEqual(await env.space.check(), { status: 'unknown' })
  assert.ok(records().some((entry) => entry.message === 'protection.free-space failed'))
})

test('L3 10s 缓存：窗口内不再读，窗口后重读', async () => {
  const env = make(FREE_SPACE_MIN_BYTES * 2)
  let calls = 0
  const read = env.fs.freeBytes
  env.fs.freeBytes = async () => {
    calls += 1
    return read()
  }
  await env.space.check()
  env.now.value += FREE_SPACE_CACHE_MS - 1
  await env.space.check()
  assert.equal(calls, 1)
  env.now.value += 1
  await env.space.check()
  assert.equal(calls, 2)
})

test('L4 非 native：unknown（Web 没有私有目录，不能说「足够」）', async () => {
  resetProtectionDiagnosticsForTests()
  const { createUnsupportedFs } = await loadTsModule('src/services/fs/unsupportedFs.ts')
  const space = createFreeSpace({ fs: createUnsupportedFs(), storage: undefined, now: () => 0, local: undefined })
  assert.deepEqual(await space.check(), { status: 'unknown' })
})

test('B1 横幅选档：lowSpace 只在没有真实失败时出现；三档原函数一字未变', () => {
  assert.equal(db.selectSaveBannerDisplay({}, true), 'lowSpace')
  assert.equal(db.selectSaveBannerDisplay(null, true), 'lowSpace')
  assert.equal(db.selectSaveBannerDisplay({}, false), null)
  for (const [kind, tier] of [['quota', 'quota'], ['unavailable', 'unavailable'], ['unknown', 'retry']]) {
    assert.equal(db.selectSaveBannerDisplay({ a: { kind } }, true), tier, `${kind} 失败优先于空间预警`)
    assert.equal(db.selectSaveBannerTier({ a: { kind } }), tier, `${kind} 旧选档口径不变`)
  }
  assert.equal(db.selectSaveBannerTier({}), null, '三档函数不认识 lowSpace')
  assert.deepEqual({ ...db.SAVE_BANNER_MESSAGE }, {
    retry: 'sessionSaveFailedRetryable',
    quota: 'sessionSaveFailedQuota',
    unavailable: 'sessionSaveFailedUnavailable',
  })
})

test('B2 lowSpace 档不给重试，文案 zh/en 成对且 zh 点明「新内容可能无法保存」', () => {
  assert.equal(db.bannerRetryable('lowSpace'), false)
  assert.equal(db.bannerRetryable('quota'), true)
  assert.equal(db.bannerRetryable('unavailable'), false)
  const key = db.bannerMessageKey('lowSpace')
  assert.equal(key, 'sessionSaveLowSpace')
  assert.equal(db.bannerMessageKey('quota'), 'sessionSaveFailedQuota')
  assert.match(zh[key], /存储空间不足，新内容可能无法保存/u)
  assert.ok(en[key].length > 0)
})
