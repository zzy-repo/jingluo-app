// [layer: unit | 纯 Node（**不需要** Android SDK / 真 APK / keystore）| 耗时: <1s]
//
// 「`verify:apk` 碰 APK 之前那道前门」的**三拍负向对照**（#705 收尾）。
//
// 为什么单独一个文件、而且必须是纯配置层：
//   · 现有负向对照（`tests/unit/verify-release-apk.test.mjs` 第 3 节的四种坏包）要 aapt2 / apksigner /
//     keytool 才能跑，CI 上没有 SDK 就整批 SKIP —— 于是「配置被改一个字」「gradle 里冒第二份副本」
//     这两类事故在 CI 里**永远不会红**，只有发版那台机器上真跑一次才可能发现；
//   · 而前门（`scripts/verify-release-apk.mjs` 的 `assertCertSources` / `resolveExpectCert`）判的是
//     **仓库状态**，不碰 APK：读 `config/appIdentity.json` + `android/app/build.gradle` + `PUBLISHED_IDENTITY`。
//     所以它能进 CI，而且必须在 CI 里跑。
//
// 三拍（每一拍都「改坏 → 必须 exit≠0 且点名 → 还原 → 必须 exit 0」，缺了最后一步就是空跑）：
//   1. 配置改一个字符 → exit 1，点名「配置 / 已发布」两个值；
//   2. 删掉配置字段     → exit 2（fail-closed），点名文件 + 字段，**不许**回落到任何 64 位默认值；
//                        并且同一状态下再传一个合法 `--expect-cert` **也不豁免**（收尾的第二处加固）；
//   3. gradle 里造第二份副本且与配置不等 → exit 1，点名两个值（第二份真相源）。
//
// 「改坏」只发生在 `/tmp` 的一次性临时树里（`mktempSync` + 用完删），仓库里的 `config/` 与
// `android/app/build.gradle` **一个字节都不动** —— 这些用例就是靠「同一棵树改一处」来证明判据有牙齿，
// 动了仓库就再也回不到干净的基线。
//
// 退出码走**真进程**（`spawnSync(node, ['--input-type=module', '-e', ...])` → `status`），不是
// `process.exitCode = ...` 式的自证：`result.exitCode` 是返回值，`spawn.status` 才是 CI / shell 看到的东西。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { publishedCertSha256 } from '../../scripts/lib/certFingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_URL = pathToFileURL(path.join(ROOT, 'scripts', 'verify-release-apk.mjs')).href;

/** 临时树（用例之间互不干扰；`after` 统一删） */
const TREES = [];
const makeTree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-apk-cert-sources-'));
  TREES.push(root);
  return root;
};
after(() => {
  for (const root of TREES) fs.rmSync(root, { recursive: true, force: true });
});

/** 一份**与真仓同形**的配置：`expectedCertSha256` 就是已发布证书（前门唯一放行的写法） */
const CONFIG_REL = 'config/appIdentity.json';
const GRADLE_REL = 'android/app/build.gradle';

/**
 * gradle 片段：与真仓一致（#271 之后指纹从配置派生，gradle 里**没有** 64 位字面量）。
 * 第三拍往这棵树里**追加**一行字面量，模拟「当年那第二份副本又长回来了」。
 */
const GRADLE_DERIVED = [
  '// 与真仓一致：#271 之后指纹从 config/appIdentity.json 派生，gradle 里不写字面量',
  "def expectedCertSha256Raw = providers.gradleProperty('expectedCertSha256').orNull",
  'def EXPECTED_CERT_SHA256 = expectedCertSha256Raw',
  '',
].join('\n');

const healthyConfig = (overrides = {}) => JSON.stringify({
  applicationId: 'com.example.deepseekchat',
  namespace: 'com.example.deepseekchat',
  label: { zh: '鲸落', en: 'Whale Fall' },
  expectedCertSha256: publishedCertSha256(),
  allowInsecureUpdateTransport: true,
  ...overrides,
}, null, 2);

const writeTree = (root, { config = healthyConfig(), gradle = GRADLE_DERIVED } = {}) => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
  if (config !== null) fs.writeFileSync(path.join(root, CONFIG_REL), config);
  if (gradle !== null) fs.writeFileSync(path.join(root, GRADLE_REL), gradle);
};

