/** Public download metadata only. Never import diagnostics transport or publisher credentials. */

// buildType 的唯一定义在 shared/build-types.mjs（Issue #330）：客户端、发布脚本、校验器共用。
// 这里只 import 判定函数与类型，不再写第二份 'stable' | 'prerelease' 字面量。
import { isBuildType, type BuildType } from '../../shared/build-types.mjs'

/**
 * 分发端点（Issue #268 / #269）。首选新静态分发机（裸 HTTP，无域名无 TLS），不可达才回退旧机。
 * 顺序写死在 RELEASE_BASES 里，不做随机或轮询。
 * 裸 HTTP 之所以可接受：APK 签名由 Android 安装器强制校验，下载前后还会比对 SHA-256、
 * 包名与 versionCode，明文只能让更新失败或被抑制。
 *
 * **本文件不留任何地址字面量**：唯一来源是 `config/endpoints.json` 的
 * `download.primaryBase` / `download.fallbackBase`，构建期由 rspack 的 DefinePlugin 注入
 * `__ENDPOINTS__`（契约见 `src/env.d.ts`）。换分发机 = 改那份 JSON 一处 + 重打包；
 * 原生侧 `UpdateEndpoint.java` 读同一份 JSON（config → build.gradle → `BuildConfig.DL_*`），
 * 两侧不会各自漂移。下载白名单已经是 `RELEASE_BASES` 的派生值，换地址不用改规则。
 */
export const PRIMARY_RELEASE_BASE = __ENDPOINTS__.dlPrimaryBase
export const FALLBACK_RELEASE_BASE = __ENDPOINTS__.dlFallbackBase
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

export type ManifestSource = 'public' | 'private'

export interface ManifestFetch {
  rows: UpdateRelease[]
  /** 真正回了清单的那个 base；相对 file 必须拼在它上面。 */
  base: string
  /** 清单来源（#622）：`private` = 带令牌的私有清单端点，`public` = 公网 `releases.json`。 */
  source: ManifestSource
}

// ---------------------------------------------------------------------------
// 私有清单（Issue #622）：internal 变体优先读私有清单，失败静默回退公网
//
// #377 的现场：公网 `releases.json` 里不再有 internal 条目（#614 裁决，两条渠道分开），
// 于是装了 internal 包的设备**永远**选不出更新 —— 那不是「已是最新」，是「这条渠道的包公网看不到」。
// #621 上线了带令牌的读端点（`GET /api/v1/releases/internal`），本段补上客户端那一半。
//
// 五条纪律（每条都对应一种会真出事的写法）：
//   1. **默认关**：`enabled:false` 一个字节都不请求（公网 / standard 用户与这条链路无关）；
//   2. **只给 internal 变体**：standard 包即便被误配成 `enabled:true` 也不请求（变体是硬判据）；
//   3. **同一套 schema**：私有清单与公网清单走同一个 `parseManifest` + `selectUpdate`，
//      绝不写第二份筛选逻辑（#484 的硬规矩）；「私有清单里混进 standard 条目」由 `selectUpdate`
//      的变体相等判定挡掉，这里**不再加一层**过滤（加一层就等于承认筛选有两份）；
//   4. **失败静默**：401 / 网络 / 脏清单一律回退公网清单，不许让整个更新流程失败 ——
//      私有清单是锦上添花，公网清单仍是唯一「必须成功」的来源；
//   5. **令牌只进请求头**：不进 URL、不进日志、不进埋点（本文件从不 import 诊断通道）。
// ---------------------------------------------------------------------------

/** 私有清单的令牌请求头（#621 的契约；服务端也收 `Authorization: Bearer`，客户端只用前者） */
export const PRIVATE_MANIFEST_TOKEN_HEADER = 'X-DL-Token'
/** 清单响应体上限：公网 / 私有同一档（2 MiB）—— 私有清单没有理由更大 */
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024

/** 私有清单的运行期配置（构建期注入值的收窄结果，令牌原文只活在这个对象里） */
export interface PrivateManifestConfig {
  url: string
  token: string
}

/**
 * 取构建期注入的私有清单配置；**任何一项不合格都返回 undefined**（= 当作没配）。
 *
 * 为什么要懒读 + 容错：
 *   · 非打包环境（`node --test` 直接 import）的 `__ENDPOINTS__` 没有 `update` 这一段；
 *   · 裁剪构建 / 旧产物可能拿到半截注入值；
 *   · 单测要按用例替换 `globalThis.__ENDPOINTS__`，懒读就不必重开进程。
 * 三种情况都退化成「关闭」，绝不抛错 —— 私有清单不允许把更新检查带崩。
 */
