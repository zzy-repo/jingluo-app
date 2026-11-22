#!/usr/bin/env node
/**
 * releases.json 清单校验器（离线，零依赖）
 *
 * 用途：发布前 / 部署前校验 dl.rose7.cn/releases.json 的结构与新增字段契约，
 * 不联网、不碰线上文件，只在本地跑。
 *
 * 用法：
 *   node scripts/validate-releases-manifest.mjs <file.json> [...] [--strict] [--private]
 *
 * 退出码：0 = 全部通过（warning 不算失败）；1 = 有 FAIL
 * --strict：把 warning 也当失败（用于「新版本必须带 sha256 + artifactVariant」这种门禁）
 * --private：按**私有清单**口径校验（`releases.internal.json`，见 §「两种清单」）
 *
 * 契约字段（详见 docs/releases-manifest.md）：
 *   version / versionCode / releasedAt / file / size / md5 / changes / buildType / breaking
 *   + sha256（可选，新版本必须有）  artifactVariant（可选：internal|standard）
 *   + artifactVariantSource（有 artifactVariant 时必须给：apk-manifest|sha256-allowlist）
 *
 * ## 两种清单，两条互斥的口径（Issue #609 / 裁决 #614 决定 3）
 *
 * | 模式 | 文件 | 允许的条目 |
 * | --- | --- | --- |
 * | `public`（默认） | `https://dl.rose7.cn/releases.json` | **只允许** `artifactVariant: "standard"`；出现 `internal` 一律 FAIL |
 * | `private`（--private） | 私有清单（线上 `/opt/dl-private/releases.internal.json`，私有根 `/opt/dl-private` 下、webroot 外；#637 私有根唯一） | **只允许** `artifactVariant: "internal"`；且 sha256 / buildType / 来源必须齐全 |
 *
 * #601 事故的根因不是「清单里 internal 条目恰好 0 条」，而是**它当时可以出现**：
 * 一旦公网清单里能写 internal 条目，`file` 字段就等于把内部包的直链广播出去了（文件名不可猜毫无意义）。
 * 所以现在不是「恰好 0 条」，而是**不可能出现** —— 公网口径下 internal 条目是硬 FAIL。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// buildType 的唯一定义在 shared/build-types.mjs（Issue #330）——校验器不再自带一份数组。
import { BUILD_TYPES, isBuildType } from '../shared/build-types.mjs';
// 产物文件名前缀的唯一来源是 config/appIdentity.json 的 artifactPrefix（Issue #836）：
// 「file 与 version 同构」这条提示必须按当前前缀判，否则改名后每条新记录都会假告警。
import { LEGACY_ARTIFACT_PREFIXES } from '../shared/artifact-name.mjs';
import { artifactPrefix } from './lib/artifactName.mjs';

const RE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_MD5 = /^[0-9a-f]{32}$/;
const RE_FILE = /^apk\/[A-Za-z0-9._-]+\.apk$/;
const RE_RELEASED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const VARIANTS = ['internal', 'standard'];
const VARIANT_SOURCES = ['apk-manifest', 'sha256-allowlist'];

/** 清单口径：`public` = 公网 `releases.json`；`private` = 私有 `releases.internal.json` */
export const MANIFEST_MODES = Object.freeze(['public', 'private']);
/** 两种口径各自**唯一允许**的变体（裁决 #614 决定 3：#601 的病根是「可以出现」，不是「恰好 0 条」） */
export const MODE_VARIANT = Object.freeze({ public: 'standard', private: 'internal' });

/**
 * 校验一份 releases.json 的**对象**（不读文件、不退出）。
 *
 * 导出给 `scripts/publish-private-apk.mjs` 用：私有包写回前必须过同一份 schema，
 * 不许在发布脚本里再抄一份枚举（Issue #330 的教训：8 处各写一份，其中一处写成 "release"）。
 *
 * @param {unknown} data
 * @param {{mode?: 'public'|'private'}} [options] 默认 `public`（公网清单口径）
 * @returns {{errors:string[], warnings:string[], records:Array<object>, mode:string}}
 */
