// [layer: unit | 纯 Node（**不需要** GitHub 网络 / Android SDK / 真 APK）| 耗时: <1s]
//
// `scripts/audit-release.mjs` 判据表的**负向对照**（每一条都「构造坏输入 → 必须红 → 点名是哪一项」）。
//
// 为什么必须在 CI 里跑（而真跑那条命令不在 CI 里）：
//   · `node scripts/audit-release.mjs v1.4.8` 要下载 6.9 MB 资产 + 装好 aapt/aapt2/apksigner/apkanalyzer，
//     CI 上没有 SDK、也不该在门禁里访问 GitHub —— 于是「判据本身有牙齿」这件事在 CI 里就会永远没人验；
//   · 审计脚本的失效模式不是「崩了」，而是**静默地少判一条**（比如正文没写 sha256 被当成通过、
//     资产多了一个却没点名）。这种失效在真跑时长得和「通过」一模一样。
// 所以这里把外部世界全部换成桩（`deps` 注入），只留判据表本身跑真代码：
//   · **不下载任何 GitHub 资产**（`downloadAsset` 桩返回一个本地 4 KiB 假文件）；
//   · `gh` / `aapt` / `apkanalyzer` / `apksigner` 一律不执行（`run` 桩按工具名给输出）；
//   · 溯源判定用桩模块（真模块有自己的用例：`tests/unit/release-traceability.test.mjs`）。
//
// 五个必拍（任务要求）+ 四个补拍：
//   1. 资产多于 1 个      → exit 1，点名多出来的那几个
//   2. 正文缺 SHA-256     → WARN（**不是红**：没声明 ≠ 声明错了），且点明「正文没声明」
//   3. 正文禁词命中       → exit 1，点名禁词 + **行号**（且不把整行抄进报告）
//   4. tag 不在 origin/main → exit 1，点名共同祖先 / 该去 #651·#738 跟进
//   5. 缺 SDK 工具        → exit 2（判不了，fail-closed），**不**降级成单判据
//   6. 正文 SHA 与实际字节不一致 → exit 1（这是 sha256 那条判据真正要治的病）
//   7. 缺溯源脚本（#738 未落地） → exit 2 并点名 #738（绝不在这里抄第二份 ancestry 判定）
//   8. `--expect-version` 传错   → exit 1（「拿错包 / 拿错 tag」的负向对照）
//   9. 端点清单只报告不判红     → 全是内网地址也 exit 0，但清单里逐条列出来
//
// 另外钉住两个容易漂的细节：
//   · `parseBodyClaims` 要认**两种历史正文格式**（1.4.5 的表格 / 1.4.8 的 bullet），
//     且**不能**把「签名证书 SHA-256」那一行当成 APK 的字节摘要；
//   · 禁词**大小写敏感**：v1.4.7 正文里合法的接口错误码 `REFRESH_TOKEN_EXPIRED` 不许被判红。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNKNOWN,
  FORBIDDEN_NEEDLES,
  auditRelease,
  formatReport,
  main,
  parseArgs,
  parseBodyClaims,
  scanForbiddenWords,
} from '../../scripts/audit-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 一次性临时树（用例之间互不干扰；`after` 统一删） */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-release-test-'));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 4 KiB 假「APK」：内容固定，摘要才可预期（真 APK 只在真跑时出现） */
const FAKE_APK_BYTES = Buffer.alloc(4096, 0x41);
const FAKE_APK_SHA = createHash('sha256').update(FAKE_APK_BYTES).digest('hex');
const FAKE_APK_SIZE = FAKE_APK_BYTES.length;
const FAKE_CERT = 'e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1';
const FAKE_COMMIT = 'a'.repeat(40);

let assetSeq = 0;

/** 每次调用造一份新的假资产文件（避免用例之间互相覆盖） */
function makeFakeApk(name = 'deepseek-chat-1.4.8.apk') {
  assetSeq += 1;
  const dir = fs.mkdtempSync(path.join(TMP, `asset-${assetSeq}-`));
  const file = path.join(dir, name);
  fs.writeFileSync(file, FAKE_APK_BYTES);
  return file;
}

