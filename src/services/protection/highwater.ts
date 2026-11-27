/**
 * 高水位标记（#909）：本机「曾经有过多少条会话」。
 *
 * 启动时库里会话数为 0、而标记说「之前有过」→ 判定「库从有到无」（Chromium 在
 * 「满盘 + 脏写 + 进程被杀」后会因 checksum mismatch 整库删除，用户只看到干净欢迎页、零提示）。
 *
 * 存放（规范 §6）：
 *  - 原生端（`fs.supported`）写应用私有目录 `protection/highwater.json`（独立于 WebView 存储，
 *    WebView 存储被清时它还在）。**原生可用却写失败就抛 InfraError**，绝不悄悄改用 localStorage /
 *    内存后假装成功 —— 假装成功会让「标记丢了」与「用户本来就没有数据」分不开。
 *    读取时 native 以原生标记为准，读失败同样抛，不去读 localStorage 那份可能更旧的。
 *  - Web 端没有私有文件系统，localStorage 是它唯一的持久化手段，显式使用并在结果里标明 `web`。
 *    localStorage 自己被清掉时无标记可依，不报（已知盲区，见 docs/protection-device-checklist.md）。
 *
 * 只升不降：`sessions` 变小不更新标记，除非调用方声明 `explicit`（用户显式删除会话 /
 * 显式清空历史 / 整包导入替换提交之后）。
 *
 * `lost`：检测到「库从有到无」后写进标记，直到用户恢复或明确放弃才清。没有它，用户忽略横幅、
 * 随手新建一条会话后，下次启动 `sessions>0` 就不再报，而快照也会在几十秒内被新数据轮转掉。
 *
 * `cleared`（#936）：库为空是**用户自己清空 / 整包替换**的结果（显式路径写），不是被系统清掉的。
 * 有了它，启动检测才敢用「磁盘上还有有效快照」当第二证据 —— 否则用户删光后会被误报成「被系统清除」。
 *
 * `sessions: 0` 的写入门槛（#936 P0）：**非显式路径绝不写 0**。满盘时这个标记文件与库在同一个分区，
 * 它自己也会写坏 / 写不进去；一旦「0 条」被落地，`sessions>0` 这条唯一证据就没了，检测层再也分不出
 * 「新装」和「库从有到无」—— 设备实测就是这个形态（`{"v":1,"sessions":0,...}`），历史全丢而零提示。
 */
import { InfraError, type InfraErrorKind } from '../capability/errors.js'
import { HIGHWATER_FORMAT_VERSION, HIGHWATER_LOCAL_KEY, HIGHWATER_PATH } from './constants.js'
import { sha256OfText } from './checksum.js'
import { reportProtectionFailure } from './diagnostics.js'
import type { ProtectionDeps } from './types.js'

export type HighwaterMark = {
  /** 记录的会话数 */
  sessions: number
  /** 最后一次写入时间 */
  at: number
  /** 写入时的库结构版本 */
  schema: number
  /** 已判定「库从有到无」时：当时标记的会话数；缺省 = 没有待处理的丢失 */
  lost?: number
  /** 库为空是用户显式清空 / 整包替换的结果（不是被系统清掉的）；#936 */
  cleared?: true
}

