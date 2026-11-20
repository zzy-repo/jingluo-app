#!/usr/bin/env node
/**
 * build.mjs —— 跨平台前端构建包装（GitHub Issue #273）
 *
 * 为什么有这个文件：`package.json` 的 build 脚本原来是
 *   `rm -rf dist && NODE_ENV=production rspack build -c rspack.config.ts`
 * 这行在 git-bash 能跑，在 Windows 上 `pnpm` 把脚本交给 cmd.exe 执行，于是直接报
 *   'NODE_ENV' 不是内部或外部命令
 * ——也就是说「在哪个 shell 里敲 pnpm build」决定了发布链路能不能开始，而这件事以前没有任何地方写明。
 * 这里用 node 标准库起 rspack（不引 cross-env / shelljs 之类新依赖）：
 *   - 清输出目录用 `fs.rm`，不再依赖 `rm -rf`
 *   - NODE_ENV / INTERNAL_BUILD 通过 spawn 的 env 传入，不再依赖 shell 前缀赋值
 *   - 用 `process.execPath` + 本地解析到的 @rspack/cli bin 起构建，与当前 node 版本一致
 *
 * 用法：
 *   node scripts/build.mjs              # 等价于原来的 pnpm build（standard 变体 -> dist/）
 *   node scripts/build.mjs --internal   # 等价于原来的 pnpm build:internal（internal 变体）
 *
 * 环境变量（原样透传，与改前一致）：
 *   DIST_OUT=dist-xxx   输出目录（默认 dist）
 *   APP_VERSION=...     覆盖 build-info 里的版本号
 *   INTERNAL_BUILD=1    等价于 --internal（变体判定与 rspack 侧同口径；只认 --internal 会漏判）
 *   ALLOW_LOOPBACK_CONSUME=1
 *                       显式放行「回环 consume.baseUrl」出包（Issue #601 第一道闸）。
 *                       不开这个开关时，`internal` 变体 + 回环 baseUrl **直接构建失败**：
 *                       那种包只对本机 adb reverse 联调有意义，真机上连不上任何后端，
 *                       2026-11-20 正是在这条默认路径上把一个 127.0.0.1 的包发到了公网。
 *                       开了开关的产物会在 build-info.json 里留 `loopbackConsume: true`，
 *                       上传侧（dl-release）据此拒收 —— 出得来也发不出去。
 *
 * 构建前会先过 `config/endpoints.json` 的 consume / pay 两段校验（#484 §6.3）：
 * https、废弃域黑名单、两个 base 不许相同、缺字段 / 未知键（报键名 + 行号）→ 一律中止。
 * 说明：输出目录由 DIST_OUT 决定，清空的也是该目录本身（改前无论 DIST_OUT 是什么都清 dist/）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { assessLoopbackConsume, ENDPOINTS_LABEL, loadConsumePay, placeholderNotice } from './lib/consumeEndpoints.mjs';
import { ALLOW_LOOPBACK_ENV, allowLoopbackFromEnv } from '../shared/loopback-consume.mjs';
import { SEAM_FLAG, scanForSeam, seamEnabled } from './lib/testAuthSeam.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RSPACK_CONFIG = 'rspack.config.ts';

function log(msg) {
  process.stdout.write(`[build] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[build][ERROR] ${msg}\n`);
  process.exit(1);
}

/**
 * 构建期 fail-fast：`config/endpoints.json` 的 `consume` / `pay` 两段（#484 §6.3 / #487 W1-A）。
 *
 * 为什么在打包**之前**校验，而不是等运行时第一发请求：地址写错 / 少了字段时，运行时只表现为
 * 「转圈」「登录一直失败」，日志里没有半条线索。构建失败是唯一能被看见的时刻。
 * 报错必须带**键名与文件行号**（`consume.baseUrl 缺失` 这种话，缺了行号还是要人去 grep）。
 * 占位地址（`*.invalid`）不算错，但每次都打一行警告 —— 出正式包前必须换掉。
 */
function checkConsumeEndpoints() {
  let config;
  try {
    config = loadConsumePay(path.join(ROOT, ENDPOINTS_LABEL));
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
  const notice = placeholderNotice(JSON.parse(fs.readFileSync(path.join(ROOT, ENDPOINTS_LABEL), 'utf8')));
  if (notice) process.stderr.write(`[build][WARN] ${notice}\n`);
  log(`consume=${config.consume.baseUrl} (${config.consume.apiV1Prefix} | ${config.consume.gatewayPrefix})`);
  log(`pay=${config.pay.baseUrl}`);
  return config;
}

/**
 * 构建期 fail-fast 第二道（Issue #601）：`internal` 变体 + 回环 `consume.baseUrl` 默认拒绝出包。
 *
 * 事故（2026-11-20 22:14）：一个 `consume.baseUrl = http://127.0.0.1:18000` 的 internal 包
 * 被发到公网分发机，公网可见约 30 分钟。这种包在真机上连不上任何后端（127.0.0.1 是手机自己），
 * 只对「本机 sub2api + adb reverse」有意义 —— 却和普通包长得一模一样，人眼在文件名上分不出来。
 * 所以「出得来 → 就能发」这条默认路径必须断掉：默认失败，要出包就显式承认自己在出联调包。
 *
 * 判定逻辑不在这里（在 `scripts/lib/consumeEndpoints.mjs` 的 `assessLoopbackConsume`，
 * 单测覆盖；gradle 侧是同一套规则的对照实现），这里只负责「拦 or 告警 + 给产物打标记」。
 *
 * @returns {boolean} 产物是否需要打「带的是回环地址」标记
 */
function checkLoopbackConsume(config, variant, allowLoopback) {
  const verdict = assessLoopbackConsume({ variant, baseUrl: config.consume.baseUrl, allowLoopback });
  if (!verdict.loopback) return false;
  if (verdict.blocked) die(verdict.message);
  process.stderr.write(`[build][WARN] ${verdict.message}\n`);
  return verdict.mark;
}

/** 本地解析 @rspack/cli 的 bin，不经过 npx / shell（npx 会按需向网络拉包，版本不锚定） */function resolveRspackBin() {
  let pkgPath;
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    pkgPath = require.resolve('@rspack/cli/package.json');
  } catch {
    die('本地找不到 @rspack/cli（node_modules 不全？先跑 pnpm install --frozen-lockfile）');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.rspack);
  if (!rel) die(`@rspack/cli 的 package.json 里没有 bin.rspack：${pkgPath}`);
  const bin = path.resolve(path.dirname(pkgPath), rel);
  if (!fs.existsSync(bin)) die(`@rspack/cli 的 bin 不存在：${bin}`);
  return { bin, version: pkg.version, pkgPath };
}

