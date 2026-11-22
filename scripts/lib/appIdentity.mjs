#!/usr/bin/env node
/**
 * appIdentity.mjs —— 应用身份（包名 / 应用名 / 已发布证书指纹 / 更新传输是否允许明文）的读取器 + 门禁规则。
 * Issue #271。
 *
 * 为什么要有这个模块：应用身份的四件事以前分别写死在四个地方（build.gradle 两处、strings.xml
 * 两处、device.mjs 一处、release-common.mjs 一处、capacitor.config.ts 一处），没有任何一处能回答
 * 「这个包的身份证是什么」。其中最危险的一条是包名：`DeviceFingerprintPlugin.java` 用
 * `sha256Hex(androidId + getPackageName())` 做设备指纹，包名一换，全网老设备的指纹同时变值 →
 * 服务端按新指纹判新人 → 额度、邀请关系、卡密绑定全部对不上（#243 / #252 / #264）。
 * 而且这个后果是**静默**的：包照装、App 照跑，只是账号换了人。
 *
 * 所以这里做两件事：
 *   1. 唯一**来源**：`config/appIdentity.json`。本模块只负责读取并校验它，不存第二份值。
 *   2. 唯一**断言**：`PUBLISHED_IDENTITY` 记着「已发布的身份是什么」。配置与它不相等 = 有人在
 *      动身份，门禁 FAIL 并列出必须连带做的事（迁移方案 / 白名单 / 证书迁移另开单）。
 *      断言不是来源 —— 它是那道「改一行就静默换掉用户账号」的闸门，和 `build.gradle` 里的
 *      `EXPECTED_CERT_SHA256` 是同一种写法。
 *
 * 门禁规则（`scripts/check-identity.mjs` / `pnpm check:identity`，单测 `tests/unit/app-identity.test.mjs`）：
 *   - 身份字面量不许出现在允许清单之外（允许：本配置、文档、测试样本、Java 包结构目录、
 *     服务端分发件 `deploy/**`）—— 这一条让「又添了一份副本」变成构建红，而不是线上事故；
 *   - `config/appIdentity.json` 的包名/应用名/证书指纹必须与 `PUBLISHED_IDENTITY` 一致；
 *   - `allowInsecureUpdateTransport === false` 时，更新链路的清单/下载地址里不许有 `http://`；
 *   - `res/values/strings.xml` 不许再声明那四个由 `resValue` 生成的字符串（否则资源重复）。
 *
 * 另有一个字段不是「身份」但住在同一份配置里：`artifactPrefix`（Issue #836 scope ①）—— 安装包
 * **产物文件名**的前缀（`jingluo-chat-<version>.apk`）。它和身份字段放一起的唯一理由是
 * 「客户端装的是谁」这件事只有一处可改：应用名 / 包名 / 证书 / 产物名全部在这份 JSON 里。
 * 它**不**参与 `PUBLISHED_IDENTITY` 断言（改名不影响设备指纹与签名，不属于「换身份」），
 * 由 `scripts/check-artifact-prefix.mjs`（`pnpm check:artifact-prefix`）单独钉住。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 名字的拼法只有一份实现（shared/artifact-name.mjs，发布脚本 / 分发接口 / 校验器共用）：
// 本模块只负责「从唯一来源读出前缀并校验」，不负责拼字符串。
import { isArtifactPrefix, isLegacyArtifactPrefix } from '../../shared/artifact-name.mjs'

/** 仓库根（本文件在 <root>/scripts/lib/ 下） */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 唯一来源：配置文件（相对仓库根） */
export const APP_IDENTITY_REL_PATH = 'config/appIdentity.json'

/**
 * 已发布的身份。**改这里 = 换用户账号身份 / 换签名**，必须与迁移方案同一个 PR。
 * 这份断言是故意写死的：包名不是纯标签，它是设备指纹（= 账号身份）的输入。
 */
export const PUBLISHED_IDENTITY = Object.freeze({
  applicationId: 'com.example.deepseekchat',
  label: '鲸落',
  expectedCertSha256: 'e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1',
})

