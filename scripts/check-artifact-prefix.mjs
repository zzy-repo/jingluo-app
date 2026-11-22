#!/usr/bin/env node
/**
 * check-artifact-prefix.mjs —— 安装包产物文件名前缀门禁（Issue #836 scope ①）
 *
 * ## 为什么要这条门禁
 *
 * #836 把产物文件名从 `deepseek-chat-<version>.apk` 改成 `jingluo-chat-<version>.apk`。
 * 这类改名的失败方式**不是构建红**，而是「改了 3/5 处」：
 *
 *   - CI（`.github/workflows/release.yml`）按新名字产出 GitHub 资产；
 *   - 私有发布脚本还在写老名字；
 *   - 分发接口 `deploy/dl-release/server.mjs` 落盘用老名字；
 *   - 文档/清单示例还是老名字。
 *
 * 每一种单独看都能跑绿、下载也能用（客户端按清单的 `file` 字段下载，不按版本号拼名字），
 * 于是「名字有几份」这件事没人发现，直到有人按文件名对账。所以这里把两条性质钉死：
 *
 * ## 判据
 *
 * 静态（读文本，**先剥注释**——注释里讲历史是应该的，代码里再来一份才是病）：
 *   P1 配置：`config/appIdentity.json` 的 `artifactPrefix` 存在、语法合法、且**不是**历史前缀
 *      `deepseek-chat`（改回去等于撤销 #836）；
 *   P2 生产者无字面量：`scripts/`、`shared/`、`deploy/`、`.github/workflows/`、`config/`、
 *      `android/app/build.gradle` 的**代码**里不许出现
 *        a) 历史前缀 `deepseek-chat-`（除允许清单：负向对照夹具 / 历史事故注释）；
 *        b) 形如 `'<当前前缀>-….apk'` 的文件名字面量，或 `prefix = '<当前前缀>'` 的常量
 *           —— 那就是「又一处硬编码」，下次改名它不会跟着动。
 *
 * 行为（import 真模块、调真函数 —— 纯文本判定挡不住「常量改了但用法没改」）：
 *   P3 生成一致：`publish-private-apk.mjs` 的 `buildFileName()` 与
 *      `scripts/artifact-name.mjs`（CI 用的那个 CLI）对同一版本给出**同一串名字**，
 *      且都等于 `<config.artifactPrefix>-…`；`FILE_PREFIX` 也等于配置值；
 *   P4 影子一致：清单 `file` 字段（`fileField()`）与 `shared/artifact-name.mjs` 的
 *      `artifactFileField()` 同一串；
 *   P5 识别不退化：G4 孤儿检测（`gateOrphanFiles()`）对**历史前缀**的老包仍然咬得住
 *      —— 老包躺在 `apk/` 下没登记，和 #601 的形态一模一样，改名不许让它失明。
 *
 * ## 负向对照（`--selftest`，CI 也跑它）
 *
 *   ① 配置里把 `artifactPrefix` 改回 `deepseek-chat` → P1 必须红；
 *   ② 往 `release.yml` 的文本里塞回 `apk="deepseek-chat-${version}.apk"` → P2 必须红；
 *   ③ 往发布脚本文本里塞 `FILE_PREFIX = 'jingluo-chat'` → P2 必须红；
 *   ④ 正本（磁盘上的真文件 + 真配置）必须**绿** —— 恒红的门禁等于没有门禁。
 *
 * ## 用法
 *
 *   node scripts/check-artifact-prefix.mjs              # 门禁（CI 跑这条）
 *   pnpm run check:artifact-prefix
 *   node scripts/check-artifact-prefix.mjs --selftest   # 自带负向对照（改回老前缀必须红）
 *   node scripts/check-artifact-prefix.mjs --verbose
 *
 * 退出码：0 通过 / 1 有违规 / 2 用法或环境错误
 *
 * 纯本地：不连 ssh、不碰分发机、不构建 APK。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LEGACY_ARTIFACT_PREFIXES,
  RE_ARTIFACT_PREFIX,
  artifactFileField,
  isArtifactPrefix,
  isLegacyArtifactPrefix,
} from '../shared/artifact-name.mjs';
import { APP_IDENTITY_REL_PATH, loadAppIdentity, validateAppIdentity } from './lib/appIdentity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 规则代码 → 人话（报告与 ci.yml 的 grep 用这套标签，别随便改） */
export const RULES = Object.freeze({
  P1: 'P1 config/appIdentity.json 的 artifactPrefix 缺失/非法/是历史前缀',
  P2: 'P2 代码里又写了一份产物名字面量（改名不会跟着动）',
  P3: 'P3 发布脚本与 CI CLI 生成的产物名不一致',
  P4: 'P4 清单 file 字段的两个实现不一致',
  P5: 'P5 孤儿检测对历史前缀的包失明（#601 形态）',
});

