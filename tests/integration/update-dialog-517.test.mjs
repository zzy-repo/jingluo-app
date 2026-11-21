// [layer: integration | 依赖: playwright + chromium + 自建标准产物（dist-update-dialog） | 耗时: ~4min]
//
// 更新策略弹窗（Issue #517）—— **只有真浏览器能验证的那一半**。
//
// L0（`tests/unit/update-policy-517.test.mjs`）已经把「该判哪一档」的规则钉死了；这里钉的是
// 一个纯函数问不出来的问题：
//   · forced 弹窗到底关不关得掉 —— 返回键 / Esc / 点遮罩，三个入口都要真的没反应；
//   · soft 点「稍后提醒」之后，snooze 真的落进本地设置，且 snooze 期内再检查确实不弹；
//   · normal 弹窗随时可关（关闭 / Esc / 点遮罩三条路都成立）；
//   · 没下发策略的清单**不弹**策略弹窗（老服务端零回归），结果仍在设置面板里；
//   · 长更新说明能滚、底部按钮常驻、390 / 360 与深浅色两套主题都看得清。
//
// 返回键怎么模拟：Android 硬件返回在 Capacitor 里最终落到 `WebView.goBack()`，也就是浏览器 back。
// 所以这里用 `history.back()`（真浏览器同文档历史回退）压 `popstate`，比派发一个假 keydown 更接近真机。
//
// 跑法（仓库根目录，**不需要**预先构建：用例自己编一份标准产物，见文件末尾的产物说明）：
//   node tests/run-layer.mjs integration --case tests/integration/update-dialog-517.test.mjs
//   node tests/integration/update-dialog-517.test.mjs
//   UPDATE_DIALOG_DIST=<已有标准产物目录> node tests/integration/update-dialog-517.test.mjs  # 跳过构建

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { chromium } from 'playwright'
import { CURRENT, CHANNEL_BUILD_TYPE, NEWEST_INSTALLABLE } from '../helpers/current-version.mjs'
import { readBuildInfo, serveDir, skipEnv, ROOT } from '../helpers/env.mjs'

const require = createRequire(import.meta.url)
/** 截图落点：与仓库既有 UI 取证一致（docs/ui/ 是入库的实拍目录，PR 里直接给路径） */
const SHOTS = path.join(ROOT, 'docs', 'ui')

/** 两台分发机（与 src/services/updateManifest.ts 的 RELEASE_BASES 同源） */
const PRIMARY = 'http://62.106.70.167:8888'
const FALLBACK = 'https://dl.rose7.cn'

const NEW_VERSION = NEWEST_INSTALLABLE.version
const RELEASE_FILE = `apk/deepseek-chat-${NEW_VERSION}.apk`
/** snooze 的存储键（与 src/services/settings.ts 的 KEYS.updateSnoozeUntil 同源） */
const SNOOZE_KEY = 'chat-demo:update-snooze-until'
const HOUR = 60 * 60 * 1000

/** 与线上同形状的一条发布记录；`updatePolicy` 由各场景自己给 */
const release = (over = {}) => ({
  version: NEW_VERSION,
  versionCode: NEWEST_INSTALLABLE.versionCode,
  size: 5452595,
  file: RELEASE_FILE,
  changes: ['修复旧机型白屏', '下载失败不再残留满格进度'],
  buildType: CHANNEL_BUILD_TYPE,
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
  releasedAt: '2026-11-20T10:00:00+08:00',
  ...over,
})

const manifestBody = (releases) => JSON.stringify({ releases })

/** 拦两台分发机的清单（只拦旧机会让首选机真的连出去：CI 上今天绿明天红） */
const routeManifest = async (context, releases) => {
  const fulfill = async (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET',
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: manifestBody(releases),
    })
  await context.route(`${PRIMARY}/releases.json`, fulfill)
  await context.route(`${FALLBACK}/releases.json`, fulfill)
}

/** 打开 设置 → 应用更新（不点检查：进入设置面板本身不触发检查） */
const openSettings = async (page) => {
  const entry = page.getByRole('button', { name: '检查更新', exact: true })
  if (!(await entry.isVisible().catch(() => false))) {
    const menu = page.getByRole('button', { name: '打开边栏' })
    if (await menu.isVisible().catch(() => false)) {
      await menu.tap()
      await page.waitForTimeout(320)
    }
    await page.getByRole('button', { name: '设置', exact: true }).last().tap()
  }
  await entry.waitFor({ state: 'visible', timeout: 15000 })
}

