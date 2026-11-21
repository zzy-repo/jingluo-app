#!/usr/bin/env node
/**
 * release-check.mjs —— 发版前自检（Issue #107）：版本号一致性 + 产物存在 + hash。
 *
 * 为什么要有它：手工清单里「版本号三处一致」「产物存在且 hash 对得上」这两件事原来全靠人肉盯，
 * 换一台机器就没人知道该比哪几处。这个脚本把口径写成代码，任何机器（Windows / Linux / 没装
 * Android SDK 也行）都能跑，缺东西时直接说缺什么，不会「看着像通过」。
 *
 * 校验项：
 *   1. package.json 的 version（→ versionName）格式合法
 *   2. package.json 的 androidVersionCode（→ versionCode）是正整数
 *   3. CHANGELOG.md 有 `## <version>` 段（它同时是 dl 的 meta.changes 与 Release notes 的来源）
 *   4. 期望证书指纹（**总是**判，Issue #702）：期望值必须读得到（主源 `config/appIdentity.json`，
 *      老 checkout 兼容回落到 `android/app/build.gradle` 的字面量）、与 gradle 里那份副本（若有）相等、
 *      且等于仓库记录的已发布证书（`PUBLISHED_IDENTITY`）。任一条不过 = FAIL。
 *      #702 之前这里「拿到 null 只打一句提示」= 看起来检查了、其实没检查；现在读不到期望值直接 FAIL。
 *   5. --tag 给定 时：tag 必须是 v<version>
 *   6. --apk 给定 时：文件存在、0 < size ≤ 50 MB、算出 sha256/md5，
 *      并**零依赖**解 APK 内的二进制 AndroidManifest 复核包名 / versionName / versionCode /
 *      ARTIFACT_VARIANT 变体标记 / debuggable（不需要 aapt2，也不需要 Android SDK）
 *   7. --manifest 给定 时：本地 versionCode 必须 > 线上 latest.versionCode（防降级 / 防 409）
 *   8. --expect-sha256 给定 时：APK 的 sha256 必须等于它（用来复核「上传后下载回来的包」）
 *
 * 用法：
 *   node scripts/release-check.mjs
 *   node scripts/release-check.mjs --apk android/app/build/outputs/apk/release/app-release.apk --tag v1.4.0-beta.10
 *   node scripts/release-check.mjs --apk <apk> --expect-sha256 <64位hex>
 *   node scripts/release-check.mjs --manifest https://dl.rose7.cn/releases.json
 *   pnpm run release:check -- --apk <apk>
 *
 * 退出码：
 *   0  全部通过（可以继续下一步；warn 不算失败，但会明确列出来）
 *   1  有 FAIL（不许继续上传）
 *   2  用法 / 环境错误（连自检都没跑起来）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CERT_FALLBACK_REL,
  CERT_PRIMARY_REL,
  MAX_APK_BYTES,
  PACKAGE_NAME,
  RE_SHA256,
  RE_VERSION,
  ReleaseEnvError,
  assertMatchesPublishedCert,
  assertSingleFingerprintSource,
  buildTypeFor,
  changelogHasVersion,
  hashFile,
  inspectApk,
  log,
  parseArgs,
  readPackageVersion,
  resolveExpectedCertSha256,
} from './release-common.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return [
    '用法: node scripts/release-check.mjs [选项]',
    '',
    '选项:',
    '  --apk <path>            构建产物路径；给了就校验存在 / 大小 / hash / APK 内版本号 / 变体 / debuggable',
    '  --tag <vX.Y.Z>          即将打的 tag（必须是 v<version>）',
    '  --manifest <path|url>   线上 releases.json；给了就校验 versionCode 严格大于线上 latest',
    '  --expect-sha256 <hex>   期望的 APK sha256（复核下载回来的包时用）',
    '  --json                  末尾额外打一份机器可读结果',
    '  --strict                warn 也当失败（发版前建议带上）',
    '  -h, --help              本用法',
    '',
    '退出码: 0 通过 / 1 有 FAIL / 2 用法或环境错误',
    '不做的事: 不构建、不联网上传、不读令牌、不写任何文件。',
  ].join('\n');
}

async function loadManifest(spec) {
  if (/^https?:\/\//i.test(spec)) {
    const res = await fetch(spec, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new ReleaseEnvError(`拉 releases.json 失败：HTTP ${res.status}（${spec}）`);
    return await res.json();
  }
  const file = path.resolve(ROOT, spec);
  if (!fs.existsSync(file)) throw new ReleaseEnvError(`releases.json 不存在：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { flags: ['json', 'strict', 'help', 'h'] });
  } catch (e) {
    console.error(`${e.message}\n\n${usage()}`);
    return EXIT_USAGE;
  }
  if (args.help || args.h) {
    console.log(usage());
    return EXIT_OK;
  }

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

  const pkg = readPackageVersion(ROOT);
  log.head(`1) 版本号唯一来源 ${path.relative(ROOT, pkg.file)}`);
  for (const e of pkg.errors) fail(e);
  if (!pkg.errors.length) {
    log.ok(`version = ${pkg.version}（→ Android versionName）`);
    log.ok(`androidVersionCode = ${pkg.versionCode}（→ Android versionCode）`);
  }

  log.head('2) CHANGELOG.md 的版本段（用户可见变更的唯一来源）');
  const changelogFile = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogFile)) {
    fail('仓库根没有 CHANGELOG.md');
  } else if (!pkg.version) {
    warn('version 都不合法，跳过 CHANGELOG 段检查');
  } else if (changelogHasVersion(fs.readFileSync(changelogFile, 'utf8'), pkg.version)) {
    log.ok(`有 \`## ${pkg.version}\` 段（这段会进 dl 的 meta.changes 与 GitHub Release notes）`);
  } else {
    fail(`CHANGELOG.md 里没有 \`## ${pkg.version}\` 段 —— 先写用户能看懂的一句话变更再发版`);
  }

  log.head('3) 三处一致：package.json / CHANGELOG 段 / 将打的 tag');
  if (args.tag === undefined) {
    log.info('没给 --tag，跳过 tag 一致性检查（发版时必须给：--tag v' + (pkg.version || '<version>') + '）');
  } else {
    const expected = `v${pkg.version}`;
    if (args.tag === expected) log.ok(`tag ${args.tag} == v<version>`);
    else fail(`tag 是 ${args.tag}，但 package.json 的 version 是 ${pkg.version}（应为 ${expected}）`);
  }
  if (pkg.version) log.info(`本次 buildType（按版本号判定）: ${buildTypeFor(pkg.version)}`);

  // ---- 4) 期望证书指纹：来源 + 一致性（#702：这一段以前是「拿到 null 只打提示」）----
  // 判据三条，任一不过 = FAIL（exit 1）：
  //   ① 期望值读得到（主源 config/appIdentity.json，老 checkout 回落到 build.gradle 字面量）；
  //      读不到就**报错**，不许「看着像检查了」——那是 #702 要治的病。
  //   ② 两份副本（配置 vs gradle 字面量）必须相等（第二份真相源显式拦截，#697 同口径）。
  //   ③ 期望值必须等于仓库记录的已发布证书（PUBLISHED_IDENTITY）—— 本脚本零依赖、没有 apksigner，
  //      读不到 APK 内的真实证书，所以这是它唯一能真正判红的口径：配置里的指纹被改一个字就红。
  log.head('4) 期望证书指纹（发版证据：唯一来源 + 一致性）');
  const expectedCert = resolveExpectedCertSha256(ROOT);
  if (!expectedCert.value) {
    fail(
      `读不到已发布证书指纹的期望值（${expectedCert.source ?? `既没有 ${CERT_PRIMARY_REL}，也没有 ${CERT_FALLBACK_REL} 的字面量`}）` +
        (expectedCert.invalid ? `：${CERT_PRIMARY_REL} 的 expectedCertSha256 ${expectedCert.invalid}` : ''),
    );
    log.info(`唯一的来源是 ${CERT_PRIMARY_REL} 的 expectedCertSha256（64 位小写十六进制，#271）；读不到就是仓库被改坏了`);
  } else if (!assertSingleFingerprintSource(expectedCert, { root: ROOT, log: console.log })) {
    fail('证书指纹有两份来源且不一致（第二份真相源，两个值见上）—— 一处改了另一处没改，不许发版');
  } else if (!assertMatchesPublishedCert(expectedCert, { log: console.log })) {
    fail('期望证书指纹与「已发布证书」不一致（两个值见上）—— 换证书 = 已装用户无法覆盖升级');
  } else {
    log.ok(`期望证书 SHA-256 = ${expectedCert.value}（来源 ${expectedCert.source}）`);
    log.info('本脚本不验签名（要 apksigner）：APK 的真实证书指纹由 `pnpm run check:keystore` / `release:verify` 比对');
    log.info('换证书 = 已装用户无法覆盖升级；不符时换 key，不许改期望值（docs/RELEASE-MANUAL.md §1）');
  }

  let apkHash = null;
  let apkInfo = null;
  if (args.apk === undefined) {
    log.head('5) 产物');
    log.info('没给 --apk，跳过产物检查（构建机上必须给）');
  } else {
    log.head(`5) 产物 ${args.apk}`);
    const apkPath = path.resolve(ROOT, args.apk);
    if (!fs.existsSync(apkPath)) {
      fail(`产物不存在：${apkPath}（构建没跑、或跑在另一个 worktree 上）`);
    } else {
      apkHash = hashFile(apkPath);
      if (apkHash.size === 0) fail('产物是 0 字节');
      else if (apkHash.size > MAX_APK_BYTES) {
        fail(`产物 ${apkHash.size} 字节，超过服务端上限 ${MAX_APK_BYTES}（50 MB）`);
      } else {
        log.ok(`size = ${apkHash.size} 字节（上限 ${MAX_APK_BYTES}）`);
      }
      log.ok(`sha256 = ${apkHash.sha256}`);
      log.ok(`md5    = ${apkHash.md5}`);

      apkInfo = inspectApk(apkPath);
      if (apkInfo.note) warn(apkInfo.note);
      if (apkInfo.packageName === PACKAGE_NAME) log.ok(`包名 = ${apkInfo.packageName}`);
      else if (apkInfo.packageName) fail(`包名是 ${apkInfo.packageName}，服务端只收 ${PACKAGE_NAME}`);
      else warn('APK 内包名解析不出来（不是 APK / 损坏），按「没测到」处理');

      if (apkInfo.versionName) {
        if (pkg.version && apkInfo.versionName === pkg.version) log.ok(`APK 内 versionName = ${pkg.version}`);
        else fail(`APK 内 versionName 是 ${apkInfo.versionName}，package.json 是 ${pkg.version} —— 版本号对不上，别上传`);
      } else {
        warn('APK 内 versionName 解析不出来，用 aapt2 dump badging 人工复核 docs/RELEASE-MANUAL.md §4.1');
      }
      if (typeof apkInfo.versionCode === 'number') {
        if (pkg.versionCode !== null && apkInfo.versionCode === pkg.versionCode) {
          log.ok(`APK 内 versionCode = ${pkg.versionCode}`);
        } else {
          fail(`APK 内 versionCode 是 ${apkInfo.versionCode}，package.json 是 ${pkg.versionCode} —— 版本号对不上，别上传`);
        }
      } else {
        warn('APK 内 versionCode 解析不出来，用 aapt2 dump badging 人工复核 docs/RELEASE-MANUAL.md §4.1');
      }

      if (apkInfo.variant === 'internal' || apkInfo.variant === 'standard') {
        log.ok(`ARTIFACT_VARIANT = ${apkInfo.variant}（必须与本次 web 构建同源：build:internal ↔ internal，build ↔ standard）`);
      } else {
        warn('ARTIFACT_VARIANT 读不到（变体标记缺失会让自动更新推错包），按没测到处理');
      }

      if (apkInfo.debuggable === false) log.ok('debuggable 标记不存在（release 构建类型）');
      else if (apkInfo.debuggable === true) {
        fail('这个包是 debuggable 构建（Issue #60）—— 绝对不准上传，回构建机用 assembleRelease 重出');
      } else {
        fail(`判不出 debuggable（${apkInfo.debuggableReason}）—— 按不通过处理，不许猜着放行`);
      }
    }
  }

  if (args['expect-sha256'] !== undefined) {
    log.head('6) 期望 sha256 复核');
    const want = String(args['expect-sha256']).trim().toLowerCase();
    if (!RE_SHA256.test(want)) fail(`--expect-sha256 不是 64 位小写 hex：${args['expect-sha256']}`);
    else if (!apkHash) fail('--expect-sha256 需要同时给 --apk 才算得出来');
    else if (apkHash.sha256 === want) log.ok('sha256 与期望值一致');
    else fail(`sha256 不一致：本地 ${apkHash.sha256}，期望 ${want}`);
  }

  if (args.manifest !== undefined) {
    log.head(`7) 与线上 latest 比 versionCode（${args.manifest}）`);
    try {
      const manifest = await loadManifest(String(args.manifest));
      const latest = manifest && manifest.latest;
      const first = manifest && Array.isArray(manifest.releases) ? manifest.releases[0] : null;
      if (!first || typeof first.versionCode !== 'number') {
        fail('releases.json 结构不对：releases[0] 没有 versionCode');
      } else {
        if (latest !== first.version) warn(`releases.json 的 latest(${latest}) 与 releases[0].version(${first.version}) 不一致（契约要求相等）`);
        if (pkg.versionCode === null) fail('本地 androidVersionCode 非法，没法比');
        else if (pkg.versionCode > first.versionCode) {
          log.ok(`本地 versionCode ${pkg.versionCode} > 线上 latest ${first.versionCode}（${first.version}）`);
        } else {
          fail(
            `本地 versionCode ${pkg.versionCode} 没有超过线上 latest ${first.versionCode}（${first.version}）` +
              ' —— 上传会 409 VERSION_CONFLICT，先 bump androidVersionCode',
          );
        }
        if (pkg.version && latest === pkg.version) {
          warn(`package.json 的 version 与线上 latest 相同（${latest}）：只允许同版本覆盖重发，正式发新版请 bump version`);
        }
      }
    } catch (e) {
      if (e instanceof ReleaseEnvError) fail(e.message);
      else fail(`拉/解析 releases.json 失败：${e.message}`);
    }
  }

  log.head('结论');
  if (warns.length) log.info(`${warns.length} 条 warn（没测到 ≠ 通过，逐条按 docs/RELEASE-CHECKLIST.md 人工补）`);
  if (fails.length) {
    console.log(`  FAIL  ${fails.length} 项不通过 —— 不许继续下一步（上传会污染线上 releases.json）`);
    if (args.json === true) {
      console.log(JSON.stringify({ ok: false, version: pkg.version, versionCode: pkg.versionCode, fails, warns }, null, 2));
    }
    return EXIT_FAIL;
  }
  if (args.strict === true && warns.length) {
    console.log(`  FAIL  --strict：${warns.length} 条 warn 被当成失败`);
    return EXIT_FAIL;
  }
  console.log('  PASS  发版前自检通过');
  if (apkHash) console.log(`  下一步（上传）需要这个 sha256: ${apkHash.sha256}`);
  if (args.json === true) {
    console.log(
      JSON.stringify(
        { ok: true, version: pkg.version, versionCode: pkg.versionCode, apk: apkHash, apkInfo, warns },
        null,
        2,
      ),
    );
  }
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ReleaseEnvError) {
      console.error(`环境/用法错误: ${e.message}`);
      console.error(`\n${usage()}`);
      process.exit(EXIT_USAGE);
    }
    console.error(`内部错误: ${e && e.stack ? e.stack : e}`);
    process.exit(EXIT_USAGE);
  },
);
