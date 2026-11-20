/**
 * API Key 管理（JWT 通道）—— Issue #484 §3.2，W1-A。
 *
 *   GET    /api/v1/keys          列表（分页：page / page_size / search / status / group_id / sort_*）
 *   POST   /api/v1/keys          创建（name* / group_id? / custom_key? / ip_* / quota(USD) / expires_in_days? …）
 *   GET    /api/v1/keys/:id      详情
 *   PUT    /api/v1/keys/:id      改名 / 停用 / 改额度（**没有 `key` 字段** → 换 Key 只能新建再删旧）
 *   DELETE /api/v1/keys/:id      删除
 *
 * 两条硬约束：
 *  1. **创建不可重试**：`POST /keys` 没有幂等键，重发会生成多把 Key，把用户的额度入口污染成一片
 *     （#484 §4.3）。所以 `createKey` 默认先按 `name` 查一遍（`dedupe: true`），查到同名就直接回那把，
 *     要真建第二把必须显式 `dedupe: false` —— 「重试前先 GET」这条规则落在这里，而不是靠调用点记得。
 *  2. Key 原文只从服务端拿（`sk-` + 32 字节 hex）。**客户端不得自行拼接/伪造**；本层不打日志、不进 URL。
 */

import type { ConsumeCallResult, ConsumeEmpty, ConsumeHttp } from './http.js'

/**
 * `APIKey`。`quota === 0` 表示**不限**，不是「零额度」（#484 §4.5 第 10 条）。
 *
 * 字段来自**本地联调实例的真实 200**（`GET /api/v1/keys?page=1&page_size=20`，实例 0.2.20）：
 * `{id,user_id,key,name,group_id,status,ip_whitelist,ip_blacklist,last_used_at,last_used_ip,quota,
 *   quota_used,expires_at,created_at,updated_at,current_concurrency,rate_limit_5h,rate_limit_1d,
 *   rate_limit_7d,usage_5h,usage_1d,usage_7d,window_5h_start,window_1d_start,window_7d_start}`
 */
export type ConsumeApiKey = {
  id: number
  name: string
  /** 完整 Key（`sk-…`）：只许进 Authorization 头 / 安全存储，**永不进日志与 DOM 全文** */
  key: string
  status: 'active' | 'inactive' | string
  /** 额度上限，单位 USD；0 = 不限 */
  quota: number
  /** 已用额度，单位 USD（注意：与 `/v1/usage` 的 `quota.used` 不是一回事） */
  quotaUsed: number
  groupId?: number | null
  ipWhitelist?: string | null
  ipBlacklist?: string | null
  expiresAt?: string | null
  lastUsedAt?: string | null
  lastUsedIp?: string | null
  createdAt?: string
  updatedAt?: string
  /** 当前并发占用 */
  currentConcurrency?: number
  /** 三个速率窗口的上限（0 = 该窗口不限） */
  rateLimit5h?: number
  rateLimit1d?: number
  rateLimit7d?: number
  /** 三个窗口的已用量 */
  usage5h?: number
  usage1d?: number
  usage7d?: number
}

/** 面板分页信封（`pkg/response` 的 `PaginatedData`） */
export type ConsumePage<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number }

/** 列表查询：`search` 用于「重试前先查一遍」的防重复创建 */
export type ConsumeKeyQuery = {
  page?: number
  pageSize?: number
  search?: string
  status?: string
  groupId?: number
}

/** 创建入参（`quota` 是 USD，`expires_in_days` 是天数；`custom_key` 只在确有需要时用） */
export type ConsumeKeyCreateInput = {
  name: string
  groupId?: number
  customKey?: string
  ipWhitelist?: string
  ipBlacklist?: string
  quota?: number
  expiresInDays?: number
  rateLimit5h?: number
  rateLimit1d?: number
  rateLimit7d?: number
}