/**
 * 点「检查更新」，等结论行出现（弹不弹策略弹窗由断言看）。
 *
 * 判定用「面板里的『重新检查』在不在」而不是「入口按钮可不可见」：设置面板一旦打开，
 * 列表里的「检查更新」入口就被自己的遮罩盖住（可见但点不到），拿它当判据会白等 30s。
 */
const runCheck = async (page) => {
  const again = page.getByRole('button', { name: '重新检查' })
  if (await again.isVisible().catch(() => false)) {
    await again.tap()
  } else {
    const entry = page.getByRole('button', { name: '检查更新', exact: true })
    await entry.waitFor({ state: 'visible', timeout: 15000 })
    await entry.scrollIntoViewIfNeeded()
    await page.waitForTimeout(120)
    await entry.tap()
  }
  await page.getByText('发现新版本，确认后再下载。').first().waitFor({ timeout: 15000 })
  // 给弹窗的挂载 + 进场动画一点时间（reducedMotion 下也是同步的，但别抢在 React 提交之前读 DOM）
  await page.waitForTimeout(120)
}

/** 页面内取数：策略弹窗的结构、按钮、snooze 台账、深浅色与滚动能力 */
const probe = () => {
  const node = document.querySelector('[data-testid="update-dialog"]')
  const card = node === null ? null : node.closest('[role="dialog"]')
  const footer = card === null ? null : card.lastElementChild
  const main = card === null ? null : (card.firstElementChild?.nextElementSibling ?? null)
  const text = (el) => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim()
  const round = (value) => Math.round(value * 10) / 10
  const rect = card === null ? null : card.getBoundingClientRect()
  const cardStyle = card === null ? null : getComputedStyle(card)
  return {
    open: node !== null,
    mode: node?.getAttribute('data-update-mode') ?? null,
    notice: text(node?.querySelector('[data-testid="update-dialog-notice"]')),
    reason: text(node?.querySelector('[data-testid="update-dialog-reason"]')),
    title: text(card?.querySelector('h3')),
    current: text(node?.querySelector('[data-testid="update-dialog-current"]')),
    size: text(node?.querySelector('[data-testid="update-dialog-size"]')),
    published: text(node?.querySelector('[data-testid="update-dialog-published"]')),
    changes: [...(node?.querySelectorAll('[data-testid="update-dialog-changes"] li') ?? [])].map(
      (li) => text(li)
    ),
    /** 策略弹窗底部按钮（顺序即渲染顺序） */
    footerButtons: [...(footer?.querySelectorAll('button, a') ?? [])].map((el) => text(el)),
    /** 整页按钮（用来看「面板里的确认下载」是否被弹窗接管） */
    pageButtons: [...document.querySelectorAll('button, a')].map((el) => text(el)),
    /** 设置面板还在不在（弹窗是叠在面板上的，关掉弹窗还要回到面板） */
    settingsOpen:
      [...document.querySelectorAll('[role="dialog"]')].length > (node === null ? 0 : 1),
    status: text(document.querySelector('[role="status"]')),
    snooze: (() => {
      try {
        return localStorage.getItem('chat-demo:update-snooze-until')
      } catch {
        return null
      }
    })(),
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    card:
      rect === null
        ? null
        : { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height) },
    background: cardStyle?.backgroundColor ?? null,
    mainScroll:
      main === null
        ? null
        : {
            overflowY: getComputedStyle(main).overflowY,
            scrollHeight: Math.round(main.scrollHeight),
            clientHeight: Math.round(main.clientHeight),
          },
    viewportHeight: Math.round(window.innerHeight),
  }
}

/** 三个「关不掉」的入口：Esc / 返回键 / 点遮罩。每次做完都重新取一次状态 */
const tryDismiss = async (page, how) => {
  if (how === 'esc') {
    await page.keyboard.press('Escape')
  } else if (how === 'back') {
    // 真浏览器同文档历史回退 = WebView 的返回键
    await page.evaluate(() => history.back())
  } else {
    // 点遮罩：左上角一定落在卡片外面（卡片居中且最宽 calc(100vw - 32px)）
    await page.mouse.click(6, 6)
  }
  await page.waitForTimeout(260)
  return page.evaluate(probe)
}

/**
 * 长更新说明（23 条，与 #172 现场同量级）。
 *
 * 文案**按序号生成**而不是照抄 domain10 的那 23 条真实说明：两个文件里逐字相同的 20+ 行会被
 * `check:test-duplication` 判成「同一断言分两层写」（R1）。这里要的是「内容足够长」这个性质，
 * 不是那批具体文案 —— 抄一份只会让下次改文案时两处不同步。
 */
