// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s] 说明见 tests/README.md
// 应用标识与签名身份（Issue #271）：单一来源 + 门禁。
//
//   cd /d/all_project/runs/cfg271 && env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
//     node tests/unit/app-identity.test.mjs
//
// 覆盖（对应 #271 的验收清单）：
//   [1] 配置是唯一来源且**值没变**：applicationId / label.zh / 证书指纹与已发布值逐字节相同
//   [2] 指纹输入串不变：sha256(androidId + 包名) 与改动前同构（DeviceFingerprintPlugin 的输入）
//   [3] 声明点都改成派生：build.gradle / AndroidManifest / strings.xml / capacitor.config.ts 里
//       不再有包名字面量，应用名由 resValue 从配置生成
//   [4] 门禁不是空跑（负向）：配置改包名 → 已发布身份规则 FAIL 且同时点名两处；
//       配置没动但留了一个写死的副本 → 字面量规则 FAIL 并给出行号；副本改成派生 → 转 PASS
//   [5] 明文传输闸门（负向）：allowInsecureUpdateTransport=false 而更新清单地址是 http:// → FAIL
//   [6] 真实仓库当前状态：identityGate() 零违规（这条在 CI 里跑 = 门禁真的接在流水线上）
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  APP_IDENTITY_REL_PATH,
  GENERATED_RES_STRINGS,
  PUBLISHED_IDENTITY,
  REPO_ROOT,
  fingerprintInput,
  identityGate,
  identityViolations,
  loadAppIdentity,
  scanGeneratedResStrings,
  scanIdentityLiterals,
  updateTransportViolations,
  validateAppIdentity,
} from '../../scripts/lib/appIdentity.mjs'

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) ok(label)
  else bad(`${label}\n      实际: ${a}\n      期望: ${e}`)
}
const truthy = (value, label) => (value ? ok(label) : bad(label))

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')

// 改动前的指纹输入（写死的历史值：改它等于改全网老设备的账号身份）
const ANDROID_ID = 'a1b2c3d4e5f60718'
const PUBLISHED_PACKAGE = 'com.example.deepseekchat'
const BEFORE_FP = createHash('sha256').update(ANDROID_ID + PUBLISHED_PACKAGE).digest('hex')

console.log('\n[1] 配置是唯一来源，且值与已发布身份一致')
const identity = loadAppIdentity()
eq(identity.applicationId, PUBLISHED_PACKAGE, 'applicationId 仍是已发布包名（改它 = 换用户账号）')
eq(identity.namespace, PUBLISHED_PACKAGE, 'namespace 仍是已发布包名（Java 包结构目录绑定它）')
eq(identity.label.zh, '鲸落', '应用名仍是「鲸落」')
eq(
  identity.expectedCertSha256,
  'e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1',
  '证书指纹仍是已发布证书（签名迁移必须另开单）',
)
eq(identity.expectedCertSha256, PUBLISHED_IDENTITY.expectedCertSha256, '配置与 PUBLISHED_IDENTITY 的证书一致')
eq(identity.allowInsecureUpdateTransport, true, '明文更新传输 = true（#268 现状：新分发机只有 http）')

console.log('\n[2] 设备指纹输入串与改动前逐字节相同')
eq(fingerprintInput(ANDROID_ID), ANDROID_ID + PUBLISHED_PACKAGE, '输入串 == androidId + 已发布包名')
const afterFp = createHash('sha256').update(fingerprintInput(ANDROID_ID)).digest('hex')
eq(afterFp, BEFORE_FP, `指纹值不变（${BEFORE_FP}）`)
const pluginSource = read('android/app/src/main/java/com/example/deepseekchat/DeviceFingerprintPlugin.java')
truthy(
  pluginSource.includes('sha256Hex(androidId + getContext().getPackageName())'),
  'DeviceFingerprintPlugin 仍按 sha256(androidId + getPackageName()) 计算（本单没动它的逻辑）',
)

