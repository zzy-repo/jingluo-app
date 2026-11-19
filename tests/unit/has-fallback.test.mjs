// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// issue #213：`:has()` 首支持 Chromium 105，本项目运行时下限是 WebView 83（Chromium 83）。
//
// 为什么这条要单独钉住：`:has()` 出现在**选择器列表**里时，83 把它当未知伪类，
// 于是整条选择器无效、**整条规则被丢弃** —— 不是「匹配不到」，而是连同列表里
// 其它合法选择器一起消失。原来 16 处 `:has()` 承载的是「标题/段落与紧跟其后的列表
// 贴合」这条间距语义，低内核上等于整块间距失效。
//
// 本文件守两条：
//   ① `src/**` 里不许再出现裸 `:has(`（间距语义改由渲染期打显式状态类承载）；
//   ② 显式状态类的产出函数与两个 CSS 里的规则对得上，且不再有重复选择器。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BEFORE_LIST_CLASS, beforeListClass } from '../../src/components/markdown/blockSpacing.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'src')

/** `src/**` 下的文本文件（组件内联 style 字符串也算，扫的就是字面量） */
const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/**
 * 注释不是规则，扫之前先抹掉；用等长空白替换，行号不变。
 * （注释里允许出现 `:has()` 的字样，例如说明「这里为什么不用它」。）
 */
const stripComments = (content, file) => {
  const blank = (text) => text.replace(/[^\n]/g, ' ')
  let out = content.replace(/\/\*[\s\S]*?\*\//g, blank)
  if (/\.(?:ts|tsx|js|mjs|jsx)$/.test(file)) {
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + blank(match.slice(lead.length)))
  }
  return out
}

/** 逐行找出源码里的 `:has(`，带上行号，方便红的时候直接看出是哪 16 处 */
const findBareHas = () => {
  const hits = []
  for (const file of walk(SRC)) {
    const content = stripComments(readFileSync(file, 'utf8'), file)
    content.split(/\r?\n/).forEach((line, index) => {
      const at = line.indexOf(':has(')
      if (at !== -1) hits.push({ file: rel(file), line: index + 1, text: line.trim() })
    })
  }
  return hits
}

test('① src/** 不含裸 :has()：WebView 83 会把整条规则连同选择器列表一起丢掉（#213）', () => {
  const hits = findBareHas()
  const detail = hits.map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`).join('\n')
  assert.equal(
    hits.length,
    0,
    `src 里仍有 ${hits.length} 处 :has()，Chromium 83 上整条规则会被丢弃：\n${detail}`
  )
})

test('② 状态已知时打显式类名：下一个渲染出来的兄弟是列表才给类，且按 ul/ol 区分', () => {
  const heading = { type: 'heading', depth: 4, children: [{ type: 'text', value: 'x' }] }
  const paragraph = { type: 'paragraph', children: [{ type: 'text', value: 'x' }] }
  const ul = { type: 'list', ordered: false, children: [] }
  const ol = { type: 'list', ordered: true, children: [] }

  assert.equal(beforeListClass([heading, ul], 0), 'ul')
  assert.equal(beforeListClass([heading, ol], 0), 'ol')
  assert.equal(beforeListClass([paragraph, ol], 0), 'ol')
  assert.equal(BEFORE_LIST_CLASS.ul, 'ds-markdown-before-ul')
  assert.equal(BEFORE_LIST_CLASS.ol, 'ds-markdown-before-ol')

  // 下一个兄弟不是列表 → 不打类（旧 :has() 也不匹配）
  assert.equal(beforeListClass([heading, paragraph], 0), null)
  assert.equal(beforeListClass([heading], 0), null)
  // 列表前面还隔着不产出 DOM 的节点（空标题 / 定义）→ 仍算「紧跟列表」
  assert.equal(beforeListClass([heading, { type: 'definition', children: [] }, ul], 0), 'ul')
  assert.equal(beforeListClass([heading, { type: 'heading', depth: 5, children: [] }, ol], 0), 'ol')
  // 中间隔了一个真的会渲染的节点 → 不再相邻
  assert.equal(beforeListClass([heading, { type: 'code', children: [] }, ul], 0), null)
})

/** 读 CSS 并去掉注释，避免注释里的字样干扰断言 */
const css = (file) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('③ 两个 CSS 都用显式状态类承载间距，且 thinking 里不再有复制的重复选择器', () => {
  const markdown = css('src/components/markdown/markdown.css')
  for (const depth of ['h4', 'h5', 'h6']) {
    for (const kind of ['ul', 'ol']) {
      assert.ok(
        markdown.includes(`${depth}.${BEFORE_LIST_CLASS[kind]}`),
        `markdown.css 缺少 ${depth}.${BEFORE_LIST_CLASS[kind]} 规则`
      )
    }
  }

  const thinking = css('src/components/messages/thinking.markdown.css')
  for (const depth of ['h3', 'h4', 'h5', 'h6']) {
    for (const kind of ['ul', 'ol']) {
      assert.ok(
        thinking.includes(`${depth}.${BEFORE_LIST_CLASS[kind]}`),
        `thinking.markdown.css 缺少 ${depth}.${BEFORE_LIST_CLASS[kind]} 规则`
      )
    }
  }
  assert.ok(
    thinking.includes(`.ds-markdown-paragraph.${BEFORE_LIST_CLASS.ol}`),
    'thinking.markdown.css 缺少段落（后接 ol）的显式状态类规则'
  )

  // #213 第 2 项：71/72 两条完全重复的选择器合并成一条（同一条规则里不允许同一个选择器写两遍）
  const repeated = []
  for (const [, prelude] of thinking.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = prelude
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean)
    const seen = new Set()
    for (const selector of selectors) {
      if (seen.has(selector)) repeated.push(selector)
      seen.add(selector)
    }
  }
  assert.deepEqual(repeated, [], `thinking.markdown.css 仍有重复选择器：${repeated.join(' / ')}`)
})
