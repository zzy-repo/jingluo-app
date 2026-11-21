// [layer: unit | 纯 Node + 本机 Android SDK build-tools（缺工具时**声明期** SKIP）| 耗时: ~20s]
//
// 「发布 APK 五件套校验」的用例（Issue #607；第 5 项 INSECURE_CONSUME 是 #601 守卫的补正面）。
// 被测脚本：`scripts/verify-release-apk.mjs`。
//
// 这个文件要回答的只有三个问题，别把它写成「脚本能跑」：
//   1. **五项都在**：debuggable / ARTIFACT_VARIANT / LOOPBACK_CONSUME / 证书 / INSECURE_CONSUME
//      —— 少一项就是「五件套」三个字在骗人；
//   2. **每项都会真的红**：五种坏包（debuggable / 变体不对 / 回环标记 / 换签证书 / 明文联调包没带
//      --allow-insecure）各自 **exit 1**，并且**点名**是哪一项挂了（`结论：FAIL（debuggable 不通过）`
//      这行，不是「反正红了」）；反过来，明文联调包带 `--allow-insecure` 必须过、且结论行标
//      `INSECURE(staging-only)`（打得出来，但别读成「可以公开发布」）；
//   3. **判不出来 ≠ 通过**：缺 aapt2 / 不是 APK / 文件不存在 → **exit 2**（fail-closed，
//      与 `check-apk-debuggable` 同一口径 —— #60 的事故就是靠「判不出来就当没事」漏出去的）。
//
// 第 4 节（#705）另钉一条：期望指纹**只许**从 `config/appIdentity.json` 派生（脚本里不许留任何
// 字面量，含注释），配置读不到 / 非法 → **exit 2**（fail-closed，绝不回落到内置默认值），并且
// 「这次比的是哪来的期望值」必须写进结论行与 `--json` 的 `expectCertSource`。
//
// 夹具口径（为什么不是把真包拷进仓库）见 `tests/helpers/apk-release-fixtures.mjs` 的文件头：
// 真包 6.8 MB、四种坏包线上拼不出来，所以清单用域10 的合成编码器现场造，再用 apksigner 真签名。
// **真 APK 实包**的验证在 `docs/RELEASE-MANUAL.md` §4.6 要求发版前/后各跑一次（1.4.3 的输出抄在那里）。
//
// 缺 SDK 时：造夹具的那批用例在**声明期** SKIP（`skipReason()`），不是用例体里 `test.skip?.() return`
// —— 后者会被 node:test 记成 ok（#95 的教训：CI 里「没跑」和「通过」长得一模一样）。
// 纯函数的几条（解析器 / 常量一致性 / 导入无副作用）**不需要 SDK**，在 CI 里照样真跑。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECKS,
  CERT_SOURCE_CLI,
  CERT_SOURCE_CONFIG,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNKNOWN,
  parseBadgingVersion,
  parseCertDigests,
  resolveExpectCert,
  verifyReleaseApk,
} from '../../scripts/verify-release-apk.mjs';
import {
  publishedCertSha256,
  resolveExpectedCertSha256,
} from '../../scripts/lib/certFingerprint.mjs';
import { buildFixtures, cleanupFixtures, skipReason } from '../helpers/apk-release-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts', 'verify-release-apk.mjs');

