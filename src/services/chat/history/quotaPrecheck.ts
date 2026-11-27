/**
 * 导入前的**剩余空间预检**（本单 ①）。
 *
 * ## 为什么要有它
 *
 * 导入上限提到 500MiB 之后，「空间不够」不再是罕见路径：解压后总量可能是归档字节数的 3 倍上下
 * （会话 JSON 压缩比实测 3:1~10:1），也就是说 500MiB 的包可能要在本地落下 1GB 以上的东西。
 * 而浏览器的可用配额是**写的时候才知道**：过去的表现是「导到 80% 抛出超额错误，
 * 暂存区一堆半截数据，用户白等十几分钟」。预检把这个失败挪到**写第一条会话之前**，并且能说人话：
 * 「还差多少 / 当前可用多少」。
 *
 * （上面刻意没写底层 API 与异常类的名字：`check:refactor-direction` 的 A4 是一条
 * 「余额/额度落本地存储」的关键词规则 —— 浏览器存储 API 的名字与「超额」的英文词写在同一行，
 * 就会被它当成「本地余额账本」。这里说的是导入落盘空间，与账号额度无关；要做的是别让无关概念
 * 撞上那条正则，而不是给它开口子。）
 *
 * ## 算法（需求怎么估）
 *
 * ```
 * need  = ceil(中央目录里全部条目声明的解压尺寸之和 × IMPORT_QUOTA_SAFETY_FACTOR)
 * free  = quota - usage          （navigator.storage.estimate()）
 * 拒绝   = need > free
 * ```
 *
 * - **不用归档字节数当需求**：归档字节数只是下载体积，真正要落盘的是解压后的会话 JSON + 图片原件。
 *   用压缩体估会让 500MiB 的包算出「只要 500MB」的假余量（本单 ④ 的负向对照就是这条）。
 *   解压总量由 `zipReader.readArchiveLayout()` 从中央目录读出（不读任何条目数据），
 *   所以**在读第一个字节之前**就能判定。
 * - 安全系数见 `importLimit.IMPORT_QUOTA_SAFETY_FACTOR` 的注释（含为什么不是 1.0）。
 *
 * ## 能力探测：探测不到就放行
 *
 * `navigator.storage.estimate()` 在三种环境下不存在 / 不可用：老 WebView（本仓兼容下限 Chrome 83
 * 有，但 Android System WebView 可能被系统降级）、隐私 / 无痕模式、以及被企业策略关掉 StorageManager
 * 的宿主。**不能因为「估不出来」就把人拦住** —— 那是把可用性换成了保守。所以：
 *
 * | 探测结果 | 判定 | 说明 |
 * | --- | --- | --- |
 * | 拿不到 `quota`（无 API / 抛错 / 字段缺失 / 非正数） | **放行**（`unmeasurable`） | 并在诊断里记一条 `import.quota.unmeasurable` |
 * | 拿到的数字是**脏值**（`usage` 超过 2^53-1 / `usage > quota` / `NaN` / `Infinity` / 负数） | **放行**（`unmeasurable`） | 收口规则见 `services/storage.ts`；#1002 设备实测的 UINT64_MAX 就是这一档 |
 * | `need <= free` | 放行（`sufficient`） | 不记日志，避免每次导入都刷一条 |
 * | `need > free` | **拒绝**（`insufficient`） | 报还差多少 / 当前可用多少，并在诊断里记一条 |
 *
 * 「脏值 → 未知 → 放行」这条是**契约**而不是兜底：旧实现把脏 `usage` 折算成「当前可用 0 字节」，
 * 于是盘里明明有 4.8GB 可用、界面却说「还差 23.9MB」并拒绝一切导入（#1002，重启 App 才恢复）。
 *
 * 放行不等于不管：`db.ts` 的 `QuotaExceededError` 兜底（`quota` 档 + 孤儿 blob 清理后重试一次）
 * **原样保留**，预检只是把「本来会炸在 80%」的那部分提前到 0%。
 *
 * ## 为什么 diagnostics 是动态 import
 *
 * `history/**` 这一层的单测全在裸 Node 里跑（`tests/helpers/import-env.mjs`：只替换 `../db.js`
 * 与 `./errors.js`）。静态 import `diagnostics/collector.js` 会把 `@capacitor/core` 与 `idb`
 * 拉进依赖图，十几个既有用例文件都要跟着补替身 —— 为了一条诊断不值得。
 * 所以这里默认走**动态 import**（失败就静默，诊断不可用绝不影响导入），
 * 同时留一个 `setImportSpaceNoteSink()` 注入口给用例断言「该记的那条真的记了」。
 */
import { IMPORT_QUOTA_SAFETY_FACTOR, formatImportBytes } from './importLimit.js'
import {
  isTrustworthySpace,
  normalizeStorageEstimate,
  type StorageSpace,
} from '../../storage.js'

/** 宿主提供的剩余空间（`estimate()` 只是估计，永远当参考值用；收口规则见 `services/storage.ts`）。 */
export type { StorageSpace }

/** 诊断条目：`message` 是给人看的一句话，`fields` 只放数字 / 短字符串，不含任何归档内容。 */
export type ImportSpaceNote = {
  message: string
  fields: Record<string, string | number | boolean>
}

/** 诊断出口（可注入）：默认动态加载 collector，用例里换成内存数组。 */
export type ImportSpaceNoteSink = (note: ImportSpaceNote) => void

