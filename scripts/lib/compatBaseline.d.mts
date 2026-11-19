/**
 * `scripts/lib/compatBaseline.mjs` 的类型声明（issue #276）。
 *
 * 为什么要有这个文件：唯一来源的运行时实现必须是能被 `node` 直接跑、也能被 .mjs 脚本 import 的
 * `.mjs`（没有构建步骤）；而 `rspack.config.ts` 是 TypeScript，tsc 在 NodeNext 下会把
 * `./scripts/lib/compatBaseline.mjs` 解析到本文件。声明与实现一一对应，
 * 改实现（导出名/签名）必须同步改这里，否则 `pnpm type` 直接红。
 */

export declare const ROOT: string
export declare const COMPAT_CONFIG_FILE: string
export declare const PACKAGE_JSON_FILE: string

export type CompatConfig = {
  baselineChromium: number
  probeTiers: number[]
  minAndroidSdk: number
}

export declare class CompatBaselineError extends Error {
  readonly code: 'COMPAT_BASELINE'
}

export declare const readCompatConfig: (file?: string) => CompatConfig
export declare const COMPAT_CONFIG: CompatConfig
export declare const BASELINE_CHROMIUM: number
export declare const PROBE_TIERS: number[]
export declare const MIN_ANDROID_SDK: number

export declare const browserslistChromeTarget: (chromium?: number) => string
export declare const browserslistTargets: () => string[]
export declare const chromeFloorsOf: (targets: unknown) => number[]
export declare const assertBrowserslist: (targets: unknown, baseline?: number) => number
export declare const productBrowserslist: (file?: string) => string[]
