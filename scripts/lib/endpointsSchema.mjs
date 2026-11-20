/**
 * endpointsSchema.mjs —— `config/endpoints.json` 的**形状与互洽校验**（纯函数，不读盘、不抛）。
 *
 * 拆出来单独一个文件的原因：`scripts/check-endpoints.mjs` 要在配置**不合法**时也能跑起来、
 * 把问题一条条打印出来。而 `scripts/lib/endpoints.mjs` 是「读盘 + 校验 + 不合法就抛」的
 * fail-fast 入口（脚本/测试 import 它就不该带着错地址继续跑）。门禁只能拿到纯校验部分，
 * 所以这里既没有副作用，也不 import 任何读文件的模块。
 *
 * 校验项（对应 Issue #274 的验收）：
 *   1. 三份地址是绝对 http(s) URL；
 *   2. 主机在 `allowedHosts` 里 —— 报「配置里的主机与白名单不一致」；
 *   3. 端口在 `allowedPorts` 里 —— 报「配置里的端口与白名单不一致」（负向 2：只改端口不改白名单必须红）；
 *   4. `legacyHosts`（已下线重写表）与 `allowedHosts` 不重叠；
 *   5. 三个端点在同一台机器上（本单的前提：一台机器、三个端口）。
 *
 * 校验项（对应 Issue #269，见 `validateDownload`）：
 *   6. `download.primaryBase` / `download.fallbackBase` 存在，且只能是「协议://主机[:端口]」；
 *   7. 回退机必须走 https；两个 base 不许相同（回退要有意义）。
 *   分发地址**不进** `URL_FIELDS`：第 5 条要求三个端点同机，而分发机是另一台机器。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 配置文件的规范位置：仓库根的 `config/endpoints.json` */
export const ENDPOINTS_FILE = path.resolve(LIB_DIR, '..', '..', 'config', 'endpoints.json')

/** 三个地址字段（顺序即报错顺序；「三个端口同一台机器」指的就是它们） */
export const URL_FIELDS = ['chatBaseUrl', 'inviteBaseUrl', 'feedbackUrl']

/**
 * 分发地址字段（Issue #269，顺序即报错顺序）。
 *
 * 为什么不并进 `URL_FIELDS`：第 6 条校验要求「三个端点在同一台机器上」，而分发机是另一台机器
 * （清单 + `/apk/`）。并进去只会让「换分发机」把服务端配置一起改坏。
 */
export const DOWNLOAD_FIELDS = ['primaryBase', 'fallbackBase']

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const isHostList = (value) => Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
const isPortList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((n) => Number.isInteger(n) && n > 0 && n < 65536)

/** 解析成 URL；解不开返回 null（校验里统一报错，调用方不用重复 try/catch） */
export const parseUrl = (value) => {
  if (!isNonEmptyString(value)) return null
  try {
    return new URL(value.trim())
  } catch {
    return null
  }
}

/** URL 的端口：没写时按协议补默认值（http 80 / https 443） */
export const portOf = (url) => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80)

/**
 * 校验分发地址 `download.*`（Issue #269），返回问题清单（空数组 = 通过）。
 *
 * 只校验「形态」与「互相不打架」：地址能不能真的下到东西是发布后的验证步骤，不在离线门禁里做。
 * 措辞会和 `check:endpoints` 的输出一起打给人看，所以写清「哪个字段、为什么」。
 */
export const validateDownload = (raw) => {
  const download = raw?.download
  if (typeof download !== 'object' || download === null || Array.isArray(download)) {
    return ['download 缺失：分发地址的唯一来源，必须给出 download.primaryBase / download.fallbackBase']
  }
  const problems = []
  const bases = new Map()
  for (const field of DOWNLOAD_FIELDS) {
    const value = download[field]
    const url = parseUrl(value)
    if (!url) {
      problems.push(`download.${field} 缺失或不是合法的绝对 URL：${JSON.stringify(value)}`)
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`download.${field} 必须是 http/https：${value}`)
      continue
    }
    // base 只能是「协议://主机[:端口]」：带路径/查询串/片段/凭据时，拼 /releases.json 与 /apk/ 都会拼错。
    // 末尾带 `/` 在 URL 层看不出来（pathname 同样是 '/'），按字符串判 —— 和 build.gradle 的
    // DL_BASE_PATTERN 对齐，避免「check:endpoints 绿、assembleRelease 红」。
    if (value.trim().endsWith('/')) {
      problems.push(`download.${field} 末尾不要带 /：${value}（拼 /releases.json 会变成 //releases.json）`)
      continue
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      problems.push(`download.${field} 只能是「协议://主机[:端口]」，不许带路径/查询串/片段/凭据：${value}`)
      continue
    }
    bases.set(field, url)
  }
  const fallback = bases.get('fallbackBase')
  // 回退机承载所有历史版本的最后兜底，必须走 TLS；明文只允许出现在首选机
  if (fallback && fallback.protocol !== 'https:') {
    problems.push(`download.fallbackBase 必须走 https：${download.fallbackBase}（回退机是已发布版本的最后兜底）`)
  }
  const primary = bases.get('primaryBase')
  // 两个 base 相同 = 回退没有意义，还会让「首选失败才回退」白打一次同一台机器
  if (primary && fallback && primary.href === fallback.href) {
    problems.push(`download.primaryBase 与 download.fallbackBase 相同：${primary.href}（回退要有意义）`)
  }
  return problems
}