/** 溯源模块桩：只提供 audit-release 用到的那三个入口（真逻辑有自己的用例） */
function stubTraceability({ ancestor = true, commonAncestor = null } = {}) {
  return {
    MAIN_REF: 'origin/main',
    deriveRepo: () => ({ repo: 'zzy-repo/deepseek-app', source: 'stub:origin' }),
    resolveTagCommit: (tag) => ({ commit: FAKE_COMMIT, objectType: 'commit', objectSha: FAKE_COMMIT, tag }),
    ancestry: () => ({ ancestor, commonAncestor }),
  };
}

const OK_TOOLS = Object.freeze({
  ok: true,
  aapt2: '/sdk/build-tools/36.0.0/aapt2',
  aapt: '/sdk/build-tools/36.0.0/aapt',
  apkanalyzer: '/sdk/cmdline-tools/latest/bin/apkanalyzer',
  apksigner: '/sdk/build-tools/36.0.0/apksigner',
  version: '36.0.0',
  source: 'stub',
  dir: '/sdk/build-tools/36.0.0',
  androidHome: '/sdk',
});

const MISSING_TOOLS = Object.freeze({
  ok: false,
  missing: ['aapt', 'apkanalyzer'],
  detail: '缺工具：aapt / apkanalyzer（aapt 在 $ANDROID_HOME/build-tools/<版本>/，apkanalyzer 在 $ANDROID_HOME/cmdline-tools/<版本>/bin/）',
});

/** 外部命令桩：apkanalyzer / aapt 都说「干净」，apksigner 打印期望指纹 */
function stubRun(cmd, args) {
  const name = path.basename(cmd);
  if (name.startsWith('apkanalyzer')) {
    return { status: 0, error: null, stdout: '<manifest package="com.example.deepseekchat"/>\n', stderr: '', cmd: `${cmd} ${args.join(' ')}` };
  }
  if (name === 'aapt') {
    return { status: 0, error: null, stdout: "package: name='com.example.deepseekchat' versionCode='27' versionName='1.4.8'\n", stderr: '', cmd: `aapt ${args.join(' ')}` };
  }
  if (name.startsWith('apksigner')) {
    return {
      status: 0,
      error: null,
      stdout: `Signer #1 certificate SHA-256 digest: ${FAKE_CERT}\n`,
      stderr: '',
      cmd: `apksigner ${args.join(' ')}`,
    };
  }
  if (name === 'sha256sum') {
    return { status: 0, error: null, stdout: `${FAKE_APK_SHA}  ${args[0]}\n`, stderr: '', cmd: 'sha256sum' };
  }
  if (name === 'openssl') {
    return { status: 0, error: null, stdout: `SHA2-256(stdin)= ${FAKE_APK_SHA}\n`, stderr: '', cmd: 'openssl' };
  }
  return { status: 127, error: new Error(`桩没实现这个命令：${cmd}`), stdout: '', stderr: '', cmd };
}

const PASS_VERIFY = Object.freeze({
  ok: true,
  exitCode: EXIT_OK,
  conclusion: 'PASS',
  failing: [],
  unknown: [],
  insecure: false,
  info: { packageName: 'com.example.deepseekchat', versionName: '1.4.8', versionCode: 27, sha256: FAKE_APK_SHA, md5: 'md5', size: FAKE_APK_SIZE },
});

/**
 * 一份「除署名判据外全绿」的 release 元数据。
 * 正文用 1.4.8 的真实形状（bullet 列表），要测表格形状就覆盖 `body`。
 */