/** 跑一次 CLI，返回 spawn 结果（`status` 就是被测的退出码） */
const runCli = (args, { env = {} } = {}) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180_000,
  env: { ...process.env, LANG: process.env.LANG ?? 'zh_CN.UTF-8', ...env },
});
const combined = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`;

/**
 * 仓库里「已发布证书」的期望值（#705 之后脚本里**没有**它的副本，测试也只从唯一来源读）。
 * 注意：这是**读配置**，不是把值抄进测试 —— 抄进来就又是第 N 份副本。
 */
const CONFIG_CERT = resolveExpectedCertSha256(ROOT).value;

/** 造一个只含 `config/appIdentity.json` 的临时仓库根（证明派生 / 缺失 / 非法三条路径） */
function makeRoot(identity) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-apk-root-'));
  if (identity !== undefined) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'appIdentity.json'), identity);
  }
  return root;
}

/** 夹具只能在用例里造（声明期造 = CI 上无 SDK 时整文件崩），跑完删 */
const fixtures = () => buildFixtures();
after(() => cleanupFixtures());

const SKIP_REASON = skipReason();
/**
 * node:test 的一个坑：`{ skip: null }` **也会被判成跳过**（Node 24 实测：用例体照跑，结果却记成 SKIP）。
 * 所以「能造夹具」时干脆不传 skip 字段 —— 用 `undefined` 也不安全，只能条件展开。
 */
const SKIP = SKIP_REASON ? { skip: SKIP_REASON } : {};

// ────────────────────────────── 1. 「五项都在」与常量一致性（不需要 SDK） ──────────────────────────────

test('五件套就是五项，顺序与 id 固定（少一项 = 报告里会少一行）', () => {
  assert.deepEqual(CHECKS.map((item) => item.id), ['debuggable', 'variant', 'loopback', 'cert', 'insecure']);
  for (const item of CHECKS) assert.match(item.title, /^\d+ /, '每项都要带序号，表格里靠它跟 --json 对齐');
});

test('脚本里没有证书指纹字面量（#705：第三份副本已删，期望值只能从配置派生）', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-release-apk.mjs'), 'utf8');
  // 与验收口径同一条：`grep -c "e7c5baee" scripts/verify-release-apk.mjs` 必须是 0。
  // 注释里留一句「旧值」也不行 —— 下一个人照样会去改注释而不是改配置。
  assert.equal((script.match(/e7c5baee/g) ?? []).length, 0, '脚本里还有已发布指纹的字面量（含注释）：期望值只许来自 config/appIdentity.json');
  assert.equal((script.match(/[0-9a-f]{64}/g) ?? []).length, 0, '脚本里还有 64 位 hex 字面量：那就是第 N 份副本');
  assert.doesNotMatch(script, /EXPECTED_CERT_SHA256\s*=/, '脚本里还有 EXPECTED_CERT_SHA256 赋值（硬编码默认值）');
  // 唯一来源本身仍然是「已发布证书」：配置被动过 → 这条先红（#702 的闸，别在改脚本时把它弄丢）
  assert.match(CONFIG_CERT, /^[0-9a-f]{64}$/, 'config/appIdentity.json 里没有可用的 expectedCertSha256');
  assert.equal(CONFIG_CERT, publishedCertSha256(), '配置里的指纹与 PUBLISHED_IDENTITY 不一致：换证书是发布级迁移，不许只改一处');
  // 派生结果必须指认来源，不能只给一个「反正有个值」
  assert.equal(resolveExpectedCertSha256(ROOT).source, CERT_SOURCE_CONFIG);
});

test('import 校验脚本/check-apk-debuggable 不会顺带跑 CLI（复用方不该被副作用带走）', () => {
  // `check-apk-debuggable.mjs` 原来在模块顶层直接 `process.exitCode = main(...)`：一旦被 import，
  // 无参数调用会把退出码设成 2 —— 复用它的 verify-release-apk 会「永远 exit 2」。
  const probe = spawnSync(process.execPath, [
    '-e',
    "Promise.all([import('./scripts/check-apk-debuggable.mjs'), import('./scripts/verify-release-apk.mjs')]).then(() => console.log('imported'))",
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(probe.status, 0, `import 过程弄脏了退出码：${combined(probe)}`);
  assert.match(probe.stdout, /imported/);
  assert.doesNotMatch(combined(probe), /用法:/, 'import 时打印了 CLI 用法 = 顶层在跑 main');
});

test('解析器：badging 首行的 versionName / versionCode / packageName', () => {
  const line = "package: name='com.example.deepseekchat' versionCode='22' versionName='1.4.3' platformBuildVersionName='16'";
  assert.deepEqual(parseBadgingVersion(line), {
    packageName: 'com.example.deepseekchat',
    versionName: '1.4.3',
    versionCode: 22,
  });
  assert.deepEqual(parseBadgingVersion(''), {});
  assert.deepEqual(parseBadgingVersion(null), {});
});

test('解析器：apksigner --print-certs 的 SHA-256（多 signer 全收，十六进制统一小写）', () => {
  const out = [
    'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug',
    `Signer #1 certificate SHA-256 digest: ${CONFIG_CERT.toUpperCase()}`,
    'Signer #1 certificate SHA-1 digest: 1bf254cc4881ca14a32379b7c487de4ad9548b5e',
  ].join('\n');
  assert.deepEqual(parseCertDigests(out), [CONFIG_CERT]);
  assert.deepEqual(parseCertDigests('no certs here'), []);
  assert.deepEqual(parseCertDigests(undefined), []);
});