export function validate(data, options = {}) {
  const mode = options.mode ?? 'public';
  if (!MANIFEST_MODES.includes(mode)) throw new Error(`未知的清单口径：${mode}（只认 ${MANIFEST_MODES.join('|')}）`);
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    E('顶层必须是 JSON 对象');
    return { errors, warnings, records: [], mode };
  }
  if (typeof data.latest !== 'string' || !data.latest) E('缺少 latest（version 字符串）');
  if (!Array.isArray(data.releases) || !data.releases.length) {
    E('releases 必须是非空数组');
    return { errors, warnings, records: [], mode };
  }

  const seenVersion = new Set();
  const seenFile = new Set();
  let prevCode = Infinity;
  const records = [];

  data.releases.forEach((r, i) => {
    const at = `releases[${i}]${r && r.version ? `(${r.version})` : ''}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return E(`${at}: 必须是对象`);

    // version
    if (typeof r.version !== 'string' || !RE_VERSION.test(r.version)) {
      E(`${at}: version 不合法（要 x.y.z 或 x.y.z-suffix）: ${JSON.stringify(r.version)}`);
    } else {
      if (seenVersion.has(r.version)) E(`${at}: version 重复`);
      seenVersion.add(r.version);
    }

    // versionCode
    if (!Number.isInteger(r.versionCode) || r.versionCode <= 0) {
      E(`${at}: versionCode 必须是正整数: ${JSON.stringify(r.versionCode)}`);
    } else {
      if (r.versionCode > prevCode) E(`${at}: versionCode 必须严格降序（上一条 ${prevCode}，本条 ${r.versionCode}）`);
      prevCode = r.versionCode;
    }

    // releasedAt
    if (typeof r.releasedAt !== 'string' || !RE_RELEASED_AT.test(r.releasedAt) || Number.isNaN(Date.parse(r.releasedAt))) {
      E(`${at}: releasedAt 必须是 ISO8601 +08:00: ${JSON.stringify(r.releasedAt)}`);
    }

    // file
    if (typeof r.file !== 'string' || !RE_FILE.test(r.file)) {
      E(`${at}: file 必须是 apk/<name>.apk 相对路径: ${JSON.stringify(r.file)}`);
    } else {
      if (seenFile.has(r.file)) E(`${at}: file 重复`);
      seenFile.add(r.file);
      // 「file 与 version 同构」：标准包叫 `apk/<prefix>-<version>.apk`。前缀既可以是当前的
      // （config 的 artifactPrefix），也可以是**历史前缀** —— #836 之前的 12 个老包不改名，
      // 老条目的 file 保持原样（客户端按 file 下载）。私有包带变体与随机段，本就不同构，这里不判。
      if (typeof r.version === 'string') {
        const sameShape = [artifactPrefix()]
          .concat(LEGACY_ARTIFACT_PREFIXES)
          .some((prefix) => r.file === `apk/${prefix}-${r.version}.apk`);
        if (!sameShape) {
          W(`${at}: file 与 version 不同构（App 侧必须用 file 拼 URL，不能用 version）: ${r.file}`);
        }
      }
    }

    // size / md5
    if (!Number.isInteger(r.size) || r.size <= 0) E(`${at}: size 必须是正整数: ${JSON.stringify(r.size)}`);
    if (typeof r.md5 !== 'string' || !RE_MD5.test(r.md5)) E(`${at}: md5 必须是 32 位小写 hex`);

    // changes
    if (!Array.isArray(r.changes)) E(`${at}: changes 必须是数组`);
    else if (r.changes.some((c) => typeof c !== 'string' || !c.trim())) E(`${at}: changes 必须是非空字符串数组`);

    // buildType：公网清单里旧记录可能缺（warning，历史兼容）；私有清单是新契约，一律必填。
    // 只要写了就必须是枚举值 → 一律 FAIL。
    // 禁止把 Gradle 的 release/debug 写进来 —— 那是「构建类型」，buildType 是「发布渠道」
    // （Issue #330：2026-11-19 的 11 条 "release" 让客户端整份清单拒收）。
    if (r.buildType === undefined) {
      if (mode === 'private') E(`${at}: 私有清单的条目必须写 buildType（缺 = 客户端不知道是不是预发布）`);
      else W(`${at}: 缺 buildType（旧记录兼容，新发布必须写）`);
    } else if (!isBuildType(r.buildType)) {
      E(`${at}: buildType 只能是 ${BUILD_TYPES.join('|')}（发布渠道），收到 ${JSON.stringify(r.buildType)}`
        + '；release/debug 是 Gradle 构建类型，不是 buildType（正式发布写 stable）');
    }

    // breaking
    if (r.breaking !== undefined && typeof r.breaking !== 'boolean') E(`${at}: breaking 必须是布尔`);

    // sha256（新增，可选）
    if (r.sha256 !== undefined && (typeof r.sha256 !== 'string' || !RE_SHA256.test(r.sha256))) {
      E(`${at}: sha256 必须是 64 位小写 hex: ${JSON.stringify(r.sha256)}`);
    }

    // artifactVariant（新增，可选）
    if (r.artifactVariant !== undefined && !VARIANTS.includes(r.artifactVariant)) {
      E(`${at}: artifactVariant 只能是 ${VARIANTS.join('|')}: ${JSON.stringify(r.artifactVariant)}`);
    }
    // 口径互斥（Issue #609 / 裁决 #614 决定 3）：公网清单**不可能**出现 internal 条目，
    // 私有清单**不可能**出现 standard 条目。这不是「恰好 0 条」，是「出现即 FAIL」。
    if (mode === 'public' && r.artifactVariant === 'internal') {
      E(`${at}: 公网清单不得出现 internal 条目（#609）：私有包走独立私有清单（webroot 外），`
        + '公网清单里的 file 字段等于把内部包直链广播出去');
    }
    if (mode === 'private' && r.artifactVariant !== 'internal') {
      E(`${at}: 私有清单只收 artifactVariant="internal" 的条目，收到 ${JSON.stringify(r.artifactVariant ?? null)}`
        + '（standard 包走 GitHub Release，见裁决 #614 决定 2）');
    }
    // artifactVariantSource：与 artifactVariant 同存同缺
    if (r.artifactVariant !== undefined && r.artifactVariantSource === undefined) {
      E(`${at}: 有 artifactVariant 就必须有 artifactVariantSource（来源要留痕）`);
    }
    if (r.artifactVariantSource !== undefined) {
      if (!VARIANT_SOURCES.includes(r.artifactVariantSource)) {
        E(`${at}: artifactVariantSource 只能是 ${VARIANT_SOURCES.join('|')}: ${JSON.stringify(r.artifactVariantSource)}`);
      }
      if (r.artifactVariant === undefined) {
        E(`${at}: 有 artifactVariantSource 但没有 artifactVariant`);
      }
    }

    if (r.sha256 === undefined) {
      if (mode === 'private') E(`${at}: 私有清单的条目必须写 sha256（没有校验和 = 客户端不得安装）`);
      else W(`${at}: 缺 sha256 → App 侧不得自动/手动安装该版本`);
    }
    if (r.artifactVariant === undefined) {
      if (mode === 'private') E(`${at}: 私有清单的条目必须写 artifactVariant（缺 = 变体未知）`);
      else W(`${at}: 缺 artifactVariant → App 侧不得自动更新到该版本`);
    }

    records.push({
      version: r.version,
      installable: typeof r.sha256 === 'string' && RE_SHA256.test(r.sha256),
      recommendable:
        typeof r.sha256 === 'string' && RE_SHA256.test(r.sha256) && VARIANTS.includes(r.artifactVariant),
    });
  });

  // 顶部一致性：`latest` 必须等于 `releases[0].version`，两种口径都一样。
  //
  // #566 的 B 方案曾经在公网清单里为 internal 条目开过一个口子（头部 internal 时 latest 可以指向
  // 第一条公共记录）—— 那个口子的前提是「internal 条目会进公网清单」，而这正是 #601 泄漏事故的成因
  // （裁决 #614 决定 3）。现在 internal 条目在公网口径下直接 FAIL（见上面的口径互斥规则），
  // 口子失去意义，于是整条去掉：**少一条例外 = 少一处可以被利用的模糊地带**。
  const head = data.releases[0];
  if (typeof data.latest === 'string' && head) {
    if (data.latest !== head.version) {
      E(`latest(${data.latest}) 必须等于 releases[0].version(${head.version})`);
    }
  }
  const codes = data.releases.map((r) => (Number.isInteger(r && r.versionCode) ? r.versionCode : -1));
  const maxCode = Math.max(...codes);
  if (Number.isInteger(data.releases[0] && data.releases[0].versionCode) && data.releases[0].versionCode !== maxCode) {
    E(`releases[0] 的 versionCode(${data.releases[0].versionCode}) 不是最大值(${maxCode})`);
  }

  return { errors, warnings, records, mode };
}