/**
 * 校验一份端点配置，返回问题清单（空数组 = 通过）。
 * 每条问题的措辞会原样出现在门禁输出里，所以写清楚「哪个字段、哪份白名单」。
 */
export const validateEndpoints = (raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['配置不是 JSON 对象']
  const problems = []

  // 1. 三个地址字段必须是绝对 http(s) URL
  const urls = new Map()
  for (const field of URL_FIELDS) {
    const url = parseUrl(raw[field])
    if (!url) {
      problems.push(`${field} 缺失或不是合法的绝对 URL：${JSON.stringify(raw[field])}`)
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`${field} 必须是 http/https：${raw[field]}`)
      continue
    }
    urls.set(field, url)
  }

  // 2. 名单字段的形状
  if (!isHostList(raw.allowedHosts)) problems.push('allowedHosts 必须是非空字符串数组（线上主机白名单）')
  if (!isHostList(raw.legacyHosts)) problems.push('legacyHosts 必须是非空字符串数组（已下线主机重写表）')
  if (!isPortList(raw.allowedPorts)) problems.push('allowedPorts 必须是非空整数数组（端口白名单）')

  // 3. 主机白名单：三个地址的主机都得在名单里
  if (isHostList(raw.allowedHosts)) {
    const allowed = new Set(raw.allowedHosts.map((h) => h.trim()))
    for (const [field, url] of urls) {
      if (!allowed.has(url.hostname)) {
        problems.push(
          `配置里的主机与白名单不一致：${field} 的主机 ${url.hostname} 不在 allowedHosts ` +
            `[${[...allowed].join(', ')}] 里（换机器要同时改地址与 allowedHosts）`
        )
      }
    }
  }

  // 4. 端口白名单：三个地址的端口都得在名单里（负向 2：只改端口不改白名单 → 红）
  if (isPortList(raw.allowedPorts)) {
    const allowed = new Set(raw.allowedPorts)
    for (const [field, url] of urls) {
      const port = portOf(url)
      if (!allowed.has(port)) {
        problems.push(
          `配置里的端口与白名单不一致：${field} 的端口 ${port} 不在 allowedPorts ` +
            `[${[...allowed].join(', ')}] 里（同一台机器开放的端口只在这个名单里登记一次）`
        )
      }
    }
  }

  // 5. 旧域名重写表与线上白名单不许重叠：一边是「要丢掉」，一边是「允许写死」
  if (isHostList(raw.allowedHosts) && isHostList(raw.legacyHosts)) {
    const allowed = new Set(raw.allowedHosts.map((h) => h.trim()))
    for (const host of raw.legacyHosts.map((h) => h.trim())) {
      if (allowed.has(host)) {
        problems.push(`legacyHosts 与 allowedHosts 重叠：${host} 既在「已下线」名单又在「线上白名单」里`)
      }
    }
  }

  // 6. 三个端口必须是同一台机器（本单的前提：一台机器、三个端口）
  if (urls.size === URL_FIELDS.length) {
    const hosts = [...new Set([...urls.values()].map((url) => url.hostname))]
    if (hosts.length > 1) {
      problems.push(
        `三个端点不在同一台机器上：${URL_FIELDS.map((field) => `${field}=${urls.get(field).hostname}`).join(', ')}` +
          '（确实要拆机器就先改 config/endpoints.json 与这条校验，并在这里写明理由）'
      )
    }
  }

  // 7. 分发地址（Issue #269）：形态与互不冲突，规则见 validateDownload
  problems.push(...validateDownload(raw))

  return problems
}