// ────────────────────────────── 2. 判不出来（exit 2，fail-closed；不需要 SDK） ──────────────────────────────

test('缺 aapt2 / 没有 build-tools → exit 2，且提示装 SDK（不许「没工具就当通过」）', () => {
  const emptySdk = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-apk-nosdk-'));
  try {
    const result = runCli([path.join(ROOT, 'package.json')], {
      env: { ANDROID_HOME: emptySdk, ANDROID_SDK_ROOT: '', BUILD_TOOLS_VERSION: '' },
    });
    assert.equal(result.status, EXIT_UNKNOWN, `缺 SDK 必须 exit 2，实际 ${result.status}\n${combined(result)}`);
    // 顺带证明：错的是「工具缺失」，不是被误判成 APK 有问题
    assert.match(combined(result), /装 Android SDK 的 build-tools/);
    assert.match(combined(result), /sdkmanager|BUILD_TOOLS_VERSION/);
    assert.match(combined(result), /UNKNOWN/);
  } finally {
    fs.rmSync(emptySdk, { recursive: true, force: true });
  }
});

test('不是 APK（一段文本）→ exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-apk-junk-'));
  try {
    const junk = path.join(dir, 'not-an-apk.apk');
    fs.writeFileSync(junk, '这不是 zip，也不是 APK\n');
    const result = runCli([junk]);
    assert.equal(result.status, EXIT_UNKNOWN, combined(result));
    assert.match(combined(result), /UNKNOWN/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在 / 少参数 / 变体名非法 → exit 2 且给用法', () => {
  const missing = runCli([path.join(ROOT, 'no-such-file.apk')]);
  assert.equal(missing.status, EXIT_UNKNOWN, combined(missing));
  assert.match(combined(missing), /读不到 APK/);

  const noArgs = runCli([]);
  assert.equal(noArgs.status, EXIT_UNKNOWN);
  assert.match(combined(noArgs), /用法:/);

  const badVariant = runCli([path.join(ROOT, 'package.json'), '--variant', 'beta']);
  assert.equal(badVariant.status, EXIT_UNKNOWN);
  assert.match(combined(badVariant), /--variant 只能是 internal \/ standard/);
});

// ────────────────────────────── 3. 正例 + 四种负向对照（需要 SDK：真签名夹具） ──────────────────────────────
//
// `expect.code` = 退出码；`expect.conclusion` = 「结论」行必须**点名**的那一项
// （正例是 `PASS（5/5 项通过）`，负例是 `FAIL（<id> 不通过）`）——「红了但不知道红在哪」不算咬住。

