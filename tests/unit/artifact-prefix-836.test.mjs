// [layer: unit | 纯 Node，无浏览器无网络（不 ssh、不构建 APK）| 耗时: <2s]
// 产物文件名前缀（Issue #836 scope ①）的契约。
//
// 这一单只改**文件名**：`deepseek-chat-<ver>.apk` → `jingluo-chat-<ver>.apk`。
// 应用显示名（label）与 applicationId **一个字都没动** —— 它们和产物前缀现在同住
// `config/appIdentity.json`，将来维护者要改那两项时也是一处改。
//
// 这里钉住三件事：
//   1) 唯一来源：配置里有 `artifactPrefix`，且所有生产者（私有发布脚本 / CI CLI / 分发接口 /
//      校验器）都从它派生，不再有第二份字面量（`pnpm check:artifact-prefix` 的同一套判据）；
//   2) 历史资产可继续用：老包名 `deepseek-chat-*.apk` 仍然被「本仓产物」判据认出来
//      （G4 孤儿检测不许因为改名对老文件失明）；
//   3) 新旧混用是安全的：客户端按清单的 `file` 字段下载（`src/services/updateManifest.ts`
//      的 `releaseUrl()` / `downloadTarget()`），从不拿版本号拼名字 —— 所以老条目留老名字、
//      新条目用新名字，两台分发机上并存不会有任何一条下载 404。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_ARTIFACT_PREFIXES,
  artifactFileName,
  artifactFileField,
  isArtifactFile,
  isArtifactPrefix,
  isLegacyArtifactPrefix,
} from '../../shared/artifact-name.mjs'
import { loadAppIdentity, validateAppIdentity } from '../../scripts/lib/appIdentity.mjs'
import { analyzeConfig, scanProducerLiterals, stripComments } from '../../scripts/check-artifact-prefix.mjs'
import { validate as validateManifest } from '../../scripts/validate-releases-manifest.mjs'
import { buildFileName, fileField, gateOrphanFiles, FILE_PREFIX } from '../../scripts/publish-private-apk.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/appIdentity.json'), 'utf8'))
const PREFIX = CONFIG.artifactPrefix
const LEGACY = LEGACY_ARTIFACT_PREFIXES[0]

/** 跑一次 CLI，回 stdout（trim 过） */
const cli = (...argv) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/artifact-name.mjs')].concat(argv), {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}

test('配置：artifactPrefix 是唯一来源，且当前值是 jingluo-chat', () => {
  assert.equal(PREFIX, 'jingluo-chat', 'config/appIdentity.json 的 artifactPrefix')
  assert.ok(isArtifactPrefix(PREFIX), '前缀语法合法（小写 + 连字符）')
  assert.equal(isLegacyArtifactPrefix(PREFIX), false, '新前缀不许是历史前缀')
  assert.deepEqual(validateAppIdentity(CONFIG), [], '整份配置合法')
  // 身份三项**没动**（scope ① 只改文件名；②③ 明确不在本单）
  assert.equal(CONFIG.applicationId, 'com.example.deepseekchat')
  assert.deepEqual(CONFIG.label, { zh: '鲸落', en: 'Whale Fall' })
})

test('配置：artifactPrefix 缺失 / 非法 / 写回历史前缀都要被判红', () => {
  const { artifactPrefix, ...missing } = CONFIG
  assert.ok(validateAppIdentity(missing).some((p) => p.includes('artifactPrefix')), '缺字段 → 报错')
  for (const bad of ['Jingluo_Chat', ' jingluo-chat', 'jingluo chat', '']) {
    assert.ok(
      validateAppIdentity({ ...CONFIG, artifactPrefix: bad }).length > 0,
      `非法前缀应报错：${JSON.stringify(bad)}`,
    )
  }
  assert.ok(
    validateAppIdentity({ ...CONFIG, artifactPrefix: LEGACY }).some((p) => p.includes('历史前缀')),
    '写回历史前缀 → 报错（等于撤销 #836）',
  )
})

