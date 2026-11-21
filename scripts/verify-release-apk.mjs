#!/usr/bin/env node
/**
 * verify-release-apk.mjs —— **发布 APK 五件套**一条命令校验（Issue #607 沉淀，#630 的 workflow 内联版；
 * 第 5 项 `INSECURE_CONSUME` 是 Issue #601 守卫的补正面 —— staging 明文联调包的自证标记）。
 *
 * ## 为什么要有它（今天真踩过）
 *   · `v1.4.3` 发出去之后，是靠人**手打 5 条命令**（aapt2 badging / xmltree / apksigner / sha256 /
 *     unzip grep baseUrl）才确认它干净 —— 换个 lane、换个人、换个心情就会漏一项；
 *   · 更早的 19 个已发布 APK 里 **15 个是 debug 包**（Issue #60），`v1.0.0`~`v1.3.0` 那些「正式版」
 *     全在内：漏的不是某一次操作，是「没有一条能一键复算的判据」；
 *   · 现有 `scripts/check-apk-debuggable.mjs` 只查 debuggable，其余三项（变体 / 回环标记 / 证书）
 *     散在 `docs/RELEASE-MANUAL.md` 的手打命令和 `.github/workflows/release.yml` 里，**别人用不上**。
 * 所以这里把判据做成同一张表：任何 lane、任何 APK，一条命令、一个退出码。
 *
 * ## 用法
 * ```
 * node scripts/verify-release-apk.mjs <apk> [--variant standard] [--expect-cert <sha256>] \
 *        [--allow-insecure] [--json]
 * ```
 *   --variant         期望的构建变体（默认 `standard`，可选 `internal`）
 *   --expect-cert     期望的签名证书 SHA-256。不传时**从唯一来源** `config/appIdentity.json` 的
 *                     `expectedCertSha256` 派生（读不到 / 非法 → **exit 2**，不回落到任何内置默认值）。
 *                     **语义（#705 收尾）**：传了它只覆盖「拿哪个值与 APK 比对」，
 *                     **不豁免**配置完整性 —— 配置被删 / 被改时照样 exit≠0。
 *   --allow-insecure  明确认可「这是明文联调包」（`INSECURE_CONSUME=true`）：不加就 exit 1
 *   --json            输出结构化结果（workflow / 脚本消费；此时不打印表格）
 *
 * ## 期望指纹的「前门」：三道配置完整性判据（碰 APK 之前，任何情况下都跑）
 *
 * #707 只做到「值从配置派生」。但**只读配置不等于校验配置** —— 于是有两处漏：
 *   ① gradle 里若还留着 `EXPECTED_CERT_SHA256` 第二份副本，「按这份配置过闸、按那份配置构建」
 *      在 `verify:apk` 眼里毫无差别；
 *   ② 配置值与仓库里的已发布断言（`PUBLISHED_IDENTITY`）不等 —— 有人把指纹改了一个字 —— 也照样
 *      拿被改过的值去比 APK，在一个用同一次构建签的包上跑绿。
 * 还有第三处：显式传 `--expect-cert` 时**完全不读配置**，「删掉配置 + 随手传个值」即可绕过。
 * 现在这三处都由前门拦住，比较逻辑**全部复用** `scripts/lib/certFingerprint.mjs`（#702 的唯一实现）：
 *   1. 读得到：`config/appIdentity.json` 的 `expectedCertSha256` 存在且是 64 位小写十六进制
 *      （且确实来自配置本身，**不接受** gradle 兼容回落）→ 否则 **exit 2**（判不出来，不回落默认值）；
 *   2. `assertSingleFingerprintSource`：gradle 里第二份副本与配置不等 → **exit 1**，点名两个值；
 *   3. `assertMatchesPublishedCert`：配置值 ≠ `PUBLISHED_IDENTITY.expectedCertSha256` → **exit 1**，
 *      点名「配置 / 已发布」两个值。
 *
 * ## 五项 + 附加输出
 * | # | 检查 | 判据 |
 * |---|------|------|
 * | 1 | `debuggable` 不存在或 false | 复用 `check-apk-debuggable.mjs` 的 `evaluateApkDebuggable`（**不重写判定**） |
 * | 2 | `ARTIFACT_VARIANT == --variant` | `aapt2 dump xmltree --file AndroidManifest.xml` 的 meta-data |
 * | 3 | `LOOPBACK_CONSUME` 不存在或 false | 同上；**缺失视为通过**（老包没有这个标记，#601 的闸 2 同口径） |
 * | 4 | 签名证书 SHA-256 == `--expect-cert` | `apksigner verify --print-certs` |
 * | 5 | `INSECURE_CONSUME` 不存在或 false，**或者**带了 `--allow-insecure` | 同上；缺失视为 false（向后兼容）。<br>`true` 且没带 `--allow-insecure` → **exit 1**（明文联调包，禁止公开分发）；<br>带了 → 通过，但结论行强制标 `INSECURE(staging-only)`、`--json` 里 `insecure: true` |
 * | 6 | 附加输出（不算失败项） | `versionName` / `versionCode` / `sha256` / `md5` / `size`，供 Release 正文直用 |
 *
 * 第 5 项为什么存在：`-PallowInsecureConsume=true` 让「明文 http 非回环」的 staging 包打得出来
 * （#651 的发版铁律要求 staging 指向 `http://140.210.13.146:16000`，明文是已知代价），代价是这个包
 * **不能公开分发**。所以放行通道必须留下自证标记，由这道闸把它挡住 —— 打得出来，但发不安静悄悄。
 *
 * ## 退出码（与 `check-apk-debuggable` 同一口径）
 *   0  五项全过（且前门三道配置判据全过）→ 可以发布
 *   1  有项目**明确不过**（读到值、值不对；含「配置 ≠ 已发布断言」「gradle 第二份副本 ≠ 配置」）
 *      → 禁止发布，报告点名是哪一项（前门拦下时 `failing = ['certSources']`，两个值都抄出来）
 *   2  判不出来（缺 aapt2 / apksigner、SDK 没装、不是 APK、清单读不出、配置读不到、`--expect-cert` 非法）
 *      → **同样禁止发布**（fail-closed）
 *
 * ## 边界（别夸大）
 *   · 不依赖网络、不修改 APK（只读 + `fs.statSync`）；
 *   · 证书指纹是「这次出包用的是不是那把已发布 key」，不等于「包里的 JS 没被人改过」——
 *     那属于产物审计，不在这张表里；
 *   · 第 2/3/5 项要 `aapt2`，第 4 项要 `apksigner`，两者都从 `$ANDROID_HOME/build-tools/<版本>/` 取
 *     （优先级见 `scripts/lib/androidTools.mjs`：钉住的版本 > 已装最高档），找不到就 exit 2；
 *   · 前门三道判据**不需要 SDK / APK / keystore**（纯配置层），所以它们进得了 CI：
 *     负向对照见 `tests/unit/verify-release-apk-cert-sources.test.mjs`。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateApkDebuggable } from './check-apk-debuggable.mjs';
import {
  DEFAULT_INSECURE_MARKER,
  DEFAULT_LOOPBACK_MARKER,
  DEFAULT_MARKER,
  VARIANTS,
  parseMetaDataFromXmltree,
} from '../deploy/dl-release/variant.mjs';
import { loadBuildEnv, resolveBuildTools, toolchainHint } from './lib/androidTools.mjs';
import { RE_CERT_SHA256 } from './lib/appIdentity.mjs';
import {
  CERT_FALLBACK_REL,
  CERT_PRIMARY_REL,
  assertMatchesPublishedCert,
  assertSingleFingerprintSource,
  resolveExpectedCertSha256,
} from './lib/certFingerprint.mjs';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_UNKNOWN = 2;

/**
 * 期望证书指纹的来源标签（写进结论行与 `--json` 的 `expectCertSource`，复核的人靠它知道
 * 这次比对的是**哪来的**期望值）。
 *
 * 这里以前有一个 `EXPECTED_CERT_SHA256` 字面量 —— 那是「已发布证书 sha256」这个事实的**第三份副本**
 * （#705）：配置里改一个字、脚本里没改，测试钉住了所以不会静默，但下一个人会被它诱去改脚本而不改配置。
 * 现在期望值只从 `scripts/lib/certFingerprint.mjs` 的 `resolveExpectedCertSha256()` 派生（#702 统一的
 * 唯一读取实现，主源 `config/appIdentity.json`，老 checkout 才落到 `android/app/build.gradle` 兼容回落）。
 * 读不到 / 非法 → **exit 2**，本文件**不留任何内置默认值**。
 */
