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
 * need  = ceil(解压总量 × IMPORT_QUOTA_SAFETY_FACTOR × WRITE_AMPLIFICATION_FACTOR)
 * free  = 原生 freeBytes()                       ← 唯一可信来源
 *       ↳ 读不到时：estimate() 的 quota-usage      ← 只用于否决（说「不够」可信，说「够」不作数）
 * 拒绝   = need > free（可信来源） / 读不到空间且 need > SMALL_WRITE_BYTES（分级拒绝）
 * ```
 *
 * - **不用归档字节数当需求**：归档字节数只是下载体积，真正要落盘的是解压后的会话 JSON + 图片原件。
 *   用压缩体估会让 500MiB 的包算出「只要 500MB」的假余量（本单 ④ 的负向对照就是这条）。
 *   解压总量由 `zipReader.readArchiveLayout()` 从中央目录读出（不读任何条目数据），
 *   所以**在读第一个字节之前**就能判定。
 * - 安全系数见 `importLimit.IMPORT_QUOTA_SAFETY_FACTOR` 的注释（含为什么不是 1.0）。
 *
 * ## 空间判据：两个来源、四个分支（#1002 第二轮）
 *
 * 设备现场推翻了口径「`estimate()` 通过 = 写盘安全」：那次 `estimate()` 报的是**正常值**
 * （quota 3.7GB / usage 45.6MB），真实剩余只有 6MB，20MB 包把盘写到底，LevelDB 半条记录
 * → Chromium 判损坏并重建 → 43MB 附件、48 个会话全丢。所以判据改成：
 *
 * | 探测结果 | 判定 | 说明 |
 * | --- | --- | --- |
 * | 原生 `freeBytes()` 可信，`need <= free` | 放行（`sufficient`） | 不看 `estimate()` 说什么 |
 * | 原生 `freeBytes()` 可信，`need > free` | **拒绝**（`insufficient`） | 三个数字都是原生的真数字 |
 * | 原生读不到，但 `estimate()` 可信且**明确不够** | **拒绝**（`insufficient`） | 保守方向：这个上限本身也是硬顶，越过它照样写不进去 |
 * | 都读不到 / `estimate()` 只是「看着够」 | `need <= SMALL_WRITE_BYTES` 放行（`unmeasurable-small`）<br>`need` 更大 → **拒绝**（`unverifiable`） | 大负载不能拿试错换：文案说「暂时无法确认剩余空间」，**不说**「空间不足」 |
 *
 * 「脏值 / 读不到」仍然绝不折算成「0 字节可用」（那是第一轮 #1002 的 bug：盘里 4.8GB，
 * 界面却报「还差 23.9MB」并拒绝一切导入）。收口与分级全在 `services/storage.ts` 的
 * `judgeWriteSpace`，这里只负责探测两个来源、把结论翻译成导入侧的错误码。
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
  judgeWriteSpace,
  normalizeFreeBytes,
  normalizeStorageEstimate,
  WRITE_AMPLIFICATION_FACTOR,
  type StorageSpace,
  type WriteSpaceProbe,
  type WriteSpaceVerdict,
} from '../../storage.js'

/** `estimate()` 的可信测量 / 判定输入：都在 `services/storage.ts` 收口。 */
export type { StorageSpace, WriteSpaceProbe }

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
 * 读 `estimate()` 的**辅助信号**。**任何一步拿不到、或者拿到的数字不可信就返回 `undefined`**：
 * 没有 `storage`、没有 `estimate`、`estimate()` 抛错、`quota` 缺失 / 非正数、以及**脏值**
 * （`usage` 超过 2^53-1 / `usage > quota` / `NaN` / `Infinity` / 负数）。
 *
 * 脏值不许折算成 `usage = 0`：那等于「宿主报了个读不懂的数 → 判定当前可用 0 字节」，
 * 也就是第一轮 #1002 的现场（盘里还有 4.8GB，导入却被全部拒绝）。
 */
export const probeEstimateSpace = async (): Promise<StorageSpace | undefined> => {
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

/** 原生可用字节的读数口（返回 `null` = 读不到 / 脏值）。 */
export type NativeFreeBytesReader = () => Promise<number | null>

let nativeFreeReader: NativeFreeBytesReader | undefined

/**
 * 注入原生 `freeBytes` 的读数口（用例与其它层用）。不传 = 回到默认的**动态 import**。
 *
 * 为什么默认走动态 import：`history/**` 的单测全在裸 Node 里跑，静态 import 原生出口会把
 * `@capacitor/core` 拉进依赖图（与 `diagnostics` 同一个理由，见文件头），十几个既有用例都要补替身。
 */
export const setNativeFreeBytesReader = (reader?: NativeFreeBytesReader): void => {
  nativeFreeReader = reader
}

