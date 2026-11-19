/** Intl.Segmenter 的 grapheme（字素簇）分段实现（issue #167）。
 *
 * 为什么要自己写：`Intl.Segmenter` 是 Chromium 87 才有的 API，WebView 83 上没有。缺了它 mermaid
 * 之类的库会退回 `[...text]` 按**码点**切，于是 emoji（ZWJ 家庭、肤色修饰、国旗）和组合字符
 * （分解形 é = e + U+0301、泰文的元音符号、印地文的连字）都被切成半个，渲染/换行就错位。
 *
 * 实现范围：只做 `granularity: "grapheme"`，按 UAX #29 的扩展字素簇边界规则（GB1–GB13，含
 * Unicode 15.1 起的 GB9c 印地文连字规则）。`word` / `sentence` 粒度**不实现**，构造时抛
 * RangeError —— 宁可明确报错，也不要静默按字素返回、让调用方以为拿到了词边界。
 *
 * 语法：本文件刻意只用 ES5 写法（`function` + `var`，不用箭头函数、模板串、`let`/`const`、
 * 属性转义正则）。旧内核的解析器本来就缺这些特性，polyfill 自己不该再依赖 swc 的语法降级。
 * 数据表也走 `graphemeData.ts` 的字面量区间（见那个文件的头部说明）。
 *
 * 边界规则参考：https://www.unicode.org/reports/tr29/#Grapheme_Cluster_Boundary_Rules
 */

import {
  EXTENDED_PICTOGRAPHIC,
  GRAPHEME_CONTROL,
  GRAPHEME_EXTEND,
  GRAPHEME_PREPEND,
  GRAPHEME_SPACING_MARK,
  HANGUL_L,
  HANGUL_T,
  HANGUL_V,
  INCB_CONSONANT,
  INCB_LINKER,
} from './graphemeData.js'

/* 字素簇分类（UAX #29 里 GCB 的取值 + 自己算出来的 LV/LVT） */
var OTHER = 0
var CARRIAGE_RETURN = 1
var LINE_FEED = 2
var CONTROL = 3
var EXTEND = 4
var ZWJ = 5
var REGIONAL_INDICATOR = 6
var PREPEND = 7
var SPACING_MARK = 8
var HANGUL_LEAD = 9
var HANGUL_VOWEL = 10
var HANGUL_TRAIL = 11
var HANGUL_LV = 12
var HANGUL_LVT = 13

/* GB11 的状态机：0 无关，1 刚过一个图象字符（可带若干 Extend），2 图象字符 + ZWJ */
var PICTURE_NONE = 0
var PICTURE_AFTER_PICTURE = 1
var PICTURE_AFTER_ZWJ = 2

export interface GraphemeSegmentData {
  segment: string
  index: number
  input: string
}

export interface GraphemeSegments {
  containing(index: number): GraphemeSegmentData | undefined
}

export interface GraphemeSegmentStep {
  value?: GraphemeSegmentData
  done: boolean
}

export interface GraphemeSegmentIterator {
  next(): GraphemeSegmentStep
}

export interface GraphemeSegmenterOptions {
  granularity?: string
}

export interface GraphemeSegmenterInstance {
  segment(input: string): GraphemeSegments
  resolvedOptions(): { locale: string; granularity: string }
}

/** 区间表是扁平数组 [start0, end0, start1, end1, …]，闭区间、升序 → 二分查找 */
function inRanges(ranges: number[], codePoint: number): boolean {
  var low = 0
  var high = ranges.length / 2 - 1
  while (low <= high) {
    var middle = Math.floor((low + high) / 2)
    var start = ranges[middle * 2]
    var end = ranges[middle * 2 + 1]
    if (codePoint < start) {
      high = middle - 1
    } else if (codePoint > end) {
      low = middle + 1
    } else {
      return true
    }
  }
  return false
}

/** 码点 → 字素簇分类。LV/LVT 用算术判定（Unicode 保证音节块按 28 等分），不必打表 */
function classOf(codePoint: number): number {
  if (codePoint === 0x0d) {
    return CARRIAGE_RETURN
  }
  if (codePoint === 0x0a) {
    return LINE_FEED
  }
  if (codePoint === 0x200d) {
    return ZWJ
  }
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) {
    return REGIONAL_INDICATOR
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) {
    return (codePoint - 0xac00) % 28 === 0 ? HANGUL_LV : HANGUL_LVT
  }
  if (inRanges(HANGUL_L, codePoint)) {
    return HANGUL_LEAD
  }
  if (inRanges(HANGUL_V, codePoint)) {
    return HANGUL_VOWEL
  }
  if (inRanges(HANGUL_T, codePoint)) {
    return HANGUL_TRAIL
  }
  if (inRanges(GRAPHEME_EXTEND, codePoint)) {
    return EXTEND
  }
  if (inRanges(GRAPHEME_SPACING_MARK, codePoint)) {
    return SPACING_MARK
  }
  if (inRanges(GRAPHEME_PREPEND, codePoint)) {
    return PREPEND
  }
  if (inRanges(GRAPHEME_CONTROL, codePoint)) {
    return CONTROL
  }
  return OTHER
}

