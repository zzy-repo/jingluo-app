#!/usr/bin/env node
/**
 * check-manifest-fixtures.mjs —— releases.json 校验器的**门禁**（Issue #330）
 *
 * 为什么需要这一层：`scripts/validate-releases-manifest.mjs` 早就对非法 buildType 判 FAIL 了，
 * 但 2026-11-19 的事故说明「判 FAIL」和「有人真的会跑」是两件事 —— 没有任何 CI 步骤跑它，
 * 于是 11 条 `buildType:"release"` 一路发到线上，客户端整份清单拒收。
 *
 * 这个脚本把「校验器本身还活着」变成一条命令：
 *   - 合法 fixture **必须 PASS**（否则门禁是一刀切的 red，没人敢开）
 *   - 每个 `invalid-*.json` **必须 FAIL**（否则门禁空跑：校验器被改回 warning 也看不出来）
 *   - 事故 fixture 额外断言「11 条非法」逐条报出，而不是只报第一条就停
 *
 * 用法：node scripts/check-manifest-fixtures.mjs   （或 pnpm run check:manifest）
 * 退出码：0 全部符合预期 / 1 有 fixture 结果不符 / 2 环境问题
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'deploy/dl-release/fixtures');
const VALIDATOR = path.join(ROOT, 'scripts/validate-releases-manifest.mjs');

/** 合法清单：必须 PASS（非 strict —— 历史条目缺 sha256/artifactVariant 是已知的 warning） */
const MUST_PASS = ['live-2026-11-18.json', 'proposed-beta4-internal.json'];
/** 非法清单：必须以「结构性 dirty」被拦下（fail-closed） */
const MUST_FAIL = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.startsWith('invalid-') && f.endsWith('.json'))
  .sort();
/** 事故 fixture：11 条 buildType:"release"，必须逐条报出（Issue #330） */
const ACCIDENT = { file: 'invalid-buildtype-release.json', expectedErrors: 11 };

const run = (file) =>
  spawnSync(process.execPath, [VALIDATOR, path.join(FIXTURES, file)], { encoding: 'utf8' });

let failed = 0;

for (const file of MUST_PASS) {
  const r = run(file);
  if (r.status === 0) {
    console.log(`  ok    PASS  ${file}（合法清单没被误杀）`);
  } else {
    failed++;
    console.log(`  FAIL  ${file} 本该 PASS，实际 exit=${r.status}\n${r.stdout}`);
  }
}

for (const file of MUST_FAIL) {
  const r = run(file);
  if (r.status !== 0) {
    console.log(`  ok    FAIL  ${file}（被拦下，exit=${r.status}）`);
  } else {
    failed++;
    console.log(`  FAIL  ${file} 本该被拦下却 exit=0 —— 门禁空跑，校验器被判成放行`);
  }
}

{
  const r = run(ACCIDENT.file);
  const detail = (r.stdout.match(/✗ [^\n]*buildType/g) || []).length;
  if (r.status !== 0 && detail === ACCIDENT.expectedErrors) {
    console.log(`  ok    事故清单 ${ACCIDENT.file}：exit=${r.status}，逐条报出 ${detail} 条非法 buildType`);
  } else {
    failed++;
    console.log(
      `  FAIL  事故清单 ${ACCIDENT.file}：期望 exit≠0 且 ${ACCIDENT.expectedErrors} 条非法，` +
        `实际 exit=${r.status}、${detail} 条\n${r.stdout}`,
    );
  }
}

console.log(
  `\n合计 ${MUST_PASS.length + MUST_FAIL.length} 个 fixture + 1 条事故断言, FAIL=${failed} ` +
    `（合法必过 / 非法必拦 / 事故清单 11 条逐条报出）`,
);
process.exit(failed ? 1 : 0);
