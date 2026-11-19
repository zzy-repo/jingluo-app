// [layer: unit | 纯 Node（假原生桥），零浏览器零网络 | 耗时: <1s]
//
// C7 —— 下载终态判定（Issue #407 / 防 #373）
//
// 历史事故 #373：下载 / 校验失败或用户取消之后，进度条**没有清空**，终态渲染成
// 「5.2 MB / 5.2 MB 满格 + 确认下载」—— 用户按「满格 = 下好了」理解，实际一次都没下成。
// 根因是一句「看起来无害」的推导：`received === total` → 「可以安装了」。
// 原生侧也有同款（`AppUpdatePlugin.java` 在 `received == size` 就发 100%，`:213` 才 verify()），
// 所以这一帧在真机上必然出现：**先看到满格、再收到失败**。
//
// 本契约锁两条语义：
//   D1 `received === total` **永不**推导「可安装」。可安装的唯一来源是显式状态：
//      `downloadUpdate()` 真的 resolve 了（校验通过），界面才 `setReady(true)`。
//   D2 失败 / 取消之后不许留下「满格」的终态：进度必须被清空，且进度事件不许跨下载串台
//      （另一个下载 id 的迟到事件不许改这一条的界面）。
//
// 行为面用假桥断言（不碰原生、不联网）；「可安装」只有一处入口这件事在源码层再钉一次，
// 因为它是 #373 唯一能复发的入口（把判断挪回进度分支即可）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, readText, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { downloadUpdate } = await import('../../src/services/appUpdate.ts')
const { PRIMARY_RELEASE_BASE } = await import('../../src/services/updateManifest.ts')

const RELEASE = {
  version: '1.4.1',
  versionCode: 20,
  size: 4_000,
  file: 'apk/deepseek-chat-1.4.1.apk',
  changes: ['x'],
  buildType: 'stable',
  artifactVariant: 'internal',
  sha256: 'a'.repeat(64),
}

/**
 * 假原生桥：`script` 决定 `download()` 的两个动作 ——
 * 先按 `events` 发进度事件（含「满格」那一帧），再把 `outcome` 交给调用方。
 */
const fakeBridge = (events, outcome) => {
  const state = { listeners: [], downloadCalls: 0 }
  return {
    state,
    addListener: async (_name, listener) => {
      state.listeners.push(listener)
      return { remove: async () => {} }
    },
    download: async ({ id }) => {
      state.downloadCalls++
      for (const event of events) for (const listener of [...state.listeners]) listener({ id, ...event })
      if (outcome.error) throw outcome.error
      return { cached: outcome.cached ?? false }
    },
    cancel: async () => {},
  }
}

/** 一行 = 一次下载的终态结论（所有行都先喂满格那一帧，专门试它会不会被当成「可安装」） */
const ROWS = [
  {
    id: 'D1-a',
    what: '满格进度 + 校验失败 → downloadUpdate 必须 reject（满格绝不等于可安装）',
    expect: 'reject',
  },
  {
    id: 'D1-b',
    what: '满格进度 + 桥 resolve → 这才是唯一「可安装」的来源（成功路径必须还能成功）',
    expect: 'resolve',
  },
]

test('C7 满格进度不推导可安装：终态只由桥的显式结论决定（防 #373）', tableTest('C7', ROWS, async (row) => {
  const seen = []
  const bridge = fakeBridge([{ received: RELEASE.size, total: RELEASE.size }], {
    error: row.expect === 'reject' ? new Error('SIGNATURE_MISMATCH') : undefined,
  })
  const run = downloadUpdate(RELEASE, new AbortController().signal, (event) => seen.push(event), bridge, PRIMARY_RELEASE_BASE)
  if (row.expect === 'reject') {
    await assert.rejects(run, /SIGNATURE_MISMATCH/, '校验失败却 resolve 了 = 界面会显示「可安装」')
  } else {
    await run
  }
  // 满格那一帧确实到达过界面（否则本用例没测到真正的风险点）
  assert.equal(seen.at(-1).received, seen.at(-1).total, '用例没喂到「满格」帧，断言无效')
}))

