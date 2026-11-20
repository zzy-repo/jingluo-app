// [layer: unit | 纯 Node，无浏览器无网络（只读源码文本） | 耗时: <1s]
//
// 域10 L0 —— **原生进度帧顺序**（Issue #376，父单 #373 / #362 域10「更新链路」）。
//
// 要回答的问题：`AppUpdatePlugin` 的 100% 进度帧，是不是**只**在校验通过之后才发。
//
// 为什么用「读源码 + 断言语句次序」而不是常规单测：
//   · 这一帧在 `download()` 的拷贝循环里，构造它需要 `HttpURLConnection` + 真文件 + Android
//     `PackageManager`（`verify()` 要读签名 / 包名 / versionCode）。L0 层拿不到这些；
//   · 安卓 JVM 单测（`android/app/src/test/…`）在本仓库的 CI 里**从不执行**（没有 Android SDK
//     job），写了也只是摆设——本仓库既有的「原生契约」做法就是源码级断言
//     （见 `tests/unit/app-update.test.mjs` 的「Java 端两处地址成对」、`scripts/check-identity.mjs`）；
//   · 这条 bug 的形状恰好是**语句次序**：#373 在 JS 侧清了残留进度，但根因是「字节凑齐 =
//     发满格」，早于 `verify()`——任何一次校验失败（错 SHA / 异签 / 异变体）都会先画满格再报错。
//
// 判定（`violations()`，空数组 = 顺序正确）：
//   1. 拷贝循环内不许出现 `received == size` 的发帧条件（旧写法，就是本条 bug）；
//   2. 拷贝循环内只许发 `received < size` 的帧；
//   3. 拷贝循环内不许直接 `notifyListeners("downloadProgress")`——进度帧统一走 `reportProgress()`；
//   4. 满格帧（`reportProgress(id, size, size)`）全仓库只有两处：缓存命中、下载收尾；
//   5. 两处都必须排在各自的 `verify(...)` **之后**（缓存 → `verify(target…)`；下载 → `verify(temporary…)`）。
//
// 负向对照（#369 的规矩：门禁绿不能是因为门禁没工作）：把 bug 逐条注回源码，`violations()`
// 必须报出来；三处注入点各有一条 test。源码结构变了（找不到循环 / verify）时**直接报违规**，
// 不许静默通过。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const SOURCE_URL = new URL(
  '../../android/app/src/main/java/com/example/deepseekchat/AppUpdatePlugin.java',
  import.meta.url
)
const source = await readFile(SOURCE_URL, 'utf8')

// 定位真下载那条拷贝循环：`manifest()` 里也有一模一样的 `while ((count = input.read(buffer)) != -1)`
// （读清单的字节流），所以必须先用 `FileOutputStream(temporary)` 锚到下载分支，再找循环。
const REGION_ANCHOR = 'new FileOutputStream(temporary)'
const LOOP_START = 'while ((count = input.read(buffer)) != -1)'
const LOOP_END = 'output.getFD().sync()'
const FULL_FRAME = 'reportProgress(id, size, size);'
const VERIFY_DOWNLOAD = 'verify(temporary, hash, size, versionCode, transfer);'
const VERIFY_CACHE = 'verify(target, hash, size, versionCode, transfer);'
const NOTIFY = 'notifyListeners("downloadProgress"'

/**
 * 源码 → 违规清单。**只有这一个判定实现**：真实源码与负向对照跑同一份，
 * 避免「对照用的规则」和「门禁用的规则」各写一套（那正是 #369 立项的原因）。
 */
