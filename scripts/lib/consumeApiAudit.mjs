/**
 * consumeApiAudit.mjs —— `check:consume-api` 的判定核心（纯函数，不碰文件系统，可单测）。
 *
 * 规则书（为什么有这条门禁）在 `scripts/check-consume-api.mjs` 的文件头；这里只放数据表与判据：
 *   - `PATH_WHITELIST`：客户端**只允许**调这些后端路径（#484 §三 的原文表）；
 *   - `LEGACY_PATHS`：W1-D / W1-E 清理之前仍在仓库里的旧路径（逐条写明归属与理由，**不许新增**）；
 *   - `BACKEND_BASE_ALLOW`：`pay.baseUrl` 这类地址在 src 里还没清完的落点（同上，**不许新增**）；
 *   - `findPathLiterals` / `matchWhitelist`：从一行源码里抽出路径字面量并判定。
 *
 * 为什么白名单是「路径表」而不是「函数表」：门禁扫的是**字面量**（谁都能调，函数可以被包装）。
 * 方法（GET / POST）不参与判定 —— 一个路径只允许一种方法这件事由 `docs/consume-layer.md` 的表约束，
 * 门禁只保证「路径本身在白名单里」，多写一个方法不会造成越权调用新的后端能力。
 */

/** 白名单：`#484 §三` 的原文表（含 §3.5 支付侧、§3.6 网关「及各家兼容路径」） */
export const PATH_WHITELIST = [
  // §3.1 账号与身份（JWT）
  '/api/v1/settings/public',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/login/2fa',
  '/api/v1/auth/send-verify-code',
  '/api/v1/auth/refresh',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/me',
  '/api/v1/auth/revoke-all-sessions',
  '/api/v1/user/profile',
  // §3.1b 邀请
  '/api/v1/auth/validate-invitation-code',
  '/api/v1/user/aff',
  // §3.1c 邮箱绑定
  '/api/v1/user/account-bindings/email/send-code',
  '/api/v1/user/account-bindings/email',
  '/api/v1/user/account-bindings/:provider',
  // §3.2 Key 管理
  '/api/v1/keys',
  '/api/v1/keys/:id',
  // §3.3 额度与用量
  '/v1/usage',
  '/api/v1/usage',
  '/api/v1/usage/stats',
  '/api/v1/usage/dashboard/*',
  '/api/v1/user/api-keys/:id/usage/daily',
  // §3.4 卡密兑换
  '/api/v1/redeem',
  '/api/v1/redeem/history',
  // §3.5 支付（apia）：只负责买卡
  '/api/plans',
  '/api/pay-link',
  '/api/orders',
  '/api/card/trail',
  // §3.6 网关（聊天）：模型调用「及各家兼容路径」，取值来自 src/services/api/providers.ts
  '/v1/models',
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/tools',
]

/**
 * 旧路径豁免：W1-D（删 invite/ours 的消费侧）与 W1-E（支付 UI 归位）还没落地之前，
 * 这些路径仍在仓库里。**只许减少，不许新增** —— 新增一条就意味着「有东西绕过白名单调后端」。
 */
export const LEGACY_PATHS = {
  '/api/v1/feedback': {
    files: ['src/services/diagnostics/config.ts'],
    owner: 'W1-D',
    reason: '旧池域的反馈上传（明文 http），随旧服务下线一起删',
  },
  '/api/redeem': {
    files: ['src/services/ours/api.ts'],
    owner: 'W1-D',
    reason: 'apia 侧的旧兑换接口，兑换改走 sub2api 的 /api/v1/redeem',
  },
  '/api/balance': {
    files: ['src/services/ours/api.ts'],
    owner: 'W1-D',
    reason: 'apia 的 Key 探活，额度改读 sub2api 的 /v1/usage',
  },
  // vendored 第三方参考实现（SillyTavern 扩展，AGPL-3.0，见 src/services/memory/README.md）：
  // 没有任何入口 import 它（.oxlintrc.json 的 ignorePatterns 有说明），里面的地址也不会被请求。
  // 它以后要整体同步上游，不在本仓就地改，所以按「登记豁免」而不是「改上游代码」处理。
  '/api/connection-manager/profiles': {
    files: ['src/services/memory/index.js'],
    owner: 'vendored',
    reason: 'vendored 参考实现，未接进运行时；同步上游时不改这一份',
  },
}

/**
 * `pay.baseUrl` 的旧落点：`src/services/ours/**` 与 `src/services/invite/**` 里还写着 apia 的
 * 域名（W1-D/W1-E 会清）。**只许减少**：新增一处 = 又有一份地址副本。
 */
export const BACKEND_BASE_ALLOW = {
  'src/services/ours/api.ts': { owner: 'W1-D', reason: 'OURS_API_BASE：支付服务地址，随消费层迁移改读 __ENDPOINTS__.pay.baseUrl' },
}

