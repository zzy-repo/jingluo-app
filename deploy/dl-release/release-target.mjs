/**
 * 发布目标（公网清单 / 私有清单）× 变体 × 渠道 —— **纯函数**，便于离线单测（Issue #620）。
 *
 * ## 为什么要把这三条判定从 server.mjs 里拆出来
 *
 * #609 / PR #619 的四条硬闸（G1–G4）只守住了**脚本路径**（`scripts/publish-private-apk.mjs`）。
 * `POST /api/v1/release` 这条路当时只校验 buildType，**根本不看 artifactVariant** ——
 * 于是脚本层的闸可以被一次 HTTP 上传绕过（#601 事故的形状：「能不能发」取决于调用方自觉）。
 *
 * #620 把同一个口径搬进接口层，并且**判据只有一份**：
 *
 * | 目标清单 | 唯一允许的变体 | 唯一允许的渠道(buildType) | 与谁同口径 |
 * | --- | --- | --- | --- |
 * | `public`（`/var/www/dl/releases.json`） | `standard` | `stable` | `publish-private-apk.mjs` G1 + 校验器 public 口径 |
 * | `private`（`DL_PRIVATE_RELEASES_JSON`，线上 `/var/www/dl-private/releases.internal.json`，webroot 之外） | `internal` | 任意合法枚举 | `publish-private-apk.mjs` G1 + 校验器 private 口径 |
 *
 * 变体判不出来（unknown）时**不默认 standard**：`unknown !== 'standard'`，公网直接拒。
 * 这一条是 #620 的要害 —— 历史包/没写标记的包如果没有服务器白名单兜底，就进不了公网清单。
 *
 * 「同口径」由 `tests/unit/release-api-variant-gate.test.mjs` 钉住：
 * 本文件的 `TARGET_VARIANT` 必须与 `scripts/validate-releases-manifest.mjs` 的 `MODE_VARIANT`、
 * `scripts/publish-private-apk.mjs` 的 `TARGET_VARIANT` 完全一致（三处各写一份就会被改歪一处）。
 *
 * 这里不 import 任何 scripts/ 下的东西：`server.mjs` 在线上是 `/opt/dl-release/server.mjs`，
 * 只跟同目录的 `variant.mjs` / `apk-manifest.mjs` / `release-target.mjs` 与 `/shared/build-types.mjs`
 * 一起部署（见 docs/RELEASE-MANUAL.md §12）。跨目录 import 会让「单文件部署」多一条隐形依赖。
 */

import path from 'node:path';

/** 发布目标：公网清单 / 私有清单（互斥，各自只收一种变体） */
export const TARGETS = Object.freeze(['public', 'private']);

/** 每种目标**唯一允许**的变体（= 校验器 MODE_VARIANT = 发布脚本 TARGET_VARIANT） */
export const TARGET_VARIANT = Object.freeze({ public: 'standard', private: 'internal' });

/** 公网清单只收 stable（裁决 #614 决定 2：dl 不再是正式渠道，只留 standard 历史条目） */
export const PUBLIC_ALLOWED_BUILD_TYPES = Object.freeze(['stable']);

/** 端点路径 → 目标（一条路径一个目标，避免「同一个 URL 靠参数切换口径」的模糊地带） */
export const TARGET_PATHS = Object.freeze({
  '/api/v1/release': 'public',
  '/api/v1/release/private': 'private',
});

/** 变体不符时的短码（顶层 code 与 error.code 同值，与 #330 的 BAD_BUILD_TYPE 同口径） */
export const VARIANT_GATE_CODE = Object.freeze({
  public: 'VARIANT_NOT_PUBLIC',
  private: 'VARIANT_NOT_PRIVATE',
});

/** 渠道不符时的短码（公网清单只收 stable） */
export const BUILD_TYPE_GATE_CODE = 'BUILD_TYPE_NOT_PUBLIC';

/** 合并后的清单里出现不该出现的条目时的短码（写盘前 fail-closed） */
export const MANIFEST_GATE_CODE = Object.freeze({
  public: 'MANIFEST_INTERNAL_ENTRY',
  private: 'MANIFEST_STANDARD_ENTRY',
});

/** 端点路径 → 目标 id；不是发布端点返回 null（路由用） */
export function resolveTarget(pathname) {
  const key = typeof pathname === 'string' ? pathname.replace(/\/+$/, '') || '/' : '';
  return Object.prototype.hasOwnProperty.call(TARGET_PATHS, key) ? TARGET_PATHS[key] : null;
}

const variantLabel = (variant) => (variant ? JSON.stringify(variant) : 'unknown（判不出变体）');

/**
 * 闸 1：目标清单 × 变体（与 #619 G1 同口径）。
 *
 * @param {{target:'public'|'private', variant:('internal'|'standard'|null), source:(string|null)}} input
 * @returns {{ok:boolean, code?:string, message?:string}}
 */
