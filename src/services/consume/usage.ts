/**
 * 额度与用量 —— Issue #484 §3.3，W1-A。
 *
 *   GET /v1/usage                        **sk- Key 通道**：当前 Key 的额度 / 余额（唯一「拿钥匙就能读额度」的接口）
 *   GET /api/v1/usage                    JWT：用量列表
 *   GET /api/v1/usage/stats              JWT：用量汇总
 *   GET /api/v1/usage/dashboard/*        JWT：仪表盘（各部门不同，路径原样透传）
 *   GET /api/v1/user/api-keys/:id/usage/daily  JWT：单把 Key 的每日用量
 *
 * 三条硬约束：
 *  1. `/v1/usage` **不套** `{code,message,data}` 信封（扁平 JSON），所以走 `unwrap: 'bare'`；
 *     面板那几个接口**套**信封。同一个解析器打天下必然读空（#484 §4.5 第 8 条）。
 *  2. 额度**只以服务端返回为准**：客户端不许缓存 / 推导余额，也不许拿本地账本判断「还能不能发消息」
 *     （#484 §4.5 第 10 条 / §七 第 6 条）。本文件只做「取一次、原样返回」。
 *  3. 金额单位一律 **元**（1 元 = 1 额度，后端 8b12ab2；sub2api 无 USD、也无积分概念）：
 *     本层只搬运服务端给的数值与币种码，展示格式化统一走 `src/utils/money.ts`。
 */

import { emptyRawResponse, type ConsumeCallResult, type ConsumeHttp } from './http.js'

/**
 * `/v1/usage` 的三种模式（`mode`）：`quota_limited` / `unrestricted`（订阅组或钱包余额）。
 *
 * 字段真值来自实测（本地实例 0.2.20 与线上 0.2.22 一致）——**文档在这里错了三处**，直接影响「已用多少」的显示：
 *   - `rate_limits` **整个键可能不存在**（该 Key 没配速率限制），所以它是可选字段，缺了就是空数组；
 *   - `quota.used` **不随实际消耗增长**（实测 `used:0` 而同 Key 的 `usage.total.actual_cost` 已 $0.0514），
 *     所以「已用」一律取 `spent`（= `usage.total.actual_cost`），**不要**显示 `quota.used`；
 *   - `quota.limit === 0` 仍然表示**不限**（不是零额度）。
 */
export type ConsumeGatewayUsage = {
  mode: 'quota_limited' | 'unrestricted' | string
  isValid: boolean
  status?: string
  /** 配额限制模式：`limit` / `remaining` / `unit`（币种码，正常是 `CNY`）。`limit === 0` 表示不限 */
  quota?: { limit: number; remaining: number; unit: string; used: number }
  /** 剩余额度（各模式都有；钱包模式等于账户余额） */
  remaining?: number
  unit?: string
  /** 订阅组名称 / 钱包模式固定为「钱包余额」 */
  planName?: string
  /** 钱包余额模式：账户余额（元） */
  balance?: number
  /** 真实花费（元）= `usage.total.actual_cost`。**这才是「已用」**（`quota.used` 不可信） */
  spent?: number
  /** 累计用量（`usage.total`）：界面上的「请求数 / token 数」从这里取 */
  usageTotal?: {
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    actualCost: number
  }
  /** 速率窗口：**键可能整个不存在**（实测），所以可选、缺省为空数组 */
  rateLimits: { window: string; limit: number; used: number; remaining: number; resetAt?: string }[]
  /** 到期时间 / 剩余天数（受限 Key 与订阅组都可能带） */
  expiresAt?: string
  daysUntilExpiry?: number
}

/** 用量列表 / 统计的查询参数（服务端按 `start_date` / `end_date` / `timezone` 过滤） */
export type ConsumeUsageQuery = { startDate?: string; endDate?: string; timezone?: string; page?: number; pageSize?: number }

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const toQuery = (query: ConsumeUsageQuery): Record<string, string | number | undefined> => ({
  start_date: query.startDate,
  end_date: query.endDate,
  timezone: query.timezone,
  page: query.page,
  page_size: query.pageSize,
})

/**
 * 当前 Key 的额度（**唯一的额度入口**，`Authorization: Bearer sk-…`）。
 *
 * 响应是扁平的：`{mode, isValid, quota?/planName?/balance?, remaining, unit, rate_limits?, usage…}`。
 * 这里只挑界面需要的字段，其余原样留在 `raw.json` 里供排查。
 */
export const getGatewayUsage = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeGatewayUsage>> =>
  http
    .call<unknown>({ method: 'GET', path: '/v1/usage', timeout: 'read', unwrap: 'bare' })
    .then((result) => (result.ok ? { ...result, data: toGatewayUsage(result.data) } : result))

