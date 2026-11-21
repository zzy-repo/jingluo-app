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
 *   CONSUME_BASE_OVERRIDE=https://…   覆盖 **web 层** `__ENDPOINTS__.consume.baseUrl`（#651）：
 *                       优先级高于 `config/endpoints.json`，判据与配置同一套（https / 回环例外 /
 *                       废弃域黑名单 / consume≠pay）。这是唯一真正能改到 web 层的通道 ——
 *                       `-PconsumeBase` 只写原生侧 BuildConfig，没有任何 Java/Kotlin 读它。
 *   PAY_BASE_OVERRIDE=https://…       同上，作用于 `pay.baseUrl`。
 *   ALLOW_INSECURE_CONSUME=true       staging 明文联调包的显式放行（#601 守卫的补正面）：
 *                       放行「非回环明文 http」与「废弃域黑名单」两条判据，并往产物注入
 *                       `__ENDPOINTS__.insecureConsume = true`（**运行时**据此才肯接受明文，
 *                       否则 `services/consume/http.ts` 在模块级调用处抛错 → 冷启动白屏）。
 *                       只认字面 true；产物是 staging-only，禁止公开分发（`pnpm verify:apk` 会拦）。
 *                       原生侧同名开关是 gradle 的 `-PallowInsecureConsume=true`，两者必须一起传。
 *
 * 构建前会先过 `config/endpoints.json` 的 consume / pay 两段校验（#484 §6.3）：
 * https、废弃域黑名单、两个 base 不许相同、缺字段 / 未知键（报键名 + 行号）→ 一律中止。
 * 现场用 `CONSUME_BASE_OVERRIDE` / `PAY_BASE_OVERRIDE` 覆盖时，覆盖值走**同一套**判据
 * （`applyBaseOverrides`）—— 非法值照样中止，绝不「配置合法、覆盖值乱来」地出包（#651）。
 * 说明：输出目录由 DIST_OUT 决定，清空的也是该目录本身（改前无论 DIST_OUT 是什么都清 dist/）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  ALLOW_INSECURE_ENV,
  BASE_OVERRIDE_ENV,
  ENDPOINTS_LABEL,
  allowInsecureFromEnv,
  applyBaseOverrides,
  loadConsumePay,
  placeholderNotice,
} from './lib/consumeEndpoints.mjs';
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
  // 明文放行开关（#601 守卫的补正面）：只认字面 true，非法取值直接中止 ——
  // 与 gradle 的 -PallowInsecureConsume 同一条规则（逃生舱不能靠拼写猜）。
  const allowInsecure = allowInsecureFromEnv();
  if (allowInsecure.error) die(allowInsecure.error);
  const insecureOptions = {
    allowInsecure: allowInsecure.allowInsecure,
    onNotice: (msg) => process.stderr.write(`[build][WARN] ${msg}\n`),
  };

  let config;
  let raw;
  try {
    config = loadConsumePay(path.join(ROOT, ENDPOINTS_LABEL), insecureOptions);
    raw = JSON.parse(fs.readFileSync(path.join(ROOT, ENDPOINTS_LABEL), 'utf8'));
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }

  // web 层地址覆盖通道（#651）：`CONSUME_BASE_OVERRIDE` > `config/endpoints.json`，判据同一套。
  // 这是**唯一**能真正改到 web 层 `__ENDPOINTS__.consume.baseUrl` 的入口 —— `-PconsumeBase`
  // 只写原生侧 BuildConfig、没有任何 Java/Kotlin 读它（gradle 侧另有交叉核对，见 build.gradle）。
  let resolved;
  try {
    // 覆盖值走同一套判据（含「明文放行」）：staging 覆盖成 http://…:16000 时，
    // 只有 ALLOW_INSECURE_CONSUME=true 才放行（见 consumeEndpoints.checkBase；开关由
    // applyBaseOverrides 自己按 process.env 解析，与上面那次解析是同一个函数）。
    resolved = applyBaseOverrides(config, raw);
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
  const effective = resolved.config;

  if (allowInsecure.allowInsecure) {
    process.stderr.write(
      `[build][WARN] ${ALLOW_INSECURE_ENV}=true：本次产物允许明文 http 后端（staging-only）。\n` +
        '[build][WARN] 产物会注入 insecureConsume=true，APK 侧写 INSECURE_CONSUME=true —— ' +
        '只许内网联调，禁止公开分发（pnpm verify:apk 不带 allow-insecure 会 exit 1）。\n'
    );
  }

  const notice = placeholderNotice({ consume: { baseUrl: effective.consume.baseUrl } });
  if (notice) process.stderr.write(`[build][WARN] ${notice}\n`);
  // 生效值里带着「谁提供的」：覆盖了就写 `(override by CONSUME_BASE_OVERRIDE)`，
  // 别让「以为改了地址、其实没改」这种事故（#651 / #601 同形）再从日志上重演。
  const line = (section, extra) => {
    const overridden = resolved.overrides[section];
    const by = overridden ? ` (override by ${BASE_OVERRIDE_ENV[section]})` : '';
    log(`${section}=${effective[section].baseUrl}${by}${extra}`);
    if (overridden) {
      log(
        `${BASE_OVERRIDE_ENV[section]}=${overridden} 覆盖 ${ENDPOINTS_LABEL} 的 ${section}.baseUrl` +
          `（配置值 ${config[section].baseUrl}）：本次产物只认覆盖值`
      );
    }
  };
  line('consume', ` (${effective.consume.apiV1Prefix} | ${effective.consume.gatewayPrefix})`);
  line('pay', '');
  return effective;
}

/** 本地解析 @rspack/cli 的 bin，不经过 npx / shell（npx 会按需向网络拉包，版本不锚定） */
function resolveRspackBin() {
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
  const internal = argv.includes('--internal');
  const passthrough = argv.filter((a) => a !== '--internal');

  const outDir = (process.env.DIST_OUT ?? '').trim() || 'dist';
  const variant = internal ? 'internal' : 'standard';
  const { bin, version } = resolveRspackBin();

  // 0. 端点配置 fail-fast（不合法直接 exit 1，绝不带着错地址打包）
  checkConsumeEndpoints();

  // 1. 清输出目录（原脚本的 rm -rf dist）
  await fsp.rm(path.join(ROOT, outDir), { recursive: true, force: true });

  // 2. 构建：env 由 node 侧设置，不依赖 POSIX 前缀赋值
  const env = { ...process.env, NODE_ENV: 'production' };
  if (internal) env.INTERNAL_BUILD = '1';
  else delete env.INTERNAL_BUILD;

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
