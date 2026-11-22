// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
//
// GitHub issue #818 回归：上传的大图「显示过大、没适配屏幕」。
//
// 修之前先量（Playwright Chromium，390×844 与 360×740，竖 3000×4000 / 横 4000×3000 各一张）：
//   ① 输入框草稿缩略图（ChatInput.module.css `.attachment`）：64×64，占屏宽 16.4% / 17.8%，
//      `.attachments` 的 scrollWidth === clientWidth（无横向溢出）→ **本来就是对的，本单不动它**；
//   ② 消息气泡里的图片（MessageFile.module.css `.image`）：120×120，单张占 33%，
//      但四张图整行宽 320px（360 视口）= 88.9% 屏宽 > 0.8 判据，且**尺寸写死不随屏宽变化**；
//   ③ 点开大图（MessageFile.tsx 正常态 `<a target="_blank">`）：新页面文档宽度 = 原图像素宽
//      （3000px vs 屏宽 360），未缩放、要横向滚动才看得全，且没有任何应用内预览层。
//
// 所以本单改两处（草稿缩略图不动），本文件把这两处钉住：
//   A 气泡图片：`min(<上限>px, <N>vw)` 形状，且按实测公式算出来的宽度满足
//     「≤ 屏宽 60%」与「360 宽下 3 张一行放得下（行宽 320）」，并保留 `object-fit: cover`
//   B 混排文档的 64px 档与 `--message-file-reason-display: none`（#214）不许被改坏
//   C 草稿缩略图仍是固定 64px（量过没问题 → 不改，谁改谁在这里红）
//   D 点开改走应用内预览：不再 `target="_blank"`，预览层是遮罩 + `max-width/max-height 100%`
//     + `object-fit: contain`，Esc 能关
//   E 新文案 zh/en 成对
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const MESSAGE_FILE_CSS = 'src/components/messages/MessageFile.module.css'
const MESSAGE_FILE_TSX = 'src/components/messages/MessageFile.tsx'
const USER_MESSAGE_CSS = 'src/components/messages/UserMessage.module.css'
const CHAT_INPUT_CSS = 'src/components/chatInput/ChatInput.module.css'
const PREVIEW_TSX = 'src/components/base/ImagePreview.tsx'
const PREVIEW_CSS = 'src/components/base/ImagePreview.module.css'

/** 注释不是规则：注释里出现的 `120px` / `target="_blank"` 旧值说明不该被当成声明 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//gu, ' ')

/** TSX 里同样要把注释摘掉（文件头就在解释「原来是 target=_blank」） */
const stripSource = (tsx) =>
  tsx.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** 取 `.cls { … }` 的第一层块（后面的嵌套块原样带着，够用来找声明） */
const blockOf = (css, selector) => {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `找不到选择器 ${selector}`)
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index + 1)
    }
  }
  throw new Error(`选择器 ${selector} 的花括号不平衡`)
}

/** 从一个值里取 `var(--name, <fallback>)` 的 fallback（按括号配平，值里还套着 min()） */
const fallbackOf = (value, name) => {
  const marker = `var(${name},`
  const start = value.indexOf(marker)
  assert.notEqual(start, -1, `${name} 没有 fallback：${value}`)
  let depth = 0
  for (let index = value.indexOf('(', start); index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') {
      depth -= 1
      if (depth === 0) return value.slice(start + marker.length, index).trim()
    }
  }
  throw new Error(`var(${name}, …) 的括号不平衡：${value}`)
}

/**
 * 尺寸表达式 → { cap, vw }：
 *   `min(120px, 27vw)` / `min(27vw, 120px)` → { cap: 120, vw: 27 }
 *   裸 `120px`（#818 要修的老写法）→ { cap: 120, vw: 0 }，照样把数字算出来，
 *   这样负向对照红在「算出来的宽度」上，而不是红在一句「形状不对」。
 */
const parseSize = (expr) => {
  const bare = /^(\d+(?:\.\d+)?)px$/u.exec(expr)
  if (bare) return { cap: Number.parseFloat(bare[1]), vw: 0 }
  const inner = /^min\(([\s\S]+)\)$/u.exec(expr)
  assert.notEqual(inner, null, `气泡图片尺寸要么是 min(<px>, <N>vw)，要么是 <px>；实际是：${expr}`)
  const parts = inner[1].split(',').map((part) => part.trim())
  assert.equal(parts.length, 2, `min() 只接受两个参数，实际：${expr}`)
  const px = parts.find((part) => /^\d+(?:\.\d+)?px$/u.test(part))
  const vw = parts.find((part) => /^\d+(?:\.\d+)?vw$/u.test(part))
  assert.ok(px, `${expr} 里没有 px 上限`)
  assert.ok(vw, `${expr} 里没有 vw 基准（写死 px 就不随屏宽变化了）`)
  return { cap: Number.parseFloat(px), vw: Number.parseFloat(vw) }
}

