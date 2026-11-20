// [layer: integration | 依赖: playwright + chromium + 本用例自建 harness（mkdtemp，跑完即删） | 耗时: ~25s]
//
// 域10 N5 —— **下载 / 安装交互**（Issue #362 §3.2 N5；功能点 F10-08 / F10-09，并登记 F10-04 的原生缺口）。
//
// 被测对象：`src/components/settings/AppUpdateField.tsx` + 真实的 `downloadUpdate()`。
// 唯一被替换的是原生 `AppUpdate` 插件（`AppUpdatePlugin.java`）：harness 用 rspack alias 把
// `@capacitor/core` 指向 `tests/fixtures/domain10/capacitor-mock.ts`，桥的行为由页面里的
// `window.__bridge` 编排。**浏览器里的标准包根本没有「确认下载 / 安装更新」这两颗按钮**
// （`isAndroidUpdate()` 为假），所以这条链路只能靠 harness 才点得到真按钮。
//
// 与 N4 的分工（别合并）：N4 走 web 通道（route 掉 releases.json，断言「下载 APK」链接与文案），
// N5 打桩原生桥。把桥塞进 N4 会污染它「网页预览降级成 <a>」那条断言 —— 两个通道的降级行为是相反的。
//
// 表驱动：`SCENARIOS` 一行 = 一条交互路径（剧本 plan + 驱动 drive + 断言 assert）。
//
// 跑法（仓库根目录）：
//   node tests/integration/domain10-update-install-flow.test.mjs
//   UPDATE_HARNESS_DIST=/tmp/xxx node tests/integration/domain10-update-install-flow.test.mjs   # 复用产物
//
// 覆盖：
//   P1 进度实时更新 + 下载目标 URL 拼在「原生真的回了清单」的 base 上（F10-08 / F10-02）
//   P2 下载中取消（F10-08）
//   P3 命中已校验缓存 → 「已复用并校验缓存」（F10-08）
//   P4 系统安装器缺「未知来源」权限（F10-09）
//   P5 安装阶段校验失败 → 可再点（F10-09）
//   G1 原生通道「清单 200 但解析不了」不回退 —— #330 只修了 web 路径（F10-04 的原生缺口）
//   G2 原生侧证件不全（无渠道标记）→ 不贸然下载（F10-05）

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { CURRENT, CHANNEL_BUILD_TYPE, PREVIOUS } from '../helpers/current-version.mjs'
import { serveDir, ROOT } from '../helpers/env.mjs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const HARNESS = path.join(ROOT, 'tests/fixtures/domain10')
const PREFIX = process.env.UPDATE_SHOT_PREFIX || 'domain10'

/**
 * 与线上 releases.json 同形状的一条记录（5.2 MB）：**就是当前这一版**。
 * 版本号 / versionCode / buildType 按当前产物派生（tests/helpers/current-version.mjs）：
 * 「有可装的新版本」依赖「清单里的 versionCode 高于已安装版本 + 渠道对得上」，两件事都要跟版本走。
 */
const RELEASE = {
  version: CURRENT.version,
  versionCode: CURRENT.versionCode,
  size: 5452595,
  file: `apk/deepseek-chat-${CURRENT.version}.apk`,
  changes: ['修复重试与离线提示', '下载失败不再残留满格进度'],
  buildType: CHANNEL_BUILD_TYPE,
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
}
const MANIFEST = { releases: [RELEASE] }
/** 事故形态的脏清单：buildType 写了 Gradle 的 "release"（#330 的 2026-11-19 现场） */
const DIRTY_MANIFEST = { releases: [{ ...RELEASE, buildType: 'release' }] }

// ---------------------------------------------------------------- 0) 构建 harness

/**
 * 每次跑都重编（实测 ~200ms）。刻意**不做**「有产物就复用」：本用例断言的是 `src/` 当前的代码，
 * 复用旧产物会让用例对着上一版代码报绿（回归用例最不能出的错）。
 * 产物落在 mkdtemp 里：仓库不会被 `dist-*` 目录污染，跑完即删。
 */