function goodRelease(overrides = {}) {
  const body = [
    '## 1.4.8 — 账户与消费改为设置里的一级整页（#727）',
    '',
    '**安装包**',
    `- 大小：**${FAKE_APK_SIZE}** 字节`,
    `- sha256：\`${FAKE_APK_SHA}\``,
    `- 签名证书 SHA-256：\`${FAKE_CERT}\``,
    '',
  ].join('\n');
  return {
    tagName: 'v1.4.8',
    isDraft: false,
    isPrerelease: false,
    targetCommitish: FAKE_COMMIT,
    publishedAt: '2026-11-21T11:30:16Z',
    body,
    assets: [
      { name: 'deepseek-chat-1.4.8.apk', size: FAKE_APK_SIZE, url: 'https://example.invalid/a.apk', state: 'uploaded' },
    ],
    ...overrides,
  };
}

/** 审计跑一次的完整依赖桩（**不碰网络、不执行真工具**） */
function stubDeps(overrides = {}) {
  const apkFile = overrides.apkFile ?? makeFakeApk();
  return {
    run: stubRun,
    getRelease: async () => ({ ok: true, release: overrides.release }),
    downloadAsset: async () => ({ ok: true, file: apkFile }),
    resolveTools: () => overrides.tools ?? OK_TOOLS,
    evaluateDebuggable: () => ({ verdict: 'clean', reason: '无 android:debuggable', info: {} }),
    verifyApk: async () => overrides.verifyResult ?? PASS_VERIFY,
    expectedCert: { value: FAKE_CERT, source: 'config/appIdentity.json' },
    loadTraceability: async () => (overrides.traceability === undefined ? stubTraceability(overrides.ancestry ?? {}) : overrides.traceability),
    computeDigests: () => ({ results: [{ tool: 'node:crypto', value: FAKE_APK_SHA }], agree: true, value: FAKE_APK_SHA }),
    extractEndpoints: () => ({ ok: true, hosts: [], scanned: [], skipped: [] }),
    now: () => '2026-11-21T12:00:00.000Z',
    mktemp: () => fs.mkdtempSync(path.join(TMP, 'run-')),
    ...overrides.deps,
  };
}

const runAudit = (options) => auditRelease({
  tag: 'v1.4.8',
  root: ROOT,
  deps: stubDeps(options),
  ...(options.audit ?? {}),
});

const checkOf = (result, id) => result.checks.find((entry) => entry.id === id);

// ---------------------------------------------------------------- 必拍 1/5

test('资产多于 1 个 → exit 1，并点名多出来的资产', async () => {
  const release = goodRelease({
    assets: [
      { name: 'deepseek-chat-1.4.8.apk', size: FAKE_APK_SIZE, url: 'u1', state: 'uploaded' },
      { name: 'deepseek-chat-1.4.8-debug.apk', size: 1234, url: 'u2', state: 'uploaded' },
      { name: 'notes.txt', size: 12, url: 'u3', state: 'uploaded' },
    ],
  });
  const result = await runAudit({ release });

  assert.equal(result.exitCode, EXIT_FAIL, '资产不唯一必须红');
  const check = checkOf(result, 'assets');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /3 个资产/);
  assert.match(check.detail, /deepseek-chat-1\.4\.8-debug\.apk/);
  assert.match(check.detail, /notes\.txt/);
  assert.equal(
    checkOf(result, 'assets').followUp.ref,
    '#652（发布单）',
    '「该去哪个单跟进」必须落在发布单上，而不是让人自己去猜',
  );
});

test('资产为 0 个 → 判不了（exit 2），不当成「通过」', async () => {
  const result = await runAudit({ release: goodRelease({ assets: [] }) });
  assert.equal(result.exitCode, EXIT_UNKNOWN);
  assert.equal(checkOf(result, 'assets').status, 'unknown');
});

test('正文缺 SHA-256 → WARN（不是红），且点明「正文没声明」', async () => {
  const body = [
    '## 1.4.8',
    '',
    `- 大小：**${FAKE_APK_SIZE}** 字节`,
    '- 签名证书 SHA-256：`' + FAKE_CERT + '`',
    '',
  ].join('\n');
  const result = await runAudit({ release: goodRelease({ body }) });

  const check = checkOf(result, 'sha256');
  assert.equal(check.status, 'warn', '「没声明」是 WARN，「声明错了」才是 FAIL');
  assert.match(check.detail, /正文没声明 SHA-256/);
  assert.equal(result.exitCode, EXIT_OK, '只有 WARN 时不该红（否则没人会去补正文，只会去关掉门禁）');
  assert.deepEqual(result.warnings, ['sha256']);
});

