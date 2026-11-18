#!/usr/bin/env node
/**
 * 兼容性探针：给定目标 WebView（Chromium 主版本号），判定一份特性清单里哪些**不可用**，
 * 也就是「哪一版 WebView 会先出问题」。
 *
 * 与 scripts/check-bundle-syntax.mjs 的分工（两者互补，不重复）：
 *   - check-bundle-syntax.mjs：检查**已经构建出来的产物**里是否出现 Chrome 83 不支持的语法/内置对象（黑名单，只认 83）。
 *   - probe.mjs：回答**任意目标版本**下「这份特性清单里哪些会挂」，并给出每条特性的最低版本与依据，
 *     支持 --scan 把源码里的使用点定位到具体文件行，供各条工作线自查。
 *
 * 输出的一切结论都是**静态推断**：来自 MDN / caniuse 的公开版本表 + 源码文本扫描，
 * 不是真机验证。任何报告都必须保留「静态推断」标注，不得写成真机通过。
 *
 * 用法：
 *   node scripts/compat/probe.mjs --target chromium83
 *   node scripts/compat/probe.mjs --target chromium79 --json
 *   node scripts/compat/probe.mjs --target all
 *   node scripts/compat/probe.mjs --scan src --target chromium83
 *   node scripts/compat/probe.mjs --list
 *
 * 退出码：0 = 目标版本上全部可用；1 = 存在不可用特性（或扫描点落在不可用特性上）；2 = 用法错误。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** 本项目 browserslist 下限（package.json: chrome >= 83 / edge >= 83）。 */
export const BASELINE_CHROMIUM = 83

export const PRESET_TARGETS = {
  chromium79: 79,
  chromium83: 83,
  chromium91: 91,
  chromium109: 109,
}

/**
 * 特性清单。minChrome 是**最低可用**的 Chromium 主版本（<= 该版本可用）。
 * basis 写依据来源 + 条目名，便于复核；所有条目均为静态推断。
 * usage 是源码扫描用的正则，命中即说明这片源码在这条特性上的最低版本要求生效。
 */
