#!/usr/bin/env node
/**
 * release-upload.mjs —— 把构建产物上传到 dl.rose7.cn（Issue #107 的「上传」这一步）。
 *
 * 它只做一件事：`POST https://dl.rose7.cn/api/v1/release`（multipart，Bearer 发布令牌），
 * 然后核对服务端返回的 sha256/md5/latest 与本地一致。不构建、不打 tag、不改仓库文件。
 *
 * 与 docs/RELEASE-MANUAL.md §5 里那条 curl 等价，但把「容易写错、写错了才发现」的部分做成了前置检查：
 *   - 令牌从哪来：--token-file / $DL_RELEASE_TOKEN_FILE / $DL_RELEASE_TOKEN / ~/.config/dl-release/token
 *     **缺令牌时在发请求之前就报错退出 2**（不会上传到一半、也不会打日志泄露令牌）
 *   - meta.changes 默认从 CHANGELOG.md 的 `## <version>` 段抽，避免手写漏条
 *   - 上传前先解 APK 内的 versionName/versionCode，与要发的 meta 比对：对不上就不发
 *   - 上传后核对 sha256（服务端自己算的那一份）—— 这是唯一能证明「发上去的就是我构建的那一份」的证据
 *
 * 用法：
 *   node scripts/release-upload.mjs --apk <apk>                     # 版本号取自 package.json，changes 取自 CHANGELOG
 *   node scripts/release-upload.mjs --apk <apk> --dry-run           # 只打印将要发的请求（不含令牌），不发
 *   node scripts/release-upload.mjs --apk <apk> --changes "新增：xxx" --changes "修复：yyy"
 *   node scripts/release-upload.mjs --apk <apk> --changes-file changes.txt
 *   pnpm run release:upload -- --apk <apk> [--dry-run]
 *
 * 退出码：
 *   0  服务端 ok:true 且 sha256/md5/latest 全部核对通过
 *   1  服务端拒绝或返回值与本地不一致（线上状态未知 → 按 docs/RELEASE-CHECKLIST.md §6 回滚/复核）
 *   2  用法 / 环境错误（缺令牌、缺 APK、版本号对不上……**一个字节都没上传**）
 *
 * 绝不打印令牌内容；日志里只出现来源与长度。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILD_TYPES,
  DEFAULT_ENDPOINT,
  MAX_APK_BYTES,
  ReleaseEnvError,
  buildTypeFor,
  changesFromChangelog,
  hashFile,
  inspectApk,
  isBuildType,
  log,
  parseArgs,
  readPackageVersion,
  resolveReleaseToken,
} from './release-common.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HINTS = {
  400: 'BAD_REQUEST —— multipart 字段名或 meta JSON 不对（字段必须是 apk + meta）；BODY 里 code=BAD_BUILD_TYPE 时是 buildType 只能是 stable|prerelease（Issue #330）；code=LOOPBACK_BUILD_REJECTED 时这个包是回环 consume 构建，只能本地联调（Issue #601）',
  401: 'UNAUTHORIZED —— 令牌不对/被轮换撤销；按 §4 重新注入，不要重试同一枚',
  404: 'NOT_FOUND —— 接口路径不对（应为 /api/v1/release）',
  409: 'VERSION_CONFLICT / VARIANT_CONFLICT —— versionCode 没超过线上 latest，或变体冲突；先跑 release-check --manifest',
  413: 'PAYLOAD_TOO_LARGE —— APK 超 50 MB',
  429: 'RATE_LIMITED —— 每 IP 每分钟 2 次，按响应的 Retry-After 等一会再试（上传这一步可以单独重试）',
  500: 'INTERNAL —— 服务端异常，先看服务日志；不要连续重试',
};

function usage() {
  return [
    '用法: node scripts/release-upload.mjs --apk <path> [选项]',
    '',
    '必填:',
    '  --apk <path>          构建产物（release 构建类型，非 debuggable）',
    '',
    '常用选项:',
    '  --dry-run             只打印将要发的请求（令牌只显示来源和长度），不发网络请求',
    '  --changes <一条>       用户可见变更，可重复；默认从 CHANGELOG.md 的 `## <version>` 段抽',
    '  --changes-file <path> 从文件读变更（一行一条）',
    '  --build-type <t>      stable / prerelease；默认按版本号判定',
    '  --version <v>         覆盖 package.json 的 version（不推荐：版本号唯一来源是 package.json）',
    '  --version-code <n>    覆盖 package.json 的 androidVersionCode（同上）',
    '  --token-file <path>   令牌文件（默认 ~/.config/dl-release/token，或 $DL_RELEASE_TOKEN）',
    '  --endpoint <url>      默认 ' + DEFAULT_ENDPOINT,
    '  --timeout <秒>        默认 120',
    '  --json                末尾打一份机器可读结果',
    '  -h, --help            本用法',
    '',
    '退出码: 0 上传成功且校验通过 / 1 服务端拒绝或回包不一致 / 2 用法或环境错误（什么都没发）',
  ].join('\n');
}

function readChangesFile(file, root) {
  const abs = path.resolve(root, file);
  if (!fs.existsSync(abs)) throw new ReleaseEnvError(`--changes-file 不存在：${abs}`);
  return fs
    .readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { flags: ['dry-run', 'json', 'help', 'h'], multi: ['changes'] });
  } catch (e) {
    console.error(`${e.message}\n\n${usage()}`);
    return EXIT_USAGE;
  }
  if (args.help || args.h) {
    console.log(usage());
    return EXIT_OK;
  }
  if (!args.apk) {
    console.error(`缺 --apk\n\n${usage()}`);
    return EXIT_USAGE;
  }

  const dryRun = args['dry-run'] === true;
  const endpoint = args.endpoint ? String(args.endpoint) : DEFAULT_ENDPOINT;
  const timeoutMs = Math.max(5, Number(args.timeout || 120)) * 1000;

  // ---- 1. 版本号（唯一来源 package.json，除非显式覆盖）----
  const pkg = readPackageVersion(ROOT);
  const version = args.version ? String(args.version).trim() : pkg.version;
  const versionCode =
    args['version-code'] !== undefined ? Number(String(args['version-code']).trim()) : pkg.versionCode;
  if (!version) throw new ReleaseEnvError(`拿不到 version：${pkg.errors.join('；') || 'package.json 缺 version'}，用 --version 显式给`);
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new ReleaseEnvError(`拿不到合法的 versionCode（package.json 的 androidVersionCode=${
      pkg.versionCode
    }），用 --version-code 显式给`);
  }
  // ---- 1b. buildType 白名单（Issue #330）----
  // Gradle 的 release/debug 是**构建类型**，不是 buildType；正式发布写 stable。
  // 2026-11-19 的 P0 就是这里放行了 "release"：客户端 parseManifest 整份清单拒收，
  // 全网更新失败却只显示「检查更新失败」。所以非法值在发任何请求之前就退出（exit 2）。
  const buildType = args['build-type'] ? String(args['build-type']).trim() : buildTypeFor(version);
  if (!isBuildType(buildType)) {
    throw new ReleaseEnvError(
      `--build-type 只能是 ${BUILD_TYPES.join('|')}，给的是 ${JSON.stringify(buildType)}。\n` +
        '  release/debug 是 Gradle 构建类型，不是 buildType（两者是不同维度）：\n' +
        '    assembleRelease + 正式发布 → stable\n' +
        '    预发布（版本号含 -alpha/-beta/-rc，或内部试用） → prerelease\n' +
        '    构建变体（内测包/标准包） → 那是 artifactVariant: internal|standard，不是 buildType',
    );
  }

  // ---- 2. 产物（本地真值）----
  const apkPath = path.resolve(ROOT, String(args.apk));
  const hash = hashFile(apkPath);
  if (hash.size === 0) throw new ReleaseEnvError(`产物是 0 字节：${apkPath}`);
  if (hash.size > MAX_APK_BYTES) {
    throw new ReleaseEnvError(`产物 ${hash.size} 字节，超过服务端上限 ${MAX_APK_BYTES}（50 MB），服务端会 413`);
  }
  const info = inspectApk(apkPath);
  if (info.debuggable === null) {
    throw new ReleaseEnvError(
      `这个文件解不成 APK（${info.debuggableReason}）—— 别把 web 产物 / 压缩包当 APK 传上去：${apkPath}`,
    );
  }
  if (info.debuggable === true) {
    throw new ReleaseEnvError(
      '这个包是 debuggable 构建（Issue #60），服务端会 400 APK_DEBUGGABLE 拒收；回构建机用 assembleRelease 重出',
    );
  }
  // 回环 consume 包（Issue #601）：本地先拦，别等服务端 400 —— 这个包在任何真机上都连不上后端
  // （127.0.0.1 指的是手机自己），只能配 adb reverse 本地联调，绝不该进任何分发通道。
  if (info.loopbackConsume === true) {
    throw new ReleaseEnvError(
      '这个包是回环 consume 构建（APK 内 LOOPBACK_CONSUME=true，consume.baseUrl 指向 127.0.0.1 / localhost）：' +
        '仅用于本地联调，服务端会 400 LOOPBACK_BUILD_REJECTED 拒收，现在不发（Issue #601）。' +
        '请把 config/endpoints.json 的 consume.baseUrl 换成 https 生产地址后重新出包（不要传 -PallowLoopbackConsume）。',
    );
  }
  if (info.versionName && info.versionName !== version) {
    throw new ReleaseEnvError(
      `APK 内的 versionName 是 ${info.versionName}，要发的 meta.version 是 ${version} —— 版本号对不上，不发`,
    );
  }
  if (typeof info.versionCode === 'number' && info.versionCode !== versionCode) {
    throw new ReleaseEnvError(
      `APK 内的 versionCode 是 ${info.versionCode}，要发的 meta.versionCode 是 ${versionCode} —— 版本号对不上，不发`,
    );
  }

  // ---- 3. changes（会进 releases.json 与 Release notes，必须是用户能看懂的话）----
  let changes = [];
  if (args.changes && args.changes.length) changes = args.changes.map((s) => String(s).trim()).filter(Boolean);
  else if (args['changes-file']) changes = readChangesFile(String(args['changes-file']), ROOT);
  else {
    const changelog = path.join(ROOT, 'CHANGELOG.md');
    if (fs.existsSync(changelog)) {
      const r = changesFromChangelog(fs.readFileSync(changelog, 'utf8'), version);
      if (r.found) changes = r.changes;
    }
  }
  if (!changes.length) {
    throw new ReleaseEnvError(
      `没有可发的 changes：CHANGELOG.md 里没有 \`## ${version}\` 段，也没给 --changes / --changes-file。\n` +
        '  changes 会原样进 releases.json 与 GitHub Release notes，不能空着发。',
    );
  }

  // ---- 4. 令牌（缺就在发请求之前退出）----
  const token = resolveReleaseToken({ tokenFile: args['token-file'], required: !dryRun });
  if (token.warning) log.warn(token.warning);

  const meta = { version, versionCode, buildType, changes };
  log.head('将上传的内容');
  log.info(`endpoint  ${endpoint}`);
  log.info(`apk       ${apkPath}`);
  log.info(`size      ${hash.size} 字节`);
  log.info(`sha256    ${hash.sha256}`);
  log.info(`md5       ${hash.md5}`);
  log.info(`meta      ${JSON.stringify({ version, versionCode, buildType, changes: `${changes.length} 条` })}`);
  for (const c of changes) log.info(`  changes: ${c}`);
  log.info(
    `令牌      ${token.token ? `已从 ${token.source} 读取（${String(token.token.length)} 个字符，内容不打印）` : '未提供（dry-run）'}`,
  );

  if (dryRun) {
    log.head('dry-run');
    log.ok('没有发任何网络请求；确认无误后去掉 --dry-run 再跑一次');
    if (args.json === true) {
      console.log(JSON.stringify({ dryRun: true, endpoint, meta, apk: hash, tokenSource: token.source }, null, 2));
    }
    return EXIT_OK;
  }

  // ---- 5. 发请求 ----
  log.head('POST /api/v1/release');
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  form.append('apk', new Blob([fs.readFileSync(apkPath)], { type: 'application/vnd.android.package-archive' }), path.basename(apkPath));

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.token}`, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ReleaseEnvError(
      `连不上 ${endpoint}（${e.message}）。这一步可以单独重试；连不上时线上没有发生任何改变。\n` +
        '  若本机需要代理访问外网，注意 dl.rose7.cn 通常直连可达，别把 GitHub 的代理套到它上面。',
    );
  }

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!res.ok || !body || body.ok !== true) {
    log.fail(`HTTP ${res.status}`);
    const hint = HINTS[res.status];
    if (hint) console.error(`  含义: ${hint}`);
    if (res.headers.get('retry-after')) console.error(`  Retry-After: ${res.headers.get('retry-after')} 秒`);
    console.error(`  响应: ${text.slice(0, 800)}`);
    console.error(
      '  线上可能已写入也可能没有 —— 先跑 `pnpm run release:verify` 看 releases.json 到底有没有这个版本，再决定重发还是回滚。',
    );
    if (args.json === true) console.log(JSON.stringify({ ok: false, status: res.status, body }, null, 2));
    return EXIT_FAIL;
  }

  // ---- 6. 核对回包（这是唯一能证明「发上去的就是我构建的那一份」的地方）----
  const problems = [];
  if (body.sha256 && String(body.sha256).toLowerCase() !== hash.sha256) {
    problems.push(`回包 sha256=${body.sha256}，本地=${hash.sha256}`);
  } else if (body.sha256) log.ok(`sha256 一致 ${body.sha256}`);
  else problems.push('回包没有 sha256，无法证明服务端存的是这一份（按契约应当返回）');

  if (body.md5 && String(body.md5).toLowerCase() !== hash.md5) {
    problems.push(`回包 md5=${body.md5}，本地=${hash.md5}`);
  } else if (body.md5) log.ok(`md5 一致 ${body.md5}`);

  if (body.latest !== undefined) {
    if (body.latest === version) log.ok(`latest = ${body.latest}`);
    else problems.push(`回包 latest=${body.latest}，期望 ${version}`);
  }
  if (body.artifactVariant !== undefined) {
    if (info.variant && body.artifactVariant !== info.variant) {
      problems.push(`回包 artifactVariant=${body.artifactVariant}，APK 内是 ${info.variant}`);
    } else {
      log.ok(`artifactVariant = ${body.artifactVariant}${info.variant ? '' : '（APK 内标记没读到，只记录不判定）'}`);
    }
  }
  if (body.url) log.info(`url ${body.url}`);

  if (problems.length) {
    log.head('结论');
    for (const p of problems) log.fail(p);
    console.error('  服务端已返回 ok:true，但回包与本地不一致 —— 停手，按 docs/RELEASE-CHECKLIST.md §6 处理。');
    if (args.json === true) console.log(JSON.stringify({ ok: false, body, apk: hash, problems }, null, 2));
    return EXIT_FAIL;
  }

  log.head('结论');
  log.ok('上传成功，服务端回包与本地 sha256/md5 一致');
  console.log(`  下一步: node scripts/release-verify.mjs --version ${version}   # 复核 releases.json 已生效`);
  if (args.json === true) console.log(JSON.stringify({ ok: true, body, apk: hash }, null, 2));
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ReleaseEnvError) {
      console.error(`环境/用法错误（一个字节都没上传）:\n  ${e.message}`);
      process.exit(EXIT_USAGE);
    }
    console.error(`内部错误: ${e && e.stack ? e.stack : e}`);
    process.exit(EXIT_USAGE);
  },
);
