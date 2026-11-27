// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// 启动检查更新 + 强制更新（本单）：`checkUpdateGate()` 的三档判定、节流、快照时效、平台闸、fail-open。
//
// 为什么全在 L0：这一层是**纯判定** —— 「这次该不该拦人」用一次函数调用就能问清楚，
// 不需要真弹窗、真清单、真等待。真实清单用注入的假 `fetch` 桩（`deps.request`），
// 时间用注入的 `now`，存储用内存 Map。整份用例里没有一次真实网络请求。
//
// 负向对照（验收时会真的做一遍）：删掉 `evaluate` 里「`!ctx.android` → none」那两行 →
// `web-never-forced` 必红；删掉「快照 24 小时」那三行 → `snapshot-stale-no-forced` 必红；
// 把 `finally` 里 `writeLastCheckedAt` 挪进 try 的成功分支 → `throttle-*` 仍然绿、
// 但「失败后不重复打服务端」那一条会红（见 `fail-open-records-attempt`）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixtureUrl, installTsResolve, loadTsModule, setupDom } from '../helpers/dom-env.mjs'

/**
 * **本文件自己钉住 `@capacitor/core` 的替身**（不要退回裸 `installTsResolve()`）。
 *
 * 现象：单跑 14/14 绿，跑 `node tests/run-layer.mjs unit` 时整份文件 `<加载失败>`
 * （0 用例、14ms）：`The requested module '@capacitor/core' does not provide an export named
 * 'registerPlugin'`。根因是**进程级**的解析 hook + **共用替身**：run-layer 把多个文件合进同一个
 * 进程，同批的 `storage-save-tier-938.test.mjs`（经 `store-storage-env.mjs`）先把
 * `@capacitor/core` 换成了 `domain03-04/capacitor.mjs` 那份替身；本文件经
 * `updateGate.ts → appUpdate.ts` 要 `registerPlugin`，谁先装谁生效，于是读到的是别人装的替身。
 *
 * 修法（与 `math-blocks-821` 的 `resetCapabilityCache()` 同一类：把「这份结论属于哪个环境」钉回本文件）：
 * 在 top-level 显式装同一份替身，不再依赖「批内谁先跑」。被测对象仍是真 `updateGate.ts`；
 * `installed` / `isAndroid` / `request` / `storage` 全部由用例注入，替身只负责「被 import 时不炸」。
 * 没有放宽任何断言、没有 skip、没改判据。
 */
const installNativeBridgeStub = () =>
  installTsResolve({ stubs: [[/^@capacitor\/core$/, fixtureUrl('domain03-04/capacitor.mjs')]] })

installNativeBridgeStub()

/** 存储替身：只在内存里，用例之间互不影响（每个用例自己 new 一份） */
const memoryStorage = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    /** 用例直读用（不是 Storage 接口的一部分） */
    raw: map,
  }
}

/** 固定的「现在」：所有时间断言都用它，不靠真实时钟 */
const NOW = Date.parse('2026-11-24T10:00:00+08:00')
const HOUR = 60 * 60 * 1000

const {
  checkUpdateGate,
  UPDATE_GATE_LAST_CHECKED_KEY,
  UPDATE_GATE_THROTTLE_MS,
  UPDATE_GATE_SNAPSHOT_FORCED_MAX_AGE_MS,
} = await loadTsModule('src/services/updateGate.ts')
const { PRIMARY_RELEASE_BASE, MANIFEST_CACHE_KEY, MANIFEST_CACHE_VERSION } = await loadTsModule(
  'src/services/updateManifest.ts'
)

/** 本机：standard 变体、versionCode 33（与 package.json 的 androidVersionCode 同量级） */
const INSTALLED = { version: '1.4.14', versionCode: 33, variant: 'standard' }

/** 清单行：`parseManifest` 要求字段齐全（变体 + sha256 + buildType 才能被 `selectUpdate` 选中） */
const row = (extra = {}) => ({
  version: '1.5.0',
  versionCode: 34,
  size: 5 * 1024 * 1024,
  file: 'apk/jingluo-chat-1.5.0.apk',
  changes: ['优化体验'],
  buildType: 'stable',
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
  ...extra,
})

/** 一份合法清单的响应 */
const manifestResponse = (rows) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ latest: '1.5.0', releases: rows }),
})

/**
 * 假 fetch：默认回一份给定清单，`calls` 记下发了几次请求。
 * `behaviour` 可以换成 500 / 脏 JSON / 永不 settle（超时用例）。
 */