/**
 * 扫哪些位置找「字面量副本」。生产者在这些目录里：发布脚本、分发接口、CI、配置。
 * `android/app/build.gradle` 单独列（APK 里的 label/package 由它出，注释里留着 #601 的历史）。
 */
export const SCAN_TARGETS = Object.freeze([
  'scripts',
  'shared',
  'deploy',
  'config',
  '.github/workflows',
  'android/app/build.gradle',
]);

/**
 * 允许出现「历史前缀」的位置。每一条都要写清为什么 —— 这不是图省事的口子，
 * 而是「负向对照夹具 / 历史事故记录」这两类**合法**用途。
 */
export const LEGACY_LITERAL_ALLOWED = Object.freeze([
  // 本门禁自己：`--selftest` 的负向对照必须把「坏字面量」原样写出来才喂得进去
  /^scripts\/check-artifact-prefix\.mjs$/,
  // 负向对照夹具：门禁的演练要在本地假 webroot 里摆出 #601 现场那个文件名
  /^scripts\/check-webroot-hygiene\.mjs$/,
  // 截图夹具：模拟一条「清单里已有老包」的记录（界面只读 file 字段，与名字无关）
  /^scripts\/shot-mobile\.mjs$/,
  // CI 负向对照：造一个干净 webroot 再往里注入脏东西，用的就是历史包名
  /^\.github\/workflows\/ci\.yml$/,
  // 分发接口与校验器的**测试 + 清单夹具**：历史包（含 2026-11-18 的线上快照）必须原样保留
  /^deploy\/dl-release\/test\//,
  /^deploy\/dl-release\/fixtures\//,
  // 部署文档里的「历史资产长什么样」示例
  /^deploy\/README\.md$/,
  // build.gradle 里 #601 的事故记录（注释）
  /^android\/app\/build\.gradle$/,
]);

/**
 * 「当前前缀」这条判据的唯一例外：唯一来源本身。
 * 别的地方写 `'jingluo-chat'` 或 `prefix = 'jingluo-chat'` 都算又一份副本。
 */
export const CURRENT_PREFIX_ALLOWED = Object.freeze([/^config\/appIdentity\.json$/]);

const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml', '.gradle', '.sh']);

/** 剥掉注释：注释里讲历史/举例子是应该的，代码里再来一份才是「又一处硬编码」 */
export const stripComments = (text) =>
  text
    // 块注释：**保留换行**，否则后面的行号会错位（报告要点到准确的行）
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => {
      const noSlash = line.replace(/\/\/.*$/, '');
      // YAML / shell 的 `#` 注释（只在行首或空白后，避免砍掉 URL 里的 #）
      return noSlash.replace(/(^|\s)#[^\n]*$/, '$1');
    })
    .join('\n');

const toPosix = (p) => p.split(path.sep).join('/');

const collectTextFiles = (root, rel, out) => {
  const abs = path.join(root, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) out.push(toPosix(rel));
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        // `.github` 例外：CI 是生产者之一
        if (entry.name === '.github') collectTextFiles(root, child, out);
        continue;
      }
      collectTextFiles(root, child, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(toPosix(child));
  }
};

/** 读扫描范围内的所有文本文件（相对路径 + 内容） */
export const readScanFiles = (root = ROOT) => {
  const files = [];
  for (const target of SCAN_TARGETS) collectTextFiles(root, target, files);
  return files.map((rel) => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }));
};

/**
 * P1：配置判据（纯函数，`--selftest` 用它喂改坏的配置）。
 * @param {object} config `config/appIdentity.json` 解析后的对象
 * @returns {{code:string, message:string}[]}
 */
export const analyzeConfig = (config) => {
  const violations = [];
  const push = (detail) => violations.push({ code: 'P1', message: `${RULES.P1}：${detail}` });
  const valid = validateAppIdentity(config);
  // artifactPrefix 自己那几条已经由 config 校验器给出（缺字段 / 语法 / 历史前缀）
  const own = valid.filter((p) => p.indexOf('artifactPrefix') !== -1);
  for (const p of own) push(p);
  if (own.length === 0 && !isArtifactPrefix(config && config.artifactPrefix)) {
    push('artifactPrefix 读不出来（既没报错也不合法，说明校验器漏了这条）');
  }
  return violations;
};

