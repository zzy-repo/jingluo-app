// [layer: integration | 依赖: playwright + chromium + 本用例自建 harness 产物（dist-update-373） | 耗时: ~40s]
/**
 * Issue #373 的正式回归用例：「下载到 100% 后按钮仍是『确认下载』」。
 *
 * 被测对象：`src/components/settings/AppUpdateField.tsx`（真实的组件 + 真实的 `downloadUpdate()`）。
 * 唯一被替换的是原生 `AppUpdate` 插件（`AppUpdatePlugin.java`）：`tests/fixtures/update-373/capacitor-mock.ts`
 * 通过 rspack alias 顶掉 `@capacitor/core`，桥的行为由页面里的 `window.__bridge` 编排，
 * 进度事件按 Java 侧的真实顺序发（`received == size` 那一帧**早于** `verify()`，见 `AppUpdatePlugin.java:205-213`）。
 *
 * 为什么要单独的 harness：`确认下载 / 安装更新` 这条分支只有 APK 里才走（`isAndroidUpdate()`），
 * 浏览器里的标准包里根本没有这两颗按钮；把原生桥换成 mock 之后，点的是真按钮、读的是真状态。
 *
 * 跑法（仓库根目录）：
 *   node tests/integration/update-stuck-button-373.test.mjs
 *   UPDATE_HARNESS_DIST=/tmp/upd373 node tests/integration/update-stuck-button-373.test.mjs   # 换产物目录
 *
 * 断言口径（每一条都对应 #373 的一项验收）：
 *   A  正常完成：按钮=安装更新，进度可以停在满格（下载确实成功了）
 *   B  字节传完、校验失败（download reject HASH_MISMATCH）：**进度条必须清空**，按钮回到「确认下载」，
 *      文案点出真实原因（SHA-256），不再出现「满格 + 确认下载」这个假象
 *   B2 安装阶段校验失败（install reject VERSION_MISMATCH）：同样清空进度，且文案说的是「版本号」而不是「SHA-256」
 *   D  下载中取消：进度清空 + 「已取消下载」文案 + 按钮回到「确认下载」
 *   E  同一 tick 连点两次「确认下载」：只允许向原生下发 1 次下载（第 2 次必须被 `downloading` ref 挡住）
 *
 * 未覆盖（本用例不做，别当成已验）：真机 Android 上 installer / PackageManager 的行为、
 * 以及「原生侧把 100% 那一帧挪到 verify() 之后」这项改动（另开单，见 #373 的 TODO）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { CURRENT, CHANNEL_BUILD_TYPE, PREVIOUS } from '../helpers/current-version.mjs'
import { serveDir, ROOT } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'

const require = createRequire(import.meta.url)
const HARNESS = path.join(ROOT, 'tests/fixtures/update-373')
const DIST = path.resolve(process.env.UPDATE_HARNESS_DIST || path.join(ROOT, 'dist-update-373'))
const SHOTS = path.join(ROOT, 'docs/ui/373-update-failure')
/** 截图与证据前缀：修复前取证跑 UPDATE_SHOT_PREFIX=before，平时留 after（PR 里前后对照用） */
const PREFIX = process.env.UPDATE_SHOT_PREFIX || 'after'

/**
 * 与 Issue 截图同形状的一条发布记录（5.2 MB）：**就是当前这一版**（清单里最新可装的那条）。
 * 版本号 / versionCode / buildType 都按当前产物派生（tests/helpers/current-version.mjs），
 * 不再抄字面量 —— 抄字面量在改版本号后会变成「清单里没有比已安装版本更高的记录」，
 * 表现为「连『确认下载』按钮都出现不了」，红得莫名其妙。
 */
const RELEASE = {
  version: CURRENT.version,
  versionCode: CURRENT.versionCode,
  size: 5452595,
  file: `apk/deepseek-chat-${CURRENT.version}.apk`,
  changes: ['修复重试与离线提示'],
  buildType: CHANNEL_BUILD_TYPE,
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
}
const MANIFEST = { latest: 'irrelevant', releases: [RELEASE] }

// ---------------------------------------------------------------- 0) 构建 harness（只在缺产物时）

/**
 * 每次跑都重编一份 harness（实测 ~170ms）。
 * 刻意**不做**「有产物就复用」：这个用例断言的是 `src/` 里的当前代码，
 * 复用旧产物会让用例对着上一版代码报绿——回归用例最不能出的错就是这个。
 */
