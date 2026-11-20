// [layer: unit | 纯 Node + 本机 Android SDK build-tools（缺工具时**声明期** SKIP）| 耗时: ~20s]
//
// 「发布 APK 四件套校验」的用例（Issue #607）。被测脚本：`scripts/verify-release-apk.mjs`。
//
// 这个文件要回答的只有三个问题，别把它写成「脚本能跑」：
//   1. **四项都在**：debuggable / ARTIFACT_VARIANT / LOOPBACK_CONSUME / 证书 —— 少一项就是「四件套」三个字在骗人；
//   2. **每项都会真的红**：四种坏包（debuggable / 变体不对 / 回环标记 / 换签证书）各自 **exit 1**，
//      并且**点名**是哪一项挂了（`结论：FAIL（debuggable 不通过）` 这行，不是「反正红了」）；
//   3. **判不出来 ≠ 通过**：缺 aapt2 / 不是 APK / 文件不存在 → **exit 2**（fail-closed，
//      与 `check-apk-debuggable` 同一口径 —— #60 的事故就是靠「判不出来就当没事」漏出去的）。
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
  EXPECTED_CERT_SHA256,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNKNOWN,
  parseBadgingVersion,
  parseCertDigests,
} from '../../scripts/verify-release-apk.mjs';
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

/** 夹具只能在用例里造（声明期造 = CI 上无 SDK 时整文件崩），跑完删 */
const fixtures = () => buildFixtures();
after(() => cleanupFixtures());

const SKIP_REASON = skipReason();
/**
 * node:test 的一个坑：`{ skip: null }` **也会被判成跳过**（Node 24 实测：用例体照跑，结果却记成 SKIP）。
 * 所以「能造夹具」时干脆不传 skip 字段 —— 用 `undefined` 也不安全，只能条件展开。
 */
const SKIP = SKIP_REASON ? { skip: SKIP_REASON } : {};

// ────────────────────────────── 1. 「四项都在」与常量一致性（不需要 SDK） ──────────────────────────────

test('四件套就是四项，顺序与 id 固定（少一项 = 报告里会少一行）', () => {
  assert.deepEqual(CHECKS.map((item) => item.id), ['debuggable', 'variant', 'loopback', 'cert']);
  for (const item of CHECKS) assert.match(item.title, /^\d+ /, '每项都要带序号，表格里靠它跟 --json 对齐');
});

test('默认证书指纹与 config/appIdentity.json 的 expectedCertSha256 一致（Issue #271 的唯一记录点）', () => {
  // gradle 的 EXPECTED_CERT_SHA256 是从 config/appIdentity.json 派生的（见 android/app/build.gradle），
  // 所以这里对着那份配置比 —— 脚本里写死的常量一旦漂移，这条立刻红。
  const identity = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/appIdentity.json'), 'utf8'));
  assert.match(identity.expectedCertSha256, /^[0-9a-f]{64}$/, 'config/appIdentity.json 里没有可用的 expectedCertSha256');
  assert.equal(
    EXPECTED_CERT_SHA256,
    identity.expectedCertSha256,
    '脚本里的默认证书指纹与 config/appIdentity.json 不一致：换证书是发布级迁移，不许只改一处',
  );
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
    `Signer #1 certificate SHA-256 digest: ${EXPECTED_CERT_SHA256.toUpperCase()}`,
    'Signer #1 certificate SHA-1 digest: 1bf254cc4881ca14a32379b7c487de4ad9548b5e',
  ].join('\n');
  assert.deepEqual(parseCertDigests(out), [EXPECTED_CERT_SHA256]);
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
// （正例是 `PASS（4/4 项通过）`，负例是 `FAIL（<id> 不通过）`）——「红了但不知道红在哪」不算咬住。

const ROWS = [
  {
    id: 'P1',
    what: '干净 standard 包（LOOPBACK_CONSUME=false）：四项全绿',
    fixture: 'clean',
    expect: { code: EXIT_OK, conclusion: /结论：PASS（4\/4 项通过）/ },
  },
  {
    id: 'P2',
    what: '老包没有 LOOPBACK_CONSUME 标记 → 缺失视为通过（不误伤历史包）',
    fixture: 'noLoopback',
    expect: { code: EXIT_OK, conclusion: /结论：PASS（4\/4 项通过）/, also: /标记缺失（视为 false）/ },
  },
  {
    id: 'P3',
    what: '--variant internal 验 internal 包 → 通过（变体是参数，不是写死 standard）',
    fixture: 'internal',
    args: ['--variant', 'internal'],
    expect: { code: EXIT_OK, conclusion: /结论：PASS（4\/4 项通过）/, also: /internal/ },
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
  assert.deepEqual(report.checks.map((item) => item.id), ['debuggable', 'variant', 'loopback', 'cert']);
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
});
