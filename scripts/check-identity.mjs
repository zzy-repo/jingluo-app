#!/usr/bin/env node
/**
 * check-identity.mjs —— 应用身份门禁（Issue #271）。
 *
 * 应用身份的四件事（包名 / 应用名 / 已发布证书指纹 / 更新传输是否允许明文）以前分别写死在
 * build.gradle、strings.xml、device.mjs、release-common.mjs、capacitor.config.ts 里，没有任何一处
 * 能回答「这个包的身份证是什么」。其中最贵的教训是包名：`DeviceFingerprintPlugin.java` 用
 * `sha256Hex(androidId + getPackageName())` 做设备指纹，包名一换就静默换掉全网老设备的账号身份
 * （额度 / 邀请关系 / 卡密绑定全对不上，见 #243 / #252 / #264）。
 *
 * 这个门禁把它变成一条命令。四条规则：
 *   1. 身份字面量只许出现在 config/appIdentity.json（以及文档 / 测试样本 / Java 包结构 / deploy）；
 *      其余任何位置出现 = 又添了一份副本 → FAIL 并打印 `文件:行: 字面量`。
 *   2. config 的 applicationId / label.zh / expectedCertSha256 必须与
 *      scripts/lib/appIdentity.mjs 的 PUBLISHED_IDENTITY 一致（改身份必须显式化 + 带迁移方案）。
 *   3. allowInsecureUpdateTransport=false 时，更新链路（config/endpoints.json 的 download.*、
 *      updateManifest.ts、UpdateEndpoint.java）里不许出现 http:// 地址（把 #268 的明文决策钉在
 *      配置里；#269 把地址搬进 JSON 后，这份 JSON 也是扫描源，否则这条闸门会空转）。
 *   4. 消费方实际解析出来的包名必须等于配置值（device.mjs / release-common.mjs），
 *      strings.xml 不许再声明那四个由 resValue 生成的字符串。
 *
 * 用法：
 *   node scripts/check-identity.mjs
 *   pnpm run check:identity
 *
 * 退出码：
 *   0  通过
 *   1  有违规（逐条打印，带文件与行号）
 *   2  环境/用法错误（配置缺失或格式非法）
 */
import { AppIdentityError, APP_IDENTITY_REL_PATH, identityGate } from './lib/appIdentity.mjs'

const main = async () => {
  let result
  try {
    result = await identityGate()
  } catch (error) {
    if (error instanceof AppIdentityError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }

  const { identity, violations, transports } = result
  const insecure = transports.filter((item) => item.url.startsWith('http://')).length

  if (violations.length === 0) {
    console.log(
      `应用身份检查通过：${APP_IDENTITY_REL_PATH} → applicationId=${identity.applicationId}、` +
        `应用名=${identity.label.zh}、证书=${identity.expectedCertSha256.slice(0, 8)}…、` +
        `明文更新传输=${identity.allowInsecureUpdateTransport ? '允许（#268 现状）' : '禁止'}；` +
        `更新链路地址 ${transports.length} 条（明文 ${insecure} 条），违规 0 处。`,
    )
    return 0
  }

  console.error(`发现 ${violations.length} 处应用身份违规（唯一来源：${APP_IDENTITY_REL_PATH}）：\n`)
  for (const violation of violations) {
    const where = violation.line ? `${violation.file}:${violation.line}` : violation.file
    console.error(`  [${violation.code}] ${where}`)
    console.error(`      ${violation.message}`)
    console.error('')
  }
  return 1
}

process.exitCode = await main()