/**
 * P2：生产者代码里不许有第二份字面量（纯函数，`--selftest` 用它喂改坏的文本）。
 * @param {{rel:string, text:string}[]} files
 * @param {string} prefix 当前前缀（来自 config）
 * @returns {{code:string, file:string, line:number, message:string}[]}
 */
export const scanProducerLiterals = (files, prefix) => {
  const violations = [];
  const legacyRes = LEGACY_ARTIFACT_PREFIXES.map((legacy) => ({
    legacy,
    re: new RegExp(`(^|[^A-Za-z0-9_-])${legacy}-`),
  }));
  // 当前前缀的「文件名形态字面量」：`'jingluo-chat-1.5.0.apk'` 这种，以及 `prefix = 'jingluo-chat'`
  const currentNameRe = new RegExp(`['"\`]${prefix}-[A-Za-z0-9.$_]`);
  const currentConstRe = new RegExp(`(?:prefix|prefixname)\\s*[:=]\\s*['"\`]${prefix}['"\`]`, 'i');
  for (const file of files) {
    const allowed = LEGACY_LITERAL_ALLOWED.some((re) => re.test(file.rel));
    const currentAllowed = CURRENT_PREFIX_ALLOWED.some((re) => re.test(file.rel));
    const code = stripComments(file.text);
    code.split('\n').forEach((line, index) => {
      if (allowed) return;
      for (const { legacy, re } of legacyRes) {
        if (re.test(line)) {
          violations.push({
            code: 'P2',
            file: file.rel,
            line: index + 1,
            message:
              `${RULES.P2}：这里写死了历史前缀 "${legacy}-" —— 产物名只许从 ` +
              `${APP_IDENTITY_REL_PATH} 的 artifactPrefix 生成（要读就 import scripts/lib/artifactName.mjs）；` +
              `确实是负向对照/历史夹具，请加进本脚本的 LEGACY_LITERAL_ALLOWED 并写明理由`,
          });
        }
      }
      if (!currentAllowed && (currentNameRe.test(line) || currentConstRe.test(line))) {
        violations.push({
          code: 'P2',
          file: file.rel,
          line: index + 1,
          message:
            `${RULES.P2}：这里写死了当前前缀的文件名/常量 "${prefix}" —— 下次改名它不会跟着动。` +
            `产物名唯一来源是 ${APP_IDENTITY_REL_PATH} 的 artifactPrefix（#836）`,
        });
      }
    });
  }
  return violations;
};

/**
 * P3 / P4 / P5：行为判据（import 真模块调真函数）。
 * @returns {Promise<{code:string, message:string}[]>}
 */