export type HighwaterSource = 'native' | 'web'
export type HighwaterRead = { mark: HighwaterMark | null; source: HighwaterSource }
export type HighwaterWriteResult = {
  /** written = 标记已是期望状态；unsupported = 既没有原生空间也没有 localStorage；failed = Web 端写失败 */
  status: 'written' | 'unsupported' | 'failed'
  /** 本次是否真的改写了标记（只升不降 / 无变化时为 false） */
  changed: boolean
  source: HighwaterSource
}
export type HighwaterWriteOptions = {
  /** 允许把 sessions 调低（用户显式删除 / 整包替换之后） */
  explicit?: boolean
  /** 清掉 `lost`（已恢复，或用户明确放弃恢复） */
  clearLost?: boolean
  /** 写入 `lost`（刚检测到库从有到无） */
  markLost?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 校验和覆盖除 checksum 外的全部字段：改任一字段都会被读侧拒绝 */
const bodyOf = (mark: HighwaterMark): string =>
  JSON.stringify({
    v: HIGHWATER_FORMAT_VERSION,
    sessions: mark.sessions,
    at: mark.at,
    schema: mark.schema,
    ...(mark.lost === undefined ? {} : { lost: mark.lost }),
    ...(mark.cleared === undefined ? {} : { cleared: mark.cleared }),
  })

const serialize = async (mark: HighwaterMark): Promise<string> => {
  const body = bodyOf(mark)
  return JSON.stringify({ ...(JSON.parse(body) as object), checksum: await sha256OfText(body) })
}

const parse = async (text: string): Promise<HighwaterMark | null> => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isRecord(raw) ||
    raw.v !== HIGHWATER_FORMAT_VERSION ||
    typeof raw.sessions !== 'number' ||
    !Number.isInteger(raw.sessions) ||
    raw.sessions < 0 ||
    typeof raw.at !== 'number' ||
    typeof raw.schema !== 'number' ||
    typeof raw.checksum !== 'string' ||
    (raw.lost !== undefined && (typeof raw.lost !== 'number' || !Number.isInteger(raw.lost) || raw.lost < 0)) ||
    (raw.cleared !== undefined && raw.cleared !== true)
  ) {
    return null
  }
  const mark: HighwaterMark = {
    sessions: raw.sessions,
    at: raw.at,
    schema: raw.schema,
    ...(raw.lost === undefined ? {} : { lost: raw.lost }),
    ...(raw.cleared === undefined ? {} : { cleared: true }),
  }
  return (await sha256OfText(bodyOf(mark))) === raw.checksum ? mark : null
}

const infraKindOf = (error: unknown): InfraErrorKind => {
  const kind = isRecord(error) ? error.kind : undefined
  return kind === 'quota' || kind === 'permission' || kind === 'unsupported' ? kind : 'unavailable'
}

export const createHighwater = (deps: ProtectionDeps) => {
  const source: HighwaterSource = deps.fs.supported ? 'native' : 'web'
  /** 本进程最近一次读 / 写成功的标记：`write` 用它判断「没变化就不碰磁盘」（每次保存都会走到这里） */
  let known: { mark: HighwaterMark | null } | undefined

  const read = async (): Promise<HighwaterRead> => {
    if (deps.fs.supported) {
      let bytes: Uint8Array | undefined
      try {
        bytes = await deps.fs.read(HIGHWATER_PATH)
      } catch (error) {
        reportProtectionFailure('highwater-read', error)
        throw new InfraError(infraKindOf(error), 'highwater: native marker unreadable')
      }
      const mark = bytes ? await parse(decoder.decode(bytes)) : null
      if (bytes && !mark) {
        reportProtectionFailure('highwater-read', new Error('highwater checksum mismatch or malformed'))
      }
      known = { mark }
      return { mark, source }
    }
    const text = deps.local?.getItem(HIGHWATER_LOCAL_KEY) ?? null
    const mark = text === null ? null : await parse(text)
    known = { mark }
    return { mark, source }
  }

  const write = async (sessions: number, options: HighwaterWriteOptions = {}): Promise<HighwaterWriteResult> => {
    const mark = (known ?? (await read())).mark
    const lost = options.markLost ?? (options.clearLost ? undefined : mark?.lost)
    const keep = mark !== null && sessions < mark.sessions && !options.explicit
    const target = keep ? mark.sessions : sessions
    /**
     * #936：非显式路径不许落地「0 条」。这个标记与库在同一个分区，满盘时它自己也会写坏 ——
     * 而 `sessions: 0` 一旦落地，「本机曾经有数据」的唯一证据就没了，检测层再也分不出
     * 「新装」和「库从有到无」（设备实测形态见 Issue #936）。0 没有信息量，所以不写。
     * `markLost` 例外：那是「已判定丢失」要落的状态，它必须写得下去。
     */
    if (target === 0 && options.explicit !== true && options.markLost === undefined) {
      return { status: 'written', changed: false, source }
    }
    // 「库为空是用户显式清空的结果」：只在写 0 时有意义；判定丢失（markLost）不是用户的意图
    const cleared =
      target === 0 && options.markLost === undefined && (options.explicit === true || mark?.cleared === true)
        ? true
        : undefined
    const unchanged =
      mark !== null &&
      mark.sessions === target &&
      mark.schema === deps.storage.schemaVersion &&
      mark.lost === lost &&
      mark.cleared === cleared
    if (unchanged) {
      return { status: 'written', changed: false, source }
    }
    const next: HighwaterMark = {
      sessions: target,
      at: deps.now(),
      schema: deps.storage.schemaVersion,
      ...(lost === undefined ? {} : { lost }),
      ...(cleared === undefined ? {} : { cleared }),
    }
    const text = await serialize(next)
    if (!deps.fs.supported) {
      if (!deps.local) {
        return { status: 'unsupported', changed: false, source }
      }
      try {
        deps.local.setItem(HIGHWATER_LOCAL_KEY, text)
      } catch (error) {
        reportProtectionFailure('highwater-write', error)
        return { status: 'failed', changed: false, source }
      }
      known = { mark: next }
      return { status: 'written', changed: true, source }
    }
    try {
      await deps.fs.writeAtomic(HIGHWATER_PATH, encoder.encode(text))
    } catch (error) {
      // 原生可用却写失败：抛，绝不改用 localStorage / 内存后返回成功（规范 §4/§6）
      reportProtectionFailure('highwater-write', error)
      throw new InfraError(infraKindOf(error), 'highwater: native marker write failed')
    }
    known = { mark: next }
    return { status: 'written', changed: true, source }
  }

  /** 标记里是否有待处理的「库从有到无」；读一次后用本进程缓存，不为每次保存跨桥 */
  const lostPending = async (): Promise<boolean> => {
    const mark = (known ?? (await read())).mark
    return mark?.lost !== undefined
  }

  return { read, write, source, lostPending }
}