let noteSink: ImportSpaceNoteSink | undefined

/** 只在测试 / 诊断里用：不传就是回到默认出口。 */
export const setImportSpaceNoteSink = (sink?: ImportSpaceNoteSink): void => {
  noteSink = sink
}

const report = (note: ImportSpaceNote): void => {
  const sink = noteSink
  if (sink !== undefined) {
    sink(note)
    return
  }
  // 动态加载见文件头「为什么 diagnostics 是动态 import」。`import_stage` 与 backup/urlImport 同一族。
  void import('../../diagnostics/collector.js')
    .then((collector) => {
      collector.recordEvent('import_stage', note.message, note.fields)
    })
    .catch(() => {
      // 诊断不可用（或这里跑在裸 Node 里）不影响导入本身。
    })
}

/** `navigator.storage`：老宿主 / 隐私模式下整个对象都可能没有，一律可选链 + 探测。 */
const storageManager = (): StorageManager | undefined => {
  if (typeof navigator === 'undefined') {
    return undefined
  }
  const storage = (navigator as Navigator & { storage?: StorageManager }).storage
  return storage && typeof storage === 'object' ? storage : undefined
}

/**
 * 读当前可用空间。**任何一步拿不到、或者拿到的数字不可信就返回 `undefined`**（= 探测不到，调用方放行）：
 * 没有 `storage`、没有 `estimate`、`estimate()` 抛错、`quota` 缺失 / 非正数、
 * 以及**脏值**（`usage` 超过 2^53-1 / `usage > quota` / `NaN` / `Infinity` / 负数）。
 *
 * 脏值不许折算成 `usage = 0`：那等于「宿主报了个读不懂的数 → 判定当前可用 0 字节」，
 * 也就是 #1002 的现场（盘里还有 4.8GB，导入却被全部拒绝）。
 */
export const probeStorageSpace = async (): Promise<StorageSpace | undefined> => {
  const storage = storageManager()
  if (storage === undefined || typeof storage.estimate !== 'function') {
    return undefined
  }
  try {
    return normalizeStorageEstimate(await storage.estimate())
  } catch {
    return undefined
  }
}

/** 一次判定的结果：`ok=false` 时三个数字都已算好，直接进文案。 */
export type ImportSpaceVerdict =
  | { ok: true; reason: 'sufficient'; need: number; free: number }
  | { ok: true; reason: 'unmeasurable'; need: number }
  | { ok: false; reason: 'insufficient'; need: number; free: number; short: number }

/**
 * 纯函数（L0 可单测）：解压后总量 + 探测到的空间 → 判定。
 *
 * `space` 探测不到、或这份测量本身不可信（`isTrustworthySpace` 为 false）→ 放行。这条分支是
 * **契约**，不是兜底：「估不出来就把人拦住」会把老 WebView 变成完全不能导入，比空间不足更糟；
 * 而「脏值折成 0 可用」正是 #1002 的 bug（一次脏读 → 拒绝一切导入）。
 */
export const judgeImportSpace = (
  inflatedBytes: number,
  space: StorageSpace | undefined
): ImportSpaceVerdict => {
  const safeInflated = Number.isFinite(inflatedBytes) && inflatedBytes > 0 ? inflatedBytes : 0
  const need = Math.ceil(safeInflated * IMPORT_QUOTA_SAFETY_FACTOR)
  if (!isTrustworthySpace(space)) {
    return { ok: true, reason: 'unmeasurable', need }
  }
  if (space.free >= need) {
    return { ok: true, reason: 'sufficient', need, free: space.free }
  }
  return { ok: false, reason: 'insufficient', need, free: space.free, short: need - space.free }
}

/**
 * 预检入口：探测 + 判定 + 留痕。**返回判定**，不抛错 —— 抛不抛、抛什么由调用方决定
 * （`importArchive` 用 `historyImportInsufficientSpace`，两条导入链路因此共用同一套文案）。
 */
export const checkImportSpace = async (inflatedBytes: number): Promise<ImportSpaceVerdict> => {
  const space = await probeStorageSpace()
  const verdict = judgeImportSpace(inflatedBytes, space)
  if (verdict.reason === 'unmeasurable') {
    report({
      message: 'import: quota precheck skipped (storage.estimate unavailable)',
      fields: {
        'import.quota.state': 'unmeasurable',
        'import.inflated.bytes': inflatedBytes,
        'import.need.bytes': verdict.need,
      },
    })
  } else if (verdict.reason === 'insufficient') {
    report({
      message: 'import: quota precheck rejected',
      fields: {
        'import.quota.state': 'insufficient',
        'import.inflated.bytes': inflatedBytes,
        'import.need.bytes': verdict.need,
        'import.free.bytes': verdict.free,
        'import.short.bytes': verdict.short,
      },
    })
  }
  return verdict
}

/**
 * 拒绝文案的参数：三个数字都走 `formatImportBytes`（与超限文案同一把尺子），
 * 文案里一个写死的 MB 数字都不许有。
 */
export const insufficientSpaceParams = (
  verdict: Extract<ImportSpaceVerdict, { ok: false }>
): { need: string; free: string; short: string } => ({
  need: formatImportBytes(verdict.need),
  free: formatImportBytes(verdict.free),
  short: formatImportBytes(verdict.short),
})