const LONG_CHANGES = Array.from(
  { length: 23 },
  (_, index) =>
    `第 ${index + 1} 条更新说明：修复与序号 ${index + 1} 相关的问题，并补充对应的说明文字，确保长内容场景下也能逐条读完整`
)

const VIEW_390 = { label: '390x844', width: 390, height: 844 }
const VIEW_360 = { label: '360x740', width: 360, height: 740 }

// ---------------------------------------------------------------- 矩阵

const SCENARIOS = [
  {
    id: 'D1',
    name: 'forced：弹窗关不掉（Esc / 返回键 / 点遮罩都无效），只留下载出口',
    releases: [release({ updatePolicy: { mode: 'forced', reason: '当前版本存在严重缺陷' } })],
    viewports: [VIEW_390, VIEW_360],
    assert: async (page, read) => {
      const p = await read()
      assert.equal(p.open, true, '下发了 forced 策略就必须弹窗')
      assert.equal(p.mode, 'forced', `弹窗应标成 forced，实际 ${p.mode}`)
      assert.deepEqual(
        p.footerButtons,
        ['下载 APK'],
        `forced 底部只该有下载出口，实际 ${JSON.stringify(p.footerButtons)}`
      )
      assert.equal(p.changes.length, 2, '更新说明应逐条渲染')
      assert.equal(p.title, NEW_VERSION, `弹窗应显示新版本号，实际 ${p.title}`)
      // 发布时间按设备本地时区（用例固定 Asia/Shanghai）收成「YYYY-MM-DD HH:mm」，不是原始 ISO 串
      assert.equal(p.published, '2026-11-20 10:00', `应显示可读的发布时间，实际 ${p.published}`)
      assert.ok(p.current.length > 0, '应显示当前版本')
      assert.ok(p.size.endsWith('MB'), `应显示包大小，实际 ${p.size}`)
      assert.match(p.notice, /必须/, `forced 的说明要讲清「必须更新」：${p.notice}`)
      assert.ok(
        p.reason.includes('当前版本存在严重缺陷'),
        `forced 应展示服务端给的原因：${p.reason}`
      )
      // 三个关闭入口，逐个验证「真的没反应」
      for (const how of ['esc', 'back', 'overlay']) {
        const after = await tryDismiss(page, how)
        assert.equal(after.open, true, `forced 弹窗被「${how}」关掉了（#517 硬要求：关不掉）`)
        assert.equal(
          after.mode,
          'forced',
          `forced 弹窗在「${how}」之后应仍在原档位，实际 ${after.mode}`
        )
      }
      // 卡片必须完整落在视口内（360 档最容易溢出的就是这一屏）
      assert.ok(p.card.top >= -1, `弹窗顶部超出视口：${JSON.stringify(p.card)}`)
      assert.ok(
        p.card.bottom <= p.viewportHeight + 1,
        `弹窗底部超出视口：${JSON.stringify(p.card)}`
      )
    },
  },
  {
    id: 'D2',
    name: '下限优先：versionCode < minSupportedVersionCode 时即使 mode:"normal" 也按 forced 处理',
    releases: [
      release({
        updatePolicy: {
          mode: 'normal',
          minSupportedVersionCode: NEWEST_INSTALLABLE.versionCode + 1000,
        },
      }),
    ],
    viewports: [VIEW_390],
    assert: async (page, read) => {
      const p = await read()
      assert.equal(p.open, true, '低过最低支持版本时必须弹窗')
      assert.equal(p.mode, 'forced', `下限优先于 mode：应判 forced，实际 ${p.mode}`)
      assert.deepEqual(
        p.footerButtons,
        ['下载 APK'],
        `forced 底部不该有「稍后提醒 / 关闭」，实际 ${JSON.stringify(p.footerButtons)}`
      )
      const after = await tryDismiss(page, 'esc')
      assert.equal(after.open, true, '下限顶成 forced 之后同样关不掉（Esc）')
      const afterBack = await tryDismiss(page, 'back')
      assert.equal(afterBack.open, true, '下限顶成 forced 之后同样关不掉（返回键）')
    },
  },
  {
    id: 'D3',
    name: 'soft：点「稍后提醒」→ 写入 snooze → snooze 期内再检查不弹（面板照旧给结论）',
    releases: [release({ updatePolicy: { mode: 'soft', snoozeHours: 24 } })],
    viewports: [VIEW_390],
    assert: async (page, read) => {
      const before = await read()
      assert.equal(before.open, true, 'soft 策略应弹窗')
      assert.equal(before.mode, 'soft', `弹窗应标成 soft，实际 ${before.mode}`)
      assert.deepEqual(
        before.footerButtons,
        ['稍后提醒', '下载 APK'],
        `soft 底部应是「稍后提醒 + 下载」，实际 ${JSON.stringify(before.footerButtons)}`
      )
      assert.ok(before.notice.includes('24'), `soft 说明要带上暂缓时长：${before.notice}`)
      assert.equal(before.snooze, null, '还没点「稍后提醒」时不该有 snooze 记录')

      const clickedAt = Date.now()
      await page.getByTestId('update-dialog-snooze').click()
      await page.waitForTimeout(200)
      const afterSnooze = await read()
      assert.equal(afterSnooze.open, false, '点「稍后提醒」后弹窗应关闭')
      assert.equal(afterSnooze.settingsOpen, true, '关掉弹窗后应回到设置面板（不是把整层都关了）')
      assert.match(afterSnooze.status, /稍后提醒/, `关掉后应有一句可读反馈：${afterSnooze.status}`)

      // snooze 必须真的落进本地设置，且是「现在 + 24h」这个量级的时间戳
      const until = Number(afterSnooze.snooze)
      assert.ok(
        Number.isSafeInteger(until) && until > 0,
        `snooze 应写进 ${SNOOZE_KEY}，实际 ${afterSnooze.snooze}`
      )
      const delta = until - clickedAt
      assert.ok(
        delta > 23.9 * HOUR && delta < 24.1 * HOUR,
        `snooze 到期时刻应是 24 小时之后（服务端下发 24），实际差 ${Math.round(delta / 60000)} 分钟`
      )

      // snooze 期内再检查一次：不弹窗，但设置面板照旧给出「发现新版本」（#517：手动检查仍可见）
      await runCheck(page)
      const again = await read()
      assert.equal(again.open, false, 'snooze 期内再检查不许再弹策略弹窗')
      assert.match(again.status, /发现新版本/, `面板结论必须还在：${again.status}`)
      assert.equal(again.snooze, afterSnooze.snooze, 'snooze 记录不许被这次检查改写')
    },
  },
  {
    id: 'D4',
    name: 'soft + 已过期 snooze：到期后重新弹',
    releases: [release({ updatePolicy: { mode: 'soft', snoozeHours: 24 } })],
    preseed: (now) => ({ [SNOOZE_KEY]: String(now - 60 * 1000) }),
    viewports: [VIEW_390],
    assert: async (page, read) => {
      const p = await read()
      assert.equal(p.open, true, 'snooze 已过期 → 应重新弹窗')
      assert.equal(p.mode, 'soft', `应回到 soft 档位，实际 ${p.mode}`)
    },
  },
  {
    id: 'D5',
    name: 'soft + snooze 有效期内：连弹窗都不出现',
    releases: [release({ updatePolicy: { mode: 'soft', snoozeHours: 24 } })],
    preseed: (now) => ({ [SNOOZE_KEY]: String(now + 6 * HOUR) }),
    viewports: [VIEW_390],
    assert: async (page, read) => {
      const p = await read()
      assert.equal(p.open, false, 'snooze 有效期内不许弹')
      assert.match(p.status, /发现新版本/, `面板结论仍在：${p.status}`)
    },
  },
  {
    id: 'D6',
    name: 'normal：可随时关闭（关闭按钮 / Esc / 点遮罩三条路）',
    releases: [release({ updatePolicy: { mode: 'normal' } })],
    viewports: [VIEW_390],
    assert: async (page, read) => {
      let p = await read()
      assert.equal(p.open, true, 'normal 策略也应弹窗（只是可以随时关）')
      assert.equal(p.mode, 'normal', `弹窗应标成 normal，实际 ${p.mode}`)
      assert.deepEqual(
        p.footerButtons,
        ['关闭', '下载 APK'],
        `normal 底部应是「关闭 + 下载」，实际 ${JSON.stringify(p.footerButtons)}`
      )

      await page.getByTestId('update-dialog-close').click()
      await page.waitForTimeout(200)
      p = await read()
      assert.equal(p.open, false, '点「关闭」应关掉 normal 弹窗')
      assert.equal(p.snooze, null, 'normal 关闭**不写** snooze（下次检查还会提示）')

      // Esc
      await runCheck(page)
      p = await read()
      assert.equal(p.open, true, '重新检查应重新弹出')
      const afterEsc = await tryDismiss(page, 'esc')
      assert.equal(afterEsc.open, false, 'normal 弹窗应能被 Esc 关掉')

      // 点遮罩
      await runCheck(page)
      const afterOverlay = await tryDismiss(page, 'overlay')
      assert.equal(afterOverlay.open, false, 'normal 弹窗应能被点遮罩关掉')
      assert.equal(afterOverlay.settingsOpen, true, '关掉弹窗后设置面板仍在')
    },
  },
  {
    id: 'D7',
    name: '没下发策略（老服务端形状）：不弹策略弹窗，结果仍在设置面板（零回归）',
    releases: [release()],
    viewports: [VIEW_390],
    assert: async (page, read) => {
      const p = await read()
      assert.equal(p.open, false, '没下发 updatePolicy 时不该出现策略弹窗')
      assert.match(p.status, /发现新版本/, `面板结论必须还在：${p.status}`)
      // 面板里的旧出口一个没少：有「确认下载 / 下载 APK」的降级链接，也有诊断区
      assert.ok(
        p.pageButtons.includes('下载 APK'),
        `面板的「下载 APK」降级链接必须还在：${JSON.stringify(p.pageButtons)}`
      )
    },
  },
  {
    id: 'D8',
    name: '长更新说明 + 暗色主题 + 360 档：内容区可滚、底部按钮常驻、弹窗不越界',
    releases: [release({ changes: LONG_CHANGES, updatePolicy: { mode: 'normal' } })],
    dark: true,
    viewports: [VIEW_360],
    assert: async (page, read) => {
      const p = await read()
      assert.equal(p.open, true, '长说明场景也要能弹出（内容滚，不是把弹窗撑爆）')
      assert.equal(p.dark, true, '暗色主题应真的生效（data-ds-dark-theme）')
      assert.equal(p.changes.length, 23, `23 条说明应逐条渲染，实际 ${p.changes.length}`)
      assert.equal(
        p.mainScroll.overflowY,
        'auto',
        `内容区必须是滚动容器，实际 ${p.mainScroll.overflowY}`
      )
      assert.ok(
        p.mainScroll.scrollHeight > p.mainScroll.clientHeight,
        `23 条说明在 360 档应装不下：${p.mainScroll.scrollHeight}/${p.mainScroll.clientHeight}`
      )
      assert.ok(
        p.card.top >= -1 && p.card.bottom <= p.viewportHeight + 1,
        `弹窗必须完整落在视口内：${JSON.stringify(p.card)}`
      )
      assert.ok(p.footerButtons.length > 0, '底部按钮必须常驻（不许被内容挤出去）')
      // 深浅色各出一份背景色读数：两张截图 + 两个不同的值 = 主题真的切换了，而不是只有一套皮肤
      assert.ok(
        p.background && p.background !== 'rgba(0, 0, 0, 0)',
        `卡片背景应有实际颜色，实际 ${p.background}`
      )
    },
  },
]

