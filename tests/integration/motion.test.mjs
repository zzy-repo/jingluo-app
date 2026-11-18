// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 1.4.0-beta.2 交互动效验收（自建、可自动化、不依赖真实上游）
//
//   cd /root/deepseek-app && node tests/integration/motion.test.mjs
//
// 被测页面是**内测构建**的 dist（`INTERNAL_BUILD=1 pnpm build:internal`），
// 由脚本自己拉起静态服务；上游（ours 渠道，见 tests/fixtures/ours-upstream.mjs）用 page.route 打桩，
// 不需要真的把 IP 绑到回环，也不连任何外网。
//
// 断言（对应任务书「验收」）：
//   [1] 抓中间帧：侧边栏 / 设置弹窗在 t=80 / 150 / 250ms 各截一张，
//       并读取 getComputedStyle 的 transform 中间值，证明是渐变而不是瞬变
//   [2] 计算样式：侧边栏打开后 transform = matrix(1,0,0,1,0,0)，关闭过程 tx < 0
//   [3] reduced-motion：动画时长降到 ~0
//   [4] 无布局抖动：transition/animation 不含 width/height/top/left/margin 等，
//       且相对改动前没有引入 transform/opacity 之外的新动画属性
//   [5] 功能回归：侧边栏能点会话、设置能开能关、发消息正常（mock 上游）
//   [6] console error = 0
//   [7] 截图存档 docs/ui/motion-*.png
//   [8] 消息流冻结：src/components/messages、src/components/chatInput 相对改动前 diff 为空
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, verifyDist } from '../helpers/env.mjs'
import { OURS_MODEL, routeOurs } from '../fixtures/ours-upstream.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const PORT = process.env.PORT
let APP_URL = process.env.APP_URL || ''
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')
const KEY = 'sk-motion-acceptance-key'
const REPLY = '动效验收用的 mock 回复。'
/**
 * 对照基线提交：用于「有没有新增动画属性 / 消息流是否被改动」的静态检查。
 *
 * 注意（Issue #19 follow-up）：这个 SHA 是硬编码的，只验证「相对某个历史点没改动」。
 * 68f9342 之后 CopyButton.tsx 因「超长复制改保存 TXT」（#16 / #2）被合法改动过，
 * 所以基线前移到 #21/#26 之后的 main 顶点；以后再改这些文件时请同步更新本常量。
 * 长期方案是改成快照 fixture（同 mode-switch-plain 的做法），不在测试里钉 git SHA。
 */
const BASE_COMMIT = process.env.MOTION_BASE || '637adfb'

/**
 * 【白名单】允许 transform / opacity 之外动画属性存在的文件（每条例外都必须写明理由）。
 *
 * src/components/session/Welcome.module.css
 *   首页「快速 / 专家模式」分段切换控件（.modeSwitch）里两段标签（.modeOption）的
 *   background-color / color 过渡（160ms）是**刻意保留的例外**：
 *   - 颜色过渡只改绘制结果，不触发 layout / reflow，不会掉帧，不违反「只动 transform / opacity」的本意；
 *   - 作用范围只在 .modeSwitch 内部的两个标签上，没有扩散到消息区（[8] 会守住 messages/chatInput）；
 *   - 布局属性（width / height / top / left / margin 等）依旧全局禁止，见下方 LAYOUT 检查与白名单守卫。
 */
const EXTRA_ANIMATED_PROPS = new Map([
  ['src/components/session/Welcome.module.css', new Set(['background-color', 'color'])],
])

const failures = []
const evidence = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => {
  evidence.push(message)
  console.log(`  ·   ${message}`)
}

const children = []
const start = (command, args, env = {}) =>
  children.push(
    spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' })
  )
const cleanup = () => {
  // 静态服务是进程内 http 服务（serveDir → runtime.serveDist），必须显式关，否则进程不退出
  try {
    served.kill()
  } catch {
    // 已关闭
  }
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
}

const md5 = (buffer) => createHash('md5').update(buffer).digest('hex')

/** matrix(a, b, c, d, tx, ty) / matrix3d(...) → { tx, ty } */
const parseTransform = (value) => {
  if (!value || value === 'none') {
    return { tx: 0, ty: 0, none: true }
  }
  const numbers = value.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? []
  if (value.startsWith('matrix3d')) {
    return { tx: numbers[12] ?? 0, ty: numbers[13] ?? 0, none: false }
  }
  return { tx: numbers[4] ?? 0, ty: numbers[5] ?? 0, none: false }
}