const fakeFetch = (rows, behaviour) => {
  const calls = []
  const request = async (url, options) => {
    calls.push({ url, options })
    if (behaviour === 'http-500') {
      return { ok: false, status: 500, text: async () => '' }
    }
    if (behaviour === 'bad-json') {
      return { ok: true, status: 200, text: async () => '<html>not json</html>' }
    }
    if (behaviour === 'hang') {
      // 永不 settle，只响应取消：用例靠 updateGate 的 AbortController 超时退出
      return await new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }
    return manifestResponse(rows)
  }
  request.calls = calls
  return request
}

/** 公共外壳：只关心「这一次判定结果是什么」，统一把三档收敛成 kind + 关键字段 */
const gate = async ({ rows = [], behaviour, now = NOW, ...deps } = {}) => {
  const storage = deps.storage ?? memoryStorage()
  const request = fakeFetch(rows, behaviour)
  const result = await checkUpdateGate({
    now,
    storage,
    request,
    installed: () => INSTALLED,
    isAndroid: () => true,
    channel: 'stable',
    ...deps,
  })
  return { result, storage, request }
}

// ---------------------------------------------------------------- 1) 三档判定

test('below-minimum: minSupportedVersionCode 高于本机 → forced', async () => {
  const { result, storage } = await gate({
    rows: [row({ updatePolicy: { mode: 'normal', minSupportedVersionCode: 9999 } })],
  })
  assert.equal(result.kind, 'forced')
  assert.equal(result.policy.basis, 'below-minimum')
  assert.equal(result.release.versionCode, 34)
  // 成功查过就记一次时间戳（下一次启动 6 小时内不再请求）
  assert.equal(storage.getItem(UPDATE_GATE_LAST_CHECKED_KEY), String(NOW))
})

test('soft: mode:"soft" 且未 snooze → soft（snooze 期内则 none）', async () => {
  const rows = [row({ updatePolicy: { mode: 'soft', snoozeHours: 12 } })]
  const shown = await gate({ rows })
  assert.equal(shown.result.kind, 'soft')
  assert.equal(shown.result.policy.mode, 'soft')

  const snoozed = await gate({ rows, snoozedUntil: NOW + 2 * HOUR })
  assert.equal(snoozed.result.kind, 'none', 'snooze 期内不该再弹')

  const expired = await gate({ rows, snoozedUntil: NOW - 1 })
  assert.equal(expired.result.kind, 'soft', 'snooze 到期后照旧弹')
})

test('normal: mode:"normal" → none', async () => {
  const { result } = await gate({ rows: [row({ updatePolicy: { mode: 'normal' } })] })
  assert.equal(result.kind, 'none')
})

test('no-policy: 清单没下发 updatePolicy（线上真实现状）→ none', async () => {
  const { result } = await gate({ rows: [row()] })
  assert.equal(result.kind, 'none')
})

test('up-to-date: 清单里没有更高版本 → none（且不发第二次请求）', async () => {
  const { result, request } = await gate({ rows: [row({ versionCode: 33 })] })
  assert.equal(result.kind, 'none')
  assert.equal(request.calls.length, 1)
})

// ---------------------------------------------------------------- 2) fail-open

test('fail-open: 500 / 脏 JSON / 超时 一律 none，且不抛', async () => {
  for (const behaviour of ['http-500', 'bad-json']) {
    const { result } = await gate({
      rows: [row({ updatePolicy: { mode: 'forced' } })],
      behaviour,
    })
    assert.equal(result.kind, 'none', `${behaviour} 必须 fail-open`)
  }

  const startedAt = Date.now()
  const { result } = await gate({
    rows: [row({ updatePolicy: { mode: 'forced' } })],
    behaviour: 'hang',
    timeoutMs: 30,
  })
  assert.equal(result.kind, 'none', '超时必须 fail-open')
  assert.ok(Date.now() - startedAt < 2000, '超时靠 AbortController 收口，不能一直挂着')
})

test('fail-open: 版本号非法（构建期没注入）→ none，一次请求都不发', async () => {
  const { result, request } = await gate({
    rows: [row({ updatePolicy: { mode: 'forced' } })],
    installed: () => ({ version: '', versionCode: 0, variant: 'standard' }),
  })
  assert.equal(result.kind, 'none')
  assert.equal(request.calls.length, 0)
})

test('fail-open-records-attempt: 失败也记「查过了」，避免每次开 App 都打一轮服务端', async () => {
  const storage = memoryStorage()
  await gate({ behaviour: 'http-500', storage })
  assert.equal(storage.getItem(UPDATE_GATE_LAST_CHECKED_KEY), String(NOW))

  // 第二条：仍在 6 小时内 → 直接跳过请求
  const second = await gate({ behaviour: 'http-500', storage, now: NOW + HOUR })
  assert.equal(second.request.calls.length, 0)
})