const privateManifestConfig = (): PrivateManifestConfig | undefined => {
  if (typeof __ENDPOINTS__ === 'undefined' || !__ENDPOINTS__) {
    return undefined
  }
  const segment = __ENDPOINTS__.update?.privateManifest
  if (!segment || segment.enabled !== true) {
    return undefined
  }
  const url = typeof segment.url === 'string' ? segment.url.trim() : ''
  const token = typeof segment.token === 'string' ? segment.token.trim() : ''
  // 端点或令牌缺失 = 这次构建没真的配好：当关闭处理（构建期 fail-fast 已拦过一遍，
  // 这里只兜「运行时拿到裁剪值」这种残留情形，避免白打一次必然 401 的请求）
  if (url === '' || token === '') {
    return undefined
  }
  return { url, token }
}

/**
 * 本机装的是不是 internal 包。判据只有一条：构建期 `__INTERNAL_BUILD__`。
 *
 * 与 `appUpdate.currentVariant()` 同源（同一个注入常量），但这里**不 import appUpdate**：
 * `appUpdate.ts` 已经 import 本文件，反向 import 会成环。判定本身只有一行，不存在两份逻辑
 * 走偏的空间；装配变体的唯一出口仍是 `__INTERNAL_BUILD__`。
 */
const isInternalVariant = (): boolean =>
  typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__ === true

/** 私有清单端点 → 该清单的 base（`file` 相对路径属于这台机器）。解不开时退默认分发机。 */
const privateManifestBase = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return DEFAULT_RELEASE_BASE
  }
}

/**
 * 拉私有清单。**所有失败都抛**（HTTP / 网络 / 解析），由 `fetchManifest` 静默回退公网。
 *
 * 与公网清单的唯一差别是**多一枚请求头**：schema、大小上限、解析器全部共用。
 * 错误短码**不带 URL、不带令牌**（这条分支的异常最终会被吞掉，但也不能留下含密信息）。
 */
const fetchPrivateManifest = async (
  config: PrivateManifestConfig,
  signal: AbortSignal,
  request: typeof fetch
): Promise<ManifestFetch> => {
  // 令牌全程只在这一行出现（#622 §安全）：它只是请求头的一个值，不进 URL、不进错误短码
  const body = await fetchManifestText(config.url, {
    signal,
    request,
    headers: { [PRIVATE_MANIFEST_TOKEN_HEADER]: config.token },
    codePrefix: 'PRIVATE_MANIFEST',
  })
  return {
    rows: parseManifest(JSON.parse(body)),
    base: privateManifestBase(config.url),
    source: 'private',
  }
}

/**
 * 取清单文本。公网 / 私有**只差三样**：URL、可选的令牌头、错误短码前缀。
 *
 * 为什么收敛成一个函数：这两份「发请求 → 查 ok → 读 text → 限长 → 出短码」几乎逐字相同，
 * 边界（不跟随跳转 / 不带凭据 / 限长 / 状态码短码）只要在**一份**里漏掉，就是「一条渠道悄悄少校验」。
 * 短码前缀区分来源（`MANIFEST_HTTP_` / `PRIVATE_MANIFEST_HTTP_`），两者**都不带 URL 与令牌**。
 */
const fetchManifestText = async (
  url: string,
  options: {
    signal: AbortSignal
    request: typeof fetch
    /** 额外请求头：私有清单的令牌只从这里进去 */
    headers?: Record<string, string>
    /** 错误短码前缀（`MANIFEST` / `PRIVATE_MANIFEST`） */
    codePrefix: string
  }
): Promise<string> => {
  const response = await options.request(url, {
    signal: options.signal,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    ...(options.headers ? { headers: options.headers } : {}),
  })
  if (!response.ok) {
    // 带上状态码的短码（#310）：404 / 502 与「连不上」对用户是两件事，界面要能分开说
    throw new Error(`${options.codePrefix}_HTTP_${response.status}`)
  }
  const body = await response.text()
  if (body.length > MANIFEST_MAX_BYTES) {
    throw new Error(`${options.codePrefix}_TOO_LARGE`)
  }
  return body
}