export type Highwater = ReturnType<typeof createHighwater>

export type DataLossVerdict = { lost: true; expectedSessions: number; lastSeenAt: number; fresh: boolean } | { lost: false }

/**
 * 启动判定（纯函数）：
 *  - 标记里已有待处理的 `lost` → 仍然是丢失（`fresh=false`：不是这次启动才发现的）；
 *  - 库里 0 条、标记说之前有过 → 库从有到无（`fresh=true`）；
 *  - 无标记（新装 / localStorage 被清）、库里还有会话、用户已清空并更新过标记 → 不报。
 */
export const detectDataLoss = (dbSessions: number, mark: HighwaterMark | null): DataLossVerdict => {
  if (mark?.lost !== undefined) {
    return { lost: true, expectedSessions: mark.lost, lastSeenAt: mark.at, fresh: false }
  }
  if (dbSessions === 0 && mark !== null && mark.sessions > 0) {
    return { lost: true, expectedSessions: mark.sessions, lastSeenAt: mark.at, fresh: true }
  }
  return { lost: false }
}

/** 磁盘上一份快照能提供的证据（`valid=false` = 校验和不过，不许当证据，也不许当恢复源） */
export type SnapshotEvidenceEntry = { sessions: number | null; valid: boolean; at: number }

/**
 * 启动判定的**第二证据**（#936）：高水位标记本身也可能随满盘一起丢 / 被写成 0，
 * 那时 `detectDataLoss` 只有「0 条标记」或「没有标记」，判不出「库从有到无」。
 *
 * 磁盘上的快照是独立的第二份证据：校验通过且 `sessions > 0` 就等于「本机确实有过这么多会话」。
 * 只取「会话数最多」的那份（并列取更新的），它的 `at` 就是「数据最后一次存在」的时间。
 *
 * 显式清空（`mark.cleared`）时，清空时刻**之前**的快照一律不作证据 —— 那些数据是用户自己删掉的。
 */
export const evidenceFromSnapshots = (
  mark: HighwaterMark | null,
  snapshots: readonly SnapshotEvidenceEntry[]
): { sessions: number; at: number } | null => {
  const floor = mark?.cleared === true ? mark.at : undefined
  let best: { sessions: number; at: number } | null = null
  for (const item of snapshots) {
    if (!item.valid || item.sessions === null || item.sessions <= 0) {
      continue
    }
    if (floor !== undefined && item.at <= floor) {
      continue
    }
    if (best === null || item.sessions > best.sessions || (item.sessions === best.sessions && item.at > best.at)) {
      best = { sessions: item.sessions, at: item.at }
    }
  }
  return best
}
