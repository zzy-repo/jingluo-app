/**
 * hostCapabilityAudit.mjs —— #209 类别 3（平台与宿主能力）的判定核心。
 *
 * 纯函数，不碰文件系统：`auditHostCapabilities(files)` 输入「路径 + 文本」的数组，
 * 输出逐条命中。谁能调用它：
 *  - `tests/unit/host-capability-audit.test.mjs`（进 pnpm test 基线，把 `src/**` 真跑一遍）
 *  - 需要出 `docs/capabilities/host.md` 那张表的人（同一份命中表，不许手写第二份口径）
 *
 * ## 判定的四类结论
 *
 * 能力在不在，不看「浏览器支持不支持」这种笼统说法，只回答一个问题：
 * **这一行代码在 WebView 83（Android 11 原厂 Chromium 83.0.4103.106）上会不会挂。** 于是：
 *
 *  - `已有兜底`   —— 调用点自己探测过（`typeof` / `?.` / `try…catch` / `isPluginAvailable`），
 *                    或者 `src/index.html` 的启动守卫已经把它列进 `REQUIRED`（探不到就不启动并画提示）。
 *  - `无风险`     —— 裸调用，但该 API 的引入版本号 ≤ 83，内核必然有，不需要探测。
 *  - `真实漏洞`   —— 裸调用，而该 API 在 WebView 83 / 原生宿主上**可能不存在或语义不同**。
 *  - `需动态验证` —— API 存在，但行为（回调是否触发、采样率是否被采纳、插件是否注册）静态看不出来。
 *
 * ## 为什么「依赖 fetch 是本尊」单列成高危
 *
 * 本项目在 `src/services/diagnostics/collector.ts` 里把 `window.fetch` 换成了自己的包装
 * （页面级拦截器），同时又有若干处代码默认「`window.fetch` 就是浏览器原生那个」：
 * `response.clone().text()` 读体积、`fetch.bind(window)` 留住原函数、SSE 靠 `response.body` 流式读。
 * Capacitor 的 `native-bridge.js` 在 `plugins.CapacitorHttp.enabled === true` 时会**再换一次**
 * `window.fetch`（换成 `cap.nativePromise` 的壳，并把原函数挪到 `win.CapacitorWebFetch`）。
 * 那一刻：包装层的 `original` 变成桥接 fetch、`response.body` 不再是真流、`clone()` 拿到的是
 * 已经整包缓冲的副本。**今天是关的（capacitor.config.ts 没写这个开关），所以是「引信已装好、
 * 没扣扳机」，按真实漏洞记，风险高。**
 *
 * 判定顺序（`decideVerdict`）写死成一条链，不要在各处再补特例：
 *   forceVerdict（fetch 家族） > bootGated（index.html 已探测） > guarded（调用点探测）
 *   > dynamic（静态不可判定） > chrome ≤ 83（内核必然有） > 真实漏洞
 */

/** 兼容性下限：Android 11 原厂 WebView 的内核版本 */
export const WEBVIEW_MAX_CHROME = 83

/** 四类结论，顺序即 `summary.byVerdict` 的输出顺序（也是文档口径顺序） */
export const VERDICTS = ['已有兜底', '无风险', '真实漏洞', '需动态验证']

/** 文档「处置」列的四个取值 —— 结论到处置的映射只有这一份 */
export const DISPOSITIONS = {
  已有兜底: '已有兜底',
  无风险: '已有兜底',
  真实漏洞: '需探测',
  需动态验证: '需动态验证',
}

/**
 * 能力规则表。每条的字段含义：
 *  - `id`            能力名（文档表格「假设内容」的锚点，也是 summary.byCapability 的分组键）
 *  - `pattern`       匹配调用点的正则（必须带 g，内部会重置 lastIndex）
 *  - `chrome`        该 API 在 Chrome 的引入版本；`null` = 不是浏览器 API（随包发布的 JS 侧 API）
 *  - `risk`          判成真实漏洞时的风险等级
 *  - `secureContext` 仅安全上下文可用（WebView 走 http://localhost 时才是安全上下文）
 *  - `dynamic`       静态不可判定 → 需动态验证
 *  - `present`       取值 `'bundle'` 表示「这是随包发布的 JS 侧 API，一定在」（@capacitor/core 的
 *                    几个函数），裸调用也不判真实漏洞 —— 它回答的是 shell 问题，不是浏览器支持问题
 *  - `forceVerdict`  无视探测结果，直接给这个结论（只给 fetch 家族用，见文件头）
 *  - `guardTokens`   识别 `typeof X` 探测时认可的名字；`a.b` 与 `a`、`b` 互为前后缀都算命中
 *  - `bootGate`      `src/index.html` 的 `REQUIRED` 里对应的名字；出现即视为启动期已探测
 *  - `reason`        写进命中项的理由，文档「假设内容」列的默认文案
 */
