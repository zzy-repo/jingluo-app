# 应用身份（包名 / 应用名 / 证书指纹 / 更新传输）

`config/appIdentity.json` 是**唯一来源**（Issue #271）。这一份配置同时喂给：

| 消费方 | 读到的字段 | 怎么读 |
| --- | --- | --- |
| `android/app/build.gradle` | `namespace` / `applicationId` / `label.zh` / `expectedCertSha256` | `JsonSlurper`，缺字段或格式非法直接 `GradleException` 中止 |
| `android/app/build.gradle` → `resValue` | `label.zh` → `app_name` / `title_activity_main`；`applicationId` → `package_name` / `custom_url_scheme` | 编译期生成 res，`res/values/strings.xml` 里不再保留这四项 |
| `android/app/src/main/AndroidManifest.xml` | `${applicationId}.ARTIFACT_VARIANT` | AGP 内置占位符 |
| `capacitor.config.ts` | `applicationId` → `appId`，`label.zh` → `appName` | 同步读 JSON（CLI 以 `process.cwd()` 为项目根） |
| `scripts/lib/appIdentity.mjs` | 全部字段 | `loadAppIdentity()`，各处 Node 脚本共用 |
| `scripts/release-common.mjs` / `scripts/compat/lib/device.mjs` / `scripts/compat/run-p2.sh` | `applicationId` | 全部经 `loadAppIdentity()` / 同一份 JSON 派生 |
| `scripts/check-identity.mjs`（`pnpm check:identity`） | 全部字段 | 门禁：字面量漂移 + 已发布身份 + 明文传输 |

## 为什么这四项是「身份」而不是普通配置

1. **`applicationId` 是账号身份的一部分。**
   `DeviceFingerprintPlugin.java` 用 `sha256Hex(androidId + getPackageName())` 做设备指纹。
   把包名换掉，全网老设备的指纹同时变值 → 服务端按「新指纹」判新人 → 额度和邀请关系对不上
   （#243 / #252 / #264 那一族）。所以 `pnpm check:identity` 会把「当前配置 ≠ 已发布包名」
   判为 **FAIL 并要求显式改 `scripts/lib/appIdentity.mjs` 的 `PUBLISHED_IDENTITY`**：
   换包名必须连着迁移方案一起做，不能是某个 PR 里顺手改一行。
2. **`expectedCertSha256` 是「已发布证书」这一事实的唯一记录点。**
   现值 = AGP 默认 `/root/.android/debug.keystore` 的标准 debug key（见 `build.gradle` 注释）。
   换它 = 签名迁移，已装用户无法覆盖升级。`build.gradle` 的指纹闸门读这里。
3. **应用名散着写会让桌面图标名和任务切换器名对不上。**
   `app_name` 与 `title_activity_main` 现在都由 `label.zh` 生成，只有一份。
4. **`allowInsecureUpdateTransport` 把 #268 的决策钉在配置里。**
   现值 `true` = 现状（新分发机 `http://62.106.70.167:8888` 只有明文，见 #268）。
   它和 `src/services/updateManifest.ts` / `UpdateEndpoint.java` 里的清单地址是一对约束：
   `false` ⇒ 更新链路里不许出现任何 `http://` 地址；地址还是明文时置 `false`，
   `pnpm check:identity` 直接 FAIL 并点名是哪个文件的哪一行。
   等 #269 把域名 + TLS 做出来，先换地址、再把这个开关置 `false`。

## 改这份配置的正确姿势

- 改 `label.zh`：桌面图标名 / 任务切换器名一起变（旧机升级后图标改名，属可见变更）。
- 改 `applicationId`：**同时**改 `scripts/lib/appIdentity.mjs` 的 `PUBLISHED_IDENTITY.applicationId`，
  并在 PR 里写清老设备指纹怎么迁移（服务端映射 / 白名单 / 是否保留旧包名）。
  `android/app/src/main/java/com/example/deepseekchat/**` 是 Java 包结构目录，与 `namespace`
  绑定，改 `namespace` 必须同步搬目录。
- 改 `expectedCertSha256`：签名迁移，另开单，`build.gradle` 里有明确禁止事项。
- 改 `allowInsecureUpdateTransport`：置 `false` 之前先把 `updateManifest.ts` 与
  `UpdateEndpoint.java` 的清单地址换成 `https://`。
