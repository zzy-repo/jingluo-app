/**
 * endpoints.mjs —— 服务端端点（主机 / 端口 / 旧域名重写表）的**唯一读取入口**（Issue #274）。
 *
 * 唯一事实来源是仓库根的 `config/endpoints.json`：
 *
 * | 字段 | 用途 | 前端消费方 |
 * | --- | --- | --- |
 * | `chatBaseUrl` | 对话上游 | `src/services/api/providers.ts` 的 `ours.defaults.baseUrl` |
 * | `inviteBaseUrl` | 邀请 / 额度 / 卡密服务 | `src/services/invite/api.ts` 的 `INVITE_API_BASE` |
 * | `feedbackUrl` | 反馈上传 | `src/services/diagnostics/config.ts` 的 `LEGACY_FEEDBACK_URL` |
 * | `legacyHosts` | 已下线主机（存过即视为没配过，回落默认） | `src/services/api/apiConfig.ts` 的 `LEGACY_HOSTS` |
 * | `allowedHosts` | `check:ip` 门禁豁免的线上主机白名单 | `scripts/lib/hardcodedIpAudit.mjs` 的 `ALLOWED_HOSTS` |
 * | `allowedPorts` | 同一台机器上开放的端口白名单 | `scripts/check-endpoints.mjs` 交叉校验 |
 *
 * 谁读它：
 *   - 构建期：`rspack.config.ts` 读同一份 JSON 注入 `__ENDPOINTS__`，前端源码只用注入值；
 *   - 门禁：`scripts/check-hardcoded-ip.mjs`（主机白名单）、`scripts/check-endpoints.mjs`（配置自洽）；
 *   - 脚本与测试：`scripts/shot-*.mjs`、`repro/**`、`tests/**` 都 import 这里，不再自己写地址字面量。
 *
 * 为什么 `allowedPorts` 和 `allowedHosts` 分两份：同一台机器上有 60010 / 60012 / 60013 三个端口，
 * 端口写错一位（60010 ↔ 60001）在运行时只表现为「连不上」，没有任何报错线索。`allowedHosts`
 * 只记主机，端口另列一份端口白名单，`check:endpoints` 拿三份 URL 去交叉校验 —— 改端口却不改
 * 白名单立即变红，不需要任何人去 grep 代码（Issue #274 的负向 2）。
 *
 * 语义边界：
 *   - `legacyHosts` 是「旧域名重写表」：老用户本地存着这些主机时视为没配过、回落当前默认值。
 *     它和白名单的用途正好相反，所以**两边不许重叠**（`check:endpoints` 会拦）。
 *   - 这个模块**读盘就校验，不合法立刻抛**（fail fast）：带着错地址跑起来只会更难查。
 *     只想拿「校验」这一半（配置不合法时仍要打印问题）就用 `endpointsSchema.mjs`。
 *   - 不碰网络、不缓存、不读环境变量。
 */

import { readFileSync } from 'node:fs'

import { ENDPOINTS_FILE, URL_FIELDS, validateEndpoints } from './endpointsSchema.mjs'

export { ENDPOINTS_FILE, URL_FIELDS, parseUrl, portOf, validateEndpoints } from './endpointsSchema.mjs'

/**
 * 读一份端点配置并校验（默认仓库根那份；测试/门禁可以传临时文件路径）。
 * 不合法直接抛错 —— 端点表不对的时候宁可启动失败，也不要带着错地址跑。
 */
export const loadEndpoints = (file = ENDPOINTS_FILE) => {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const problems = validateEndpoints(raw)
  if (problems.length > 0) {
    throw new Error(`${file} 不合法：\n  - ${problems.join('\n  - ')}`)
  }
  return Object.freeze({
    chatBaseUrl: raw.chatBaseUrl.trim(),
    inviteBaseUrl: raw.inviteBaseUrl.trim(),
    feedbackUrl: raw.feedbackUrl.trim(),
    legacyHosts: Object.freeze(raw.legacyHosts.map((h) => h.trim())),
    allowedHosts: Object.freeze(raw.allowedHosts.map((h) => h.trim())),
    allowedPorts: Object.freeze([...raw.allowedPorts]),
  })
}

const config = loadEndpoints()

/** 对话上游（`ours.defaults.baseUrl`） */
export const chatBaseUrl = config.chatBaseUrl
/** 邀请 / 额度 / 卡密服务（`INVITE_API_BASE`） */
export const inviteBaseUrl = config.inviteBaseUrl
/** 反馈上传（`LEGACY_FEEDBACK_URL`） */
export const feedbackUrl = config.feedbackUrl
/** 已下线主机重写表（`LEGACY_HOSTS`）：删了老配置就失联，只许从配置读、不许删 */
export const legacyHosts = config.legacyHosts
/** 线上主机白名单（`check:ip` 的 `ALLOWED_HOSTS`） */
export const allowedHosts = config.allowedHosts
/** 端口白名单（`check:endpoints` 交叉校验用） */
export const allowedPorts = config.allowedPorts

/** 三个地址字段 → 值（提示文案 / 注入 / 文案表格用，不要再另抄一份） */
export const endpointUrls = Object.freeze({
  chatBaseUrl,
  inviteBaseUrl,
  feedbackUrl,
})

/** 三个端点的主机（同一台机器，去重后应当只有一个） */
export const endpointHosts = Object.freeze([...new Set(Object.values(endpointUrls).map((url) => new URL(url).hostname))])

/** 主机白名单的 Set 形式（门禁判定要用，省得每次重新构造） */
export const ALLOWED_HOST_SET = new Set(allowedHosts)