/** 更新入参：**没有 `key`**（服务端不接受换值），`status` 只有 active / inactive */
export type ConsumeKeyUpdateInput = {
  name?: string
  groupId?: number
  status?: 'active' | 'inactive'
  ipWhitelist?: string
  ipBlacklist?: string
  quota?: number
  expiresAt?: string | null
  resetQuota?: boolean
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** 服务端 `APIKey` → `ConsumeApiKey`（snake_case 只在这里转一次） */
export const toConsumeApiKey = (value: unknown): ConsumeApiKey => {
  const key = asRecord(value)
  const out: ConsumeApiKey = {
    id: num(key.id),
    name: str(key.name),
    key: str(key.key),
    status: str(key.status) || 'active',
    quota: num(key.quota),
    quotaUsed: num(key.quota_used),
  }
  if (typeof key.group_id === 'number' || key.group_id === null) {
    out.groupId = key.group_id as number | null
  }
  if (typeof key.ip_whitelist === 'string' || key.ip_whitelist === null) {
    out.ipWhitelist = key.ip_whitelist as string | null
  }
  if (typeof key.ip_blacklist === 'string' || key.ip_blacklist === null) {
    out.ipBlacklist = key.ip_blacklist as string | null
  }
  if (typeof key.expires_at === 'string' || key.expires_at === null) {
    out.expiresAt = key.expires_at as string | null
  }
  if (typeof key.last_used_at === 'string' || key.last_used_at === null) {
    out.lastUsedAt = key.last_used_at as string | null
  }
  if (typeof key.last_used_ip === 'string' || key.last_used_ip === null) {
    out.lastUsedIp = key.last_used_ip as string | null
  }
  if (typeof key.created_at === 'string') {
    out.createdAt = key.created_at
  }
  if (typeof key.updated_at === 'string') {
    out.updatedAt = key.updated_at
  }
  const optionalNumbers: [keyof ConsumeApiKey, unknown][] = [
    ['currentConcurrency', key.current_concurrency],
    ['rateLimit5h', key.rate_limit_5h],
    ['rateLimit1d', key.rate_limit_1d],
    ['rateLimit7d', key.rate_limit_7d],
    ['usage5h', key.usage_5h],
    ['usage1d', key.usage_1d],
    ['usage7d', key.usage_7d],
  ]
  for (const [field, raw] of optionalNumbers) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      ;(out as Record<string, unknown>)[field] = raw
    }
  }
  return out
}

/** 分页信封 → `ConsumePage`（**空列表是正常态**，不是错误，#484 §4.5 第 9 条） */
export const toConsumePage = <T>(value: unknown, mapItem: (item: unknown) => T): ConsumePage<T> => {
  const page = asRecord(value)
  const items = Array.isArray(page.items) ? page.items.map(mapItem) : []
  return {
    items,
    total: num(page.total, items.length),
    page: num(page.page, 1),
    pageSize: num(page.page_size, items.length),
    pages: num(page.pages, 1),
  }
}

const toQuery = (query: ConsumeKeyQuery): Record<string, string | number | undefined> => ({
  page: query.page,
  page_size: query.pageSize,
  search: query.search,
  status: query.status,
  group_id: query.groupId,
})

/** 列表（只读，可重试） */
export const listKeys = (http: ConsumeHttp, query: ConsumeKeyQuery = {}): Promise<ConsumeCallResult<ConsumePage<ConsumeApiKey>>> =>
  http
    .call<unknown>({ method: 'GET', path: '/api/v1/keys', query: toQuery(query), timeout: 'read' })
    .then((result) => (result.ok ? { ...result, data: toConsumePage(result.data, toConsumeApiKey) } : result))

/** 详情（只读，可重试） */
export const getKey = (http: ConsumeHttp, id: number): Promise<ConsumeCallResult<ConsumeApiKey>> =>
  http
    .call<unknown>({ method: 'GET', path: `/api/v1/keys/${id}`, timeout: 'read' })
    .then((result) => (result.ok ? { ...result, data: toConsumeApiKey(result.data) } : result))

