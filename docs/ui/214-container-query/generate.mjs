/** #214 截图：把两条真实的 CSS Module 规则原样搬到裸 HTML 上，对比「低内核（Chromium 83）模拟」与「修复后」。
 *
 * 为什么不直接跑 app：聊天页要出现「上传失败的图片 + 同条消息还带文件」得先造假附件、
 * 拦住上传接口，`scripts/shot-mobile.mjs` 里也没有这类场景；而 #214 的差异**只**由这两条规则决定
 * （`.image` 的固定宽度、`.reason` 的显隐），规则原样搬运即可复现，且不引入任何手写样式。
 *
 * 83 模拟：Chromium 83 解析 `container-type` 会丢掉该声明、解析 `@container` 会丢掉整块，
 * 所以「修复前 + 删掉这两处」就是 83 的真实计算结果。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const OUT = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(OUT, '../../..')

/** 取出一个顶层选择器规则的完整正文（含嵌套块；规则可能就在文件第 1 行） */
const block = (css, selector) => {
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{`, 'u').exec(css)
  if (!match) throw new Error(`找不到规则 ${selector}`)
  const start = match.index + match[0].indexOf(selector)
  let depth = 0
  const open = css.indexOf('{', start)
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, i + 1)
    }
  }
  throw new Error(`规则 ${selector} 没有闭合`)
}

const read = (file) => readFileSync(`${ROOT}/${file}`, 'utf8')
const readAtHead = (file) =>
  execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' })

const SELECTORS = ['.image', '.imageThumb', '.reason', '.files', '.filesWithDocuments']

const collect = (messageFile, userFile) => {
  const message = messageFile()
  const user = userFile()
  return SELECTORS.map((selector) =>
    block(['.filesWithDocuments', '.files'].includes(selector) ? user : message, selector))
    .join('\n')
}

const afterCss = collect(
  () => read('src/components/messages/MessageFile.module.css'),
  () => read('src/components/messages/UserMessage.module.css'),
)

const headMessage = readAtHead('src/components/messages/MessageFile.module.css')

/** 修复前那条 `@container (max-width: 63px) { … }` 原样取出 */
const containerBlock = (css) => {
  const start = css.indexOf('@container (max-width: 63px)')
  if (start < 0) throw new Error('修复前的 @container 块没找到')
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, i + 1)
    }
  }
  throw new Error('修复前的 @container 块没有闭合')
}

// 修复前（现代内核原样）：六条规则 + 容器查询块拼回去
const beforeModernCss =
  collect(
    () => headMessage,
    () => readAtHead('src/components/messages/UserMessage.module.css'),
  ) +
  '\n' +
  containerBlock(headMessage)

// 修复前（Chromium 83 的计算结果）：删掉 container-type 声明与 @container 整块
const before83Css = (() => {
  let css = beforeModernCss
  css = css.replace(/\n\s*container-type: inline-size;/u, '')
  const start = css.indexOf('@container (max-width: 63px)')
  if (start < 0) throw new Error('修复前的 @container 块没找到')
  const open = css.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return css.slice(0, start) + css.slice(end)
})()

const REASON = '网络中断，图片没有上传成功，请连上 Wi-Fi 后重试'
const PREVIEW =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
       <rect width="120" height="120" fill="#c8d4e6"/>
       <circle cx="60" cy="46" r="18" fill="#8fa6c4"/>
       <path d="M0 120 L42 68 L74 104 L96 84 L120 112 L120 120 Z" fill="#6f89ab"/>
     </svg>`,
  )

const thumb = (extraClass, title) => `
      <div class="image imageThumb">
        <img src="${PREVIEW}" alt=""/>
        <span class="reason">${REASON}</span>
      </div>`

const page = (css, title, subtitle) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>#214 ${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #f5f6f8; }
  body { font-family: system-ui, "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  .shot { padding: 16px 12px 20px; }
  .caption { font-size: 13px; line-height: 18px; color: #4a5262; margin: 0 0 12px; }
  .caption b { color: #101828; }
  .rowLabel { font-size: 11px; color: #6b7280; margin: 14px 0 6px; }
  .rowLabel:first-of-type { margin-top: 0; }
  /* 设计 token：取 src/app/theme.css 亮色档里这几条规则用到的值（缺了会让 border 整条失效） */
  :root {
    --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
    --ds-transition-duration: 0.2s;
    --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
    --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  }
  /* ↓↓↓ 以下规则原样取自 src/components/messages/*.module.css ↓↓↓ */
${css}
  /* ↑↑↑ 以上规则原样取自 src/components/messages/*.module.css ↑↑↑ */
</style>
</head>
<body>
  <div class="shot">
    <p class="caption"><b>${title}</b><br/>${subtitle}</p>
    <p class="rowLabel">同一条消息里还有文件 → 缩略图 64px（窄档）</p>
    <div class="files filesWithDocuments">${thumb('', 'a')}${thumb('', 'b')}</div>
    <p class="rowLabel">纯图片消息 → 缩略图 120px（对照：原因该正常显示）</p>
    <div class="files">${thumb('', 'c')}</div>
  </div>
</body>
</html>`

const VARIANTS = [
  {
    name: 'before-chromium83-simulated',
    css: before83Css,
    title: '修复前 · Chromium 83 模拟',
    subtitle: '容器查询整块被丢弃 → 64px 缩略图上的两行失败原因又冒出来',
  },
  {
    name: 'before-chromium105plus',
    css: beforeModernCss,
    title: '修复前 · 支持容器查询的内核（105+）',
    subtitle: '@container 命中 → 窄档隐藏原因（现代内核上的现状，修复后必须与它逐像素一致）',
  },
  {
    name: 'after-fix',
    css: afterCss,
    title: '修复后 · 任意内核（含 Chromium 83）',
    subtitle: '判据换成 --message-file-reason-display（自定义属性），不依赖容器查询',
  },
]

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const versions = []
for (const width of [390, 360]) {
  mkdirSync(`${OUT}/${width}`, { recursive: true })
  for (const variant of VARIANTS) {
    const file = `${OUT}/${width}/${variant.name}.html`
    writeFileSync(file, page(variant.css, variant.title, variant.subtitle), 'utf8')
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
    })
    const tab = await context.newPage()
    await tab.goto(`file:///${file.replace(/\\/gu, '/')}`)
    versions.push(`${width}: ${await tab.evaluate(() => navigator.userAgent)}`)
    const measured = await tab.evaluate(() =>
      [...document.querySelectorAll('.files')].map((row) => {
        const reason = row.querySelector('.reason')
        const box = row.querySelector('.image').getBoundingClientRect()
        const style = getComputedStyle(reason)
        return `${row.className.includes('filesWithDocuments') ? '64px 档' : '120px 档'} display=${style.display} 缩略图=${Math.round(box.width)}x${Math.round(box.height)}`
      }),
    )
    console.log(`  ${variant.name} @${width}: ${measured.join(' | ')}`)
    await tab.screenshot({ path: `${OUT}/${width}/${variant.name}.png`, fullPage: true })
    await context.close()
  }
}
await browser.close()
console.log(versions.join('\n'))