test('C7 取消 / 缺校验和 / 串台事件：都不许产生「可安装」信号（防 #373）', async () => {
  // 取消：下载中途 abort → reject AbortError，且取消之后桥的迟到「满格」事件不再往界面写
  const controller = new AbortController()
  const seen = []
  let lateListener
  const cancellingBridge = {
    addListener: async (_name, listener) => {
      lateListener = listener
      return { remove: async () => {} }
    },
    download: async ({ id }) => {
      controller.abort()
      lateListener({ id, received: RELEASE.size, total: RELEASE.size })
      return { cached: false }
    },
    cancel: async () => {},
  }
  await assert.rejects(
    downloadUpdate(RELEASE, controller.signal, (event) => seen.push(event), cancellingBridge, PRIMARY_RELEASE_BASE),
    (error) => error.name === 'AbortError'
  )
  assert.deepEqual(seen, [], '取消之后不许可再写一次进度（否则终态又是「满格/部分」）')

  // 缺校验和 / 缺变体的条目：连下载都不许发起（否则装上去的东西没人验过）
  for (const field of ['sha256', 'artifactVariant']) {
    let downloaded = false
    const noBridge = {
      addListener: async () => ({ remove: async () => {} }),
      download: async () => {
        downloaded = true
        return { cached: false }
      },
      cancel: async () => {},
    }
    await assert.rejects(
      downloadUpdate({ ...RELEASE, [field]: undefined }, new AbortController().signal, () => {}, noBridge),
      /INCOMPLETE_RELEASE/
    )
    assert.equal(downloaded, false, `缺 ${field} 却发起了下载`)
  }

  // 串台：另一个下载 id 的迟到事件不许更新这一条的界面
  const otherId = []
  const staleListeners = []
  const staleBridge = {
    addListener: async (_name, listener) => {
      staleListeners.push(listener)
      return { remove: async () => {} }
    },
    download: async ({ id }) => {
      const [listener] = staleListeners
      listener({ id: 'another-download', received: 4_000, total: 4_000 })
      listener({ id, received: 1, total: 4_000 })
      return { cached: false }
    },
    cancel: async () => {},
  }
  await downloadUpdate(RELEASE, new AbortController().signal, (event) => otherId.push(event), staleBridge)
  assert.deepEqual(
    otherId.map((event) => event.received),
    [1],
    '别的下载 id 的进度事件串到了这一条界面（满格可能是别人家的）'
  )
})

test('C7 源码层唯一入口：「可安装」只由 downloadUpdate resolve 后的显式状态决定（防 #373 复发）', () => {
  const source = readText('src/components/settings/AppUpdateField.tsx')

  // (1) setReady(true) 必须排在 `await downloadUpdate(` 之后 —— 即「校验通过」之后，而不是进度分支里
  const awaitAt = source.indexOf('await downloadUpdate(')
  const readyAt = source.indexOf('setReady(true)')
  assert.ok(awaitAt > 0, 'AppUpdateField 里找不到 `await downloadUpdate(`（下载入口被搬走了？契约要跟着改）')
  assert.ok(readyAt > awaitAt, '`setReady(true)` 出现在 downloadUpdate 之前：可安装状态又回到「进度/发起」阶段推导了')

  // (2) 进度与「可安装」不许有任何直接耦合：同一行里出现 received/total 与 setReady 就算复发
  const coupled = source
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /setReady/.test(line) && /received|total/.test(line))
  assert.deepEqual(coupled, [], `进度值参与了「可安装」判断（#373 根因）：${JSON.stringify(coupled)}`)

  // (3) 失败 / 取消分支必须清空进度：catch 里没有 setProgress(undefined) = 终态会留下满格
  const downloadCatch = source.slice(source.indexOf('await downloadUpdate('))
  assert.match(
    downloadCatch.slice(0, downloadCatch.search(/\n {2}const install =/)),
    /catch \(error\)[\s\S]{0,1200}setProgress\(undefined\)/,
    '下载失败/取消分支没有清空进度 —— 终态又会渲染成「满格 + 确认下载」'
  )
})