const toCreateBody = (input: ConsumeKeyCreateInput): Record<string, unknown> => {
  const body: Record<string, unknown> = { name: input.name }
  if (input.groupId !== undefined) {body.group_id = input.groupId}
  if (input.customKey) {body.custom_key = input.customKey}
  if (input.ipWhitelist) {body.ip_whitelist = input.ipWhitelist}
  if (input.ipBlacklist) {body.ip_blacklist = input.ipBlacklist}
  if (input.quota !== undefined) {body.quota = input.quota}
  if (input.expiresInDays !== undefined) {body.expires_in_days = input.expiresInDays}
  if (input.rateLimit5h !== undefined) {body.rate_limit_5h = input.rateLimit5h}
  if (input.rateLimit1d !== undefined) {body.rate_limit_1d = input.rateLimit1d}
  if (input.rateLimit7d !== undefined) {body.rate_limit_7d = input.rateLimit7d}
  return body
}

/**
 * 创建 Key（#484 §4.3：**不可重试**，重试前先 `GET /api/v1/keys` 防重复创建）。
 *
 * `dedupe: true`（默认）时的行为：先按 `name` 搜一次，命中同名且同状态就**直接返回它**，
 * 不再发 POST —— 上一次超时到底成没成，这一查就有答案；`dedupe: false` 是给「确实要第二把同名 Key」
 * 的显式选择（服务端允许同名，所以只能由调用方说明意图）。
 */
export const createKey = async (
  http: ConsumeHttp,
  input: ConsumeKeyCreateInput,
  options: { dedupe?: boolean } = {}
): Promise<ConsumeCallResult<ConsumeApiKey>> => {
  if (options.dedupe !== false) {
    const existing = await listKeys(http, { search: input.name, page: 1, pageSize: 20 })
    if (existing.ok) {
      const hit = existing.data.items.find((item) => item.name === input.name)
      if (hit) {return { ok: true, data: hit, status: existing.status, raw: existing.raw }}
      // 查不到同名才继续 —— 查询失败（网络/5xx）不算「确认不存在」，此时宁可让调用方重试这个只读查询
    } else if (existing.error.retryable) {
      return existing
    }
  }
  return http
    .call<unknown>({ method: 'POST', path: '/api/v1/keys', body: toCreateBody(input), timeout: 'write' })
    .then((result) => (result.ok ? { ...result, data: toConsumeApiKey(result.data) } : result))
}

/** 更新（改名 / 停用 / 改额度）。**没有 `key` 字段**：想换 Key 值只能新建再删旧（#484 §3.2） */
export const updateKey = (
  http: ConsumeHttp,
  id: number,
  input: ConsumeKeyUpdateInput
): Promise<ConsumeCallResult<ConsumeApiKey>> => {
  const body: Record<string, unknown> = {}
  if (input.name !== undefined) {body.name = input.name}
  if (input.groupId !== undefined) {body.group_id = input.groupId}
  if (input.status !== undefined) {body.status = input.status}
  if (input.ipWhitelist !== undefined) {body.ip_whitelist = input.ipWhitelist}
  if (input.ipBlacklist !== undefined) {body.ip_blacklist = input.ipBlacklist}
  if (input.quota !== undefined) {body.quota = input.quota}
  if (input.expiresAt !== undefined) {body.expires_at = input.expiresAt}
  if (input.resetQuota !== undefined) {body.reset_quota = input.resetQuota}
  return http
    .call<unknown>({ method: 'PUT', path: `/api/v1/keys/${id}`, body, timeout: 'write' })
    .then((result) => (result.ok ? { ...result, data: toConsumeApiKey(result.data) } : result))
}

/**
 * 删除（近似幂等）：已经删掉再删会回 404，那种情况当**已完成**处理（#484 §4.3「不要当致命错」）。
 */
export const deleteKey = async (http: ConsumeHttp, id: number): Promise<ConsumeCallResult<ConsumeEmpty>> => {
  const result = await http.call<ConsumeEmpty>({ method: 'DELETE', path: `/api/v1/keys/${id}`, timeout: 'write' })
  if (!result.ok && result.error.status === 404) {return { ok: true, data: undefined, status: 404, raw: result.raw }}
  return result
}