const ROWS = [
  {
    id: 'P1',
    what: '干净 standard 包（LOOPBACK_CONSUME=false）：四项全绿',
    fixture: 'clean',
    expect: { code: EXIT_OK, conclusion: /结论：PASS（5\/5 项通过）—— 可以发布。/ },
  },
  {
    id: 'P2',
    what: '老包没有 LOOPBACK_CONSUME 标记 → 缺失视为通过（不误伤历史包）',
    fixture: 'noLoopback',
    expect: { code: EXIT_OK, conclusion: /结论：PASS（5\/5 项通过）/, also: /标记缺失（视为 false）/ },
  },
  {
    id: 'P3',
    what: '--variant internal 验 internal 包 → 通过（变体是参数，不是写死 standard）',
    fixture: 'internal',
    args: ['--variant', 'internal'],
    expect: { code: EXIT_OK, conclusion: /结论：PASS（5\/5 项通过）/, also: /internal/ },
  },
  {
    id: 'N1',
    what: 'debuggable 包 → exit 1，且点名 debuggable',
    fixture: 'debuggable',
    expect: { code: EXIT_FAIL, conclusion: /结论：FAIL（debuggable 不通过）/, also: /FAIL\s+android:debuggable="true"/ },
  },
  {
    id: 'N2',
    what: '变体是 internal 但期望 standard → exit 1，且点名 variant',
    fixture: 'internal',
    expect: { code: EXIT_FAIL, conclusion: /结论：FAIL（variant 不通过）/, also: /FAIL\s+internal/ },
  },
  {
    id: 'N3',
    what: 'LOOPBACK_CONSUME=true（回环包）→ exit 1，且点名 loopback',
    fixture: 'loopbackTrue',
    expect: { code: EXIT_FAIL, conclusion: /结论：FAIL（loopback 不通过）/, also: /FAIL\s+true/ },
  },
  {
    id: 'N4',
    what: '证书不是期望那把（换签了）→ exit 1，且点名 cert',
    fixture: 'certMismatch',
    expect: { code: EXIT_FAIL, conclusion: /结论：FAIL（cert 不通过）/, also: /FAIL\s+[0-9a-f]{64}/ },
  },
  {
    id: 'N5',
    what: 'INSECURE_CONSUME=true（明文联调包）不带 --allow-insecure → exit 1，且点名 insecure + 「禁止公开分发」',
    fixture: 'insecureTrue',
    expect: {
      code: EXIT_FAIL,
      conclusion: /结论：FAIL（insecure 不通过）/,
      also: /明文联调包，禁止公开分发/,
    },
  },
  {
    id: 'P6',
    what: '同一个明文联调包 + --allow-insecure → 通过，但结论行强制标 INSECURE(staging-only)',
    fixture: 'insecureTrue',
    args: ['--allow-insecure'],
    expect: {
      code: EXIT_OK,
      conclusion: /结论：PASS（5\/5 项通过）—— \*\*INSECURE\(staging-only\)\*\*/,
      also: /禁止公开分发/,
    },
  },
];

for (const row of ROWS) {
  test(`${row.id} ${row.what}`, SKIP, () => {
    const built = fixtures();
    const result = runCli([
      built.apks[row.fixture],
      '--expect-cert', built.certA,
      ...(row.args ?? []),
    ]);
    assert.equal(
      result.status,
      row.expect.code,
      `${row.id} 退出码应为 ${row.expect.code}，实际 ${result.status}\n--- 输出 ---\n${combined(result)}`,
    );
    assert.match(combined(result), row.expect.conclusion);
    if (row.expect.also) assert.match(combined(result), row.expect.also);
    // 附加输出必须在（Release 正文直接用）：sha256 / size / versionName 三样齐
    assert.match(combined(result), /sha256\s+:\s+[0-9a-f]{64}/);
    assert.match(combined(result), /size\s+:\s+\d/);
    assert.match(combined(result), /versionName\s+:\s+1\.4\.0/);
  });
}

test('P4 --expect-cert 真的在驱动第 4 项（换签包配自己那把指纹 → 通过）', SKIP, () => {
  const built = fixtures();
  const asExpected = runCli([built.apks.certMismatch, '--expect-cert', built.certB]);
  assert.equal(asExpected.status, EXIT_OK, `把期望证书换成这把就该过（说明不是写死常量）\n${combined(asExpected)}`);
  // 反过来：同一把 B 证书配 A 的指纹必须红 —— 与 N4 同一判据，这里是为了证明「过的原因是对的」
  const asOther = runCli([built.apks.certMismatch, '--expect-cert', built.certA]);
  assert.equal(asOther.status, EXIT_FAIL);
  assert.match(combined(asOther), /结论：FAIL（cert 不通过）/);
});

