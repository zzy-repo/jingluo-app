#!/usr/bin/env node
/**
 * release-verify.mjs —— 复核「线上 releases.json 真的生效了」（Issue #107 的「校验」这一步）。
 *
 * `https://dl.rose7.cn/releases.json` 是**唯一事实来源**：App 的自动更新看它、release.yml 也从它取
 * file/md5/changes 去镜像 GitHub Release。所以上传返回 ok:true 之后，真正的验收是：
 *   1. releases.json 里出现这个版本，并且 latest / releases[0] / 记录三处对得上
 *   2. 记录的 versionCode / size / sha256 / buildType 与本次一致
 *   3. 把 APK 从 dl 下载回来算 sha256，与本地构建产物、与记录里的 sha256 三者一致
 *
 * 用法：
 *   node scripts/release-verify.mjs                         # 版本号取 package.json 的 version
 *   node scripts/release-verify.mjs --version 1.4.0-beta.10 --apk <本地apk>
 *   node scripts/release-verify.mjs --manifest deploy/dl-release/fixtures/live-2026-11-18.json --no-download
 *   pnpm run release:verify -- --version <ver> [--apk <apk>]
 *
 * 退出码：
 *   0  线上已生效且三方 hash 一致（可以往下打 tag）
 *   1  不一致 / 线上还没有这个版本（**此时绝不能打 tag**：release.yml 会 404）
 *   2  用法或网络错误
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MANIFEST,
  RE_MD5,
  RE_SHA256,
  ReleaseEnvError,
  buildTypeFor,
  hashFile,
  log,
  parseArgs,
  readPackageVersion,
} from './release-common.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_FIELDS = ['version', 'versionCode', 'releasedAt', 'file', 'size', 'md5', 'changes', 'buildType'];

function usage() {
  return [
    '用法: node scripts/release-verify.mjs [选项]',
    '',
    '选项:',
    '  --version <v>        要复核的版本（默认 package.json 的 version）',
    '  --manifest <path|url> 默认 ' + DEFAULT_MANIFEST,
    '  --base-url <url>     APK 下载根（默认 ' + DEFAULT_BASE_URL + '；file 是相对路径）',
    '  --apk <path>         本地构建产物；给了就与线上记录的 sha256 三方比对',
    '  --expect-variant <internal|standard>  期望的 artifactVariant',
    '  --no-download        不下载 APK（只校验 manifest 记录本身）',
    '  --timeout <秒>       默认 120',
    '  --json               末尾打一份机器可读结果',
    '  -h, --help           本用法',
    '',
    '退出码: 0 已生效且一致 / 1 不一致或线上没有该版本（不许打 tag）/ 2 用法或网络错误',
  ].join('\n');
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ReleaseEnvError(`拉 ${url} 失败：HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ReleaseEnvError(`拉 ${url} 回来的不是 JSON（${e.message}）`);
  }
}

async function downloadSha256(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ReleaseEnvError(`下载 ${url} 失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { flags: ['no-download', 'json', 'help', 'h'] });
  } catch (e) {
    console.error(`${e.message}\n\n${usage()}`);
    return EXIT_USAGE;
  }
  if (args.help || args.h) {
    console.log(usage());
    return EXIT_OK;
  }

  const timeoutMs = Math.max(5, Number(args.timeout || 120)) * 1000;
  const manifestSpec = args.manifest ? String(args.manifest) : DEFAULT_MANIFEST;
  const baseUrl = args['base-url'] ? String(args['base-url']) : DEFAULT_BASE_URL;
  const pkg = readPackageVersion(ROOT);

  const fails = [];
  const warns = [];
  const fail = (m) => {
    fails.push(m);
    log.fail(m);
  };
  const warn = (m) => {
    warns.push(m);
    log.warn(m);
  };

  log.head(`1) 读线上 releases.json（${manifestSpec}）`);
  let manifest;
  try {
    if (/^https?:\/\//i.test(manifestSpec)) manifest = await fetchJson(manifestSpec, timeoutMs);
    else manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, manifestSpec), 'utf8'));
  } catch (e) {
    if (e instanceof ReleaseEnvError) throw e;
    throw new ReleaseEnvError(`读写 ${manifestSpec} 失败：${e.message}`);
  }
  const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
  if (!releases.length) throw new ReleaseEnvError('releases.json 里没有 releases[] —— 结构不对，先跑 scripts/validate-releases-manifest.mjs');
  log.ok(`共 ${releases.length} 条记录，latest = ${manifest.latest}`);

  const version = args.version ? String(args.version).trim() : pkg.version;
  if (!version) throw new ReleaseEnvError('拿不到要复核的版本号：package.json 缺 version 且没给 --version');

  log.head(`2) 定位记录 ${version}`);
  const idx = releases.findIndex((r) => r && r.version === version);
  if (idx < 0) {
    fail(`releases.json 里没有 ${version} —— 上传没生效（或发的是另一个版本）。**此时绝不能打 tag**：release.yml 会 404 退出`);
    log.info(`线上最新是 ${manifest.latest}（releases[0].version=${releases[0] && releases[0].version}）`);
    if (args.json === true) console.log(JSON.stringify({ ok: false, version, latest: manifest.latest, fails }, null, 2));
    return EXIT_FAIL;
  }
  const record = releases[idx];
  log.ok(`releases[${idx}] 命中（latest=${manifest.latest}）`);
  if (manifest.latest !== releases[0].version) {
    warn(`latest(${manifest.latest}) 与 releases[0].version(${releases[0].version}) 不一致（契约要求相等）`);
  }
  if (idx !== 0) {
    warn(`这条不是 releases[0]：说明后面又发过更新的版本，自动更新不会推给它（确认这是你要的）`);
  }

  log.head('3) 记录字段完整性');
  for (const f of REQUIRED_FIELDS) {
    if (record[f] === undefined || record[f] === null || record[f] === '') fail(`记录缺必填字段 ${f}`);
  }
  if (Array.isArray(record.changes) && record.changes.length) log.ok(`changes ${record.changes.length} 条`);
  else fail('changes 为空 —— App 更新弹窗与 Release notes 会是空白');
  if (typeof record.sha256 === 'string') {
    if (RE_SHA256.test(record.sha256)) log.ok(`sha256 ${record.sha256}`);
    else fail(`记录里的 sha256 不是 64 位小写 hex：${record.sha256}`);
  } else {
    fail('记录缺 sha256（新版本必须有；只有历史版本可以没有）');
  }
  if (typeof record.md5 === 'string' && !RE_MD5.test(record.md5)) fail(`记录里的 md5 不是 32 位小写 hex：${record.md5}`);
  if (typeof record.file === 'string' && !record.file.startsWith('apk/')) {
    fail(`file 必须是 apk/<name>.apk 相对路径，记录里是 ${record.file}`);
  }

  log.head('4) 与本次发布口径对照');
  if (pkg.version && record.version === pkg.version) log.ok(`version 与 package.json 一致（${pkg.version}）`);
  else if (args.version) log.info(`按 --version 复核（package.json 是 ${pkg.version}）`);
  else warn(`version 与 package.json（${pkg.version}）不同`);
  if (pkg.versionCode !== null) {
    if (record.versionCode === pkg.versionCode) log.ok(`versionCode 与 package.json 一致（${pkg.versionCode}）`);
    else fail(`记录的 versionCode ${record.versionCode} ≠ package.json 的 ${pkg.versionCode}（记录对不上就是发错了包）`);
  }
  const expectBuildType = buildTypeFor(version);
  if (record.buildType === expectBuildType) log.ok(`buildType = ${record.buildType}`);
  else warn(`记录的 buildType 是 ${record.buildType}，按版本号判定应为 ${expectBuildType}`);
  if (record.artifactVariant !== undefined || record.artifactVariantSource !== undefined) {
    if (record.artifactVariant && record.artifactVariantSource) {
      log.ok(`artifactVariant = ${record.artifactVariant}（source ${record.artifactVariantSource}）`);
      if (args['expect-variant'] && record.artifactVariant !== String(args['expect-variant'])) {
        fail(`artifactVariant 是 ${record.artifactVariant}，期望 ${args['expect-variant']}（变体错了 = 自动更新会推错包）`);
      }
    } else {
      fail('artifactVariant 与 artifactVariantSource 必须成对出现');
    }
  } else {
    warn('记录里没有 artifactVariant（历史版本或服务端未写）——无法判定变体是否与本次构建同源');
  }

  let localHash = null;
  if (args.apk) {
    localHash = hashFile(path.resolve(ROOT, String(args.apk)));
    if (record.sha256 && localHash.sha256 === record.sha256) log.ok('本地 APK sha256 == 线上记录 sha256');
    else if (record.sha256) fail(`本地 APK sha256 ${localHash.sha256} ≠ 线上记录 ${record.sha256}`);
    if (typeof record.size === 'number') {
      if (record.size === localHash.size) log.ok(`本地 APK size == 线上记录 size（${localHash.size}）`);
      else fail(`本地 APK size ${localHash.size} ≠ 线上记录 ${record.size}`);
    }
  } else {
    log.info('没给 --apk，跳过与本地构建产物的比对');
  }

  if (args['no-download'] === true) {
    log.head('5) 下载复核');
    log.info('--no-download：跳过。注意这一步没做就等于没验证「用户真能下到这个包」');
  } else if (!record.file) {
    fail('记录没有 file，无法下载复核');
  } else {
    const url = new URL(record.file, baseUrl).toString();
    log.head(`5) 下载回来算 hash（${url}）`);
    try {
      const got = await downloadSha256(url, timeoutMs);
      if (record.sha256 && got.sha256 === record.sha256) log.ok(`下载件 sha256 == 记录 sha256（${got.sha256}）`);
      else fail(`下载件 sha256 ${got.sha256} ≠ 记录 ${record.sha256} —— 线上文件与记录不符，停止发布`);
      if (typeof record.size === 'number' && got.size !== record.size) fail(`下载件 size ${got.size} ≠ 记录 ${record.size}`);
      if (localHash && got.sha256 !== localHash.sha256) fail(`下载件 sha256 与本地构建产物不同（${localHash.sha256}）`);
      if (localHash) log.ok('三方一致：本地构建产物 / 线上记录 / dl 下载件');
    } catch (e) {
      if (e instanceof ReleaseEnvError) fail(e.message);
      else fail(`下载复核失败：${e.message}`);
    }
  }

  log.head('结论');
  if (warns.length) log.info(`${warns.length} 条 warn（逐条判断，不许当成通过）`);
  if (fails.length) {
    console.log(`  FAIL  ${fails.length} 项不通过 —— 不许打 tag / 不许宣布发布完成`);
    if (args.json === true) console.log(JSON.stringify({ ok: false, version, record, fails, warns }, null, 2));
    return EXIT_FAIL;
  }
  console.log(`  PASS  ${version} 已在线上生效，hash 一致`);
  console.log(`  下一步: 打 tag v${version} 并推送（会触发 .github/workflows/release.yml 镜像 GitHub Release）`);
  if (args.json === true) console.log(JSON.stringify({ ok: true, version, record, warns }, null, 2));
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ReleaseEnvError) {
      console.error(`环境/用法错误:\n  ${e.message}`);
      process.exit(EXIT_USAGE);
    }
    console.error(`内部错误: ${e && e.stack ? e.stack : e}`);
    process.exit(EXIT_USAGE);
  },
);
