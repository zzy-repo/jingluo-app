// [layer: unit | 纯 Node，无浏览器无网络（子进程只跑本地临时目录）| 耗时: <3s]
//
// #609 / 裁决 #614 决定 3：**发布安全门禁**的正反演练（四条硬闸 + webroot 卫生门禁）。
//
// 为什么这些对照必须写在 L0（而不是只写在 ci.yml 里）：
//   1) ci.yml 那一步只在 CI 跑；本地 `pnpm test` 也要能立刻看出「门禁还咬不咬得住」；
//   2) 四条硬闸的判据是「产物字节 / 磁盘实况」，最省事的造法就是临时目录 + 手搓 zip，
//      **完全不需要**一台分发机（#609 的硬要求：不许拿生产机当试验田）；
//   3) 每条闸都是四拍：干净输入 → exit 0；造违规 → exit 1 且点到那条闸；还原 → exit 0。
//      只跑正例的对照等于没有对照（#369 的教训）。
//
// 本文件不连 ssh、不碰 /var/www（发布脚本用 `--transport local --dry-run`，那条路**没有**发布能力）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const {
  gateLoopbackConsume,
  gateManifestSelfConsistency,
  gateOrphanFiles,
  gateTargetVariant,
  targetPaths,
} = await import('../../scripts/publish-private-apk.mjs')
const { findConsumeBases, inspectConsumeBase, isLoopbackBase, judgeConsumeBase } = await import(
  '../../deploy/dl-release/apk-consume.mjs'
)
const {
  fileViolation,
  internalNameViolation,
  makeCleanWebroot,
  scanWebroot,
  selftest: hygieneSelftest,
} = await import('../../scripts/check-webroot-hygiene.mjs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PUBLISH = path.join(ROOT, 'scripts/publish-private-apk.mjs')
const HYGIENE = path.join(ROOT, 'scripts/check-webroot-hygiene.mjs')

/** 临时目录（一次性；本文件结束时整棵删掉） */
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'release-safety-gates-'))
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true })

/**
 * 手搓一个最小 APK（zip store）：`assets/public/static/js/main.js` + AndroidManifest.xml。
 * 真 aapt2 校验在 L0 里跑不动（要真 AndroidManifest），所以演练一律带 `--skip-apk-validation`；
 * 但 G2 读的是 **bundle 里的 consume 键**，这一段在假包里也是真的 —— 这正是它能被负向对照的原因。
 */
function makeApk(file, bundleText) {
  const entries = [
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
    { name: 'assets/public/static/js/main.js', data: Buffer.from(bundleText) },
  ];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(data);
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(body) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(body.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...chunks, cd, eocd]));
}

/**
 * bundle 里 `__ENDPOINTS__` 被 DefinePlugin 内联后的真实形态（生产构建会把键压成不带引号）。
 * 这里**故意**用文档保留域名/bogus host 而不是真地址：`pnpm check:endpoints` 要求
 * 「地址零副本」（唯一来源是 config/endpoints.json），测试里也不许抄一份真 host。
 * 判据只认 `consume:{baseUrl:"…"}` 这个键名形态，host 具体是什么与断言无关。
 */
const BUNDLE = (consumeBase) =>
  `var a=1;__ENDPOINTS__={chatBaseUrl:"https://chat.invalid",consume:{baseUrl:"${consumeBase}",apiV1Prefix:"/api/v1"},pay:{baseUrl:"https://pay.invalid"}};`;

/** 造一套演练现场：私有根（webroot 外）+ 公网 webroot + 两个 APK */
function makeArena() {
  const dir = scratch();
  const priv = path.join(dir, 'dl-private');
  const web = path.join(dir, 'www-dl');
  fs.mkdirSync(path.join(priv, 'apk'), { recursive: true });
  fs.mkdirSync(path.join(web, 'apk'), { recursive: true });
  const okApk = path.join(dir, 'ok.apk');
  const loopApk = path.join(dir, 'loop.apk');
  makeApk(okApk, BUNDLE('https://sub2api.example.com'));
  makeApk(loopApk, BUNDLE('http://127.0.0.1:18000'));
  // 公网 webroot：历史 19 条里挑两条，文件真的存在（G3/G4 在公网侧也能过）
  fs.writeFileSync(
    path.join(web, 'releases.json'),
    `${JSON.stringify({ latest: '1.4.1', releases: [] }, null, 2)}\n`,
    'utf8',
  );
  return { dir, priv, web, okApk, loopApk };
}