test('P5 --json 是结构化结果（workflow / 脚本消费的那份形状）', SKIP, () => {
  const built = fixtures();
  const result = runCli([built.apks.clean, '--expect-cert', built.certA, '--json']);
  assert.equal(result.status, EXIT_OK, combined(result));
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(report.conclusion, 'PASS');
  assert.equal(report.variant, 'standard');
  assert.equal(report.expectedCert, built.certA);
  assert.equal(report.expectCertSource, CERT_SOURCE_CLI, '--expect-cert 显式传入时来源要标 CLI（复核的人靠它）');
  assert.deepEqual(report.checks.map((item) => item.id), ['debuggable', 'variant', 'loopback', 'cert', 'insecure']);
  assert.equal(report.insecure, false, '干净包的 insecure 必须是 false');
  for (const item of report.checks) {
    assert.equal(item.status, 'pass', `${item.id} 应为 pass：${JSON.stringify(item)}`);
    assert.ok(item.title, '每项都要带 title（--json 消费方靠它做提示）');
  }
  assert.deepEqual(report.failing, []);
  // 附加输出：Release 正文直接用，形状不能变
  assert.equal(report.info.versionName, '1.4.0');
  assert.equal(report.info.versionCode, 18);
  assert.match(report.info.sha256, /^[0-9a-f]{64}$/);
  assert.match(report.info.md5, /^[0-9a-f]{32}$/);
  assert.ok(report.info.size > 0);
  assert.ok(report.buildTools.version, 'buildTools.version 要报出来（核对用的工具是哪一档）');

  // 红的那一版：--json 也要能直接读出「哪几项挂了」
  const red = runCli([built.apks.debuggable, '--expect-cert', built.certA, '--json']);
  assert.equal(red.status, EXIT_FAIL);
  const redReport = JSON.parse(red.stdout);
  assert.equal(redReport.conclusion, 'FAIL');
  assert.deepEqual(redReport.failing, ['debuggable']);
  assert.equal(redReport.checks.find((item) => item.id === 'debuggable').status, 'fail');

  // 明文联调包：--json 里必须能直接读出 `insecure: true`（workflow 靠它决定「只发内网 / 不许公开」）
  const insecureJson = JSON.parse(runCli([
    built.apks.insecureTrue, '--expect-cert', built.certA, '--allow-insecure', '--json',
  ]).stdout);
  assert.equal(insecureJson.ok, true);
  assert.equal(insecureJson.insecure, true);
  assert.equal(insecureJson.allowInsecure, true);
  assert.equal(insecureJson.checks.find((item) => item.id === 'insecure').status, 'pass');
  // 没带 --allow-insecure 时：同一份 JSON 也要能读出「为什么红」，而不是只有退出码
  const insecureRed = JSON.parse(runCli([built.apks.insecureTrue, '--expect-cert', built.certA, '--json']).stdout);
  assert.equal(insecureRed.ok, false);
  assert.equal(insecureRed.insecure, true);
  assert.deepEqual(insecureRed.failing, ['insecure']);
});

// ─────────────────── 4. 期望指纹的单一来源 + fail-closed（#705） ───────────────────
//
// #705 的问题不是「值写错了」，而是「同一个事实在脚本里有第三份副本」：它被测试钉住所以不会漂移，
// 但会**诱使下一个人去改脚本而不是改配置**（同根因 #697 / #702 已经各踩过一次）。
// 所以这一节钉三件事：
//   1. 脚本里**一个指纹字面量都没有**（含注释），期望值只能从 `config/appIdentity.json` 派生；
//   2. 派生出来的值**真的在驱动第 4 项**（不是「反正有个值」）；
//   3. 配置读不到 / 非法 → **exit 2**（判不出来），**绝不**回落到任何内置默认值。