test('正文禁词命中 → exit 1，点名禁词与行号，且不把整行抄进报告', async () => {
  const body = [
    '## 1.4.8',
    '',
    // check-endpoints-allow: 这是**被测数据**（正文禁词检测的样本），不是产品端点；本用例就是靠它变红的
    '接口直连 http://140.210.13.146:60010/api/v1 联调即可',
    `- sha256：\`${FAKE_APK_SHA}\``,
    `- 大小：**${FAKE_APK_SIZE}** 字节`,
    '',
    '清单在 /var/www/dl/releases.json',
    '',
  ].join('\n');
  const result = await runAudit({ release: goodRelease({ body }) });

  assert.equal(result.exitCode, EXIT_FAIL);
  const check = checkOf(result, 'forbidden-words');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /140\.210\./);
  assert.match(check.detail, /第 3 行/, '必须点名行号，否则人去正文里找不着');
  assert.match(check.detail, /\/var\/www/);
  assert.match(check.detail, /第 7 行/);
  assert.ok(!check.detail.includes('60010'), '报告不许把命中的内网地址整行抄出来（报告会进 Issue / CI 日志）');
});

test('tag 不在 origin/main → exit 1，点名共同祖先与该去哪个单', async () => {
  const result = await runAudit({
    release: goodRelease(),
    ancestry: { ancestor: false, commonAncestor: 'b'.repeat(40) },
  });

  assert.equal(result.exitCode, EXIT_FAIL);
  const check = checkOf(result, 'ancestry');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /\*\*不是\*\* origin\/main 的祖先/);
  assert.match(check.detail, /bbbbbbbb/, '要给出共同祖先，否则「重指 tag」这件事没法下手');
  assert.ok(
    result.followUps.some((entry) => entry.id === 'ancestry' && entry.ref.includes('#738')),
    '必须指到溯源门禁那个单（#651 / #738）',
  );
});

test('缺 SDK 工具（aapt / apkanalyzer）→ exit 2（判不了），不降级成单判据', async () => {
  const result = await runAudit({ release: goodRelease(), tools: MISSING_TOOLS });

  assert.equal(result.exitCode, EXIT_UNKNOWN, '缺工具时只能是「判不了」，不能是「通过」');
  const check = checkOf(result, 'debuggable');
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /缺工具：aapt \/ apkanalyzer/);
  assert.equal(checkOf(result, 'cert').status, 'unknown', 'apksigner 也在 build-tools 里，同样判不了');
  assert.ok(result.unknown.includes('cert'));
});

// ---------------------------------------------------------------- 补拍

test('正文 SHA-256 与资产实际字节不一致 → exit 1，两个值都点名', async () => {
  const wrong = 'f'.repeat(64);
  const result = await runAudit({
    release: goodRelease({
      body: [`- 大小：**${FAKE_APK_SIZE}** 字节`, `- sha256：\`${wrong}\``, ''].join('\n'),
    }),
  });

  assert.equal(result.exitCode, EXIT_FAIL);
  const check = checkOf(result, 'sha256');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, new RegExp(wrong));
  assert.match(check.detail, new RegExp(FAKE_APK_SHA));
});

test('大小与正文不一致 → exit 1（三处：正文 / 元数据 / 本地）', async () => {
  const result = await runAudit({
    release: goodRelease({
      body: ['- 大小：**9999** 字节', `- sha256：\`${FAKE_APK_SHA}\``, ''].join('\n'),
    }),
  });
  assert.equal(result.exitCode, EXIT_FAIL);
  const check = checkOf(result, 'size');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /9999/);
  assert.match(check.detail, new RegExp(String(FAKE_APK_SIZE)));
});