/** 取一个字符：自己解代理对，不依赖 ES6 的 codePointAt */
function codePointAt(input: string, offset: number): number {
  var head = input.charCodeAt(offset)
  if (head >= 0xd800 && head <= 0xdbff && offset + 1 < input.length) {
    var tail = input.charCodeAt(offset + 1)
    if (tail >= 0xdc00 && tail <= 0xdfff) {
      return (head - 0xd800) * 0x400 + (tail - 0xdc00) + 0x10000
    }
  }
  return head
}

function charSize(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1
}

/** ToIntegerOrInfinity：NaN → 0，小数向零取整（+1.5 → 1，-1.5 → -1） */
function toInteger(value: number): number {
  var number = Number(value)
  if (number !== number) {
    return 0
  }
  if (number < 0) {
    return Math.ceil(number)
  }
  return Math.floor(number)
}

/** 算出每个字素簇的起始下标（UTF-16 偏移），返回升序数组 */
function findBoundaries(input: string): number[] {
  var starts: number[] = []
  var classes: number[] = []
  var pictures: boolean[] = []
  var consonants: boolean[] = []
  var linkers: boolean[] = []
  var offset = 0
  while (offset < input.length) {
    var codePoint = codePointAt(input, offset)
    starts.push(offset)
    classes.push(classOf(codePoint))
    pictures.push(inRanges(EXTENDED_PICTOGRAPHIC, codePoint))
    consonants.push(inRanges(INCB_CONSONANT, codePoint))
    linkers.push(inRanges(INCB_LINKER, codePoint))
    offset = offset + charSize(codePoint)
  }
  var total = starts.length
  if (total === 0) {
    return starts
  }

  /* 累积状态：GB11 的图象序列、GB12/13 的 RI 计数、GB9c 的「辅音 + 连字」序列 */
  var pictureState = pictures[0] ? PICTURE_AFTER_PICTURE : PICTURE_NONE
  var regionalRun = classes[0] === REGIONAL_INDICATOR ? 1 : 0
  var afterConsonant = consonants[0]
  var seenLinker = false

  function isBreak(previous: number, current: number): boolean {
    var before = classes[previous]
    var after = classes[current]
    if (before === CARRIAGE_RETURN && after === LINE_FEED) {
      return false
    }
    if (before === CONTROL || before === CARRIAGE_RETURN || before === LINE_FEED) {
      return true
    }
    if (after === CONTROL || after === CARRIAGE_RETURN || after === LINE_FEED) {
      return true
    }
    if (
      before === HANGUL_LEAD &&
      (after === HANGUL_LEAD ||
        after === HANGUL_VOWEL ||
        after === HANGUL_LV ||
        after === HANGUL_LVT)
    ) {
      return false
    }
    if (
      (before === HANGUL_LV || before === HANGUL_VOWEL) &&
      (after === HANGUL_VOWEL || after === HANGUL_TRAIL)
    ) {
      return false
    }
    if ((before === HANGUL_LVT || before === HANGUL_TRAIL) && after === HANGUL_TRAIL) {
      return false
    }
    if (after === EXTEND || after === ZWJ) {
      return false
    }
    if (after === SPACING_MARK) {
      return false
    }
    if (before === PREPEND) {
      return false
    }
    if (consonants[current] && afterConsonant && seenLinker) {
      return false
    }
    if (pictureState === PICTURE_AFTER_ZWJ && pictures[current]) {
      return false
    }
    if (after === REGIONAL_INDICATOR && regionalRun % 2 === 1) {
      return false
    }
    return true
  }

  var boundaries: number[] = [starts[0]]
  for (var index = 1; index < total; index++) {
    if (isBreak(index - 1, index)) {
      boundaries.push(starts[index])
    }
    /* 判完边界再吃掉当前字符的状态 */
    if (pictures[index]) {
      pictureState = PICTURE_AFTER_PICTURE
    } else if (classes[index] === ZWJ) {
      pictureState = pictureState === PICTURE_AFTER_PICTURE ? PICTURE_AFTER_ZWJ : PICTURE_NONE
    } else if (classes[index] !== EXTEND) {
      pictureState = PICTURE_NONE
    } else if (pictureState === PICTURE_AFTER_ZWJ) {
      /* GB11 只允许「图象字符 Extend* ZWJ」后紧跟图象字符：ZWJ 之后再来的 Extend 会打断它 */
      pictureState = PICTURE_NONE
    }
    if (classes[index] === REGIONAL_INDICATOR) {
      regionalRun = regionalRun + 1
    } else {
      regionalRun = 0
    }
    if (consonants[index]) {
      afterConsonant = true
      seenLinker = false
    } else if (linkers[index]) {
      seenLinker = true
    } else if (classes[index] !== EXTEND && classes[index] !== ZWJ) {
      afterConsonant = false
      seenLinker = false
    }
  }
  return boundaries
}