test('名字拼法：standard / internal 两种形态都从配置前缀派生', () => {
  assert.equal(artifactFileName({ prefix: PREFIX, version: '1.5.0' }), `${PREFIX}-1.5.0.apk`)
  assert.equal(
    artifactFileName({ prefix: PREFIX, version: '1.5.0', variant: 'internal', suffix: 'HJ5NWRHQ' }),
    `${PREFIX}-1.5.0-internal-HJ5NWRHQ.apk`,
  )
  assert.equal(artifactFileField(`${PREFIX}-1.5.0.apk`), `apk/${PREFIX}-1.5.0.apk`)
  // 非法入参一律抛（不猜名字）
  assert.throws(() => artifactFileName({ prefix: 'Bad_Prefix', version: '1.5.0' }))
  assert.throws(() => artifactFileName({ prefix: PREFIX, version: 'v1.5' }))
  assert.throws(() => artifactFileName({ prefix: PREFIX, version: '1.5.0', variant: 'internal', suffix: 'short' }))
})

test('发布脚本与 CI CLI 生成同一串名字（前缀来自配置，不是字面量）', () => {
  assert.equal(FILE_PREFIX, PREFIX, 'publish-private-apk.mjs 的 FILE_PREFIX 跟着配置走')
  assert.equal(
    buildFileName({ version: '1.5.0', variant: 'internal', suffix: 'HJ5NWRHQ' }),
    `${PREFIX}-1.5.0-internal-HJ5NWRHQ.apk`,
  )
  assert.equal(fileField(`${PREFIX}-1.5.0.apk`), `apk/${PREFIX}-1.5.0.apk`)

  const standard = cli('--version', '1.5.0')
  assert.equal(standard.code, 0, standard.err)
  assert.equal(standard.out, `${PREFIX}-1.5.0.apk`, 'CI 用的 CLI 打出的名字')
  assert.equal(cli('--version', '1.5.0', '--field').out, `apk/${PREFIX}-1.5.0.apk`)
  assert.equal(cli('--prefix').out, PREFIX)
  assert.equal(
    cli('--version', '1.5.0', '--variant', 'internal', '--suffix', 'HJ5NWRHQ').out,
    `${PREFIX}-1.5.0-internal-HJ5NWRHQ.apk`,
  )
  // 配置读不到时不许「猜一个名字」：非 0 退出
  assert.notEqual(cli('--version', 'not-a-version').code, 0, '非法版本号 → exit 非 0')
})

test('历史资产：老包名仍然是「本仓产物」（G4 孤儿检测不许失明）', () => {
  assert.equal(isArtifactFile(`apk/${PREFIX}-1.5.0.apk`, { prefix: PREFIX }), true, '新名字认')
  assert.equal(isArtifactFile(`apk/${LEGACY}-1.4.5.apk`, { prefix: PREFIX }), true, '老名字也认')
  assert.equal(isArtifactFile('apk/README.md', { prefix: PREFIX }), false, '人家的 README 不算孤儿')
  assert.equal(
    isArtifactFile(`apk/${LEGACY}-1.4.5.apk`, { prefix: PREFIX, includeLegacy: false }),
    false,
    '只认当前前缀时（不用于识别场景）',
  )

  const orphans = gateOrphanFiles({
    manifest: { releases: [{ file: `apk/${PREFIX}-1.5.0.apk` }] },
    presentFiles: [`apk/${PREFIX}-1.5.0.apk`, `apk/${LEGACY}-1.4.5.apk`],
  })
  const text = orphans.join('\n')
  assert.match(text, /G4/, '老包没登记 → 必须报 G4 孤儿')
  assert.match(text, new RegExp(`${LEGACY}-1\\.4\\.5\\.apk`), '报错要点名那个老文件')
  assert.deepEqual(
    gateOrphanFiles({ manifest: { releases: [{ file: `apk/${PREFIX}-1.5.0.apk` }] }, presentFiles: [`apk/${PREFIX}-1.5.0.apk`] }),
    [],
    '登记齐全 → 不报',
  )
})

