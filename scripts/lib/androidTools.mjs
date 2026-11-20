/**
 * androidTools.mjs —— Android SDK 命令行工具探测（零依赖、可 import）。
 *
 * 为什么单独抽一个模块（Issue #607）：
 *   发布校验要跑 `aapt2` / `apksigner`，离线单测要**造**签名 APK 也要跑 `apksigner`，
 *   「SDK 在哪、build-tools 用哪一档、找不到时怎么报错」这三件事必须只有一份答案。
 *   各脚本各写一遍的结果是：校验脚本用 35.0.0、夹具用 36.0.0，或者一方「找不到就静默跳过」
 *   另一方「找不到就报错」—— 于是「四件套全绿」和「四件套根本没跑」在输出里长得一样。
 *
 * 与 `build-apk.sh` 的关系（**同一套口径，不要改成通配**）：
 *   `build-apk.sh` 强制 `BUILD_TOOLS_VERSION` 必须显式钉住，理由是「装了 36.0.0 就静默换 aapt2
 *   = 人工核对的工具和实际出包的工具不是同一个」（Issue #273）。这里的优先级照抄：
 *     `--build-tools` / `$BUILD_TOOLS_VERSION` / `build.env` 里的 BUILD_TOOLS_VERSION  → 用这一档
 *     都没有                                                                          → 取已装最高档
 *   自动取最高档只作为「本机没配 build.env」的兜底，并且会在输出里标 `auto-max`，
 *   让人一眼看出「今天核对的工具和出包的工具可能不是同一个」。
 *
 * 找不到 SDK 时**不许返回 null 让调用方自己猜**：返回 `{ok:false, detail}`，
 * 调用方一律 exit 2（判不出来 = 禁止发布，与 check-apk-debuggable 同一口径）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 发布校验必需的两个工具：缺任何一个都判「验不了」 */
export const REQUIRED_TOOLS = Object.freeze(['aapt2', 'apksigner']);

/** Windows 下 apksigner 是 .bat；同一份探测代码要在这里把所有可能的形态列出来 */
const EXE_SUFFIXES = ['', '.exe', '.bat', '.cmd'];

/** `build.env` 里只关心这两个键（其余键由 build-apk.sh 自己消费） */
const BUILD_ENV_KEYS = Object.freeze(['ANDROID_HOME', 'BUILD_TOOLS_VERSION']);

/**
 * 解析 build.env（`KEY=VALUE` 行，# 开头是注释，值可带引号）。
 * 只取 BUILD_ENV_KEYS 里的键，避免把整份机器配置漏进报告。
 *
 * @param {string} text
 * @returns {{ANDROID_HOME?: string, BUILD_TOOLS_VERSION?: string}}
 */