test('C1 不传 --expect-cert：从 config/appIdentity.json 派生，来源点名配置文件', () => {
  const root = makeRoot(JSON.stringify({ expectedCertSha256: 'a'.repeat(64) }));
  try {
    const resolved = resolveExpectCert({ root });
    assert.equal(resolved.value, 'a'.repeat(64), '配置里的值就是要比对的值，不该被任何默认值顶掉');
    assert.equal(resolved.source, CERT_SOURCE_CONFIG);
    assert.equal(resolved.invalid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C2 --expect-cert 优先于配置（大小写归一），非 64 位 hex 直接判不出来', () => {
  const root = makeRoot(JSON.stringify({ expectedCertSha256: 'a'.repeat(64) }));
  try {
    const resolved = resolveExpectCert({ expectCert: 'B'.repeat(64), root });
    assert.equal(resolved.value, 'b'.repeat(64), 'apksigner 打印的是小写，传进来的大写要归一');
    assert.equal(resolved.source, CERT_SOURCE_CLI, '显式传入要标 CLI（不是配置文件）');

    const bad = resolveExpectCert({ expectCert: 'e7c5:baee', root });
    assert.equal(bad.value, null, '非法 --expect-cert 不许被当成「反正有个值」继续跑');
    assert.match(bad.invalid, /64 位十六进制/);
    assert.equal(bad.source, CERT_SOURCE_CLI);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C3 配置缺失 / 非法 → value = null（判不出来），且不给任何兜底值', () => {
  const cases = [
    { name: '配置文件不存在', identity: undefined, expect: /读不到 config\/appIdentity\.json/ },
    { name: '缺 expectedCertSha256 字段', identity: JSON.stringify({ applicationId: 'x.y' }), expect: /缺失或不是字符串/ },
    { name: '不是 64 位（63 位）', identity: JSON.stringify({ expectedCertSha256: 'e'.repeat(63) }), expect: /64 位小写十六进制/ },
    { name: '带冒号的写法（apksigner 的 AA:BB…）', identity: JSON.stringify({ expectedCertSha256: `${'ab:'.repeat(31)}ab` }), expect: /64 位小写十六进制/ },
    { name: 'JSON 本身就是坏的', identity: '{"expectedCertSha256": ', expect: /读不出来/ },
  ];
  for (const item of cases) {
    const root = makeRoot(item.identity);
    try {
      const resolved = resolveExpectCert({ root });
      assert.equal(resolved.value, null, `${item.name}：判不出来时不许给出任何值（那就是内置默认值）`);
      assert.match(resolved.invalid ?? '', item.expect, `${item.name}：错误文案要说清为什么读不出来`);
      assert.equal(resolved.source, CERT_SOURCE_CONFIG, `${item.name}：来源要指认配置文件（人要知道去哪修）`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('C4 配置缺失 / 非法 → exit 2、五项全 unknown、文案说清来源与修法（不需要 SDK）', () => {
  // 期望值判不出来发生在「碰 APK 之前」，所以这里故意拿一个非 APK 路径：能证明是配置这一关先挡住的
  for (const identity of [undefined, JSON.stringify({ expectedCertSha256: 'z'.repeat(64) })]) {
    const root = makeRoot(identity);
    try {
      const result = verifyReleaseApk({ apk: path.join(ROOT, 'package.json'), root });
      // 先断言「是期望值这一关挡住的」：少了这条，别的 fail-closed（比如读不到 APK）也会让 exit=2 蒙对
      assert.match(result.error ?? '', /期望证书指纹判不出来/, '必须是被「期望值判不出来」挡住，不是被别的检查顺带挡住');
      assert.equal(result.exitCode, EXIT_UNKNOWN, `期望值判不出来必须 exit 2（判不出来），实际 ${result.exitCode}`);
      assert.equal(result.ok, false);
      assert.equal(result.expectedCert, null, '判不出来时不许填任何值 —— 填了就等于「内置默认值」还在');
      assert.equal(result.expectCertSource, CERT_SOURCE_CONFIG);
      assert.match(result.error, /config\/appIdentity\.json/, '文案要说清期望值该从哪来');
      assert.match(result.error, /不回落到任何内置默认值/, '文案要说清为什么直接 exit 2');
      assert.match(result.error, /--expect-cert/, '文案要给修法（临时换指纹的通道）');
      assert.deepEqual(
        result.checks.map((item) => item.status),
        ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
        '判不出来 = 五项全 unknown（不是「证书一项不过」，更不是 pass）',
      );
      assert.deepEqual(result.failing, [], '「判不出来」不许表述成「某几项不过」');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('C4b 配置缺失 + 真 APK → exit 2（不是 0、也不是 1：不许拿内置默认值继续跑完）', SKIP, () => {
  const built = fixtures();
  const root = makeRoot(undefined);
  try {
    // 夹具包是临时证书签的（≠ 已发布证书）：若脚本里还留着硬编码默认值，这一条就会一路跑完，
    // 落在 exit 1（被当成「证书不符」）或 exit 0（恰巧相等）—— 都不是 exit 2。负向对照实测是 exit 1。
    const result = verifyReleaseApk({ apk: built.apks.clean, root });
    assert.equal(result.exitCode, EXIT_UNKNOWN, `配置缺失必须 exit 2，实际 ${result.exitCode}（0 = 用了内置默认值跑完，1 = 被当成证书不符）`);
    assert.match(result.error ?? '', /期望证书指纹判不出来/);
    assert.deepEqual(
      result.checks.map((item) => item.status),
      ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C5 配置里的值真的在驱动第 4 项（换配置 → 同一个包从绿变红）', SKIP, () => {
  const built = fixtures();
  const root = makeRoot(JSON.stringify({ expectedCertSha256: built.certA }));
  try {
    const green = verifyReleaseApk({ apk: built.apks.clean, root });
    assert.equal(green.exitCode, EXIT_OK, `配置里放的正是这把证书，必须过：${green.error ?? ''}`);
    assert.equal(green.expectedCert, built.certA, '期望值必须等于配置里那个（不是任何常量）');
    assert.equal(green.expectCertSource, CERT_SOURCE_CONFIG);
    assert.equal(green.checks.find((item) => item.id === 'cert').status, 'pass');

    // 配置改一个值（等价于「另一把证书」）→ 同一个包必须红，且只有 cert 红
    fs.writeFileSync(path.join(root, 'config', 'appIdentity.json'), JSON.stringify({ expectedCertSha256: built.certB }));
    const red = verifyReleaseApk({ apk: built.apks.clean, root });
    assert.equal(red.exitCode, EXIT_FAIL, '配置值变了却没红 = 期望值根本没参与比对');
    assert.deepEqual(red.failing, ['cert']);
    assert.equal(red.expectedCert, built.certB);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C6 CLI 不传 --expect-cert：用仓库配置里的已发布指纹比对，输出点名来源', SKIP, () => {
  const built = fixtures();
  // 夹具的包是临时证书签的 ≠ 已发布证书 → 不带 --expect-cert 必须红（说明它真拿配置值比了一次）
  const result = runCli([built.apks.clean]);
  assert.equal(result.status, EXIT_FAIL, `不带 --expect-cert 时要用配置里的已发布指纹比对\n${combined(result)}`);
  assert.match(combined(result), /结论：FAIL（cert 不通过）/);
  assert.match(combined(result), new RegExp(`cert=${CONFIG_CERT}\\s+来源=config/appIdentity\\.json`), '期望行要标出「值来自配置文件」');
  assert.match(combined(result), /期望指纹来源：config\/appIdentity\.json/, '结论行要标来源，复核的人才知道比的是哪来的期望值');
});

test('C7 显式 --expect-cert 压过配置（配置指向另一把证书也按 CLI 值比对）', SKIP, () => {
  const built = fixtures();
  const root = makeRoot(JSON.stringify({ expectedCertSha256: built.certB }));
  try {
    const cliWins = verifyReleaseApk({ apk: built.apks.clean, root, expectCert: built.certA });
    assert.equal(cliWins.exitCode, EXIT_OK, '显式传入的值优先级最高');
    assert.equal(cliWins.expectCertSource, CERT_SOURCE_CLI);
    assert.equal(cliWins.expectedCert, built.certA);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // 原行为不回归：证书不符仍 exit 1 且点名 cert（--json 里也能读出来）
  const mismatch = verifyReleaseApk({ apk: built.apks.certMismatch, expectCert: built.certA });
  assert.equal(mismatch.exitCode, EXIT_FAIL);
  assert.deepEqual(mismatch.failing, ['cert']);
  assert.equal(mismatch.expectCertSource, CERT_SOURCE_CLI);
});