const buildHarness = () => {
  if (process.env.UPDATE_HARNESS_DIST) return path.resolve(process.env.UPDATE_HARNESS_DIST)
  const dist = mkdtempSync(path.join(tmpdir(), 'domain10-harness-'))
  console.log(`· 构建 harness → ${dist}`)
  const rspackCli = path.join(path.dirname(require.resolve('@rspack/cli/package.json')), 'bin', 'rspack.js')
  execFileSync(process.execPath, [rspackCli, 'build', '-c', path.join(HARNESS, 'rspack.harness.config.ts')], {
    cwd: ROOT,
    env: { ...process.env, HARNESS_DIST: dist },
    stdio: 'inherit',
  })
  return dist
}

// ---------------------------------------------------------------- 1) 页面里的假桥

/** 把 registerPlugin('AppUpdate') 换成可编排的桥；其余（React / 组件 / downloadUpdate）都是产品代码 */
const bootstrap = (plan) => {
  const calls = []
  const listeners = []
  const pending = []
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const handlers = {
    // F10-05：原生侧读出的「当前安装包」；artifactVariant 为 unknown 时必须不下载
    installed: async () => {
      calls.push({ method: 'installed' })
      return {
        // 设备上装的是**上一版**（更新用例的语义就是旧包装新包）。
        // 这个函数会被 addInitScript 序列化进页面执行，引用不到模块作用域常量，
        // 所以版本由 plan.installedApp 带进来（见 current-version.mjs 的 PREVIOUS）。
        ...plan.installedApp,
        artifactVariant: plan.variant ?? 'standard',
      }
    },
    // F10-04：原生侧只会对「非 200」重试；解析在 JS 侧（AppUpdatePlugin.java:65-80）
    manifest: async () => {
      calls.push({ method: 'manifest' })
      return { body: JSON.stringify(plan.manifest), base: plan.base }
    },
    addListener: async (name, callback) => {
      calls.push({ method: 'addListener', name })
      listeners.push(callback)
      return {
        remove: async () => {
          const index = listeners.indexOf(callback)
          if (index >= 0) listeners.splice(index, 1)
          calls.push({ method: 'removeListener' })
        },
      }
    },
    cancel: async (options) => {
      calls.push({ method: 'cancel', id: options?.id })
      if (plan.cancelEffect !== 'reject') return
      const entry = pending.find((item) => item.id === options?.id && !item.settled)
      if (!entry) return
      entry.settled = true
      entry.reject(new Error('CANCELLED'))
    },
    download: async (options) => {
      calls.push({ method: 'download', url: options.url, size: options.size, sha256: options.sha256 })
      const bytes = options.size
      return new Promise((resolve, reject) => {
        const entry = { id: options.id, settled: false, resolve, reject }
        pending.push(entry)
        const finish = (fn, value) => {
          if (entry.settled) return
          entry.settled = true
          fn(value)
        }
        void (async () => {
          for (const ratio of plan.progress ?? []) {
            if (entry.settled) return
            emit({ id: options.id, received: Math.round(bytes * ratio), total: bytes })
            await sleep(plan.tickMs ?? 12)
          }
          if (entry.settled || plan.outcome === 'hang') return
          if (plan.outcome === 'resolve') {
            finish(resolve, { cached: Boolean(plan.cached) })
            return
          }
          finish(reject, new Error(plan.error ?? 'HASH_MISMATCH'))
        })()
      })
    },
    install: async (options) => {
      calls.push({ method: 'install', versionCode: options.versionCode })
      if (plan.installReject) throw new Error(plan.installReject)
      return { status: plan.installStatus ?? 'installer-opened' }
    },
  }

  window.__bridge = { platform: 'android', handlers }
  window.__calls = calls
  window.__probe = () => {
    const progress = document.querySelector('progress[aria-label="APK 下载进度"]')
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop() ?? null
    return {
      buttons: [...document.querySelectorAll('button, a')].map((item) => (item.textContent ?? '').trim()),
      status: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      dialogOpen: dialog !== null,
      progress: progress === null ? null : { value: Number(progress.value), max: Number(progress.max) },
      progressText: progress === null ? null : (progress.nextElementSibling?.textContent ?? '').trim(),
      diagnostics: document.querySelector('[data-testid="update-diagnostics"]')?.textContent ?? '',
      native: (window.__calls ?? []).map((call) => call.method),
      downloadUrl: (window.__calls ?? []).find((call) => call.method === 'download')?.url ?? null,
    }
  }
}

