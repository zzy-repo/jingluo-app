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
/** 统一网关 BASE（#869）：consume ≠ pay 规则唯一允许相等的值 */
export declare const UNIFIED_GATEWAY_BASE: string
export declare const EXPECTED_API_V1_PREFIX: string
export declare const EXPECTED_GATEWAY_PREFIX: string
export declare const TIMEOUT_MIN_MS: number
export declare const TIMEOUT_MAX_MS: number

/** 覆盖通道的环境变量名（`CONSUME_BASE_OVERRIDE` / `PAY_BASE_OVERRIDE`） */
export declare const BASE_OVERRIDE_ENV: Readonly<{ consume: string; pay: string }>

/** 明文联调包放行开关的环境变量名（`ALLOW_INSECURE_CONSUME`；原生侧同名开关是 `-PallowInsecureConsume=true`） */
export declare const ALLOW_INSECURE_ENV: string

/** 放行开关的解析结果：`error` 非空 = 「设了但不合法」，调用方必须中止（只认字面 true） */
export type AllowInsecureParse = Readonly<{ allowInsecure: boolean; error: string | null }>

export declare const parseAllowInsecure: (raw: unknown) => AllowInsecureParse
export declare const allowInsecureFromEnv: (env?: Record<string, string | undefined>) => AllowInsecureParse

/** `validateConsumePay` / `checkBase` 的放宽选项（只放宽「明文 + 旧池域」两条） */
export type InsecureFlags = {
  allowInsecure?: boolean
  onNotice?: (message: string) => void
}

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
/** consume 与 pay 是否都等于统一网关 BASE（#869）：consume≠pay 规则唯一的放行条件 */
export declare const bothUnifiedBase: (consumeBase: unknown, payBase: unknown) => boolean
export declare const validateConsumePay: (raw: unknown, text?: string, options?: InsecureFlags) => string[]
export declare const placeholderNotice: (raw: unknown) => string | null
export declare const loadConsumePay: (file?: string, options?: InsecureFlags) => ConsumePayConfig
export declare const applyBaseOverrides: (
  config: ConsumePayConfig,
  raw?: unknown,
  env?: Record<string, string | undefined>,
  options?: InsecureFlags
) => BaseOverrideResult