console.log('\n[3] 声明点都改成从配置派生')
const gradle = read('android/app/build.gradle')
truthy(gradle.includes("rootProject.file('../config/appIdentity.json')"), 'build.gradle 读 config/appIdentity.json')
truthy(gradle.includes('namespace = identityNamespace'), 'namespace 由配置派生')
truthy(gradle.includes('applicationId identityApplicationId'), 'applicationId 由配置派生')
truthy(gradle.includes('def EXPECTED_CERT_SHA256 = expectedCertSha256Raw'), '证书指纹由配置派生')
for (const name of GENERATED_RES_STRINGS) {
  truthy(
    gradle.includes(`resValue "string", "${name}"`),
    `build.gradle 用 resValue 生成 ${name}`,
  )
}
eq(scanGeneratedResStrings(), [], 'res/values/strings.xml 里没有与 resValue 撞车的残留')
const manifest = read('android/app/src/main/AndroidManifest.xml')
truthy(
  manifest.includes('android:name="${applicationId}.ARTIFACT_VARIANT"'),
  '变体标记名跟着 ${applicationId} 走',
)
eq(scanIdentityLiterals(), [], '全仓没有允许清单之外的身份字面量（含 build.gradle / manifest / capacitor.config.ts / 脚本）')

console.log('\n[4] 门禁不是空跑：配置漂移 / 字面量副本都会 FAIL')

/** 沙箱里的分发配置：https，作为「明文闸门」以外的断言的安静基线 */
const ENDPOINTS_FIXTURE = {
  download: { primaryBase: 'https://dl-primary.test.invalid', fallbackBase: 'https://dl-fallback.test.invalid' },
}

/** 造一棵最小仓库树：真 appIdentity.mjs + 一份可改的配置 + 若干声明点 */
const makeTree = ({ configPatch = {}, files = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg271-'))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts', 'compat', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'services'), { recursive: true })
  fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'example', 'deepseekchat'), {
    recursive: true,
  })
  const config = { ...JSON.parse(read(APP_IDENTITY_REL_PATH)), ...configPatch }
  fs.writeFileSync(path.join(root, APP_IDENTITY_REL_PATH), JSON.stringify(config, null, 2))
  // 更新链路的第三个扫描源（#269）：config/endpoints.json 的 download.* 也是真会被请求的地址。
  // 沙箱里必须有这份文件，否则每条用例都会先撞上 missing-transport-source（扫描源不存在）。
  // 默认给 https 版本，专测明文闸门的用例会自己覆盖它。
  fs.writeFileSync(path.join(root, 'config/endpoints.json'), JSON.stringify(ENDPOINTS_FIXTURE, null, 2))
  fs.cpSync(path.join(REPO_ROOT, 'scripts/lib/appIdentity.mjs'), path.join(root, 'scripts/lib/appIdentity.mjs'))
  // 更新链路扫描源：默认为 https，避免它干扰其它断言
  fs.writeFileSync(
    path.join(root, 'src/services/updateManifest.ts'),
    "export const PRIMARY_RELEASE_BASE = 'https://dl.rose7.cn'\n",
  )
  fs.writeFileSync(
    path.join(root, 'android/app/src/main/java/com/example/deepseekchat/UpdateEndpoint.java'),
    'final class UpdateEndpoint { static final String PRIMARY_BASE = "https://dl.rose7.cn"; }\n',
  )
  // 消费方默认从配置派生
  fs.writeFileSync(
    path.join(root, 'scripts/compat/lib/device.mjs'),
    "import { loadAppIdentity } from '../../lib/appIdentity.mjs'\nexport const PACKAGE = loadAppIdentity().applicationId\n",
  )
  fs.writeFileSync(
    path.join(root, 'scripts/release-common.mjs'),
    "import { loadAppIdentity } from './lib/appIdentity.mjs';\nexport const PACKAGE_NAME = loadAppIdentity().applicationId;\n",
  )
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

const codesOf = (violations) => violations.map((v) => v.code)