// ---------------------------------------------------------------- 2) 场景（表）

/** 打开弹窗并等到结论行出现（「发现新版本」或失败文案），不依赖某一个具体文案 */
const openDialog = async (page, plan) => {
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByRole('dialog').last().waitFor({ state: 'visible', timeout: 10000 })
  if (plan.expectCheckMessage) {
    await page.getByText(plan.expectCheckMessage).first().waitFor({ timeout: 8000 })
  }
}

const SCENARIOS = [
  {
    id: 'P1',
    f10: ['F10-08', 'F10-02'],
    name: '下载：进度实时更新，URL 拼在原生回传的 base 上',
    plan: {
      manifest: MANIFEST,
      // 原生回退到了旧机：file 必须拼在这个 base 上，拼新机域名就是 404（F10-02）
      base: 'https://dl.rose7.cn',
      progress: [0.15, 0.5, 0.85, 1],
      outcome: 'resolve',
      expectCheckMessage: '发现新版本，确认后再下载。',
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[0].plan)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByText('下载及校验完成，点击安装。').waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      assert.ok(probe.buttons.includes('安装更新'), `下载完成后按钮应变成「安装更新」：${JSON.stringify(probe.buttons)}`)
      assert.equal(probe.buttons.includes('确认下载'), false, '下载完成后不该还留着「确认下载」')
      // F10-08 进度：进度条存在且到满格（下载确实成功了）
      assert.ok(probe.progress !== null, '下载过程中应渲染进度条')
      assert.equal(probe.progress.value, probe.progress.max, '下载成功时进度应到满格')
      // F10-02：相对 file 必须拼在「真的回了清单」的 base 上
      assert.ok(
        probe.downloadUrl?.startsWith(`https://dl.rose7.cn/${RELEASE.file}`),
        `下载 URL 应拼在原生回传的 base 上，实际 ${probe.downloadUrl}`
      )
      assert.match(probe.status, /下载及校验完成/)
    },
  },
  {
    id: 'P2',
    f10: ['F10-08'],
    name: '下载中取消：进度清空、文案说明、原生 cancel 被调用',
    plan: {
      manifest: MANIFEST,
      base: 'http://62.106.70.167:8888',
      progress: [0.3, 0.6],
      outcome: 'hang',
      cancelEffect: 'reject',
      expectCheckMessage: '发现新版本，确认后再下载。',
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[1].plan)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.waitForTimeout(400)
      await page.getByRole('button', { name: '取消' }).click()
      await page.getByText('已取消下载，可重新下载。').waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      assert.equal(probe.progress, null, `取消后进度条必须清空（#373），实际 ${JSON.stringify(probe.progress)}`)
      assert.ok(probe.buttons.includes('确认下载'), `取消后按钮应回到「确认下载」：${JSON.stringify(probe.buttons)}`)
      assert.ok(probe.native.includes('cancel'), '取消必须真的下发到原生 cancel')
      assert.match(probe.status, /已取消下载/)
    },
  },
  {
    id: 'P3',
    f10: ['F10-08'],
    name: '缓存复用：已校验缓存 → 「已复用并校验缓存」（不必再下 5.2MB）',
    plan: {
      manifest: MANIFEST,
      base: 'http://62.106.70.167:8888',
      progress: [],
      outcome: 'resolve',
      cached: true,
      expectCheckMessage: '发现新版本，确认后再下载。',
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[2].plan)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByText('已复用并校验缓存，点击安装。').waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      assert.match(probe.status, /已复用并校验缓存/, '命中缓存时文案必须明说复用，别让人以为又下了一遍')
      assert.ok(probe.buttons.includes('安装更新'), `命中缓存后也应可直接安装：${JSON.stringify(probe.buttons)}`)
      assert.equal(probe.native.filter((name) => name === 'download').length, 1, '缓存命中仍然只调用一次原生 download')
    },
  },
  {
    id: 'P4',
    f10: ['F10-09'],
    name: '安装：系统缺「未知来源」权限 → 引导去授权，回来还要再点一次',
    plan: {
      manifest: MANIFEST,
      base: 'http://62.106.70.167:8888',
      progress: [1],
      outcome: 'resolve',
      installStatus: 'permission-required',
      expectCheckMessage: '发现新版本，确认后再下载。',
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[3].plan)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByRole('button', { name: '安装更新' }).click()
      await page.getByText(/请允许此应用安装更新/).waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      assert.match(probe.status, /请允许此应用安装更新/, '无权限时必须说清「去允许」这一动作')
      assert.match(probe.status, /再次点击安装/, '回来之后还要再点一次，文案必须写出来')
      assert.ok(probe.buttons.includes('安装更新'), `授权后应能再点安装：${JSON.stringify(probe.buttons)}`)
      assert.ok(probe.native.includes('install'), '应真的调用过原生 install')
    },
  },
  {
    id: 'P5',
    f10: ['F10-09', 'F10-10'],
    name: '安装阶段校验失败 → 分原因文案 + 回到可再点（不留满格进度）',
    plan: {
      manifest: MANIFEST,
      base: 'http://62.106.70.167:8888',
      progress: [0.5, 1],
      outcome: 'resolve',
      installReject: 'VERSION_MISMATCH',
      expectCheckMessage: '发现新版本，确认后再下载。',
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[4].plan)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByRole('button', { name: '安装更新' }).click()
      await page.getByRole('button', { name: '确认下载' }).waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      assert.equal(probe.progress, null, `安装失败后进度条必须清空，实际 ${JSON.stringify(probe.progress)}`)
      assert.ok(probe.buttons.includes('确认下载'), `失败后要能重新下载：${JSON.stringify(probe.buttons)}`)
      assert.match(probe.status, /版本号/, `VERSION_MISMATCH 的文案应点出版本号，实际：${probe.status}`)
      assert.doesNotMatch(probe.status, /大小或 SHA-256 不符/, 'VERSION_MISMATCH 不许冒充「大小/摘要不符」')
    },
  },
  {
    id: 'G1',
    f10: ['F10-04'],
    name: '【缺口 #330】原生通道：清单 200 但解析不了 → 只失败一次，不回退第二台',
    plan: {
      // 脏清单（buildType 写了 Gradle 的 "release"）：web 通道会继续试下一台并把脏清单丢掉
      manifest: DIRTY_MANIFEST,
      base: 'http://62.106.70.167:8888',
      progress: [],
      outcome: 'resolve',
      expectCheckMessage: undefined,
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[5].plan)
      // 解析失败 → 归「版本信息无法解析」（manifest 类），不是「连不上」
      await page.getByText(/版本信息读不出来|版本信息无法解析/).waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      // 现状（这是**记录缺口**的断言，不是期望行为）：原生侧只调了一次 manifest()。
      // 重试循环在 Java 里（AppUpdatePlugin.java:65-80），只对「非 200 / 网络异常」重试；
      // 解析在 JS 侧（AppUpdateField.tsx），所以「200 但清单脏」在原生通道上**不回退**。
      assert.equal(
        probe.native.filter((name) => name === 'manifest').length,
        1,
        `原生通道解析失败后不该再调 manifest（现状就是一次）：${JSON.stringify(probe.native)}`
      )
      assert.match(probe.status, /版本信息/, `失败类别应是 manifest（清单坏了），实际：${probe.status}`)
      // 它必须仍然「可再试一次」，用户至少不是死路
      assert.ok(probe.buttons.includes('重新检查'), `失败后应能「重新检查」：${JSON.stringify(probe.buttons)}`)
      console.log('    # TODO(#330) 原生 AppUpdatePlugin.manifest() 只对非 200 重试，解析失败不回退 —— 已登记，见本文件头')
    },
  },
  {
    id: 'G2',
    f10: ['F10-05'],
    name: '原生侧证件不全（无渠道标记）→ 不贸然下载，说清「信息缺失」',
    plan: {
      manifest: MANIFEST,
      base: 'http://62.106.70.167:8888',
      variant: 'unknown',
      progress: [],
      outcome: 'resolve',
      expectCheckMessage: undefined,
    },
    drive: async (page) => {
      await openDialog(page, SCENARIOS[6].plan)
      await page.getByText(/当前安装包信息缺失/).waitFor({ timeout: 8000 })
    },
    assert: (probe) => {
      assert.match(probe.status, /当前安装包信息缺失/, '渠道判不出来时文案要说「信息缺失」，不是「已是最新」')
      assert.equal(probe.native.includes('download'), false, '渠道不明时绝不下载（F10-05 的核心）')
      assert.equal(probe.buttons.includes('确认下载'), false, '渠道不明时不该出现「确认下载」')
    },
  },
]

