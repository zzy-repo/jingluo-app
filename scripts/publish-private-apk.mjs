#!/usr/bin/env node
/**
 * publish-private-apk.mjs —— 私有（internal）包发布 + 四条硬闸（Issue #609 / 裁决 #614 决定 3）
 *
 * ## 前置结论（#595 的前提是错的，本文件按 #609 重写）
 *
 * #595 把私有包写进**公网** `releases.json`，靠「文件名不可猜测」保护。这个前提已被 #601 否证：
 * 清单本身就是公开的（`GET /releases.json` → 200），文件名直接躺在里面 —— 一点都不可猜。
 * 2026-11-20 22:14 那次泄漏，就是「进了公网清单 + 文件在 `/apk/`」两件凑齐。
 *
 * 所以现在：
 *   - 私有包**绝不进公网清单**，改走**独立私有清单**（默认 `<private-root>/releases.internal.json`），
 *     私有根默认 `/opt/dl-private/`（**webroot 之外**，公网 file_server 够不着），包在 `<private-root>/apk/` 下；
 *     线上实况（#621 收尾，**以线上为准**）：`DL_PRIVATE_ROOT=/opt/dl-private`、
 *     `DL_PRIVATE_APK_DIR=/opt/dl-private/apk`、`DL_PRIVATE_RELEASES_JSON=/var/www/dl-private/releases.internal.json`
 *     —— 清单与包目录**不在同一个目录**，所以清单路径另有开关 `--private-manifest`
 *     （env `DL_PRIVATE_RELEASES_JSON`，与 `deploy/dl-release/server.mjs` 同名同义）；
 *   - 公网 `releases.json` 只允许 `artifactVariant === 'standard'` 且 `buildType === 'stable'`
 *     （校验器与这里的 G1 各拦一次，`scripts/validate-releases-manifest.mjs` 的 public 口径）；
 *   - 客户端取用方式（内置开关）见 docs/RELEASE-MANUAL.md §14：internal 变体在构建期带
 *     `DL_PRIVATE_MANIFEST`，从私有清单取更新；standard 包不含该开关。
 *
 * ## 四条硬闸（**写之前就拒**，一个字节都不发）
 *
 * | 闸 | 判据 | 拒绝时 |
 * | --- | --- | --- |
 * | G1 目标/变体 | 公网清单 + `artifactVariant !== 'standard'`（或 `buildType !== 'stable'`）；私有清单 + 非 internal | exit 1 |
 * | G2 回环 baseUrl | **APK 字节里**读出的 `consume.baseUrl` 是回环（127.0.0.1 / localhost / ::1 / 127/8） | exit 1 |
 * | G3 清单自洽 | 合入后清单登记的 `file` 在目标 `apk/` 下**不存在**（清单指向不存在的文件） | exit 1 |
 * | G4 孤儿文件 | 目标 `apk/` 下有 `deepseek-chat-*.apk` 却**没登记**在清单里（含调用方自己的残留） | exit 1 |
 *
 * 四条都是「判据来自产物/磁盘实况，不来自命令行声明」。#601 的教训正是：`--variant internal`
 * 只说明操作者的意图，APK 里 `consume.baseUrl=127.0.0.1` 才是事实。
 *
 * ## 用法
 *
 *   # 演练（只读本地目录 / 只读远端，不落地）：四条闸都真跑
 *   node scripts/publish-private-apk.mjs --apk app-release.apk --version 1.4.3 --versionCode 22 --dry-run
 *
 *   # 本地演练通道（L0/CI 用；不碰任何机器，也不许真发布）
 *   node scripts/publish-private-apk.mjs --transport local --private-root /tmp/x \
 *     --apk /tmp/fake.apk --version 1.4.3 --versionCode 22 --dry-run
 *
 *   # 真发布（写私有清单；默认 ssh aliyun）
 *   node scripts/publish-private-apk.mjs --apk app-release.apk --version 1.4.3 --versionCode 22
 *
 * 参数（全部可用环境变量给，见 `--help`）：
 *   --target private|public   默认 private。public 只允许 standard + stable（G1）
 *   --private-root <dir>      默认 /opt/dl-private（**必须不在 webroot 内**，G1 会核）
 *   --private-manifest <p>    默认 <private-root>/releases.internal.json（env DL_PRIVATE_RELEASES_JSON）
 *   --webroot <dir>           默认 /var/www/dl（公网站点根）；`--site-root` 是它的旧名
 *   --transport ssh|local     默认 ssh。`local` 只读本机目录、只允许 --dry-run（演练用）
 *   --apk/--version/--versionCode/--variant/--changes/--dry-run/--exercise/--force/--ssh-host/--aapt2
 *
 * 退出码：0 成功（含 dry-run / 演练回滚干净）；1 校验或执行失败（含四条硬闸）；2 环境/参数问题
 *
 * 设计原则（沿用 §0）：
 *   - **不做「跑到一半」的自动化**：真上传前把所有能本地判定的判完，判不过就退出，一个字节都不发；
 *   - **不猜**：判不出来的（aapt2 缺失、consume.baseUrl 读不到、清单读不到）一律按失败处理，
 *     不许「先发后修」——G2 的「读不到」就是拒绝，不是跳过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_APK_BYTES,
  PACKAGE_NAME,
  RE_VERSION,
  buildTypeFor,
  hashFile,
  log,
  parseArgs,
  VARIANT_META_NAME,
} from './release-common.mjs';
// schema 校验只有一份实现（Issue #330）：这里 import 校验器本体，不再写第二份枚举
import { validate as validateReleasesSchema } from './validate-releases-manifest.mjs';
// 变体标记的解析只有一份实现：aapt2 dump xmltree 的输出由它来判
import { parseVariantFromXmltree } from '../deploy/dl-release/variant.mjs';
// consume.baseUrl 的取证（Issue #609 G2）：读 APK 字节，不读命令行、不读 config
import { inspectConsumeBase, judgeConsumeBase } from '../deploy/dl-release/apk-consume.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 清单里允许的变体（与 deploy/dl-release/variant.mjs、校验器同口径） */
export const VARIANTS = Object.freeze(['internal', 'standard']);
/** 目标清单口径（#609）：公网清单 / 私有清单，各自只收一种变体 */
export const TARGETS = Object.freeze(['private', 'public']);
/** 每种目标**唯一允许**的变体（= scripts/validate-releases-manifest.mjs 的 MODE_VARIANT） */
export const TARGET_VARIANT = Object.freeze({ private: 'internal', public: 'standard' });
/** 公网清单只收 stable（裁决 #614 决定 2/3：dl 不再是正式渠道，只留 standard 历史条目） */
export const PUBLIC_ALLOWED_BUILD_TYPES = Object.freeze(['stable']);
/** 文件名前缀：与既有的 19 个 APK 同构（`apk/<prefix>-<version>...apk`） */
export const FILE_PREFIX = 'deepseek-chat';
/** DL 主机：`ssh aliyun`（Tailscale 内网，公网 22 打不通） */
export const DEFAULT_SSH_HOST = 'aliyun';
/** 公网站点根（webroot）：Caddy 本地直服（/var/www/dl/releases.json、/var/www/dl/apk/*.apk） */
export const DEFAULT_WEBROOT = '/var/www/dl';
/**
 * 私有根：**故意在 webroot 之外** —— 公网 file_server 够不着（#609 的核心）。
 * 默认值与线上对齐（#621 收尾，以线上为准）：生产 `DL_PRIVATE_ROOT=/opt/dl-private`。
 * env `DL_PRIVATE_ROOT` 可覆盖；`--private-manifest`（env `DL_PRIVATE_RELEASES_JSON`）
 * 单独管清单路径，因为线上清单不在私有根下。
 */
export const DEFAULT_PRIVATE_ROOT = '/opt/dl-private';
/** 两种清单的文件名 */
export const PUBLIC_MANIFEST_NAME = 'releases.json';
export const PRIVATE_MANIFEST_NAME = 'releases.internal.json';
/** 对外基址（只有公网目标用它拼直链） */
export const DEFAULT_PUBLIC_BASE = 'https://dl.rose7.cn/';
/** APK 子目录（清单里的 `file` 是 `apk/<name>.apk` 相对路径） */
export const APK_SUBDIR = 'apk';
/** 传输方式：ssh（真发布）/ local（**只读本机目录**，仅供演练与 L0/CI） */
export const TRANSPORTS = Object.freeze(['ssh', 'local']);
/** 不可猜测文件名的随机段：5 字节 = 40 bit = 8 个 base32 字符 */
export const RANDOM_BYTES = 5;
export const RANDOM_CHARS = 8;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 演练用的假版本号前缀（只有 `0.0.0` 开头才允许 --exercise，除非 --force） */
const FAKE_VERSION_RE = /^0\.0\.0(?:-|$)/;
/** APK 下载时的 Content-Type（Caddy 由 mime 表给，实测如此） */
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';
/** 目标 apk/ 下「本仓产物」的文件名形态（G4 只看这些，别把人家放的 README 当孤儿） */
const ARTIFACT_FILE_RE = new RegExp(`^${APK_SUBDIR}/${FILE_PREFIX}-[A-Za-z0-9._-]+\\.apk$`);