export const CERT_SOURCE_CONFIG = CERT_PRIMARY_REL;
export const CERT_SOURCE_CLI = '--expect-cert';

/**
 * 「期望指纹来源是否健康」的四种结局。**这不是第 6 项检查，而是碰 APK 之前的一道前门**：
 * 前门红了就不该判 APK（判了也白判 —— 拿坏期望值比出来的绿是假绿）。
 */
export const CERT_SOURCES = Object.freeze({
  /** 配置健康：读得到 / 是 64 位 hex / 与已发布断言一致 / 没有第二份不等副本 */
  OK: 'ok',
  /** 配置读不到或不是 64 位 hex → **判不出来**（exit 2，fail-closed，不回落任何默认值） */
  UNREADABLE: 'unreadable',
  /** `android/app/build.gradle` 里还有第二份副本且与配置不等 → **明确不过**（exit 1，点名两值） */
  DUPLICATE_SOURCE: 'duplicate-source',
  /** 配置值 ≠ `PUBLISHED_IDENTITY.expectedCertSha256`（已发布断言）→ **明确不过**（exit 1，点名两值） */
  PUBLISHED_MISMATCH: 'published-mismatch',
  /** `--expect-cert` 本身不是 64 位 hex → 判不出来（exit 2） */
  CLI_INVALID: 'cli-invalid',
});

/**
 * 期望证书指纹的**来源完整性**（#705 收尾的第一处加固）。
 *
 * 三道判据，比较逻辑**全部复用** `scripts/lib/certFingerprint.mjs`（#702 的唯一实现）：
 *   ① 配置读得到、`expectedCertSha256` 是 64 位小写十六进制（且确实来自 `config/appIdentity.json`
 *      本身，不是 gradle 兼容回落）→ 读不到 = **判不出来**（exit 2）；
 *   ② `assertSingleFingerprintSource`：gradle 里若还有 `EXPECTED_CERT_SHA256` 第二份副本且与配置不等
 *      → **exit 1**，并把两个值都打出来；
 *   ③ `assertMatchesPublishedCert`：配置值 ≠ 仓库里的已发布断言 `PUBLISHED_IDENTITY.expectedCertSha256`
 *      → **exit 1**，并把「配置 / 已发布」两个值都打出来。
 *
 * 为什么 `verify:apk` 自己要跑 ②③（原来只「读配置」）：`release-check` 跑得过不等于这道闸跑得过 ——
 * 发版那台机器上真正被人执行的是 `pnpm run verify:apk`。只读配置的话，「配置被改了一个字符」在
 * 这条命令眼里毫无差别（它只会拿被改过的值去比 APK，然后在一个用同一次构建签的包上跑绿）。
 *
 * @param {{root?: string, log?: ((...parts: unknown[]) => void)|null}} [options]
 *   `root` 只为复用方 / 单测存在（把配置指向临时目录）；`log` 缺省时把 assert 的输出收进 `detail`。
 * @returns {{ok: boolean, kind: string, exitCode: number, value: string|null, source: string|null,
 *            configValue: string|null, invalid: string|null, detail: string[]}}
 *   `ok === false` 时调用方**必须**按 `exitCode` 收场，不许继续比 APK。
 */