/** 历史包名（含当前已发布值）。仓库里除允许清单外任何地方出现都算漂移。 */
export const LEGACY_APPLICATION_IDS = Object.freeze(['com.example.deepseekchat'])

/** Java / Android 包名语法（小写段 + 点，至少两段） */
export const RE_JAVA_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
/** 证书指纹：64 位小写十六进制（不接受 apksigner 的 AA:BB:… 写法） */
export const RE_CERT_SHA256 = /^[0-9a-f]{64}$/

/** 配置不合法（缺字段 / 格式不对）：调用方应当直接失败，不许猜默认值 */
export class AppIdentityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AppIdentityError'
  }
}

export const identityPath = (root = REPO_ROOT) => path.join(root, APP_IDENTITY_REL_PATH)

/** 逐字段校验；返回问题清单（空数组 = 合法）。未知顶层字段也算问题，防止拼错后静默失效。 */
export const validateAppIdentity = (value) => {
  const problems = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`顶层必须是 JSON 对象，实际是 ${Array.isArray(value) ? 'array' : typeof value}`]
  }
  const known = new Set([
    'applicationId',
    'namespace',
    'label',
    'artifactPrefix',
    'expectedCertSha256',
    'allowInsecureUpdateTransport',
  ])
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      problems.push(`未知字段 "${key}"（只认 ${[...known].join(' / ')}；拼错会静默失效，所以这里直接拦）`)
    }
  }
  for (const key of ['applicationId', 'namespace']) {
    const raw = value[key]
    if (typeof raw !== 'string' || raw.trim() === '') {
      problems.push(`${key} 必须是非空字符串（Android 包名，例如 com.example.app）`)
    } else if (!RE_JAVA_PACKAGE.test(raw.trim())) {
      problems.push(`${key} 不是合法的 Android 包名：'${raw}'`)
    }
  }
  const label = value.label
  if (label === null || typeof label !== 'object' || Array.isArray(label)) {
    problems.push('label 必须是对象：{ "zh": "应用名", "en": "English name" }')
  } else {
    for (const lang of ['zh', 'en']) {
      const raw = label[lang]
      if (typeof raw !== 'string' || raw.trim() === '') {
        problems.push(`label.${lang} 必须是非空字符串（桌面图标名 / 任务切换器名）`)
      } else if (raw !== raw.trim()) {
        problems.push(`label.${lang} 首尾不许有空白：'${raw}'`)
      }
    }
    for (const key of Object.keys(label)) {
      if (!['zh', 'en'].includes(key)) problems.push(`label 里有未知语言 "${key}"（目前只认 zh / en）`)
    }
  }
  // artifactPrefix（#836）：产物文件名前缀。语法与「不许用历史前缀生成新名字」两条都判，
  // 否则 `deepseek-chat` 会被静默放回来（那就是这次改名被悄悄撤销）。
  const prefix = value.artifactPrefix
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    problems.push('artifactPrefix 必须是非空字符串（安装包产物文件名前缀，例如 jingluo-chat）')
  } else if (prefix !== prefix.trim()) {
    problems.push(`artifactPrefix 首尾不许有空白：'${prefix}'`)
  } else if (!isArtifactPrefix(prefix)) {
    problems.push(
      `artifactPrefix 只能是「小写字母/数字 + 连字符」的短横线格式（例如 jingluo-chat）：'${prefix}'`,
    )
  } else if (isLegacyArtifactPrefix(prefix)) {
    problems.push(
      `artifactPrefix 不能是历史前缀 '${prefix}'（#836 已改名，历史包保持原名不再新增；` +
        '改回去等于撤销这次改名）',
    )
  }
  const cert = value.expectedCertSha256
  if (typeof cert !== 'string' || !RE_CERT_SHA256.test(cert)) {
    problems.push(
      `expectedCertSha256 必须是 64 位小写十六进制字符串（apksigner 的 AA:BB:… 写法不认）：'${cert}'`,
    )
  }
  if (typeof value.allowInsecureUpdateTransport !== 'boolean') {
    problems.push('allowInsecureUpdateTransport 必须是 boolean（true = 允许更新链路走明文 http）')
  }
  return problems
}