// ---------------------------------------------------------------- 3) 节流

test('throttle: 6 小时内查过 → 不发请求', async () => {
  const storage = memoryStorage()
  storage.setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(NOW - HOUR))
  const { result, request } = await gate({
    rows: [row({ updatePolicy: { mode: 'soft' } })],
    storage,
  })
  assert.equal(result.kind, 'none', '没有快照可用时，节流命中就是 none')
  assert.equal(request.calls.length, 0, '节流命中不许发请求')
})

test('throttle: 超过 6 小时就重新查（force 参数也能跳过节流）', async () => {
  const storage = memoryStorage()
  storage.setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(NOW - UPDATE_GATE_THROTTLE_MS - HOUR))
  const { request } = await gate({ rows: [row({ updatePolicy: { mode: 'soft' } })], storage })
  assert.equal(request.calls.length, 1)

  const forced = memoryStorage()
  forced.setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(NOW - HOUR))
  const again = await gate({
    rows: [row({ updatePolicy: { mode: 'soft' } })],
    storage: forced,
    force: true,
  })
  assert.equal(again.request.calls.length, 1, '?update-check 等价物必须无视节流')
  assert.equal(again.result.kind, 'soft')
})

// ---------------------------------------------------------------- 4) 快照时效

/** 往存储里塞一份「上次成功拉到的清单」快照（结构与 `saveManifestSnapshot` 一致） */
const putSnapshot = (storage, savedAt, rows) =>
  storage.setItem(
    MANIFEST_CACHE_KEY,
    JSON.stringify({ version: MANIFEST_CACHE_VERSION, savedAt, base: PRIMARY_RELEASE_BASE, rows })
  )

test('snapshot-fresh: 节流命中也用新鲜快照判 forced（强制更新不该被节流吞掉）', async () => {
  const storage = memoryStorage()
  storage.setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(NOW - HOUR))
  putSnapshot(storage, NOW - HOUR, [row({ updatePolicy: { mode: 'forced' } })])
  const { result, request } = await gate({ storage })
  assert.equal(request.calls.length, 0)
  assert.equal(result.kind, 'forced')
})

test('snapshot-stale-no-forced: 快照超过 24 小时不判 forced，但 soft 仍然照常展示', async () => {
  const stale = NOW - UPDATE_GATE_SNAPSHOT_FORCED_MAX_AGE_MS - HOUR
  const forcedStorage = memoryStorage()
  forcedStorage.setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(NOW - HOUR))
  putSnapshot(forcedStorage, stale, [row({ updatePolicy: { mode: 'forced' } })])
  const forced = await gate({ storage: forcedStorage })
  assert.equal(forced.result.kind, 'none', '陈旧策略不许拦人')

  const softStorage = memoryStorage()
  softStorage.setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(NOW - HOUR))
  putSnapshot(softStorage, stale, [row({ updatePolicy: { mode: 'soft' } })])
  const soft = await gate({ storage: softStorage })
  assert.equal(soft.result.kind, 'soft', '快照仍可用于「有新版」这类可关闭的提示')
})

// ---------------------------------------------------------------- 5) 平台闸

test('web-never-forced: 网页（isAndroidUpdate() 为假）永不 forced', async () => {
  const rows = [row({ updatePolicy: { minSupportedVersionCode: 9999 } })]
  const android = await gate({ rows })
  assert.equal(android.result.kind, 'forced')

  const web = await gate({ rows, isAndroid: () => false })
  assert.equal(web.result.kind, 'none', '网页刷新即最新，没有安装概念，不许锁人')

  // 反过来：web 下 soft 仍然可以展示（可关闭的那一档与平台无关）
  const webSoft = await gate({ rows: [row({ updatePolicy: { mode: 'soft' } })], isAndroid: () => false })
  assert.equal(webSoft.result.kind, 'soft')
})

// ---------------------------------------------------------------- 6) 不碰真实存储

test('默认存储：不传 storage 时读 localStorage（setupDom 的替身），脏值一律当作没查过', async () => {
  const dom = setupDom()
  try {
    dom.localStorage.setItem(UPDATE_GATE_LAST_CHECKED_KEY, 'not-a-number')
    const request = fakeFetch([row({ updatePolicy: { mode: 'soft' } })])
    const result = await checkUpdateGate({
      now: NOW,
      request,
      installed: () => INSTALLED,
      isAndroid: () => true,
      channel: 'stable',
    })
    assert.equal(request.calls.length, 1, '脏时间戳不许把「该查一次」挡掉')
    assert.equal(result.kind, 'soft')
  } finally {
    dom.restore()
  }
})
