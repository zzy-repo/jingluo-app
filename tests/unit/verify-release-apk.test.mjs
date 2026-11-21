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
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNKNOWN,
  parseBadgingVersion,
  parseCertDigests,
  resolveExpectedCert,
} from '../../scripts/verify-release-apk.mjs';
import { PUBLISHED_IDENTITY } from '../../scripts/lib/appIdentity.mjs';
import { buildFixtures, cleanupFixtures, skipReason } from '../helpers/apk-release-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts', 'verify-release-apk.mjs');
/** 已发布证书指纹（取自断言本身；不从被测脚本取，否则「两边一起改错」也会绿） */
const PUBLISHED = PUBLISHED_IDENTITY.expectedCertSha256.toLowerCase();

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

// ────────────────────────────── 1. 「五项都在」与常量一致性（不需要 SDK） ──────────────────────────────

test('五件套就是五项，顺序与 id 固定（少一项 = 报告里会少一行）', () => {
  assert.deepEqual(CHECKS.map((item) => item.id), ['debuggable', 'variant', 'loopback', 'cert', 'insecure']);
  for (const item of CHECKS) assert.match(item.title, /^\d+ /, '每项都要带序号，表格里靠它跟 --json 对齐');
});

test('期望指纹从唯一来源派生（config/appIdentity.json）并点明来源（Issue #271 / #705）', () => {
  // #705 之前这里钉的是「脚本里的常量 == 配置」：常量当时没漂，但它仍是「已发布证书指纹」的
  // **第三份副本**。默认值现在只能派生，所以改钉「派生结果 == 配置 + 来源正确」。
  const identity = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/appIdentity.json'), 'utf8'));
  assert.match(identity.expectedCertSha256, /^[0-9a-f]{64}$/, 'config/appIdentity.json 里没有可用的 expectedCertSha256');
  const resolved = resolveExpectedCert();
  assert.equal(resolved.ok, true, `本仓配置合法时必须派生成功：${resolved.detail}`);
  assert.equal(resolved.value, identity.expectedCertSha256, '派生的期望指纹与 config/appIdentity.json 不一致');
  assert.equal(resolved.source, 'config/appIdentity.json', '期望值必须来自唯一来源，不许落到兼容回落（build.gradle）');
  assert.equal(resolved.published, identity.expectedCertSha256, '本仓期望值与「已发布证书」断言必须相等');
});

test('第三份副本已消除：verify-release-apk.mjs 里不许再出现 64 位指纹字面量（Issue #705）', () => {
  // 这条比原来的「常量 == 配置」更强：连「写死一个和配置相同的字面量」也拦。
  // 为什么必须拦：危险不在现在会错，而在下一个换签名的人会先看到那份字面量、把它当事实来源去改。
  const src = fs.readFileSync(CLI, 'utf8');
  const literals = src.match(/\b[0-9a-fA-F]{64}\b/g) ?? [];
  assert.deepEqual(literals, [], `脚本里又出现了 64 位十六进制字面量：${literals.join(', ')}（期望值只许从配置派生）`);
  assert.ok(
    !src.includes(PUBLISHED),
    '已发布指纹的第三份副本不许回来：期望值只能来自 config/appIdentity.json（#705）',
  );
});

// ─────────── 1b. 期望指纹的负向对照三拍：改配置 / 删配置 / 两份副本不等（不需要 SDK） ───────────
//
// 三拍都跑**真 CLI**（整棵 scripts/ + deploy/ 拷进临时树，REPO_ROOT 随之换成临时树），
// 因为要验的就是「退出码」，而临时树里只放配置和 gradle —— 不碰真仓库的 config。

/** 与已发布值不同的合法 64 位十六进制 = 「改一个字」的注入值 */
const TYPOED = `${PUBLISHED.slice(0, -1)}${PUBLISHED.endsWith('1') ? '2' : '1'}`;

/**
 * 造一棵能跑 `verify:apk` 的临时树（脚本 + deploy + 可选配置 / gradle 字面量）。
 * **不碰真仓库**：这三拍要改配置、删配置，改完必须能干净地还原。
 */