/** 实测行宽（`.files` 的 clientWidth，来自 #818 的两档量测） */
const ROW_WIDTH = { 360: 320, 390: 350 }
const GAP = 10
/** 某个屏宽下的实际图片宽度；vw 为 0 = 老写法（固定 px），宽度与屏宽无关 */
const widthAt = ({ cap, vw }, screen) => (vw > 0 ? Math.min(cap, (vw * screen) / 100) : cap)

test('A 气泡图片随屏宽自适应，且窄屏多图一行放得下（#818 定位结论 ②）', () => {
  const css = stripComments(read(MESSAGE_FILE_CSS))
  const image = blockOf(css, '.image')
  const widthDecl = /width:\s*([^;]+);/u.exec(image)
  const heightDecl = /height:\s*([^;]+);/u.exec(image)
  assert.ok(widthDecl, '.image 缺少 width 声明')
  assert.ok(heightDecl, '.image 缺少 height 声明')
  const size = parseSize(fallbackOf(widthDecl[1], '--message-file-image-size'))
  assert.equal(
    fallbackOf(heightDecl[1], '--message-file-image-size'),
    fallbackOf(widthDecl[1], '--message-file-image-size'),
    '宽高必须同一条规则，缩略图是方块'
  )

  for (const [screen, rowWidth] of Object.entries(ROW_WIDTH)) {
    const width = widthAt(size, Number(screen))
    assert.ok(
      width / Number(screen) <= 0.6,
      `${screen} 宽下图片 ${width}px 占屏宽 ${((width / Number(screen)) * 100).toFixed(1)}% > 60%`
    )
    const perRow = Math.floor((rowWidth + GAP) / (width + GAP))
    assert.ok(perRow >= 3, `${screen} 宽下一行只放得下 ${perRow} 张（要求 ≥ 3），图片 ${width}px`)
    assert.ok(
      perRow * width + (perRow - 1) * GAP <= rowWidth,
      `${screen} 宽下 ${perRow} 张一行会顶出 ${rowWidth}px 的行宽`
    )
  }
  // 窄屏更小、宽屏不超过原来那档
  assert.ok(
    size.vw > 0,
    `尺寸里没有 vw 基准（${fallbackOf(widthDecl[1], '--message-file-image-size')}）：写死 px 就是 #818 要修的病 —— 图片不随屏宽变化，窄屏上比例过大`
  )
  assert.ok(widthAt(size, 360) < widthAt(size, 390), '更窄的屏必须得到更小的图')
  assert.ok(widthAt(size, 390) <= 120, '宽屏不该比原来的 120px 更大')

  // `object-fit: cover` 保留（要求原文：改成自适应，cover 不动）
  assert.match(image, /object-fit:\s*cover;/u, '.image img 的 object-fit: cover 不许动')
  // 方块：img 撑满盒子
  assert.match(image, /img\s*\{[^}]*width:\s*100%;/u, '.image img 仍然撑满盒子')
})

test('B 混排文档的 64px 档与 #214 的显隐开关不回退', () => {
  const userCss = stripComments(read(USER_MESSAGE_CSS))
  const mixed = blockOf(userCss, '.filesWithDocuments')
  assert.match(mixed, /--message-file-image-size:\s*64px;/u, '与文件混排时仍是 64px 一档')
  assert.match(
    mixed,
    /--message-file-reason-display:\s*none;/u,
    '#214：64px 档放不下两行失败原因，这条声明必须留着'
  )
  assert.match(
    stripComments(read(MESSAGE_FILE_CSS)),
    /display:\s*var\(--message-file-reason-display,\s*flex\);/u,
    '.reason 的默认仍是 flex（低内核上的基线）'
  )
})

test('C 草稿缩略图量过没问题 → 保持固定 64px，不被顺手改大改小', () => {
  const attachment = blockOf(stripComments(read(CHAT_INPUT_CSS)), '.attachment')
  assert.match(attachment, /width:\s*64px;/u, '草稿缩略图仍是 64px')
  assert.match(attachment, /height:\s*64px;/u, '草稿缩略图仍是 64px')
  assert.doesNotMatch(attachment, /\bvw\b/u, '草稿缩略图不参与自适应（量过 64px 没有溢出）')
})

