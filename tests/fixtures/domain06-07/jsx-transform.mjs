/**
 * 极简 JSX → `jsx()` 调用转换器（**只给 tests/fixtures/domain06-07 用**）。
 *
 * 为什么自己写：本仓库的 `typescript` 是 7.x 原生版（没有 `transpileModule`），`@swc/core` /
 * `esbuild` / `@babel/core` 都不在依赖里；而 Node 自带的 `stripTypeScriptTypes()` 只处理类型、
 * **不处理 JSX**。为了让「Node 里真跑一次组件」这件事不依赖新依赖、不启动浏览器、不改生产代码，
 * 这里只做一件事：把 JSX 片段改写成语义等价的 `__jsx(type, props, key)` 调用，
 * 其余 TS 语法原封不动交给 `stripTypeScriptTypes()`。
 *
 * 覆盖面（= 本域两个 `.tsx` 实际用到的语法）：
 *   - 元素 / 自闭合 / 片段 `<>…</>` / 成员名 `<A.B>`；
 *   - 属性：字符串 `a="b"`、表达式 `a={expr}`、布尔简写 `a`、展开 `{...props}`；
 *   - 子节点：嵌套元素、`{expr}`、纯文本（按 JSX 规则折叠空白）；
 *   - 表达式里的一切花括号平衡问题（字符串 / 模板串 / 正则字形 / 注释 / 箭头函数 `=>`）。
 * 不覆盖：命名空间标签、JSX 注释以外的特殊字形（有的话用例会直接报语法错误，而不是静默通过）。
 */

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$.-]/

const isSpace = (char) => char === ' ' || char === '\t' || char === '\n' || char === '\r'

/** 跳过字符串 / 模板串 / 注释 / 正则字面量，返回「这个 JS 记号的结束位置」 */
const skipJsToken = (source, index) => {
  const char = source[index]
  if (char === '"' || char === "'") {
    let cursor = index + 1
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (source[cursor] === char) {
        return cursor + 1
      }
      cursor += 1
    }
    return source.length
  }
  if (char === '`') {
    let cursor = index + 1
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (source[cursor] === '`') {
        return cursor + 1
      }
      if (source[cursor] === '$' && source[cursor + 1] === '{') {
        cursor = scanBalanced(source, cursor + 1, '{', '}') + 1
        continue
      }
      cursor += 1
    }
    return source.length
  }
  if (char === '/' && source[index + 1] === '/') {
    const end = source.indexOf('\n', index)
    return end === -1 ? source.length : end
  }
  if (char === '/' && source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2)
    return end === -1 ? source.length : end + 2
  }
  return -1
}

/** 从左花括号扫到配对的右花括号（返回右花括号的下标） */
const scanBalanced = (source, index, open, close) => {
  let depth = 0
  let cursor = index
  while (cursor < source.length) {
    const skipped = skipJsToken(source, cursor)
    if (skipped !== -1) {
      cursor = skipped
      continue
    }
    const char = source[cursor]
    if (char === open) {
      depth += 1
    } else if (char === close) {
      depth -= 1
      if (depth === 0) {
        return cursor
      }
    }
    cursor += 1
  }
  throw new Error('JSX 转换：花括号不平衡')
}

const readJsxName = (source, index) => {
  let cursor = index
  while (cursor < source.length && IDENT_PART.test(source[cursor])) {
    cursor += 1
  }
  return { name: source.slice(index, cursor), end: cursor }
}

const collapseText = (text) => text.replace(/\s+/gu, ' ').trim()

const quote = (text) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

const isIdentifierName = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)

