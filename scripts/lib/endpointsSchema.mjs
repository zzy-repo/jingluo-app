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
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 配置文件的规范位置：仓库根的 `config/endpoints.json` */
export const ENDPOINTS_FILE = path.resolve(LIB_DIR, '..', '..', 'config', 'endpoints.json')

/** 三个地址字段（顺序即报错顺序；「三个端口同一台机器」指的就是它们） */
export const URL_FIELDS = ['chatBaseUrl', 'inviteBaseUrl', 'feedbackUrl']

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

  return problems
}