// 4a：配置改包名（不同步任何东西）→ 已发布身份规则 FAIL，并同时点名两处
{
  const root = makeTree({ configPatch: { applicationId: 'com.whalefall.chat', namespace: 'com.whalefall.chat' } })
  const gate = await identityGate(root)
  const hit = gate.violations.find((v) => v.code === 'published-application-id')
  truthy(Boolean(hit), '改 config 的 applicationId → published-application-id FAIL')
  truthy(
    Boolean(hit) && hit.message.includes('com.whalefall.chat') && hit.message.includes(PUBLISHED_PACKAGE),
    '失败信息同时点名「配置新值」与「已发布值」',
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// 4b：配置没动，但 device.mjs 里留了一个写死的包名副本 → 字面量规则 FAIL 并给出行号
{
  const stale = "export const PACKAGE = 'com.example.deepseekchat'\n"
  const root = makeTree({ files: { 'scripts/compat/lib/device.mjs': stale } })
  const gate = await identityGate(root)
  const literal = gate.violations.find((v) => v.code === 'identity-literal')
  truthy(Boolean(literal), 'device.mjs 写死包名 → identity-literal FAIL')
  eq(Boolean(literal) && literal.file, 'scripts/compat/lib/device.mjs', '失败信息点名 device.mjs')
  eq(Boolean(literal) && literal.line, 1, '失败信息带行号')
  fs.rmSync(root, { recursive: true, force: true })
}

// 4b2：issue 里的原场景 —— 配置改成新包名、不同步 device.mjs 的副本 → FAIL 并指名两处
{
  const stale = "export const PACKAGE = 'com.example.deepseekchat'\n"
  const root = makeTree({
    configPatch: { applicationId: 'com.whalefall.chat', namespace: 'com.whalefall.chat' },
    files: { 'scripts/compat/lib/device.mjs': stale },
  })
  const gate = await identityGate(root)
  const codes = codesOf(gate.violations)
  truthy(codes.includes('identity-literal'), '配置改名 + 副本没同步 → identity-literal FAIL')
  truthy(codes.includes('consumer-drift'), '配置改名 + 副本没同步 → consumer-drift FAIL')
  truthy(codes.includes('published-application-id'), '配置改名 → 已发布身份规则也 FAIL（换账号身份必须显式化）')
  const drift = gate.violations.find((v) => v.code === 'consumer-drift')
  truthy(
    Boolean(drift) && drift.message.includes('com.example.deepseekchat') && drift.message.includes('com.whalefall.chat'),
    '失败信息同时点名「副本里的旧值」与「配置里的新值」',
  )

  // 把副本改回「从配置派生」：漂移消失，只剩「换身份必须显式声明」那一条
  fs.writeFileSync(
    path.join(root, 'scripts/compat/lib/device.mjs'),
    "import { loadAppIdentity } from '../../lib/appIdentity.mjs'\nexport const PACKAGE = loadAppIdentity().applicationId\n",
  )
  const fixed = await identityGate(root)
  eq(
    codesOf(fixed.violations),
    ['published-application-id'],
    '副本改回派生 → 字面量/漂移规则转 PASS（剩下的只有「换包名要显式改 PUBLISHED_IDENTITY」）',
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// 4c：把副本改回派生 → 转 PASS（只剩与身份无关的噪声 = 无）
{
  const root = makeTree()
  const gate = await identityGate(root)
  eq(codesOf(gate.violations), [], '副本改回派生 → 门禁 PASS')
  fs.rmSync(root, { recursive: true, force: true })
}

// 4d：允许清单要留口子（文档 / Java 包结构可以写出包名），否则这条门禁会逼人删文档
{
  const root = makeTree({
    files: {
      'docs/compat/README.md': `本仓库 debug 包名是 ${PUBLISHED_PACKAGE}\n`,
      'android/app/src/main/java/com/example/deepseekchat/MainActivity.java': `package ${PUBLISHED_PACKAGE};\n`,
    },
  })
  eq(codesOf(identityViolations(root).violations), [], '文档与 Java 包结构目录里的包名不算违规')
  fs.rmSync(root, { recursive: true, force: true })
}

console.log('\n[5] 明文更新传输闸门（#268 决策的落点）')
{
  const plain = [{ file: 'src/services/updateManifest.ts', line: 9, url: 'http://62.106.70.167:8888' }]
  const secure = [{ file: 'src/services/updateManifest.ts', line: 9, url: 'https://dl.rose7.cn' }]
  eq(updateTransportViolations({ allowInsecureUpdateTransport: true }, plain), [], 'true + http → 放行（现状）')
  eq(updateTransportViolations({ allowInsecureUpdateTransport: false }, secure), [], 'false + https → 放行')
  const blocked = updateTransportViolations({ allowInsecureUpdateTransport: false }, plain)
  eq(blocked.length, 1, 'false + http → FAIL')
  truthy(blocked[0]?.message.includes('http://62.106.70.167:8888'), '失败信息点名具体地址')

  // 端到端：真的扫文件，而不是只喂数组
  const root = makeTree({
    configPatch: { allowInsecureUpdateTransport: false },
    files: {
      'src/services/updateManifest.ts': "export const PRIMARY_RELEASE_BASE = 'http://62.106.70.167:8888'\n",
    },
  })
  const gate = await identityGate(root)
  const insecure = gate.violations.find((v) => v.code === 'insecure-update-transport')
  truthy(Boolean(insecure), '扫到 http:// 清单地址 → insecure-update-transport FAIL')
  eq(Boolean(insecure) && insecure.line, 1, '带行号（能直接定位到那行地址）')
  fs.rmSync(root, { recursive: true, force: true })

  // #269：地址搬进 config/endpoints.json 之后，这份配置本身也必须在扫描源里 ——
  // 只扫 .ts / .java 会扫到空文件，闸门永远是绿的（假绿）。
  const root2 = makeTree({ configPatch: { allowInsecureUpdateTransport: false } })
  fs.writeFileSync(
    path.join(root2, 'config/endpoints.json'),
    JSON.stringify(
      { download: { primaryBase: 'http://dl-primary.test.invalid', fallbackBase: 'https://dl-fallback.test.invalid' } },
      null,
      2,
    ),
  )
  const gate2 = await identityGate(root2)
  const plainConfig = gate2.violations.find(
    (v) => v.code === 'insecure-update-transport' && v.file === 'config/endpoints.json',
  )
  truthy(Boolean(plainConfig), '配置里的明文分发地址 → 立刻 FAIL（闸门不会因为地址搬家而空转）')
  fs.rmSync(root2, { recursive: true, force: true })
}

console.log('\n[6] 配置校验：缺字段 / 格式错不许静默兜底')
{
  const valid = JSON.parse(read(APP_IDENTITY_REL_PATH))
  eq(validateAppIdentity(valid), [], '当前配置合法')
  truthy(validateAppIdentity({ ...valid, applicationId: '' }).length > 0, '空包名 → 报错')
  truthy(validateAppIdentity({ ...valid, applicationId: 'com' }).length > 0, '包名段数不够 → 报错')
  truthy(
    validateAppIdentity({ ...valid, expectedCertSha256: 'AA:BB:CC' }).length > 0,
    '证书指纹不是 64 位小写十六进制 → 报错',
  )
  truthy(
    validateAppIdentity({ ...valid, allowInsecureUpdateTransport: 'false' }).length > 0,
    '传输开关写成字符串 → 报错（不许当作 false 生效）',
  )
  const { allowInsecureUpdateTransport, ...missing } = valid
  truthy(validateAppIdentity(missing).length > 0, '缺 allowInsecureUpdateTransport → 报错')
  truthy(validateAppIdentity({ ...valid, label: { zh: ' 鲸落 ' } }).length > 0, '应用名带空白 / 缺 en → 报错')
  truthy(validateAppIdentity({ ...valid, applicationID: valid.applicationId }).length > 0, '拼错字段名 → 报错（否则静默失效）')
}

console.log('\n[7] 真实仓库当前状态（CI 里这条 = 门禁接在流水线上）')
{
  const gate = await identityGate()
  eq(codesOf(gate.violations), [], 'pnpm check:identity 的同一套规则：当前零违规')
  const pkg = JSON.parse(read('package.json'))
  eq(pkg.scripts['check:identity'], 'node scripts/check-identity.mjs', 'package.json 里有 check:identity')
  truthy(
    fs.existsSync(path.join(REPO_ROOT, 'capacitor.config.ts')),
    'capacitor.config.ts 存在（appId/appName 也从同一份配置派生）',
  )
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（共 ${checks.n} 项检查）`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ 全部通过（${checks.n} 项检查）`)
