/**
 * endpoints.mjs —— 服务端端点（主机 / 端口 / 旧域名重写表）的**唯一读取入口**（Issue #274）。
 *
 * 唯一事实来源是仓库根的 `config/endpoints.json`：
 *
 * | 字段 | 用途 | 前端消费方 |
 * | --- | --- | --- |
 * | `consume.baseUrl` | **统一网关 BASE**（#869）：登录 + 推理上游（#812：同一份部署）+ 购买链接（#861）。App 只配这一个 BASE | `src/services/api/providers.ts` 的 `ours.defaults.baseUrl`（经 `services/api/environment.ts` 的 `inferenceBaseUrl`） |
 * | `feedbackUrl` | 反馈上传 | `src/services/diagnostics/config.ts` 的 `LEGACY_FEEDBACK_URL` |
 * | `legacyHosts` | 已下线主机（存过即视为没配过，回落默认） | `src/services/api/apiConfig.ts` 的 `LEGACY_HOSTS` |
 * | `allowedHosts` | `check:ip` 门禁豁免的线上主机白名单（旧池机器 + 网关域名；只收域名与既有旧池 IP，不收通配） | `scripts/lib/hardcodedIpAudit.mjs` 的 `ALLOWED_HOSTS` |
 * | `allowedPorts` | 白名单主机上开放的端口（反馈 60012 + 网关 https 443） | `scripts/check-endpoints.mjs` 交叉校验 |
 * | `download.primaryBase` | 分发首选机（清单 + `/apk/`） | `src/services/updateManifest.ts` 的 `PRIMARY_RELEASE_BASE`（经 `__ENDPOINTS__.dlPrimaryBase`）；原生 `UpdateEndpoint.java` 的 `PRIMARY_BASE`（经 `BuildConfig.DL_PRIMARY`） |
 * | `download.fallbackBase` | 分发回退机 | `src/services/updateManifest.ts` 的 `FALLBACK_RELEASE_BASE`（经 `__ENDPOINTS__.dlFallbackBase`）；原生 `UpdateEndpoint.java` 的 `FALLBACK_BASE`（经 `BuildConfig.DL_FALLBACK`） |
 *
 * 谁读它：
 *   - 构建期：`rspack.config.ts` 读同一份 JSON 注入 `__ENDPOINTS__`，前端源码只用注入值；
 *   - 门禁：`scripts/check-hardcoded-ip.mjs`（主机白名单）、`scripts/check-endpoints.mjs`（配置自洽）；
 *   - 脚本与测试：`scripts/shot-*.mjs`、`tests/**` 都 import 这里，不再自己写地址字面量。
 *
 * 为什么 `allowedPorts` 和 `allowedHosts` 分两份：端口写错一位（60012 ↔ 60021）在运行时只表现为
 * 「连不上」，没有任何报错线索。`allowedHosts` 只记主机，端口另列一份端口白名单，`check:endpoints`
 * 拿旧池地址（`feedbackUrl`）与网关 BASE 去交叉校验 —— 改端口却不改白名单立即变红，不需要任何人
 * 去 grep 代码（Issue #274 的负向 2）。#869 起旧池机器只剩反馈上传，网关是另一台机器（域名）。
 *
 * 语义边界：
 *   - `legacyHosts` 是「旧域名重写表」：老用户本地存着这些主机时视为没配过、回落当前默认值。
 *     它和白名单的用途正好相反，所以**两边不许重叠**（`check:endpoints` 会拦）。
 *   - 这个模块**读盘就校验，不合法立刻抛**（fail fast）：带着错地址跑起来只会更难查。
 *     只想拿「校验」这一半（配置不合法时仍要打印问题）就用 `endpointsSchema.mjs`。
 *   - 不碰网络、不缓存、不读环境变量。
 *   - 分发地址（`download.*`，Issue #269）也在这份配置里：换分发机只改这里一处，
 *     Web 侧由 rspack 注入、原生侧由 `android/app/build.gradle` 读成 `BuildConfig.DL_*`。
 *     原生下载白名单由这两个 base 派生，所以配置里不许再出现第三份主机名单。
 */

import { readFileSync } from 'node:fs'

import { validateConsumePay } from './consumeEndpoints.mjs'
import { ENDPOINTS_FILE, URL_FIELDS, validateEndpoints } from './endpointsSchema.mjs'

export { ENDPOINTS_FILE, URL_FIELDS, parseUrl, portOf, validateEndpoints } from './endpointsSchema.mjs'

/**
 * 读一份端点配置并校验（默认仓库根那份；测试/门禁可以传临时文件路径）。
 * 不合法直接抛错 —— 端点表不对的时候宁可启动失败，也不要带着错地址跑。
 */
