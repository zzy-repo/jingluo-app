#!/usr/bin/env node
/**
 * 「账户与消费」四面板（W1-C2 #487）的**组件级**截图取证工具。
 *
 * 为什么不是 `scripts/shot-mobile.mjs`：那个跑的是 `dist/` 里的整页（页面外壳由 W1-C1 负责，
 * 本单不许碰 `AccountConsumePage.tsx`）。这四个面板此刻还没有外壳可挂，所以这里走**同源渲染**：
 * 用真视图函数（`src/components/consume/*.ts` 的 `createElement`）在 Node 里
 * `renderToStaticMarkup`，配同样的三张样式表（`app/theme.css` 令牌 + `app/global.css` +
 * `panels.module.css`），再用 Playwright 按 390×844 / 360×740 两档截 ——
 * 版式与真机一致（同 CSS、同文案表、同 DOM 结构），但**这是浏览器视口截图，不是真机截图**。
 *
 *   node scripts/shot-consume-panels.mjs                     # 两档全场景 → docs/ui/consume-panels/
 *   node scripts/shot-consume-panels.mjs --scene=account     # 只截一个场景
 *   node scripts/shot-consume-panels.mjs --viewport=390 --out=docs/ui/consume-panels
 *
 * 场景（每个都在两档下各一张 `<场景>-<宽度>.png`）：
 *   quota         钱包额度：余额 / 已用 / 剩余 + 展开的用量列表 + 「加载更多」
 *   quota-nokey   还没有 Key：引导去「账号」创建（不发请求）
 *   account       账号：资料 + Key 列表（只显示尾 4 位）+ 「Key 只显示这一次」块
 *   invite        我的邀请：邀请码 / 已邀请人数 / 返利余额 + 不可解绑之外的语义说明
 *   email-form    邮箱绑定：填邮箱 + 验证码 + 发码倒计时（42s）
 *
 * 截图里看到的数字全部来自这里声明的夹具（不是真接口），夹具字段按契约 §3 的实测字段写，
 * 所以「已用」显示的是 `spent`（`usage.total.actual_cost`）而不是恒为 0 的 `quota.used`。
 * 金额单位是**元**（CNY，1 元 = 1 额度），符号由组件层的 `formatCurrency` 按 `currency` 渲染 ——
 * 夹具里的 `unit` 跟着写成 `CNY`，否则截出来的图和真机对不上。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** `.js` 说明符 → 同名 `.ts` / `.tsx`（源码按 NodeNext 写法引用） */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        for (const ext of ['.ts', '.tsx']) {
          try {
            return nextResolve(specifier.slice(0, -3) + ext, context)
          } catch {
            continue
          }
        }
      }
      throw error
    }
  },
})

const VIEWPORTS = {
  390: { width: 390, height: 844, label: '390×844' },
  360: { width: 360, height: 740, label: '360×740' },
}

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { zh } = await import(pathToFileURL(path.join(ROOT, 'src/i18n/zh.ts')).href)
const { QuotaPanelView } = await import(pathToFileURL(path.join(ROOT, 'src/components/consume/quotaPanelModel.ts')).href)
const { AccountPanelView, initialAccountState } = await import(
  pathToFileURL(path.join(ROOT, 'src/components/consume/accountPanelModel.ts')).href
)
const { InvitePanelView } = await import(pathToFileURL(path.join(ROOT, 'src/components/consume/invitePanelModel.ts')).href)
const { EmailBindPanelView, initialEmailBindState } = await import(
  pathToFileURL(path.join(ROOT, 'src/components/consume/emailBindPanelModel.ts')).href
)

/** 与 i18n/index.ts 同一套占位符规则（截图里要看到真文案） */
const t = (key, params) =>
  String(zh[key]).replace(/\{(\w+)\}/gu, (whole, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole
  })

/** 视图的样式注入：`panels.module.css` 的类名在本脚本里原样使用（不经过 CSS Modules 哈希） */
const c = new Proxy({}, { get: (_target, name) => String(name) })

/** 设计系统按钮的替身：只保留截图需要的 class 与文本（真机是 `base/Button`） */
const Button = ({ variant = 'primary', size = 'l', disabled, children, testId }) =>
  createElement(
    'button',
    {
      type: 'button',
      'data-testid': testId,
      disabled: disabled === true,
      className: `shotButton shotButton-${variant} shotButton-${size}`,
    },
    children
  )

// ------------------------------------------------------------------ 夹具（字段按契约 §3 实测）

const WALLET_USAGE = {
  mode: 'unrestricted',
  isValid: true,
  balance: 11.83,
  remaining: 11.83,
  unit: 'CNY',
  planName: '钱包余额',
  spent: 0.0514,
  quota: { limit: 0, used: 0, remaining: 11.83, unit: 'CNY' },
  usageTotal: { requests: 12, inputTokens: 18234, outputTokens: 2109, totalTokens: 20343, cacheReadTokens: 0, actualCost: 0.0514 },
  rateLimits: [],
}