// ---------------------------------------------------------------- 跑

/*
 * 产物：**自建**，不读环境里的 dist / dist-standard。
 *
 * 为什么（两次实红都出在这里）：
 *   1. 本仓库的 `dist` 由 `pnpm build:internal` 产生（installed variant = internal），
 *      而本用例清单里是 `artifactVariant: "standard"` —— 变体不等时 `selectUpdate` 一条候选都挑不出来，
 *      界面**永远**是「已是最新」，9 组用例会各自等 15s 再报「找不到『发现新版本』」，
 *      看起来像断言失败，其实是拿错了产物；
 *   2. `dist-standard` 可能是上一版代码编的 —— 回归用例对着旧产物报绿/报红都没有意义。
 *
 * 所以照 `copy-limit` / `update-stuck-button-373` 的写法：用**同一份** `rspack.config.ts` 现编一份
 * 标准产物到 `dist-update-dialog`（实测 ~2s，目录名以 dist- 开头，已在 .gitignore 的忽略范围内）。
 * 想复用手工产物：`UPDATE_DIALOG_DIST=<目录>` 跳过构建（CI 不用它）。
 */
const DIST_LABEL = 'dist-update-dialog'
const DIST = process.env.UPDATE_DIALOG_DIST
  ? path.resolve(ROOT, process.env.UPDATE_DIALOG_DIST)
  : path.join(ROOT, DIST_LABEL)

