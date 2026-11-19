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
 * 说明：输出目录由 DIST_OUT 决定，清空的也是该目录本身（改前无论 DIST_OUT 是什么都清 dist/）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RSPACK_CONFIG = 'rspack.config.ts';

function log(msg) {
  process.stdout.write(`[build] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[build][ERROR] ${msg}\n`);
  process.exit(1);
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
  log(`OK ${outDir}/ 已生成`);
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