/** 参数/环境不满足 → exit 2（不是发布失败，是还没开始就做不了） */
export class PublishEnvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishEnvError';
    this.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// 纯函数区（可单测，不碰网络、不碰磁盘）
// ---------------------------------------------------------------------------

/**
 * 不可猜测的随机段：**必须**来自 crypto.randomBytes，不许用时间戳/进程号
 * （时间戳可枚举：知道大致发布时间就能把 36^8 的搜索空间压成几百万）。
 *
 * ⚠️ 自 #609 起这条**不再承担任何保密职责**：私有包不进公网清单，也就不存在
 * 「顺着清单猜 URL」这回事（清单里本来就没有它）。保留随机段只是为了
 * ①同一版本重发不撞名 ②仓库里历史文件名继续可用。别再把「不可猜」当安全边界。
 *
 * @param {number} bytes 随机字节数；默认 5 → 40 bit → 8 个 base32 字符
 * @returns {string} 8 个 base32 字符（A-Z2-7，无易混字符 0/1）
 */
export function randomSuffix(bytes = RANDOM_BYTES) {
  if (!Number.isInteger(bytes) || bytes < 4) throw new PublishEnvError('随机段至少要 4 字节（32 bit）');
  const buf = crypto.randomBytes(bytes);
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/**
 * 生成文件名（不含目录）：`deepseek-chat-<version>-<variant>-<8位随机>.apk`
 * @param {{version:string, variant:string, suffix:string}} p
 */
export function buildFileName({ version, variant, suffix }) {
  if (!RE_VERSION.test(String(version))) throw new PublishEnvError(`version 格式非法：${version}`);
  if (!VARIANTS.includes(variant)) throw new PublishEnvError(`variant 只能是 ${VARIANTS.join('|')}：${variant}`);
  if (!/^[A-Z2-7]{8}$/.test(String(suffix))) throw new PublishEnvError(`随机段必须正好 8 个 base32 字符：${suffix}`);
  return `${FILE_PREFIX}-${version}-${variant}-${suffix}.apk`;
}

/** 清单里的 file 字段（相对目标根的路径，与既有 19 条同构） */
export function fileField(fileName) {
  return `${APK_SUBDIR}/${fileName}`;
}

/**
 * ISO8601 +08:00 时间戳（校验器要求 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$`）
 * @param {Date} [date]
 */
export function shanghaiTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

/**
 * 构造清单条目。字段顺序与线上既有条目一致（人读 diff 时最省事），
 * `buildType` 由版本号决定（`shared/build-types.mjs` 是唯一判定来源）。
 */
export function buildEntry({ version, versionCode, variant, fileName, size, md5, sha256, changes, releasedAt }) {
  return {
    version,
    versionCode,
    releasedAt: releasedAt || shanghaiTimestamp(),
    file: fileField(fileName),
    size,
    md5,
    sha256,
    changes:
      Array.isArray(changes) && changes.length
        ? changes
        : [`私有（${variant}）构建 ${version}（versionCode ${versionCode}）：仅内测渠道分发，公网清单不含本条`],
    buildType: buildTypeFor(version),
    breaking: false,
    artifactVariant: variant,
    artifactVariantSource: 'apk-manifest',
  };
}

/**
 * 把条目并进清单。
 *
 * 两种目标的 `latest` 语义**相反**，这是本脚本最容易写错的一处：
 *   - `public`：`latest` **原样带过**（公网清单只收 standard+stable，且 dl 不再是正式渠道 ——
 *     改 latest 等于对外宣布一个新正式版，这件事只能由 GitHub Release 流程做）；
 *   - `private`：`latest` **必须**跟着变（私有清单里的「最新内测版」就是刚发的那条，
 *     客户端靠它 + `versionCode` 取更新）。
 *
 * @param {{latest:string, releases:object[]}} manifest
 * @param {object} entry
 * @param {{updateLatest?: boolean}} [opts]
 */
export function mergeEntry(manifest, entry, opts = {}) {
  if (!manifest || typeof manifest !== 'object') throw new PublishEnvError('目标清单不是对象');
  if (!Array.isArray(manifest.releases)) throw new PublishEnvError('目标清单没有 releases 数组');
  const version = String(entry.version);
  const variant = entry.artifactVariant;
  const kept = manifest.releases.filter(
    (r) => !(r && String(r.version) === version && (r.artifactVariant ?? null) === (variant ?? null)),
  );
  const at = kept.findIndex((r) => Number(r.versionCode) < Number(entry.versionCode));
  const releases = at < 0 ? [...kept, entry] : [...kept.slice(0, at), entry, ...kept.slice(at)];
  const updateLatest = opts.updateLatest === true || manifest.latest === undefined;
  return { ...manifest, latest: updateLatest ? releases[0].version : manifest.latest, releases };
}

/**
 * 写回前的自检（比校验器更严的那几条「本脚本特有」的约束）：
 *   1. `latest` 语义正确（public 逐字节不变 / private = 头部那条）；
 *   2. 发布前的每一条既有记录**原样还在**（不许顺手改别人）；
 *   3. 合并后的整份清单仍满足**对应口径**的 schema（复用脚本，不另写枚举）；
 *   4. 新条目真的在清单里，且 sha256/size/file 与本次产物一致。
 *
 * @returns {{errors:string[], warnings:string[]}}
 */
export function verifyMerge({ before, after, entry, target = 'private' }) {
  const errors = [];
  const warnings = [];
  const label = target === 'public' ? '公网清单' : '私有清单';

  if (target === 'public') {
    if (after.latest !== before.latest) {
      errors.push(
        `latest 被改了：发布前 ${JSON.stringify(before.latest)} → 发布后 ${JSON.stringify(after.latest)}` +
          '（公网清单的 latest 只能由正式发布流程改；dl 不再是正式渠道，见裁决 #614 决定 2）',
      );
    }
  } else if (after.latest !== after.releases[0].version) {
    errors.push(`私有清单的 latest(${JSON.stringify(after.latest)}) 必须等于 releases[0].version(${after.releases[0].version})`);
  }

  for (const old of before.releases) {
    const still = after.releases.find(
      (r) => r && r.version === old.version && (r.artifactVariant ?? null) === (old.artifactVariant ?? null),
    );
    if (!still) {
      errors.push(`既有条目丢了：${old.version}${old.artifactVariant ? `（${old.artifactVariant}）` : ''}`);
      continue;
    }
    if (JSON.stringify(still) !== JSON.stringify(old)) {
      errors.push(`既有条目被改了：${old.version}${old.artifactVariant ? `（${old.artifactVariant}）` : ''}`);
    }
  }

  const added = after.releases.find((r) => r && r.version === entry.version && r.artifactVariant === entry.artifactVariant);
  if (!added) {
    errors.push(`新条目没进清单：${entry.version}（${entry.artifactVariant}）`);
  } else {
    if (added.sha256 !== entry.sha256) errors.push(`新条目 sha256 与产物不一致：${added.sha256} != ${entry.sha256}`);
    if (added.size !== entry.size) errors.push(`新条目 size 与产物不一致：${added.size} != ${entry.size}`);
    if (added.file !== entry.file) errors.push(`新条目 file 与预期不一致：${added.file} != ${entry.file}`);
  }

  const { errors: schemaErrors, warnings: schemaWarnings } = validateReleasesSchema(after, { mode: target });
  errors.push(...schemaErrors.map((m) => `${label} schema：${m}`));
  warnings.push(...schemaWarnings);

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// 四条硬闸（纯函数：输入是「产物 / 磁盘实况」，不是命令行声明）
// ---------------------------------------------------------------------------

/**
 * G1 —— 目标清单 × 变体 × 发布渠道。
 *
 * 裁决 #614 决定 3：「公网 `releases.json` 出现 `artifactVariant!=='standard'` 或
 * `buildType!=='stable'` → 门禁红」。这里是**写之前**的那一道（门禁是写之后的那一道），
 * 两道都要有：门禁只在你想起跑它的时候才拦得住，发布脚本是每次都会走的。
 *
 * @returns {string[]} 错误列表（空 = 通过）
 */
export function gateTargetVariant({ target, variant, buildType, webroot, privateRoot }) {
  const errors = [];
  if (!TARGETS.includes(target)) return [`G1 目标必须是 ${TARGETS.join('|')}：${JSON.stringify(target)}`];

  const only = TARGET_VARIANT[target];
  if (variant !== only) {
    errors.push(
      `G1 目标清单只允许 ${only} 变体，本次是 ${JSON.stringify(variant)}（target=${target}）` +
        (target === 'public'
          ? '：私有（internal）包绝不进公网清单（#609 / #601 事故形态）'
          : '：私有清单只收 internal 包，standard 走 GitHub Release（裁决 #614 决定 2）'),
    );
  }
  if (target === 'public' && !PUBLIC_ALLOWED_BUILD_TYPES.includes(buildType)) {
    errors.push(
      `G1 公网清单只允许 ${PUBLIC_ALLOWED_BUILD_TYPES.join('|')} 渠道，本次 buildType=${JSON.stringify(buildType)}` +
        `（由版本号决定；要发预发布版请走 GitHub Release 的 prerelease 资产）`,
    );
  }
  // 私有根必须在 webroot 之外 —— 否则公网 file_server 照样能把内部包发出去，
  // 「清单里没有」就白搭了（#601 的第 4 类口子）。
  if (target === 'private' && privateRoot && webroot) {
    const from = path.resolve(webroot);
    const to = path.resolve(privateRoot);
    const inside = to === from || to.startsWith(`${from}${path.sep}`);
    if (inside) {
      errors.push(
        `G1 私有根 ${to} 在 webroot ${from} 内：webroot 里的文件会被公网 file_server 直出，` +
          '私有包必须放在 webroot 之外（默认 /opt/dl-private）',
      );
    }
  }
  return errors;
}

/**
 * G2 —— APK 字节里的 `consume.baseUrl` 是回环 → 拒绝。
 *
 * #601 事故的包在任何真机上都连不上后端（`127.0.0.1` 指向手机自己），只能配 `adb reverse` 联调。
 * 这种包**绝不该进任何分发通道**，哪怕只是 internal。判据取自 APK 里真实编译进去的字节：
 * 读不到也算失败（判不出来就不发）。
 *
 * @param {{ok:boolean, message:string, loopback:string[]}} judgement `judgeConsumeBase()` 的输出
 * @returns {string[]}
 */
export function gateLoopbackConsume(judgement) {
  if (!judgement) return ['G2 拿不到 consume.baseUrl 的取证结果（内部错误：没有调用 inspectConsumeBase）'];
  if (judgement.ok) return [];
  return [`G2 ${judgement.message}`];
}

/**
 * G3 —— 清单与文件自洽：清单登记的每个 `file` 必须真的在目标的 `apk/` 下。
 *
 * 「清单指向不存在的文件」是 #601 那次事故的另一半症状（清单短暂广播了一个 404 的版本）。
 * 公网侧同一个病还更糟：客户端拿到清单 → 下载 404 → 用户以为是网络问题。
 *
 * @param {{manifest:object, presentFiles:string[], planned?:string}} p
 *   `presentFiles` 是 `apk/<name>.apk` 形式的现有文件；`planned` 是本次要上传的那一条（豁免）
 * @returns {string[]}
 */
export function gateManifestSelfConsistency({ manifest, presentFiles, planned = null }) {
  const errors = [];
  const have = new Set(presentFiles);
  const missing = [];
  for (const r of manifest?.releases ?? []) {
    if (!r || typeof r.file !== 'string') continue;
    if (r.file === planned) continue; // 本次要上传的包：现在当然还不在，上传后由 verifyLive 复核
    if (!have.has(r.file)) missing.push(`${r.version}${r.artifactVariant ? `（${r.artifactVariant}）` : ''} → ${r.file}`);
  }
  if (missing.length) {
    errors.push(
      `G3 清单登记的 ${missing.length} 个文件不在目标 apk/ 下（清单指向不存在的文件）：\n` +
        missing.slice(0, 8).map((m) => `      · ${m}`).join('\n') +
        (missing.length > 8 ? `\n      · ……另有 ${missing.length - 8} 条` : ''),
    );
  }
  return errors;
}

/**
 * G4 —— 孤儿文件：目标 `apk/` 下有本仓产物（`apk/deepseek-chat-*.apk`）却没登记在清单里。
 *
 * 为什么是**拒绝**而不是警告：#601 的处置经验是「光从清单里删掉不够，文件必须移出 webroot」
 * —— 只要文件还在那儿，任何知道/猜到 URL 的人都能下载（静态目录不看清单）。
 * 所以「有文件、没条目」= 已经泄漏了一半，必须在发布前清掉（或补登记）。
 *
 * @param {{manifest:object, presentFiles:string[], planned?:string}} p
 * @returns {string[]}
 */
export function gateOrphanFiles({ manifest, presentFiles, planned = null }) {
  const registered = new Set((manifest?.releases ?? []).map((r) => r && r.file).filter(Boolean));
  if (planned) registered.add(planned);
  const orphans = presentFiles.filter((f) => ARTIFACT_FILE_RE.test(f) && !registered.has(f));
  if (!orphans.length) return [];
  return [
    `G4 目标 apk/ 下有 ${orphans.length} 个孤儿文件（有文件、清单没登记 → 等于已经泄漏了一半）：\n` +
      orphans.slice(0, 8).map((f) => `      · ${f}`).join('\n') +
      (orphans.length > 8 ? `\n      · ……另有 ${orphans.length - 8} 个` : '') +
      '\n      处置：移出该目录（`mv` 到 webroot/私有根之外）或补登进清单',
  ];
}

/**
 * 目标路径（manifest / apk 目录 / 根）。
 *
 * 私有一侧的两个路径**分开算**（#621 收尾）：线上 `DL_PRIVATE_ROOT=/opt/dl-private`（包目录在
 * `/opt/dl-private/apk`）而清单在 `/var/www/dl-private/releases.internal.json` —— 一个 `--private-root`
 * 拼不出线上布局，所以清单路径可由 `privateManifest`（`--private-manifest` / env
 * `DL_PRIVATE_RELEASES_JSON`）单独指定，缺省仍回落 `<private-root>/releases.internal.json`。
 * @param {{target:string, webroot:string, privateRoot:string, privateManifest?:string}} opts
 */
export function targetPaths(opts) {
  const target = opts.target ?? 'private';
  if (target === 'public') {
    const root = opts.webroot ?? DEFAULT_WEBROOT;
    return {
      target,
      root,
      manifestPath: `${root}/${PUBLIC_MANIFEST_NAME}`,
      apkDir: `${root}/${APK_SUBDIR}`,
      label: `公网清单 ${root}/${PUBLIC_MANIFEST_NAME}（webroot 内，公网可读）`,
      publiclyReadable: true,
    };
  }
  const root = opts.privateRoot ?? DEFAULT_PRIVATE_ROOT;
  const manifestPath = opts.privateManifest || `${root}/${PRIVATE_MANIFEST_NAME}`;
  return {
    target,
    root,
    manifestPath,
    apkDir: `${root}/${APK_SUBDIR}`,
    label: `私有清单 ${manifestPath}（webroot 之外，带令牌的端点才提供）`,
    publiclyReadable: false,
  };
}

/**
 * 解析 `aapt2 dump badging` 的首行（package / versionCode / versionName）
 * @param {string} text
 */
export function parseBadging(text) {
  const lines = String(text).split('\n');
  const first = lines.find((l) => l.trimStart().startsWith('package:')) || '';
  const grab = (re) => {
    const m = re.exec(first);
    return m ? m[1] : null;
  };
  const rawCode = grab(/versionCode='([^']*)'/);
  return {
    packageName: grab(/name='([^']*)'/),
    // 解析不出来必须是 null（调用方按「没测到」处理），不许变成 0 蒙过去
    versionCode: rawCode === null || !/^\d+$/.test(rawCode) ? null : Number(rawCode),
    versionName: grab(/versionName='([^']*)'/),
    debuggableLines: lines.filter((l) => l.includes('application-debuggable')).length,
  };
}