if (process.env.UPDATE_DIALOG_DIST === undefined) {
  console.log(`· 构建被测产物到 ${DIST_LABEL}（DIST_OUT=${DIST_LABEL}，标准变体）…`)
  // Windows 上 node_modules/.bin/rspack 是无扩展名的 sh 脚本，execFileSync 直接 spawn 会 ENOENT；
  // 用当前 node 跑 @rspack/cli 的 bin 入口（跨平台一致，与 integration/copy-limit 同一写法）。
  const rspackCli = path.join(
    path.dirname(require.resolve('@rspack/cli/package.json')),
    'bin',
    'rspack.js'
  )
  execFileSync(process.execPath, [rspackCli, 'build', '-c', 'rspack.config.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', DIST_OUT: DIST_LABEL },
    stdio: 'inherit',
  })
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  skipEnv(
    `没有产物：${path.relative(ROOT, DIST)}/index.html 不存在`,
    '先构建：pnpm run build（或用 UPDATE_DIALOG_DIST 指向已构建的标准产物目录）'
  )
}

/** 产物变体自检：清单写的是 standard，内测包会让「有新版」永远不成立（见上） */
const buildInfo = readBuildInfo(DIST)
if (buildInfo !== null && buildInfo.variant !== undefined && buildInfo.variant !== 'standard') {
  throw new Error(
    `产物变体不对：${path.relative(ROOT, DIST)} 是 ${buildInfo.variant} 变体，本用例要 standard`
  )
}

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}