test('缺溯源脚本（#738 未落地）→ exit 2 并点名 #738，不抄第二份判定', async () => {
  const result = await runAudit({ release: goodRelease(), traceability: null });

  assert.equal(result.exitCode, EXIT_UNKNOWN);
  const check = checkOf(result, 'ancestry');
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /check-release-traceability\.mjs/);
  assert.match(check.detail, /#738/);
});

test('--expect-version 传错 → exit 1（拿错包 / 拿错 tag 的负向对照）', async () => {
  const result = await runAudit({
    release: goodRelease(),
    audit: { expectVersion: '1.4.7' },
  });

  assert.equal(result.exitCode, EXIT_FAIL);
  const check = checkOf(result, 'expect-version');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /versionName=1\.4\.8/);
  assert.match(check.detail, /≠ 期望 1\.4\.7/);
});

test('--expect-version 对得上 → PASS，并把 versionCode 带出来', async () => {
  const result = await runAudit({ release: goodRelease(), audit: { expectVersion: '1.4.8' } });
  assert.equal(result.exitCode, EXIT_OK);
  const check = checkOf(result, 'expect-version');
  assert.equal(check.status, 'pass');
  assert.match(check.detail, /versionCode=27/);
});

test('包内端点清单只报告不判红（含内网地址也 exit 0，但清单要列出来）', async () => {
  const result = await runAudit({
    release: goodRelease(),
    deps: {
      extractEndpoints: () => ({
        ok: true,
        hosts: [
          { url: 'https://sub2api.rose7.cn', count: 2, note: null },
          // check-endpoints-allow: 被测数据（包内端点清单的样本），用于验证只报告不判红
          { url: 'http://140.210.13.146:60010', count: 2, note: null },
          { url: 'http://127.0.0.1:18000', count: 1, note: '回环' },
        ],
        scanned: ['assets/public/static/js/main.abc.js'],
        skipped: [],
      }),
    },
  });

  assert.equal(result.exitCode, EXIT_OK, '端点清单是报告，不是门禁（判它是 #745 的活）');
  assert.equal(checkOf(result, 'endpoints').status, 'pass');
  const report = formatReport(result);
  assert.match(report, /https:\/\/sub2api\.rose7\.cn/);
  assert.match(report, /140\.210\.13\.146:60010/);
  assert.match(report, /← 回环/);
});

test('draft release → exit 2 并说明「draft 不是发布物」', async () => {
  const result = await runAudit({ release: goodRelease({ isDraft: true }) });
  assert.equal(result.exitCode, EXIT_UNKNOWN);
  const check = checkOf(result, 'release-published');
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /draft/);
});

test('包内 INSECURE_CONSUME=true 且没带 --allow-insecure → exit 1，并提示「加 --allow-insecure 只用于 staging 联调」', async () => {
  const seen = [];
  const insecureResult = {
    ...PASS_VERIFY,
    ok: false,
    exitCode: EXIT_FAIL,
    conclusion: 'FAIL',
    failing: ['insecure'],
    insecure: true,
  };
  const result = await runAudit({
    release: goodRelease(),
    verifyResult: insecureResult,
    deps: {
      verifyApk: async (options) => {
        seen.push(options);
        return insecureResult;
      },
    },
  });

  assert.equal(result.exitCode, EXIT_FAIL);
  const check = checkOf(result, 'verify-apk');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /不过的项：insecure/);
  assert.match(check.detail, /--allow-insecure/, '要把「怎么放行 / 为什么不该放行」直接写在红的那一行');
  assert.match(check.detail, /staging/);
  assert.equal(seen[0].allowInsecure, false, '默认不认可明文联调包');
  assert.equal(seen[0].variant, 'standard', '五件套固定按 standard 变体验（这是公开渠道的包）');
});