const makeTree = (t, { sha = null, gradleLiteral = null } = {}) => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-apk-cert-'));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(tree, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'deploy'), path.join(tree, 'deploy'), { recursive: true });
  const writeSha = (value) => {
    fs.mkdirSync(path.join(tree, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(tree, 'config/appIdentity.json'),
      `${JSON.stringify({
        applicationId: 'com.example.deepseekchat',
        namespace: 'com.example.deepseekchat',
        label: { zh: '鲸落', en: 'Whale Fall' },
        expectedCertSha256: value,
        allowInsecureUpdateTransport: true,
      }, null, 2)}\n`,
    );
  };
  const writeGradle = (value) => {
    fs.mkdirSync(path.join(tree, 'android/app'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'android/app/build.gradle'), `def EXPECTED_CERT_SHA256 = '${value}'\n`);
  };
  if (sha) writeSha(sha);
  if (gradleLiteral) writeGradle(gradleLiteral);
  // 期望值这一拍总在「读 APK / 找 SDK」之前，所以临时树里不需要真的 APK 与 build-tools：
  // 配置坏掉的树会停在期望值这一步（这正是要验的），配置正常的树会往后走到「读不到 APK」。
  const run = (args = [path.join(tree, 'no-such.apk'), '--json']) => spawnSync(
    process.execPath,
    [path.join(tree, 'scripts/verify-release-apk.mjs'), ...args],
    {
      cwd: tree,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, LANG: process.env.LANG ?? 'zh_CN.UTF-8', ANDROID_HOME: '', ANDROID_SDK_ROOT: '', BUILD_TOOLS_VERSION: '' },
    },
  );
  return { tree, run, writeSha, writeGradle, rmGradle: () => fs.rmSync(path.join(tree, 'android/app/build.gradle'), { force: true }) };
};

/** 一份结果里「期望值这一拍」的信息（--json 的 expectedCert / error 字段） */
const certGate = (result) => {
  const json = JSON.parse(result.stdout || '{}');
  return { exitCode: result.status, json, error: String(json.error ?? ''), out: combined(result) };
};

test('负向 ①：配置被改一个字 → exit 2 且点名「配置 vs 已发布」两个值（不再静默跟着配置走）', (t) => {
  const { run, writeSha } = makeTree(t, { sha: TYPOED });
  const bad = certGate(run());
  assert.notEqual(bad.exitCode, 0, `改配置必须 exit≠0（fail-closed）\n${bad.out}`);
  assert.equal(bad.json.exitCode, EXIT_UNKNOWN, `期望值对不上 = 判不出来（exit 2）\n${bad.out}`);
  assert.match(bad.error, /与「已发布证书」不一致/, `必须明说「与已发布证书不一致」\n${bad.out}`);
  assert.ok(
    bad.error.includes(`配置   ${TYPOED}`) && bad.error.includes(`已发布 ${PUBLISHED}`),
    `必须同时点名两个值（配置 ${TYPOED} / 已发布 ${PUBLISHED}）：只说「不一致」等于让人自己猜\n${bad.out}`,
  );
  assert.doesNotMatch(
    String(bad.json.expectedCert),
    /^[0-9a-f]{64}$/,
    `没判出来时不许给出任何 64 位期望值（那就是「悄悄用了个默认值」）\n${bad.out}`,
  );
  // 还原 → 这一拍不再是「证书期望值」的问题（临时树没有 APK，所以停在「读不到 APK」）
  writeSha(PUBLISHED);
  const restored = certGate(run());
  assert.equal(restored.json.exitCode, EXIT_UNKNOWN, `还原后仍是 exit 2（没有 APK），但原因必须换了\n${restored.out}`);
  assert.doesNotMatch(restored.error, /已发布证书|两份来源/, `还原配置后不许再红在指纹上\n${restored.out}`);
  assert.match(restored.error, /读不到 APK/, `还原后应当往后走到「读不到 APK」这一步（证明上面不是恒红）\n${restored.out}`);
});