/** 把 errors 汇总成可读的一段并退出（exit 1 = 校验/执行失败，含四条硬闸） */
function die(errors, hint) {
  console.error('\n发布中止（一个字节都没有发出去）：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

/** 环境/参数不满足：exit 2 */
function dieEnv(message) {
  console.error(`\n环境/参数不满足，未开始发布：\n  ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 外部命令（ssh / scp / curl / aapt2）
// ---------------------------------------------------------------------------

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

function run(bin, argv, opts = {}) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, input: opts.input });
  if (r.error) throw new CliError(`${bin} 跑不起来：${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().slice(0, 800);
    throw new CliError(`${bin} ${argv.join(' ')} 失败（exit=${r.status}）${detail ? `：\n${detail}` : ''}`);
  }
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sshExec(host, script) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, script]);
}

function scpTo(host, localFile, remotePath) {
  return run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', localFile, `${host}:${remotePath}`], {
    timeout: 300_000,
  });
}

/** 找 aapt2：显式 → $AAPT2 → $ANDROID_HOME → ~/android-sdk → PATH */
export function findAapt2(explicit) {
  const candidates = [];
  const push = (p) => p && candidates.push(p);
  push(explicit);
  push(process.env.AAPT2);
  for (const home of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'android-sdk')]) {
    if (!home) continue;
    const dir = path.join(String(home), 'build-tools');
    try {
      for (const v of fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        push(path.join(dir, v, 'aapt2'));
      }
    } catch {
      /* 没这个 SDK 目录就跳过 */
    }
  }
  const onPath = spawnSync('sh', ['-c', 'command -v aapt2'], { encoding: 'utf8' });
  if (onPath.status === 0) push(onPath.stdout.trim());
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* 权限之类，继续下一个 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// APK 校验（任一不符直接退出）
// ---------------------------------------------------------------------------