export function assertCertSources(options = {}) {
  const root = options.root;
  const detail = [];
  const record = options.log ?? ((...parts) => detail.push(parts.map(String).join(' ')));
  const config = resolveExpectedCertSha256(root);
  const rejection = (kind, exitCode, invalid, source = null) => ({
    ok: false,
    kind,
    exitCode,
    value: null,
    source: source ?? config.source ?? CERT_SOURCE_CONFIG,
    configValue: null,
    invalid,
    detail,
  });

  // ① 读得到，且确实来自配置本身（gradle 字面量的兼容回落是 release-check 的口子，不是这条发版闸的）
  if (!config.value) {
    return rejection(
      CERT_SOURCES.UNREADABLE,
      EXIT_UNKNOWN,
      `${CERT_PRIMARY_REL} 的 expectedCertSha256 ${config.invalid ?? '读不到'}` +
        `（文件不存在、解析失败、或字段缺失；唯一来源只有这份配置，#271）`,
      CERT_SOURCE_CONFIG,
    );
  }
  if (config.source !== CERT_PRIMARY_REL) {
    return rejection(
      CERT_SOURCES.UNREADABLE,
      EXIT_UNKNOWN,
      `${CERT_PRIMARY_REL} 里没有可用的 expectedCertSha256，只在 ${config.source} 找到了字面量。` +
        '发版闸只认配置：兼容回落是 release-check 给老 checkout 的口子，这里不回落 —— ' +
        '否则「删掉配置」就能让这道闸改读另一份副本',
      CERT_SOURCE_CONFIG,
    );
  }

  // ② 第二份副本（gradle 字面量）必须与配置相等；③ 配置必须等于已发布断言。
  //    两条都跑（不短路），因为「改配置一个字」往往同时踩中两条，两个值都打出来才好定位。
  const singleSource = assertSingleFingerprintSource(config, { root, log: record });
  const matchesPublished = assertMatchesPublishedCert(config, { log: record });
  if (!singleSource || !matchesPublished) {
    return {
      ok: false,
      kind: singleSource ? CERT_SOURCES.PUBLISHED_MISMATCH : CERT_SOURCES.DUPLICATE_SOURCE,
      exitCode: EXIT_FAIL,
      value: null,
      source: config.source,
      configValue: config.value,
      invalid: null,
      detail,
    };
  }

  return {
    ok: true,
    kind: CERT_SOURCES.OK,
    exitCode: EXIT_OK,
    value: config.value,
    source: config.source,
    configValue: config.value,
    invalid: null,
    detail,
  };
}

/**
 * 解析「这次要比对的期望指纹」与它的来源。
 *
 * **语义（#705 收尾的第二处加固，2026-11 起生效）**：先无条件跑一遍 {@link assertCertSources}
 * （配置存在 / 64 位 hex / 与已发布断言一致 / 无第二份不等副本），**配置不健康就直接收场**；
 * `--expect-cert` 只决定「拿哪个值与 APK 比对」，**不豁免**「配置是否健康」。
 *
 * 改这条的理由（缺陷）：改之前，显式传 `--expect-cert <hex>` 时**完全不读配置** —— 于是
 * 「删掉 `config/appIdentity.json` + 随手传个值」就能让这道闸一路跑绿。配置是「发布用的到底是不是
 * 那把已发布 key」的唯一记录点，它坏掉这件事必须自己单独判红，不许被一个命令行参数顶掉。
 *
 * @param {{expectCert?: string|null, root?: string, log?: ((...parts: unknown[]) => void)|null}} options
 *   `root` 只为复用方 / 单测存在（把配置指向临时目录，证明「配置缺失 → 判不出来」）。
 * @returns {{ok: boolean, kind: string, exitCode: number, value: string|null, source: string|null,
 *            configValue: string|null, invalid: string|null, detail: string[]}}
 *   `ok === false` = 不许继续比 APK，调用方**必须**按 `exitCode` 收场。
 */
export function resolveExpectCert(options = {}) {
  const sources = assertCertSources({ root: options.root, log: options.log });
  if (!sources.ok) return sources;

  const raw = typeof options.expectCert === 'string' ? options.expectCert.trim() : '';
  if (raw) {
    const value = raw.toLowerCase();
    if (!RE_CERT_SHA256.test(value)) {
      return {
        ok: false,
        kind: CERT_SOURCES.CLI_INVALID,
        exitCode: EXIT_UNKNOWN,
        value: null,
        source: CERT_SOURCE_CLI,
        configValue: sources.configValue,
        invalid: `--expect-cert 不是 64 位十六进制指纹：'${raw}'（apksigner 的 AA:BB:… 写法也不接受，请传 64 位 hex）`,
        detail: [],
      };
    }
    return {
      ok: true,
      kind: CERT_SOURCES.OK,
      exitCode: EXIT_OK,
      value,
      source: CERT_SOURCE_CLI,
      configValue: sources.configValue,
      invalid: null,
      detail: [],
    };
  }
  return sources;
}

/** 检查项状态：pass 通过 / fail 明确不过 / unknown 判不出来（fail-closed） */
export const STATUS = Object.freeze({ PASS: 'pass', FAIL: 'fail', UNKNOWN: 'unknown' });

/**
 * 五项检查的固定顺序与标题（表格、--json、报错点名都以它为准）。
 * 第 5 项 `insecure` 与第 3 项 `loopback` **并列、语义不合并**：
 *   loopback = 回环地址（真机连不上后端）；insecure = 明文非回环（连得上但不加密，#601 守卫的补正面）。
 */
export const CHECKS = Object.freeze([
  { id: 'debuggable', title: '1 debuggable 不存在或 false' },
  { id: 'variant', title: '2 ARTIFACT_VARIANT 与期望一致' },
  { id: 'loopback', title: '3 LOOPBACK_CONSUME 不存在或 false' },
  { id: 'cert', title: '4 签名证书 SHA-256 与期望一致' },
  { id: 'insecure', title: '5 INSECURE_CONSUME 不存在或 false' },
]);