const toGatewayUsage = (value: unknown): ConsumeGatewayUsage => {
  const body = asRecord(value)
  const quota = asRecord(body.quota)
  const usageTotal = asRecord(asRecord(body.usage).total)
  const usage: ConsumeGatewayUsage = {
    mode: str(body.mode) || 'unrestricted',
    // 实测有 isValid；老部署不给时按「有 remaining / balance 就算有效」兜底
    isValid: body.isValid === true || num(body.remaining) !== undefined,
    // 实测该键可能整个不存在 —— 缺了就是空数组，绝不假设它一定有
    rateLimits: Array.isArray(body.rate_limits)
      ? body.rate_limits.map((item) => {
          const window = asRecord(item)
          return {
            window: str(window.window),
            limit: num(window.limit) ?? 0,
            used: num(window.used) ?? 0,
            remaining: num(window.remaining) ?? 0,
            ...(typeof window.reset_at === 'string' ? { resetAt: window.reset_at } : {}),
          }
        })
      : [],
  }
  if (typeof body.status === 'string') {
    usage.status = body.status
  }
  if (Object.keys(quota).length > 0) {
    usage.quota = {
      limit: num(quota.limit) ?? 0,
      // `used` 只作参考：实测恒为 0（真花费在 usage.total.actual_cost）
      used: num(quota.used) ?? 0,
      remaining: num(quota.remaining) ?? 0,
      unit: str(quota.unit) || 'CNY',
    }
  }
  const remaining = num(body.remaining)
  if (remaining !== undefined) {
    usage.remaining = remaining
  }
  if (typeof body.unit === 'string') {
    usage.unit = body.unit
  }
  if (typeof body.planName === 'string') {
    usage.planName = body.planName
  }
  const balance = num(body.balance)
  if (balance !== undefined) {
    usage.balance = balance
  }
  // 「已用」= 真实花费（实测 quota.used 恒为 0，不可信）
  const spent = num(usageTotal.actual_cost)
  if (spent !== undefined) {
    usage.spent = spent
  }
  if (Object.keys(usageTotal).length > 0) {
    usage.usageTotal = {
      requests: num(usageTotal.requests) ?? 0,
      inputTokens: num(usageTotal.input_tokens) ?? 0,
      outputTokens: num(usageTotal.output_tokens) ?? 0,
      totalTokens: num(usageTotal.total_tokens) ?? 0,
      cacheReadTokens: num(usageTotal.cache_read_tokens) ?? 0,
      actualCost: spent ?? 0,
    }
  }
  if (typeof body.expires_at === 'string') {
    usage.expiresAt = body.expires_at
  }
  const days = num(body.days_until_expiry)
  if (days !== undefined) {
    usage.daysUntilExpiry = days
  }
  return usage
}

/**
 * 用量列表（JWT）。
 * 返回体是分页信封，但**字段因版本而异**（列表 / 汇总 / dashboard 三处不同），
 * 所以这里不硬编码成一个类型：原样返回 `data`，由界面按需取（#484 §4.5 第 9 条：空列表是正常态）。
 */
export const listUsage = (http: ConsumeHttp, query: ConsumeUsageQuery = {}): Promise<ConsumeCallResult<unknown>> =>
  http.call<unknown>({ method: 'GET', path: '/api/v1/usage', query: toQuery(query), timeout: 'read' })

/** 用量汇总 */
export const getUsageStats = (http: ConsumeHttp, query: ConsumeUsageQuery = {}): Promise<ConsumeCallResult<unknown>> =>
  http.call<unknown>({ method: 'GET', path: '/api/v1/usage/stats', query: toQuery(query), timeout: 'read' })

/**
 * 仪表盘（`/usage/dashboard/{summary,trend,models,...}`）。
 * `view` 只接受**路径段**（不许带 `?` 或 `#`）：白名单里这条是通配入口，拼接一律经过 `url()` 的前缀校验。
 */
export const getUsageDashboard = (
  http: ConsumeHttp,
  view: string,
  query: ConsumeUsageQuery = {}
): Promise<ConsumeCallResult<unknown>> => {
  const segment = view.replace(/^\/+/, '')
  if (segment === '' || /[?#\s]/.test(segment)) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'bad_request',
        code: 'BAD_DASHBOARD_VIEW',
        message: `dashboard 视图名不合法：${view}`,
        status: 0,
        retryable: false,
        envelope: 'none',
        i18nKey: 'consumeErrBadRequest',
      },
      raw: emptyRawResponse(),
    })
  }
  return http.call<unknown>({
    method: 'GET',
    path: `/api/v1/usage/dashboard/${segment}`,
    query: toQuery(query),
    timeout: 'read',
  })
}

/** 单把 Key 的每日用量（JWT）：`/user/api-keys/:id/usage/daily` */
export const getKeyDailyUsage = (
  http: ConsumeHttp,
  keyId: number,
  query: ConsumeUsageQuery = {}
): Promise<ConsumeCallResult<unknown>> =>
  http.call<unknown>({
    method: 'GET',
    path: `/api/v1/user/api-keys/${keyId}/usage/daily`,
    query: toQuery(query),
    timeout: 'read',
  })