/**
 * @returns {{ok:boolean, errors:string[], facts:object}}
 */
export function validateApk({ apk, version, versionCode, variant, aapt2 }) {
  const errors = [];
  const facts = {
    aapt2: aapt2 || null,
    packageName: null,
    versionCode: null,
    versionName: null,
    debuggable: null,
    variant: null,
    variantReason: null,
  };

  if (!aapt2) {
    return {
      ok: false,
      errors: [
        '找不到 aapt2（$AAPT2 / $ANDROID_HOME/build-tools/<ver>/aapt2 都没有）；用 --aapt2 指定，或演练时加 --skip-apk-validation',
      ],
      facts,
    };
  }

  let badging;
  try {
    badging = run(aapt2, ['dump', 'badging', apk]).stdout;
  } catch (e) {
    return { ok: false, errors: [`aapt2 dump badging 失败（不是合法 APK？）：${e.message}`], facts };
  }
  const parsed = parseBadging(badging);
  facts.packageName = parsed.packageName;
  facts.versionCode = parsed.versionCode;
  facts.versionName = parsed.versionName;
  facts.debuggable = parsed.debuggableLines !== 0;

  if (parsed.packageName !== PACKAGE_NAME) errors.push(`包名不符：APK 里是 ${parsed.packageName}，要求 ${PACKAGE_NAME}`);
  if (parsed.versionCode !== Number(versionCode)) {
    errors.push(`versionCode 不符：APK 里是 ${parsed.versionCode}，--versionCode 给的是 ${versionCode}`);
  }
  if (parsed.versionName !== String(version)) {
    errors.push(`versionName 不符：APK 里是 ${JSON.stringify(parsed.versionName)}，--version 给的是 ${version}`);
  }
  if (parsed.debuggableLines !== 0) errors.push('APK 是 debuggable 构建（application-debuggable 出现）——发布完整性的硬门禁，绝对不发');

  let xmltree = '';
  try {
    xmltree = run(aapt2, ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']).stdout;
  } catch (e) {
    errors.push(`aapt2 dump xmltree 失败（读不到变体标记）：${e.message}`);
  }
  if (xmltree) {
    const v = parseVariantFromXmltree(xmltree, VARIANT_META_NAME);
    facts.variant = v.variant;
    facts.variantReason = v.reason;
    if (!v.variant) {
      errors.push(
        `APK 里读不到变体标记 ${VARIANT_META_NAME}（reason=${v.reason}）——` +
          `重新出包：./gradlew assembleRelease -PartifactVariant=${variant}`,
      );
    } else if (v.variant !== variant) {
      errors.push(`变体标记不符：APK 里是 ${v.variant}，--variant 给的是 ${variant}`);
    }
  }

  return { ok: errors.length === 0, errors, facts };
}

// ---------------------------------------------------------------------------
// 目标状态读取（ssh / local 两种传输）
// ---------------------------------------------------------------------------

/**
 * 读目标清单 + 目标 apk/ 下的文件清单。
 *
 * 两种传输**只差在「怎么读」**，判据完全一致（这是 L0/CI 能用本地临时目录做正反演练的前提）：
 *   · `ssh`   —— `cat` 清单 + `ls -1` 目录（真发布与真发布前的 dry-run）；
 *   · `local` —— 直接读本机目录（**只允许 --dry-run**，见 parseCli）。
 *
 * 「目录不存在」与「读不到」是两件事：前者对私有根是**合法**的第一次发布（返回空），
 * 后者一律失败（不猜）。
 *
 * @returns {{ok:boolean, manifestText:string|null, manifestSha:string|null, presentFiles:string[], errors:string[]}}
 */
export function readTargetState({ transport, sshHost, target, allowMissingRoot }) {
  const errors = [];
  const present = [];
  let manifestText = null;
  let manifestSha = null;

  if (transport === 'local') {
    // 目录缺 = 第一次发布（私有根）；公网 webroot 缺 → 不猜，直接报错
    if (!fs.existsSync(target.root) && !allowMissingRoot) {
      errors.push(`目标根不存在：${target.root}（公网/私有根缺失时拒绝发布 —— 不猜「大概是空的」）`);
    }
    if (fs.existsSync(target.apkDir)) {
      for (const name of fs.readdirSync(target.apkDir).sort()) {
        present.push(`${APK_SUBDIR}/${name}`);
      }
    }
    if (fs.existsSync(target.manifestPath)) {
      const buf = fs.readFileSync(target.manifestPath);
      manifestText = buf.toString('utf8');
      manifestSha = crypto.createHash('sha256').update(buf).digest('hex');
    }
    return { ok: errors.length === 0, manifestText, manifestSha, presentFiles: present, errors };
  }

  // ssh：一次连接把三件事问完（清单 sha / 目录是否存在 / 目录里的文件名）
  const script = [
    `if test -r ${quote(target.manifestPath)}; then sha256sum ${quote(target.manifestPath)}; else echo NO_MANIFEST; fi`,
    `if test -d ${quote(target.apkDir)}; then echo APKDIR_OK; ls -1 ${quote(target.apkDir)}; else echo NO_APKDIR; fi`,
  ].join('; ');
  let out;
  try {
    out = sshExec(sshHost, script).stdout;
  } catch (e) {
    errors.push(`连不上 ${sshHost} 或读不到目标状态：${e.message}`);
    return { ok: false, manifestText, manifestSha, presentFiles: present, errors };
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const rootExists = lines.includes('APKDIR_OK');
  if (!rootExists && !allowMissingRoot) {
    errors.push(`目标根不存在或 apk/ 目录缺失：${target.apkDir}（缺失时拒绝发布 —— 不猜「大概是空的」）`);
  }
  let inList = false;
  for (const line of lines) {
    if (line === 'APKDIR_OK') {
      inList = true;
      continue;
    }
    if (line === 'NO_APKDIR' || line === 'NO_MANIFEST') continue;
    if (!inList) {
      // 第一行是 sha256sum 输出（`<sha>  <path>`）
      const m = /^([0-9a-f]{64})\s+/.exec(line);
      if (m) manifestSha = m[1];
      continue;
    }
    present.push(`${APK_SUBDIR}/${line}`);
  }
  if (manifestSha) {
    try {
      manifestText = sshExec(sshHost, `cat ${quote(target.manifestPath)}`).stdout;
    } catch (e) {
      errors.push(`读不到目标清单 ${target.manifestPath}：${e.message}`);
    }
  }
  return { ok: errors.length === 0, manifestText, manifestSha, presentFiles: present, errors };
}

// ---------------------------------------------------------------------------
// 发布主流程
// ---------------------------------------------------------------------------

function help() {
  console.log(
    [
      '私有（internal）包发布：node scripts/publish-private-apk.mjs --apk <path> --version <x.y.z> --versionCode <n>',
      '',
      '  --apk <path>           必填（DL_PRIVATE_APK）',
      '  --version <x.y.z>      必填（DL_PRIVATE_VERSION）',
      '  --versionCode <n>      必填（DL_PRIVATE_VERSION_CODE）',
      '  --variant <v>          internal（默认）| standard（DL_PRIVATE_VARIANT）',
      '  --target <t>           private（默认）| public（DL_PRIVATE_TARGET）',
      '  --private-root <dir>   /opt/dl-private（DL_PRIVATE_ROOT）；必须在 webroot 之外',
      '  --private-manifest <p> <private-root>/releases.internal.json（DL_PRIVATE_RELEASES_JSON）；',
      '                         线上是 /var/www/dl-private/releases.internal.json（不在私有根下）',
      '  --webroot <dir>        /var/www/dl（DL_PRIVATE_WEBROOT）；--site-root 是它的旧名',
      '  --transport <t>        ssh（默认）| local（只读本机目录，仅 --dry-run）（DL_PRIVATE_TRANSPORT）',
      '  --changes <text>       清单 changes 条目，可重复',
      '  --dry-run              只打印动作与清单条目，不落地（默认是真发布）',
      '  --exercise             真上传 + 真加清单条目 + 立刻全量回滚（要求 version 形如 0.0.0）',
      '  --skip-apk-validation  仅演练：跳过 aapt2 校验（仍会跑 G2，除非连 APK 都读不了）',
      '  --force                演练时允许非 0.0.0 版本（危险）',
      '  --ssh-host <host>      aliyun（默认）',
      '  --public-base <url>    https://dl.rose7.cn/（默认，只有 public 目标用）',
      '  --aapt2 <path>         aapt2 路径',
    ].join('\n'),
  );
}

function readArg(args, flag, envName) {
  if (args[flag] !== undefined && args[flag] !== true) return String(args[flag]);
  if (envName && process.env[envName]) return String(process.env[envName]);
  return null;
}

function parseCli(argv) {
  const args = parseArgs(argv, {
    flags: ['dry-run', 'exercise', 'skip-apk-validation', 'force', 'help'],
    multi: ['changes'],
  });
  if (args.help) {
    help();
    process.exit(0);
  }
  const apk = readArg(args, 'apk', 'DL_PRIVATE_APK');
  const version = readArg(args, 'version', 'DL_PRIVATE_VERSION');
  const versionCodeRaw = readArg(args, 'versionCode', 'DL_PRIVATE_VERSION_CODE');
  const variant = readArg(args, 'variant', 'DL_PRIVATE_VARIANT') || 'internal';
  const target = readArg(args, 'target', 'DL_PRIVATE_TARGET') || 'private';
  const transport = readArg(args, 'transport', 'DL_PRIVATE_TRANSPORT') || 'ssh';
  const sshHost = readArg(args, 'ssh-host', 'DL_PRIVATE_SSH_HOST') || DEFAULT_SSH_HOST;
  const webroot = readArg(args, 'webroot', 'DL_PRIVATE_WEBROOT')
    || readArg(args, 'site-root', 'DL_PRIVATE_SITE_ROOT')
    || DEFAULT_WEBROOT;
  const privateRoot = readArg(args, 'private-root', 'DL_PRIVATE_ROOT') || DEFAULT_PRIVATE_ROOT;
  // 清单路径单独可配：线上 DL_PRIVATE_RELEASES_JSON=/var/www/dl-private/… 不在私有根下（#621 收尾）。
  // 缺省回落 <private-root>/releases.internal.json（与 server.mjs 的同名 env 同义）。
  const privateManifest = readArg(args, 'private-manifest', 'DL_PRIVATE_RELEASES_JSON') || '';
  const publicBase = (readArg(args, 'public-base', 'DL_PRIVATE_PUBLIC_BASE') || DEFAULT_PUBLIC_BASE).replace(/\/+$/, '') + '/';

  const missing = [];
  if (!apk) missing.push('--apk（或 DL_PRIVATE_APK）');
  if (!version) missing.push('--version（或 DL_PRIVATE_VERSION）');
  if (!versionCodeRaw) missing.push('--versionCode（或 DL_PRIVATE_VERSION_CODE）');
  if (missing.length) dieEnv(`缺必填参数：${missing.join('、')}（--help 看全部参数）`);

  if (!RE_VERSION.test(version)) dieEnv(`--version 格式非法（要 x.y.z 或 x.y.z-beta.N）：'${version}'`);
  const versionCode = Number(versionCodeRaw);
  if (!Number.isInteger(versionCode) || versionCode <= 0) dieEnv(`--versionCode 必须是正整数：'${versionCodeRaw}'`);
  if (!VARIANTS.includes(variant)) dieEnv(`--variant 只能是 ${VARIANTS.join('|')}：'${variant}'`);
  if (!TARGETS.includes(target)) dieEnv(`--target 只能是 ${TARGETS.join('|')}：'${target}'`);
  if (!TRANSPORTS.includes(transport)) dieEnv(`--transport 只能是 ${TRANSPORTS.join('|')}：'${transport}'`);
  for (const [flag, dir] of [['--webroot', webroot], ['--private-root', privateRoot]]) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(dir)) dieEnv(`${flag} 必须是绝对路径且不含空格/引号：'${dir}'`);
  }
  if (privateManifest && !/^\/[A-Za-z0-9._/-]+$/.test(privateManifest)) {
    dieEnv(`--private-manifest 必须是绝对路径且不含空格/引号：'${privateManifest}'`);
  }
  if (!/^https?:\/\//.test(publicBase)) dieEnv(`--public-base 必须是 http(s) URL：'${publicBase}'`);

  const exercise = args.exercise === true;
  const dryRun = args['dry-run'] === true;
  const skipApkValidation = args['skip-apk-validation'] === true;
  const force = args.force === true;
  if (exercise && !FAKE_VERSION_RE.test(version) && !force) {
    dieEnv(`--exercise 只允许演练用的假版本号（0.0.0 开头），拿到的是 '${version}'。真版本走正常发布，别拿来演练。`);
  }
  // `--skip-apk-validation` 会把 aapt2 那几条一起跳过，所以它只能出现在**不会真发布**的组合里：
  //   · `--exercise`（假文件演练，跑完全量回滚）；或
  //   · `--transport local --dry-run`（本地临时目录演练，压根没有发布这条路）。
  // 单独用它 + 真版本 + ssh = 「绕过硬闸去发真包」，这条路不许存在。
  const drillOnly = transport === 'local' && dryRun;
  if (skipApkValidation && !exercise && !drillOnly) {
    dieEnv(
      '--skip-apk-validation 只能和 --exercise 或 `--transport local --dry-run` 一起用' +
        '（它是演练用的假文件通道，不是「跳过校验发真包」的开关）',
    );
  }
  // local 传输只读本机目录：它不是另一条发布通道，只是让 L0/CI 能在临时目录里演练四条硬闸。
  if (transport === 'local' && !dryRun) {
    dieEnv('--transport local 只允许配 --dry-run（本地目录仅用于演练四条硬闸；真发布走 ssh）');
  }
  if (!fs.existsSync(apk)) dieEnv(`APK 不存在：${apk}`);

  const changes = Array.isArray(args.changes) ? args.changes.filter((c) => typeof c === 'string' && c.trim()) : [];

  return {
    apk: path.resolve(apk),
    version,
    versionCode,
    variant,
    target,
    transport,
    changes,
    dryRun,
    exercise,
    skipApkValidation,
    sshHost,
    webroot,
    privateRoot,
    privateManifest,
    publicBase,
    aapt2: readArg(args, 'aapt2', 'AAPT2'),
  };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const target = targetPaths(opts);
  const buildType = buildTypeFor(opts.version);
  const stamp = Math.floor(Date.now() / 1000);

  log.head('发布参数');
  log.info(`APK          ${opts.apk}`);
  log.info(`version      ${opts.version}（versionCode ${opts.versionCode}）`);
  log.info(`variant      ${opts.variant}（buildType 由版本号判定 = ${buildType}）`);
  log.info(`target       ${opts.target} → ${target.label}`);
  log.info(`传输         ${opts.transport === 'local' ? 'local（本机目录，只读演练）' : `ssh ${opts.sshHost}`}`);
  log.info(`模式         ${opts.dryRun ? 'dry-run（不落地）' : opts.exercise ? 'exercise（真上传 + 真改清单 + 立刻回滚）' : '真发布'}`);

  // ---- 0. 硬闸 G1：目标 × 变体 × buildType（最便宜的一条，先判）----
  log.head('0/7 硬闸 G1：目标清单 × 变体 × 发布渠道');
  const g1 = gateTargetVariant({
    target: opts.target,
    variant: opts.variant,
    buildType,
    webroot: opts.webroot,
    privateRoot: opts.privateRoot,
  });
  if (g1.length) die(g1, '硬闸 G1 拒绝：公网清单只收 standard + stable；私有清单只收 internal。改目标或改变体，别改闸门。');
  log.ok(`目标 ${opts.target} 只收 ${TARGET_VARIANT[opts.target]}，本次 ${opts.variant} ✓`);
  if (opts.target === 'public') log.ok(`公网清单 buildType 只收 ${PUBLIC_ALLOWED_BUILD_TYPES.join('|')}，本次 ${buildType} ✓`);
  else {
    log.ok(`私有根 ${path.resolve(opts.privateRoot)} 在 webroot ${path.resolve(opts.webroot)} 之外 ✓`);
    log.info(`私有清单     ${target.manifestPath}${opts.privateManifest ? '' : '（缺省 = 私有根下；线上是 /var/www/dl-private/）'}`);
  }

  // ---- 1. APK 校验（aapt2）----
  log.head('1/7 校验 APK（aapt2）');
  let facts = { skipped: true };
  if (opts.skipApkValidation) {
    log.warn('已跳过 aapt2 校验（--skip-apk-validation，只允许「--exercise」或「--transport local --dry-run」演练用）');
  } else {
    const aapt2 = findAapt2(opts.aapt2);
    const res = validateApk({ apk: opts.apk, version: opts.version, versionCode: opts.versionCode, variant: opts.variant, aapt2 });
    facts = res.facts;
    if (!res.ok) die(res.errors, 'APK 属性不符 → 停止。改代码重出包，不要「先发后修」。');
    log.ok(`package=${facts.packageName} versionCode=${facts.versionCode} versionName=${facts.versionName}`);
    log.ok('application-debuggable: 0 处（无属性）');
    log.ok(`变体标记 ${VARIANT_META_NAME} = ${facts.variant}（source=apk-manifest）`);
  }

  // ---- 2. 硬闸 G2：APK 字节里的 consume.baseUrl ----
  // 判据来自产物字节，不来自命令行、不来自 config/endpoints.json（-PconsumeBase= 能覆盖后者）。
  log.head('2/7 硬闸 G2：APK 内 consume.baseUrl 不得是回环');
  const consumeReport = inspectConsumeBase(fs.readFileSync(opts.apk));
  const judgement = judgeConsumeBase(consumeReport);
  let g2 = gateLoopbackConsume(judgement);
  if (opts.skipApkValidation && g2.length) {
    // 演练用的假文件：读不出 consume.baseUrl 是**预期**的（不是真包）。回环**仍然**拒绝 ——
    // 也就是说这条豁免只豁免「读不到」，不豁免「读到了且是回环」。
    // 豁免只在「不会真发布」的组合里生效（--exercise / local+dry-run，见 parseCli），
    // 所以它挡不住任何真包：真包必须能读出 baseUrl，读不出就是 exit 1。
    if (judgement.loopback.length) die(g2, '硬闸 G2 拒绝（演练豁免只覆盖「读不到」，不覆盖「读到了且是回环」）。');
    log.warn(`演练模式（--skip-apk-validation）：读不出 consume.baseUrl（${consumeReport.reason ?? '未知'}），按演练继续`);
    g2 = [];
  }
  if (g2.length) die(g2, '硬闸 G2 拒绝：回环包在任何真机上都连不上后端（#601 事故形态），任何分发通道都不该收。');
  log.ok(judgement.ok ? judgement.message : '演练模式：假文件读不出 consume.baseUrl，已按演练放行（回环仍会拒）');
  if (judgement.ok) log.info(`取证来源     ${consumeReport.sources.join('、')}`);

  // ---- 3. hash ----
  log.head('3/7 算 sha256 / md5 / size');
  const hashes = hashFile(opts.apk);
  if (hashes.size > MAX_APK_BYTES) die([`APK ${hashes.size} 字节，超过服务端上限 ${MAX_APK_BYTES} 字节`]);
  log.ok(`size      ${hashes.size} 字节`);
  log.ok(`sha256    ${hashes.sha256}`);
  log.ok(`md5       ${hashes.md5}`);

  // ---- 4. 文件名 ----
  log.head('4/7 生成文件名（不再承担保密职责，见文件头）');
  const fileName = buildFileName({ version: opts.version, variant: opts.variant, suffix: randomSuffix() });
  const fileUrl = opts.target === 'public' ? `${opts.publicBase}${fileField(fileName)}` : null;
  log.ok(`文件名    ${fileName}`);
  if (fileUrl) log.ok(`直链      ${fileUrl}`);
  else log.ok(`存放      ${target.apkDir}/${fileName}（webroot 外，无公网直链）`);

  // ---- 5. 读目标状态 + 硬闸 G3/G4 ----
  log.head('5/7 硬闸 G3/G4：读目标清单与 apk/ 实况');
  const state = readTargetState({
    transport: opts.transport,
    sshHost: opts.sshHost,
    target,
    // 私有根缺 = 第一次发布（合法空态）；公网 webroot 缺 = 环境不对（不猜）
    allowMissingRoot: opts.target === 'private',
  });
  if (!state.ok && !opts.dryRun) die(state.errors, `目标状态读不出来 → 停止（一个字节都没动）。`);
  if (!state.ok) {
    // dry-run 也不许「读不到就跳过」：G3/G4 判不出来就是不安全，必须红。
    die(state.errors, 'dry-run 同样要过 G3/G4：读不到目标状态就判不了孤儿与自洽，判不了不发。');
  }

  let beforeManifest = null;
  if (state.manifestText) {
    try {
      beforeManifest = JSON.parse(state.manifestText);
    } catch (e) {
      die([`目标清单不是合法 JSON：${e.message}`]);
    }
    // 往返一致性：写回时用同一份序列化口径，若原文件不是「2 空格缩进 + 末尾换行」就拒绝写回，
    // 免得整份重排（那会让 diff 里全是无关改动，也让「回滚后逐字节一致」无法验证）
    const canonical = JSON.stringify(beforeManifest, null, 2) + '\n';
    if (canonical !== state.manifestText) {
      die([
        '目标清单的排版不是「2 空格缩进 + 末尾换行」，写回会整份重排。拒绝执行。',
        `原始 ${state.manifestText.length} 字符，规范化后 ${canonical.length} 字符 —— 请先用 node -e 检查 formatting 再手工发。`,
      ]);
    }
    log.ok(`目标清单 ${beforeManifest.releases.length} 条，latest = ${beforeManifest.latest}（往返序列化逐字节一致）`);
  } else {
    // 第一次发布：清单还不存在 → 从空清单起（latest 由条目决定）
    beforeManifest = { latest: opts.version, releases: [] };
    log.info('目标清单还不存在（第一次发布）→ 从空清单起');
  }

  const entry = buildEntry({
    version: opts.version,
    versionCode: opts.versionCode,
    variant: opts.variant,
    fileName,
    size: hashes.size,
    md5: hashes.md5,
    sha256: hashes.sha256,
    changes: opts.changes,
  });
  const afterManifest = mergeEntry(beforeManifest, entry, { updateLatest: opts.target === 'private' });
  const verdict = verifyMerge({ before: beforeManifest, after: afterManifest, entry, target: opts.target });
  // 既有历史 warning 不是本次发布的事，只显示**本条**相关的；其余折叠成一行计数，免得刷屏
  const mine = verdict.warnings.filter((w) => w.includes(`(${entry.version})`) || w.includes(`latest(${entry.version})`));
  const others = verdict.warnings.length - mine.length;
  for (const w of mine) log.warn(`清单 warning：${w}`);
  if (others > 0) log.info(`（另有 ${others} 条历史 warning，属于既有条目，未改动）`);
  if (verdict.errors.length) die(verdict.errors, '合并后的清单不合法 → 停止（目标上一个字节都没动）。');

  const g3 = gateManifestSelfConsistency({ manifest: afterManifest, presentFiles: state.presentFiles, planned: entry.file });
  const g4 = gateOrphanFiles({ manifest: afterManifest, presentFiles: state.presentFiles, planned: entry.file });
  if (g3.length || g4.length) die([...g3, ...g4], '硬闸 G3/G4 拒绝：清单与文件必须自洽，且目标目录里不许有清单未登记的本仓产物。');
  log.ok(`G3 自洽：清单登记 ${afterManifest.releases.length} 条，除本次待上传那条外全部在 ${target.apkDir} 下 ✓`);
  log.ok(`G4 孤儿：${state.presentFiles.length} 个现有文件全部有登记 ✓`);
  if (opts.target === 'private') log.ok(`合并后 ${afterManifest.releases.length} 条；latest = ${afterManifest.latest}（私有清单的 latest 跟着走）`);
  else log.ok(`合并后 ${afterManifest.releases.length} 条；latest 仍是 ${afterManifest.latest}（公网 latest 不许动）`);

  const afterText = JSON.stringify(afterManifest, null, 2) + '\n';
  const remoteManifest = target.manifestPath;
  const remoteApkDir = target.apkDir;
  const plan = [
    `scp ${opts.apk} ${opts.sshHost}:${remoteApkDir}/${fileName}.tmp-${stamp}`,
    `ssh ${opts.sshHost} 'chown www-data:www-data <tmp> && chmod 644 <tmp> && mv <tmp> ${remoteApkDir}/${fileName}'   # 原子改名`,
    `ssh ${opts.sshHost} 'cp ${remoteManifest} ${remoteManifest}.bak-private-${stamp}'   # 清单先备份`,
    `scp releases.json → ${opts.sshHost}:${remoteManifest}.tmp-${stamp} && ssh ${opts.sshHost} 'mv … ${remoteManifest}'   # 原子替换`,
    opts.target === 'public'
      ? `curl -I ${fileUrl}                    # 期望 200 + ${APK_CONTENT_TYPE} + content-length=${hashes.size}`
      : `ssh ${opts.sshHost} 'sha256sum ${remoteApkDir}/${fileName}'   # 私有包无公网直链：以远端字节为准（期望 ${hashes.sha256}）`,
    `ssh ${opts.sshHost} 'cat ${remoteManifest}' | grep -A2 '"${opts.version}"'   # 期望条目在清单里，sha256/size 与产物一致`,
    opts.target === 'public'
      ? `curl ${opts.publicBase}releases.json   # 期望 latest 与发布前逐字节相同（${beforeManifest.latest}）`
      : `确认 latest = ${afterManifest.latest}（私有清单）/ 公网 releases.json 未被本次触碰`,
  ];

  log.head(opts.dryRun ? '6/7 dry-run：将要执行的动作（一个字节都没发）' : '6/7 执行');
  if (opts.dryRun) {
    plan.forEach((line, i) => log.info(`(${i + 1}) ${line}`));
    log.head('清单里将要加入的条目');
    console.log(JSON.stringify(entry, null, 2));
    log.head('回滚方法（真发布后要撤时）');
    log.info(`ssh ${opts.sshHost} 'mv ${remoteManifest}.bak-private-${stamp} ${remoteManifest}'   # 恢复清单`);
    log.info(`ssh ${opts.sshHost} 'rm -f ${remoteApkDir}/${fileName}'                            # 删包`);
    log.ok('dry-run 结束：四条硬闸全过，没有上传、没有改清单');
    return;
  }

  // 上传前再确认文件名没被占用（随机撞车概率可忽略，但撞了就必须换一个）
  const exists = sshExec(opts.sshHost, `test -e ${quote(`${remoteApkDir}/${fileName}`)} && echo EXISTS || echo FREE`).stdout.trim();
  if (exists === 'EXISTS') die([`远端已存在同名文件：${fileName}（撞车了，重跑一次即可）`]);

  const state2 = { uploaded: false, manifestWritten: false, backupPath: '', remoteTmpFiles: [] };

  try {
    // 私有根第一次发布时可能还没有 apk/ 目录：建出来（只建目录，不碰任何已有字节）
    sshExec(opts.sshHost, `mkdir -p ${quote(remoteApkDir)}`);

    // 6a. 上传（先 .tmp 再原子 mv）
    const remoteTmp = `${remoteApkDir}/${fileName}.tmp-${stamp}`;
    state2.remoteTmpFiles.push(remoteTmp);
    log.info(`scp → ${opts.sshHost}:${remoteTmp}`);
    scpTo(opts.sshHost, opts.apk, remoteTmp);
    sshExec(
      opts.sshHost,
      `chown www-data:www-data ${quote(remoteTmp)} && chmod 644 ${quote(remoteTmp)} && mv -f ${quote(remoteTmp)} ${quote(`${remoteApkDir}/${fileName}`)}`,
    );
    state2.uploaded = true;
    log.ok(`上传完成（原子改名）：${remoteApkDir}/${fileName}`);

    // 6b. 清单：备份 → 写 tmp → 原子 mv
    const backupPath = `${remoteManifest}.bak-private-${stamp}`;
    if (state.manifestText) {
      sshExec(opts.sshHost, `cp -p ${quote(remoteManifest)} ${quote(backupPath)} && sha256sum ${quote(backupPath)}`);
      state2.backupPath = backupPath;
      log.ok(`清单已备份：${backupPath}`);
    }
    const tmpLocal = path.join(os.tmpdir(), `releases-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(tmpLocal, afterText, 'utf8');
    const remoteManifestTmp = `${remoteManifest}.tmp-${stamp}`;
    state2.remoteTmpFiles.push(remoteManifestTmp);
    scpTo(opts.sshHost, tmpLocal, remoteManifestTmp);
    sshExec(
      opts.sshHost,
      `chown www-data:www-data ${quote(remoteManifestTmp)} && chmod 644 ${quote(remoteManifestTmp)} && mv -f ${quote(remoteManifestTmp)} ${quote(remoteManifest)}`,
    );
    fs.rmSync(tmpLocal, { force: true });
    state2.manifestWritten = true;
    log.ok(`清单已原子替换（${beforeManifest.releases.length} → ${afterManifest.releases.length} 条，latest = ${afterManifest.latest}）`);

    // 7. 验证
    log.head('7/7 验证（远端字节 / 清单 / latest）');
    let verifyError = null;
    try {
      verifyLive({ opts, target, fileName, fileUrl, hashes, beforeManifest, afterManifest, entry });
    } catch (e) {
      verifyError = e;
    }

    if (opts.exercise) {
      log.head('exercise：全量回滚');
      rollback({ opts, state: state2, target, fileName, remoteManifest, remoteApkDir, beforeSha: state.manifestSha, beforeManifest, hadManifest: Boolean(state.manifestText) });
      state2.rolledBack = true;
      if (verifyError) throw verifyError;
      log.ok('演练完成：上传 / 清单改动 / 回滚三条都真的走了一遍，目标上无残留');
    } else if (verifyError) {
      throw verifyError;
    } else {
      log.head('发布成功 —— 清单条目');
      console.log(JSON.stringify(entry, null, 2));
      log.info(`回滚：ssh ${opts.sshHost} 'mv ${state2.backupPath} ${remoteManifest}' && ssh ${opts.sshHost} 'rm -f ${remoteApkDir}/${fileName}'`);
      log.info('证据：见上方「验证」段；全部核对通过');
      if (opts.target === 'private') {
        log.info('交付给内测同学：私有清单 + APK 都在 webroot 之外，按 docs/RELEASE-MANUAL.md §14.6 走带令牌的端点取，');
        log.info('或者直接把 APK 文件（连同 sha256）发给对方 —— 公网清单里没有这一条，猜 URL 也猜不到。');
      }
    }
  } catch (e) {
    console.error(`\n执行失败：${e.message}`);
    if (state2.rolledBack) {
      console.error('\n（本次是 --exercise，目标现场已经全量回滚 —— 上面的失败只是演练本身没通过。）');
    } else if (state2.uploaded || state2.manifestWritten) {
      console.error('\n目标上可能已半改，按下面顺序回滚（先清单、再文件）：');
      if (state2.backupPath) console.error(`  ssh ${opts.sshHost} 'mv -f ${quote(state2.backupPath)} ${quote(remoteManifest)}'`);
      console.error(`  ssh ${opts.sshHost} 'rm -f ${quote(`${remoteApkDir}/${fileName}`)}'`);
      for (const t of state2.remoteTmpFiles) console.error(`  ssh ${opts.sshHost} 'rm -f ${quote(t)}'`);
    }
    process.exit(1);
  }
}

/**
 * 发布后验证：
 *   公网目标（`--target public`）—— 直链 200 + Content-Type + Content-Length / 下载 sha256 /
 *     latest 逐字节未变 / 条目在清单里 / 既有条目原样；
 *   私有目标（默认）—— **没有公网直链**，所以判据换成远端字节 sha256 + 清单内容 + latest 语义。
 *     这一条本身就是 #609 的验收：私有包不该有可被公网访问的 URL。
 */
function verifyLive({ opts, target, fileName, fileUrl, hashes, beforeManifest, afterManifest, entry }) {
  const errors = [];

  if (opts.target === 'public') {
    const head = run('curl', ['-sS', '-I', fileUrl], { timeout: 60_000 }).stdout;
    const status = Number((/^HTTP\/[\d.]+ (\d{3})/m.exec(head) || [])[1] || 0);
    const contentType = ((/\r?\ncontent-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim();
    const contentLength = Number(((/\r?\ncontent-length:\s*(\d+)/i.exec(head) || [])[1] || 0));
    log.info(`curl -I ${fileUrl}`);
    log.info(`  → HTTP ${status}  content-type: ${contentType}  content-length: ${contentLength}`);
    if (status !== 200) errors.push(`直链不是 200（拿到 ${status}）`);
    if (contentType !== APK_CONTENT_TYPE) errors.push(`Content-Type 不对：${contentType || '(缺)'}，要求 ${APK_CONTENT_TYPE}`);
    if (contentLength !== hashes.size) errors.push(`Content-Length ${contentLength} != 本地 size ${hashes.size}`);
  } else {
    // 私有目标：远端字节必须与本地一致；顺手确认公网侧**看不到**这个文件（#609 的核心验收）
    const remoteSha = sshExec(opts.sshHost, `sha256sum ${quote(`${target.apkDir}/${fileName}`)}`).stdout.trim().split(/\s+/)[0] || '';
    log.info(`ssh sha256sum ${target.apkDir}/${fileName}`);
    log.info(`  → ${remoteSha}（本地 ${hashes.sha256}）`);
    if (remoteSha !== hashes.sha256) errors.push(`远端文件的 sha256 与本地不一致：${remoteSha} != ${hashes.sha256}`);

    // #609 的核心验收：私有包**不许**有公网可访问的 URL。直接按「如果它在公网 apk/ 目录里会是什么地址」探一次，
    // 期望不是 200（404 / 连接失败都算通过 —— 只有 200 是事故）。
    const publicProbe = `${opts.publicBase}${entry.file}`;
    const probeHead = run('curl', ['-sS', '-I', publicProbe], { timeout: 60_000 }).stdout;
    const probeStatus = Number((/^HTTP\/[\d.]+ (\d{3})/m.exec(probeHead) || [])[1] || 0);
    log.info(`curl -I ${publicProbe}（公网侧必须够不着这个文件）`);
    log.info(`  → HTTP ${probeStatus}（期望非 200）`);
    if (probeStatus === 200) {
      errors.push(`私有包在公网可直链下载（${publicProbe} → 200）—— 文件被放进了 webroot，立刻移出`);
    }
  }

  const liveText = sshExec(opts.sshHost, `cat ${quote(target.manifestPath)}`).stdout;
  let live = null;
  try {
    live = JSON.parse(liveText);
  } catch (e) {
    errors.push(`目标清单读不出来了：${e.message}`);
  }
  if (live) {
    const rec = live.releases.find((r) => r.version === entry.version && r.artifactVariant === entry.artifactVariant);
    if (!rec) errors.push(`清单里没有本次条目：${entry.version}（${entry.artifactVariant}）`);
    else {
      if (rec.sha256 !== entry.sha256) errors.push(`清单里的 sha256 与产物不一致：${rec.sha256}`);
      if (rec.file !== entry.file) errors.push(`清单里的 file 与产物不一致：${rec.file}`);
      if (rec.size !== entry.size) errors.push(`清单里的 size 与产物不一致：${rec.size}`);
      log.info(`条目：${rec.version} code=${rec.versionCode} variant=${rec.artifactVariant} file=${rec.file} sha256=${rec.sha256}`);
    }
    if (opts.target === 'public') {
      if (live.latest !== beforeManifest.latest) errors.push(`公网 latest 变了：${beforeManifest.latest} → ${live.latest}`);
    } else if (live.latest !== afterManifest.latest) {
      errors.push(`私有清单 latest 不等于本次版本：${live.latest} != ${afterManifest.latest}`);
    }
    for (const old of beforeManifest.releases) {
      const still = live.releases.find(
        (r) => r && r.version === old.version && (r.artifactVariant ?? null) === (old.artifactVariant ?? null),
      );
      if (!still || JSON.stringify(still) !== JSON.stringify(old)) {
        errors.push(`既有条目被动过：${old.version}${old.artifactVariant ? `（${old.artifactVariant}）` : ''}`);
      }
    }
    log.info(`既有 ${beforeManifest.releases.length} 条逐条比对：${errors.length ? '有差异' : '全部原样'}`);
  }

  if (errors.length) throw new CliError(`发布后验证失败：\n  - ${errors.join('\n  - ')}`);
  log.ok(
    opts.target === 'public'
      ? '验证通过：200 + Content-Type + Content-Length / 下载 sha256 一致 / latest 未变 / 条目在清单里 / 既有条目原样'
      : '验证通过：远端 sha256 一致 / 无公网直链 / 条目在清单里 / latest 正确 / 既有条目原样',
  );
  return true;
}

/**
 * 全量回滚：恢复清单 → 删包 → 再验证（文件消失、清单 sha256 与演练前逐字节一致）
 */
function rollback({ opts, state, target, fileName, remoteManifest, remoteApkDir, beforeSha, beforeManifest, hadManifest }) {
  const remoteFile = `${remoteApkDir}/${fileName}`;

  if (state.backupPath) {
    sshExec(opts.sshHost, `mv -f ${quote(state.backupPath)} ${quote(remoteManifest)}`);
    log.ok(`清单已从备份恢复：${state.backupPath}`);
  } else if (!hadManifest) {
    sshExec(opts.sshHost, `rm -f ${quote(remoteManifest)}`);
    log.ok('清单是本次新建的（演练前不存在）→ 已删除');
  }
  sshExec(opts.sshHost, `rm -f ${quote(remoteFile)}`);
  log.ok(`已删除上传的文件：${remoteFile}`);
  for (const t of state.remoteTmpFiles) sshExec(opts.sshHost, `rm -f ${quote(t)}`);

  const errors = [];
  if (hadManifest) {
    const afterRollbackSha = sshExec(opts.sshHost, `sha256sum ${quote(remoteManifest)}`).stdout.trim().split(/\s+/)[0];
    log.info(`清单 sha256：演练前 ${beforeSha} / 回滚后 ${afterRollbackSha}`);
    if (afterRollbackSha !== beforeSha) errors.push(`回滚后清单 sha256 与演练前不一致：${afterRollbackSha} != ${beforeSha}`);
    const remoteText = sshExec(opts.sshHost, `cat ${quote(remoteManifest)}`).stdout;
    try {
      const back = JSON.parse(remoteText);
      if (JSON.stringify(back) !== JSON.stringify(beforeManifest)) errors.push('回滚后的清单内容与演练前不是同一份');
    } catch (e) {
      errors.push(`回滚后清单读不出来：${e.message}`);
    }
  } else {
    const exists = sshExec(opts.sshHost, `test -e ${quote(remoteManifest)} && echo LEFT || echo GONE`).stdout.trim();
    log.info(`演练前没有清单 → 回滚后：${exists}`);
    if (exists === 'LEFT') errors.push('回滚后清单还在（演练前它并不存在）');
  }

  const fileGone = sshExec(opts.sshHost, `test -e ${quote(remoteFile)} && echo FILE_LEFT || echo FILE_GONE`).stdout.trim();
  log.info(`文件残留检查：${fileGone}（期望 FILE_GONE）`);
  if (fileGone !== 'FILE_GONE') errors.push('回滚后文件还在');

  const residue = sshExec(
    opts.sshHost,
    [
      `test -e ${quote(state.backupPath || `${remoteManifest}.never`)} && echo BAK_LEFT || echo BAK_GONE`,
      ...state.remoteTmpFiles.map((t) => `test -e ${quote(t)} && echo TMP_LEFT || echo TMP_GONE`),
    ].join('; '),
  ).stdout.trim().split('\n');
  log.info(`残留检查：${residue.join(' / ')}`);
  if (residue.some((l) => l.endsWith('_LEFT'))) {
    errors.push(`回滚后还有残留：${residue.filter((l) => l.endsWith('_LEFT')).join('、')}`);
  }

  if (errors.length) throw new CliError(`回滚没干净：\n  - ${errors.join('\n  - ')}`);
  log.ok(`回滚验证：文件已删、清单与演练前逐字节一致、无残留（target=${target.target}）`);
}

// 被 import（单测）时不要跑 cli：只有直接执行才进 main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n[${e.name || 'Error'}] ${e.message}`);
    process.exit(e.exitCode || 1);
  });
}

export { ROOT, run, sshExec, scpTo };