/** 跑发布脚本（local 传输 + dry-run：这条路没有发布能力，只判硬闸） */
const publish = (arena, extra = []) =>
  spawnSync(
    process.execPath,
    [
      PUBLISH,
      '--transport',
      'local',
      '--private-root',
      arena.priv,
      '--webroot',
      arena.web,
      '--apk',
      arena.okApk,
      '--version',
      '1.4.3',
      '--versionCode',
      '22',
      '--skip-apk-validation',
      '--dry-run',
      ...extra,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );

/** 写一份私有清单（`entries` 是完整条目对象） */
const writePrivateManifest = (arena, latest, entries) =>
  fs.writeFileSync(
    path.join(arena.priv, 'releases.internal.json'),
    `${JSON.stringify({ latest, releases: entries }, null, 2)}\n`,
    'utf8',
  );

/** 一条合法的 internal 条目（字段齐、file 可指向任意名字） */
const internalEntry = (over = {}) => ({
  version: '1.4.2',
  versionCode: 21,
  releasedAt: '2026-11-20T22:14:58+08:00',
  file: 'apk/deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk',
  size: 6870715,
  md5: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  sha256: 'a967531eaca51fff7eb34aaf5d067863eb13f9ebd43030a2bedd841be5317f52',
  changes: ['私有（internal）构建 1.4.2（versionCode 21）：仅内测渠道分发'],
  buildType: 'stable',
  breaking: false,
  artifactVariant: 'internal',
  artifactVariantSource: 'apk-manifest',
  ...over,
})

// ------------------------------------------------------------------ G1 目标 × 变体

test('G1：公网清单拒 internal（#601 事故形状）、私有清单拒 standard；私有根不许在 webroot 内', () => {
  // 公网清单 + internal → 拒
  assert.match(
    gateTargetVariant({ target: 'public', variant: 'internal', buildType: 'stable', webroot: '/var/www/dl', privateRoot: '/opt/dl-private' }).join('\n'),
    /G1 目标清单只允许 standard 变体/,
  )
  // 公网清单 + standard + prerelease → 拒（决定 2：dl 只留 stable 历史条目）
  assert.match(
    gateTargetVariant({ target: 'public', variant: 'standard', buildType: 'prerelease', webroot: '/var/www/dl', privateRoot: '/opt/dl-private' }).join('\n'),
    /G1 公网清单只允许 stable 渠道/,
  )
  // 私有清单 + standard → 拒（另一半口径）
  assert.match(
    gateTargetVariant({ target: 'private', variant: 'standard', buildType: 'stable', webroot: '/var/www/dl', privateRoot: '/opt/dl-private' }).join('\n'),
    /G1 目标清单只允许 internal 变体/,
  )
  // 私有根被放进 webroot → 拒（否则「清单里没有」也白搭：静态目录照样直出）
  assert.match(
    gateTargetVariant({ target: 'private', variant: 'internal', buildType: 'stable', webroot: '/var/www/dl', privateRoot: '/var/www/dl/private' }).join('\n'),
    /G1 私有根 .* 在 webroot .* 内/,
  )
  // 正例：私有清单 + internal + 私有根在 webroot 外
  assert.deepEqual(
    gateTargetVariant({ target: 'private', variant: 'internal', buildType: 'stable', webroot: '/var/www/dl', privateRoot: '/opt/dl-private' }),
    [],
  )
})

// ------------------------------------------------------------------ G2 回环 baseUrl

test('G2：consume.baseUrl 只认键名证据；回环四种写法都判红；读不出来也算失败', () => {
  assert.deepEqual(findConsumeBases(`x=${BUNDLE('https://sub2api.example.com')}`), ['https://sub2api.example.com'])
  // pay 也是回环时不许误判成 consume（dex 里分不开，所以只认键名）
  assert.deepEqual(
    findConsumeBases('__ENDPOINTS__={consume:{baseUrl:"https://a.example"},pay:{baseUrl:"http://127.0.0.1:9"}}'),
    ['https://a.example'],
  )
  for (const loop of ['http://127.0.0.1:18000', 'http://127.0.0.5:18000', 'http://localhost:18000', 'http://[::1]:18000']) {
    assert.equal(isLoopbackBase(loop), true, `${loop} 是回环，必须判红`);
  }
  assert.equal(isLoopbackBase('https://sub2api.example.com'), false)

  // 读不出来 → ok=false（判不出来就不发，别默认放行）
  assert.equal(judgeConsumeBase(inspectConsumeBase(Buffer.from('not a zip'))).ok, false)
  assert.match(gateLoopbackConsume(judgeConsumeBase(inspectConsumeBase(Buffer.from('not a zip')))).join('\n'), /G2 /)
  // 回环 → 拒
  assert.match(
    gateLoopbackConsume(judgeConsumeBase({ found: ['http://127.0.0.1:18000'], sources: ['assets/public/static/js/main.js'], reason: null })).join('\n'),
    /G2 .*本机回环/,
  )
  // 正例
  assert.deepEqual(
    gateLoopbackConsume(judgeConsumeBase({ found: ['https://sub2api.example.com'], sources: ['x.js'], reason: null })),
    [],
  )
})

// ------------------------------------------------------------------ G3/G4 清单 × 文件

test('G3：清单登记的文件必须在目标 apk/ 下（本次待上传那条豁免）；G4：apk/ 下的本仓产物必须已登记', () => {
  const manifest = { latest: '1.4.2', releases: [internalEntry()] }
  const planned = 'apk/deepseek-chat-1.4.3-internal-ABCDEFGH.apk'

  // G3 正例：文件在
  assert.deepEqual(gateManifestSelfConsistency({ manifest, presentFiles: [internalEntry().file], planned }), [])
  // G3 负例：文件不在（清单指向 404 —— #601 现场的另一半症状）
  assert.match(
    gateManifestSelfConsistency({ manifest, presentFiles: [], planned }).join('\n'),
    /G3 清单登记的 1 个文件不在目标 apk\/ 下/,
  )
  // G3：本次待上传的那条豁免（它现在当然还不在）
  assert.deepEqual(
    gateManifestSelfConsistency({ manifest: { latest: '1.4.3', releases: [internalEntry({ file: planned })] }, presentFiles: [], planned }),
    [],
  )

  // G4 正例：目录里只有已登记的文件
  assert.deepEqual(gateOrphanFiles({ manifest, presentFiles: [internalEntry().file], planned }), [])
  // G4 负例：多出一个没登记的本仓产物
  assert.match(
    gateOrphanFiles({ manifest, presentFiles: [internalEntry().file, 'apk/deepseek-chat-9.9.9-internal-ZZZZZZZZ.apk'], planned }).join('\n'),
    /G4 目标 apk\/ 下有 1 个孤儿文件/,
  )
  // G4：非本仓产物（人家放的 README）不算孤儿 —— 判据只针对 deepseek-chat-*.apk
  assert.deepEqual(gateOrphanFiles({ manifest, presentFiles: ['apk/README.txt'], planned }), [])
})

// ------------------------------------------------------------------ 四条闸的 CLI 负向对照

test('发行脚本 G1 负向对照：internal 包指向公网清单 → exit 1；还原 → exit 0', (t) => {
  const arena = makeArena();
  t.after(() => cleanup(arena.dir));

  const clean = publish(arena);
  assert.equal(clean.status, 0, `干净现场必须 exit 0（否则下面的红不算数）\n${clean.stdout}${clean.stderr}`);
  assert.match(clean.stdout, /四条硬闸全过/);

  const red = publish(arena, ['--target', 'public']);
  assert.equal(red.status, 1, `internal 包指向公网清单必须 exit 1\n${red.stdout}${red.stderr}`);
  assert.match(`${red.stdout}${red.stderr}`, /G1 目标清单只允许 standard 变体/);
  assert.match(`${red.stdout}${red.stderr}`, /私有（internal）包绝不进公网清单/);

  const again = publish(arena);
  assert.equal(again.status, 0, '还原（--target private）后必须 exit 0');
})

test('发行脚本 G2 负向对照：APK 内 consume.baseUrl 是回环 → exit 1；换回非回环 → exit 0', (t) => {
  const arena = makeArena();
  t.after(() => cleanup(arena.dir));

  const red = publish(arena, ['--apk', arena.loopApk]);
  assert.equal(red.status, 1, `回环包必须 exit 1\n${red.stdout}${red.stderr}`);
  assert.match(`${red.stdout}${red.stderr}`, /G2 APK 里的 consume\.baseUrl 是本机回环/);
  assert.match(`${red.stdout}${red.stderr}`, /127\.0\.0\.1:18000/);

  const green = publish(arena);
  assert.equal(green.status, 0, '换成非回环包后必须 exit 0');
})

test('发行脚本 G3 负向对照：清单登记了不存在的文件 → exit 1；补上文件 → exit 0', (t) => {
  const arena = makeArena();
  t.after(() => cleanup(arena.dir));

  writePrivateManifest(arena, '1.4.2', [internalEntry()]); // file 指向 apk/…HJ5NWRHQ.apk，但目录里没有
  const red = publish(arena);
  assert.equal(red.status, 1, `清单指向不存在的文件必须 exit 1\n${red.stdout}${red.stderr}`);
  assert.match(`${red.stdout}${red.stderr}`, /G3 清单登记的 1 个文件不在目标 apk\/ 下/);
  assert.match(`${red.stdout}${red.stderr}`, /deepseek-chat-1\.4\.2-internal-HJ5NWRHQ\.apk/);

  fs.writeFileSync(path.join(arena.priv, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'apk', 'utf8');
  const green = publish(arena);
  assert.equal(green.status, 0, `补上文件后必须 exit 0\n${green.stdout}${green.stderr}`);
})

test('发行脚本 G4 负向对照：apk/ 下有清单未登记的孤儿 → exit 1；移走后 → exit 0', (t) => {
  const arena = makeArena();
  t.after(() => cleanup(arena.dir));

  const orphan = path.join(arena.priv, 'apk', 'deepseek-chat-1.4.2-internal-ORPHAN01.apk');
  fs.writeFileSync(orphan, 'apk', 'utf8');
  const red = publish(arena);
  assert.equal(red.status, 1, `孤儿文件必须 exit 1\n${red.stdout}${red.stderr}`);
  assert.match(`${red.stdout}${red.stderr}`, /G4 目标 apk\/ 下有 1 个孤儿文件/);
  assert.match(`${red.stdout}${red.stderr}`, /ORPHAN01\.apk/);

  fs.rmSync(orphan, { force: true });
  const green = publish(arena);
  assert.equal(green.status, 0, `移走孤儿后必须 exit 0\n${green.stdout}${green.stderr}`);
})

test('发行脚本：local 传输不许真发布（不是另一条发布通道）', (t) => {
  const arena = makeArena();
  t.after(() => cleanup(arena.dir));
  const out = spawnSync(
    process.execPath,
    [
      PUBLISH,
      '--transport', 'local',
      '--private-root', arena.priv,
      '--webroot', arena.web,
      '--apk', arena.okApk,
      '--version', '1.4.3',
      '--versionCode', '22',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(out.status, 2, `local 传输不带 --dry-run 必须 exit 2（不给它发布能力）\n${out.stdout}${out.stderr}`);
  assert.match(`${out.stdout}${out.stderr}`, /--transport local 只允许配 --dry-run/);
})

test('发行脚本：targetPaths 把私有清单指向 webroot 之外 / 公网清单指向 webroot 内', () => {
  const priv = targetPaths({ target: 'private', webroot: '/var/www/dl', privateRoot: '/opt/dl-private' });
  assert.equal(priv.manifestPath, '/opt/dl-private/releases.internal.json');
  assert.equal(priv.apkDir, '/opt/dl-private/apk');
  assert.equal(priv.publiclyReadable, false);
  // #621 收尾：线上清单不在私有根下（DL_PRIVATE_RELEASES_JSON），清单路径必须能单独指
  const live = targetPaths({
    target: 'private',
    webroot: '/var/www/dl',
    privateRoot: '/opt/dl-private',
    privateManifest: '/var/www/dl-private/releases.internal.json',
  });
  assert.equal(live.manifestPath, '/var/www/dl-private/releases.internal.json');
  assert.equal(live.apkDir, '/opt/dl-private/apk', 'apk 目录仍跟着私有根');
  const pub = targetPaths({ target: 'public', webroot: '/var/www/dl', privateRoot: '/opt/dl-private' });
  assert.equal(pub.manifestPath, '/var/www/dl/releases.json');
  assert.equal(pub.publiclyReadable, true);
})

// ------------------------------------------------------------------ webroot 卫生门禁

test('卫生门禁：五类脏东西各命中对应规则，干净 webroot 不误杀', (t) => {
  const dir = scratch();
  t.after(() => cleanup(dir));
  makeCleanWebroot(dir);
  assert.deepEqual(scanWebroot(dir).violations, [], '干净 webroot 不许被误杀');

  // R1：备份 / 取证 / 撤回 / 清单副本 / 发布半成品
  for (const name of ['releases.json.bak-private-1', 'releases.json.LEAKED-1795185887', '_withdrawn-1.4.2', 'releases.json.old', 'x.apk.tmp-1']) {
    assert.ok(fileViolation(name), `${name} 必须命中 R1`);
  }
  assert.equal(fileViolation('releases.json'), null, '正本不许误杀');
  assert.equal(fileViolation('deepseek-chat-1.4.1.apk'), null);
  // R3：内部包的名字
  assert.ok(internalNameViolation('deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'));
  assert.ok(internalNameViolation('deepseek-chat-1.4.2-dev.apk'));
  assert.equal(internalNameViolation('deepseek-chat-1.4.1.apk'), null);

  // 逐个注入 → 扫描必须命中对应规则（R2 用目录、R3 用 internal 包、R1 用 LEAKED 文件）
  fs.writeFileSync(path.join(dir, 'releases.json.LEAKED-1795185887'), '{}', 'utf8');
  assert.ok(scanWebroot(dir).violations.some((v) => v.rule === 'R1' && v.at.includes('LEAKED')));
  fs.rmSync(path.join(dir, 'releases.json.LEAKED-1795185887'), { force: true });

  fs.mkdirSync(path.join(dir, 'private'));
  assert.ok(scanWebroot(dir).violations.some((v) => v.rule === 'R2' && v.at === 'private'));
  fs.rmSync(path.join(dir, 'private'), { recursive: true, force: true });

  fs.writeFileSync(path.join(dir, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'x', 'utf8');
  assert.ok(scanWebroot(dir).violations.some((v) => v.rule === 'R3'));
  fs.rmSync(path.join(dir, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), { force: true });

  // R4（#620）：公网清单里的 internal 条目数必须为 0 —— 注入一条就必须红，且点到那条记录
  const cleanJson = fs.readFileSync(path.join(dir, 'releases.json'), 'utf8');
  const internalManifest = JSON.parse(cleanJson);
  assert.equal(internalManifest.releases.filter((r) => r.artifactVariant !== 'standard').length, 0);
  internalManifest.releases[0].artifactVariant = 'internal';
  fs.writeFileSync(path.join(dir, 'releases.json'), `${JSON.stringify(internalManifest, null, 2)}\n`, 'utf8');
  const r4 = scanWebroot(dir).violations.filter((v) => v.rule === 'R4');
  assert.equal(r4.length, 1, `清单里的 internal 条目必须命中 R4，实际 ${JSON.stringify(scanWebroot(dir).violations)}`);
  assert.match(r4[0].at, /releases\.json:releases\[0\]\(1\.4\.1\)/, '要点到是哪一条记录');
  assert.match(r4[0].why, /internal/);

  // R4 fail-closed：清单读不出来时不许当作「没有 internal 条目」
  fs.writeFileSync(path.join(dir, 'releases.json'), '{"latest": "1.4.1", "releases": [', 'utf8');
  assert.ok(
    scanWebroot(dir).violations.some((v) => v.rule === 'R4'),
    '清单解析失败也必须命中 R4（证明不了 internal=0 就不许判绿）',
  );
  // 清单整个不见了也一样
  fs.rmSync(path.join(dir, 'releases.json'), { force: true });
  assert.ok(scanWebroot(dir).violations.some((v) => v.rule === 'R4'), '清单缺失必须命中 R4');

  fs.writeFileSync(path.join(dir, 'releases.json'), cleanJson, 'utf8');
  assert.deepEqual(scanWebroot(dir).violations, [], '还原后必须干净');
})

test('卫生门禁：内置演练（--selftest 的那条路）每一类脏东西都咬得住', () => {
  const st = hygieneSelftest();
  assert.deepEqual(st.failures, [], `内置演练必须全过：\n${st.failures.join('\n')}`);
  assert.ok(st.rows.length >= 10, `演练至少覆盖 10 类脏东西（R1×5 / R2 / R3×2 / R4×2），实际 ${st.rows.length}`);
  assert.ok(st.rows.some((row) => row.rule === 'R4'), '演练必须覆盖 R4（公网清单里的 internal 条目，#620）');
})

test('卫生门禁 CLI：干净 exit 0 / 脏 exit 1 且点到文件；--selftest exit 0', (t) => {
  const dir = scratch();
  t.after(() => cleanup(dir));
  makeCleanWebroot(dir);
  const runHygiene = (root) => spawnSync(process.execPath, [HYGIENE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DL_WEBROOT: root } });

  const clean = runHygiene(dir);
  assert.equal(clean.status, 0, `干净 webroot 必须 exit 0\n${clean.stdout}${clean.stderr}`);
  assert.match(clean.stdout, /干净/);

  fs.writeFileSync(path.join(dir, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'x', 'utf8');
  const dirty = runHygiene(dir);
  assert.equal(dirty.status, 1, `apk/ 下的 internal 包必须 exit 1\n${dirty.stdout}${dirty.stderr}`);
  assert.match(dirty.stdout, /\[R3/);
  assert.match(dirty.stdout, /deepseek-chat-1\.4\.2-internal-HJ5NWRHQ\.apk/);
  fs.rmSync(path.join(dir, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), { force: true });

  assert.equal(runHygiene(dir).status, 0, '还原后必须 exit 0');

  // R4：公网清单里塞一条 internal → CLI 必须 exit 1 且点到记录（#620 常驻断言）
  const cleanJson = fs.readFileSync(path.join(dir, 'releases.json'), 'utf8');
  const internalManifest = JSON.parse(cleanJson);
  internalManifest.releases[0].artifactVariant = 'internal';
  fs.writeFileSync(path.join(dir, 'releases.json'), `${JSON.stringify(internalManifest, null, 2)}\n`, 'utf8');
  const r4Run = runHygiene(dir);
  assert.equal(r4Run.status, 1, `清单里的 internal 条目必须 exit 1\n${r4Run.stdout}${r4Run.stderr}`);
  assert.match(r4Run.stdout, /\[R4/);
  assert.match(r4Run.stdout, /releases\[0\]\(1\.4\.1\)/);
  fs.writeFileSync(path.join(dir, 'releases.json'), cleanJson, 'utf8');
  assert.equal(runHygiene(dir).status, 0, '还原后必须 exit 0（R4 不是恒红）');

  const self = spawnSync(process.execPath, [HYGIENE, '--selftest'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(self.status, 0, `--selftest 必须 exit 0\n${self.stdout}${self.stderr}`);
  assert.match(self.stdout, /演练通过/);
})