export const CAPABILITY_RULES = [
  {
    id: 'navigator.clipboard',
    pattern: /navigator\.clipboard(?![\w$])/gu,
    chrome: 66,
    risk: '中',
    secureContext: true,
    guardTokens: ['navigator.clipboard', 'clipboard'],
    reason: 'navigator.clipboard 非安全上下文下整体为 undefined（局域网 http 打开就不是安全上下文）',
  },
  {
    id: 'Blob.prototype.stream',
    pattern: /\.stream\(\s*\)/gu,
    chrome: 76,
    risk: '低',
    guardTokens: ['Blob', 'blob'],
    reason: 'blob.stream() 引入于 Chrome 76，83 必有',
  },
  {
    id: 'Body.text/arrayBuffer',
    pattern: /\.(?:text|arrayBuffer|blob)\(\s*\)/gu,
    chrome: 76,
    risk: '低',
    guardTokens: ['Blob', 'blob', 'Response'],
    reason: 'Body.text/arrayBuffer 引入于 Chrome 76，83 必有',
  },
  {
    id: 'URL.createObjectURL',
    pattern: /URL\.createObjectURL/gu,
    chrome: 8,
    risk: '低',
    guardTokens: ['URL.createObjectURL', 'URL'],
    reason: 'URL.createObjectURL 引入于 Chrome 8，83 必有',
  },
  {
    id: 'URL.revokeObjectURL',
    pattern: /URL\.revokeObjectURL/gu,
    chrome: 8,
    risk: '低',
    guardTokens: ['URL.revokeObjectURL', 'URL'],
    reason: 'URL.revokeObjectURL 引入于 Chrome 8，83 必有',
  },
  {
    id: 'FileReader',
    pattern: /new FileReader\b/gu,
    chrome: 6,
    risk: '低',
    guardTokens: ['FileReader'],
    reason: 'FileReader 引入于 Chrome 6，83 必有',
  },
  {
    id: 'localStorage',
    pattern: /(?<![\w$])localStorage\s*\.\s*(?:getItem|setItem|removeItem|clear)/gu,
    chrome: 4,
    risk: '中',
    guardTokens: ['localStorage', 'window.localStorage'],
    reason: 'localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch',
  },
  {
    id: 'QuotaExceededError',
    pattern: /QuotaExceededError/gu,
    chrome: 4,
    risk: '低',
    guardTokens: ['QuotaExceededError'],
    reason: '配额溢出只能靠捕获 QuotaExceededError 区分「满了」和「不可用」',
  },
  {
    id: 'Web Share',
    pattern: /navigator\.(?:share|canShare)\b/gu,
    chrome: null,
    risk: '高',
    guardTokens: ['navigator.share', 'navigator.canShare'],
    reason: 'Android WebView 里没有 Web Share API（不是版本问题，是宿主不实现）',
  },
  {
    id: 'Notification',
    pattern: /\bnew Notification\b|Notification\.requestPermission/gu,
    chrome: null,
    risk: '高',
    guardTokens: ['Notification'],
    reason: 'Android WebView 不支持 Web Notification，构造即为 undefined 调用',
  },
  {
    id: 'navigator.onLine',
    pattern: /navigator\.onLine(?![\w$])/gu,
    chrome: 4,
    risk: '低',
    guardTokens: ['navigator.onLine', 'navigator', 'nav'],
    reason: 'navigator.onLine 是「有没有网卡」不是「能不能连上」，只能当弱信号用',
  },
  {
    id: 'AbortController',
    pattern: /new AbortController\(/gu,
    chrome: 66,
    risk: '中',
    guardTokens: ['AbortController'],
    bootGate: 'AbortController',
    reason: 'AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED）',
  },
  {
    id: 'AbortSignal.timeout',
    pattern: /AbortSignal\.(?:timeout|any)(?![\w$])/gu,
    chrome: 103,
    risk: '高',
    guardTokens: ['AbortSignal.timeout', 'AbortSignal.any', 'AbortSignal'],
    reason: 'AbortSignal.timeout 引入于 Chrome 103、AbortSignal.any 引入于 116，WebView 83 都没有',
  },
  {
    id: 'ReadableStream.getReader',
    pattern: /\.getReader\(\s*\)/gu,
    chrome: 43,
    risk: '低',
    guardTokens: ['ReadableStream'],
    reason: 'ReadableStream.getReader 引入于 Chrome 43，83 必有；真正要防的是 body 为 null',
  },
  {
    id: 'TransformStream',
    pattern: /new TransformStream\b/gu,
    chrome: 67,
    risk: '中',
    guardTokens: ['TransformStream'],
    reason: 'TransformStream 引入于 Chrome 67，83 必有',
  },
  {
    id: 'CompressionStream',
    pattern: /new (?:De)?compressionStream\b/gu,
    chrome: 80,
    risk: '中',
    guardTokens: ['CompressionStream', 'DecompressionStream'],
    reason: 'CompressionStream 引入于 Chrome 80，勉强在 83 之内',
  },
  {
    id: 'requestIdleCallback',
    pattern: /(?<![\w$])requestIdleCallback\b/gu,
    chrome: 47,
    risk: '中',
    guardTokens: ['requestIdleCallback'],
    reason: 'requestIdleCallback 在 Chrome 47 就有，但 Safari 系没有；本项目不用它',
  },
  {
    id: 'IntersectionObserver',
    pattern: /new IntersectionObserver\b/gu,
    chrome: 51,
    risk: '中',
    guardTokens: ['IntersectionObserver'],
    reason: 'IntersectionObserver 引入于 Chrome 51，83 必有',
  },
  {
    id: 'ResizeObserver',
    pattern: /new ResizeObserver\b/gu,
    chrome: 64,
    risk: '中',
    guardTokens: ['ResizeObserver'],
    bootGate: 'ResizeObserver',
    reason: 'ResizeObserver 引入于 Chrome 64，83 必有（启动守卫也把它列进 REQUIRED）',
  },
  {
    id: 'matchMedia',
    pattern: /(?<![\w$])matchMedia\(/gu,
    chrome: 9,
    risk: '低',
    guardTokens: ['matchMedia', 'window.matchMedia'],
    reason: 'matchMedia 引入于 Chrome 9，83 必有',
  },
  {
    id: 'visualViewport',
    pattern: /visualViewport(?![\w$])/gu,
    chrome: 61,
    risk: '中',
    guardTokens: ['visualViewport', 'window.visualViewport'],
    reason: 'visualViewport 引入于 Chrome 61，83 必有；键盘弹出后的行为仍需真机确认',
  },
  {
    id: 'Intl.DisplayNames',
    pattern: /Intl\.DisplayNames/gu,
    chrome: 81,
    risk: '中',
    dynamic: true,
    guardTokens: ['Intl.DisplayNames', 'Intl'],
    bootGate: 'Intl.DisplayNames',
    reason: 'Intl.DisplayNames 引入于 Chrome 81，勉强在 83 之内，但语言数据（ICU）齐不齐要实测',
  },
  {
    id: 'CSS.escape',
    pattern: /CSS\.escape\b/gu,
    chrome: 46,
    risk: '低',
    guardTokens: ['CSS.escape', 'CSS'],
    bootGate: 'CSS.escape',
    reason: 'CSS.escape 引入于 Chrome 46，83 必有（启动守卫也把它列进 REQUIRED）',
  },
  {
    id: 'canvas.toBlob',
    pattern: /\.toBlob\(/gu,
    chrome: 50,
    risk: '中',
    dynamic: true,
    guardTokens: ['toBlob'],
    reason: 'toBlob 的回调在部分 WebView 上会拿到 null 甚至不触发，静态判不出',
  },
  {
    id: 'canvas.toDataURL',
    pattern: /\.toDataURL\(/gu,
    chrome: 2,
    risk: '低',
    guardTokens: ['toDataURL'],
    reason: 'toDataURL 引入于 Chrome 2，83 必有',
  },
  {
    id: 'AudioContext',
    pattern: /new (?:webkit)?AudioContext\b/gu,
    chrome: 35,
    risk: '中',
    dynamic: true,
    guardTokens: ['AudioContext'],
    reason: 'AudioContext 的 sampleRate 选项与自动播放策略在不同宿主机型上表现不一致',
  },
  {
    id: 'createImageBitmap',
    pattern: /(?<![\w$])createImageBitmap\b/gu,
    chrome: 50,
    risk: '低',
    guardTokens: ['createImageBitmap'],
    reason: 'createImageBitmap 引入于 Chrome 50，83 必有',
  },
  {
    id: 'Capacitor.isNativePlatform',
    pattern: /Capacitor\.isNativePlatform\(\)/gu,
    chrome: null,
    risk: '低',
    present: 'bundle',
    guardTokens: ['Capacitor'],
    reason: '@capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」',
  },
  {
    id: 'Capacitor.getPlatform',
    pattern: /Capacitor\.getPlatform\(\)/gu,
    chrome: null,
    risk: '低',
    present: 'bundle',
    guardTokens: ['Capacitor'],
    reason: '@capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web"',
  },
  {
    id: 'Capacitor.isPluginAvailable',
    pattern: /isPluginAvailable\b/gu,
    chrome: null,
    risk: '中',
    present: 'bundle',
    guardTokens: ['Capacitor'],
    reason: 'isPluginAvailable 是判断「原生侧到底注册没注册这个插件」的唯一手段',
  },
  {
    id: 'Capacitor.registerPlugin',
    pattern: /(?<![\w$])registerPlugin[<(]/gu,
    chrome: null,
    risk: '中',
    dynamic: true,
    guardTokens: ['Capacitor'],
    reason: 'registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测',
  },
  {
    id: 'fetch 页面级拦截',
    pattern: /window\.fetch\s*=(?!=)|globalThis\.fetch\s*=(?!=)|CapacitorWebFetch/gu,
    chrome: null,
    risk: '高',
    forceVerdict: '真实漏洞',
    reason: '依赖 fetch 是本尊：页面把 window.fetch 换成包装后，任何「原生 fetch」假设（bind、clone、body 流）都不再成立',
  },
  {
    id: 'fetch 响应体 clone',
    pattern: /\.clone\(\s*\)\s*\.\s*(?:text|json|arrayBuffer|blob)\(/gu,
    chrome: null,
    risk: '中',
    forceVerdict: '真实漏洞',
    onReason: '依赖 fetch 是本尊：clone().text() 会把流式响应整包读完才 resolve（实测见 #209 类别 3 报告）',
  },
]

/** 一行里出现这些就说明调用点自己探测过（与 API 名字无关的通用信号） */
const GENERIC_GUARDS = [
  { name: 'optional-chaining', re: /\?\.[A-Za-z_$]/, sameLineOnly: true },
  { name: 'nullish-fallback', re: /\?\?/, sameLineOnly: true },
  { name: 'promise-catch', re: /\.catch\(/ },
  { name: 'isPluginAvailable', re: /isPluginAvailable\s*\(/ },
  { name: 'in-window', re: /\bin\s+window\b/ },
  { name: 'try-catch', re: /try\s*\{[\s\S]*?\}\s*catch\b/ },
]

/** 探测窗口：命中行的前 15 行到后 4 行（`try {` 与 `catch` 通常隔着几行） */
const WINDOW_BEFORE = 15
const WINDOW_AFTER = 4

const isCommentLine = (line) => /^\s*(?:\/\/|\*|\/\*)/u.test(line)

const tokenMatches = (probed, tokens) =>
  tokens.some(
    (token) =>
      probed === token ||
      probed.startsWith(`${token}.`) ||
      token.startsWith(`${probed}.`) ||
      (probed.includes('.') && token.endsWith(`.${probed.split('.').pop()}`))
  )

/**
 * 命中行自己（或邻近窗口）有没有探测。
 * 返回命中的探测方式名，没探测返回 null —— 名字会带进文档，方便人复核。
 */
const detectGuard = (rule, lineText, windowText) => {
  for (const guard of GENERIC_GUARDS) {
    const text = guard.sameLineOnly ? lineText : windowText
    if (guard.re.test(text)) {
      return guard.name
    }
  }
  for (const match of windowText.matchAll(/typeof\s+([A-Za-z_$][\w$.]*)/gu)) {
    if (tokenMatches(match[1], rule.guardTokens ?? [])) {
      return `typeof ${match[1]}`
    }
  }
  return null
}

/** 结论判定链（顺序见文件头，改这里等于改口径，必须同步文档与测试） */
const decideVerdict = (rule, { guarded, bootGated }) => {
  if (rule.forceVerdict) {
    return rule.forceVerdict
  }
  if (bootGated) {
    return '已有兜底'
  }
  if (guarded) {
    return '已有兜底'
  }
  if (rule.present === 'bundle') {
    return '无风险'
  }
  if (rule.dynamic) {
    return '需动态验证'
  }
  if (typeof rule.chrome === 'number' && rule.chrome <= WEBVIEW_MAX_CHROME) {
    return '无风险'
  }
  return '真实漏洞'
}

const riskOf = (rule, verdict) => {
  if (verdict === '真实漏洞') {
    return rule.risk ?? '中'
  }
  if (verdict === '需动态验证') {
    return '中'
  }
  return '低'
}

/** 从 `src/index.html` 里抽出启动守卫的 `REQUIRED` 名单（数组元素是 `['名字', 函数]`，要按括号配对取） */
const readBootGate = (text) => {
  const list = new Set()
  const start = /\bREQUIRED\s*=\s*\[/u.exec(text)
  if (!start) {
    return list
  }
  let depth = 0
  let end = -1
  for (let index = start.index + start[0].length - 1; index < text.length; index += 1) {
    if (text[index] === '[') depth += 1
    else if (text[index] === ']') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) {
    return list
  }
  for (const item of text.slice(start.index, end).matchAll(/['"`]([^'"`]+)['"`]/gu)) {
    list.add(item[1])
  }
  return list
}

/** 把块注释抹成空白（保留行号与行数）：注释里写着「Intl.DisplayNames 必须列进来」不算调用点 */
const maskBlockComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))

const normalizeFiles = (files) => {
  if (!Array.isArray(files)) {
    throw new TypeError('auditHostCapabilities(files) 需要一个数组')
  }
  return files.map((entry, index) => {
    const file = entry?.file ?? entry?.path
    const text = entry?.text ?? entry?.content
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError(`第 ${index} 项缺少 file/path`)
    }
    if (typeof text !== 'string') {
      throw new TypeError(`第 ${index} 项（${file}）缺少 text/content`)
    }
    return { file: file.split('\\').join('/'), text }
  })
}

const emptyVerdictCounts = () => Object.fromEntries(VERDICTS.map((name) => [name, 0]))

/**
 * 跑一遍审计。
 *
 * @param {Array<{file?: string, path?: string, text?: string, content?: string}>} files
 * @returns {{hits: Array<object>, summary: object}}
 */
export const auditHostCapabilities = (files) => {
  const list = normalizeFiles(files)

  // 跨文件信息：启动守卫探过的能力，等于在页面启动阶段就兜住了
  const bootGate = new Set()
  for (const { file, text } of list) {
    if (/(?:^|\/)index\.html$/u.test(file)) {
      for (const name of readBootGate(text)) {
        bootGate.add(name)
      }
    }
  }

  const hits = []
  for (const { file, text } of list) {
    const lines = text.split('\n')
    const codeLines = maskBlockComments(text).split('\n')
    for (const rule of CAPABILITY_RULES) {
      for (let index = 0; index < codeLines.length; index += 1) {
        const lineText = codeLines[index]
        if (isCommentLine(lineText)) {
          continue
        }
        rule.pattern.lastIndex = 0
        if (!rule.pattern.test(lineText)) {
          continue
        }
        const from = Math.max(0, index - WINDOW_BEFORE)
        const to = Math.min(codeLines.length, index + WINDOW_AFTER + 1)
        const windowText = codeLines.slice(from, to).join('\n')
        const guard = detectGuard(rule, lineText, windowText)
        const bootGated = Boolean(rule.bootGate) && bootGate.has(rule.bootGate)
        const verdict = decideVerdict(rule, { guarded: Boolean(guard), bootGated })
        hits.push({
          file,
          line: index + 1,
          capability: rule.id,
          guarded: Boolean(guard) || bootGated,
          verdict,
          risk: riskOf(rule, verdict),
          disposition: DISPOSITIONS[verdict],
          guard: guard ?? (bootGated ? 'index.html REQUIRED' : null),
          reason: rule.onReason && (guard === null) ? rule.onReason : rule.reason,
          snippet: (lines[index] ?? '').trim().slice(0, 160),
        })
      }
    }
  }

  hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))

  const byVerdict = emptyVerdictCounts()
  const byRisk = { 高: 0, 中: 0, 低: 0 }
  const perCapability = new Map()
  for (const hit of hits) {
    byVerdict[hit.verdict] += 1
    byRisk[hit.risk] += 1
    const bucket = perCapability.get(hit.capability) ?? { capability: hit.capability, total: 0, verdicts: emptyVerdictCounts() }
    bucket.total += 1
    bucket.verdicts[hit.verdict] += 1
    perCapability.set(hit.capability, bucket)
  }

  const byCapability = [...perCapability.values()].sort(
    (a, b) => b.total - a.total || (a.capability < b.capability ? -1 : 1)
  )

  return {
    hits,
    summary: {
      files: list.length,
      total: hits.length,
      byVerdict,
      byRisk,
      byCapability,
      bootGated: [...bootGate].sort(),
      realVulnerabilities: hits.filter((hit) => hit.verdict === '真实漏洞'),
      needsDynamic: hits.filter((hit) => hit.verdict === '需动态验证'),
    },
  }
}

export default auditHostCapabilities
