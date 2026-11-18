#!/usr/bin/env node
/**
 * 认选择器专用：把当前页面上的可交互元素全部 dump 出来（aria / class / text / rect / disabled），
 * 然后按「侧栏 → 设置」的顺序试着点，每步都 dump 一次。
 * 只读探测，不改产品代码，也不进证据目录（结果打屏）。
 *
 * 用法：node scripts/compat/dump-ui.mjs [--steps 1]
 */
import { sleep } from './lib/device.mjs'
import { attach } from './lib/cdp.mjs'

const DUMP = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
  }
  const nodes = document.querySelectorAll('button, input, a, [role="tab"], [role="button"], textarea, [data-testid]')
  const list = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (!visible(node)) continue
    const rect = node.getBoundingClientRect()
    list.push({
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role'),
      aria: node.getAttribute('aria-label'),
      testId: node.getAttribute('data-testid'),
      placeholder: node.getAttribute('placeholder'),
      text: (node.textContent || '').trim().slice(0, 40),
      className: String(node.className || '').slice(0, 80),
      disabled: node.disabled === true,
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    })
  }
  return {
    innerWidth: window.innerWidth,
    scrollWidth: (document.scrollingElement || document.documentElement).scrollWidth,
    url: location.href,
    bodyTextHead: (document.body.innerText || '').slice(0, 300),
    count: list.length,
    list,
  }
})()`

const show = (label, dump) => {
  console.log(`\n===== ${label} =====`)
  if (!dump || dump.error) {
    console.log(`错误：${dump?.error}`)
    return
  }
  console.log(`viewport=${dump.innerWidth} scrollWidth=${dump.scrollWidth} 元素=${dump.count}`)
  for (const item of dump.list) {
    console.log(
      `  ${item.tag}${item.role ? `[role=${item.role}]` : ''} aria=${item.aria ?? '-'} text=${JSON.stringify(item.text)} class=${item.className} rect=${item.rect.join(',')}${item.disabled ? ' DISABLED' : ''}`
    )
  }
  console.log(`--- body: ${JSON.stringify((dump.bodyTextHead || '').slice(0, 160))}`)
}

const { cdp } = await attach()
const dump = () => cdp.evaluate(DUMP, 20_000).catch((error) => ({ error: error.message }))

show('初始（主界面）', await dump())

// 侧栏开关候选：把带 sidebar / expand / menu 的 aria 全列出来，逐个试
const candidates = await cdp
  .evaluate(
    `(() => {
      const all = Array.from(document.querySelectorAll('button, [role="button"], a'))
      return all
        .map((node) => ({ aria: node.getAttribute('aria-label'), cls: String(node.className || '').slice(0, 60) }))
        .filter((item) => /sidebar|expand|collapse|menu|settings|gear/i.test((item.aria || '') + ' ' + item.cls))
    })()`,
    15_000
  )
  .catch((error) => ({ error: error.message }))
console.log(`\n候选开关：${JSON.stringify(candidates)}`)

for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 4) : []) {
  if (!candidate.aria) continue
  const opened = await cdp
    .evaluate(
      `(() => {
        const node = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(candidate.aria)}) + ']')
        if (!node) return false
        node.click()
        return true
      })()`,
      15_000
    )
    .catch(() => false)
  await sleep(900)
  const after = await dump()
  const hasSettings = Array.isArray(after.list) && after.list.some((item) => /^settings$/i.test(item.text))
  show(`点 aria=${candidate.aria} 之后（有 Settings 按钮=${hasSettings}）`, after)
  if (hasSettings) break
}

// 直接试 text=Settings
const clicked = await cdp
  .evaluate(
    `(() => {
      const all = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
      for (const node of all) {
        const text = (node.textContent || '').trim()
        if (text !== 'Settings') continue
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (node.children.length > 0) continue
        node.click()
        return { clicked: true, cls: String(node.className || '').slice(0, 80), rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] }
      }
      return { clicked: false }
    })()`,
    15_000
  )
  .catch((error) => ({ error: error.message }))
console.log(`\n点 Settings 文本：${JSON.stringify(clicked)}`)
await sleep(1500)
show('点 Settings 之后', await dump())

cdp.close()