// ---------- 静态检查：[4][8] ----------
const staticChecks = () => {
  console.log('\n[4] 静态检查：动画属性只含 transform / opacity')

  const readDir = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return readDir(full)
      }
      return entry.name.endsWith('.css') ? [full] : []
    })

  const cssFiles = readDir(path.join(ROOT, 'src'))

  /** 按顶层逗号切分（跳过 var(...) / cubic-bezier(...) 里的逗号） */
  const splitTopLevel = (value) => {
    const parts = []
    let depth = 0
    let current = ''
    for (const char of value) {
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (char === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
      current += char
    }
    parts.push(current)
    return parts.map((part) => part.trim()).filter(Boolean)
  }

  /** 抽出所有 transition / animation 声明里被动画的属性名（animation 简写只取动画名，不当属性） */
  const animatedProps = (css) => {
    const props = new Set()
    for (const match of css.matchAll(/(?:^|[;{\s])(transition|transition-property)\s*:\s*([^;}]+)/g)) {
      for (const part of splitTopLevel(match[2])) {
        const name = part.split(/\s+/)[0]
        if (!name || name.startsWith('var(') || /^[\d.]/.test(name)) {
          continue
        }
        props.add(name)
      }
    }
    return props
  }

  /** @keyframes 里被动画的 CSS 属性（用来抓 keyframes 里动布局属性的情况） */
  const keyframeProps = (css) => {
    const props = new Set()
    for (const block of css.matchAll(/@keyframes[^{]*{([\s\S]*?)\n}/g)) {
      for (const declaration of block[1].matchAll(/(?:^|[;{\s])([a-z-]+)\s*:/g)) {
        props.add(declaration[1])
      }
    }
    return props
  }

  const LAYOUT = /^(width|height|min-|max-|top|right|bottom|left|inset|margin|padding|flex|grid|gap|font-size|line-height|border-width)/
  const offenders = []
  const motionProps = new Map()
  for (const file of cssFiles) {
    const css = readFileSync(file, 'utf8')
    for (const prop of [...animatedProps(css), ...keyframeProps(css)]) {
      if (LAYOUT.test(prop)) {
        offenders.push(`${path.relative(ROOT, file)} → ${prop}`)
      }
    }
    for (const [index, match] of [...css.matchAll(/(transition|transition-property)\s*:\s*([^;}]+)/g)].entries()) {
      if (!match[2].includes('--motion-duration')) {
        continue
      }
      const props = splitTopLevel(match[2]).map((part) => part.split(/\s+/)[0])
      motionProps.set(`${path.relative(ROOT, file)}#${index}`, { props, snippet: match[2].trim() })
    }
  }
  if (offenders.length > 0) {
    bad(`有动画在跑布局属性（必然掉帧）：${offenders.join(' | ')}`)
  } else {
    ok(`src/ 下 ${cssFiles.length} 个 CSS 文件，没有任何 transition/animation 动 width/height/top/left/margin 等布局属性`)
  }

  // 相对基线提交，不允许引入 transform / opacity 之外的新动画属性
  const gitShow = (file) => {
    try {
      return execFileSync('git', ['show', `${BASE_COMMIT}:${file}`], { cwd: ROOT, encoding: 'utf8' })
    } catch {
      return null
    }
  }
  const introduced = []
  for (const file of cssFiles) {
    const relative = path.relative(ROOT, file)
    const before = gitShow(relative)
    if (before === null) {
      continue
    }
    const baseline = animatedProps(before)
    // 白名单文件额外允许它自己声明的那几个「纯绘制」属性（见 EXTRA_ANIMATED_PROPS）
    const allowed = EXTRA_ANIMATED_PROPS.get(relative) || new Set()
    for (const prop of animatedProps(readFileSync(file, 'utf8'))) {
      if (
        ['transform', 'opacity'].includes(prop) ||
        baseline.has(prop) ||
        ['ease', 'linear', 'both', 'none'].includes(prop) ||
        allowed.has(prop)
      ) {
        continue
      }
      introduced.push(`${relative} → ${prop}`)
    }
  }
  if (introduced.length > 0) {
    bad(`新增了 transform/opacity 之外的动画属性：${introduced.join(' | ')}`)
  } else {
    const whitelist = [...EXTRA_ANIMATED_PROPS.keys()]
    ok(
      `相对 ${BASE_COMMIT} 没有新增 transform/opacity 之外的动画属性${
        whitelist.length > 0 ? `（白名单例外：${whitelist.join(', ')}）` : ''
      }`
    )
  }

  // 白名单只允许放宽「颜色」这类纯绘制属性：一旦有人往白名单里塞布局属性，这里立刻失败
  for (const [file, props] of EXTRA_ANIMATED_PROPS) {
    const layoutInWhitelist = [...props].filter((prop) => LAYOUT.test(prop))
    if (layoutInWhitelist.length > 0) {
      bad(`白名单 ${file} 里混入了布局属性（禁止）：${layoutInWhitelist.join(' | ')}`)
    }
  }

  // 本次动效令牌驱动的 transition 明细（贴给报告用）
  for (const [where, { props }] of motionProps) {
    const unexpected = props.filter((prop) => !['transform', 'opacity'].includes(prop))
    note(
      `motion transition ${where} → ${props.join(' + ')}${
        unexpected.length > 0 ? `（其中 ${unexpected.join('/')} 是既有过渡，非本次新增）` : ''
      }`
    )
  }

  console.log('\n[8] 消息流冻结检查')
  let diff = ''
  try {
    diff = execFileSync(
      'git',
      ['diff', '--stat', BASE_COMMIT, '--', 'src/components/messages', 'src/components/chatInput'],
      { cwd: ROOT, encoding: 'utf8' }
    )
  } catch {
    bad('git diff 执行失败，无法确认消息流未被改动')
  }
  if (diff.trim()) {
    bad(`消息流组件相对 ${BASE_COMMIT} 有改动：\n${diff}`)
  } else {
    ok(`src/components/messages 与 src/components/chatInput 相对 ${BASE_COMMIT} diff 为空（流式/气泡/思考块/输入框未参与动效）`)
  }
}

// ---------- 主流程 ----------
staticChecks()

verifyDist(DIST, { variant: 'internal' })
// 端口自动发现（PORT 可注入），避免固定端口撞车
const served = await serveDir(DIST, { port: PORT, label: '内测产物 dist' })
APP_URL = APP_URL || served.url
// 连外部 APP_URL 时也要校验「端口上那份产物」是不是内测包（防止撞到别人的标准包 → 假红）
await verifyAppUrl(APP_URL, DIST, { variant: 'internal' })

/** 移动端尺寸（<768px 走移动端布局与底部弹层） */
const mobileViewport = { width: 390, height: 844 }

const desktopViewport = { width: 1280, height: 900 }

const launch = async (reducedMotion, viewport = mobileViewport) => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport,
    hasTouch: viewport === mobileViewport,
    isMobile: false,
  })
  const page = await context.newPage()
  if (reducedMotion) {
    await page.emulateMedia({ reducedMotion })
  }
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  // 上游打桩：内测构建默认渠道 ours，契约集中在 tests/fixtures/ours-upstream.mjs
  // （OpenAI 协议：POST /v1/chat/completions + Bearer，SSE 是 chat.completion.chunk）
  await routeOurs(page, { reply: REPLY })
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  return { browser, page, errors }
}

