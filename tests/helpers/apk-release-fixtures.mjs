// [helper | 域: 发布闸门 / Issue #607] 给 `tests/unit/verify-release-apk.test.mjs` 造「真签名 APK」。
//
// 为什么是**现场生成**而不是把真包拷进 `tests/fixtures/apk/`：
//   · 干净的 1.4.3 实包 6.8 MB、debug 备份包 6.2 MB —— 拷两份进 git 就是 13 MB 的二进制永久躺在历史里，
//     而用例真正需要的只是「ZIP 里有真二进制 AXML + 真签名」这两件事；
//   · 负向对照要四种坏包（变体不对 / 回环标记 / 证书不符 / debuggable），线上包拼不出来，
//     现场生成才是唯一不会退化的做法（拷备份包的话，那份备份哪天被清掉，用例就静默失效）。
//   · 清单（AXML）用 `tests/fixtures/domain10/apk-fixture.mjs` 的编码器造 —— **不另写一份**，
//     那份已经被域10 的服务端契约用例验过「aapt2 与 apk-manifest.mjs 都能读」。
//
// 「真 APK 实包」的验证不在单测里做（它不可移植）：`docs/RELEASE-MANUAL.md` §4.6 要求发版前/后
// 拿**真产物**跑同一条命令，1.4.3 实包的输出抄在该节与 PR 正文里。
//
// 依赖：aapt2 / apksigner（build-tools）+ keytool（JDK）。缺任何一个 → 调用方在**声明期** skip
// （`skipReason()` 非 null），不是「跑一半再失败」——#95 的教训：`test.skip?.() return` 会被记成 ok。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildApk } from '../fixtures/domain10/apk-fixture.mjs';
import { resolveBuildTools } from '../../scripts/lib/androidTools.mjs';

/** 变体标记名（与 `deploy/dl-release/variant.mjs` 的 DEFAULT_MARKER 一致） */
export const VARIANT_MARKER = 'com.example.deepseekchat.ARTIFACT_VARIANT';
/** 回环标记名（与 #601 的 LOOPBACK_CONSUME 一致） */
export const LOOPBACK_MARKER = 'com.example.deepseekchat.LOOPBACK_CONSUME';

const KEYSTORE_PASS = 'android';

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    ...options,
  });
}

/** keytool 在不在（JDK 缺了就没法造第二把证书，整个夹具层直接 skip） */
function hasKeytool() {
  const result = run('keytool', ['-help']);
  return !result.error && result.status === 0;
}

/** 工具链探测（与生产脚本同一份逻辑：`scripts/lib/androidTools.mjs`） */
function detectToolchain() {
  const tools = resolveBuildTools({});
  if (!tools.ok) return { ok: false, reason: `缺 Android SDK build-tools（${tools.detail.split('\n')[0]}）` };
  if (!hasKeytool()) return { ok: false, reason: 'keytool 不在 PATH（缺 JDK，造不出第二把签名证书）' };
  if (!tools.tools.zipalign) return { ok: false, reason: `${tools.dir} 里没有 zipalign` };
  return {
    ok: true,
    dir: tools.dir,
    version: tools.version,
    aapt2: tools.tools.aapt2,
    apksigner: tools.tools.apksigner,
    zipalign: tools.tools.zipalign,
  };
}

let toolchainCache;
/** 工具链（memo）；`ok:false` 时 `reason` 直接给 node:test 当声明期 skip 理由 */
export function toolchain() {
  toolchainCache ??= detectToolchain();
  return toolchainCache;
}

/** 造不出来的理由；null = 可以造 */
export function skipReason() {
  const tools = toolchain();
  return tools.ok ? null : `verify-release-apk 夹具造不出：${tools.reason}`;
}

/** 建一把临时 keystore（PKCS12，口令统一 `android`） */
function createKeystore(dir, name) {
  const keystore = path.join(dir, `${name}.p12`);
  const result = run('keytool', [
    '-genkeypair',
    '-keystore', keystore,
    '-storetype', 'PKCS12',
    '-storepass', KEYSTORE_PASS,
    '-keypass', KEYSTORE_PASS,
    '-alias', name,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '3650',
    '-dname', `CN=${name}, O=verify-release-apk fixture, C=CN`,
  ]);
  if (result.error || result.status !== 0) {
    throw new Error(`keytool 生成 ${name} 失败：${result.error?.message ?? result.stderr}`);
  }
  return { keystore, alias: name };
}