test('D 点开大图走应用内预览层，不再 target="_blank" 开原件', () => {
  const tsx = stripSource(read(MESSAGE_FILE_TSX))
  assert.doesNotMatch(tsx, /target="_blank"/u, '正常态不许再用 target="_blank" 把原图丢给新页面/WebView')
  assert.match(tsx, /import \{ ImagePreview \} from '\.\.\/base\/ImagePreview\.js'/u, '要用应用内预览组件')
  assert.match(tsx, /<ImagePreview[\s\S]*?src=\{url\}/u, '预览层拿的是同一个本地原件地址')

  const preview = stripComments(read(PREVIEW_CSS))
  const overlay = blockOf(preview, '.overlay')
  assert.match(overlay, /position:\s*fixed;/u, '预览层是全屏遮罩')
  assert.match(overlay, /inset:\s*0;/u, '遮罩铺满视口')
  const image = blockOf(preview, '.image')
  assert.match(image, /max-width:\s*100%;/u, '图片宽度不许超过遮罩')
  assert.match(image, /max-height:\s*100%;/u, '图片高度不许超过遮罩')
  assert.match(image, /object-fit:\s*contain;/u, '等比完整显示（不裁切）')

  const component = stripSource(read(PREVIEW_TSX))
  assert.match(component, /role="dialog"/u, '预览层要报无障碍角色')
  assert.match(component, /aria-modal="true"/u, '预览层是模态')
  assert.match(component, /'Escape'/u, 'Esc 要能关')
  assert.match(component, /onClick=\{onClose\}/u, '点遮罩要能关')
  assert.match(component, /data-testid="image-preview"/u, '留一个稳定的取证钩子')

  // #209：能力靠探测不靠假设 —— `object-fit` 要不出来就落到纯尺寸方案，不许「应该支持」
  assert.match(component, /detectObjectFit/u, 'object-fit 要有一条真探测（读回声明），不是推理')
  assert.doesNotMatch(component, /CSS\.supports/u, '#209：不许用 CSS.supports 冒充能力探测（flex gap 就骗过人）')
  assert.match(component, /data-object-fit=/u, '探测结果要落到 DOM 上，取证才有得看')
  assert.match(component, /styles\.imageNoFit/u, '探测失败要有纯尺寸兜底类')
  const noFit = blockOf(preview, '.imageNoFit')
  assert.match(noFit, /max-width:\s*100%;/u, '兜底方案：限宽')
  assert.match(noFit, /max-height:\s*100%;/u, '兜底方案：限高')
  assert.doesNotMatch(noFit, /object-fit/u, '兜底方案不写 object-fit')
  // 正确性不许押在 object-fit 上：主方案也是限宽限高 + auto（老内核都认）
  assert.match(image, /width:\s*auto;/u, '主方案靠 auto 尺寸 + 限宽限高，不依赖 object-fit 生效')
  assert.match(image, /height:\s*auto;/u, '主方案靠 auto 尺寸 + 限宽限高，不依赖 object-fit 生效')
})

test('F 新代码不碰老内核不认识的东西（#209 / #173）', () => {
  // MessageFile.tsx 是存量文件（自身就有 #552 时期的 `?.` / `??`），所以这里只扫**本单新增的部分**：
  // 两个新文件整份扫，MessageFile.tsx 只扫「正常态」那段（#818 新增的 button + 预览层）。
  const tsx = stripSource(read(MESSAGE_FILE_TSX))
  const marker = tsx.indexOf("t('imagePreviewOpen')")
  const start = marker === -1 ? -1 : tsx.lastIndexOf('<button', marker)
  const end = marker === -1 ? -1 : tsx.indexOf(') : (', marker)
  assert.ok(start !== -1 && end > start, '找不到 #818 新增的「正常态」分支')
  const addedBlock = tsx.slice(start, end)
  assert.match(addedBlock, /<ImagePreview/u, '扫的这段必须是本单新增的那段')
  const files = [PREVIEW_TSX, MESSAGE_FILE_CSS, PREVIEW_CSS]
  const banned = [
    [/\?\./u, '?.'],
    [/\?\?/u, '??'],
    [/\.at\(/u, 'at()'],
    [/replaceAll/u, 'replaceAll'],
    [/Object\.hasOwn/u, 'Object.hasOwn'],
    [/:has\(/u, ':has()'],
    [/aspect-ratio/u, 'aspect-ratio'],
    [/\bdvh\b/u, 'dvh'],
  ]
  for (const [pattern, name] of banned) {
    assert.doesNotMatch(addedBlock, pattern, `MessageFile.tsx 的新增段里出现了 ${name}：老内核（WebView 83 / ES5 兜底）不保证支持`)
  }
  for (const file of files) {
    const source = file.endsWith('.css') ? stripComments(read(file)) : stripSource(read(file))
    for (const [pattern, name] of banned) {
      assert.doesNotMatch(source, pattern, `${file} 里出现了 ${name}：老内核（WebView 83 / ES5 兜底）不保证支持`)
    }
  }
})

test('E 新文案 zh/en 成对', () => {
  const zhLine = /imagePreviewOpen:\s*'([^']+)'/u.exec(read('src/i18n/zh.ts'))
  const enLine = /imagePreviewOpen:\s*'([^']+)'/u.exec(read('src/i18n/en.ts'))
  assert.ok(zhLine, 'zh 缺 imagePreviewOpen')
  assert.ok(enLine, 'en 缺 imagePreviewOpen')
  assert.notEqual(zhLine[1], enLine[1], 'zh / en 不能是同一句')
  assert.match(read(MESSAGE_FILE_TSX), /t\('imagePreviewOpen'\)/u, '新 key 必须真的被用上（否则是孤立 key）')
})