// ---------------------------------------------------------------- 3) 跑

const VIEWPORTS = [
  { label: '390x844', width: 390, height: 844 },
  { label: '360x740', width: 360, height: 740 },
]

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}

const dist = buildHarness()
const served = await serveDir(dist, { port: process.env.PORT, label: 'domain10 update harness' })
console.log(`静态服务：${dist} → ${served.url}`)

const browser = await chromium.launch({ headless: true })
const report = []
try {
  for (const viewport of VIEWPORTS) {
    // 390 跑全部场景；360 只重放 P1 + P4（窄屏最容易把底部按钮挤出视口）
    const plan = viewport.width === 390 ? SCENARIOS : SCENARIOS.filter((item) => ['P1', 'P4'].includes(item.id))
    for (const scenario of plan) {
      const context = await browser.newContext({
        locale: 'zh-CN',
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      })
      await context.addInitScript(bootstrap, { ...scenario.plan, installedApp: PREVIOUS })
      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      await page.goto(served.url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__mounted === true, undefined, { timeout: 15000 })
      let driveError = null
      try {
        await scenario.drive(page)
      } catch (error) {
        driveError = String(error).split('\n')[0]
      }
      const probe = await page.evaluate(() => window.__probe())
      report.push({ viewport: viewport.label, id: scenario.id, plan: scenario.plan, probe, driveError, pageErrors })
      if (driveError === null) {
        try {
          scenario.assert(probe)
          ok(`${scenario.id}@${viewport.label} ${scenario.name}`)
        } catch (error) {
          failures.push(`${scenario.id}@${viewport.label}：${error.message}`)
          console.error(`  ✗  ${scenario.id}@${viewport.label} ${scenario.name}\n     ${error.message}`)
        }
      } else {
        failures.push(`${scenario.id}@${viewport.label} 驱动失败：${driveError}`)
        console.error(`  ✗  ${scenario.id}@${viewport.label} 驱动失败：${driveError}`)
      }
      if (pageErrors.length > 0) {
        failures.push(`${scenario.id}@${viewport.label} 页面抛异常：${pageErrors.join(' | ')}`)
      }
      console.log(
        `  ·   ${scenario.id}@${viewport.label} 按钮=${JSON.stringify(probe.buttons)} 进度=${
          probe.progress === null ? '无' : `${probe.progress.value}/${probe.progress.max}`
        } 原生=${JSON.stringify(probe.native)}`
      )
      await context.close()
    }
  }
} finally {
  await browser.close()
  served.kill()
  if (!process.env.UPDATE_HARNESS_DIST) rmSync(dist, { recursive: true, force: true })
}

console.log(`\n共 ${checks} 条断言组通过，${failures.length} 条失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
}
