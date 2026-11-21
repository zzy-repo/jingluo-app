// [layer: L1（零 Android SDK：只读文件 + 正则，毫秒级） | 耗时: ~0.3s]
//
// 闸 1b —— **明文（http）非回环 consume 的显式放行通道 + 产物自证标记**（Issue #601 守卫的补正面）。
//
// 为什么这道闸必须存在（而不是「把 https 判据放宽」）：#651 的发版铁律要求 staging 联调包指向
// `http://140.210.13.146:16000`（16000 是 staging，明文 HTTP 是已知且接受的代价，包按 prerelease 发）。
// 而 #601 的守卫判据是「https，唯一例外是本机回环」—— 它**正确**拦下这种包。麻烦不在「拦错了」，
// 而在「没有第二条路」：唯一的放宽手段是去拆那条判据，而拆守卫正是 #601 事故的形状。
//
// 所以这里钉住的是三道**接缝**，少一条这条通道就不可审计：
//   1. 开关存在且**只认字面 true**（`yes` / `1` / `false` 一律报错）—— 逃生舱不能靠拼写猜；
//   2. 标记 `INSECURE_CONSUME` 真的写进产物（AndroidManifest meta-data + BuildConfig），
//      且**只在「确实有明文非回环 base」且「确实传了 flag」时**写 true（传了 flag 但地址是生产 https → 不写，
//      否则每个正常发布包都会被打成「明文联调包」，标记就没意义了）；
//   3. 标记与 `LOOPBACK_CONSUME` **并列、语义不合并**：回环仍归 `-PallowLoopbackConsume`，两个 flag 互不替代。
//
// 本文件**不**验「gradle 真的会中止/放行」——那是构建期行为，由 PR 描述里的六行负向对照（真跑
// `./gradlew help` + 真 `assembleRelease`）与本文件的正则共同担保。理由是纯 gradle 求值要 JDK +
// capacitor 生成物，进了单测就是「在 CI 上时红时绿」的门禁，比没有更糟。
//
// 运行：node --test deploy/dl-release/test/insecure-consume-marker.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_INSECURE_MARKER, DEFAULT_LOOPBACK_MARKER } from '../variant.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const GRADLE = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8')
const MANIFEST = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
const VERIFY = fs.readFileSync(path.join(ROOT, 'scripts/verify-release-apk.mjs'), 'utf8')

/**
 * 取一段 gradle 源码（按起止锚点裁），用于「这段里有 X」这种断言。
 * 为什么不整文件 `assert.match`：整个 build.gradle 里 `allowLoopbackConsume` 出现十几次，
 * 全文匹配证明不了「闸 1 的判据没把 insecure 的 flag 混进来」这类**局部**性质。
 */
const slice = (startAnchor, endAnchor) => {
  const from = GRADLE.indexOf(startAnchor)
  assert.ok(from >= 0, `build.gradle 里找不到锚点：${startAnchor}`)
  const to = GRADLE.indexOf(endAnchor, from + startAnchor.length)
  assert.ok(to > from, `build.gradle 里找不到结束锚点：${endAnchor}（起点 ${startAnchor}）`)
  return GRADLE.slice(from, to)
}

test('标记名与 variant.mjs 同源，且与 LOOPBACK_CONSUME 是两条并列的标记（不合并语义）', () => {
  assert.equal(DEFAULT_INSECURE_MARKER, 'com.example.deepseekchat.INSECURE_CONSUME')
  assert.equal(DEFAULT_LOOPBACK_MARKER, 'com.example.deepseekchat.LOOPBACK_CONSUME')
  assert.notEqual(DEFAULT_INSECURE_MARKER, DEFAULT_LOOPBACK_MARKER, '两个标记必须各自独立：回环 ≠ 明文')
})

test('AndroidManifest 有 INSECURE_CONSUME 的 meta-data，占位符由 gradle 的 insecureConsume 填充', () => {
  assert.match(
    MANIFEST,
    /<meta-data android:name="\$\{applicationId\}\.INSECURE_CONSUME" android:value="\$\{insecureConsume\}" \/>/,
    'AndroidManifest 必须有 INSECURE_CONSUME 的 meta-data（verify:apk 第 5 项的唯一读取点）',
  )
  // 与 LOOPBACK_CONSUME 并列：两条都在同一个 <application> 里，命名风格一致
  assert.match(MANIFEST, /\$\{applicationId\}\.LOOPBACK_CONSUME/, 'LOOPBACK_CONSUME 那条不许被顺手删掉（#601 闸 2 的读取点）')
})

