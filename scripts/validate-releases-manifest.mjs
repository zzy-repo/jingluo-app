#!/usr/bin/env node
/**
 * releases.json 清单校验器（离线，零依赖）
 *
 * 用途：发布前 / 部署前校验 dl.rose7.cn/releases.json 的结构与新增字段契约，
 * 不联网、不碰线上文件，只在本地跑。
 *
 * 用法：
 *   node scripts/validate-releases-manifest.mjs <file.json> [...] [--strict]
 *
 * 退出码：0 = 全部通过（warning 不算失败）；1 = 有 FAIL
 * --strict：把 warning 也当失败（用于「新版本必须带 sha256 + artifactVariant」这种门禁）
 *
 * 契约字段（详见 docs/releases-manifest.md）：
 *   version / versionCode / releasedAt / file / size / md5 / changes / buildType / breaking
 *   + sha256（可选，新版本必须有）  artifactVariant（可选：internal|standard）
 *   + artifactVariantSource（有 artifactVariant 时必须给：apk-manifest|sha256-allowlist）
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('用法: node scripts/validate-releases-manifest.mjs <file.json>... [--strict]');
  process.exit(2);
}

const RE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_MD5 = /^[0-9a-f]{32}$/;
const RE_FILE = /^apk\/[A-Za-z0-9._-]+\.apk$/;
const RE_RELEASED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const BUILD_TYPES = ['stable', 'prerelease'];
const VARIANTS = ['internal', 'standard'];
const VARIANT_SOURCES = ['apk-manifest', 'sha256-allowlist'];

function validate(data) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    E('顶层必须是 JSON 对象');
    return { errors, warnings, records: [] };
  }
  if (typeof data.latest !== 'string' || !data.latest) E('缺少 latest（version 字符串）');
  if (!Array.isArray(data.releases) || !data.releases.length) {
    E('releases 必须是非空数组');
    return { errors, warnings, records: [] };
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
      if (typeof r.version === 'string' && r.file !== `apk/deepseek-chat-${r.version}.apk`) {
        W(`${at}: file 与 version 不同构（App 侧必须用 file 拼 URL，不能用 version）: ${r.file}`);
      }
    }

    // size / md5
    if (!Number.isInteger(r.size) || r.size <= 0) E(`${at}: size 必须是正整数: ${JSON.stringify(r.size)}`);
    if (typeof r.md5 !== 'string' || !RE_MD5.test(r.md5)) E(`${at}: md5 必须是 32 位小写 hex`);

    // changes
    if (!Array.isArray(r.changes)) E(`${at}: changes 必须是数组`);
    else if (r.changes.some((c) => typeof c !== 'string' || !c.trim())) E(`${at}: changes 必须是非空字符串数组`);

    // buildType（旧记录可能缺，算 warning）
    if (r.buildType === undefined) W(`${at}: 缺 buildType（旧记录兼容，新发布必须写）`);
    else if (!BUILD_TYPES.includes(r.buildType)) E(`${at}: buildType 只能是 ${BUILD_TYPES.join('|')}: ${JSON.stringify(r.buildType)}`);

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

    if (r.sha256 === undefined) W(`${at}: 缺 sha256 → App 侧不得自动/手动安装该版本`);
    if (r.artifactVariant === undefined) W(`${at}: 缺 artifactVariant → App 侧不得自动更新到该版本`);

    records.push({
      version: r.version,
      installable: typeof r.sha256 === 'string' && RE_SHA256.test(r.sha256),
      recommendable:
        typeof r.sha256 === 'string' && RE_SHA256.test(r.sha256) && VARIANTS.includes(r.artifactVariant),
    });
  });

  // 顶部一致性
  if (typeof data.latest === 'string' && data.releases[0] && data.releases[0].version !== data.latest) {
    E(`latest(${data.latest}) 必须等于 releases[0].version(${data.releases[0].version})`);
  }
  const codes = data.releases.map((r) => (Number.isInteger(r && r.versionCode) ? r.versionCode : -1));
  const maxCode = Math.max(...codes);
  if (Number.isInteger(data.releases[0] && data.releases[0].versionCode) && data.releases[0].versionCode !== maxCode) {
    E(`releases[0] 的 versionCode(${data.releases[0].versionCode}) 不是最大值(${maxCode})`);
  }

  return { errors, warnings, records };
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
  const { errors, warnings, records } = validate(data);
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

console.log(`\n合计: ${files.length} 个文件, FAIL=${failed}, 有 warning=${warned}${strict ? '（strict 模式）' : ''}`);
process.exit(failed ? 1 : 0);