/** 读配置并校验；任何不合法都抛 AppIdentityError（调用方不要兜底猜值） */
export const loadAppIdentity = (root = REPO_ROOT) => {
  const file = identityPath(root)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new AppIdentityError(
      `[identity] 读不到 ${APP_IDENTITY_REL_PATH}：${error.message}\n` +
        '       它是包名 / 应用名 / 证书指纹的唯一来源，缺了不能猜（见 config/README.md）',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new AppIdentityError(`[identity] 解析 ${APP_IDENTITY_REL_PATH} 失败：${error.message}`)
  }
  const problems = validateAppIdentity(parsed)
  if (problems.length > 0) {
    throw new AppIdentityError(
      `[identity] ${APP_IDENTITY_REL_PATH} 不合法：\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
  }
  return {
    applicationId: parsed.applicationId.trim(),
    namespace: parsed.namespace.trim(),
    label: { zh: parsed.label.zh, en: parsed.label.en },
    artifactPrefix: parsed.artifactPrefix.trim(),
    expectedCertSha256: parsed.expectedCertSha256,
    allowInsecureUpdateTransport: parsed.allowInsecureUpdateTransport,
  }
}

/**
 * 设备指纹输入串：与 `DeviceFingerprintPlugin.java` 的
 * `sha256Hex(androidId + getContext().getPackageName())` 同构。
 * 包名没变时，这里拼出来的字节必须与改动前逐字节相同（单测钉住这一点）。
 */
export const fingerprintInput = (androidId, identity = loadAppIdentity()) =>
  `${androidId}${identity.applicationId}`

/** 允许出现身份字面量的位置（相对仓库根的 POSIX 路径） */
export const IDENTITY_LITERAL_ALLOWED = Object.freeze([
  // 唯一来源本身
  /^config\/appIdentity\.json$/,
  // 门禁与断言必须写出这个值才能拦得住（同 scripts/check-hardcoded-ip.mjs 跳过自己的写法）
  /^scripts\/lib\/appIdentity\.mjs$/,
  /^scripts\/check-identity\.mjs$/,
  /^tests\/unit\/app-identity\.test\.mjs$/,
  // 文档与历史记录保留原文
  /^docs\//,
  /^CHANGELOG\.md$/,
  // 测试样本（断言里必须写出期望值才能验证）
  /^tests\//,
  // Java 包结构目录 + package 声明：与 namespace 绑定，本单不动（issue 明确允许保留）
  /^android\/app\/src\/(?:main|test)\/java\//,
  // 服务端分发件：与 App 不同部署单元，本单边界不动（marker 默认值另单跟进）
  /^deploy\//,
])

/** 扫描时跳过的目录名 / 前缀（依赖、产物、构建缓存） */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'dist-standard',
  'dist-internal',
  'dist-scroll',
  '.git',
  '.gradle',
  '.workflow-lite',
  'coverage',
  'build',
  'assets',
])

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.xml',
  '.gradle',
  '.properties',
  '.sh',
  '.bash',
  '.java',
  '.kt',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
])

const toPosix = (p) => p.split(path.sep).join('/')

const collectTextFiles = (root, dir, out, depth = 0) => {
  if (depth > 12) return
  let entries
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      // tools/ 下的第三方二进制与解包目录不扫
      collectTextFiles(root, rel, out, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    out.push(rel)
  }
}

/**
 * 全仓找身份字面量。允许清单外的命中 = 又添了一份副本（必须收敛回 config/appIdentity.json）。
 * @returns {{file: string, line: number, needle: string, text: string}[]}
 */
export const scanIdentityLiterals = (root = REPO_ROOT, { needles = null } = {}) => {
  const identity = loadAppIdentity(root)
  const targets = needles ?? [...new Set([identity.applicationId, identity.namespace, ...LEGACY_APPLICATION_IDS])]
  const files = []
  collectTextFiles(root, '', files)
  const hits = []
  for (const rel of files) {
    if (IDENTITY_LITERAL_ALLOWED.some((re) => re.test(rel))) continue
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const matched = targets.filter((needle) => needle && text.includes(needle))
    if (matched.length === 0) continue
    text.split('\n').forEach((line, index) => {
      for (const needle of matched) {
        if (line.includes(needle)) hits.push({ file: toPosix(rel), line: index + 1, needle, text: line.trim() })
      }
    })
  }
  return hits
}

/** 四个由 build.gradle 的 resValue 生成的字符串：strings.xml 里再出现就是资源重复 */
export const GENERATED_RES_STRINGS = Object.freeze([
  'app_name',
  'title_activity_main',
  'package_name',
  'custom_url_scheme',
])

/** strings.xml 里残留这些名字 → 与 resValue 撞车（编译期 duplicate resource） */
export const scanGeneratedResStrings = (root = REPO_ROOT) => {
  const rel = 'android/app/src/main/res/values/strings.xml'
  let text
  try {
    text = fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return []
  }
  const hits = []
  text.split('\n').forEach((line, index) => {
    for (const name of GENERATED_RES_STRINGS) {
      if (new RegExp(`<string\\s+name\\s*=\\s*"${name}"`).test(line)) {
        hits.push({ file: rel, line: index + 1, name, text: line.trim() })
      }
    }
  })
  return hits
}

/**
 * 更新链路里会被真的拿去请求的地址来源（改这里等于改更新端点，见 #268 / #269）。
 *
 * `config/endpoints.json` 是 #269 之后分发地址的**唯一来源**：地址从 .ts / .java 搬进这份 JSON
 * 之后，只扫那两个文件等于扫空 —— 明文闸门会永远是绿的（假绿比没有闸门更危险）。所以配置
 * 文件本身也必须在扫描列表里，取值走下面 JSON 分支（键名白名单见 `DOWNLOAD_TRANSPORT_KEYS`），
 * 报错会直接点出该文件的第几行。
 */
export const UPDATE_TRANSPORT_SOURCES = Object.freeze([
  'config/endpoints.json',
  'src/services/updateManifest.ts',
  'android/app/src/main/java/com/example/deepseekchat/UpdateEndpoint.java',
])

/**
 * `config/endpoints.json` 里属于**更新链路**的键（Issue #269）。
 *
 * 这份配置同时放着聊天 / 邀请 / 反馈地址（那是 #274 的服务端端点，走 https 是另一件事）。
 * 闸门只关心「更新链路里有没有明文」，所以配置源只收这两个键 —— 否则把
 * `allowInsecureUpdateTransport` 置 false 会被聊天地址的 http 卡住，报出来的还是一句看不懂的错。
 */
export const DOWNLOAD_TRANSPORT_KEYS = Object.freeze(['primaryBase', 'fallbackBase'])

const RE_URL_LITERAL = /(['"`])(https?:\/\/[^'"`\s]+)\1/g

/**
 * 收集更新链路的清单 / 下载地址字面量。
 * @returns {{urls: {file: string, line: number, url: string}[], missing: string[]}}
 */
export const collectUpdateTransportUrls = (root = REPO_ROOT, sources = UPDATE_TRANSPORT_SOURCES) => {
  const urls = []
  const missing = []
  for (const rel of sources) {
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      missing.push(rel)
      continue
    }
    // 配置源（JSON）：只收 download.* 那两行，见 DOWNLOAD_TRANSPORT_KEYS 的说明
    if (rel.endsWith('.json')) {
      const re = new RegExp(`"(?:${DOWNLOAD_TRANSPORT_KEYS.join('|')})"\\s*:\\s*"([^"]+)"`)
      text.split('\n').forEach((line, index) => {
        const match = re.exec(line)
        if (match && /^https?:\/\//.test(match[1])) urls.push({ file: rel, line: index + 1, url: match[1] })
      })
      continue
    }
    text.split('\n').forEach((line, index) => {
      RE_URL_LITERAL.lastIndex = 0
      let match
      while ((match = RE_URL_LITERAL.exec(line)) !== null) {
        urls.push({ file: rel, line: index + 1, url: match[2] })
      }
    })
  }
  return { urls, missing }
}

/**
 * 明文传输闸门：`allowInsecureUpdateTransport === false` 时，更新链路里不许有 http:// 地址。
 * 这条把 #268「先用明文 http 跑起来」的决策钉进配置：想收紧就改地址，想继续明文就写 true。
 */
export const updateTransportViolations = (identity, urls) => {
  if (identity.allowInsecureUpdateTransport !== false) return []
  return urls
    .filter((item) => item.url.startsWith('http://'))
    .map((item) => ({
      code: 'insecure-update-transport',
      file: item.file,
      line: item.line,
      message:
        `更新链路用了明文 http（${item.url}），但 ${APP_IDENTITY_REL_PATH} 的 ` +
        'allowInsecureUpdateTransport=false。\n' +
        '      统一签名下这条链路挡不住伪造包（已发布证书是公开的标准 debug key）：\n' +
        '      要么把清单/下载地址换成 https（#269），要么把该开关改回 true 并说明理由。',
    }))
}

/**
 * 已发布身份闸门：配置与 PUBLISHED_IDENTITY 不一致 = 有人在动账号身份。
 * 这里不「拦死」改动，而是要求它显式化 —— 同时改断言（= 声明换身份），并带上迁移方案。
 */
export const publishedIdentityViolations = (identity) => {
  const violations = []
  if (identity.applicationId !== PUBLISHED_IDENTITY.applicationId) {
    violations.push({
      code: 'published-application-id',
      file: APP_IDENTITY_REL_PATH,
      line: null,
      message:
        `applicationId 与已发布包名不一致：配置 ${identity.applicationId} ≠ 已发布 ${PUBLISHED_IDENTITY.applicationId}。\n` +
        '      包名是设备指纹（= 账号身份）的输入之一（DeviceFingerprintPlugin: sha256Hex(androidId + 包名)），\n' +
        '      换它会让全网老设备变成「新用户」：额度、邀请关系、卡密绑定全部对不上（#243 / #252 / #264）。\n' +
        '      真要换：同一个 PR 里改 scripts/lib/appIdentity.mjs 的 PUBLISHED_IDENTITY，并写清迁移方案\n' +
        '      （服务端指纹映射 / 白名单 / 是否保留旧包名）。不许在别的改动里顺手改。',
    })
  }
  if (identity.label.zh !== PUBLISHED_IDENTITY.label) {
    violations.push({
      code: 'published-label',
      file: APP_IDENTITY_REL_PATH,
      line: null,
      message:
        `label.zh 与已发布应用名不一致：配置 ${identity.label.zh} ≠ 已发布 ${PUBLISHED_IDENTITY.label}。\n` +
        '      应用名是用户可见的身份（桌面图标名 / 任务切换器名）。换名可以，但必须是单独一条改动并\n' +
        '      同步 PUBLISHED_IDENTITY，不能夹在别的 PR 里。',
    })
  }
  if (identity.expectedCertSha256 !== PUBLISHED_IDENTITY.expectedCertSha256) {
    violations.push({
      code: 'published-cert',
      file: APP_IDENTITY_REL_PATH,
      line: null,
      message:
        `expectedCertSha256 与已发布证书不一致：配置 ${identity.expectedCertSha256} ≠ 已发布 ${PUBLISHED_IDENTITY.expectedCertSha256}。\n` +
        '      这是签名迁移（已装用户无法覆盖升级），必须另开单并同步 PUBLISHED_IDENTITY。\n' +
        '      见 build.gradle 顶部「禁止顺手切换证书」。',
    })
  }
  return violations
}

/** 消费方必须真的从配置派生：解析它们「实际会用的包名」，与配置逐一比对 */
export const CONSUMER_MODULES = Object.freeze([
  { file: 'scripts/compat/lib/device.mjs', exportName: 'PACKAGE' },
  { file: 'scripts/release-common.mjs', exportName: 'PACKAGE_NAME' },
])

export const resolveConsumerPackages = async (root = REPO_ROOT) => {
  const resolved = []
  for (const consumer of CONSUMER_MODULES) {
    const full = path.join(root, consumer.file)
    if (!fs.existsSync(full)) {
      resolved.push({ ...consumer, value: null, error: '文件不存在' })
      continue
    }
    try {
      const mod = await import(`${pathToFileUrlHref(full)}?t=${Date.now()}`)
      resolved.push({ ...consumer, value: mod[consumer.exportName] ?? null, error: null })
    } catch (error) {
      resolved.push({ ...consumer, value: null, error: error.message })
    }
  }
  return resolved
}

const pathToFileUrlHref = (full) => {
  const normalized = toPosix(full)
  return /^[A-Za-z]:\//.test(normalized) ? `file:///${normalized}` : `file://${normalized}`
}

/**
 * 全量门禁：返回 { violations, info }。violations 空 = 通过。
 * 同步部分（字面量 / 资源 / 明文传输 / 已发布身份）先跑；消费方解析是异步的，由调用方 await。
 */
export const identityViolations = (root = REPO_ROOT) => {
  const identity = loadAppIdentity(root)
  const violations = []

  for (const hit of scanIdentityLiterals(root)) {
    violations.push({
      code: 'identity-literal',
      file: hit.file,
      line: hit.line,
      message:
        `写死了应用身份 "${hit.needle}"。包名/应用名的唯一来源是 ${APP_IDENTITY_REL_PATH}：\n` +
        '      改配置才能改身份；散落的副本改一处漏一处，漏的后果是设备指纹变值（= 账号换人）。\n' +
        `      确实必须写出这个字面量（文档 / 测试样本 / 服务端分发件），把路径加进\n` +
        '      scripts/lib/appIdentity.mjs 的 IDENTITY_LITERAL_ALLOWED 并注明理由。',
    })
  }

  for (const hit of scanGeneratedResStrings(root)) {
    violations.push({
      code: 'duplicate-res-string',
      file: hit.file,
      line: hit.line,
      message:
        `res 里又声明了 "${hit.name}"。它现在由 android/app/build.gradle 的 resValue 从\n` +
        `      ${APP_IDENTITY_REL_PATH} 生成，两边并存会编译失败（duplicate resource）。\n` +
        '      如果这是 `npx cap sync android` 写回来的，把这几行删掉即可（配置是唯一来源）。',
    })
  }

  const { urls, missing } = collectUpdateTransportUrls(root)
  for (const rel of missing) {
    violations.push({
      code: 'missing-transport-source',
      file: rel,
      line: null,
      message:
        '明文传输闸门的扫描源不存在。更新端点搬了家就同步 UPDATE_TRANSPORT_SOURCES，\n' +
        '      否则这条安全门禁会静默变成空跑。',
    })
  }
  violations.push(...updateTransportViolations(identity, urls))
  violations.push(...publishedIdentityViolations(identity))

  return { identity, violations, transports: urls }
}

/** 异步版：额外核对各消费方实际解析出来的包名 */
export const identityGate = async (root = REPO_ROOT) => {
  const result = identityViolations(root)
  for (const consumer of await resolveConsumerPackages(root)) {
    if (consumer.error) {
      result.violations.push({
        code: 'consumer-unresolvable',
        file: consumer.file,
        line: null,
        message: `读不出 ${consumer.exportName}：${consumer.error}（它必须从 ${APP_IDENTITY_REL_PATH} 派生）`,
      })
      continue
    }
    if (consumer.value !== result.identity.applicationId) {
      result.violations.push({
        code: 'consumer-drift',
        file: consumer.file,
        line: null,
        message:
          `${consumer.exportName} = ${JSON.stringify(consumer.value)} ≠ 配置的 applicationId ` +
          `${result.identity.applicationId}。两者不一致时，脚本会去 adb 查一个不存在的包，\n` +
          '      报「App 未安装」而不是报配置漂移。让它从 loadAppIdentity() 派生。',
      })
    }
  }
  return result
}