export function parseBuildEnv(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!BUILD_ENV_KEYS.includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

/** 读仓库根的 build.env（机器本地文件，已 .gitignore；不存在就是 {}） */
export function loadBuildEnv(root = REPO_ROOT) {
  const file = path.join(root, 'build.env');
  try {
    return parseBuildEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** `~/android-sdk` → `/home/u/android-sdk`（build.env.example 里就是这么写的） */
export function expandHome(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value) return '';
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

/**
 * 定位 Android SDK 根目录。
 * 顺序：`$ANDROID_HOME` > `$ANDROID_SDK_ROOT` > `build.env` 的 ANDROID_HOME > `~/android-sdk`。
 *
 * @returns {{ok: true, androidHome: string, source: string} | {ok: false, tried: string[]}}
 */
export function resolveAndroidHome({ env = process.env, buildEnv = {}, home = os.homedir() } = {}) {
  const candidates = [
    { source: '$ANDROID_HOME', value: env.ANDROID_HOME },
    { source: '$ANDROID_SDK_ROOT', value: env.ANDROID_SDK_ROOT },
    { source: 'build.env:ANDROID_HOME', value: buildEnv.ANDROID_HOME },
    { source: '~/android-sdk（兜底）', value: path.join(home, 'android-sdk') },
  ];
  const tried = [];
  for (const candidate of candidates) {
    const expanded = expandHome(candidate.value, home);
    if (!expanded) continue;
    const resolved = path.resolve(expanded);
    tried.push(`${candidate.source} → ${resolved}`);
    if (isDirectory(resolved)) return { ok: true, androidHome: resolved, source: candidate.source };
  }
  return { ok: false, tried };
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 版本号比较（`35.0.0` vs `36.0.0-rc1`）：逐段数字比，非数字段按字符串比 */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    const aNum = Number.isFinite(na) && pa[i] !== '';
    const bNum = Number.isFinite(nb) && pb[i] !== '';
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
    } else if (pa[i] !== pb[i]) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 列出 `$ANDROID_HOME/build-tools/` 下已安装的档位（含每档有哪些工具）。
 * @returns {Array<{version: string, dir: string, tools: Record<string, string|null>, complete: boolean}>}
 */
export function listBuildToolVersions(androidHome) {
  const root = path.join(androidHome, 'build-tools');
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => isDirectory(path.join(root, name)))
    .sort(compareVersions)
    .reverse()
    .map((version) => {
      const dir = path.join(root, version);
      const tools = {};
      for (const tool of ['aapt2', 'apksigner', 'zipalign']) tools[tool] = findTool(dir, tool);
      return {
        version,
        dir,
        tools,
        complete: REQUIRED_TOOLS.every((tool) => Boolean(tools[tool])),
      };
    });
}

/** 在一个 build-tools 目录里找某个工具（Windows 上 apksigner 是 .bat） */
export function findTool(dir, name) {
  for (const suffix of EXE_SUFFIXES) {
    const candidate = path.join(dir, `${name}${suffix}`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** 给使用者看的「怎么装 SDK」提示（exit 2 时一定会打印） */
export function toolchainHint() {
  return [
    '装 Android SDK 的 build-tools（aapt2 / apksigner 都在里面）：',
    '  sdkmanager "build-tools;35.0.0"',
    '然后让本机认得到它（两种都行）：',
    '  export ANDROID_HOME=$HOME/android-sdk',
    '  cp build.env.example build.env   # 填 ANDROID_HOME 与 BUILD_TOOLS_VERSION',
    '注意：找不到工具时本脚本按「判不出来」处理（exit 2），不会放行。',
  ].join('\n');
}

/**
 * 解析出可用的 build-tools 目录。
 *
 * @param {{env?: NodeJS.ProcessEnv, buildEnv?: object, androidHome?: string|null,
 *          buildToolsVersion?: string|null}} opts
 * @returns {{ok: true, androidHome: string, dir: string, version: string, source: string,
 *            tools: Record<string, string|null>, installed: string[]}
 *         | {ok: false, reason: string, detail: string, installed: string[]}}
 */
export function resolveBuildTools(opts = {}) {
  const env = opts.env ?? process.env;
  const buildEnv = opts.buildEnv ?? {};
  let androidHome = opts.androidHome ?? null;
  let homeSource = '参数';
  if (!androidHome) {
    const resolved = resolveAndroidHome({ env, buildEnv });
    if (!resolved.ok) {
      return {
        ok: false,
        reason: 'android_home_missing',
        detail: [
          '找不到 Android SDK 根目录（ANDROID_HOME / ANDROID_SDK_ROOT / build.env / ~/android-sdk 都没命中）。',
          ...resolved.tried.map((line) => `  试过：${line}`),
        ].join('\n'),
        installed: [],
      };
    }
    androidHome = resolved.androidHome;
    homeSource = resolved.source;
  }

  const installed = listBuildToolVersions(androidHome);
  const installedVersions = installed.map((item) => item.version);

  const pinned = [
    { value: opts.buildToolsVersion, source: '--build-tools' },
    { value: env.BUILD_TOOLS_VERSION, source: '$BUILD_TOOLS_VERSION' },
    { value: buildEnv.BUILD_TOOLS_VERSION, source: 'build.env:BUILD_TOOLS_VERSION' },
  ].find((item) => item.value);

  if (pinned) {
    const dir = path.join(androidHome, 'build-tools', String(pinned.value));
    if (!isDirectory(dir)) {
      return {
        ok: false,
        reason: 'build_tools_version_missing',
        detail: [
          `${pinned.source} 指定的 build-tools ${pinned.value} 不存在：${dir}`,
          `  已安装档位：${installedVersions.join(' ') || '<无>'}`,
          '  修复：改 build.env 的 BUILD_TOOLS_VERSION（或安装该档位）。',
        ].join('\n'),
        installed: installedVersions,
      };
    }
    const tools = {};
    for (const tool of ['aapt2', 'apksigner', 'zipalign']) tools[tool] = findTool(dir, tool);
    const missing = REQUIRED_TOOLS.filter((tool) => !tools[tool]);
    if (missing.length) {
      return {
        ok: false,
        reason: 'tool_missing',
        detail: `${path.join(androidHome, 'build-tools', String(pinned.value))} 里缺工具：${missing.join(' / ')}`,
        installed: installedVersions,
      };
    }
    return {
      ok: true,
      androidHome,
      dir,
      version: String(pinned.value),
      source: `${pinned.source}（${homeSource}）`,
      tools,
      installed: installedVersions,
    };
  }

  const best = installed.find((item) => item.complete);
  if (!best) {
    return {
      ok: false,
      reason: installed.length ? 'tool_missing' : 'build_tools_missing',
      detail: [
        installed.length
          ? `${androidHome}/build-tools 下没有任何一档同时具备 ${REQUIRED_TOOLS.join(' + ')}`
          : `${androidHome}/build-tools 下没有任何已安装档位`,
        `  已安装档位：${installedVersions.join(' ') || '<无>'}`,
      ].join('\n'),
      installed: installedVersions,
    };
  }
  return {
    ok: true,
    androidHome,
    dir: best.dir,
    version: best.version,
    source: `auto-max（${homeSource}；未钉住 BUILD_TOOLS_VERSION，取已装最高档 ${best.version}）`,
    tools: best.tools,
    installed: installedVersions,
  };
}