/**
 * 用**真进程**跑前门，退出码就是 `verify:apk` 在碰 APK 之前会给出的那个退出码。
 *
 * 为什么不是直接调 `assertCertSources()` 然后看返回值：返回值是「函数认为的退出码」，
 * 而 bug 往往出在「返回值对上、进程退出码没接上」。这里跑的是 `process.exitCode = ...` 那条真实路径。
 * `mode: 'apk'` 时改调 `verifyReleaseApk`（证明它真的把前门接在自己的最前面）。
 */
function runGate(root, { mode = 'sources', expectCert = null } = {}) {
  const driver = `
    const mod = await import(process.env.VAPK_URL);
    const root = process.env.VAPK_ROOT;
    const mode = process.env.VAPK_MODE;
    const expectCert = process.env.VAPK_EXPECT_CERT || undefined;
    if (mode === 'apk') {
      const result = mod.verifyReleaseApk({ apk: 'no-such.apk', root, expectCert });
      console.log(mod.formatReport(result));
      console.log('FAILING=' + JSON.stringify(result.failing));
      process.exitCode = result.exitCode;
    } else {
      const result = mod.assertCertSources({ root });
      for (const line of result.detail ?? []) console.log(line);
      if (result.invalid) console.log(result.invalid);
      console.log('KIND=' + result.kind + ' VALUE=' + String(result.value));
      process.exitCode = result.exitCode;
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      LANG: process.env.LANG ?? 'zh_CN.UTF-8',
      VAPK_URL: SCRIPT_URL,
      VAPK_ROOT: root,
      VAPK_MODE: mode,
      ...(expectCert ? { VAPK_EXPECT_CERT: expectCert } : {}),
    },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const MUTATED = () => {
  const published = publishedCertSha256();
  // 「改一个字符」要真的只改一个字符（末位换成另一个十六进制数字）——不是换整串，那样证明不了「一个字就红」
  return `${published.slice(0, -1)}${published.endsWith('1') ? '2' : '1'}`;
};

// ─────────────────────────── 0. 基线：健康的树必须 exit 0 ───────────────────────────
//
// 没有这一拍，下面三拍的「红」可能是「反正永远红」（比如 root 参数根本没被用上）。

test('S0 基线：配置 = 已发布断言、gradle 从配置派生 → 前门 exit 0（否则下面三拍的红是假红）', () => {
  const root = makeTree();
  writeTree(root);
  const gate = runGate(root);
  assert.equal(gate.status, 0, `健康的树必须 exit 0，实际 ${gate.status}\n${gate.output}`);
  assert.match(gate.output, /KIND=ok/);
  assert.match(gate.output, new RegExp(`VALUE=${publishedCertSha256()}`), '前门放行时用的就是配置里那个值');

  // 同样一棵树走完整 `verifyReleaseApk`：前门必须放行（后面是「读不到 APK」才 exit 2，不是被配置挡住）
  const full = runGate(root, { mode: 'apk' });
  assert.equal(full.status, 2, `配置健康时不该在前门 exit 1，实际 ${full.status}\n${full.output}`);
  assert.doesNotMatch(full.output, /期望证书指纹/, '这一轮的红不能是「期望指纹」挡的');
  assert.match(full.output, /读不到 APK|不是可读的 APK/, '红的原因是后面的 APK 那一项（临时树里没有 APK）');
});

// ─────────────────────────── 1. 配置改一个字符 ───────────────────────────

test('S1 配置改一个字符 → exit 1，点名「配置 / 已发布」两个值；还原后 exit 0', () => {
  const root = makeTree();
  writeTree(root, { config: healthyConfig({ expectedCertSha256: MUTATED() }) });

  const red = runGate(root);
  assert.notEqual(red.status, 0, `配置改一个字必须 exit≠0，实际 ${red.status}\n${red.output}`);
  assert.equal(red.status, 1, `这是「明确不过」（不是判不出来）：期望 exit 1，实际 ${red.status}\n${red.output}`);
  assert.match(red.output, /KIND=published-mismatch/);
  assert.match(red.output, /期望证书指纹与「已发布证书」不一致/);
  // 两个值都必须点名（含来源）：只说「不一致」等于让人自己去 grep
  assert.match(red.output, new RegExp(`配置\\s+${MUTATED()}`), '要点名配置里那个值');
  assert.match(red.output, new RegExp(`已发布\\s+${publishedCertSha256()}`), '要点名已发布断言那个值');
  assert.match(red.output, /config\/appIdentity\.json/, '要点名来源文件');
  assert.match(red.output, /scripts\/lib\/appIdentity\.mjs/, '要点名已发布断言所在文件');

  // 还原 → 必须真的回到 0（不是「红完就完」）
  writeTree(root);
  const green = runGate(root);
  assert.equal(green.status, 0, `还原后必须 exit 0，实际 ${green.status}\n${green.output}`);
});

// ─────────────────────────── 2. 删配置字段（fail-closed） ───────────────────────────

test('S2 删掉 expectedCertSha256 → exit 2，点名文件 + 字段，且不回落到任何 64 位默认值；还原后 exit 0', () => {
  const root = makeTree();
  const withoutField = JSON.parse(healthyConfig());
  delete withoutField.expectedCertSha256;
  writeTree(root, { config: JSON.stringify(withoutField, null, 2) });

  const red = runGate(root);
  assert.notEqual(red.status, 0, `删字段必须 exit≠0，实际 ${red.status}\n${red.output}`);
  assert.equal(red.status, 2, `读不到期望值 = 判不出来（fail-closed），期望 exit 2，实际 ${red.status}\n${red.output}`);
  assert.match(red.output, /KIND=unreadable/);
  // 点名文件与字段：人得知道去改哪一行
  assert.match(red.output, /config\/appIdentity\.json/);
  assert.match(red.output, /expectedCertSha256/);
  // 关键：没有回落到任何值（`VALUE=null`）。这条断言就是「内置默认值」的墓碑。
  assert.match(red.output, /VALUE=null/, '读不到时不许给出任何值 —— 给出值 = 还有一份默认值兜底');
  assert.doesNotMatch(red.output, /VALUE=[0-9a-f]{64}/, '出现 64 位 hex 就说明回落到某个默认值了');
  // 也不许「借用」gradle 里那份字面量：临时树里 gradle 没有字面量，所以这里同时证明它没去别处找值
  assert.doesNotMatch(red.output, /EXPECTED_CERT_SHA256\s*=\s*'/, '临时树的 gradle 里本来就没有字面量');

  writeTree(root);
  const green = runGate(root);
  assert.equal(green.status, 0, `还原后必须 exit 0，实际 ${green.status}\n${green.output}`);
});

test('S2b 同一状态 + 传一个合法 --expect-cert → 仍然 exit≠0（--expect-cert 不豁免配置完整性）', () => {
  const root = makeTree();
  const withoutField = JSON.parse(healthyConfig());
  delete withoutField.expectedCertSha256;
  writeTree(root, { config: JSON.stringify(withoutField, null, 2) });
  const validOtherCert = 'b'.repeat(64);

  // 收尾加固之前的缺陷：显式传 --expect-cert 时**完全不读配置** → 这一拍会是 exit 0（假绿）。
  const red = runGate(root, { mode: 'apk', expectCert: validOtherCert });
  assert.notEqual(red.status, 0, `「删掉配置 + 随手传个值」不许绕过（exit≠0），实际 ${red.status}\n${red.output}`);
  assert.equal(red.status, 2, `配置读不到 = 判不出来，期望 exit 2，实际 ${red.status}\n${red.output}`);
  assert.match(red.output, /FAILING=\[\]/, '判不出来不许表述成「某几项不过」');
  assert.match(red.output, /期望证书指纹判不出来/);
  assert.match(red.output, /expectedCertSha256/);
  assert.doesNotMatch(red.output, /结论：PASS/, '绝不能出现 PASS');

  // 还原后同一棵树 + 同一个 --expect-cert → 前门放行（比对值才轮到 CLI）
  writeTree(root);
  const gate = runGate(root);
  assert.equal(gate.status, 0, `还原后必须 exit 0，实际 ${gate.status}\n${gate.output}`);
});

test('S2c 整份配置删掉、只在 gradle 里留字面量 → 仍 exit 2（verify:apk 只认配置，不认兼容回落）', () => {
  const root = makeTree();
  writeTree(root, {
    config: null,
    gradle: `def EXPECTED_CERT_SHA256 = '${publishedCertSha256()}'\n`,
  });

  // 值与已发布断言**完全相同**，唯一的问题是它来自 gradle 而不是配置 —— 这正是「删掉配置」的绕道。
  // release-check 会因为兼容回落认它（老 checkout），但发版闸不认：否则删配置就能换来源。
  const red = runGate(root);
  assert.equal(red.status, 2, `只认配置：期望 exit 2，实际 ${red.status}\n${red.output}`);
  assert.match(red.output, /KIND=unreadable/);
  assert.match(red.output, /config\/appIdentity\.json/);
  assert.match(red.output, /android\/app\/build\.gradle/, '要说明「只在 gradle 找到字面量」这件事');

  writeTree(root);
  assert.equal(runGate(root).status, 0);
});

// ─────────────────────────── 3. gradle 第二份副本 ───────────────────────────

test('S3 gradle 里造第二份副本且与配置不等 → exit 1，点名两个值；还原后 exit 0', () => {
  const root = makeTree();
  const duplicate = '1'.repeat(64);
  writeTree(root, { gradle: `${GRADLE_DERIVED}def EXPECTED_CERT_SHA256 = '${duplicate}'\n` });

  const red = runGate(root);
  assert.notEqual(red.status, 0, `第二份副本不等必须 exit≠0，实际 ${red.status}\n${red.output}`);
  assert.equal(red.status, 1, `这是「明确不过」：期望 exit 1，实际 ${red.status}\n${red.output}`);
  assert.match(red.output, /KIND=duplicate-source/);
  assert.match(red.output, /证书指纹有两份来源且不一致/);
  // 两个值都点名（含各自来源）
  assert.match(red.output, new RegExp(`期望\\s+${publishedCertSha256()}`), '要点名配置里那个值');
  assert.match(red.output, new RegExp(`实际\\s+${duplicate}`), '要点名 gradle 里那个副本的值');
  assert.match(red.output, /config\/appIdentity\.json/);
  assert.match(red.output, /android\/app\/build\.gradle/);

  writeTree(root);
  const green = runGate(root);
  assert.equal(green.status, 0, `还原后必须 exit 0，实际 ${green.status}\n${green.output}`);
});

test('S3b 两份副本相等（gradle 仍是旧写法但值相同）→ exit 0（不许把「有副本」本身判红）', () => {
  const root = makeTree();
  writeTree(root, { gradle: `def EXPECTED_CERT_SHA256 = '${publishedCertSha256()}'\n` });
  // 判据是「两份**不等**」，不是「存在第二份」：把存在本身判红会逼人去改文件名而不是消除漂移。
  const gate = runGate(root);
  assert.equal(gate.status, 0, `两份相等时应当放行，实际 ${gate.status}\n${gate.output}`);
  assert.match(gate.output, /KIND=ok/);
});

// ─────────────────── 4. 仓库自己没被这些用例改坏 ───────────────────

test('S4 这些用例只动 /tmp：仓库里的 config 与 gradle 仍是「配置 = 已发布、gradle 无字面量」', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_REL), 'utf8'));
  assert.equal(config.expectedCertSha256, publishedCertSha256(), '仓库配置在跑完这组用例后必须仍等于已发布断言');
  const gradle = fs.readFileSync(path.join(ROOT, GRADLE_REL), 'utf8');
  assert.doesNotMatch(gradle, /EXPECTED_CERT_SHA256\s*=\s*['"][0-9a-fA-F]{64}['"]/, '仓库 gradle 里不许出现 64 位字面量');
});

// ─────────────────── 5. 参数文档与语义同步（改了判据不许只改代码） ───────────────────

test('S5 --help 写清了前门与 --expect-cert 的新语义（判据变了，文档必须跟着变）', () => {
  // 为什么钉这条：`--expect-cert` 的语义从「命令行给了就用它」变成「只覆盖比对值、不豁免配置」，
  // 这是**用户可见**的行为变化。只改代码不改文档，下一个人会按旧心智用这个参数（发版当晚没人读源码）。
  const help = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-release-apk.mjs'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const text = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  assert.equal(help.status, 0, `--help 必须 exit 0：${text}`);
  assert.match(text, /前门/, '要点明「碰 APK 之前还有一道前门」');
  assert.match(text, /不豁免/, '要写清 --expect-cert 不豁免配置完整性');
  assert.match(text, /assertMatchesPublishedCert|已发布断言/, '要点明「配置必须等于已发布断言」');
  assert.match(text, /EXPECTED_CERT_SHA256/, '要点明 gradle 里那份副本也在判据里');
  assert.match(text, /config\/appIdentity\.json/, '要点名唯一来源文件');
});