const SCRIPT = path.basename(fileURLToPath(import.meta.url));

const EXIT_LABEL = { [EXIT_OK]: 'PASS', [EXIT_FAIL]: 'FAIL', [EXIT_UNKNOWN]: 'UNKNOWN' };

/** 跑一个外部命令；永不抛（超时 / 缺文件都折成 error），调用方按 status/error 判定 */
function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  const shell = /\.(bat|cmd)$/i.test(cmd);
  const result = spawnSync(shell ? `"${cmd}"` : cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    shell,
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    cmd: [cmd, ...args].join(' '),
  };
}

/** 一条检查结果 */
function check(id, status, expected, actual, detail) {
  const meta = CHECKS.find((item) => item.id === id);
  return { id, title: meta ? meta.title : id, status, expected, actual, detail };
}

/** 判不出来时的统一结果（exit 2）：四项都记 unknown，报告里写清为什么 */
function unknownResult(base, error) {
  return {
    ...base,
    ok: false,
    exitCode: EXIT_UNKNOWN,
    insecure: false,
    conclusion: EXIT_LABEL[EXIT_UNKNOWN],
    checks: CHECKS.map((item) => check(item.id, STATUS.UNKNOWN, '—', '未校验', error)),
    failing: [],
    error,
  };
}

/**
 * 「期望指纹前门」拦住时的统一结果（#705 收尾）：APK 一项都还没判，所以五项全记「未校验」。
 *
 * 两种收场，区别是**能不能判**：
 *   · 判不出来（配置读不到 / 不是 64 hex / `--expect-cert` 本身非法）→ exit 2，`failing` 为空
 *     （「判不出来」不许表述成「某几项不过」，与 release-check 的 FAIL/UNKNOWN 同口径）；
 *   · 明确不过（配置与已发布断言不等 / gradle 里第二份副本不等）→ exit 1，`failing` 点名 `certSources`,
 *     报告里把两个值都抄出来 —— 只说红了不说是哪两个值不一致，等于让人自己去 grep。
 */
function certSourcesFailure(base, expectation) {
  const definite = expectation.exitCode === EXIT_FAIL;
  const head = expectation.kind === CERT_SOURCES.CLI_INVALID
    ? `--expect-cert 判不出来（配置本身是健康的：${expectation.configValue ?? '—'}）：`
    : definite
      ? '期望证书指纹的来源/断言不一致（前门拦下，还没碰 APK）：'
      : `期望证书指纹判不出来（${expectation.source ?? CERT_SOURCE_CONFIG}）：`;
  const lines = [head];
  if (expectation.invalid) lines.push(`  ${expectation.invalid}`);
  for (const line of expectation.detail ?? []) lines.push(`  ${line}`);
  lines.push('');
  if (definite) {
    // `assertSingleFingerprintSource` / `assertMatchesPublishedCert` 自己已经打过「修法」了（在 detail 里），
    // 这里只补它们没讲的那一层：为什么 `--expect-cert` 顶不掉这条判据。
    lines.push(
      '--expect-cert 不豁免这条: 它只决定「拿哪个值与 APK 比对」，不决定「配置是否健康」。',
      '因为配置就是「发布用的到底是不是那把已发布 key」的唯一记录点 —— 让一个命令行参数顶掉它，',
      '「删掉配置 + 随手传个值」就能一路跑绿（#705 收尾时补的第二处）。',
      '按上面 detail 里的修法把两个值弄成一致，再跑一遍 —— 不要通过改期望值让闸门变绿。',
    );
  } else {
    if (expectation.kind !== CERT_SOURCES.CLI_INVALID) {
      lines.push(
        '为什么直接 exit 2：指纹是第 4 项的唯一判据。判不出来就只能「按通过处理」或「猜一个值」，',
        '两者都会让第 4 项变成假绿灯 —— 所以这里**不回落到任何内置默认值**（#705）。',
        '',
      );
    }
    lines.push(
      '修法:',
      `  1) 确认 ${CERT_PRIMARY_REL} 存在，且 expectedCertSha256 是 64 位小写十六进制；`,
      '     这个值就是「已发布证书」（换它 = 已装用户无法覆盖升级，见 docs/RELEASE-MANUAL.md §1）。',
      '  2) 只是想临时按别的指纹验一下 → 显式传 --expect-cert <64 位 hex>（输出里会标来源）。',
    );
  }
  const result = unknownResult(base, lines.join('\n'));
  result.exitCode = expectation.exitCode;
  result.conclusion = EXIT_LABEL[expectation.exitCode];
  result.failing = definite ? ['certSources'] : [];
  result.certSources = { ok: false, kind: expectation.kind, exitCode: expectation.exitCode };
  return result;
}

/** 从 `aapt2 dump badging` 的首行取版本号；取不到返回 {} */
export function parseBadgingVersion(text) {
  if (typeof text !== 'string') return {};
  const line = text.split('\n').find((item) => item.startsWith('package:')) ?? '';
  const versionName = /versionName='([^']*)'/.exec(line);
  const versionCode = /versionCode='(\d+)'/.exec(line);
  const packageName = /name='([^']*)'/.exec(line);
  return {
    ...(packageName ? { packageName: packageName[1] } : {}),
    ...(versionName ? { versionName: versionName[1] } : {}),
    ...(versionCode ? { versionCode: Number(versionCode[1]) } : {}),
  };
}

/** 从 `apksigner verify --print-certs` 的输出里取出全部 signer 的 SHA-256（统一成小写） */
export function parseCertDigests(text) {
  if (typeof text !== 'string') return [];
  const digests = [];
  for (const line of text.split('\n')) {
    const match = /certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/.exec(line);
    if (match) digests.push(match[1].toLowerCase());
  }
  return digests;
}