export const loadEndpoints = (file = ENDPOINTS_FILE) => {
  const text = readFileSync(file, 'utf8')
  const raw = JSON.parse(text)
  // 旧池域那份地址（#274，现在只剩 feedbackUrl）与消费 / 支付两段（#484 W1-A）各用各的判据：
  // 前者要求主机/端口白名单，后者是网关（https + 废弃域 + 互不相同，#869 例外见 UNIFIED_GATEWAY_BASE）。
  const problems = [...validateEndpoints(raw), ...validateConsumePay(raw, text)]
  if (problems.length > 0) {
    throw new Error(`${file} 不合法：\n  - ${problems.join('\n  - ')}`)
  }
  return Object.freeze({
    feedbackUrl: raw.feedbackUrl.trim(),
    legacyHosts: Object.freeze(raw.legacyHosts.map((h) => h.trim())),
    allowedHosts: Object.freeze(raw.allowedHosts.map((h) => h.trim())),
    allowedPorts: Object.freeze([...raw.allowedPorts]),
    downloadPrimaryBase: raw.download.primaryBase.trim(),
    downloadFallbackBase: raw.download.fallbackBase.trim(),
    // 消费侧（sub2api）：账号/额度/卡密兑换/Key 管理（#484 W1-A）
    consumeBaseUrl: raw.consume.baseUrl.trim(),
    consumeApiV1Prefix: raw.consume.apiV1Prefix,
    consumeGatewayPrefix: raw.consume.gatewayPrefix,
    consumeTimeouts: Object.freeze({ ...raw.consume.timeoutMs }),
    // 支付侧（apia）：只负责买卡，不迁（#482 定调）
    payBaseUrl: raw.pay.baseUrl.trim(),
    payTimeouts: Object.freeze({ ...raw.pay.timeoutMs }),
  })
}

const config = loadEndpoints()

/** 反馈上传（`LEGACY_FEEDBACK_URL`） */
export const feedbackUrl = config.feedbackUrl
/** 已下线主机重写表（`LEGACY_HOSTS`）：删了老配置就失联，只许从配置读、不许删 */
export const legacyHosts = config.legacyHosts
/** 线上主机白名单（`check:ip` 的 `ALLOWED_HOSTS`） */
export const allowedHosts = config.allowedHosts
/** 端口白名单（`check:endpoints` 交叉校验用） */
export const allowedPorts = config.allowedPorts
/** 分发首选机（`UpdateEndpoint.PRIMARY_BASE` / `PRIMARY_RELEASE_BASE`，Issue #269） */
export const downloadPrimaryBase = config.downloadPrimaryBase
/** 分发回退机（`UpdateEndpoint.FALLBACK_BASE` / `FALLBACK_RELEASE_BASE`，Issue #269） */
export const downloadFallbackBase = config.downloadFallbackBase

/** 消费侧地址（sub2api 的 `__ENDPOINTS__.consume.baseUrl` / `BuildConfig.CONSUME_BASE`） */
export const consumeBaseUrl = config.consumeBaseUrl

/**
 * `ours` 渠道的**推理地址**（#812）：与登录环境同源，就是 `consume.baseUrl`。
 *
 * 以前推理取的是 `chatBaseUrl`（旧池域，#869 已删除），于是 staging 包出现「登录在 staging、推理打到生产」
 * —— 服务端发的 Key 被另一个环境判 401。源码侧的推导在 `src/services/api/environment.ts`，
 * 这里给同一份推导的脚本版：用例与截图脚本都 import 它，不再各自写 `chatBaseUrl` 当推理地址。
 */
export const inferenceBaseUrl = consumeBaseUrl.replace(/\/+$/, '')
/** 消费侧 JWT 前缀（固定 `/api/v1`，见 #484 §三） */
export const consumeApiV1Prefix = config.consumeApiV1Prefix
/** 消费侧 API Key 前缀（固定 `/v1`） */
export const consumeGatewayPrefix = config.consumeGatewayPrefix
/** 消费侧超时档位（read / write / redeem，毫秒）：调用点不许再写死毫秒数 */
export const consumeTimeouts = config.consumeTimeouts
/** 支付侧地址（apia 的 `__ENDPOINTS__.pay.baseUrl` / `BuildConfig.PAY_BASE`） */
export const payBaseUrl = config.payBaseUrl
/** 支付侧超时档位（read / write，毫秒） */
export const payTimeouts = config.payTimeouts

/** 旧池地址字段 → 值（提示文案 / 注入 / 文案表格用，不要再另抄一份） */
export const endpointUrls = Object.freeze({
  feedbackUrl,
})

/** 旧池端点的主机（去重） */
export const endpointHosts = Object.freeze([...new Set(Object.values(endpointUrls).map((url) => new URL(url).hostname))])

/** 主机白名单的 Set 形式（门禁判定要用，省得每次重新构造） */
export const ALLOWED_HOST_SET = new Set(allowedHosts)