test('gradle：flag 只认字面 true（yes / 1 / false 都报错，且报错文案点名 INSECURE_CONSUME 标记）', () => {
  assert.match(GRADLE, /def ALLOW_INSECURE_PROP = 'allowInsecureConsume'/, '逃生舱参数名必须是 -PallowInsecureConsume')
  const block = slice("def ALLOW_INSECURE_PROP = 'allowInsecureConsume'", 'def allowInsecureConsume =')
  assert.match(block, /raw != 'true'/, '判定必须严格等于字面 true —— 不许 toLowerCase / 不许布尔解析')
  assert.doesNotMatch(block, /toLowerCase\(\)/, '明文逃生舱不做大小写归一：-PallowInsecureConsume=TRUE 是要人改的那一类')
  assert.match(block, /GradleException/, '非 true 取值必须 fail-fast')
  assert.match(block, /INSECURE_CONSUME/, '报错文案要说清这个开关影响什么（产物标记）')
  // 两个入口都要认（-P 与 env），否则会出现「web 侧放了、原生侧没放」的半套包
  assert.match(block, /ALLOW_INSECURE_CONSUME/, 'gradle 也要认 web 侧那个环境变量（同一语义，避免半套包）')
})

test('gradle：标记只在「有明文非回环 base」且「传了 flag」时才是 true', () => {
  assert.match(
    GRADLE,
    /def insecureConsumeMarker = \(insecureBases\.isEmpty\(\) \|\| !allowInsecureConsume\) \? 'false' : 'true'/,
    '标记表达式必须与 LOOPBACK_CONSUME 同形状：命中集合为空 或 没放行 → false（不误标生产 https 包）',
  )
  // 三个 base 都要被看到：consume / pay 由 readConsumeBase 记录，migration 在这里补
  assert.match(GRADLE, /insecureBases\["\$\{section\}\.baseUrl"\] = value\.toString\(\)/, 'consume / pay 的明文命中要记录')
  assert.match(GRADLE, /insecureBases\['migration\.baseUrl'\] = migrationBaseForGate/, 'migration 不走 readConsumeBase，必须单独补上同一判据')
  // 产物自证：BuildConfig + manifestPlaceholders 同一处、同一风格
  assert.match(GRADLE, /buildConfigField "boolean", "INSECURE_CONSUME", "\$\{insecureConsumeMarker\}"/)
  assert.match(GRADLE, /insecureConsume\s*:\s*insecureConsumeMarker/, 'manifestPlaceholders 必须带上 insecureConsume')
  assert.match(GRADLE, /loopbackConsume\s*:\s*loopbackConsumeMarker/, 'LOOPBACK 的占位符不许被替换掉（两者并列）')
})

test('gradle：闸 1b 的中止条件只看自己的 flag —— 与闸 1 互不替代', () => {
  const insecureGate = slice('if (!insecureBases.isEmpty() && !allowInsecureConsume)', 'if (insecureConsumeMarker')
  assert.match(insecureGate, /明文/, '这是明文那道闸')
  assert.match(insecureGate, /-P\$\{ALLOW_INSECURE_PROP\}=true/, '文案必须给出确切解法（flag 名）')
  assert.doesNotMatch(insecureGate, /allowLoopbackConsume/, '明文 flag 不能替代回环 flag')

  const loopbackGate = slice('if (!loopbackBases.isEmpty() && !allowLoopbackConsume)', 'if (loopbackConsumeMarker')
  assert.doesNotMatch(loopbackGate, /allowInsecureConsume/, '回环 flag 也不能被明文 flag 替代：两个 flag 各管各的')

  // 守卫本体没被删：https 判据仍在 readConsumeBase 里（放不放行由闸 1b 决定，判据本身不许消失）
  assert.match(GRADLE, /if \(!value\.startsWith\('https:\/\/'\) && !isLoopback\)/, 'readConsumeBase 的「https 或本机回环」判据必须还在')
})

test('verify:apk：第 5 项读 INSECURE_CONSUME，且 --allow-insecure 是唯一的放行开关', () => {
  assert.match(VERIFY, /DEFAULT_INSECURE_MARKER/, '读取点必须用 variant.mjs 的常量，不许另写一份字面量')
  assert.match(VERIFY, /\{ id: 'insecure', title: '5 INSECURE_CONSUME 不存在或 false' \}/, '第 5 项要有固定 id/序号（表格与 --json 靠它对齐）')
  assert.match(VERIFY, /'--allow-insecure'/, 'CLI 必须接受 --allow-insecure')
  assert.match(VERIFY, /这是明文联调包，禁止公开分发/, '不带 --allow-insecure 时的报错要点名「禁止公开分发」')
  assert.match(VERIFY, /INSECURE\(staging-only\)/, '带 --allow-insecure 时结论行必须强制标 INSECURE(staging-only)')
  assert.match(VERIFY, /insecure: false,/, '结果形状里要有 insecure 字段（--json 消费方读它）')
})
