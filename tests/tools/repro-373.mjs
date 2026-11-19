#!/usr/bin/env node
/**
 * REPRO ONLY（Issue #373）——「进度条满格但按钮仍是『确认下载』」的 L1 复现。
 *
 * 跑法（仓库根目录）：
 *   node tests/tools/repro-373.mjs                # 先构建 harness 再跑
 *   SKIP_BUILD=1 node tests/tools/repro-373.mjs   # 复用上次构建
 *
 * 为什么这不是普通 integration 用例、而放在 tests/tools：
 *   - 它要在**浏览器里挂真实组件**（`src/components/settings/AppUpdateField.tsx`）并只替换原生桥，
 *     需要一份专门的 harness 产物（`@capacitor/core` 被 alias 成 mock），不复用 app 的 dist；
 *   - 按 tests/README.md 的约定「不在测试脚本里编译」，它不进 unit/integration 分层，属于一次性复现工具。
 *
 * 断言口径：每条场景都按 Issue #373「期望行为」断言，**失败即复现**（本文件在 main 上是红的，属预期）。
 * 结果同时写到 tests/tools/repro-373/result.json 并打印成表格，直接贴进 Issue 评论。
 */
import { execSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const OUT = path.join(HERE, 'repro-373', 'out')
const RESULT_FILE = path.join(HERE, 'repro-373', 'result.json')

const RELEASE = {
  version: '1.4.0-beta.11',
  versionCode: 18,
  size: 5452595, // 5.2 MB，对齐 Issue 截图
  file: 'apk/deepseek-chat-1.4.0-beta.11.apk',
  changes: ['修复重试与离线提示'],
  buildType: 'prerelease',
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
}
const MANIFEST = { latest: 'irrelevant', releases: [RELEASE] }

const build = async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(ROOT, 'node_modules/.bin/rspack'),
      ['build', '-c', path.join(HERE, 'repro-373/rspack.repro.config.ts')],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let log = ''
    child.stdout.on('data', (chunk) => (log += chunk))
    child.stderr.on('data', (chunk) => (log += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rspack build failed (${code})\n${log}`))))
  })
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const serve = async () => {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const file = path.join(OUT, url.pathname === '/' ? 'index.html' : url.pathname)
      if (!file.startsWith(OUT)) throw new Error('ESCAPE')
      const info = await stat(file)
      if (!info.isFile()) throw new Error('NOT_FILE')
      response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      response.end(await readFile(file))
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

/**
 * 注入到页面：把 `registerPlugin('AppUpdate')` 换成一个可编排的桥。
 * 除 AppUpdate 之外的一切（React、真实组件、真实 downloadUpdate、真实 i18n）都是产品代码。
 */
const bootstrap = (plan) => {
  const calls = []
  // Capacitor 的 notifyListeners 会打到**所有**已注册的 downloadProgress 回调，逐个用 event.id 过滤；
  // 这里必须照做，否则双入口竞态下第 1 次下载的进度会被第 2 个回调吞掉，结果不真实。
  const listeners = []
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event)
  }
  const pending = []
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const handlers = {
    installed: async () => {
      calls.push({ method: 'installed' })
      return { version: '1.4.0-beta.10', versionCode: 17, artifactVariant: 'standard' }
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
      // 与 AppUpdatePlugin.download 的 catch 一致：取消 → reject("已取消下载", "CANCELLED")
      entry.reject(new Error('CANCELLED'))
    },
    download: async (options) => {
      // 第 N 次调用可以有自己的剧本（双入口竞态：第 2 次在原生端会被 BUSY 直接拒掉）
      const spec = plan.outcomes?.[pending.length] ?? plan
      calls.push({
        method: 'download',
        id: options.id,
        url: options.url,
        size: options.size,
        versionCode: options.versionCode,
        sha256: options.sha256,
      })
      const bytes = options.size
      return new Promise((resolve, reject) => {
        const entry = { id: options.id, settled: false, resolve, reject }
        pending.push(entry)
        const finish = (fn, value) => {
          if (entry.settled) return
          entry.settled = true
          fn(value)
        }
        const settle = async () => {
          if (entry.settled) return
          if (spec.outcome === 'hang') return
          if (spec.outcome === 'resolve') {
            finish(resolve, { cached: Boolean(spec.cached) })
            return
          }
          if (spec.outcome === 'reject') {
            // 原生端：进度事件（含 received === size）先发，verify() 后跑 → 校验失败只能 reject
            finish(reject, new Error(spec.error ?? 'HASH_MISMATCH'))
            return
          }
          if (spec.outcome === 'delay-resolve') {
            await sleep(spec.delayMs ?? 600)
            finish(resolve, { cached: false })
          }
        }
        void (async () => {
          for (const ratio of spec.progress ?? []) {
            if (entry.settled) return
            const received = Math.round(bytes * ratio)
            emit({ id: options.id, received, total: bytes })
            await sleep(spec.tickMs ?? 12)
          }
          await settle()
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
  window.__probe = () => {
    const progress = document.querySelector('progress[aria-label="APK 下载进度"]')
    const dialog = document.querySelector('[role="dialog"]') ?? document.body
    return {
      buttons: [...document.querySelectorAll('button')].map((item) => item.textContent.trim()),
      status: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      progress: progress ? { value: Number(progress.value), max: Number(progress.max) } : null,
      text: dialog.innerText.replace(/\s+/g, ' ').trim(),
      calls: window.__calls ?? [],
    }
  }
  window.__calls = calls
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
    expect: '按钮=安装更新，进度条可留在满格（下载成功）',
    assert: (probe) => probe.buttons.includes('安装更新'),
  },
  {
    id: 'B',
    name: '字节传完后校验失败：进度到满 → download reject(HASH_MISMATCH)',
    plan: { progress: [0.25, 0.5, 0.98, 1], outcome: 'reject', error: 'HASH_MISMATCH' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      // 失败后组件把「重新检查」放回来（busy=false），这样不依赖具体文案
      await page.getByRole('button', { name: '重新检查' }).waitFor({ timeout: 5000 })
    },
    expect: '进度条清空（不留满格假象）+ 失败原因可见',
    assert: (probe) => probe.progress === null,
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
    expect: '回到「确认下载」时进度条应清空（不能留满格）',
    assert: (probe) => probe.progress === null,
  },
  {
    id: 'C',
    name: '完成后又点「重新检查」',
    plan: { progress: [0.5, 1], outcome: 'resolve' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.getByRole('button', { name: '安装更新' }).waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: '重新检查' }).click()
      await page.getByText('发现新版本，确认后再下载。').waitFor({ timeout: 5000 })
    },
    expect: '按钮=确认下载（设计如此），进度条必须被清掉',
    assert: (probe) => probe.progress === null && probe.buttons.includes('确认下载'),
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
    expect: '进度归零 + 「已取消」文案',
    assert: (probe) => probe.progress === null,
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
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '确认下载')
        button?.click()
        button?.click()
      })
      await page.waitForTimeout(1600)
    },
    expect: 'busy 期间重复点击不应再下发一次下载（现实发了 2 次，第 2 次被原生 BUSY 拒）',
    assert: (probe) => probe.calls.filter((call) => call.method === 'download').length === 1,
  },
  {
    id: 'F',
    name: '进度到满后立刻取消（校验还没回，候选根因 1）',
    plan: { progress: [0.5, 1], outcome: 'delay-resolve', delayMs: 700, cancelEffect: 'reject' },
    drive: async (page) => {
      await clickCheck(page)
      await page.getByRole('button', { name: '确认下载' }).click()
      await page.waitForTimeout(320)
      await page.getByRole('button', { name: '取消' }).click()
      await page.waitForTimeout(600)
    },
    expect: '取消后进度条必须清空（而不是停在满格 + 按钮回到确认下载）',
    assert: (probe) => probe.progress === null,
  },
]

const clickCheck = async (page) => {
  await page.getByRole('button', { name: '检查更新' }).click()
  await page.getByText('发现新版本，确认后再下载。').waitFor({ timeout: 8000 })
}

const main = async () => {
  if (process.env.SKIP_BUILD !== '1') {
    console.log('· 构建 harness（tests/tools/repro-373/out）…')
    await build()
  }
  const { server, url } = await serve()
  const browser = await chromium.launch()
  const results = []
  try {
    for (const scenario of scenarios) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 414, height: 900 } })
      await context.addInitScript(bootstrap, { ...scenario.plan, manifest: MANIFEST })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error)))
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__mounted === true, undefined, { timeout: 8000 })
      let driveError = null
      try {
        await scenario.drive(page)
      } catch (error) {
        driveError = String(error).split('\n')[0]
      }
      const probe = await page.evaluate(() => window.__probe())
      const shot = path.join(HERE, 'repro-373', 'shots', `${scenario.id}.png`)
      await mkdir(path.dirname(shot), { recursive: true })
      await page.screenshot({ path: shot, fullPage: true })
      const ok = driveError === null && scenario.assert(probe)
      results.push({
        id: scenario.id,
        name: scenario.name,
        expect: scenario.expect,
        actual: {
          buttons: probe.buttons,
          status: probe.status,
          progress: probe.progress,
          native: probe.calls.map((call) => call.method),
        },
        ok,
        driveError,
        pageErrors: errors,
        text: probe.text,
      })
      await context.close()
      console.log(`${ok ? '  ok  ' : '  REPRO'} ${scenario.id} ${scenario.name}${driveError ? ` — ${driveError}` : ''}`)
      console.log(
        `       按钮=${JSON.stringify(probe.buttons)} 进度=${probe.progress ? `${probe.progress.value}/${probe.progress.max}` : '无'} 原生调用=${JSON.stringify(probe.calls.map((call) => call.method))}\n       文案=${JSON.stringify(probe.status)}`
      )
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
  const summary = {
    issue: 373,
    commit: (() => {
      try {
        return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
      } catch {
        return 'unknown'
      }
    })(),
    at: new Date().toISOString(),
    reproduced: results.filter((item) => !item.ok).map((item) => item.id),
    results,
  }
  await writeFile(RESULT_FILE, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n复现成功的场景：${summary.reproduced.join(', ') || '无'}`)
  console.log(`明细：${path.relative(ROOT, RESULT_FILE)}`)
  process.exitCode = summary.reproduced.length ? 1 : 0
}

await main()