/** 人类可读体积 */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  const mib = bytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(2)} MiB（${bytes} 字节）` : `${(bytes / 1024).toFixed(1)} KiB（${bytes} 字节）`;
}

/** 展示宽度：CJK / 全角算 2 列，否则 1 列（表格对齐用） */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

const pad = (text, width) => String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));

/** 状态 → 表格里的标签（PASS / FAIL / UNKNOWN，宽度一致便于眼睛扫） */
const STATUS_LABEL = {
  [STATUS.PASS]: 'PASS   ',
  [STATUS.FAIL]: 'FAIL   ',
  [STATUS.UNKNOWN]: 'UNKNOWN',
};

/**
 * 校验一个 APK。
 *
 * @param {{apk: string, variant?: string, expectCert?: string, env?: NodeJS.ProcessEnv,
 *          buildToolsVersion?: string|null, allowInsecure?: boolean, root?: string}} options
 *   `root`：仓库根（默认本仓）。只有复用方 / 单测会传，用来把配置指向临时目录。
 * @returns {object} 结构化结果（形状见文件头；`--json` 直接打印它）
 */
export function verifyReleaseApk(options) {
  const env = options.env ?? process.env;
  const expectedVariant = options.variant ?? 'standard';
  // 期望指纹前门（#705 收尾）：**先无条件校验配置完整性**（存在 / 64 hex / 无第二份不等副本 /
  // 与已发布断言一致），再决定拿哪个值与 APK 比对。`--expect-cert` 只覆盖后者，不豁免前者。
  const certExpectation = resolveExpectCert({ expectCert: options.expectCert, root: options.root });
  // 「明文联调包」必须是**显式**认可的一件事：不传就是不许发（见下面第 5 项）
  const allowInsecure = options.allowInsecure === true;
  const apkArg = typeof options.apk === 'string' ? options.apk : '';
  const base = {
    apk: apkArg,
    variant: expectedVariant,
    expectedCert: certExpectation.value,
    // 这次比对的是**哪来的**期望值：config/appIdentity.json（派生）或 --expect-cert（显式传入）
    expectCertSource: certExpectation.source,
    // 配置里那个值（即便 --expect-cert 覆盖了比对值，它也存在 —— 复核的人要看得出「配置是健康的」）
    configCert: certExpectation.configValue ?? null,
    allowInsecure,
    insecure: false,
    buildTools: null,
    info: {},
  };

  if (!certExpectation.ok) return certSourcesFailure(base, certExpectation);

  // 前门已过（配置健康、两道来源拦截都过了）：写进每一种结果的同一位置 ——
  // 复核的人（和 `--json` 消费方）要能看出「这一次比对的期望值经得起配置层复核」，
  // 而不是只有全绿那一份结果里才带这个字段。
  base.certSources = { ok: true, kind: CERT_SOURCES.OK, exitCode: EXIT_OK };

  const expectCert = certExpectation.value;

  if (!VARIANTS.includes(expectedVariant)) {
    return unknownResult(base, `--variant 只能是 ${VARIANTS.join(' / ')}，收到 "${expectedVariant}"`);
  }

  const apk = path.resolve(apkArg);
  base.apk = apk;
  let stat;
  try {
    stat = fs.statSync(apk);
  } catch (error) {
    return unknownResult(base, `读不到 APK：${apk}（${error.code ?? error.message}）`);
  }
  if (!stat.isFile()) return unknownResult(base, `不是普通文件：${apk}`);

  const tools = resolveBuildTools({
    env,
    buildEnv: loadBuildEnv(),
    buildToolsVersion: options.buildToolsVersion ?? null,
  });
  if (!tools.ok) return unknownResult(base, `${tools.detail}\n${toolchainHint()}`);
  base.buildTools = { version: tools.version, source: tools.source, dir: tools.dir, androidHome: tools.androidHome };

  const checks = [];

  // ── 1. debuggable：复用 check-apk-debuggable 的判定（零依赖、直接读二进制 AXML） ───────────
  const debug = evaluateApkDebuggable(apk);
  // 「根本不是可读的 APK」是**判不出来**（exit 2），不是「某一项不过」（exit 1）：
  // 后者会让人以为是发版参数错了，而实际是拿到了错文件 / 下载被截断。判据沿用 check-apk-debuggable 的 reason 前缀。
  const structural = ['read_failed', 'zip_failed', 'manifest_absent'];
  if (debug.verdict === 'unknown' && structural.some((prefix) => String(debug.reason).startsWith(prefix))) {
    return unknownResult(base, `这个文件不是可读的 APK（${debug.reason}）—— 按判不出来处理，exit 2`);
  }
  if (debug.verdict === 'clean') {
    checks.push(check('debuggable', STATUS.PASS, '无 android:debuggable（或 false）', debug.reason, null));
  } else if (debug.verdict === 'debuggable') {
    checks.push(check(
      'debuggable', STATUS.FAIL, '无 android:debuggable（或 false）', 'android:debuggable="true"',
      'debug 变体产物：可被任何已授权 adb 的机器 run-as 读私有数据 / 挂 JDWP。改用 assembleRelease 重新出包（Issue #60）',
    ));
  } else {
    checks.push(check('debuggable', STATUS.UNKNOWN, '无 android:debuggable（或 false）', '判不出来', debug.reason));
  }

  // ── 2 / 3. 变体标记与回环标记：同一份 xmltree（aapt2 dump badging 不输出 meta-data） ────────
  const xmltree = run(tools.tools.aapt2, ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']);
  const xmltreeOk = xmltree.status === 0 && !xmltree.error;
  const meta = xmltreeOk ? parseMetaDataFromXmltree(xmltree.stdout) : new Map();
  const xmltreeWhy = xmltreeOk
    ? ''
    : `aapt2 dump xmltree 失败（${xmltree.error ? xmltree.error.message : `退出码 ${xmltree.status}`}）：${(xmltree.stderr || xmltree.stdout).trim().split('\n').slice(0, 3).join(' / ')}`;

  const variantMarker = meta.get(DEFAULT_MARKER);
  if (!xmltreeOk) {
    checks.push(check('variant', STATUS.UNKNOWN, expectedVariant, '判不出来', xmltreeWhy));
  } else if (!variantMarker) {
    checks.push(check(
      'variant', STATUS.FAIL, expectedVariant, '标记缺失',
      `AndroidManifest 里没有 ${DEFAULT_MARKER} —— 出包时没传 -PartifactVariant 或包是历史产物；自动更新会推错包`,
    ));
  } else if (variantMarker.typed || typeof variantMarker.value !== 'string') {
    checks.push(check('variant', STATUS.FAIL, expectedVariant, '非字符串取值', '标记被编成 android:resource / 布尔 / 整数，读不出变体名'));
  } else if (variantMarker.value.trim() !== expectedVariant) {
    checks.push(check(
      'variant', STATUS.FAIL, expectedVariant, variantMarker.value.trim(),
      '构建变体与 web 构建不同源（build:internal ↔ internal，build ↔ standard），自动更新会推错包',
    ));
  } else {
    checks.push(check('variant', STATUS.PASS, expectedVariant, variantMarker.value.trim(), null));
  }

  const loopbackMarker = meta.get(DEFAULT_LOOPBACK_MARKER);
  const loopbackRaw = loopbackMarker && typeof loopbackMarker.value === 'string'
    ? loopbackMarker.value.trim().toLowerCase()
    : (loopbackMarker ? '<非字符串>' : null);
  if (!xmltreeOk) {
    checks.push(check('loopback', STATUS.UNKNOWN, '不存在或 false', '判不出来', xmltreeWhy));
  } else if (!loopbackMarker) {
    // 老包没有这个标记：#601 的闸 2 也是「读不到就放行」，这里同口径，避免误伤历史包
    checks.push(check('loopback', STATUS.PASS, '不存在或 false', '标记缺失（视为 false）', null));
  } else if (loopbackRaw === 'false' || loopbackRaw === '0') {
    checks.push(check('loopback', STATUS.PASS, '不存在或 false', loopbackRaw, null));
  } else if (loopbackRaw === 'true' || loopbackRaw === '1') {
    checks.push(check(
      'loopback', STATUS.FAIL, '不存在或 false', loopbackRaw,
      '回环 consume 构建（-PallowLoopbackConsume=true）：consume.baseUrl 指向 127.0.0.1 / localhost，任何真机都连不上后端（Issue #601）',
    ));
  } else {
    // 只认 true/false 两种语义；其余一律按不过处理（发布闸门不做「可能是 false」的猜测）
    checks.push(check('loopback', STATUS.FAIL, '不存在或 false', String(loopbackRaw), '标记值不是布尔（gradle 只写 true/false），fail-closed'));
  }

  // ── 4. 签名证书 ────────────────────────────────────────────────────────────────────────
  const certs = run(tools.tools.apksigner, ['verify', '--print-certs', apk]);
  const digests = parseCertDigests(`${certs.stdout}\n${certs.stderr}`);
  if (certs.error) {
    checks.push(check('cert', STATUS.UNKNOWN, expectCert, '判不出来', `apksigner 起不来：${certs.error.message}`));
  } else if (certs.status !== 0) {
    const why = (certs.stderr || certs.stdout).trim().split('\n')[0] ?? '';
    checks.push(check('cert', STATUS.FAIL, expectCert, '签名无效 / 未签名', `apksigner verify 退出码 ${certs.status}${why ? `：${why}` : ''}`));
  } else if (!digests.length) {
    checks.push(check('cert', STATUS.UNKNOWN, expectCert, '判不出来', 'apksigner 没打印任何 SHA-256 指纹'));
  } else if (digests.some((digest) => digest !== expectCert)) {
    checks.push(check('cert', STATUS.FAIL, expectCert, digests.join(', '), '换证书会让已装用户无法覆盖升级；不要为了过闸门改期望值（唯一来源 config/appIdentity.json 的 expectedCertSha256，换签名是发布级迁移）'));
  } else {
    checks.push(check('cert', STATUS.PASS, expectCert, digests.join(', '), null));
  }

  // ── 5. 明文联调包标记（INSECURE_CONSUME）：与 LOOPBACK_CONSUME 并列、判据独立 ──────────────
  //
  // 语义（#601 守卫的补正面）：`-PallowInsecureConsume=true` 让「明文 http 非回环」的 staging 包
  // 打得出来，代价是**不能公开分发**。构建期把 `INSECURE_CONSUME=true` 写进 AndroidManifest，
  // 这里就是那个标记的读取点：不显式 `--allow-insecure` 一律 exit 1 —— 打得出来，但发不安静悄悄。
  // 老包没有这个字段 → 视为 false（向后兼容，与第 3 项同口径）。
  const insecureMarker = meta.get(DEFAULT_INSECURE_MARKER);
  const insecureRaw = insecureMarker && typeof insecureMarker.value === 'string'
    ? insecureMarker.value.trim().toLowerCase()
    : (insecureMarker ? '<非字符串>' : null);
  const insecureIsTrue = insecureRaw === 'true' || insecureRaw === '1';
  base.insecure = xmltreeOk && insecureIsTrue;
  if (!xmltreeOk) {
    checks.push(check('insecure', STATUS.UNKNOWN, '不存在或 false', '判不出来', xmltreeWhy));
  } else if (!insecureMarker) {
    checks.push(check('insecure', STATUS.PASS, '不存在或 false', '标记缺失（视为 false）', null));
  } else if (insecureRaw === 'false' || insecureRaw === '0') {
    checks.push(check('insecure', STATUS.PASS, '不存在或 false', insecureRaw, null));
  } else if (insecureIsTrue) {
    if (allowInsecure) {
      checks.push(check(
        'insecure', STATUS.PASS, '不存在或 false', `${insecureRaw}（--allow-insecure 已确认：staging-only）`,
        '明文联调包：仅限内网 staging 联调，禁止公开分发 / 禁止进公开清单',
      ));
    } else {
      checks.push(check(
        'insecure', STATUS.FAIL, '不存在或 false', insecureRaw,
        '这是明文联调包，禁止公开分发（构建期用了 -PallowInsecureConsume=true，consume/pay 的 base 是非回环明文 http，流量不加密）。'
          + '确认只做 staging 联调就显式加 --allow-insecure；要公开发布请换成 https 重新出包',
      ));
    }
  } else {
    // 只认 true/false 两种语义；其余一律按不过处理（发布闸门不做「可能是 false」的猜测）
    checks.push(check('insecure', STATUS.FAIL, '不存在或 false', String(insecureRaw), '标记值不是布尔（gradle 只写 true/false），fail-closed'));
  }

  // ── 6. 附加输出（不算失败项）：Release 正文直接用 ──────────────────────────────────────
  const badging = run(tools.tools.aapt2, ['dump', 'badging', apk]);
  const fromBadging = badging.status === 0 && !badging.error ? parseBadgingVersion(badging.stdout) : {};
  const info = {
    packageName: fromBadging.packageName ?? debug.info.packageName ?? null,
    versionName: fromBadging.versionName ?? debug.info.versionName ?? null,
    versionCode: fromBadging.versionCode ?? debug.info.versionCode ?? null,
  };
  try {
    const bytes = fs.readFileSync(apk);
    info.sha256 = createHash('sha256').update(bytes).digest('hex');
    info.md5 = createHash('md5').update(bytes).digest('hex');
    info.size = stat.size;
    info.sizeHuman = humanSize(stat.size);
  } catch (error) {
    info.sha256 = null;
    info.md5 = null;
    info.size = stat.size;
    info.sizeHuman = humanSize(stat.size);
    info.note = `读文件算摘要失败：${error.message}`;
  }
  base.info = info;

  const failing = checks.filter((item) => item.status === STATUS.FAIL).map((item) => item.id);
  const unknown = checks.filter((item) => item.status === STATUS.UNKNOWN).map((item) => item.id);
  const exitCode = failing.length ? EXIT_FAIL : unknown.length ? EXIT_UNKNOWN : EXIT_OK;
  return {
    ...base,
    ok: exitCode === EXIT_OK,
    exitCode,
    conclusion: EXIT_LABEL[exitCode],
    checks,
    failing,
    unknown,
    error: null,
  };
}

/** 结论行尾的来源标注（期望指纹是哪来的，复核的人要看得见） */
const certSourceSuffix = (result) => `（期望指纹来源：${result.expectCertSource ?? '未确定'}）`;

/**
 * `failing` 里的 id → 结论行里的人话。五项检查直接用 id（`cert` / `insecure` …，与 `--json` 对齐），
 * 唯一例外是前门那条 `certSources` —— 它不是 APK 的某一项，而是「期望值本身不健康」。
 */
const FAILING_LABEL = { certSources: '期望证书指纹的来源/断言' };
const failingLabel = (result) => result.failing.map((id) => FAILING_LABEL[id] ?? id).join(' / ');

/** 表格 + 附加信息 → 人看的报告 */
export function formatReport(result) {
  const lines = [];
  lines.push(`APK   : ${result.apk}`);
  if (result.buildTools) {
    lines.push(`工具  : build-tools ${result.buildTools.version} · ${result.buildTools.source}`);
  }
  // 期望值来源紧挨着期望值：#705 之后期望指纹不再是脚本里的字面量，复核的人必须能一眼看到
  // 这次比对的是「配置派生的」还是「--expect-cert 显式传入的」——否则又得靠猜。
  lines.push(
    `期望  : variant=${result.variant}  cert=${result.expectedCert ?? '—'}`
      + `  来源=${result.expectCertSource ?? '未确定'}`,
  );
  lines.push('');
  const titleWidth = Math.max(...CHECKS.map((item) => displayWidth(item.title.replace(/^\d+ /, ''))));
  lines.push(`${pad('#', 1)}  ${pad('检查', titleWidth)}  结果     实际`);
  lines.push(`${'-'.repeat(1)}  ${'-'.repeat(titleWidth)}  --------  ${'-'.repeat(24)}`);
  for (const item of result.checks) {
    const index = CHECKS.findIndex((meta) => meta.id === item.id) + 1;
    lines.push(`${pad(String(index), 1)}  ${pad(item.title.replace(/^\d+ /, ''), titleWidth)}  ${STATUS_LABEL[item.status]}  ${item.actual}`);
  }
  const info = result.info ?? {};
  lines.push('');
  lines.push('附加输出（Release 正文可直接用，不算失败项）');
  lines.push(`  packageName : ${info.packageName ?? '—'}`);
  lines.push(`  versionName : ${info.versionName ?? '—'}`);
  lines.push(`  versionCode : ${info.versionCode ?? '—'}`);
  lines.push(`  sha256      : ${info.sha256 ?? '—'}`);
  lines.push(`  md5         : ${info.md5 ?? '—'}`);
  lines.push(`  size        : ${info.sizeHuman ?? '—'}`);
  lines.push('');
  if (result.conclusion === 'PASS') {
    // 明文联调包（INSECURE_CONSUME=true + --allow-insecure）：通过，但结论行**强制**带 INSECURE(staging-only)
    // —— 这一行是贴进 Release 正文 / 分发说明的，不能让它读起来像「可以公开发布」。
    if (result.insecure) {
      lines.push(
        `结论：PASS（${result.checks.length}/${result.checks.length} 项通过）—— **INSECURE(staging-only)**：`
          + '明文 http 联调包，只许内网 staging 联调用，禁止公开分发（--allow-insecure 已由操作者确认）。'
          + `${certSourceSuffix(result)}`,
      );
    } else {
      lines.push(`结论：PASS（${result.checks.length}/${result.checks.length} 项通过）—— 可以发布。${certSourceSuffix(result)}`);
    }
  } else if (result.conclusion === 'FAIL') {
    const detail = result.checks.filter((item) => item.status === STATUS.FAIL);
    lines.push(`结论：FAIL（${failingLabel(result)} 不通过）—— 禁止发布。${certSourceSuffix(result)}`);
    for (const item of detail) {
      if (item.detail) lines.push(`  · ${item.title}：${item.detail}`);
    }
    // 前门拦下时（配置与已发布断言不等 / gradle 第二份副本不等）五项一项都没判，
    // 红的理由只在 result.error 里 —— 不抄出来就等于「红了但不说是哪两个值」。
    if (!detail.length && result.error) {
      for (const line of result.error.split('\n')) lines.push(`  ${line}`);
    }
  } else {
    lines.push(`结论：UNKNOWN（判不出来）—— 按禁止发布处理（fail-closed）。${certSourceSuffix(result)}`);
    if (result.error) {
      for (const line of result.error.split('\n')) lines.push(`  ${line}`);
    } else {
      for (const item of result.checks.filter((entry) => entry.status === STATUS.UNKNOWN)) {
        lines.push(`  · ${item.title}：${item.detail}`);
      }
    }
  }
  return lines.join('\n');
}

function usage() {
  return [
    `用法: node scripts/${SCRIPT} <apk> [--variant standard|internal] [--expect-cert <sha256>] [--allow-insecure] [--json]`,
    '',
    '前门（碰 APK 之前，任何情况下都先跑）：期望证书指纹的配置完整性 —— 配置存在 / 64 位 hex /',
    '        与已发布断言一致 / gradle 里没有第二份不等的副本；不健康就 exit≠0。',
    '        --expect-cert 只覆盖「拿哪个值与 APK 比对」，不豁免上面这几条（详见下面「期望证书指纹」）。',
    '',
    '五项校验：debuggable 不存在或 false / ARTIFACT_VARIANT 与 --variant 一致 /',
    '          LOOPBACK_CONSUME 不存在或 false / 签名证书 SHA-256 与 --expect-cert 一致 /',
    '          INSECURE_CONSUME 不存在或 false（为 true 时必须显式加 --allow-insecure，否则 exit 1）',
    '附加输出：versionName / versionCode / sha256 / md5 / size（Release 正文直接用）',
    '',
    '--allow-insecure  确认「这是明文联调包」：只给 staging 联调用，结论行会强制标 INSECURE(staging-only)，',
    '                  禁止公开分发；不带它时，带 INSECURE_CONSUME=true 标记的包一律 exit 1',
    '',
    '期望证书指纹（碰 APK 之前的**前门**，任何情况下都会先跑一遍）：',
    `  1) 配置完整性：${CERT_PRIMARY_REL} 必须存在、expectedCertSha256 是 64 位小写十六进制`,
    '     （读不到 / 非法 → exit 2，不回落到任何内置默认值）；',
    `  2) 单一来源：${CERT_FALLBACK_REL} 里若还有 EXPECTED_CERT_SHA256 字面量且与配置不等 → exit 1，`,
    '     报告里点名两个值（第二份真相源）；',
    '  3) 已发布断言：配置值 ≠ scripts/lib/appIdentity.mjs 的 PUBLISHED_IDENTITY.expectedCertSha256',
    '     → exit 1，报告里点名「配置 / 已发布」两个值（改配置一个字就红）。',
    '',
    '--expect-cert <sha256>  只覆盖「拿哪个值与 APK 比对」，**不豁免**上面三条配置完整性判据：',
    '                  配置被删 / 被改时，即便传了合法指纹也照样 exit≠0（语义自 #705 收尾起）。',
    '                  不传时比对值从配置派生；来源会写进结论行与 --json 的 expectCertSource。',
    '',
    '退出码: 0 五项全过 / 1 有项目明确不过（报告点名；含配置与已发布断言不等） /',
    '        2 判不出来（缺 SDK 工具、配置读不到、--expect-cert 非法等，同样禁止发布）',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    apk: '',
    variant: 'standard',
    expectCert: null,
    json: false,
    help: false,
    buildToolsVersion: null,
    allowInsecure: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${arg} 缺少取值`);
      return next;
    };
    // `pnpm run verify:apk -- <apk>` 会把 `--` 原样透传过来（npm 会吞掉）；两种都接受
    if (arg === '--') continue;
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-insecure') options.allowInsecure = true;
    else if (arg === '--variant') options.variant = value();
    else if (arg === '--expect-cert') options.expectCert = value();
    else if (arg === '--build-tools') options.buildToolsVersion = value();
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    else rest.push(arg);
  }
  if (rest.length > 1) throw new Error(`一次只验一个 APK（收到 ${rest.length} 个参数）`);
  options.apk = rest[0] ?? '';
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    return EXIT_UNKNOWN;
  }
  if (options.help) {
    console.log(usage());
    return EXIT_OK;
  }
  if (!options.apk) {
    console.error(usage());
    return EXIT_UNKNOWN;
  }

  const result = verifyReleaseApk({
    apk: options.apk,
    variant: options.variant,
    expectCert: options.expectCert ?? undefined,
    buildToolsVersion: options.buildToolsVersion,
    allowInsecure: options.allowInsecure,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }
  // 非 JSON 模式下把「为什么不过」同时写到 stderr，方便 workflow 的 ::error:: 与 grep 抓
  if (result.exitCode !== EXIT_OK && !options.json) {
    const reason = result.conclusion === 'FAIL'
      ? (result.failing.includes('insecure') && !result.allowInsecure
        ? '发布校验不通过：insecure —— 这是明文联调包，禁止公开分发（确认只做 staging 联调请加 --allow-insecure）'
        : result.failing.includes('certSources')
          // 前门拦下（#705 收尾）：措辞要说清「不是 APK 的问题，是期望值本身不可信」，两个值在报告里
          ? '发布校验不通过：期望证书指纹的来源/断言不一致（配置 ≠ 已发布，或 gradle 里还有第二份副本）—— 两个值见上面的报告'
          : `发布校验不通过：${result.failing.join(' / ')}`)
      : '发布校验判不出来（fail-closed）';
    console.error(reason);
  }
  return result.exitCode;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