/** zipalign + apksigner：把一个合成 APK 签成「apksigner verify 认」的包 */
function signApk({ input, output, signer }) {
  const tools = toolchain();
  const aligned = `${output}.aligned`;
  const align = run(tools.zipalign, ['-f', '4', input, aligned]);
  if (align.error || align.status !== 0) {
    throw new Error(`zipalign 失败：${align.error?.message ?? align.stderr}`);
  }
  const signed = run(tools.apksigner, [
    'sign',
    '--ks', signer.keystore,
    '--ks-pass', `pass:${KEYSTORE_PASS}`,
    '--key-pass', `pass:${KEYSTORE_PASS}`,
    '--ks-key-alias', signer.alias,
    '--out', output,
    aligned,
  ]);
  if (signed.error || signed.status !== 0) {
    throw new Error(`apksigner sign 失败：${signed.error?.message ?? signed.stderr}`);
  }
  return output;
}

/** 读一个已签名 APK 的证书 SHA-256（用于喂 `--expect-cert`） */
export function certDigest(apk) {
  const tools = toolchain();
  const result = run(tools.apksigner, ['verify', '--print-certs', apk]);
  const match = /certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) throw new Error(`读不到证书指纹：${result.stderr || result.stdout}`);
  return match[1].toLowerCase();
}

/**
 * 造整套夹具（memo，一次会话一份；`cleanupFixtures()` 负责删）。
 *
 * 返回值：
 *   `certA` / `certB` —— 两把不同的证书指纹（A =「已发布那把」的角色，B =「换签了」的角色）
 *   `apks.*` —— 六个已签名 APK 的绝对路径，`apks` 名对应下面的清单
 */
let fixtureCache;
export function buildFixtures() {
  if (fixtureCache) return fixtureCache;
  const tools = toolchain();
  if (!tools.ok) throw new Error(tools.reason);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-apk-'));
  const signerA = createKeystore(dir, 'fixture-a');
  const signerB = createKeystore(dir, 'fixture-b');

  /** 清单变体 → 合成 APK 参数（元数据按真实 gradle 的写法给） */
  const specs = {
    // 干净 standard 包：loopback 显式 false（真实 1.4.3 就是这种形状）
    clean: { debuggable: false, metaData: { [VARIANT_MARKER]: 'standard', [LOOPBACK_MARKER]: false } },
    // 老包：没有 LOOPBACK_CONSUME 这个标记（#601 之前的所有产物）
    noLoopback: { debuggable: false, metaData: { [VARIANT_MARKER]: 'standard' } },
    // 变体是 internal（内测包）
    internal: { debuggable: false, metaData: { [VARIANT_MARKER]: 'internal', [LOOPBACK_MARKER]: false } },
    // 回环包：-PallowLoopbackConsume=true 的产物（布尔 true，与真机 APK 同形）
    loopbackTrue: { debuggable: false, metaData: { [VARIANT_MARKER]: 'standard', [LOOPBACK_MARKER]: true } },
    // debug 变体：application 上写着 android:debuggable="true"
    debuggable: { debuggable: true, metaData: { [VARIANT_MARKER]: 'standard', [LOOPBACK_MARKER]: false } },
  };

  const apks = {};
  for (const [name, spec] of Object.entries(specs)) {
    const unsigned = path.join(dir, `${name}.unsigned.apk`);
    fs.writeFileSync(unsigned, buildApk(spec));
    apks[name] = signApk({ input: unsigned, output: path.join(dir, `${name}.apk`), signer: signerA });
  }
  // 同一个清单，换另一把证书签：证书检查的负向对照
  const unsignedMismatch = path.join(dir, 'certMismatch.unsigned.apk');
  fs.writeFileSync(unsignedMismatch, buildApk(specs.clean));
  apks.certMismatch = signApk({
    input: unsignedMismatch,
    output: path.join(dir, 'certMismatch.apk'),
    signer: signerB,
  });

  fixtureCache = {
    dir,
    certA: certDigest(apks.clean),
    certB: certDigest(apks.certMismatch),
    apks,
    buildToolsVersion: tools.version,
  };
  return fixtureCache;
}

/** 删临时目录（用例 `after()` 里调；残留会被 `check:hygiene` 之外的人先骂） */
export function cleanupFixtures() {
  if (!fixtureCache) return;
  fs.rmSync(fixtureCache.dir, { recursive: true, force: true });
  fixtureCache = undefined;
}