export function judgeVariant({ target, variant, source = null }) {
  if (!TARGETS.includes(target)) {
    throw new Error(`未知的发布目标：${JSON.stringify(target)}（只认 ${TARGETS.join('|')}）`);
  }
  const only = TARGET_VARIANT[target];
  if (variant === only) return { ok: true };

  const code = VARIANT_GATE_CODE[target];
  const origin = source ? `，判定来源 ${source}` : '';
  const message =
    target === 'public'
      ? `公网清单只收 artifactVariant="standard" 的正式包，本次是 ${variantLabel(variant)}${origin}。`
        + 'internal / 判不出变体的包绝不进公网清单：清单是公开的，`file` 字段等于把内部包直链广播出去'
        + '（#601 事故形态，裁决 #614 决定 3）。internal 包请改走私有清单端点 POST /api/v1/release/private'
        + '（写私有清单 DL_PRIVATE_RELEASES_JSON，线上 /var/www/dl-private/releases.internal.json，webroot 之外）。'
        + '本次上传未落盘，releases.json 一个字节都没改。'
      : `私有清单只收 artifactVariant="internal" 的包，本次是 ${variantLabel(variant)}${origin}。`
        + 'standard 包走 GitHub Release（裁决 #614 决定 2），不进私有清单。'
        + '本次上传未落盘，私有清单一个字节都没改。';
  return { ok: false, code, message };
}

/**
 * 闸 2：目标清单 × 发布渠道（buildType）。只有公网清单限制渠道；私有清单只要求枚举合法
 * （枚举合法性在 server.mjs 的 (4b) 已经先判过了）。
 *
 * @param {{target:'public'|'private', buildType:string}} input
 */
export function judgeBuildType({ target, buildType }) {
  if (!TARGETS.includes(target)) {
    throw new Error(`未知的发布目标：${JSON.stringify(target)}（只认 ${TARGETS.join('|')}）`);
  }
  if (target !== 'public') return { ok: true };
  if (PUBLIC_ALLOWED_BUILD_TYPES.includes(buildType)) return { ok: true };
  return {
    ok: false,
    code: BUILD_TYPE_GATE_CODE,
    message:
      `公网清单只收 buildType=${PUBLIC_ALLOWED_BUILD_TYPES.map((v) => `"${v}"`).join('|')} 的正式发布，`
      + `本次 buildType=${JSON.stringify(buildType ?? null)}（meta 显式给出，或按版本号推导：-alpha/-beta/-rc → prerelease）。`
      + '预发布版请走 GitHub Release 的 prerelease 资产，internal 包请走 POST /api/v1/release/private'
      + '（裁决 #614 决定 2/3）。本次上传未落盘，releases.json 一个字节都没改。',
  };
}

/**
 * 合并后的清单里「不属于这个目标」的条目（写盘前 fail-closed，与 #330 的 findIllegalBuildTypes 同一手法）。
 *
 * 为什么要查**整份**清单而不只查新条目：新条目合法不代表清单干净 —— 公网清单里只要历史上
 * 漏进过一条 internal，本次上传再把它写回去就等于继续广播那个直链。
 *
 * @param {unknown} manifest
 * @returns {Array<{index:number, version:string, variant:string}>}
 */
export function findMismatchedVariants(manifest, target) {
  if (!TARGETS.includes(target)) {
    throw new Error(`未知的发布目标：${JSON.stringify(target)}（只认 ${TARGETS.join('|')}）`);
  }
  const only = TARGET_VARIANT[target];
  const list = Array.isArray(manifest && manifest.releases) ? manifest.releases : [];
  const bad = [];
  list.forEach((r, index) => {
    if (!r || typeof r !== 'object') return;
    // 「没写变体」的历史条目不算脏：它进不了自动更新（App 侧要求 artifactVariant 齐全），
    // 校验器对它是 warning 而不是 FAIL（docs/releases-manifest.md）。这里只拦**明确写错**的。
    if (r.artifactVariant === undefined) return;
    if (r.artifactVariant === only) return;
    bad.push({
      index,
      version: typeof r.version === 'string' && r.version ? r.version : '?',
      variant: String(r.artifactVariant),
    });
  });
  return bad;
}

/**
 * 闸 3：合并后的清单整体判一次（写盘前）。
 *
 * @param {{target:'public'|'private', manifest:unknown}} input
 */
export function judgeMergedManifest({ target, manifest }) {
  const bad = findMismatchedVariants(manifest, target);
  if (!bad.length) return { ok: true };
  const only = TARGET_VARIANT[target];
  const head = bad.slice(0, 3)
    .map((d) => `releases[${d.index}] ${d.version} artifactVariant=${d.variant}`)
    .join('；');
  return {
    ok: false,
    code: MANIFEST_GATE_CODE[target],
    count: bad.length,
    entries: bad,
    message:
      `合并后的${target === 'public' ? '公网' : '私有'}清单有 ${bad.length} 条 ${JSON.stringify(only)} 之外的条目`
      + `（${head}${bad.length > 3 ? ' …' : ''}）。`
      + (target === 'public'
        ? '公网清单出现 internal 条目 = 把内部包直链广播出去（#601 事故形态）：'
          + '先把它们挪进私有清单（DL_PRIVATE_RELEASES_JSON，线上 /var/www/dl-private/releases.internal.json）再发'
        : '私有清单只收 internal 条目：standard 包走 GitHub Release')
      + '。整份清单校验未通过，本次上传未落盘（APK 与清单均未改）。',
  };
}

/**
 * `child` 是否落在 `parent` 目录里（含相等）。用于「私有清单/私有包目录绝不许在 webroot 内」
 * —— 那是 #609 G1 的同一条判据，接口层也必须自己判一次（不能指望部署时人人记得）。
 *
 * @param {string} child
 * @param {string} parent
 */
export function isInsideDir(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