async function main() {
  const argv = process.argv.slice(2);
  // 变体判定必须与 rspack 侧同口径：`--internal` 或 `INTERNAL_BUILD=1` 都算 internal。
  // 只看 `--internal` 会留一个洞 —— `INTERNAL_BUILD=1 pnpm build` 出来的产物本质是内测包，
  // 而闸门却按 standard 放行（#601：闸门的漏判就是这么产生的）。
  const internal = argv.includes('--internal') || process.env.INTERNAL_BUILD === '1';
  const passthrough = argv.filter((a) => a !== '--internal');

  const outDir = (process.env.DIST_OUT ?? '').trim() || 'dist';
  const variant = internal ? 'internal' : 'standard';
  const { bin, version } = resolveRspackBin();

  // 0. 端点配置 fail-fast（不合法直接 exit 1，绝不带着错地址打包）
  const endpoints = checkConsumeEndpoints();

  // 0b. 回环 baseUrl 闸门（Issue #601 第一道）：internal + 回环 → 默认拒绝出包
  const loopbackMark = checkLoopbackConsume(endpoints, variant, allowLoopbackFromEnv());

  // 1. 清输出目录（原脚本的 rm -rf dist）
  await fsp.rm(path.join(ROOT, outDir), { recursive: true, force: true });

  // 2. 构建：env 由 node 侧设置，不依赖 POSIX 前缀赋值
  const env = { ...process.env, NODE_ENV: 'production' };
  if (internal) env.INTERNAL_BUILD = '1';
  else delete env.INTERNAL_BUILD;
  // 产物自述（build-info.json）里要留下「这个包带的是回环地址」这条事实：
  // 上传侧 / 事后取证都靠它，而不是靠人回忆当时 config 长什么样（#601）。
  if (loopbackMark) env.LOOPBACK_CONSUME = '1';
  else delete env.LOOPBACK_CONSUME;

  log(`variant=${variant} NODE_ENV=${env.NODE_ENV}${internal ? ' INTERNAL_BUILD=1' : ''}`);
  log(`out=${outDir} rspack=@rspack/cli@${version} config=${RSPACK_CONFIG} node=${process.version}`);

  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'build', '-c', RSPACK_CONFIG, ...passthrough], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (c, signal) => (signal ? reject(new Error(`被信号 ${signal} 终止`)) : resolve(c ?? 1)));
  });

  if (code !== 0) die(`rspack build 退出码 ${code}`);
  if (!fs.existsSync(path.join(ROOT, outDir, 'index.html'))) {
    die(`构建报告成功但 ${outDir}/index.html 不存在（dist 输出异常）`);
  }

  // 2.5 登录接缝守卫（#510）：构建完**立刻**自扫一遍产物，别指望下一个人记得跑门禁。
  //     带 `TEST_AUTH_SEAM=1` 的是测试专用产物（黄金回归 / L1 需要「启动即已登录」），
  //     它必然带标记 → 只告警；不带开关的构建（含发版）里出现标记就一定是接缝漏进了产物 → 直接失败。
  //     标记清单与假会话的唯一出处是 scripts/lib/testAuthSeam.mjs（CI 门禁读同一份）。
  const seamHits = scanForSeam(path.join(ROOT, outDir));
  if (seamEnabled()) {
    if (seamHits.length === 0) {
      log(`[WARN] ${SEAM_FLAG}=1 但产物里扫不到接缝标记 —— 接缝可能没生效（先跑 pnpm run check:test-seam -- --expect-seam ${outDir}）`);
    } else {
      log(`[WARN] 测试接缝构建（${seamHits.length} 个文件带着假会话）：${outDir}/ 只许给测试用，绝不能发版`);
    }
  } else if (seamHits.length > 0) {
    die(
      `${outDir}/ 里出现了登录接缝标记（${seamHits.map((hit) => path.relative(ROOT, hit.file)).slice(0, 3).join(', ')}…）：` +
        '正常构建必须把 __TEST_AUTH_STATE__ 内联为 undefined（见 rspack.config.ts 的 DefinePlugin / scripts/lib/testAuthSeam.mjs）'
    );
  }

  log(`OK ${outDir}/ 已生成`);
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
