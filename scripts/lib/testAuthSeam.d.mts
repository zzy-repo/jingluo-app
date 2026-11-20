/**
 * `scripts/lib/testAuthSeam.mjs` 的类型声明（#510）—— 写法与 `compatBaseline.d.mts` 同一套理由：
 * 实现必须是能被 `node` 直接跑、也能被 `.mjs` 脚本 import 的 `.mjs`（没有构建步骤），
 * 而 `rspack.config.ts` 是 TypeScript，NodeNext 下 tsc 会解析到本文件。
 * 声明与实现一一对应：改导出名 / 签名必须同步改这里，否则 `pnpm type` 直接红。
 */

export declare const SEAM_FLAG: string
export declare const SEAM_ACCESS_TOKEN: string
export declare const SEAM_SESSION: Readonly<{
  accessToken: string
  user: Readonly<{
    id: number
    email: string
    username: string
    role: string
    emailVerified: boolean
  }>
}>
export declare const SEAM_MARKERS: readonly string[]
export declare const seamEnabled: (env?: Record<string, string | undefined>) => boolean
export declare const scanForSeam: (dir: string) => { file: string; marker: string }[]