test('新旧混用安全：清单校验器同时接受两种前缀的 file（客户端按 file 下载，不按 version 拼）', () => {
  /** 造一条最小合法记录 */
  const row = (version, file) => ({
    version,
    versionCode: 100,
    releasedAt: '2026-11-22T10:00:00+08:00',
    file,
    size: 1024,
    md5: 'a'.repeat(32),
    sha256: 'b'.repeat(64),
    changes: ['x'],
    buildType: 'stable',
    breaking: false,
    artifactVariant: 'standard',
    artifactVariantSource: 'apk-manifest',
  })
  // 同构（新 / 老前缀）都不许有 warning；名字对不上才提醒
  const same = validateManifest({ latest: '1.5.0', releases: [row('1.5.0', `apk/${PREFIX}-1.5.0.apk`)] })
  assert.deepEqual(same.errors, [])
  assert.equal(
    same.warnings.filter((w) => w.includes('不同构')).length,
    0,
    `新前缀同构不该有「不同构」warning：${same.warnings.join('；')}`,
  )
  const legacy = validateManifest({ latest: '1.4.5', releases: [row('1.4.5', `apk/${LEGACY}-1.4.5.apk`)] })
  assert.deepEqual(legacy.errors, [])
  assert.equal(
    legacy.warnings.filter((w) => w.includes('不同构')).length,
    0,
    `老条目（历史资产，未改名）也不该被提醒：${legacy.warnings.join('；')}`,
  )
  const odd = validateManifest({ latest: '1.5.0', releases: [row('1.5.0', 'apk/whatever-1.5.0.apk')] })
  assert.equal(odd.warnings.filter((w) => w.includes('不同构')).length, 1, '真的不同构才提醒')
})

test('门禁：实际仓库判绿；配置改回历史前缀 / 代码再现字面量都必须判红', () => {
  assert.deepEqual(analyzeConfig(CONFIG), [], '正本配置：零违规')
  const back = analyzeConfig({ ...CONFIG, artifactPrefix: LEGACY })
  assert.equal(back.length, 1, '改回历史前缀 → 1 条违规')
  assert.equal(back[0].code, 'P1')

  // 生产者里塞一份老字面量 → P2
  const ciText = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
  const hit = scanProducerLiterals(
    [{ rel: '.github/workflows/release.yml', text: `${ciText}\n          apk="${LEGACY}-\${version}.apk"\n` }],
    PREFIX,
  )
  assert.ok(hit.some((v) => v.code === 'P2'), 'CI 里写死老前缀 → P2 红')

  // 生产者里塞一份「当前前缀常量」→ P2（这次改完，下次改名仍会漏）
  const hit2 = scanProducerLiterals(
    [{ rel: 'scripts/publish-private-apk.mjs', text: `export const FILE_PREFIX = '${PREFIX}';\n` }],
    PREFIX,
  )
  assert.ok(hit2.some((v) => v.code === 'P2'), '代码里再写一份当前前缀 → P2 红')

  // 注释里讲历史不算违规（剥注释后再判，行号仍然对得上）
  const commented = stripComments(`// 历史包叫 ${LEGACY}-1.4.5.apk\nconst a = 1;\n`)
  assert.equal(commented.split('\n').length, 3, '剥注释保留换行（行号不错位）')
  assert.deepEqual(scanProducerLiterals([{ rel: 'scripts/x.mjs', text: `// ${LEGACY}-1.4.5.apk\n` }], PREFIX), [])
})

test('门禁接在流水线上：package.json 有 check:artifact-prefix，CI 里有那一步', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['check:artifact-prefix'], 'node scripts/check-artifact-prefix.mjs')
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  assert.match(ci, /check:artifact-prefix/, 'ci.yml 必须跑这条门禁（否则等于没有）')
  assert.match(ci, /check-artifact-prefix\.mjs --selftest/, 'ci.yml 必须跑负向对照')
})

test('应用身份没被这次改名牵连（label / applicationId / 证书指纹原样）', () => {
  const identity = loadAppIdentity(ROOT)
  assert.equal(identity.applicationId, CONFIG.applicationId)
  assert.equal(identity.expectedCertSha256, CONFIG.expectedCertSha256)
  assert.deepEqual(identity.label, CONFIG.label)
  assert.equal(identity.artifactPrefix, PREFIX)
})