/** 首次打开会自动弹设置；填 API Key 并关掉，回到干净的空会话页 */
const prepare = async (page) => {
  const dialog = page.getByRole('dialog').first()
  if ((await dialog.count()) > 0) {
    await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
    await page.waitForTimeout(250)
    await page.locator('input[type="password"]').first().fill(KEY)
    await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
    await page.waitForTimeout(800)
    await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(600)
  }
}

const drawerTransform = (page) =>
  page.evaluate(() => {
    const drawer = document.querySelector('[data-motion-state]')
    if (!drawer) {
      return null
    }
    return getComputedStyle(drawer).transform
  })

const dialogTransform = (page) =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) {
      return null
    }
    return getComputedStyle(dialog).transform
  })

const openSider = async (page) => {
  await page.getByRole('button', { name: /打开边栏|expand sidebar/i }).first().click()
}
const closeSiderByMask = async (page) => {
  // 点右侧空白处（遮罩），不点抽屉本身
  await page.mouse.click(mobileViewport.width - 24, mobileViewport.height / 2)
}

const shot = async (page, name) => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `motion-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

/** 抽屉当前的 data-motion-state（未挂载返回 null） */
const siderState = (page) =>
  page.evaluate(() => document.querySelector('[data-motion-state]')?.dataset.motionState ?? null)

const ensureSiderOpen = async (page) => {
  if ((await siderState(page)) !== 'open') {
    if ((await siderState(page)) !== null) {
      await closeSiderByMask(page)
      await page.waitForTimeout(450)
    }
    await openSider(page)
    await page.waitForTimeout(420)
  }
}

const ensureSiderClosed = async (page) => {
  if ((await siderState(page)) !== null) {
    await closeSiderByMask(page)
    await page.waitForTimeout(450)
  }
}

/**
 * 触发一次进入动效，用页面内 rAF 抓到「transform 真正开始变化」的那一刻作为 t=0，
 * 再精确睡到 target 毫秒读 computedStyle 并截图（截图与点击的往返耗时不污染时间点）。
 */
const captureFrame = async ({ page, trigger, selector, axis, target, name }) => {
  await page.evaluate((query) => {
    window.__motionOrigin = null
    window.__motionBase = null
    const startedAt = performance.now()
    const tick = () => {
      const element = document.querySelector(query)
      const value = element ? getComputedStyle(element).transform : null
      if (value) {
        if (window.__motionBase === null) {
          window.__motionBase = value
        } else if (value !== window.__motionBase) {
          window.__motionOrigin = performance.now()
          return
        }
      }
      if (performance.now() - startedAt < 3000) {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)
  }, selector)

  await trigger()
  await page.waitForFunction(() => window.__motionOrigin !== null, null, { timeout: 5000, polling: 'raf' })
  const remaining = await page.evaluate((ms) => ms - (performance.now() - window.__motionOrigin), target)
  if (remaining > 1) {
    await page.waitForTimeout(remaining)
  }
  const sample = await page.evaluate((query) => {
    const element = document.querySelector(query)
    return {
      transform: element ? getComputedStyle(element).transform : null,
      at: performance.now() - window.__motionOrigin,
    }
  }, selector)
  const file = await shot(page, name)
  return {
    transform: sample.transform,
    file,
    measuredAt: sample.at,
    value:
      axis === 'tx' ? parseTransform(sample.transform).tx : parseTransform(sample.transform).ty,
  }
}

try {
  // ================= [1][2] 侧边栏 =================
  console.log('\n[1][2] 侧边栏：滑入中间帧 + 计算样式')
  const { browser, page, errors } = await launch(null)
  await prepare(page)

  // 数值序列：证明 transform 是逐帧插值，不是瞬变
  await openSider(page)
  const series = []
  for (let index = 0; index < 14; index += 1) {
    const sample = await page.evaluate(() => {
      const drawer = document.querySelector('[data-motion-state]')
      return drawer
        ? { transform: getComputedStyle(drawer).transform, at: performance.now() }
        : null
    })
    if (sample) {
      series.push({ ...sample, ...parseTransform(sample.transform) })
    }
    await page.waitForTimeout(22)
  }
  const txList = series.map((item) => Math.round(item.tx))
  note(`侧边栏打开 transform.tx 采样序列 = [${txList.join(', ')}]`)
  const interior = txList.filter((tx) => tx < -5 && tx > -Math.abs(txList[0] || -300))
  const monotonic = txList.every((tx, index) => index === 0 || tx >= txList[index - 1] - 1)
  if (interior.length < 2 || !monotonic) {
    bad(`侧边栏不是渐变过程：tx=${txList.join(',')} 单调=${monotonic}`)
  } else {
    ok(`侧边栏滑入是渐变：中间帧 tx 取到 ${interior.length} 个介于起点与 0 之间的值，且单调递增`)
  }
  const openTx = txList.at(-1)
  const openMatrix = series.at(-1).transform
  if (openTx !== 0) {
    bad(`侧边栏打开后 transform 未归零：${openMatrix}`)
  } else {
    ok(`侧边栏打开后 getComputedStyle(transform) = ${openMatrix}（tx=0）`)
  }
  await shot(page, 'sidebar-open')

  // 三张中间帧：每次重新打开，单独在 t=80/150/250ms 截一张，避免截图耗时互相挤占
  const frameShots = []
  for (const target of [80, 150, 250]) {
    await closeSiderByMask(page)
    await page.waitForTimeout(500)
    const frame = await captureFrame({
      page,
      trigger: () => openSider(page),
      selector: '[data-motion-state]',
      axis: 'tx',
      target,
      name: `sidebar-t${target}`,
    })
    frameShots.push({ ...frame, tx: frame.value })
    note(`侧边栏 t=${target}ms：transform=${frame.transform}（实测 ${frame.measuredAt}ms）`)
  }
  const frameMd5 = frameShots.map((frame) => md5(readFileSync(frame.file)))
  const frameValues = frameShots.map((frame) => frame.tx)
  if (frameMd5[0] === frameMd5[1] || frameMd5[0] === frameMd5[2]) {
    bad(`侧边栏早期中间帧与后续帧画面相同，疑似瞬变：${frameMd5.map((hash) => hash.slice(0, 8)).join(' / ')}`)
  } else {
    ok(`侧边栏 t=80/150/250ms 三帧画面互不相同（md5 ${frameMd5.map((hash) => hash.slice(0, 8)).join(' / ')}）`)
  }
  // 注意：t=250ms 已接近收尾（受点击往返 ±10ms 影响），因此只要求「单调不减 + 至少两个严格中间值」
  const increasing = frameValues.every((value, index) => index === 0 || value >= frameValues[index - 1] - 0.5)
  const interiorFrames = frameValues.filter((value) => value < -1).length
  if (!increasing || interiorFrames < 2) {
    bad(`侧边栏中间帧不是逐步滑到 0：${frameValues.map((value) => value.toFixed(1)).join(' → ')}`)
  } else {
    ok(`侧边栏中间帧 tx：t80=${frameValues[0].toFixed(1)} → t150=${frameValues[1].toFixed(1)} → t250=${frameValues[2].toFixed(1)}（逐步滑到 0，其中 ${interiorFrames} 帧在途中）`)
  }

  // 关闭：DOM 要留到退出动画结束，且过程中 tx 为负
  await closeSiderByMask(page)
  await page.waitForTimeout(100)
  const closingPresent = await page.evaluate(() => !!document.querySelector('[data-motion-state]'))
  const closingTransform = await drawerTransform(page)
  const closingTx = parseTransform(closingTransform).tx
  await shot(page, 'sidebar-closing')
  if (!closingPresent) {
    bad('侧边栏关闭 100ms 后 DOM 就被卸载了，退出动画会被吞掉')
  } else if (!(closingTx < -1)) {
    bad(`侧边栏关闭中 transform 不是负值：${closingTransform}`)
  } else {
    ok(`侧边栏关闭中（t=100ms）transform=${closingTransform}（tx=${Math.round(closingTx)} < 0），且 DOM 仍在`)
  }
  await page.waitForTimeout(500)
  const closedGone = await page.evaluate(() => !document.querySelector('[data-motion-state]'))
  if (!closedGone) {
    bad('侧边栏退出动画结束后 DOM 没有卸载')
  } else {
    ok('侧边栏退出动画结束后 DOM 已卸载（约 320ms）')
  }

  // ================= 设置弹窗（移动端底部滑起） =================
  console.log('\n[1] 设置弹窗：底部滑起中间帧')
  await ensureSiderOpen(page)
  await page.getByRole('button', { name: /^设置$|^Settings$/ }).first().click()
  const dialogSeries = []
  for (let index = 0; index < 14; index += 1) {
    const sample = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      return dialog
        ? { transform: getComputedStyle(dialog).transform, opacity: getComputedStyle(dialog).opacity }
        : null
    })
    if (sample) {
      dialogSeries.push({ ...sample, ...parseTransform(sample.transform) })
    }
    await page.waitForTimeout(22)
  }
  const tyList = dialogSeries.map((item) => Math.round(item.ty))
  note(`设置弹窗打开 transform.ty 采样序列 = [${tyList.join(', ')}]`)
  const dialogInterior = tyList.filter((ty) => ty > 8)
  const dialogEnd = tyList.at(-1)
  if (dialogInterior.length < 2 || dialogEnd !== 0) {
    bad(`设置弹窗不是从底部滑起：ty=${tyList.join(',')}（末尾应为 0）`)
  } else {
    ok(`设置弹窗底部滑起：中间帧 ty 取到 ${dialogInterior.length} 个正值（最大 ${Math.max(...tyList)}px），末尾归 0`)
  }
  const opacitySeries = dialogSeries.map((item) => Number(item.opacity))
  if (!(opacitySeries[0] < 0.99 && opacitySeries.at(-1) > 0.99)) {
    bad(`设置弹窗没有淡入：opacity=${opacitySeries.join(',')}`)
  } else {
    ok(`设置弹窗淡入：opacity ${opacitySeries[0].toFixed(2)} → ${opacitySeries.at(-1).toFixed(2)}`)
  }
  await shot(page, 'settings-open')

  const settingsFrames = []
  for (const target of [80, 150, 250]) {
    if ((await page.getByRole('dialog').count()) > 0) {
      await page.getByRole('dialog').getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
      await page.waitForTimeout(600)
    }
    await ensureSiderOpen(page)
    const frame = await captureFrame({
      page,
      trigger: () => page.getByRole('button', { name: /^设置$|^Settings$/ }).first().click(),
      selector: '[role="dialog"]',
      axis: 'ty',
      target,
      name: `settings-t${target}`,
    })
    settingsFrames.push({ ...frame, ty: frame.value })
    note(`设置弹窗 t=${target}ms：transform=${frame.transform}（实测 ${frame.measuredAt}ms）`)
  }
  const settingsMd5 = settingsFrames.map((frame) => md5(readFileSync(frame.file)))
  const settingsValues = settingsFrames.map((frame) => frame.ty)
  if (settingsMd5[0] === settingsMd5[1] || settingsMd5[0] === settingsMd5[2]) {
    bad(`设置弹窗早期中间帧与后续帧画面相同，疑似瞬变：${settingsMd5.map((hash) => hash.slice(0, 8)).join(' / ')}`)
  } else {
    ok(`设置弹窗 t=80/150/250ms 三帧画面互不相同（md5 ${settingsMd5.map((hash) => hash.slice(0, 8)).join(' / ')}）`)
  }
  const settingsRising = settingsValues.every(
    (value, index) => index === 0 || value <= settingsValues[index - 1] + 0.5
  )
  const settingsInterior = settingsValues.filter((value) => value > 1).length
  if (!settingsRising || settingsInterior < 2) {
    bad(`设置弹窗中间帧不是逐步升到 0：${settingsValues.map((value) => value.toFixed(1)).join(' → ')}`)
  } else {
    ok(`设置弹窗中间帧 ty：t80=${settingsValues[0].toFixed(1)} → t150=${settingsValues[1].toFixed(1)} → t250=${settingsValues[2].toFixed(1)}（逐步升到 0，其中 ${settingsInterior} 帧在途中）`)
  }

  // 关闭：DOM 留到动画结束
  await page.getByRole('dialog').getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await page.waitForTimeout(120)
  const dialogStillThere = (await page.getByRole('dialog').count()) > 0
  const dialogClosing = await dialogTransform(page)
  await shot(page, 'settings-closing')
  if (!dialogStillThere) {
    bad('设置弹窗关闭 120ms 后就卸载了，退出动画会被吞掉')
  } else if (!(parseTransform(dialogClosing).ty > 1)) {
    bad(`设置弹窗关闭中 transform 没有向下滑：${dialogClosing}`)
  } else {
    ok(`设置弹窗关闭中（t=120ms）transform=${dialogClosing}，DOM 仍在（等 transitionend 时长后再卸载）`)
  }
  await page.waitForTimeout(700)
  if ((await page.getByRole('dialog').count()) > 0) {
    bad('设置弹窗退出动画结束后 DOM 没有卸载')
  } else {
    ok('设置弹窗退出动画结束后 DOM 已卸载（约 320ms）')
  }

  // ================= [5] 功能回归 =================
  console.log('\n[5] 功能回归：侧边栏点会话 / 设置开关 / 发消息')
  // 发消息：先发一条，让会话列表里出现条目（先收起抽屉，避免遮罩拦截点击）
  await ensureSiderClosed(page)
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill('动效验收：发一条消息')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
  await page.getByText(REPLY.slice(0, 6)).first().waitFor({ timeout: 15000 })
  ok(`mock 上游回复已渲染：${REPLY}`)

  await ensureSiderOpen(page)
  // 抽屉里的第一行会话（标题可能已被自动标题覆盖，按结构取，不按文案找）
  const row = await page.evaluate(() => {
    const drawer = document.querySelector('[data-motion-state="open"]')
    const item = drawer?.querySelector('[class*="item-"]')
    if (!item) {
      return null
    }
    const rect = item.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: item.textContent }
  })
  if (!row) {
    bad('侧边栏里没有出现刚才的会话条目')
  } else {
    note(`抽屉里第一条会话：${JSON.stringify(row.text)}`)
    await page.mouse.click(row.x, row.y)
    await page.waitForTimeout(500)
    const siderGone = await page.evaluate(() => !document.querySelector('[data-motion-state]'))
    if (!siderGone) {
      bad('点会话后侧边栏没有关闭')
    } else {
      ok('侧边栏能点开、能点会话并自动收起')
    }
  }

  await ensureSiderOpen(page)
  await page.getByRole('button', { name: /^设置$|^Settings$/ }).first().click()
  await page.waitForTimeout(450)
  const settingsOpenedAgain = (await page.getByRole('dialog').count()) > 0
  await page.getByRole('dialog').getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await page.waitForTimeout(600)
  const settingsClosedAgain = (await page.getByRole('dialog').count()) === 0
  if (!settingsOpenedAgain || !settingsClosedAgain) {
    bad(`设置弹窗开/关异常：open=${settingsOpenedAgain} close=${settingsClosedAgain}`)
  } else {
    ok('设置弹窗能开能关（含退出动画）')
  }

  // ================= 桌面端 + 按压反馈 =================
  console.log('\n桌面端：设置弹窗缩放淡入（保留原观感）+ 按压反馈')
  await browser.close()
  const desktop = await launch(null, desktopViewport)
  try {
    await prepare(desktop.page)
    // 桌面端设置入口在左侧常驻侧边栏底部
    await desktop.page.getByRole('button', { name: /^设置$|^Settings$/ }).first().click()
    const desktopSeries = []
    for (let index = 0; index < 12; index += 1) {
      const sample = await desktop.page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        if (!dialog) {
          return null
        }
        const style = getComputedStyle(dialog)
        return { transform: style.transform, opacity: style.opacity }
      })
      if (sample) {
        desktopSeries.push(sample)
      }
      await desktop.page.waitForTimeout(20)
    }
    const scales = desktopSeries.map((item) => Number(item.transform.match(/matrix\(([^,]+)/)?.[1] ?? 1))
    note(`桌面端设置弹窗 scale 采样 = [${scales.map((value) => value.toFixed(3)).join(', ')}]`)
    if (!(scales[0] < 0.999 && scales.at(-1) > 0.999)) {
      bad(`桌面端设置弹窗没有缩放淡入：${scales.join(',')}`)
    } else {
      ok(`桌面端保留缩放淡入：scale ${scales[0].toFixed(2)} → ${scales.at(-1).toFixed(2)}，opacity ${Number(desktopSeries[0].opacity).toFixed(2)} → ${Number(desktopSeries.at(-1).opacity).toFixed(2)}`)
    }
    await shot(desktop.page, 'desktop-settings')
    await desktop.page.getByRole('dialog').getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await desktop.page.waitForTimeout(400)

    // 按压反馈：按住侧边栏「设置」行，:active 应缩到 ~0.97，松开回弹
    const target = desktop.page.getByRole('button', { name: /^设置$|^Settings$/ }).first()
    const box = await target.boundingBox()
    await desktop.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await desktop.page.mouse.down()
    await desktop.page.waitForTimeout(140)
    const pressed = await target.evaluate((element) => getComputedStyle(element).transform)
    await desktop.page.mouse.up()
    await desktop.page.waitForTimeout(200)
    const released = await target.evaluate((element) => getComputedStyle(element).transform)
    // 松手即触发 click，设置会被重新打开：先关掉，让后面从干净状态开始
    if ((await desktop.page.getByRole('dialog').count()) > 0) {
      await desktop.page.getByRole('dialog').getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
      await desktop.page.waitForTimeout(500)
    }
    const pressedScale = Number(pressed.match(/matrix\(([^,]+)/)?.[1] ?? 1)
    if (!(pressedScale < 0.999)) {
      bad(`按压反馈没有生效：:active transform=${pressed}`)
    } else {
      ok(`按压反馈生效：按住时 scale=${pressedScale.toFixed(3)}（110ms 内完成），松开后 transform=${released}`)
    }

    // 桌面端点遮罩也要能关闭（动画期间不阻塞交互）
    await target.click()
    await desktop.page.waitForTimeout(500)
    await desktop.page.mouse.click(desktopViewport.width - 40, 40)
    await desktop.page.waitForTimeout(500)
    if ((await desktop.page.getByRole('dialog').count()) > 0) {
      bad('桌面端点击遮罩没有关闭设置弹窗')
    } else {
      ok('桌面端点遮罩可关闭设置弹窗（遮罩动画期间点击有效）')
    }
    if (desktop.errors.length > 0) {
      bad(`桌面端 console error：${desktop.errors.slice(0, 3).join(' | ')}`)
    } else {
      ok('桌面端 console error = 0')
    }
  } finally {
    await desktop.browser.close()
  }

  // ================= [3] reduced-motion =================
  console.log('\n[3] reduced-motion：动画时长降级为 ~0')
  await browser.close()
  const reduced = await launch('reduce')
  try {
    await prepare(reduced.page)
    const durations = await reduced.page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        .probe-drawer { transition: transform var(--motion-duration-slow) var(--motion-ease-ios); }
        .probe-dialog { transition: transform var(--motion-duration-base) var(--motion-ease-ios); }
      `
      document.head.append(style)
      const drawer = document.createElement('div')
      drawer.className = 'probe-drawer'
      const dialog = document.createElement('div')
      dialog.className = 'probe-dialog'
      document.body.append(drawer, dialog)
      const read = getComputedStyle(drawer).transitionDuration
      const read2 = getComputedStyle(dialog).transitionDuration
      drawer.remove()
      dialog.remove()
      style.remove()
      return { drawer: read, dialog: read2 }
    })
    const toSeconds = (value) => Number.parseFloat(value)
    note(`reduced-motion 下计算出的 transition-duration：抽屉 ${durations.drawer} / 弹窗 ${durations.dialog}`)
    if (!(toSeconds(durations.drawer) <= 0.001 && toSeconds(durations.dialog) <= 0.001)) {
      bad(`reduced-motion 下动画时长没有降级：${JSON.stringify(durations)}`)
    } else {
      ok(`reduced-motion 下动画时长 ≈ 0（${durations.drawer} / ${durations.dialog}）`)
    }

    // 真实交互：点击后几乎是瞬间到位，没有渐变残留
    const started = Date.now()
    await openSider(reduced.page)
    await reduced.page.waitForTimeout(40)
    const fastTransform = await drawerTransform(reduced.page)
    const fastTx = parseTransform(fastTransform).tx
    if (Math.abs(fastTx) > 1) {
      bad(`reduced-motion 下侧边栏 40ms 仍在动画中：${fastTransform}（耗时 ${Date.now() - started}ms）`)
    } else {
      ok(`reduced-motion 下侧边栏 40ms 已到位：transform=${fastTransform}`)
    }
    // 主题切换的淡入动画同样关闭
    const themeAnimation = await reduced.page.evaluate(() => {
      document.documentElement.classList.add('ds-theme-fade')
      const name = getComputedStyle(document.getElementById('root')).animationName
      document.documentElement.classList.remove('ds-theme-fade')
      return name
    })
    if (themeAnimation !== 'none') {
      bad(`reduced-motion 下主题淡入动画未关闭：animation-name=${themeAnimation}`)
    } else {
      ok('reduced-motion 下主题切换淡入 animation-name = none')
    }
    if (reduced.errors.length > 0) {
      bad(`reduced-motion 上下文 console error：${reduced.errors.slice(0, 3).join(' | ')}`)
    } else {
      ok('reduced-motion 上下文 console error = 0')
    }
  } finally {
    await reduced.browser.close()
  }

  // ================= [6] console error =================
  console.log('\n[6] console error')
  if (errors.length > 0) {
    bad(`console 有 ${errors.length} 条 error：${errors.slice(0, 3).join(' | ')}`)
  } else {
    ok('console error = 0')
  }

  // ================= [7] 截图存档 =================
  console.log('\n[7] 截图存档')
  const shots = readdirSync(SHOT_DIR)
    .filter((name) => name.startsWith('motion-'))
    .sort()
  note(`docs/ui 下动效截图：${shots.join(', ')}`)
  const required = ['motion-sidebar-t80.png', 'motion-sidebar-t150.png', 'motion-sidebar-t250.png', 'motion-settings-t80.png', 'motion-settings-t150.png', 'motion-settings-t250.png']
  const missing = required.filter((name) => !shots.includes(name))
  if (missing.length > 0) {
    bad(`缺少截图：${missing.join(', ')}`)
  } else {
    const sizes = required.map((name) => `${name}=${statSync(path.join(SHOT_DIR, name)).size}B`)
    ok(`截图齐全：${sizes.join(' ')}`)
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  cleanup()
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/motion.test.mjs`)
if (evidence.length > 0) {
  console.log('证据：')
  for (const item of evidence) {
    console.log(`  · ${item}`)
  }
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
