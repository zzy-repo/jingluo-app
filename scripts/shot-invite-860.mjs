#!/usr/bin/env node
/**
 * #860「邀请面板：名额已满提示 + 划转返利」的 390 / 360 截图取证（**组件级同源渲染，不是真机截图**）。
 *
 * 与 `scripts/shot-invite-bind-842.mjs` 同一做法：真视图函数（`invitePanelModel.InvitePanelView`）在 Node 里
 * `renderToStaticMarkup`，配真样式表，Playwright 按 390×844 / 360×740 截。数据全是脚本里的夹具（mock），
 * 不来自任何真实接口；划转没有任何真实响应样本。
 *
 *   node scripts/shot-invite-860.mjs --out=docs/ui/860-invite-panel
 *
 * 场景：migrated-full（迁移用户 aff_count=30 + 名额已满）/ transfer（有可划转返利）/ transfer-failed（划转失败文案）
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
const { InvitePanelView, initialInviteTransferState } = await import(pathToFileURL(path.join(ROOT, 'src/components/consume/invitePanelModel.ts')).href)

const t = (key, params) =>
  String(zh[key]).replace(/\{(\w+)\}/gu, (whole, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole
  })
const c = new Proxy({}, { get: (_target, name) => String(name) })
const Button = ({ variant = 'primary', size = 'l', disabled, children, testId }) =>
  createElement(
    'button',
    { type: 'button', 'data-testid': testId, disabled: disabled === true, className: `shotButton shotButton-${variant} shotButton-${size}` },
    children
  )

const noop = () => {}
const BASE = { code: 'MIGR0011', count: 30, rebateBalance: 0, frozenBalance: 0, remaining: 0 }
const panel = (data, transferState) =>
  InvitePanelView({
    t,
    c,
    Button,
    state: { phase: 'ready', data },
    copied: false,
    onCopy: noop,
    onRetry: noop,
    transfer: { state: transferState, onTransfer: noop },
  })

const SCENES = {
  'migrated-full': () => panel(BASE, initialInviteTransferState()),
  transfer: () => panel({ ...BASE, count: 1, remaining: 29, rebateBalance: 12.5 }, initialInviteTransferState()),
  'transfer-failed': () =>
    panel({ ...BASE, count: 1, remaining: 29, rebateBalance: 12.5 }, { busy: false, done: false, errorKey: 'inviteTransferFailed' }),
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

const argOut = process.argv.slice(2).find((a) => a.startsWith('--out='))
const OUT = argOut ? argOut.slice(6) : 'docs/ui/860-invite-panel'
const scenes = Object.keys(SCENES)
const viewports = Object.keys(VIEWPORTS)

const [theme, global, panelCss] = await Promise.all([
  readFile(path.join(ROOT, 'src/app/theme.css'), 'utf8'),
  readFile(path.join(ROOT, 'src/app/global.css'), 'utf8'),
  readFile(path.join(ROOT, 'src/components/consume/panels.module.css'), 'utf8'),
])

const OUT_ROOT = path.resolve(ROOT, OUT)
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