const violations = (text) => {
  const found = []
  const regionAt = text.indexOf(REGION_ANCHOR)
  if (regionAt < 0) {
    found.push(`找不到下载分支（${REGION_ANCHOR}）：顺序判定已失效，请同步本用例`)
    return found
  }
  const loopAt = text.indexOf(LOOP_START, regionAt)
  const loopEnd = loopAt < 0 ? -1 : text.indexOf(LOOP_END, loopAt)
  if (loopAt < 0 || loopEnd <= loopAt) {
    // 结构变了不等于「顺序对了」：找不到就报违规，别静默绿
    found.push('找不到下载拷贝循环（while/read + getFD().sync()）：顺序判定已失效，请同步本用例')
    return found
  }
  const loop = text.slice(loopAt, loopEnd)
  if (/received\s*==\s*size/.test(loop)) {
    found.push('拷贝循环里仍在 received == size 时发进度帧：字节凑齐 ≠ 校验通过，校验失败会先画满格')
  }
  if (!/received\s*<\s*size/.test(loop)) {
    found.push('拷贝循环里没有 received < size 的判定：循环内不该发满格帧')
  }
  if (loop.includes(NOTIFY)) {
    found.push('拷贝循环里直接 notifyListeners：进度帧应统一走 reportProgress()（单出口才好审计）')
  }
  const downloadVerifyAt = text.indexOf(VERIFY_DOWNLOAD)
  const cacheVerifyAt = text.indexOf(VERIFY_CACHE)
  if (downloadVerifyAt < 0) {
    found.push('找不到真下载的 verify(temporary…)：顺序判定已失效，请同步本用例')
  }
  if (cacheVerifyAt < 0) {
    found.push('找不到缓存复用的 verify(target…)：顺序判定已失效，请同步本用例')
  }
  const frames = [...text.matchAll(new RegExp(FULL_FRAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
  if (frames.length !== 2) {
    found.push(`满格帧应只有两处（缓存命中 / 下载收尾），实际 ${frames.length} 处`)
  }
  if (frames[0] !== undefined && cacheVerifyAt >= 0 && frames[0].index < cacheVerifyAt) {
    found.push('缓存命中的满格帧早于 verify(target…)：缓存文件名不是证据，必须先校验再宣称可安装')
  }
  if (frames[1] !== undefined && downloadVerifyAt >= 0 && frames[1].index < downloadVerifyAt) {
    found.push('真下载的满格帧早于 verify(temporary…)：这就是 #376 的根因')
  }
  return found
}

/** 负向对照 1：把旧的 `|| received == size` 注回拷贝循环 */
const reinjectLoopFrame = (text) =>
  text.replace('if (received < size && now - lastEvent >= 100) {', 'if (now - lastEvent >= 100 || received == size) {')

/** 负向对照 2：把下载收尾的满格帧挪到 verify() 之前 */
const moveFullFrameBeforeVerify = (text) => {
  const withoutDownloadFrame = text.replace(
    new RegExp(`(${VERIFY_DOWNLOAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([\\s\\S]*?)${FULL_FRAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    '$1$2'
  )
  return withoutDownloadFrame.replace(VERIFY_DOWNLOAD, `${FULL_FRAME}\n                ${VERIFY_DOWNLOAD}`)
}

/** 负向对照 3：整帧删掉（校验失败时确实没有满格，但成功路径也不再宣称可安装） */
const dropFullFrame = (text) => text.replace(FULL_FRAME, '')

test('真实源码：满格帧只在校验通过之后发（#376 的修复形状）', () => {
  assert.deepEqual(violations(source), [], 'AppUpdatePlugin 的进度帧顺序不符合「满格 = 已验证」')
})

test('负向对照：注回 `|| received == size` 必须被拦下（证明判定不是空跑）', () => {
  const injected = reinjectLoopFrame(source)
  assert.notEqual(injected, source, '注入没生效：源码形状变了，请同步本用例')
  const found = violations(injected)
  assert.ok(
    found.some((item) => item.includes('received == size')),
    `应由「received == size」那条报出，实际：${JSON.stringify(found)}`
  )
})

test('负向对照：满格帧挪到 verify() 之前必须被拦下', () => {
  const moved = moveFullFrameBeforeVerify(source)
  assert.notEqual(moved, source, '搬迁没生效：源码形状变了，请同步本用例')
  const found = violations(moved)
  assert.ok(
    found.some((item) => item.includes('#376')),
    `应由「满格帧早于 verify()」那条报出，实际：${JSON.stringify(found)}`
  )
})

test('负向对照：满格帧被删掉也要报（成功路径不再宣称可安装）', () => {
  const dropped = dropFullFrame(source)
  const found = violations(dropped)
  assert.ok(
    found.some((item) => item.includes('满格帧应只有两处')),
    `应由「满格帧数量」那条报出，实际：${JSON.stringify(found)}`
  )
})
