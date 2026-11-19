/**
 * `shared/build-types.mjs` 的类型声明（Issue #330）。
 *
 * 没有这个文件，`tsc`（module/moduleResolution: NodeNext）对
 * `import ... from '../../shared/build-types.mjs'` 会报 TS7016，
 * `pnpm run type` 直接红。缺了别处补 any —— 补这里。
 */

export declare const BUILD_TYPES: readonly ['stable', 'prerelease'];

/** 发布渠道枚举（releases.json 的 buildType） */
export type BuildType = (typeof BUILD_TYPES)[number];

export declare const BUILD_TYPE_SUFFIX_RE: RegExp;

export declare function buildTypeFor(version: string): BuildType;

export declare function isBuildType(value: unknown): value is BuildType;
