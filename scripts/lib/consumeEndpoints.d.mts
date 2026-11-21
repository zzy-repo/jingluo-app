/**
 * `scripts/lib/consumeEndpoints.mjs` 的类型声明（Issue #651）。
 *
 * 为什么要有这个文件：唯一来源的运行时实现必须是能被 `node` 直接跑、也能被 .mjs 脚本 import 的
 * `.mjs`（没有构建步骤）；而 `rspack.config.ts` 是 TypeScript，tsc 在 NodeNext 下会把
 * `./scripts/lib/consumeEndpoints.mjs` 解析到本文件（同 `compatBaseline.d.mts` / `testAuthSeam.d.mts`）。
 * 声明与实现一一对应：改实现（导出名 / 签名）必须同步改这里，否则 `pnpm type` 直接红。
 */

export declare const ENDPOINTS_FILE: string
export declare const ENDPOINTS_LABEL: string
export declare const DEPRECATED_MARKERS: readonly string[]
export declare const CONSUME_KEYS: readonly string[]
export declare const PAY_KEYS: readonly string[]
export declare const CONSUME_TIMEOUT_KEYS: readonly string[]
export declare const PAY_TIMEOUT_KEYS: readonly string[]
export declare const EXPECTED_API_V1_PREFIX: string
export declare const EXPECTED_GATEWAY_PREFIX: string
export declare const TIMEOUT_MIN_MS: number
export declare const TIMEOUT_MAX_MS: number

/** 覆盖通道的环境变量名（`CONSUME_BASE_OVERRIDE` / `PAY_BASE_OVERRIDE`） */
export declare const BASE_OVERRIDE_ENV: Readonly<{ consume: string; pay: string }>

export type ConsumeSection = {
  baseUrl: string
  apiV1Prefix: string
  gatewayPrefix: string
  timeoutMs: { read: number; write: number; redeem: number }
}

export type PaySection = {
  baseUrl: string
  timeoutMs: { read: number; write: number }
}

export type ConsumePayConfig = Readonly<{ consume: ConsumeSection; pay: PaySection }>

/** 覆盖解析结果：`config` 是生效配置，`overrides` 是本次真正生效的覆盖值 */
export type BaseOverrideResult = Readonly<{
  config: ConsumePayConfig
  overrides: Readonly<{ consume?: string; pay?: string }>
}>

export declare const collectKeyLines: (text: string) => Map<string, number>
export declare const isLoopbackHost: (hostname: string) => boolean
export declare const parseBaseUrl: (value: unknown) => URL | null
export declare const normalizeBaseForCompare: (value: unknown) => string
export declare const validateConsumePay: (raw: unknown, text?: string) => string[]
export declare const placeholderNotice: (raw: unknown) => string | null
export declare const loadConsumePay: (file?: string) => ConsumePayConfig
export declare const applyBaseOverrides: (
  config: ConsumePayConfig,
  raw?: unknown,
  env?: Record<string, string | undefined>
) => BaseOverrideResult