const buildHarness = async () => {
  console.log(`· 构建 harness 到 ${path.relative(ROOT, DIST)}（可用 UPDATE_HARNESS_DIST 指定输出目录）…`)
  // 用 rspack CLI + 本用例自己的配置文件：与主配置同口径（swc / CSS Modules / Define），
  // 差别只有「单一 entry」和 `@capacitor/core` 指向 mock。
  // Windows 上 node_modules/.bin/rspack 是无扩展名的 sh 脚本，直接 spawn 会 ENOENT，
  // 所以用当前 node 跑 @rspack/cli 的 bin 入口（与 integration/copy-limit 同一写法）。
  const rspackCli = path.join(path.dirname(require.resolve('@rspack/cli/package.json')), 'bin', 'rspack.js')
  execFileSync(process.execPath, [rspackCli, 'build', '-c', path.join(HARNESS, 'rspack.harness.config.ts')], {
    cwd: ROOT,
    env: { ...process.env, HARNESS_DIST: DIST },
    stdio: 'inherit',
  })
}

// ---------------------------------------------------------------- 1) 页面里注入假桥

/**
 * 把 `registerPlugin('AppUpdate')` 换成一个可编排的桥；其余（React / 真组件 / 真 `downloadUpdate()`）都是产品代码。
 * Capacitor 的 notifyListeners 会打给**所有**已注册的 progress 回调，所以这里也照做（按 event.id 过滤由业务层负责）。
 */
const bootstrap = (plan) => {
  const calls = []
  const listeners = []
  const pending = []
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const handlers = {
    installed: async () => {
      calls.push({ method: 'installed' })
      // 设备上装的是**上一版**（更新用例的语义就是旧包装新包）；见 current-version.mjs 的 PREVIOUS
      // 设备上装的是**上一版**（更新用例的语义就是旧包装新包）——
      // 注意：这个函数被 addInitScript 序列化进页面执行，**不能**引用模块作用域常量，
      // 所以版本由 plan.installedApp 带进来（见 current-version.mjs 的 PREVIOUS）。
      return { ...plan.installedApp, artifactVariant: 'standard' }
    },
    manifest: async () => {
      calls.push({ method: 'manifest' })
      return { body: JSON.stringify(plan.manifest) }
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
      // 与 AppUpdatePlugin.download 的 catch 一致：取消 → reject(CANCELLED)
      entry.reject(new Error('CANCELLED'))
    },
    download: async (options) => {
      // 第 N 次调用可以有自己的剧本（双入口竞态：第 2 次在原生端会被 BUSY 直接拒掉）
      const spec = plan.outcomes?.[pending.length] ?? plan
      calls.push({ method: 'download', id: options.id, size: options.size })
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
          for (const ratio of spec.progress ?? []) {
            if (entry.settled) return
            emit({ id: options.id, received: Math.round(bytes * ratio), total: bytes })
            await sleep(spec.tickMs ?? 12)
          }
          if (entry.settled || spec.outcome === 'hang') return
          if (spec.outcome === 'resolve') {
            finish(resolve, { cached: Boolean(spec.cached) })
            return
          }
          if (spec.outcome === 'delay-resolve') {
            await sleep(spec.delayMs ?? 600)
            finish(resolve, { cached: false })
            return
          }
          // 原生端：进度（含 received === size）先发完，verify() 才跑 → 校验失败只能 reject
          finish(reject, new Error(spec.error ?? 'HASH_MISMATCH'))
        })()
      })
    },
    install: async (options) => {
      calls.push({ method: 'install', ...options })
      if (plan.installReject) throw new Error(plan.installReject)
      return { status: 'installer-opened' }
    },
  }
  window.__bridge = { platform: 'android', handlers }
  window.__calls = calls
  window.__probe = () => {
    const progress = document.querySelector('progress[aria-label="APK 下载进度"]')
    return {
      buttons: [...document.querySelectorAll('button')].map((item) => (item.textContent ?? '').trim()),
      status: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      progress: progress === null ? null : { value: Number(progress.value), max: Number(progress.max) },
      native: (window.__calls ?? []).map((call) => call.method),
    }
  }
}

// ---------------------------------------------------------------- 2) 场景

const clickCheck = async (page) => {
  await page.getByRole('button', { name: '检查更新' }).click()
  await page.getByText('发现新版本，确认后再下载。').waitFor({ timeout: 8000 })
}