const fetchBody = async (
  base: string,
  signal: AbortSignal,
  request: typeof fetch
): Promise<string> =>
  fetchManifestText(`${base}/releases.json`, { signal, request, codePrefix: 'MANIFEST' })

/**
 * 按 RELEASE_BASES 顺序取**公网**清单：首个「能解析」的成功即生效（新机 HTTP → 旧机 HTTPS）。
 *
 * 解析失败也继续试下一台（Issue #330）：200 只说明「服务器回了字节」，清单被写脏
 * （例如 buildType:"release"）时整份清单不可用，另一台很可能还是好的。2026-11-19 的
 * P0 事故正相反——新机脏、旧机干净，客户端却因为「拿到 200 就不换」把可用清单丢掉了。
 *
 * 两台都拿到字节但都解析不了 → 抛**首个解析错误**（界面要说「清单坏了」，不是「连不上」，
 * updateFailure 已按 INVALID_RELEASE/INVALID_MANIFEST 归类为 manifest 故障）；
 * 全是网络/HTTP 失败 → 抛最后一个网络错误（报错信息保持 #310 的 MANIFEST_HTTP_xxx）。
 */
const fetchPublicManifest = async (
  signal: AbortSignal,
  request: typeof fetch
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
      return { rows: parseManifest(JSON.parse(body)), base, source: 'public' }
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

/**
 * 取更新清单（Issue #622）。
 *
 * 顺序：**internal 变体 + 配置开启 → 先私有清单，失败静默回退公网**；其余情况只走公网。
 * 「先私有」放在这里而不是调用点，是因为调用点有两个（原生 bridge 之外的 Web 预览路径与测试），
 * 放服务层才能被 L0 用例按表钉住。
 *
 * 回退的边界：只有「私有清单这条分支失败」不回传任何异常 —— 取消（用户自己点的）照常上抛，
 * 公网清单的失败也照常上抛（那是真的检查失败，界面该说话）。
 */
export const fetchManifest = async (
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<ManifestFetch> => {
  const priv = isInternalVariant() ? privateManifestConfig() : undefined
  if (priv) {
    try {
      return await fetchPrivateManifest(priv, signal, request)
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      // 401 / 429 / 超时 / 脏清单：静默。不记日志、不上报、不弹窗 ——
      // 私有端点的存在性与令牌有效性都不该出现在任何可见面（#622 §安全）。
    }
  }
  return fetchPublicManifest(signal, request)
}

export const loadManifest = async (
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<UpdateRelease[]> => (await fetchManifest(signal, request)).rows

// ---------------------------------------------------------------------------
// 下载目标（Issue #639）：内测包只能从带令牌的私有下载端点取
//
// #601 把私有 APK 移出了公网 webroot，于是清单里那条相对 `apk/<名>.apk` 拼出来的公网地址
// **一定 404**（实测，见 #639 的复现证据）。#621 为此开了带令牌的读端点
// `GET …/api/v1/releases/internal/download?file=<名>`，形状由服务端钉死（`downloadUrl` 字段），
// 客户端只认这一种。这里把「选中条目 → 真正的下载目标」收敛成**一个函数**：
//   · 公网条目 → 原样拼在清单生效的 base 上（`releaseUrl`，规则一字不动）；
//   · 私有条目（`artifactVariant === 'internal'`）→ 私有端点 + `X-DL-Token` 请求头。
//
// 为什么用变体判定而不是「这份清单是私有还是公网」：公网清单里**没有** internal 条目
// （#614 的裁决，服务端 `POST /api/v1/release` 直接 400 拒收），所以「internal 条目 ⇒ 私有包」
// 是这条链路上的恒等式。这样调用点不必知道清单来源，也就不必多加一条会漂移的旁路参数。
//
// 为什么下载地址写成「清单端点 + `/download`」而不是再抄一个路径字面量：#621 的两个路径同源
// （`/api/v1/releases/internal` 与 `/api/v1/releases/internal/download`），而 `src/**` 里出现
// `/api/**` 字面量本身就会被 `check:consume-api` 的 R3 判红（那张表是消费侧后端路径，不该为分发
// 端点开洞）。所以这里只从构建期注入的清单端点派生，端点形状的唯一来源仍是 `config/endpoints.json`。
//
// 令牌纪律与 `fetchPrivateManifest` 相同：只从 `__ENDPOINTS__.update.privateManifest` 取、
// 只进请求头，**不进 URL、不进日志、不进埋点**（本文件从不 import 诊断通道）。
// ---------------------------------------------------------------------------

/** 私有下载端点在清单端点上的后缀（相对 `update.privateManifest.url`，见 #621 的服务端契约） */
export const PRIVATE_DOWNLOAD_SUFFIX = '/download'

export interface DownloadTarget {
  url: string
  /** 只有私有端点才带（令牌请求头）；公网下载不带任何头 */
  headers?: Record<string, string>
}

/**
 * 把「选中的清单条目」翻成「交给原生 `download()` 的 URL（+ 白名单请求头）」。
 *
 * 私有条目的文件名严格取清单里的 `apk/<名>.apk` 里的裸 basename：服务端只收裸名
 * （带任何路径成分都 400），这里也就**不给**它任何拼错的余地。拼不出合法名字 → 抛
 * `INVALID_APK_URL`（与 `releaseUrl` 同一个短码，界面已有归类）。
 */
export const downloadTarget = (
  release: UpdateRelease,
  base: string = DEFAULT_RELEASE_BASE
): DownloadTarget => {
  const priv = release.artifactVariant === 'internal' ? privateManifestConfig() : undefined
  if (!priv) {
    return { url: releaseUrl(release.file, base) }
  }
  const name = /^apk\/([a-zA-Z0-9._-]+\.apk)$/.exec(release.file)?.[1]
  if (!name) {
    throw new Error('INVALID_APK_URL')
  }
  // 端点形状在构建期已校验（绝对 / https / 完整端点 / 不带查询串与凭据，见 rspack 的
  // privateManifestInjection），这里只做运行期收窄：再确认一次协议，然后只加一个 file 参数。
  const target = new URL(`${priv.url.replace(/\/+$/, '')}${PRIVATE_DOWNLOAD_SUFFIX}`)
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('INVALID_APK_URL')
  }
  target.searchParams.set('file', name)
  return {
    url: target.href,
    headers: { [PRIVATE_MANIFEST_TOKEN_HEADER]: priv.token },
  }
}

// ---------------------------------------------------------------------------
// 渠道选择的持久化（Issue #412 第 3 项）
//
// #309 的原始验收里有一条「切到『仅稳定版』后，选择要不要记住」，#310 只做了「切渠道自动重查」，
// 没做持久化 —— 用户每次重开设置都回到按版本号猜的默认值（内测包 → 预发布），
// 于是「我把渠道切到稳定版了」这件事在界面上根本不成立。这里只做一件小事：
// **存的只有 stable / prerelease 两档，脏值一律回落默认**，读写失败不抛（隐私模式 / 裁剪构建）。
// ---------------------------------------------------------------------------

/** 「更新渠道」选择的存储键：与其它设置项同一前缀（`chat-demo:`），只是这一项归更新链路管 */
export const UPDATE_CHANNEL_KEY = 'chat-demo:update-channel'

/**
 * 只需要 localStorage 的三个方法：测试可以直接塞一个 Map 替身，
 * 不必为了一条读写断言把整个 Storage 接口实现一遍。
 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 取存储介质：显式传入（测试）优先，否则用 `localStorage`。
 * 三种「取不到」都返回 undefined 而不是抛：SSR / 裁剪构建没有这个全局、隐私模式访问即抛错、
 * 以及单测裸跑（纯 Node）根本没有它 —— 这些场景下读写一律退化成「不持久化」。
 */
const storageOf = (storage?: StorageLike | null): StorageLike | undefined => {
  if (storage) {
    return storage
  }
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * 读「上次选的渠道」。没存过 / 存的是脏值（`release`、空串、旧版本留下的别的写法）→ 返回 `fallback`。
 *
 * 脏值不回落成 `prerelease` 而是回落到调用方给的默认值：默认值按「装的是不是预发布包」算，
 * 比任何硬编码的猜测都更接近用户的实际处境。
 */
export const readUpdateChannel = (
  fallback: UpdateChannel,
  storage?: StorageLike | null
): UpdateChannel => {
  try {
    const saved = storageOf(storage)?.getItem(UPDATE_CHANNEL_KEY)
    return isBuildType(saved) ? saved : fallback
  } catch {
    return fallback
  }
}

/** 写「选的渠道」：成功与否都返回布尔（调用方不需要 try/catch），脏值直接拒写 */
export const saveUpdateChannel = (
  channel: UpdateChannel,
  storage?: StorageLike | null
): boolean => {
  if (!isBuildType(channel)) {
    return false
  }
  const target = storageOf(storage)
  if (!target) {
    return false
  }
  try {
    target.setItem(UPDATE_CHANNEL_KEY, channel)
    return true
  } catch {
    // 配额满 / 隐私模式：选择只在本次会话生效，不把界面带崩
    return false
  }
}

// ---------------------------------------------------------------------------
// 清单快照缓存（Issue #412 第 1 项：失败时用上次成功的清单兜底）
//
// 现状：检查失败只剩一句「更新服务不可达」，而「上次成功拉到的版本列表」明明还在手上。
// 断网 / 分发机 5xx / 清单被写脏时，用户至少应该能看到「上次看到过哪些版本、什么时候看到的」。
//
// 四条纪律（每条都对应一种真实失效）：
//   1. **带结构版本**：`version` 不是当前值就整份丢弃 —— 不做字段猜测式迁移（猜错就是脏数据上屏）；
//   2. **带成功时间**：`savedAt` 是界面上「上次成功时间」的唯一来源，也是过期判定的依据；
//   3. **有上限**：条数与序列化字符数都有硬上限（localStorage 是和其它键共享的 5MB），
//      超了按 versionCode 从低到高丢，**永不无限增长**；
//   4. **读的时候重新校验**：缓存是外部可变数据（用户可以手改、旧版本可能写坏），
//      读出来一律走 `parseManifest` 的同一套判定 —— 脏记录不许冒充可安装版本。
// ---------------------------------------------------------------------------

/** 缓存键（`chat-demo:` 前缀，与设置项同族；只存公开下载元数据，不含任何凭据） */
export const MANIFEST_CACHE_KEY = 'chat-demo:update-manifest-cache'
/** 缓存结构版本：字段有增减就 +1，旧结构整份丢弃 */
export const MANIFEST_CACHE_VERSION = 1
/** 条数上限：远超真实清单（线上 20 条上下），够覆盖「很久没更新」的用户 */
export const MANIFEST_CACHE_MAX_RELEASES = 80
/** 字符数上限：96 KiB ≈ 5MB 配额的 2%，留给会话 / 其它设置 */
export const MANIFEST_CACHE_MAX_CHARS = 96 * 1024
/** 年龄上限：30 天前的版本列表比「检查失败」更容易误导，到点就不再用它兜底 */
export const MANIFEST_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 一次成功检查的快照（界面按 `savedAt` 标注「缓存数据，可能不是最新」） */
export interface ManifestSnapshot {
  /** 上次成功解析清单的时间（毫秒时间戳） */
  savedAt: number
  /** 上次真正回了清单的分发机：缓存里的相对 `file` 必须拼在它上面 */
  base: string
  /** 已通过 `parseManifest` 校验的记录（按原顺序，界面自己排序） */
  rows: UpdateRelease[]
}

/**
 * 存一份快照。约定：
 *  - 落库前先过一遍 `parseManifest`（写进去的一定是能读回来的形状）；
 *  - 条数超过 `MANIFEST_CACHE_MAX_RELEASES` → 按 versionCode 从高到低留下；
 *  - 序列化后仍超过 `MANIFEST_CACHE_MAX_CHARS` → 继续从最低版本丢，丢到只剩一条还超 → 放弃写入
 *    （宁可不缓存，也不留一条写不进去的半成品）。
 * 返回 false 只表示「这次没缓存成」，调用方不需要处理 —— 缓存是兜底，不是主链路。
 */
export const saveManifestSnapshot = (
  snapshot: { rows: UpdateRelease[]; base: string; savedAt?: number },
  storage?: StorageLike | null
): boolean => {
  const target = storageOf(storage)
  if (!target) {
    return false
  }
  let rows: UpdateRelease[]
  try {
    rows = parseManifest({ releases: snapshot.rows })
  } catch {
    // 连自己刚解析成功的清单都过不了校验：不写（写进去也只能被读回时丢掉）
    return false
  }
  rows = [...rows].sort((a, b) => b.versionCode - a.versionCode).slice(0, MANIFEST_CACHE_MAX_RELEASES)
  const savedAt = Number.isSafeInteger(snapshot.savedAt) ? Number(snapshot.savedAt) : Date.now()
  const base = isAllowedBase(snapshot.base) ? snapshot.base : DEFAULT_RELEASE_BASE
  try {
    for (;;) {
      const payload = JSON.stringify({
        version: MANIFEST_CACHE_VERSION,
        savedAt,
        base,
        rows,
      })
      if (payload.length <= MANIFEST_CACHE_MAX_CHARS) {
        target.setItem(MANIFEST_CACHE_KEY, payload)
        return true
      }
      if (rows.length <= 1) {
        // 单条记录本身就超上限（changes 被写爆）：放弃，不留半份
        return false
      }
      // 已经按 versionCode 降序，尾部就是最旧的：丢最旧的，保留「最近在用的那几个版本」
      rows = rows.slice(0, -1)
    }
  } catch {
    return false
  }
}

/**
 * 读快照：任何一项不合格都返回 undefined（**不返回半个快照**）。
 *
 * `now` 可注入，单测靠它把「30 天后」这件事变成一次参数而不是一次等待。
 * `savedAt` 落在未来（用户改过系统时间 / 时区跳变）同样判不合格：那样的时间戳没法标注「上次成功时间」。
 */
export const readManifestSnapshot = (
  now: number = Date.now(),
  storage?: StorageLike | null
): ManifestSnapshot | undefined => {
  let raw: string | null
  try {
    raw = storageOf(storage)?.getItem(MANIFEST_CACHE_KEY) ?? null
  } catch {
    return undefined
  }
  if (raw === null || raw === '') {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!object(parsed)) {
    return undefined
  }
  if (parsed.version !== MANIFEST_CACHE_VERSION) {
    return undefined
  }
  const savedAt = parsed.savedAt
  if (!Number.isSafeInteger(savedAt) || Number(savedAt) <= 0) {
    return undefined
  }
  const at = Number(savedAt)
  const age = now - at
  if (!(age >= 0) || age > MANIFEST_CACHE_MAX_AGE_MS) {
    return undefined
  }
  if (typeof parsed.base !== 'string' || !isAllowedBase(parsed.base)) {
    return undefined
  }
  let rows: UpdateRelease[]
  try {
    rows = parseManifest({ releases: parsed.rows })
  } catch {
    return undefined
  }
  return { savedAt: at, base: parsed.base, rows }
}

/** 清掉缓存（用户主动「清空本地数据」/ 排查时用） */
export const clearManifestSnapshot = (storage?: StorageLike | null): void => {
  try {
    storageOf(storage)?.removeItem(MANIFEST_CACHE_KEY)
  } catch {
    // 清不掉等于没清：下次读还会校验，不会因为这里失败而把坏数据当成好的
  }
}

/**
 * 「手动下载最新版」的兜底地址：清单拉不到时唯一还能给用户的出口。
 *
 * 用**公开下载站首页**（旧机 `dl.rose7.cn` 是 Caddy 的 file_server，页面会随每次发布更新），
 * 而不是某条记录里的 file —— 检查失败时我们连清单都没拿到，拼不出可信的 file 路径。
 */
export const RELEASE_HOME_URL = `${FALLBACK_RELEASE_BASE}/`

/**
 * 「手动下载最新版」的目标（Issue #412 第 2 项）：检查失败时用户唯一还能走的路。
 *
 *  - 有快照 → 用**同一套筛选**（变体 × 渠道 × 当前版本）从快照里挑出最新可装的那条 `file`，
 *    拼在「当初真的回了清单的那个 base」上（拼错机器就是 404）；
 *  - 没有快照 / 挑不出来（变体断链、只剩预发布、缺 SHA256）→ 公开下载站首页。
 *
 * 为什么放在服务层而不是组件里：这是**纯判定**，「什么时候给文件直链、什么时候退首页」值得被
 * 单测钉住；放在 JSX 里就只能靠集成测试隔着 DOM 猜。
 */
export interface ManualDownloadTarget {
  url: string
  /** true = 直接指向缓存里那条记录的 APK；false = 下载站首页（兜底） */
  fromCache: boolean
}

export const manualDownloadTarget = (
  snapshot: ManifestSnapshot | undefined,
  current: { code: number; variant: ArtifactVariant },
  channel: UpdateChannel
): ManualDownloadTarget => {
  if (snapshot) {
    try {
      const picked = selectUpdate(snapshot.rows, current.code, current.variant, channel)
      if (picked.release) {
        return { url: releaseUrl(picked.release.file, snapshot.base), fromCache: true }
      }
    } catch {
      // 同一版本号两条不同 file（AMBIGUOUS_RELEASE）/ 路径不合法：宁可不猜，退到下载站首页
    }
  }
  return { url: RELEASE_HOME_URL, fromCache: false }
}