export const checkBehavior = async () => {
  const violations = [];
  const fail = (code, detail) => violations.push({ code, message: `${RULES[code]}：${detail}` });

  // publish-private-apk 在 import 期就会读配置（前缀唯一来源），配置坏了这里直接抛
  const publish = await import(pathToFileURL(path.join(ROOT, 'scripts/publish-private-apk.mjs')).href);
  const shared = await import(pathToFileURL(path.join(ROOT, 'shared/artifact-name.mjs')).href);
  const prefix = loadAppIdentity(ROOT).artifactPrefix;

  // P3：私有发布脚本生成的名字必须跟着配置走
  if (publish.FILE_PREFIX !== prefix) {
    fail('P3', `publish-private-apk.mjs 的 FILE_PREFIX=${JSON.stringify(publish.FILE_PREFIX)} ≠ 配置 ${JSON.stringify(prefix)}`);
  }
  const internalName = publish.buildFileName({ version: '1.5.0', variant: 'internal', suffix: 'HJ5NWRHQ' });
  const wantInternal = shared.artifactFileName({ prefix, version: '1.5.0', variant: 'internal', suffix: 'HJ5NWRHQ' });
  if (internalName !== wantInternal) {
    fail('P3', `私有包名 ${internalName} ≠ 配置推出的 ${wantInternal}`);
  }
  if (internalName.indexOf(`${prefix}-`) !== 0) {
    fail('P3', `私有包名的前缀不是 ${prefix}：${internalName}`);
  }

  // P3：CI 用的 CLI（node scripts/artifact-name.mjs）必须给出同一串
  const cli = await runCli(['--version', '1.5.0']);
  if (cli.code !== 0) {
    fail('P3', `node scripts/artifact-name.mjs --version 1.5.0 退出码 ${cli.code}：${cli.stderr.trim()}`);
  } else if (cli.stdout.trim() !== `${prefix}-1.5.0.apk`) {
    fail('P3', `CI CLI 打出 ${JSON.stringify(cli.stdout.trim())}，应为 ${prefix}-1.5.0.apk`);
  }

  // P4：清单 file 字段两条实现同一串
  const field = publish.fileField(`${prefix}-1.5.0.apk`);
  if (field !== shared.artifactFileField(`${prefix}-1.5.0.apk`)) {
    fail('P4', `fileField()=${field} ≠ artifactFileField()=${shared.artifactFileField(`${prefix}-1.5.0.apk`)}`);
  }

  // P5：孤儿检测必须同时咬住新前缀与历史前缀（#601 形态对老包同样成立）
  const legacy = LEGACY_ARTIFACT_PREFIXES[0];
  const gate = publish.gateOrphanFiles({
    manifest: { releases: [{ file: `apk/${prefix}-1.5.0.apk` }] },
    presentFiles: [`apk/${prefix}-1.5.0.apk`, `apk/${legacy}-1.4.5.apk`, 'apk/README.md'],
  });
  const text = gate.join('\n');
  if (!text.includes(`apk/${legacy}-1.4.5.apk`)) {
    fail('P5', `G4 孤儿检测放过了历史前缀的老包（改名让这道闸失明）：${text || '(没有任何报错)'}`);
  }
  if (!text.includes('G4')) fail('P5', `G4 报错了但没点出规则名：${text}`);
  if (text.includes('README.md')) fail('P5', `G4 把人家放的 README 当成孤儿了（判据过宽）：${text}`);
  const clean = publish.gateOrphanFiles({
    manifest: { releases: [{ file: `apk/${prefix}-1.5.0.apk` }] },
    presentFiles: [`apk/${prefix}-1.5.0.apk`],
  });
  if (clean.length !== 0) fail('P5', `登记齐全时 G4 不该报错：${clean.join('\n')}`);

  return violations;
};

/** 跑一次 CLI（子进程，拿它的真实输出 —— 不 import 它，免得 process.exitCode 影响本进程） */
const runCli = (argv) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/artifact-name.mjs')].concat(argv), {
      cwd: ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/**
 * 完整门禁：静态（P1 配置 / P2 生产者字面量）+ 行为（P3–P5）。
 *
 * **配置判不了就到此为止**：P3–P5 每一步都要先把 `config/appIdentity.json` 读进来（发布脚本在
 * import 期就读它），配置坏了那里只会抛出 AppIdentityError。把它兜住 = 一条 P1 违规，
 * 而不是让整个门禁崩成一屏堆栈 —— 崩掉的门禁读不出「红在哪条判据上」，CI 也没法 grep P1。
 * @param {string} [root]
 * @returns {Promise<{code:string, message:string, file?:string, line?:number}[]>}
 */
export const runGate = async (root = ROOT) => {
  const files = readScanFiles(root);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, APP_IDENTITY_REL_PATH), 'utf8'));
  } catch (error) {
    return [{ code: 'P1', message: `${RULES.P1}：读不到 / 解析不了 ${APP_IDENTITY_REL_PATH}：${error.message}` }];
  }
  const prefix = isArtifactPrefix(config.artifactPrefix) ? config.artifactPrefix : '<artifactPrefix 不合法>';
  const staticViolations = analyzeConfig(config).concat(scanProducerLiterals(files, prefix));
  if (staticViolations.some((v) => v.code === 'P1')) return staticViolations;
  if (root !== ROOT) return staticViolations;
  try {
    staticViolations.push(...(await checkBehavior()));
  } catch (error) {
    // 走到这里说明配置「看起来合法但用不了」（例如被别处改坏的字段）：同样按配置问题报
    staticViolations.push({
      code: 'P1',
      message: `${RULES.P1}：按这份配置跑不动生成侧（${error.name || 'Error'}）：${error.message.split('\n')[0]}`,
    });
  }
  return staticViolations;
};

/**
 * 负向对照：把「改坏的样子」喂给纯函数，逐个确认门禁会红；
 * 同时确认正本（磁盘上的真配置 + 真代码）是绿的。
 * @returns {{ok:boolean, failures:string[], rows:Array<{id:string, why:string}>}}
 */
