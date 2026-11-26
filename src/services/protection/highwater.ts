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
    (raw.lost !== undefined && (typeof raw.lost !== 'number' || !Number.isInteger(raw.lost) || raw.lost < 0))
  ) {
    return null
  }
  const mark: HighwaterMark = {
    sessions: raw.sessions,
    at: raw.at,
    schema: raw.schema,
    ...(raw.lost === undefined ? {} : { lost: raw.lost }),
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
    const unchanged =
      mark !== null &&
      mark.sessions === target &&
      mark.schema === deps.storage.schemaVersion &&
      mark.lost === lost
    if (unchanged) {
      return { status: 'written', changed: false, source }
    }
    const next: HighwaterMark = {
      sessions: target,
      at: deps.now(),
      schema: deps.storage.schemaVersion,
      ...(lost === undefined ? {} : { lost }),
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

  return { read, write, source }
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