const USAGE_ROWS = [
  { id: '1', model: 'deepseek-chat', at: '2026-11-20T09:12:00Z', requests: 6, cost: 0.0142 },
  { id: '2', model: 'deepseek-reasoner', at: '2026-11-20T08:41:00Z', requests: 3, cost: 0.0301 },
  { id: '3', model: 'deepseek-chat', at: '2026-11-19T22:03:00Z', requests: 3, cost: 0.0071 },
]

const API_KEYS = [
  { id: 7, name: '我的第一把', key: 'sk-live-0123456789abcdef9f2c', status: 'active', quota: 0, quotaUsed: 0 },
  { id: 8, name: '测试用', key: 'sk-live-fedcba98765432104b1e', status: 'inactive', quota: 0, quotaUsed: 0 },
]

const ACCOUNT_STATE = {
  ...initialAccountState({ id: 1, email: 'someone@example.com', balance: 11.83 }),
  profile: { phase: 'ready', data: { email: 'someone@example.com', balance: 11.83, registeredAt: '2026-03-08T10:20:00Z' } },
  keys: { phase: 'ready', data: { items: API_KEYS, total: 2, page: 1, pageSize: 20, pages: 1 } },
  createdKey: { id: 9, name: '新建的 Key', key: 'sk-live-9f2c4a7b1d6e8c0f5a3b', status: 'active', quota: 0, quotaUsed: 0 },
  draftName: '',
  busy: null,
  actionError: null,
  notice: null,
  confirmDeleteId: null,
  confirmLogout: false,
}

const INVITE_STATE = {
  phase: 'ready',
  data: { code: 'AFF-9F2C4A', count: 3, rebateBalance: 1.23, frozenBalance: 0.1, ratePercent: 10 },
}

const EMAIL_STATE = {
  ...initialEmailBindState(),
  info: { phase: 'ready', data: { email: 'someone@example.com', bound: true, canUnbind: true, emailVerifyEnabled: true } },
  mode: 'form',
  draftEmail: 'new@example.com',
  draftCode: '',
  cooldown: { untilMs: Date.now() + 42000, totalSeconds: 42 },
  notice: 'codeSent',
}

const noop = () => {}

const SCENES = {
  quota: () =>
    QuotaPanelView({
      t,
      c,
      Button,
      quota: { phase: 'ready', data: WALLET_USAGE },
      expanded: true,
      usage: { phase: 'ready', data: { items: USAGE_ROWS, page: 1, pages: 2, total: 6 } },
      loadingMore: false,
      loadMoreError: null,
      onToggle: noop,
      onLoadMore: noop,
      onRetryQuota: noop,
      onRetryUsage: noop,
    }),
  'quota-nokey': () =>
    QuotaPanelView({
      t,
      c,
      Button,
      quota: { phase: 'noKey' },
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle: noop,
      onLoadMore: noop,
      onRetryQuota: noop,
      onRetryUsage: noop,
    }),
  account: () =>
    AccountPanelView({
      t,
      c,
      Button,
      state: ACCOUNT_STATE,
      copied: false,
      onCopyKey: noop,
      onDraft: noop,
      onCreate: noop,
      onToggleKey: noop,
      onAskDelete: noop,
      onCancelDelete: noop,
      onConfirmDelete: noop,
      onDismissCreated: noop,
      onAskLogout: noop,
      onCancelLogout: noop,
      onLogout: noop,
      onRetry: noop,
    }),
  invite: () => InvitePanelView({ t, c, Button, state: INVITE_STATE, copied: false, onCopy: noop, onRetry: noop }),
  'email-form': () =>
    EmailBindPanelView({
      t,
      c,
      Button,
      state: EMAIL_STATE,
      remaining: 42,
      onStartBind: noop,
      onCancelForm: noop,
      onDraftEmail: noop,
      onDraftCode: noop,
      onSendCode: noop,
      onSubmit: noop,
      onAskUnbind: noop,
      onCancelUnbind: noop,
      onUnbind: noop,
      onRetry: noop,
    }),
}

/** 设计系统按钮的最小样式（截图里要能看出主次与禁用态；真机由 `base/Button.module.css` 提供） */
const BUTTON_CSS = `
.shotButton {
  box-sizing: border-box;
  min-height: 32px;
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 10px;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.shotButton-primary { background-color: #3957fe; color: #fff; }
.shotButton-outlined { background-color: #fff; border-color: rgba(0, 0, 0, 0.12); color: #0f1115; }
.shotButton-danger { background-color: #d92d20; color: #fff; }
.shotButton-dangerOutlined { background-color: #fff; border-color: rgba(0, 0, 0, 0.12); color: #d92d20; }
.shotButton[disabled] { opacity: 0.5; cursor: default; }
.shotButton-s { min-height: 28px; padding: 4px 10px; font-size: 12px; }
.shotButton-m { min-height: 36px; padding: 6px 14px; }
.shotButton-l { min-height: 40px; padding: 8px 18px; font-size: 14px; }
`