/** 明文 http 的显式豁免（`.local` 是 URL 解析用的哨兵 base，不发请求） */
export const PLAINTEXT_ALLOW = {
  'redacted.local': {
    files: ['src/services/diagnostics/fields.ts', 'src/services/diagnostics/redact.ts'],
    reason: '只用于 new URL(value, base) 解析出 host，从不发起请求',
  },
  // SVG 的 xmlns 是**命名空间标识符**，不是可请求地址（浏览器不会去解析它）
  'www.w3.org': {
    files: [
      'src/components/base/icons.tsx',
      'src/components/chatInput/DragMask.tsx',
      'src/components/files/FileIcon.tsx',
      'src/components/session/Welcome.tsx',
    ],
    reason: 'SVG xmlns 命名空间，不是后端地址（浏览器不会去解析它）',
  },
}

/** 鉴权类标记：与 `device_id` 同现即为「把设备码当凭据」（#484 §七 第 3 条 / A1 的 grep 判据） */
const AUTH_MARKERS = /(authorization|bearer|x-api-key)/i

/** 路径字面量的形状：`/api/v1/...`、`/api/...`、`/v1/...` */
const PATH_PREFIXES = ['/api/v1/', '/api/', '/v1/']

/** 路径里允许出现的字符（含模板 `${id}` 这种） */
const PATH_CHARS = /[A-Za-z0-9_\-./:${}]/

/** 把 `${...}` 归一成 `:param`，方便和白名单里的 `:id` / `:provider` 对齐 */
const normalizeTemplate = (value) => value.replace(/\$\{[^}]*\}/g, ':param')

/**
 * 从一行源码里抽出所有「后端路径字面量」。
 *
 * 只在引号内出现才算（注释行由调用方先过滤）：`'`/`"`/`` ` `` 三种都认，
 * 模板变量归一成 `:param`。返回去重后的候选（保持出现顺序）。
 */
export const findPathLiterals = (line) => {
  const found = []
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch !== "'" && ch !== '"' && ch !== '`') continue
    const prefix = PATH_PREFIXES.find((item) => line.startsWith(item, i + 1))
    if (!prefix) continue
    let end = i + 1
    while (end < line.length && PATH_CHARS.test(line[end])) end += 1
    const literal = normalizeTemplate(line.slice(i + 1, end))
    if (literal.length > 1) found.push(literal)
    i = end - 1
  }
  return [...new Set(found)]
}

/** 白名单条目 → 正则（`*` = 任意后缀，`:param` / `:id` 等 = 单个路径段） */
const patternToRegExp = (pattern) => {
  const segments = pattern.split('/').map((segment) => {
    if (segment === '*') return '.*'
    // 冒号段（`:id` / `:provider`）与源码里的模板变量（已归一成 `:param`）互相通配
    if (segment.startsWith(':')) return '[A-Za-z0-9_:%.-]+'
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  return new RegExp(`^${segments.join('/')}$`)
}

const WHITELIST_PATTERNS = PATH_WHITELIST.map((pattern) => ({ pattern, regExp: patternToRegExp(pattern) }))
const LEGACY_PATTERNS = Object.keys(LEGACY_PATHS).map((pattern) => ({ pattern, regExp: patternToRegExp(pattern) }))

/**
 * 判定一个字面量：
 *  - `{ ok: true }`                 在白名单里；
 *  - `{ ok: true, legacy: 归属 }`   在旧路径豁免里（且调用方文件与登记一致）；
 *  - `{ ok: false, reason }`        白名单外 —— 门禁要报的那一条。
 */
export const matchWhitelist = (literal, { file } = {}) => {
  for (const { regExp } of WHITELIST_PATTERNS) {
    if (regExp.test(literal)) return { ok: true, kind: 'whitelist' }
  }
  for (const { pattern, regExp } of LEGACY_PATTERNS) {
    if (!regExp.test(literal)) continue
    const entry = LEGACY_PATHS[pattern]
    if (!file || entry.files.includes(file)) return { ok: true, kind: 'legacy', owner: entry.owner }
    return {
      ok: false,
      reason:
        `旧路径 ${pattern} 只登记在 ${entry.files.join(' / ')}（${entry.owner}：${entry.reason}）` +
        `，不许扩散到 ${file}`,
    }
  }
  return {
    ok: false,
    reason: '不在白名单里（#484 §三：白名单之外的一切端点禁止调用）',
  }
}

/** 一行里是否把设备码当成了鉴权凭据 */
export const usesDeviceIdAsAuth = (line) => /device_?id/i.test(line) && AUTH_MARKERS.test(line)

/** 一行里是否把 Key / JWT 放进了 query（`?key=` / `&api_key=` / `?token=` …） */
export const keyInQuery = (line) => /[?&](?:api_key|apikey|key|token|access_token|refresh_token)=/i.test(line)
