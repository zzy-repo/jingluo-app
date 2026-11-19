/** Public download metadata only. Never import diagnostics transport or publisher credentials. */

// buildType 的唯一定义在 shared/build-types.mjs（Issue #330）：客户端、发布脚本、校验器共用。
// 这里只 import 判定函数与类型，不再写第二份 'stable' | 'prerelease' 字面量。
import { isBuildType, type BuildType } from '../../shared/build-types.mjs'

/**
 * 分发端点（Issue #268）。首选新静态分发机（见 PRIMARY_RELEASE_BASE，裸 HTTP，无域名无 TLS），
 * 不可达才回退旧机 `https://dl.rose7.cn`。顺序写死在 RELEASE_BASES 里，不做随机或轮询。
 * 裸 HTTP 之所以可接受：APK 签名由 Android 安装器强制校验，下载前后还会比对 SHA-256、
 * 包名与 versionCode，明文只能让更新失败或被抑制；域名 + TLS 在 #269 补。
 */
export const PRIMARY_RELEASE_BASE = 'http://62.106.70.167:8888' // check-ip-allow: 新分发机（#268），原生白名单同源
export const FALLBACK_RELEASE_BASE = 'https://dl.rose7.cn'
/** 尝试顺序：先新机后旧机。 */
export const RELEASE_BASES = [PRIMARY_RELEASE_BASE, FALLBACK_RELEASE_BASE] as const
export const DEFAULT_RELEASE_BASE = PRIMARY_RELEASE_BASE
export const MAX_APK_BYTES = 50 * 1024 * 1024
export type ArtifactVariant = 'internal' | 'standard'
/** 发布渠道（stable|prerelease）——别名指到共享枚举，别再另写字面量 */
export type UpdateChannel = BuildType
export interface UpdateRelease {
  version: string
  versionCode: number
  changes: string[]
  size: number
  file: string
  buildType?: UpdateChannel
  artifactVariant?: ArtifactVariant
  sha256?: string
}
/**
 * 「没有可装版本」的可解释原因（Issue #377）。
 *
 * 背景：清单里 `1.4.1` 只发了 `standard` 变体、`1.4.0` 只发了 `internal` 变体，而
 * `selectUpdate` 要求 `artifactVariant` 完全相等 —— 于是装了 internal 的用户**没有任何候选**，
 * 界面只能说「已是最新」。那不是「已是最新」，是**这条渠道的包没发**（变体维度断链）。
 * 这里把「为什么没有」一起返回，让界面给一句能行动的话（手动下载正式版 / 切渠道），
 * 而不是笼统的「已是最新」。
 *
 * 注意：跨变体**安装**是产品决策（原生 `verify()` 的 `VARIANT_MISMATCH` 仍然拦截），
 * 本单只做解释，不放开候选筛选。
 */
export type UpdateReason =
  /** 本机是 internal 包，清单里更高的版本只有 `standard` 包（#377 的现场） */
  | 'no-internal-variant'
  /** 对称情形：本机是 standard 包，清单里更高的版本只有 `internal` 包 */
  | 'no-standard-variant'
  /** 有更高的同变体包，但都是预发布，当前渠道只接受稳定版 */
  | 'prerelease-filtered'
  /** 渠道内确实没有比当前更高的记录 */
  | 'up-to-date'