export const selftest = async (root = ROOT) => {
  const failures = [];
  const rows = [];
  const files = readScanFiles(root);
  const config = JSON.parse(fs.readFileSync(path.join(root, APP_IDENTITY_REL_PATH), 'utf8'));
  const prefix = config.artifactPrefix;

  // ① 正本必须绿（静态部分；行为部分单独在 runGate 里，避免和这里重复跑）
  const positive = analyzeConfig(config).concat(scanProducerLiterals(files, prefix));
  if (positive.length) {
    failures.push(`正本（真实配置 + 真实代码）应当判绿，实际 ${positive.length} 条：${positive[0].message}`);
  }
  rows.push({ id: '正本', why: `当前 ${APP_IDENTITY_REL_PATH} 的 artifactPrefix=${prefix}，生产者代码零字面量` });

  // ② 配置改回历史前缀 → P1 必须红
  const legacyBack = analyzeConfig({ ...config, artifactPrefix: LEGACY_ARTIFACT_PREFIXES[0] });
  if (!legacyBack.some((v) => v.code === 'P1')) {
    failures.push('负向对照失败：artifactPrefix 改回历史前缀后门禁仍然通过');
  } else {
    rows.push({ id: '②', why: `artifactPrefix 改回 ${LEGACY_ARTIFACT_PREFIXES[0]} → P1 红：${legacyBack[0].message.slice(0, 60)}…` });
  }

  // ③ CI 里塞回老字面量 → P2 必须红
  const injectedCi = files.map((f) =>
    f.rel === '.github/workflows/release.yml'
      ? { rel: f.rel, text: `${f.text}\n          apk="deepseek-chat-\${version}.apk"\n` }
      : f,
  );
  const ciHit = scanProducerLiterals(injectedCi, prefix).filter((v) => v.code === 'P2');
  if (!ciHit.length) {
    failures.push('负向对照失败：release.yml 里塞回 old-prefix 字面量后门禁仍然通过');
  } else {
    rows.push({ id: '③', why: `${ciHit[0].file}:${ciHit[0].line} 被点到（历史前缀字面量）` });
  }

  // ④ 发布脚本里塞回「当前前缀常量」 → 也要红（防「这次改完了，下次再抄一份」）
  const injectedScript = files.map((f) =>
    f.rel === 'scripts/publish-private-apk.mjs'
      ? { rel: f.rel, text: `${f.text}\nexport const FILE_PREFIX = '${prefix}';\n` }
      : f,
  );
  const scriptHit = scanProducerLiterals(injectedScript, prefix).filter((v) => v.code === 'P2');
  if (!scriptHit.length) {
    failures.push('负向对照失败：发布脚本里塞回 artifactPrefix 常量后门禁仍然通过');
  } else {
    rows.push({ id: '④', why: `${scriptHit[0].file}:${scriptHit[0].line} 被点到（当前前缀常量）` });
  }

  return { ok: failures.length === 0, failures, rows };
};

// ---------------------------------------------------------------- CLI
const main = async (argv) => {
  const flags = new Set(argv);
  if (flags.has('-h') || flags.has('--help')) {
    process.stdout.write(
      '用法: node scripts/check-artifact-prefix.mjs [--selftest] [--verbose]\n' +
        '  产物文件名前缀必须是 config/appIdentity.json 的 artifactPrefix（#836）\n',
    );
    return 0;
  }
  const verbose = flags.has('--verbose');
  if (flags.has('--selftest')) {
    const result = await selftest();
    for (const row of result.rows) console.log(`  ✓ [${row.id}] ${row.why}`);
    if (!result.ok) {
      console.error(`\n✗ 负向对照失败 ${result.failures.length} 条：`);
      for (const failure of result.failures) console.error(`  - ${failure}`);
      return 1;
    }
    console.log('\n✓ 负向对照全过（正本绿 + 三种改坏的样子都红）');
    return 0;
  }
  const violations = await runGate();
  if (!violations.length) {
    const prefix = loadAppIdentity(ROOT).artifactPrefix;
    console.log(`✓ 产物前缀 ${prefix}（P1–P5 全部通过：配置唯一来源 / 生产者无字面量 / 生成与识别一致）`);
    if (verbose) {
      for (const code of Object.keys(RULES)) console.log(`  ✓ ${code} ${RULES[code]}`);
    }
    return 0;
  }
  console.error(`✗ ${violations.length} 处违规：`);
  for (const v of violations) {
    const where = v.file ? `${v.file}${v.line ? `:${v.line}` : ''} → ` : '';
    console.error(`  - ${where}${v.message}`);
  }
  return 1;
};

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