/**
 * 读原生 `freeBytes()`（**唯一可信来源**）。三条纪律：
 *  - Web / 老壳 / 插件缺失 → `null`（未知），不抛错；
 *  - 脏值（NaN / Infinity / 负数 / 超过 2^53-1）→ `null`，与 `estimate()` 同一把尺子；
 *  - 读不到不等于 0：调用方按「未知」分级处理，见 `judgeWriteSpace`。
 */
export const probeNativeFree = async (): Promise<number | null> => {
  const reader = nativeFreeReader
  if (reader !== undefined) {
    try {
      return normalizeFreeBytes(await reader())
    } catch {
      return null
    }
  }
  try {
    const mod = await import('../../backup/nativeBackupFs.js')
    return normalizeFreeBytes(await mod.availableBytes())
  } catch {
    return null
  }
}

/** 两个来源一起探：原生是主，`estimate()` 只填来当否决信号。 */
export const probeWriteSpace = async (): Promise<WriteSpaceProbe> => {
  const [nativeFree, estimate] = await Promise.all([probeNativeFree(), probeEstimateSpace()])
  return { nativeFree, estimateFree: estimate === undefined ? null : estimate.free }
}

/** 一次判定的结果：与 `storage.judgeWriteSpace` 同一套分支（`ok=false` 时数字已算好，直接进文案）。 */
export type ImportSpaceVerdict = WriteSpaceVerdict

/**
 * 纯函数（L0 可单测）：解压后总量 + 两个来源的读数 → 判定。
 *
 * `need` 已经含**写放大**（暂存 + 提交两份）与安全系数，所以判的是「这次导入真正要落多少」，
 * 不是「包有多大」。分级与来源优先级全在 `judgeWriteSpace`，这里只负责把解压总量换算成 need。
 */
export const judgeImportSpace = (
  inflatedBytes: number,
  probe: WriteSpaceProbe
): ImportSpaceVerdict => {
  const safeInflated = Number.isFinite(inflatedBytes) && inflatedBytes > 0 ? inflatedBytes : 0
  const need = Math.ceil(safeInflated * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  return judgeWriteSpace(need, probe)
}

/** 诊断口径：`unmeasurable`（放行）/ `unverifiable`（拒绝）都带着「哪一档」的细分。 */
const reportVerdict = (inflatedBytes: number, probe: WriteSpaceProbe, verdict: ImportSpaceVerdict): void => {
  const source =
    probe.nativeFree !== null && probe.nativeFree !== undefined
      ? 'native'
      : probe.estimateFree !== null && probe.estimateFree !== undefined
        ? 'estimate'
        : 'none'
  const fields: Record<string, string | number | boolean> = {
    'import.inflated.bytes': inflatedBytes,
    'import.need.bytes': verdict.need,
    'import.space.source': source,
  }
  if (verdict.reason === 'insufficient') {
    fields['import.quota.state'] = 'insufficient'
    fields['import.space.decidedBy'] = verdict.source
    fields['import.free.bytes'] = verdict.free
    fields['import.short.bytes'] = verdict.short
  } else if (verdict.reason === 'unmeasurable-small') {
    // 口径不变：诊断面板按 `import.quota.state` 分档，「哪一档负载」另开字段
    fields['import.quota.state'] = 'unmeasurable'
    fields['import.space.tier'] = 'small'
  } else if (verdict.reason === 'unverifiable') {
    fields['import.quota.state'] = 'unverifiable'
    fields['import.space.tier'] = 'large'
  } else {
    fields['import.quota.state'] = 'sufficient'
    fields['import.free.bytes'] = verdict.free
  }
  report({
    message:
      verdict.ok
        ? verdict.reason === 'sufficient'
          ? 'import: quota precheck passed'
          : 'import: quota precheck skipped (space unknown, small payload)'
        : verdict.reason === 'insufficient'
          ? 'import: quota precheck rejected'
          : 'import: quota precheck rejected (space unknown, large payload)',
    fields,
  })
}

/**
 * 预检入口：探测 + 判定 + 留痕。**返回判定**，不抛错 —— 抛不抛、抛什么由调用方决定
 * （`importArchive` 用 `historyImportInsufficientSpace` / `historyImportSpaceUnverifiable`
 * 两种文案，两条导入链路因此共用同一套判断）。
 */
export const checkImportSpace = async (inflatedBytes: number): Promise<ImportSpaceVerdict> => {
  const probe = await probeWriteSpace()
  const verdict = judgeImportSpace(inflatedBytes, probe)
  reportVerdict(inflatedBytes, probe, verdict)
  return verdict
}

/**
 * 拒绝文案的参数：三个数字都走 `formatImportBytes`（与超限文案同一把尺子），
 * 文案里一个写死的 MB 数字都不许有。
 */
export const insufficientSpaceParams = (
  verdict: Extract<ImportSpaceVerdict, { reason: 'insufficient' }>
): { need: string; free: string; short: string } => ({
  need: formatImportBytes(verdict.need),
  free: formatImportBytes(verdict.free),
  short: formatImportBytes(verdict.short),
})