export interface UpdateSelection {
  release?: UpdateRelease
  incomplete: number
  /** `release` 为空时「为什么没有可装版本」；有 release 时不带这个字段 */
  reason?: UpdateReason
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isAllowedBase = (base: string): boolean =>
  (RELEASE_BASES as readonly string[]).includes(base)

/**
 * 清单里的 file 是相对路径，必须拼在「本次清单实际生效的那个 base」上——回退到旧机后
 * 还拿新机地址拼，下载就是 404。只接受白名单 base 与 /apk/<file>.apk 这一种公开路径。
 */
export const releaseUrl = (file: string, base: string = DEFAULT_RELEASE_BASE): string => {
  if (!/^apk\/[a-zA-Z0-9._-]+\.apk$/.test(file) || !isAllowedBase(base)) {
    throw new Error('INVALID_APK_URL')
  }
  const url = new URL(file, `${base}/`)
  if (
    url.origin !== base ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/apk\/[a-zA-Z0-9._-]+\.apk$/.test(url.pathname)
  ) {
    throw new Error('INVALID_APK_URL')
  }
  return url.href
}

/** Legacy rows remain readable, but absent variant/hash must never imply standard or trusted. */
export const parseManifest = (input: unknown): UpdateRelease[] => {
  if (!object(input) || !Array.isArray(input.releases) || input.releases.length > 2000) {
    throw new Error('INVALID_MANIFEST')
  }
  return input.releases.map((value): UpdateRelease => {
    if (
      !object(value) ||
      typeof value.version !== 'string' ||
      !value.version ||
      value.version.length > 100 ||
      !Number.isSafeInteger(value.versionCode) ||
      Number(value.versionCode) <= 0 ||
      !Number.isSafeInteger(value.size) ||
      Number(value.size) <= 0 ||
      Number(value.size) > MAX_APK_BYTES ||
      typeof value.file !== 'string' ||
      !Array.isArray(value.changes) ||
      value.changes.length > 200 ||
      !value.changes.every((line) => typeof line === 'string' && line.length <= 2000) ||
      // 非法 buildType 整条拒收（fail-closed）：一条不合法就是整份清单不可信，
      // 不做「跳过这条」——否则坏条目会被静默忽略，用户看到的是「已是最新」。
      (value.buildType !== undefined && !isBuildType(value.buildType))
    ) {
      throw new Error('INVALID_RELEASE')
    }
    releaseUrl(value.file)
    return {
      version: value.version,
      versionCode: Number(value.versionCode),
      size: Number(value.size),
      file: value.file,
      changes: value.changes as string[],
      buildType: value.buildType as UpdateChannel | undefined,
      artifactVariant:
        value.artifactVariant === 'internal' || value.artifactVariant === 'standard'
          ? value.artifactVariant
          : undefined,
      sha256:
        typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
          ? value.sha256
          : undefined,
    }
  })
}

/** 「字段齐全、能装」：变体已知 + 有 SHA256 + buildType 已知（与 eligible 判定同一口径） */
const installable = (row: UpdateRelease): boolean =>
  Boolean(row.artifactVariant && row.sha256 && row.buildType)

/**
 * 没有候选时的原因（Issue #377）。**只在这一格真的说不清时才给 reason**：
 * 若只是「有更高记录但缺渠道 / SHA256」，`incomplete > 0` 已经在说这件事（界面已有对应文案），
 * 不在这里重复一遍。
 */
const reasonOf = (
  aboveCurrent: UpdateRelease[],
  variant: ArtifactVariant,
  channel: UpdateChannel
): UpdateReason => {
  // 1) 同变体、字段齐全，却一个都没进候选 → 只可能是被「仅稳定版」挡掉的预发布
  if (
    channel === 'stable' &&
    aboveCurrent.some((row) => row.artifactVariant === variant && installable(row))
  ) {
    return 'prerelease-filtered'
  }
  // 2) 变体维度断链：更高的版本里有能装的包，但不是本机这个变体（#377 的 1.4.0 internal / 1.4.1 standard）
  const otherVariant = aboveCurrent.filter(
    (row) => installable(row) && row.artifactVariant !== variant
  )
  if (otherVariant.length > 0) {
    return otherVariant.some((row) => row.artifactVariant === 'internal')
      ? 'no-standard-variant'
      : 'no-internal-variant'
  }
  // 3) 渠道内确实没有更高的版本
  return 'up-to-date'
}

export const selectUpdate = (
  releases: UpdateRelease[],
  currentCode: number,
  variant: ArtifactVariant,
  channel: UpdateChannel
): UpdateSelection => {
  if (!Number.isSafeInteger(currentCode) || currentCode <= 0) {
    throw new Error('INVALID_CURRENT_VERSION')
  }
  // 高于当前版本的全部记录（先不过渠道）：区分「没有更高版本」和「有但被渠道过滤」
  const aboveCurrent = releases.filter((row) => row.versionCode > currentCode)
  const candidates = aboveCurrent.filter(
    (row) =>
      row.buildType === undefined || channel === 'prerelease' || row.buildType === 'stable'
  )
  const eligible = candidates.filter(
    (row) => row.artifactVariant === variant && row.sha256 && row.buildType
  )
  // 兼容旧 WebView：Array.prototype.toSorted 是 ES2023，ColorOS/旧 Android WebView 上会抛
  // 「toSorted is not a function」。用不依赖新原型的写法（复制后 sort，不改入参）。
  const sorted = [...eligible].sort((a, b) => b.versionCode - a.versionCode)
  // Duplicate code for the same variant/channel is ambiguous; do not pick an arbitrary file.
  if (sorted.length > 1 && sorted[0].versionCode === sorted[1].versionCode) {
    throw new Error('AMBIGUOUS_RELEASE')
  }
  const incomplete = candidates.filter(
    (row) =>
      row.artifactVariant === undefined ||
      (row.artifactVariant === variant && (!row.sha256 || !row.buildType))
  ).length
  if (sorted.length > 0) {
    return { release: sorted[0], incomplete }
  }
  // 「有记录但缺渠道 / SHA256」由 incomplete 说清；其余情况给可解释的 reason（#377）
  return incomplete > 0
    ? { release: undefined, incomplete }
    : { release: undefined, incomplete, reason: reasonOf(aboveCurrent, variant, channel) }
}

export interface ManifestFetch {
  rows: UpdateRelease[]
  /** 真正回了清单的那个 base；相对 file 必须拼在它上面。 */
  base: string
}

const fetchBody = async (
  base: string,
  signal: AbortSignal,
  request: typeof fetch
): Promise<string> => {
  const response = await request(`${base}/releases.json`, {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  if (!response.ok) {
    // 带上状态码的短码（#310）：404 / 502 与「连不上」对用户是两件事，界面要能分开说
    throw new Error(`MANIFEST_HTTP_${response.status}`)
  }
  const body = await response.text()
  if (body.length > 2 * 1024 * 1024) {
    throw new Error('MANIFEST_TOO_LARGE')
  }
  return body
}

/**
 * 按 RELEASE_BASES 顺序取清单：首个「能解析」的成功即生效（新机 HTTP → 旧机 HTTPS）。
 *
 * 解析失败也继续试下一台（Issue #330）：200 只说明「服务器回了字节」，清单被写脏
 * （例如 buildType:"release"）时整份清单不可用，另一台很可能还是好的。2026-11-19 的
 * P0 事故正相反——新机脏、旧机干净，客户端却因为「拿到 200 就不换」把可用清单丢掉了。
 *
 * 两台都拿到字节但都解析不了 → 抛**首个解析错误**（界面要说「清单坏了」，不是「连不上」，
 * updateFailure 已按 INVALID_RELEASE/INVALID_MANIFEST 归类为 manifest 故障）；
 * 全是网络/HTTP 失败 → 抛最后一个网络错误（报错信息保持 #310 的 MANIFEST_HTTP_xxx）。
 */
export const fetchManifest = async (
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<ManifestFetch> => {
  let networkFailure: unknown = new Error('MANIFEST_NETWORK')
  let parseFailure: unknown
  for (const base of RELEASE_BASES) {
    let body: string
    try {
      body = await fetchBody(base, signal, request)
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      networkFailure = error
      continue
    }
    try {
      return { rows: parseManifest(JSON.parse(body)), base }
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      // 记下第一份解析错误，继续试下一台；已经拿到的字节不留用——脏清单不能冒充好清单。
      parseFailure ??= error
      continue
    }
  }
  throw parseFailure ?? networkFailure
}

export const loadManifest = async (
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<UpdateRelease[]> => (await fetchManifest(signal, request)).rows