export const FEATURES = [
  // ---- 语法 ----
  {
    id: 'optional-chaining',
    kind: 'syntax',
    label: '可选链 a?.b / a?.[k] / a?.()',
    minChrome: 80,
    basis: 'MDN Optional chaining / caniuse "optional chaining"：Chrome 80',
    usage: /\?\.[a-zA-Z_$[(]/,
  },
  {
    id: 'nullish-coalescing',
    kind: 'syntax',
    label: '空值合并 a ?? b',
    minChrome: 80,
    basis: 'MDN Nullish coalescing operator / caniuse "nullish coalescing"：Chrome 80',
    usage: /[^?]\?\?[^=?]/,
  },
  {
    id: 'logical-assignment',
    kind: 'syntax',
    label: '逻辑赋值 ||= &&= ??=',
    minChrome: 85,
    basis: 'MDN Logical assignment / caniuse "logical assignment"：Chrome 85',
    usage: /(\|\|=|&&=|\?\?=)/,
  },
  {
    id: 'class-static-block',
    kind: 'syntax',
    label: '类静态初始化块 static { }',
    minChrome: 94,
    basis: 'MDN Class static initialization blocks / caniuse：Chrome 94',
    usage: /static\s*\{/,
  },
  {
    id: 'numeric-separator',
    kind: 'syntax',
    label: '数字分隔符 1_000_000',
    minChrome: 75,
    basis: 'MDN Numeric separators / caniuse "numeric separators"：Chrome 75',
    usage: /\b\d+_\d/,
  },
  {
    id: 'class-fields',
    kind: 'syntax',
    label: '类字段（实例/静态公有字段）x = 1 / static y = 2',
    minChrome: 72,
    basis: 'MDN Public class fields / caniuse "class fields"：Chrome 72',
    usage: /^\s+(static\s+)?[a-zA-Z_$][\w$]*\s*=\s*[^=]/m,
  },
  {
    id: 'private-members',
    kind: 'syntax',
    label: '私有字段/方法 #x',
    minChrome: 74,
    basis: 'MDN Private class features / caniuse "private class fields"：Chrome 74',
    usage: /#[a-zA-Z_$][\w$]*\s*[=(;]/,
  },
  {
    id: 'top-level-await',
    kind: 'syntax',
    label: '模块顶层 await',
    minChrome: 89,
    basis: 'MDN top level await / caniuse "top level await"：Chrome 89',
    usage: /^await\s/m,
  },
  {
    id: 'named-capture-group',
    kind: 'syntax',
    label: '正则命名捕获组 (?<name>...)',
    minChrome: 64,
    basis: 'MDN Named capture groups / caniuse "regexp named capture groups"：Chrome 64',
    usage: /\(\?<[a-zA-Z_$][\w$]*>/,
  },
  {
    id: 'regexp-d-flag',
    kind: 'syntax',
    label: '正则 d 标志（match indices）',
    minChrome: 90,
    basis: 'MDN RegExp hasIndices / caniuse "regexp match indices"：Chrome 90',
    usage: /\/[dgimsuy]*d[dgimsuy]*[.,;)]/,
  },
  {
    id: 'lookbehind',
    kind: 'syntax',
    label: '正则后行断言 (?<=...) / (?<!...)',
    minChrome: 62,
    basis: 'MDN Lookbehind assertions / caniuse "regexp lookbehind"：Chrome 62',
    usage: /\(\?<[=!]/,
  },
  {
    id: 'bigint',
    kind: 'syntax',
    label: 'BigInt 字面量与 BigInt()',
    minChrome: 67,
    basis: 'MDN BigInt / caniuse "BigInt"：Chrome 67',
    usage: /\b\d+n\b|\bBigInt\s*\(/,
  },
  {
    id: 'optional-catch-binding',
    kind: 'syntax',
    label: 'catch { } 省略绑定',
    minChrome: 66,
    basis: 'MDN Optional catch binding：Chrome 66',
    usage: /catch\s*\{/,
  },
  {
    id: 'import-meta',
    kind: 'syntax',
    label: 'import.meta',
    minChrome: 64,
    basis: 'MDN import.meta：Chrome 64',
    usage: /\bimport\.meta\b/,
  },
  // ---- 内置对象 / 浏览器 API ----
  {
    id: 'fetch',
    kind: 'api',
    label: 'fetch()',
    minChrome: 42,
    basis: 'MDN fetch / caniuse "fetch"：Chrome 42',
    usage: /\bfetch\s*\(/,
  },
  {
    id: 'abort-controller',
    kind: 'api',
    label: 'AbortController',
    minChrome: 66,
    basis: 'MDN AbortController / caniuse：Chrome 66',
    usage: /\bAbortController\b/,
  },
  {
    id: 'abort-signal-timeout',
    kind: 'api',
    label: 'AbortSignal.timeout() / AbortSignal.any()',
    minChrome: 103,
    basis: 'MDN AbortSignal.timeout：Chrome 103（any() 同版本）',
    usage: /AbortSignal\.(timeout|any)\s*\(/,
  },
  {
    id: 'readable-stream',
    kind: 'api',
    label: 'ReadableStream / getReader()',
    minChrome: 43,
    basis: 'MDN ReadableStream / caniuse "Streams"：Chrome 43',
    usage: /\bReadableStream\b|\.getReader\s*\(/,
  },
  {
    id: 'pipe-through',
    kind: 'api',
    label: 'Stream pipeThrough() / TransformStream',
    minChrome: 67,
    basis: 'MDN TransformStream / pipeThrough：Chrome 67',
    usage: /\.pipeThrough\s*\(|\bTransformStream\b/,
  },
  {
    id: 'promise-allsettled',
    kind: 'api',
    label: 'Promise.allSettled()',
    minChrome: 76,
    basis: 'MDN Promise.allSettled / caniuse：Chrome 76',
    usage: /Promise\.allSettled\s*\(/,
  },
  {
    id: 'promise-any',
    kind: 'api',
    label: 'Promise.any() + AggregateError',
    minChrome: 85,
    basis: 'MDN Promise.any / caniuse：Chrome 85',
    usage: /Promise\.any\s*\(|\bAggregateError\b/,
  },
  {
    id: 'object-fromentries',
    kind: 'api',
    label: 'Object.fromEntries()',
    minChrome: 73,
    basis: 'MDN Object.fromEntries：Chrome 73',
    usage: /Object\.fromEntries\s*\(/,
  },
  {
    id: 'object-hasown',
    kind: 'api',
    label: 'Object.hasOwn()',
    minChrome: 93,
    basis: 'MDN Object.hasOwn：Chrome 93',
    usage: /Object\.hasOwn\s*\(/,
  },
  {
    id: 'string-replaceall',
    kind: 'api',
    label: 'String.prototype.replaceAll()',
    minChrome: 85,
    basis: 'MDN String.replaceAll：Chrome 85',
    usage: /\.replaceAll\s*\(/,
  },
  {
    id: 'string-at',
    kind: 'api',
    label: 'String.prototype.at()',
    minChrome: 92,
    basis: 'MDN String.prototype.at：Chrome 92',
    usage: /["'`][^"'`]*["'`]\s*\.at\s*\(|\bstr\w*\.at\s*\(/,
  },
  {
    id: 'array-at',
    kind: 'api',
    label: 'Array.prototype.at()',
    minChrome: 92,
    basis: 'MDN Array.prototype.at：Chrome 92',
    usage: /\b\w+(\.|\?\.)at\s*\(\s*-?\d/,
  },
  {
    id: 'array-findlast',
    kind: 'api',
    label: 'Array.prototype.findLast / findLastIndex',
    minChrome: 97,
    basis: 'MDN Array.findLast：Chrome 97',
    usage: /\.findLast(Index)?\s*\(/,
  },
  {
    id: 'array-tosorted',
    kind: 'api',
    label: 'Array.prototype.toSorted / toReversed / with',
    minChrome: 110,
    basis: 'MDN Array.prototype.toSorted：Chrome 110',
    usage: /\.(toSorted|toReversed|toSpliced)\s*\(|\btoReversed\s*\(/,
  },
  {
    id: 'object-groupby',
    kind: 'api',
    label: 'Object.groupBy / Map.groupBy',
    minChrome: 117,
    basis: 'MDN Object.groupBy：Chrome 117',
    usage: /Object\.groupBy\s*\(|Map\.groupBy\s*\(/,
  },
  {
    id: 'structured-clone',
    kind: 'api',
    label: 'structuredClone()',
    minChrome: 98,
    basis: 'MDN structuredClone：Chrome 98',
    usage: /\bstructuredClone\s*\(/,
  },
  {
    id: 'weakref',
    kind: 'api',
    label: 'WeakRef / FinalizationRegistry',
    minChrome: 84,
    basis: 'MDN WeakRef：Chrome 84',
    usage: /\bWeakRef\b|\bFinalizationRegistry\b/,
  },
  {
    id: 'queue-microtask',
    kind: 'api',
    label: 'queueMicrotask()',
    minChrome: 71,
    basis: 'MDN queueMicrotask：Chrome 71',
    usage: /\bqueueMicrotask\s*\(/,
  },
  {
    id: 'intl-segmenter',
    kind: 'api',
    label: 'Intl.Segmenter（按字素切分 emoji / 组合字符）',
    minChrome: 87,
    basis: 'MDN Intl.Segmenter / caniuse：Chrome 87',
    usage: /Intl\.Segmenter/,
  },
  {
    id: 'intl-displaynames',
    kind: 'api',
    label: 'Intl.DisplayNames',
    minChrome: 81,
    basis: 'MDN Intl.DisplayNames / caniuse：Chrome 81',
    usage: /Intl\.DisplayNames/,
  },
  {
    id: 'intl-listformat',
    kind: 'api',
    label: 'Intl.ListFormat',
    minChrome: 72,
    basis: 'MDN Intl.ListFormat：Chrome 72',
    usage: /Intl\.ListFormat/,
  },
  {
    id: 'clipboard-api',
    kind: 'api',
    label: 'navigator.clipboard.writeText()',
    minChrome: 66,
    basis: 'MDN Clipboard API / caniuse "async clipboard"：Chrome 66',
    usage: /navigator\.clipboard/,
  },
  {
    id: 'resize-observer',
    kind: 'api',
    label: 'ResizeObserver',
    minChrome: 64,
    basis: 'MDN ResizeObserver / caniuse：Chrome 64',
    usage: /\bResizeObserver\b/,
  },
  {
    id: 'intersection-observer',
    kind: 'api',
    label: 'IntersectionObserver',
    minChrome: 51,
    basis: 'MDN IntersectionObserver / caniuse：Chrome 51',
    usage: /\bIntersectionObserver\b/,
  },
  {
    id: 'request-idle-callback',
    kind: 'api',
    label: 'requestIdleCallback()',
    minChrome: 47,
    basis: 'MDN requestIdleCallback / caniuse：Chrome 47',
    usage: /\brequestIdleCallback\s*\(/,
  },
  {
    id: 'match-media',
    kind: 'api',
    label: 'window.matchMedia()',
    minChrome: 9,
    basis: 'MDN matchMedia / caniuse：Chrome 9',
    usage: /\bmatchMedia\s*\(/,
  },
  {
    id: 'crypto-randomuuid',
    kind: 'api',
    label: 'crypto.randomUUID()',
    minChrome: 92,
    basis: 'MDN Crypto.randomUUID：Chrome 92',
    usage: /crypto\.randomUUID\s*\(/,
  },
  {
    id: 'blob-text',
    kind: 'api',
    label: 'Blob.prototype.text() / arrayBuffer()',
    minChrome: 76,
    basis: 'MDN Blob.text：Chrome 76',
    usage: /\.(text|arrayBuffer)\s*\(\s*\)/,
  },
  {
    id: 'navigator-online',
    kind: 'api',
    label: 'navigator.onLine',
    minChrome: 14,
    basis: 'MDN Navigator.onLine：Chrome 14',
    usage: /navigator\.onLine/,
  },
  // ---- CSS / 布局 ----
  {
    id: 'css-has',
    kind: 'css',
    label: 'CSS :has() 选择器',
    minChrome: 105,
    basis: 'MDN :has() / caniuse：Chrome 105',
    usage: /:has\(/,
  },
  {
    id: 'css-dvh',
    kind: 'css',
    label: 'CSS dvh / svh / lvh 单位',
    minChrome: 108,
    basis: 'MDN dynamic viewport units / caniuse：Chrome 108',
    usage: /\b(d|s|l)vh\b/,
  },
  {
    id: 'css-nesting',
    kind: 'css',
    label: 'CSS 原生嵌套',
    minChrome: 112,
    basis: 'MDN CSS nesting / caniuse：Chrome 112',
    usage: /^\s{2,}[&.][\w-]+\s*\{/m,
  },
]

const byId = new Map(FEATURES.map((feature) => [feature.id, feature]))

const usage = `用法：
  node scripts/compat/probe.mjs --target chromium83 [--json]
  node scripts/compat/probe.mjs --target all
  node scripts/compat/probe.mjs --scan src [--target chromium83]
  node scripts/compat/probe.mjs --list

目标可用写法：chromium<主版本号>（如 chromium79 / chromium83 / chromium91 / chromium109），或 all。
退出码：0 全部可用 / 1 有不可用特性 / 2 用法错误。`

const parseArgs = (argv) => {
  const options = { target: null, json: false, list: false, scan: null, all: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--list') {
      options.list = true
    } else if (arg === '--target') {
      options.target = argv[++index] ?? null
    } else if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length)
    } else if (arg === '--scan') {
      options.scan = argv[++index] ?? null
    } else if (arg.startsWith('--scan=')) {
      options.scan = arg.slice('--scan='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.list = false
      options.help = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

/** 解析目标：返回选中的 Chromium 主版本号数组（all = 全部预设 + 本项目下限）。 */
const resolveTargets = (target) => {
  if (!target) {
    throw new Error('缺少 --target')
  }
  if (target === 'all') {
    const numbers = new Set([...Object.values(PRESET_TARGETS), BASELINE_CHROMIUM])
    return [...numbers].sort((a, b) => a - b)
  }
  const match = /^chromium(\d+)$/.exec(target)
  if (!match) {
    throw new Error(`无法识别的目标：${target}（应形如 chromium83）`)
  }
  return [Number(match[1])]
}

/** 判定：某特性在给定 Chromium 主版本上是否可用。 */
export const availableAt = (feature, chromium) => chromium >= feature.minChrome

/** 给定版本下不可用的特性（按最低版本从高到低排序：最先炸的排前面）。 */
export const judge = (chromium) => {
  const unavailable = FEATURES.filter((feature) => !availableAt(feature, chromium)).sort(
    (a, b) => b.minChrome - a.minChrome
  )
  return {
    target: `chromium${chromium}`,
    chromium,
    expected: '静态推断',
    total: FEATURES.length,
    unavailableCount: unavailable.length,
    unavailable: unavailable.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      label: feature.label,
      minChrome: feature.minChrome,
      basis: feature.basis,
      evidence: '静态推断',
    })),
    available: FEATURES.filter((feature) => availableAt(feature, chromium)).map(
      (feature) => feature.id
    ),
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'web-build', 'android', 'ios'])
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.scss']

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) {
      continue
    }
    const path = join(dir, name)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      walk(path, out)
    } else if (SCAN_EXTENSIONS.some((extension) => name.endsWith(extension))) {
      out.push(path)
    }
  }
  return out
}

/** 扫描源码，定位每条特性的使用点。只做文本匹配，结论仍是静态推断。 */
export const scan = (root) => {
  const hits = []
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    for (const feature of FEATURES) {
      if (!feature.usage) {
        continue
      }
      for (let index = 0; index < lines.length; index += 1) {
        if (feature.usage.test(lines[index])) {
          hits.push({
            id: feature.id,
            minChrome: feature.minChrome,
            file: relative(process.cwd(), file).split('\\').join('/'),
            line: index + 1,
            text: lines[index].trim().slice(0, 160),
          })
        }
      }
    }
  }
  return hits
}

const printList = () => {
  const rows = [...FEATURES].sort((a, b) => a.minChrome - b.minChrome)
  process.stdout.write(`特性清单（${rows.length} 条，依据 MDN / caniuse，全部为静态推断）\n`)
  for (const feature of rows) {
    process.stdout.write(
      `  Chrome ${String(feature.minChrome).padStart(3)}  ${feature.kind.padEnd(6)} ${feature.id}  —  ${feature.label}\n`
    )
  }
}

const printReport = (result) => {
  const lines = []
  lines.push(`兼容性探针（静态推断，非真机验证）  目标：${result.target}`)
  lines.push(
    `共 ${result.total} 条特性，目标版本上不可用 ${result.unavailableCount} 条${
      result.unavailableCount === 0 ? '（全部可用）' : ''
    }`
  )
  if (result.unavailableCount > 0) {
    lines.push('')
    lines.push('不可用清单（最低可用版本从高到低）：')
    for (const item of result.unavailable) {
      lines.push(`  ✗ ${item.id}  ${item.label}`)
      lines.push(`     跑到 Chrome ${item.minChrome} 才可用；依据：${item.basis}`)
    }
    lines.push('')
    lines.push(
      '结论：这些能力在该版本 WebView 上缺失，源码里任何一处使用都会在运行时抛错（缺失时不会自动降级）。'
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

const main = () => {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage}\n`)
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (options.list) {
    printList()
    return 0
  }
  let targets
  try {
    targets = resolveTargets(options.target)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage}\n`)
    process.exit(2)
  }

  const results = targets.map((chromium) => judge(chromium))
  const scanned = options.scan ? scan(resolve(options.scan)) : null

  if (options.json) {
    const payload =
      results.length === 1 && !scanned
        ? results[0]
        : {
            expected: '静态推断',
            targets: results,
            ...(scanned
              ? {
                  scan: {
                    root: options.scan,
                    hits: scanned,
                    /** 目标版本上不可用、但源码里确实用了的特性 */
                    conflicting:
                      results.length === 1
                        ? scanned.filter((hit) => results[0].unavailable.some((item) => item.id === hit.id))
                        : [],
                  },
                }
              : {}),
          }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    const failed = results.some((result) => result.unavailableCount > 0)
    return failed ? 1 : 0
  }

  results.forEach((result, index) => {
    if (index > 0) {
      process.stdout.write('\n')
    }
    printReport(result)
  })

  if (scanned) {
    process.stdout.write(`\n源码扫描 ${options.scan}：命中 ${scanned.length} 处特性使用点（静态推断）\n`)
    const target = results[0]
    const conflicting = scanned.filter((hit) =>
      target.unavailable.some((item) => item.id === hit.id)
    )
    if (conflicting.length === 0) {
      process.stdout.write(`  在 ${target.target} 上：没有命中不可用特性\n`)
    } else {
      process.stdout.write(`  在 ${target.target} 上：${conflicting.length} 处命中不可用特性\n`)
      for (const hit of conflicting) {
        process.stdout.write(`    ${hit.file}:${hit.line}  [${hit.id} 需 Chrome ${hit.minChrome}]  ${hit.text}\n`)
      }
    }
  }

  return results.some((result) => result.unavailableCount > 0) ? 1 : 0
}

// 被其它脚本 import 时（例如测试）不要执行 CLI。
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  process.exit(main())
}

export { byId }