const served = await serveDir(DIST, { port: process.env.PORT, label: 'update-dialog 标准产物' })
console.log(`静态服务：${path.relative(ROOT, DIST)} → ${served.url}`)

const browser = await chromium.launch({ headless: true })
try {
  for (const scenario of SCENARIOS) {
    for (const viewport of scenario.viewports) {
      const context = await browser.newContext({
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'reduce',
        ...(scenario.dark ? { colorScheme: 'dark' } : {}),
      })
      // 首屏前预置 localStorage：主题与 snooze 现场都要在模块初始化时就读到
      await context.addInitScript(
        (seed) => {
          try {
            for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value)
          } catch {
            // 首屏前不可用就跳过（本用例只看设置页）
          }
        },
        {
          'chat-demo:api-key': 'sk-update-dialog-fixture',
          'chat-demo:provider-kind': 'deepseek',
          ...(scenario.dark ? { 'chat-demo:theme-preference': 'dark' } : {}),
          ...(scenario.preseed ? scenario.preseed(Date.now()) : {}),
        }
      )
      await routeManifest(context, scenario.releases)
      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      const tag = `${scenario.id}@${viewport.label}${scenario.dark ? '(dark)' : ''}`
      const read = () => page.evaluate(probe)
      try {
        await page.goto(served.url, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(600)
        await openSettings(page)
        await runCheck(page)
        await scenario.assert(page, read)
        ok(`${tag} ${scenario.name}`)
        if (scenario.dark || scenario.id === 'D1') {
          const shot = path.join(
            SHOTS,
            `517-update-dialog-${scenario.id}-${viewport.width}${scenario.dark ? '-dark' : ''}.png`
          )
          await page.screenshot({ path: shot })
          console.log(`  ·   截图 ${path.relative(ROOT, shot)}`)
        }
      } catch (error) {
        const message = String(error.message ?? error).split('\n')[0]
        failures.push(`${tag}：${message}`)
        console.error(`  ✗  ${tag} ${scenario.name}\n     ${message}`)
        const shot = path.join(
          SHOTS,
          `517-update-dialog-${scenario.id}-${viewport.width}-FAILED.png`
        )
        await page.screenshot({ path: shot }).catch(() => {})
      }
      if (pageErrors.length > 0) failures.push(`${tag} 页面抛异常：${pageErrors.join(' | ')}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
  // serveDir 的返回值是 { url, port, kill }（不是 http.Server）—— 用 close() 会静默失效，
  // 静态服务把事件循环吊住，进程永不退出：run-layer 按「文件超时」判红，
  // 而屏幕上明明已经打印过「全部通过」（实测：两次尝试各被 180s 超时杀掉，合计 360s FAIL）。
  served.kill()
}

console.log(
  failures.length === 0
    ? `\n全部通过：${checks} 组`
    : `\n失败 ${failures.length} 组：\n- ${failures.join('\n- ')}`
)
if (failures.length > 0) {
  process.exitCode = 1
}