/** CLI 入口：只在直接运行时跑（被 import 时只导出 validate） */
function main(argv) {
  const strict = argv.includes('--strict');
  const mode = argv.includes('--private') ? 'private' : 'public';
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('用法: node scripts/validate-releases-manifest.mjs <file.json>... [--strict] [--private]');
    process.exit(2);
  }

  let failed = 0;
  let warned = 0;

  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.log(`FAIL  ${path.basename(f)}  读取/解析失败: ${e.message}`);
      failed++;
      continue;
    }
    const { errors, warnings, records } = validate(data, { mode });
    const installable = records.filter((r) => r.installable).length;
    const recommendable = records.filter((r) => r.recommendable).length;

    if (errors.length) {
      failed++;
      console.log(`FAIL  ${path.basename(f)}  (${errors.length} error, ${warnings.length} warning)`);
      for (const m of errors) console.log(`        ✗ ${m}`);
    } else if (warnings.length && strict) {
      failed++;
      console.log(`FAIL(strict)  ${path.basename(f)}  (${warnings.length} warning)`);
      for (const m of warnings) console.log(`        ! ${m}`);
    } else {
      console.log(`PASS  ${path.basename(f)}  (${records.length} records, installable=${installable}, recommendable=${recommendable}, ${warnings.length} warning)`);
    }
    if (warnings.length && !(warnings.length && strict)) {
      warned++;
      for (const m of warnings.slice(0, 4)) console.log(`        ! ${m}`);
      if (warnings.length > 4) console.log(`        ! ...另有 ${warnings.length - 4} 条 warning`);
    }
  }

  console.log(
    `\n合计: ${files.length} 个文件, FAIL=${failed}, 有 warning=${warned}`
      + `${strict ? '（strict 模式）' : ''}（${mode === 'private' ? '私有清单口径' : '公网清单口径'}）`,
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