test('--allow-insecure 透传给 verify:apk（staging 联调包的显式放行）', async () => {
  const seen = [];
  const result = await runAudit({
    release: goodRelease(),
    audit: { allowInsecure: true },
    deps: {
      verifyApk: async (options) => {
        seen.push(options);
        return PASS_VERIFY;
      },
    },
  });
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(seen[0].allowInsecure, true);
});

test('全绿时 exit 0，报告里逐项写 PASS 且给出「无阻塞项」', async () => {
  const result = await runAudit({ release: goodRelease() });
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.failing, []);
  const report = formatReport(result);
  assert.match(report, /结论: PASS/);
  assert.match(report, /无阻塞项/);
});

// --------------------------------------------------- 纯函数（解析口径钉死）

test('parseBodyClaims 认两种历史正文格式（表格 / bullet）', () => {
  const table = [
    '| 项 | 值 |',
    '| --- | --- |',
    '| 大小 | 6891043 bytes（6.57 MiB） |',
    '| SHA-256 | `6675ad4ae91dfe73285ee19f85cc7884628b74b0ff2247a7d6dd1a085c305fe6` |',
    '| 签名证书 SHA-256 | `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1` |',
  ].join('\n');
  const bullet = [
    '- 大小：**6898447** 字节',
    '- sha256：`2ab90fdf4c445ceb65bd3316929cff737339ac04d0286e5f9cc3265892b45b94`',
    '- 签名证书 SHA-256：`e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`',
  ].join('\n');

  const fromTable = parseBodyClaims(table);
  assert.equal(fromTable.sha256.value, '6675ad4ae91dfe73285ee19f85cc7884628b74b0ff2247a7d6dd1a085c305fe6');
  assert.equal(fromTable.sha256.line, 4);
  assert.equal(fromTable.size.value, 6891043, '`6.57 MiB` 那种小数不许被当成字节数');

  const fromBullet = parseBodyClaims(bullet);
  assert.equal(fromBullet.sha256.value, '2ab90fdf4c445ceb65bd3316929cff737339ac04d0286e5f9cc3265892b45b94');
  assert.equal(fromBullet.size.value, 6898447);

  assert.equal(parseBodyClaims('没有声明').sha256, null);
  assert.equal(parseBodyClaims('没有声明').size, null);
});

test('禁词扫描大小写敏感：REFRESH_TOKEN_EXPIRED 不算命中，小写 token= 算', () => {
  assert.equal(scanForbiddenWords('刷新失败（`REFRESH_TOKEN_EXPIRED`）→ 清理登录态').hits.length, 0);
  const hits = scanForbiddenWords('地址里带了 ?token=abc').hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].needle, 'token');
  assert.equal(hits[0].line, 1);
  assert.ok(FORBIDDEN_NEEDLES.some((entry) => entry.needle === 'primaryBase'));
});

test('parseArgs 与 main 的用法层出口（不联网、不下载）', async () => {
  const options = parseArgs(['v1.4.8', '--expect-version', '1.4.8', '--allow-insecure', '--json']);
  assert.equal(options.tag, 'v1.4.8');
  assert.equal(options.expectVersion, '1.4.8');
  assert.equal(options.allowInsecure, true);
  assert.equal(options.json, true);

  assert.throws(() => parseArgs(['v1.4.8', '--expect-version']), /需要一个版本号/);
  assert.throws(() => parseArgs(['v1.4.8', '--nope']), /未知参数/);

  // 用法层出口不碰网络，但会往 stdout/stderr 打 usage —— 用例里收进口袋，别把测试输出刷成手册
  const printed = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => printed.push(args.join(' '));
  console.error = (...args) => printed.push(args.join(' '));
  try {
    assert.equal(await main(['--help']), EXIT_OK);
    assert.equal(await main([]), EXIT_UNKNOWN, '不给 tag = 用法错误（exit 2），不是「全都查过了」');
    assert.equal(await main(['--nope']), EXIT_UNKNOWN);
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.ok(printed.some((line) => line.includes('用法: node scripts/audit-release.mjs')), '用法错时必须把用法打出来');
});