/** 解析一个 JSX 元素，返回 { code, end } */
const parseElement = (source, start) => {
  let index = start + 1 // 跳过 '<'
  if (source[index] === '>') {
    // 片段 <>
    const children = parseChildren(source, index + 1, '</>')
    return {
      code: `__jsx(__jsxFragment, ${propsCode([], children)})`,
      end: children.end,
    }
  }
  const { name, end: nameEnd } = readJsxName(source, index)
  index = nameEnd
  const attributes = []
  let selfClosing = false
  while (index < source.length) {
    while (isSpace(source[index])) {
      index += 1
    }
    if (source[index] === '/' && source[index + 1] === '>') {
      selfClosing = true
      index += 2
      break
    }
    if (source[index] === '>') {
      index += 1
      break
    }
    if (source[index] === '{') {
      const close = scanBalanced(source, index, '{', '}')
      attributes.push({ spread: transformSource(source.slice(index + 1, close)) })
      index = close + 1
      continue
    }
    const { name: attributeName, end: attributeEnd } = readJsxName(source, index)
    if (attributeName === '') {
      throw new Error(`JSX 转换：属性名解析失败 @${index}`)
    }
    index = attributeEnd
    while (isSpace(source[index])) {
      index += 1
    }
    if (source[index] !== '=') {
      attributes.push({ name: attributeName, value: 'true' })
      continue
    }
    index += 1
    while (isSpace(source[index])) {
      index += 1
    }
    const valueChar = source[index]
    if (valueChar === '"' || valueChar === "'") {
      const close = source.indexOf(valueChar, index + 1)
      attributes.push({ name: attributeName, value: quote(source.slice(index + 1, close)) })
      index = close + 1
      continue
    }
    if (valueChar === '{') {
      const close = scanBalanced(source, index, '{', '}')
      attributes.push({
        name: attributeName,
        value: `(${transformSource(source.slice(index + 1, close))})`,
      })
      index = close + 1
      continue
    }
    throw new Error(`JSX 转换：属性值解析失败 @${index}`)
  }
  const children = selfClosing
    ? { children: [], end: index }
    : parseChildren(source, index, `</${name}>`)
  const typeCode = isIdentifierName(name) && /^[a-z]/u.test(name) ? quote(name) : name
  return { code: `__jsx(${typeCode}, ${propsCode(attributes, children)})`, end: children.end }
}

/** 子节点：一直扫到 `</name>`（或 `</>`）为止 */
const parseChildren = (source, start, closingTag) => {
  const parts = []
  let index = start
  let text = ''
  const flushText = () => {
    const collapsed = collapseText(text)
    if (collapsed !== '') {
      parts.push(quote(collapsed))
    }
    text = ''
  }
  while (index < source.length) {
    if (source.startsWith(closingTag, index)) {
      flushText()
      return { children: parts, end: index + closingTag.length }
    }
    if (source[index] === '<') {
      flushText()
      const element = parseElement(source, index)
      parts.push(element.code)
      index = element.end
      continue
    }
    if (source[index] === '{') {
      flushText()
      const close = scanBalanced(source, index, '{', '}')
      const expression = source.slice(index + 1, close).trim()
      // JSX 注释 {/* ... */} 直接丢掉
      if (expression !== '' && !expression.startsWith('/*')) {
        parts.push(`(${transformSource(expression)})`)
      }
      index = close + 1
      continue
    }
    text += source[index]
    index += 1
  }
  throw new Error(`JSX 转换：子节点没有闭合（缺少 ${closingTag}）`)
}

const propsCode = (attributes, children) => {
  const fields = []
  for (const attribute of attributes) {
    if (attribute.spread !== undefined) {
      const spread = attribute.spread.trim()
      // 展开属性原样带过去（`{...rest}`），别再套一层括号
      fields.push(spread.startsWith('...') ? spread : `...(${spread})`)
      continue
    }
    const name = isIdentifierName(attribute.name) ? attribute.name : quote(attribute.name)
    fields.push(`${name}: ${attribute.value}`)
  }
  if (children.children.length === 1) {
    fields.push(`children: ${children.children[0]}`)
  } else if (children.children.length > 1) {
    fields.push(`children: [${children.children.join(', ')}]`)
  }
  return `{ ${fields.join(', ')} }`
}

/** `<` 是不是一个 JSX 开头（而不是小于号 / 泛型） */
const startsJsx = (source, index) => {
  const next = source[index + 1]
  if (next === undefined) {
    return false
  }
  if (next === '>') {
    return true
  }
  if (next === '/') {
    return false
  }
  if (!IDENT_START.test(next)) {
    return false
  }
  // 往回找上一个有效字符：只有在「表达式可以开始」的位置才当 JSX
  let cursor = index - 1
  while (cursor >= 0 && isSpace(source[cursor])) {
    cursor -= 1
  }
  if (cursor < 0) {
    // 片段开头（属性值 / 子表达式里的 JSX 就长这样）
    return true
  }
  const previous = source[cursor]
  return '(,=:?&|!{};\n>+['.includes(previous) || source[cursor] === '\n'
}

/** 把一段源码里的 JSX 全部改写成 `__jsx(...)`（可重入：属性值 / 子表达式的 JSX 也走这里） */
function transformSource(source) {
  let output = ''
  let index = 0
  while (index < source.length) {
    const skipped = skipJsToken(source, index)
    if (skipped !== -1) {
      output += source.slice(index, skipped)
      index = skipped
      continue
    }
    if (source[index] === '<' && startsJsx(source, index)) {
      const element = parseElement(source, index)
      output += element.code
      index = element.end
      continue
    }
    output += source[index]
    index += 1
  }
  return output
}

export const transformJsx = (source) =>
  `import { jsx as __jsx, jsxs as __jsxs, Fragment as __jsxFragment } from 'react/jsx-runtime'\n${transformSource(source)}`
