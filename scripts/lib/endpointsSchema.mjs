/**
 * endpointsSchema.mjs —— `config/endpoints.json` 的**形状与互洽校验**（纯函数，不读盘、不抛）。
 *
 * 拆出来单独一个文件的原因：`scripts/check-endpoints.mjs` 要在配置**不合法**时也能跑起来、
 * 把问题一条条打印出来。而 `scripts/lib/endpoints.mjs` 是「读盘 + 校验 + 不合法就抛」的
 * fail-fast 入口（脚本/测试 import 它就不该带着错地址继续跑）。门禁只能拿到纯校验部分，
 * 所以这里既没有副作用，也不 import 任何读文件的模块。
 *
 * 校验项（对应 Issue #274 的验收，#869 起结构改了）：
 *   1. 旧池地址（`URL_FIELDS`，现在只剩 `feedbackUrl`）是绝对 http(s) URL；
 *   2. 主机在 `allowedHosts` 里 —— 报「配置里的主机与白名单不一致」；
 *   3. 端口在 `allowedPorts` 里 —— 报「配置里的端口与白名单不一致」（负向 2：只改端口不改白名单必须红）；
 *   4. `legacyHosts`（已下线重写表）与 `allowedHosts` 不重叠；
 *   5. 网关 BASE（`consume.baseUrl` / `pay.baseUrl`，#869 单一 BASE）：主机:端口也要登记在同两份白名单里，
 *      且不许是裸 IP（回环的本地联调实例除外）。原来的「三个端点在同一台机器上」不再成立：
 *      旧池机器只剩反馈上传，网关是另一台机器（域名），硬把它们判成同机只会逼人把网关写回 IP。
 *
 * 校验项（对应 Issue #269，见 `validateDownload`）：
 *   6. `download.primaryBase` / `download.fallbackBase` 存在，且只能是「协议://主机[:端口]」；
 *   7. 回退机必须走 https；两个 base 不许相同（回退要有意义）。
 *   分发地址**不进** `URL_FIELDS`：分发机是另一台机器，并进去只会让「换分发机」把服务端配置一起改坏。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 配置文件的规范位置：仓库根的 `config/endpoints.json` */
export const ENDPOINTS_FILE = path.resolve(LIB_DIR, '..', '..', 'config', 'endpoints.json')

/**
 * 旧池地址字段（顺序即报错顺序）。#869 之后只剩 `feedbackUrl`：对话 / 邀请都已迁到统一网关 BASE
 * （`consume.baseUrl`），`chatBaseUrl` / `inviteBaseUrl` 随之删除。
 */
export const URL_FIELDS = ['feedbackUrl']

/**
 * 网关 BASE 字段（#869 单一 BASE）：形态（https / 前缀 / 废弃域）由 `consumeEndpoints.mjs` 判，
 * 这里只判「主机:端口登记在白名单里、不是裸 IP」。
 */
export const GATEWAY_FIELDS = [
  ['consume', 'baseUrl'],
  ['pay', 'baseUrl'],
]

const IPV4 = /^d{1,3}(?:.d{1,3}){3}$/u
/** 本机回环：本地联调实例（`http://127.0.0.1:18000`）是既有例外，不要求登记白名单 */
const isLoopbackHost = (host) => host === 'localhost' || host === '[::1]' || host === '::1' || /^127./u.test(host)

/**
 * 分发地址字段（Issue #269，顺序即报错顺序）。
 *
 * 为什么不并进 `URL_FIELDS`：分发机是另一台机器（清单 + `/apk/`）。
 * 并进去只会让「换分发机」把服务端配置一起改坏。
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

  // 1. 旧池地址字段必须是绝对 http(s) URL
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

  // 3. 主机白名单：旧池地址的主机都得在名单里
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

  // 4. 端口白名单：旧池地址的端口都得在名单里（负向 2：只改端口不改白名单 → 红）
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

  // 6. 网关 BASE（#869 单一 BASE）：主机:端口登记在白名单里，且不是裸 IP。
  //    取代原来的「三个端点同一台机器」：旧池机器只剩反馈上传，网关是另一台机器（域名），
  //    所以这里不再要求同机，改成「每个地址都得登记」—— 换网关域名而忘了登记白名单照样红。
  //    只收紧、不放宽：https 与废弃域仍由 consumeEndpoints.mjs 判，这里不接受通配或额外裸 IP。
  for (const [section, key] of GATEWAY_FIELDS) {
    const field = `${section}.${key}`
    const url = parseUrl(raw[section]?.[key])
    if (!url) continue // 缺失 / 不合法由 consumeEndpoints.mjs 报，这里不重复
    if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) continue
    if (IPV4.test(url.hostname)) {
      problems.push(`${field} 不许是裸 IP：${url.hostname}（网关 BASE 必须是域名，#869）`)
      continue
    }
    if (isHostList(raw.allowedHosts) && !raw.allowedHosts.some((h) => h.trim() === url.hostname)) {
      problems.push(
        `配置里的主机与白名单不一致：${field} 的主机 ${url.hostname} 不在 allowedHosts ` +
          `[${raw.allowedHosts.map((h) => h.trim()).join(', ')}] 里（换网关域名要同时改地址与 allowedHosts）`
      )
    }
    if (isPortList(raw.allowedPorts) && !raw.allowedPorts.includes(portOf(url))) {
      problems.push(
        `配置里的端口与白名单不一致：${field} 的端口 ${portOf(url)} 不在 allowedPorts ` +
          `[${raw.allowedPorts.join(', ')}] 里`
      )
    }
  }

  // 7. 分发地址（Issue #269）：形态与互不冲突，规则见 validateDownload
  problems.push(...validateDownload(raw))

  return problems
}
