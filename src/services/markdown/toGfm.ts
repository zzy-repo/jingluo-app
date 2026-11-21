import type { PhrasingContent, Table } from 'mdast'

/**
 * 表格 → GFM 管道表格（issue #486 P0-3）。
 *
 * 为什么从 AST 序列化而不是读 `innerText`：渲染出来的 `<td>` 里没有列边界信息，
 * `innerText` 会把「列」压成一行空格连排，粘回去就不再是表格；语义（强调 / 代码 / 链接）
 * 也会一起丢掉。AST 里这些都在，所以这里按 GFM 语法逐格重建。
 */

/** 单元格里的换行在 GFM 表格里非法，压成空格；`|` 是列分隔符，必须转义 */
const escapeCell = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

/** 把行内节点序列化成 GFM 行内语法 */
const inlineToGfm = (node: PhrasingContent): string => {
  switch (node.type) {
    case 'text':
      return node.value
    case 'inlineCode': {
      // 内容里带反引号时用更长的定界符包住（GFM 的标准做法）
      const longest = /`+/g
      let run = 0
      let match = longest.exec(node.value)
      while (match !== null) {
        run = Math.max(run, match[0].length)
        match = longest.exec(node.value)
      }
      const fence = '`'.repeat(run + 1)
      const pad = node.value.startsWith('`') || node.value.endsWith('`') ? ' ' : ''
      return `${fence}${pad}${node.value}${pad}${fence}`
    }
    case 'emphasis':
      return `*${node.children.map(inlineToGfm).join('')}*`
    case 'strong':
      return `**${node.children.map(inlineToGfm).join('')}**`
    case 'delete':
      return `~~${node.children.map(inlineToGfm).join('')}~~`
    case 'link':
      return `[${node.children.map(inlineToGfm).join('')}](${node.url})`
    case 'image':
      return `![${node.alt ?? ''}](${node.url})`
    case 'inlineMath':
      return `$${node.value}$`
    case 'break':
      return ' '
    case 'html':
      return node.value
    case 'citation':
      return `[citation:${node.source.index}]`
    default:
      // 解析阶段（parse.ts）已经把脚注 / 引用式链接 / 定义换成纯文本，其余类型不参与表格
      return ''
  }
}

const rowToCells = (row: Table['children'][number]): string[] =>
  row.children.map((cell) => escapeCell(cell.children.map(inlineToGfm).join('')))

/** `:---` / `:---:` / `---:`，null 与缺省都出 `---`（GFM 默认左对齐） */
const delimiter = (align: Table['align'], index: number): string => {
  const value = align === undefined || align === null ? null : align[index] ?? null
  if (value === 'center') {
    return ':---:'
  }
  if (value === 'right') {
    return '---:'
  }
  if (value === 'left') {
    return ':---'
  }
  return '---'
}

/**
 * 输出标准 GFM：表头行 + 分隔行 + 数据行，每格左右各一个空格，列数按表头补齐。
 * 空表（没有表头）返回空串，调用方据此不显示复制入口。
 */
export const tableToGfm = (node: Table): string => {
  const rows = node.children
  if (rows.length === 0 || rows[0].children.length === 0) {
    return ''
  }
  const columns = rows[0].children.length
  const pad = (cells: string[]): string[] => {
    const result = cells.slice(0, columns)
    while (result.length < columns) {
      result.push('')
    }
    return result
  }
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const output = [line(pad(rowToCells(rows[0])))]
  output.push(line(pad(Array.from({ length: columns }, (_, index) => delimiter(node.align, index)))))
  for (const row of rows.slice(1)) {
    output.push(line(pad(rowToCells(row))))
  }
  return output.join('\n')
}
