/**
 * 代码块行号 / 下载用的纯函数（issue #486 P0-1、P0-4）。
 *
 * 为什么不按 `code.split('\n')` 逐行高亮：Prism 的 token 可以**跨行**（块注释、模板字符串、
 * Python docstring），逐行喂给语法分析会把一条 token 切成两半，颜色与内容都会错。
 * 所以高亮仍然整段做一次（`Prism.highlight(code, …)`），这里只把**已经高亮好的 HTML** 按换行切成
 * 若干行，并在切点补上「行尾闭合 / 下一行重开」的标签 —— 输出仍然是原样 HTML，交给 `pre` 的
 * `innerHTML` 一次性写入，行数变化不会额外产生 React 节点。
 */

type OpenTag = { name: string; open: string }

/** 取标签名与「重开时原样再写一遍」的起始标签（属性要保留，否则重开的那段会丢高亮类名） */
const parseOpenTag = (tag: string): OpenTag | null => {
  const match = /^<\s*([a-zA-Z][^\s/>]*)([^>]*)>$/.exec(tag)
  if (!match) {
    return null
  }
  return { name: match[1], open: `<${match[1]}${match[2]}>` }
}

/**
 * 把 Prism 高亮后的 HTML 按换行切成逐行 HTML；跨行 token 在行尾闭合、下一行按原属性重开。
 *
 * 契约：`lines.join('\n')` 与输入只差「补出来的开闭标签」，渲染结果与整段渲染完全一致
 * （标签只是闭合后在同一位置重开，浏览器排版不变）。
 */
export const splitHighlightedLines = (html: string): string[] => {
  const lines: string[] = []
  const stack: OpenTag[] = []
  const closeAll = () => {
    let result = ''
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      result += `</${stack[index].name}>`
    }
    return result
  }
  const reopenAll = () => {
    let result = ''
    for (const tag of stack) {
      result += tag.open
    }
    return result
  }
  let current = ''
  let index = 0
  while (index < html.length) {
    if (html.charCodeAt(index) !== 60 /* < */) {
      // 纯文本段：只有这里可能出现换行
      const next = html.indexOf('<', index)
      const end = next === -1 ? html.length : next
      const parts = html.slice(index, end).split('\n')
      for (let part = 0; part < parts.length; part += 1) {
        current += parts[part]
        if (part < parts.length - 1) {
          lines.push(current + closeAll())
          current = reopenAll()
        }
      }
      index = end
      continue
    }
    const close = html.indexOf('>', index)
    if (close === -1) {
      current += html.slice(index)
      index = html.length
      continue
    }
    const tag = html.slice(index, close + 1)
    current += tag
    if (tag.startsWith('</')) {
      stack.pop()
    } else if (!tag.endsWith('/>')) {
      const parsed = parseOpenTag(tag)
      if (parsed) {
        stack.push(parsed)
      }
    }
    index = close + 1
  }
  lines.push(current)
  return lines
}

/**
 * 语言名 → 下载文件名用的扩展名。键是「代码块里写的语言名」（含常见别名），
 * 不是 Prism 语言 id：用户写 ```py 时下载的文件名也该是 .py。
 * 不在表里的语言一律 .txt —— 猜错扩展名比给一个通用的 txt 更让人困惑。
 */
const EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  shell: 'sh',
  sh: 'sh',
  zsh: 'sh',
  console: 'sh',
  c: 'c',
  'c++': 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cplusplus: 'cpp',
  'c#': 'cs',
  cs: 'cs',
  csharp: 'cs',
  css: 'css',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  go: 'go',
  golang: 'go',
  graphql: 'graphql',
  gql: 'graphql',
  haskell: 'hs',
  hs: 'hs',
  html: 'html',
  xml: 'xml',
  vue: 'vue',
  ini: 'ini',
  toml: 'toml',
  java: 'java',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  kotlin: 'kt',
  kt: 'kt',
  latex: 'tex',
  tex: 'tex',
  lua: 'lua',
  makefile: 'mk',
  mk: 'mk',
  markdown: 'md',
  md: 'md',
  matlab: 'm',
  mermaid: 'mmd',
  nginx: 'conf',
  objc: 'm',
  objectivec: 'm',
  perl: 'pl',
  php: 'php',
  powershell: 'ps1',
  ps1: 'ps1',
  protobuf: 'proto',
  proto: 'proto',
  py: 'py',
  python: 'py',
  r: 'r',
  rb: 'rb',
  ruby: 'rb',
  rs: 'rs',
  rust: 'rs',
  scala: 'scala',
  scss: 'scss',
  sql: 'sql',
  swift: 'swift',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  yaml: 'yml',
  yml: 'yml',
}

/** 原型链上的键（`toString` / `constructor` 这类）不算语言名 */
const hasLanguage = (name: string): boolean => Object.prototype.hasOwnProperty.call(EXTENSIONS, name)

const safeExtension = (infostring: string): string => {
  const name = infostring.trim().toLowerCase()
  if (hasLanguage(name)) {
    return EXTENSIONS[name]
  }
  // 允许 `python title=foo` 这种带元信息的写法，以及 ```{.python} 这类写法
  const head = name.split(/[\s{,}]/)[0]
  if (head !== '' && hasLanguage(head)) {
    return EXTENSIONS[head]
  }
  return 'txt'
}

/**
 * 代码下载的默认文件名：`snippet.<扩展名>`。
 *
 * 不带上会话 / 代码块序号：同一目录下多次下载时由系统自己加 `(1)`，比我们猜一个可能碰撞的
 * 序号更容易认（也避免文件名里出现时间戳这种不可复现的东西）。
 */
export const codeFileName = (infostring: string): string => `snippet.${safeExtension(infostring)}`