const scaffold = (bodyHtml, caption) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${caption}</title>
<style>/* 真样式表：令牌 + 全局 + 面板（同一份文件，非手抄） */</style>
</head>
<body>
<div class="shotPage">
  <p class="shotCaption">${caption}</p>
  ${bodyHtml}
</div>
</body>
</html>`

const parseArgs = (argv) => {
  const options = { scenes: null, viewports: null, out: 'docs/ui/consume-panels' }
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(arg)
    if (match === null) {
      throw new Error(`不认识的参数：${arg}（用 --scene= / --viewport= / --out=）`)
    }
    const [, key, value] = match
    if (key === 'scene' || key === 'scenes') {
      options.scenes = value.split(',').map((item) => item.trim()).filter(Boolean)
    } else if (key === 'viewport' || key === 'viewports') {
      options.viewports = value.split(',').map((item) => item.trim()).filter(Boolean)
    } else if (key === 'out') {
      options.out = value.trim()
    } else {
      throw new Error(`不认识的参数：--${key}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const scenes = options.scenes ?? Object.keys(SCENES)
for (const scene of scenes) {
  if (!(scene in SCENES)) {
    throw new Error(`未注册的场景：${scene}（可用：${Object.keys(SCENES).join(' / ')}）`)
  }
}
const viewports = options.viewports ?? Object.keys(VIEWPORTS)
for (const viewport of viewports) {
  if (!(viewport in VIEWPORTS)) {
    throw new Error(`不支持的视口档位：${viewport}（可用：390 / 360）`)
  }
}

const [theme, global, panelCss] = await Promise.all([
  readFile(path.join(ROOT, 'src/app/theme.css'), 'utf8'),
  readFile(path.join(ROOT, 'src/app/global.css'), 'utf8'),
  readFile(path.join(ROOT, 'src/components/consume/panels.module.css'), 'utf8'),
])

const OUT_ROOT = path.resolve(ROOT, options.out)
const browser = await chromium.launch()
try {
  for (const viewport of viewports) {
    const size = VIEWPORTS[viewport]
    const dir = path.join(OUT_ROOT, String(viewport))
    await mkdir(dir, { recursive: true })
    for (const scene of scenes) {
      const caption = `consume panels · ${scene} · ${size.label}`
      const html = scaffold(renderToStaticMarkup(SCENES[scene]()), caption)
        .replace(
          '<style>/* 真样式表：令牌 + 全局 + 面板（同一份文件，非手抄） */</style>',
          `<style>${theme}\n${global}\n${panelCss}\n${BUTTON_CSS}</style>`
        )
        .replace(
          '<title>',
          '<style>'
            // 真 app 是「固定高度 + 内部滚动」（global.css 的 body{overflow:hidden}；窄屏还给
            // html/body/#root 钉了 height:100%）。截图要的是「面板整块长什么样」，所以在这里
            // 把滚动还给文档 —— 这只影响取证页，不动产品样式。
            + 'html,body{height:auto !important;overflow:visible !important;}'
            + '.shotPage{padding:12px;background:var(--dsw-alias-bg-layer-3);}'
            + '.shotCaption{margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;}'
            + 'body{margin:0;background:var(--dsw-alias-bg-layer-3);}'
            + '</style><title>'
        )
      const page = await browser.newPage({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
      })
      await page.setContent(html, { waitUntil: 'load' })
      // 先把视口拉到「内容实际高度」再截：`fullPage` 在 isMobile + deviceScaleFactor 2 下
      // 偶尔只截到半屏（360 上的实际教训），显式量高度更稳，也保证不会截掉列表尾巴。
      const metrics = await page.evaluate(() => ({
        body: Math.ceil(document.body.getBoundingClientRect().height),
        scroll: Math.ceil(document.documentElement.scrollHeight),
        panel: Math.ceil(document.querySelector('[data-testid$="panel"]')?.getBoundingClientRect().bottom ?? 0),
      }))
      // 只截「内容 + 底部留白」：短面板不留一整屏空白，长面板的列表尾巴不会被截掉
      const contentHeight = Math.min(2400, Math.max(metrics.body, metrics.panel + 12))
      if (process.env.SHOT_DEBUG === '1') {
        console.log(`  debug ${scene}@${viewport}`, metrics)
      }
      await page.setViewportSize({ width: size.width, height: Math.max(size.height, contentHeight) })
      const file = path.join(dir, `${scene}-${viewport}.png`)
      await page.screenshot({ path: file })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      console.log(`${path.relative(ROOT, file)}  横向溢出 ${overflow}px`)
      if (overflow > 0) {
        console.error(`✗ ${scene} @${viewport} 出现 ${overflow}px 横向溢出（390/360 都不许出现）`)
        process.exitCode = 1
      }
      await page.close()
    }
  }
} finally {
  await browser.close()
}
