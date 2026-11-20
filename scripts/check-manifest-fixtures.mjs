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
 *   - #609：公网口径与私有口径必须**分得开** —— 同一份 internal 形状的清单，公网口径必红
 *     （「公网清单不得出现 internal 条目」）、私有口径（`--private`）必过
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

/**
 * 公网清单口径下必须 PASS 的合法 fixture（非 strict —— 历史条目缺 sha256/artifactVariant 是已知 warning）。
 *
 * #609 / 裁决 #614 决定 3 之后这里**只剩公网清单**：`internal` 条目在公网口径下是硬 FAIL，
 * 原来那两个 `proposed-*-internal*.json` 已改名为 `invalid-internal-in-public-*.json` 并挪到反例侧
 * —— 它们的形状（internal 条目 + 公共 latest 不动）正是 #601 泄漏的那一份，现在**必须被拦下**。
 */
const MUST_PASS = ['live-2026-11-18.json'];
/** 私有清单口径（`--private`）下必须 PASS 的 fixture：webroot 外的 `releases.internal.json` 的形状 */
const MUST_PASS_PRIVATE = ['private-valid-internal.json'];
/** 非法清单：必须以「结构性 dirty」被拦下（fail-closed）。`invalid-*` 走公网口径 */
const MUST_FAIL = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.startsWith('invalid-') && f.endsWith('.json'))
  .sort();
/** 私有口径下的非法清单：`private-invalid-*` 必须被 `--private` 拦下 */
const MUST_FAIL_PRIVATE = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.startsWith('private-invalid-') && f.endsWith('.json'))
  .sort();
/** 事故 fixture：11 条 buildType:"release"，必须逐条报出（Issue #330） */
const ACCIDENT = { file: 'invalid-buildtype-release.json', expectedErrors: 11 };

const run = (file, { private: isPrivate = false } = {}) =>
  spawnSync(
    process.execPath,
    [VALIDATOR, path.join(FIXTURES, file), ...(isPrivate ? ['--private'] : [])],
    { encoding: 'utf8' },
  );

let failed = 0;

for (const [files, opts, label] of [
  [MUST_PASS, {}, '合法清单没被误杀'],
  [MUST_PASS_PRIVATE, { private: true }, '合法私有清单没被误杀'],
]) {
  for (const file of files) {
    const r = run(file, opts);
    if (r.status === 0) {
      console.log(`  ok    PASS  ${file}（${label}）`);
    } else {
      failed++;
      console.log(`  FAIL  ${file} 本该 PASS，实际 exit=${r.status}\n${r.stdout}`);
    }
  }
}

for (const [files, opts] of [
  [MUST_FAIL, {}],
  [MUST_FAIL_PRIVATE, { private: true }],
]) {
  for (const file of files) {
    const r = run(file, opts);
    if (r.status !== 0) {
      console.log(`  ok    FAIL  ${file}（被拦下，exit=${r.status}${opts.private ? '，私有口径' : ''}）`);
    } else {
      failed++;
      console.log(`  FAIL  ${file} 本该被拦下却 exit=0 —— 门禁空跑，校验器被判成放行`);
    }
  }
}

// #609 的口径本身也要有对照：**同一份 internal 形状的清单**在公网口径必红、在私有口径必过。
// 只断言「公网红」不够 —— 校验器被改成恒红也能满足它；两条腿一起才证明口径是分得开的。
{
  const internalFile = 'private-valid-internal.json';
  const asPublic = run(internalFile);
  const asPrivate = run(internalFile, { private: true });
  const redOnPublic = asPublic.status !== 0 && /公网清单不得出现 internal 条目/.test(asPublic.stdout);
  if (redOnPublic && asPrivate.status === 0) {
    console.log(`  ok    口径分离：${internalFile} 在公网口径 exit=${asPublic.status}（报「不得出现 internal」），私有口径 exit=0`);
  } else {
    failed++;
    console.log(
      `  FAIL  口径分离：${internalFile} 公网口径 exit=${asPublic.status}、私有口径 exit=${asPrivate.status}` +
        `（期望 公网≠0 且报「不得出现 internal」、私有=0）\n--- 公网 ---\n${asPublic.stdout}\n--- 私有 ---\n${asPrivate.stdout}`,
    );
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
  `\n合计 ${MUST_PASS.length + MUST_FAIL.length} 个公网 fixture + ` +
    `${MUST_PASS_PRIVATE.length + MUST_FAIL_PRIVATE.length} 个私有 fixture + ` +
    `1 条口径分离断言 + 事故断言, FAIL=${failed} ` +
    `（合法必过 / 非法必拦 / 公网清单不收 internal / 私有清单不收 standard / 事故清单 11 条逐条报出）`,
);
process.exit(failed ? 1 : 0);
