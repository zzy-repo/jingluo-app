// 页内操作小工具：按「文本 / aria-label / placeholder / data-testid」找元素并点击或填值。
// 只用最老的 DOM API（querySelectorAll + textContent），WebView 58 也能跑。
export const MATCH_JS = `
  const visible = (element) => {
    if (!element || !element.getClientRects) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    return true
  }
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    placeholder: element.getAttribute('placeholder'),
    testId: element.getAttribute('data-testid'),
    type: element.getAttribute('type'),
    disabled: element.disabled === true,
    text: (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    className: String(element.className || '').slice(0, 120),
  })
  const matches = (element, spec) => {
    const label = [
      element.getAttribute('aria-label') || '',
      element.getAttribute('placeholder') || '',
      element.getAttribute('data-testid') || '',
      (element.textContent || ''),
    ].join(' \\u0000 ')
    if (spec.aria && !(element.getAttribute('aria-label') || '').includes(spec.aria)) return false
    if (spec.testId && element.getAttribute('data-testid') !== spec.testId) return false
    if (spec.placeholder && !(element.getAttribute('placeholder') || '').includes(spec.placeholder)) return false
    if (spec.text) {
      // 正则 / exact 只对元素自身的 textContent 生效。
      // 旧实现的 bug：正则对整个拼接标签（aria-label + placeholder + testid + text）做匹配，
      // 标签里带 \u0000 分隔符，于是 ^Import$ / ^(Data|数据)$ 这类锚定写法永远不成立
      // → 确认按钮点不到、P2 全程零请求（result-p2-ctrl-1mb.json requests: []）。
      const own = (element.textContent || '').trim()
      if (spec.regex) {
        if (!new RegExp(spec.text, spec.flags || 'i').test(own)) return false
      } else if (spec.exact) {
        if (own.toLowerCase() !== spec.text.toLowerCase()) return false
      } else if (!label.toLowerCase().includes(spec.text.toLowerCase())) return false
    }
    if (spec.tag && element.tagName.toLowerCase() !== spec.tag) return false
    return Boolean(spec.aria || spec.testId || spec.placeholder || spec.text || spec.tag)
  }
`

const wrapped = (body) => `(() => { ${MATCH_JS}\n${body}\n})()`

/** 列出页面上可交互元素的描述（调试选择器用；也是「界面到底渲染出什么」的原始证据）。 */
export const dumpInteractive = (cdp) =>
  cdp.evaluate(
    wrapped(`
      const nodes = document.querySelectorAll('button, input, a, [role="tab"], [role="button"], textarea, [data-testid]')
      const list = []
      for (let index = 0; index < nodes.length; index += 1) {
        if (!visible(nodes[index])) continue
        list.push(describe(nodes[index]))
        if (list.length >= 80) break
      }
      return list
    `),
    30_000
  )

/** 点击第一个匹配的可见元素。返回 { clicked, descriptor } 或 { clicked: false }。 */
export const click = async (cdp, spec) => {
  const result = await cdp.evaluate(
    wrapped(`
      const spec = ${JSON.stringify(spec)}
      const nodes = document.querySelectorAll(
        spec.tag ? spec.tag : 'button, input, a, [role="tab"], [role="button"], textarea, [data-testid], div, span'
      )
      for (let index = 0; index < nodes.length; index += 1) {
        const element = nodes[index]
        if (!visible(element) || !matches(element, spec)) continue
        element.scrollIntoView({ block: 'center' })
        // disabled 的按钮 element.click() 是空操作：老实现一律回报 clicked:true，
        // 把「没点着」伪装成「点着了」，后面就只能看见零请求。这里如实标记。
        if (element.disabled === true) {
          return { clicked: false, reason: 'disabled', descriptor: describe(element) }
        }
        element.click()
        return { clicked: true, descriptor: describe(element) }
      }
      return { clicked: false }
    `),
    30_000
  )
  return result
}

/** 填 input（走原生 setter + input/change 事件，React 受控组件才认）。 */
export const typeInto = async (cdp, spec, value) => {
  const result = await cdp.evaluate(
    wrapped(`
      const spec = ${JSON.stringify(spec)}
      const value = ${JSON.stringify(value)}
      const nodes = document.querySelectorAll('input, textarea')
      for (let index = 0; index < nodes.length; index += 1) {
        const element = nodes[index]
        if (!visible(element) || !matches(element, spec)) continue
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return { typed: true, descriptor: describe(element) }
      }
      return { typed: false }
    `),
    30_000
  )
  return result
}

/** 页面上所有可见文本（去重、限量）。错误文案就在里面。 */
export const visibleTexts = (cdp) =>
  cdp.evaluate(
    wrapped(`
      const out = []
      const nodes = document.querySelectorAll('body *')
      for (let index = 0; index < nodes.length; index += 1) {
        const element = nodes[index]
        if (element.children.length > 0) continue
        if (!visible(element)) continue
        const text = (element.textContent || '').trim().replace(/\\s+/g, ' ')
        if (text.length === 0) continue
        out.push(text.slice(0, 200))
        if (out.length >= 60) break
      }
      return out
    `),
    30_000
  )

/** 判断某个文本是否出现在页面上。 */
export const hasText = async (cdp, text) => {
  const result = await cdp.evaluate(
    wrapped(`
      const needle = ${JSON.stringify(text)}
      const body = document.body ? document.body.innerText || '' : ''
      return body.indexOf(needle) >= 0
    `),
    30_000
  )
  return result
}