test('负向 ②：删配置 → fail-closed（exit 2 + 点名文件/字段），绝不退回内置默认指纹', (t) => {
  const { run, writeSha } = makeTree(t);  // 既无 config/appIdentity.json，也无 gradle 字面量
  const missing = certGate(run());
  assert.notEqual(missing.exitCode, 0, `删配置必须 exit≠0（fail-closed，不是静默默认）\n${missing.out}`);
  assert.equal(missing.json.exitCode, EXIT_UNKNOWN, `读不到期望值 = 判不出来（exit 2）\n${missing.out}`);
  assert.match(missing.error, /config\/appIdentity\.json/, `必须点名是哪个文件缺了\n${missing.out}`);
  assert.match(missing.error, /expectedCertSha256/, `必须点名是哪个字段\n${missing.out}`);
  assert.match(missing.error, /fail-closed/, `必须明说这是 fail-closed，不是「跳过这一项」\n${missing.out}`);
  assert.doesNotMatch(
    String(missing.json.expectedCert),
    /^[0-9a-f]{64}$/,
    `配置缺失时不许出现任何 64 位期望值（那是 fail-open 的默认值）\n${missing.out}`,
  );
  assert.deepEqual(missing.json.checks.map((item) => item.status), CHECKS.map(() => 'unknown'), `期望值都没拿到，五项一律记 unknown\n${missing.out}`);
  // 显式 --expect-cert 也**不豁免**配置完整性：否则「删配置 + 随手给个值」又是一次 fail-open
  const withExplicit = certGate(run([path.join('no-such.apk'), '--expect-cert', PUBLISHED, '--json']));
  assert.equal(withExplicit.json.exitCode, EXIT_UNKNOWN, `配置缺失时，显式 --expect-cert 也必须先报配置问题\n${withExplicit.out}`);
  assert.match(withExplicit.error, /config\/appIdentity\.json/, `必须点名缺的是配置文件，而不是「APK 读不到」\n${withExplicit.out}`);
  // 还原（补回配置）→ 不再是「配置缺失」的问题
  writeSha(PUBLISHED);
  const restored = certGate(run());
  assert.doesNotMatch(restored.error, /config\/appIdentity\.json/, `补回配置后不许再报「读不到配置」\n${restored.out}`);
  assert.match(restored.error, /读不到 APK/, `补回配置后应当往后走到「读不到 APK」\n${restored.out}`);
});

test('负向 ③：两份副本不等（配置 ≠ gradle 遗留字面量）→ exit 2 且分别点名两个值与来源', (t) => {
  const { run, rmGradle } = makeTree(t, { sha: PUBLISHED, gradleLiteral: TYPOED });
  const parity = certGate(run());
  assert.notEqual(parity.exitCode, 0, `两份副本不等必须 exit≠0\n${parity.out}`);
  assert.equal(parity.json.exitCode, EXIT_UNKNOWN, `两份副本不等 = 判不出来（exit 2）\n${parity.out}`);
  assert.match(parity.error, /两份来源且不一致|第二份真相源/, `必须点明「第二份真相源」\n${parity.out}`);
  assert.ok(
    parity.error.includes(`期望 ${PUBLISHED}（来源 config/appIdentity.json）`) &&
      parity.error.includes(`实际 ${TYPOED}（来源 android/app/build.gradle 的 EXPECTED_CERT_SHA256 字面量）`),
    `点名两个值时必须分别标出来源\n${parity.out}`,
  );
  // 删掉那份遗留副本（= 收敛到单一来源）→ 不再是「两份不等」的问题
  rmGradle();
  const restored = certGate(run());
  assert.doesNotMatch(restored.error, /两份来源且不一致|第二份真相源/, `删掉副本后不许再红在「两份来源」上\n${restored.out}`);
  assert.match(restored.error, /读不到 APK/, `删掉副本后应当往后走到「读不到 APK」（证明上面不是恒红）\n${restored.out}`);
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

/** 解析器用例的样本值（#705 之后脚本里没有常量可取，也不该有：这里要的只是一个 64 位十六进制串） */
const SAMPLE_CERT = 'a'.repeat(64);

test('解析器：apksigner --print-certs 的 SHA-256（多 signer 全收，十六进制统一小写）', () => {
  const out = [
    'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug',
    `Signer #1 certificate SHA-256 digest: ${SAMPLE_CERT.toUpperCase()}`,
    'Signer #1 certificate SHA-1 digest: 1bf254cc4881ca14a32379b7c487de4ad9548b5e',
  ].join('\n');
  assert.deepEqual(parseCertDigests(out), [SAMPLE_CERT]);
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