const scenarios = [
  {
    id: 'A',
    name: '正常完成：进度到满 → download resolve',
    plan: { progress: [0.25, 0.5, 0.98, 1], outcome: 'resolve' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByText('下载及校验完成，点击安装。').waitFor({ timeout: 5000 })
    },
    assert: (probe) => {
      assert.ok(probe.buttons.includes('安装更新'), `按钮应变成「安装更新」，实际 ${JSON.stringify(probe.buttons)}`)
      assert.equal(probe.buttons.includes('确认下载'), false, '下载成功后不该还留着「确认下载」')
      // 成功档：进度可以停在满格（用户确实下完了），这里只钉「进度不是判断依据」
      assert.ok(probe.progress !== null, '下载成功后进度条不必清空（与失败档区分开）')
      assert.equal(probe.progress.value, probe.progress.max, '成功档进度应到满格')
      assert.match(probe.status, /下载及校验完成/)
    },
  },
  {
    id: 'B',
    name: '字节传完但校验失败：进度到满 → download reject(HASH_MISMATCH)',
    plan: { progress: [0.25, 0.5, 0.98, 1], outcome: 'reject', error: 'HASH_MISMATCH' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      // 失败后 busy=false 会把「重新检查」放回来；用它当失败完成的信号（不依赖具体文案）
      await page.getByRole('button', { name: '重新检查' }).waitFor({ timeout: 5000 })
    },
    assert: (probe) => {
      // 这就是 #373 本体：失败后不许留下「5.2 MB / 5.2 MB 满格」
      assert.equal(probe.progress, null, `校验失败后进度条必须清空，实际 ${JSON.stringify(probe.progress)}`)
      assert.ok(probe.buttons.includes('确认下载'), `按钮应回到「确认下载」，实际 ${JSON.stringify(probe.buttons)}`)
      assert.equal(probe.buttons.includes('安装更新'), false, '校验失败不许出现「安装更新」')
      assert.match(probe.status, /安装包校验未通过/)
      assert.match(probe.status, /SHA-256/, `失败文案应点出真实原因（SHA-256），实际：${probe.status}`)
      assert.equal(probe.native.filter((name) => name === 'download').length, 1, '只应下发一次下载')
    },
  },
  {
    id: 'B2',
    name: '下载成功、点安装后原生校验失败（install reject VERSION_MISMATCH）',
    plan: { progress: [0.5, 1], outcome: 'resolve', installReject: 'VERSION_MISMATCH' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByRole('button', { name: '安装更新' }).click()
      await page.getByRole('button', { name: '重新检查' }).waitFor({ timeout: 5000 })
    },
    assert: (probe) => {
      assert.equal(probe.progress, null, `安装阶段校验失败后进度条必须清空，实际 ${JSON.stringify(probe.progress)}`)
      assert.ok(probe.buttons.includes('确认下载'), `按钮应回到「确认下载」，实际 ${JSON.stringify(probe.buttons)}`)
      // 分原因文案：VERSION_MISMATCH 说「版本号」，不再冒充「大小或 SHA-256 不符」（#373 第 3 项）
      assert.match(probe.status, /版本号/, `VERSION_MISMATCH 的文案应点出版本号，实际：${probe.status}`)
      assert.doesNotMatch(probe.status, /大小或 SHA-256 不符/, `VERSION_MISMATCH 不该说成大小/摘要不符：${probe.status}`)
      assert.ok(probe.native.includes('install'), '应真的调用过原生 install')
    },
  },
  {
    id: 'D',
    name: '下载中被取消：进度到 99% → 点「取消」',
    plan: { progress: [0.3, 0.99], outcome: 'hang', cancelEffect: 'reject' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: '取消' }).click()
      await page.getByText('已取消下载，可重新下载。').waitFor({ timeout: 5000 })
    },
    assert: (probe) => {
      assert.equal(probe.progress, null, `取消后进度条必须清空，实际 ${JSON.stringify(probe.progress)}`)
      assert.ok(probe.buttons.includes('确认下载'), `取消后按钮应回到「确认下载」，实际 ${JSON.stringify(probe.buttons)}`)
      assert.match(probe.status, /已取消下载/)
      assert.ok(probe.native.includes('cancel'), '取消应真的调用原生 cancel')
    },
  },
  {
    id: 'E',
    name: '双入口竞态：同一 tick 连点两次「确认下载」（第 2 次在原生端被 BUSY 拒）',
    plan: {
      outcomes: [
        { outcome: 'delay-resolve', delayMs: 900, progress: [0.3, 0.6, 1] },
        { outcome: 'reject', error: 'BUSY' },
      ],
    },
    drive: async (page) => {
      await clickCheck(page)
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(
          (item) => (item.textContent ?? '').trim() === '确认下载'
        )
        button?.click()
        button?.click()
      })
      await page.waitForTimeout(1800)
    },
    assert: (probe) => {
      // 第 2 次点击必须被 downloading ref 挡住：以前实测会真下发 2 次（第 2 次被原生 BUSY 拒）
      assert.equal(
        probe.native.filter((name) => name === 'download').length,
        1,
        `同一 tick 连点两次只许下发 1 次下载，实际原生调用序 ${JSON.stringify(probe.native)}`
      )
      assert.ok(probe.buttons.includes('安装更新'), `第 1 次下载应正常走完，实际 ${JSON.stringify(probe.buttons)}`)
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
const expectScenario = (scenario, probe) => {
  try {
    scenario.assert(probe)
    ok(`${scenario.id} ${scenario.name}`)
  } catch (error) {
    failures.push(`${scenario.id} ${scenario.name}：${error.message}`)
    console.error(`  ✗  ${scenario.id} ${scenario.name}\n     ${error.message}`)
  }
}

await mkdir(SHOTS, { recursive: true })
await buildHarness()
const served = await serveDir(DIST, { port: process.env.PORT, label: 'update-373 harness' })
console.log(`静态服务：${path.relative(ROOT, DIST)} → ${served.url}`)

const browser = await chromium.launch({ headless: true })
const report = []
try {
  for (const viewport of VIEWPORTS) {
    // 390 跑全部场景；360 只重放 B（#373 的症状本来就出在这条），用于补一张窄屏截图
    const plan = viewport.width === 390 ? scenarios : scenarios.filter((item) => item.id === 'B')
    for (const scenario of plan) {
      const context = await browser.newContext({
        locale: 'zh-CN',
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      })
      await context.addInitScript(bootstrap, {
        ...scenario.plan,
        manifest: MANIFEST,
        installedApp: PREVIOUS,
      })
      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      /**
       * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来）。
       * 本用例的原生 `AppUpdate` 插件与更新清单都是 harness 里注入的本机假实现，
       * 白名单里只需要被测 harness 自己的 origin（精确 host:port）。
       */
      await installEgressGate(page, { appUrl: served.url, allowHosts: [new URL(served.url).host] })
      await page.goto(served.url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__mounted === true, undefined, { timeout: 10000 })
      let driveError = null
      try {
        await scenario.drive(page)
      } catch (error) {
        driveError = String(error).split('\n')[0]
      }
      const probe = await page.evaluate(() => window.__probe())
      const shot = path.join(SHOTS, `${PREFIX}-${scenario.id}-${viewport.label}.png`)
      await page.screenshot({ path: shot, fullPage: true })
      report.push({ viewport: viewport.label, ...scenario.plan, id: scenario.id, probe, driveError, pageErrors, shot: path.relative(ROOT, shot) })
      if (driveError === null) {
        expectScenario(scenario, probe)
      } else {
        failures.push(`${scenario.id}@${viewport.label} 驱动失败：${driveError}`)
        console.error(`  ✗  ${scenario.id}@${viewport.label} 驱动失败：${driveError}`)
      }
      assert.deepEqual(pageErrors, [], `${scenario.id}@${viewport.label} 页面不该抛异常：${pageErrors.join(' | ')}`)
      console.log(
        `  ·   ${scenario.id}@${viewport.label} 按钮=${JSON.stringify(probe.buttons)} 进度=${
          probe.progress === null ? '无' : `${probe.progress.value}/${probe.progress.max}`
        } 原生=${JSON.stringify(probe.native)}`
      )
      await context.close()
    }
  }
} finally {
  // #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）—— 先断言再关浏览器
  assertNoEgress(failures)
  await browser.close()
  served.kill()
  await writeFile(path.join(SHOTS, `${PREFIX}-result.json`), `${JSON.stringify(report, null, 2)}\n`)
}

console.log(`\n共 ${checks} 条断言通过，${failures.length} 条失败；截图与原始证据见 ${path.relative(ROOT, SHOTS)}/`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
} else {
  // 顺手确认「进度满格 + 确认下载」这个假象在证据里真的不存在了
  const raw = await readFile(path.join(SHOTS, `${PREFIX}-result.json`), 'utf8')
  if (raw.includes('"progress": {"value": 5452595, "max": 5452595}') && /"id": "B"/.test(raw)) {
    console.error('FAIL 证据里仍出现 B 档满格进度')
    process.exitCode = 1
  }
}