function createIterator(items: GraphemeSegmentData[]): GraphemeSegmentIterator {
  var cursor = 0
  var iterator = {} as GraphemeSegmentIterator
  Object.defineProperty(iterator, 'next', {
    value: function next(): GraphemeSegmentStep {
      if (cursor >= items.length) {
        return { done: true }
      }
      var item = items[cursor]
      cursor = cursor + 1
      return { done: false, value: item }
    },
    writable: true,
    configurable: true,
    enumerable: false,
  })
  Object.defineProperty(iterator, Symbol.iterator, {
    value: function (): GraphemeSegmentIterator {
      return iterator
    },
    writable: true,
    configurable: true,
    enumerable: false,
  })
  return iterator
}

/** 造原生同形的 Segments 对象：可 `for…of` / 展开，另有非枚举的 `containing(index)` */
function createSegments(input: string): GraphemeSegments {
  var boundaries = findBoundaries(input)
  var cache: GraphemeSegmentData[] | null = null

  function list(): GraphemeSegmentData[] {
    if (cache === null) {
      var items: GraphemeSegmentData[] = []
      for (var index = 0; index < boundaries.length; index++) {
        var start = boundaries[index]
        var end = index + 1 < boundaries.length ? boundaries[index + 1] : input.length
        items.push({ segment: input.slice(start, end), index: start, input: input })
      }
      cache = items
    }
    return cache
  }

  function containing(index: number): GraphemeSegmentData | undefined {
    var position = toInteger(index)
    if (position < 0 || position >= input.length) {
      return undefined
    }
    var items = list()
    var low = 0
    var high = items.length - 1
    var found = -1
    while (low <= high) {
      var middle = Math.floor((low + high) / 2)
      if (items[middle].index <= position) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (found === -1) {
      return undefined
    }
    var item = items[found]
    if (position >= item.index + item.segment.length) {
      return undefined
    }
    return item
  }

  var segments = {} as GraphemeSegments
  Object.defineProperty(segments, 'containing', {
    value: containing,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  Object.defineProperty(segments, Symbol.iterator, {
    value: function (): GraphemeSegmentIterator {
      return createIterator(list())
    },
    writable: true,
    configurable: true,
    enumerable: false,
  })
  return segments
}

function defaultLocale(): string {
  var resolved = new Intl.DateTimeFormat().resolvedOptions().locale
  return typeof resolved === 'string' && resolved !== '' ? resolved : 'en'
}

export interface GraphemeSegmenterConstructor {
  new (locales?: unknown, options?: GraphemeSegmenterOptions): GraphemeSegmenterInstance
  prototype: GraphemeSegmenterInstance
}

/** 造一个可挂到 `Intl.Segmenter` 上的构造函数（这里不碰任何全局对象，安装交给 legacy.ts） */
export function createGraphemeSegmenter(): GraphemeSegmenterConstructor {
  function Segmenter(
    this: GraphemeSegmenterInstance,
    locales?: unknown,
    options?: GraphemeSegmenterOptions
  ): void {
    if (this instanceof Segmenter === false) {
      throw new TypeError('Intl.Segmenter 需要用 new 调用')
    }
    var granularity =
      options === undefined || options === null || options.granularity === undefined
        ? 'grapheme'
        : String(options.granularity)
    if (granularity !== 'grapheme') {
      throw new RangeError(
        'Intl.Segmenter 兜底实现只支持 granularity: "grapheme"，收到 "' + granularity + '"'
      )
    }
    /* locales 只影响词/句切分的语言习惯，字素边界与语言无关，这里忽略（也不做 supportedLocalesOf） */
    if (locales !== undefined && locales !== null) {
      void locales
    }
    Object.defineProperty(this, 'locale', {
      value: defaultLocale(),
      writable: true,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(this, 'granularity', {
      value: granularity,
      writable: true,
      configurable: true,
      enumerable: true,
    })
  }

  var Ctor = Segmenter as unknown as GraphemeSegmenterConstructor
  Ctor.prototype.segment = function segment(input: string): GraphemeSegments {
    return createSegments(String(input))
  }
  Ctor.prototype.resolvedOptions = function resolvedOptions(): {
    locale: string
    granularity: string
  } {
    var instance = this as unknown as { locale?: string; granularity?: string }
    return {
      locale: instance.locale === undefined ? defaultLocale() : instance.locale,
      granularity: instance.granularity === undefined ? 'grapheme' : instance.granularity,
    }
  }
  return Ctor
}
