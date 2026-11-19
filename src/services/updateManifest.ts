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
export interface UpdateSelection {
  release?: UpdateRelease
  incomplete: number
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

export const selectUpdate = (
  releases: UpdateRelease[],
  currentCode: number,
  variant: ArtifactVariant,
  channel: UpdateChannel
): UpdateSelection => {
  if (!Number.isSafeInteger(currentCode) || currentCode <= 0) {
    throw new Error('INVALID_CURRENT_VERSION')
  }
  const candidates = releases.filter(
    (row) =>
      row.versionCode > currentCode &&
      (row.buildType === undefined || channel === 'prerelease' || row.buildType === 'stable')
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
  return {
    release: sorted[0],
    incomplete: candidates.filter(
      (row) =>
        row.artifactVariant === undefined ||
        (row.artifactVariant === variant && (!row.sha256 || !row.buildType))
    ).length,
  }
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
