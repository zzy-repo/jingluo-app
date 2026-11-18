# releases.json 清单契约（App 内更新 / 发布侧共同遵守）

`https://dl.rose7.cn/releases.json` 是**唯一权威**的已发布版本清单：谁发布、发了什么、变体是什么、
下载地址与校验值全部以它为准。App 内更新、GitHub Release 流水线、发布脚本都读它。

本文是字段契约的唯一来源；服务端实现见 `deploy/dl-release/server.mjs`，离线校验器见
`scripts/validate-releases-manifest.mjs`。

---

## 1. 顶层结构

```json
{
  "latest": "1.4.0-beta.4",
  "releases": [ /* 版本记录，versionCode 严格降序，releases[0] 恒为 latest */ ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `latest` | string | 最新发布版本号，**必须**等于 `releases[0].version` |
| `releases` | array | 非空，按 `versionCode` **严格降序** |

## 2. 单条版本记录

| 字段 | 类型 | 必需 | 约束 |
| --- | --- | --- | --- |
| `version` | string | ✅ | `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`（例 `1.4.0-beta.4`），全表唯一 |
| `versionCode` | integer | ✅ | 正整数，严格降序 |
| `releasedAt` | string | ✅ | ISO8601 带 `+08:00`，例 `2026-11-18T10:29:05+08:00` |
| `file` | string | ✅ | **仓库相对路径** `apk/<name>.apk`，全表唯一；绝对 URL = `https://dl.rose7.cn/` + `file` |
| `size` | integer | ✅ | 字节数，正整数 |
| `md5` | string | ✅ | 32 位小写 hex（服务端自己算） |
| `sha256` | string | ➕ 新版本必须 | 64 位小写 hex，针对 `file` 指向的完整文件字节（服务端自己算） |
| `changes` | string[] | ✅ | 非空字符串数组，用户可见的变更说明 |
| `buildType` | `"stable"` \| `"prerelease"` | ✅（旧记录可缺） | 语义：版本号含 alpha/beta/rc → `prerelease` |
| `artifactVariant` | `"internal"` \| `"standard"` | ➕ 可选 | 构建变体：内测包 / 对外包。**缺失 = 未知，不等于 standard** |
| `artifactVariantSource` | `"apk-manifest"` \| `"sha256-allowlist"` | ⚠️ 与 `artifactVariant` 同存同缺 | 变体判定来源，留痕用 |
| `breaking` | boolean | 可选 | 是否有不兼容变更 |

> ⚠️ `buildType` 与 `artifactVariant` 是**两个不同维度**，不要混用：
> `buildType` 表达「稳定版还是预发布版」（由版本号决定）；
> `artifactVariant` 表达「这个包是内测构建还是对外构建」（由构建方式决定）。
> 两者可以任意组合，例如 `1.4.0-beta.4` + `internal`。

## 3. 读取侧（App）必须遵守的语义

1. **`file` 拼 URL，不要用 `version` 拼文件名**：`https://dl.rose7.cn/` + `file`。版本号与文件名
   不保证同构，历史上有旧路径兼容重定向，但**不要依赖重定向**。
2. **`sha256` 缺失或格式非法 → 既不能自动更新，也不能作为手动安装目标**（不降级到 md5 校验）。
   md5 只做展示/排查用，不作为安装依据。
3. **`artifactVariant` 缺失或非法 → 该记录不得被自动更新选中**；可以展示，但只能人工判断。
   未知变体**绝不能默认当成 `standard`**。
4. **推荐/自动更新条件**：`清单.artifactVariant === 已装包的 artifactVariant` **且**
   `清单.versionCode > 已装包的 versionCode`。不比较 `version` 字符串大小。
5. **安装前再验一次**：下载到的包用系统/aapt2 解析出的 `packageName` 必须
   `com.example.deepseekchat`，且其 `versionCode` 与清单记录一致，否则丢弃。
6. `latest` 只表示「最新发布」，**不等于「推荐给你」**；推荐逻辑在 App 侧。

## 4. 变体（artifactVariant）从哪来 —— 服务端判定，客户端说了不算

| 优先级 | 来源 | `artifactVariantSource` | 说明 |
| --- | --- | --- | --- |
| 1 | APK 内 `AndroidManifest.xml` 的 `<meta-data>` 标记 | `apk-manifest` | 构建期写入，受 APK 签名覆盖 |
| 2 | 服务器侧 sha256 白名单 `/etc/dl-release/artifact-variants.json` | `sha256-allowlist` | 仅用于**没有标记的历史包** |
| 3 | 都没有 | （不写字段） | 判为 unknown，绝不默认 `standard` |

**上传时 `meta.artifactVariant` 一律不采信**（只记一条 `meta_variant_ignored` 日志）。
标记与白名单互相矛盾时 → `409 VARIANT_CONFLICT`，不静默取其一。

### 4.1 APK 内标记契约（App 构建方实现）

```xml
<!-- android/app/src/main/AndroidManifest.xml，<application> 直接子节点 -->
<meta-data
    android:name="com.example.deepseekchat.ARTIFACT_VARIANT"
    android:value="${artifactVariant}"/>
```

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        manifestPlaceholders = [artifactVariant: (project.findProperty('artifactVariant') ?: 'standard')]
    }
}
```

- 取值必须严格是 `internal` 或 `standard`（小写）。
- 用 `android:resource` 引用、非字符串类型、值越界、标记缺失 → 服务端一律判 unknown。
- 发布脚本负责对齐：`--internal` → `-PartifactVariant=internal`，`--standard` → `-PartifactVariant=standard`
  （让 `pnpm build:internal` 与 APK 标记指向同一个变体）。
- 解析方式：`aapt2 dump xmltree <apk> --file AndroidManifest.xml`。
  ⚠️ `aapt2 dump badging` **不输出** meta-data（已实测），不要用 badging 解析标记。

> **可信边界（别夸大）**：该标记受签名覆盖，改它就必须重签名，所以它比客户端 `meta` 强得多；
> 但 `dl-release` 目前**不核验签名证书指纹**，因此它是「发布方声明」而非「服务端已验证的发布方身份」。
> 签名指纹核验是单独待办，不在本次范围。

### 4.2 历史包白名单

```json
{
  "apks": {
    "70ffd85dbda2dad35038485466fc69a57d841c0d5dbcbd1d1a6224f61bb3f2d5": {
      "variant": "internal",
      "version": "1.4.0-beta.4",
      "note": "依据 /tmp/rel-run2.log「构建并校验产物（internal）」+ 状态文件 1.4.0-beta.4.json"
    }
  }
}
```

键必须是 sha256（64 位小写 hex），文件仅 root 可写、服务端只读。这是**人工登记**通道，
只用于补救没有标记的历史包；新版本请走 APK 标记，避免每版人工登记卡住自动更新。

## 5. 本次对历史记录的处理

- 全部历史记录**不猜变体**（`artifactVariant` 保持缺失）。
- `1.4.0-beta.4` 可补 `sha256`（= `70ffd85d…f2d5`，已对线上 APK 实测）与
  `artifactVariant: "internal"`（依据：`/tmp/rel-run2.log` 的「6/9 构建并校验产物（internal）」、
  `INTERNAL_BUILD=1`，以及 `/root/.local/state/deepseek-app/release/1.4.0-beta.4.json` 的
  commit `1d08b247` / code 11 / md5 `28485902…2d21` 与线上包一致），来源记 `sha256-allowlist`。
- 其余历史记录只补 `sha256` 是可选的；没有 `sha256` 的记录 App 不会自动/手动安装。

## 6. 离线校验

```bash
# 结构 + 新字段契约
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/live-2026-11-18.json
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/proposed-beta4-internal.json
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/invalid-*.json   # 应全部 FAIL

# 服务端行为（真 APK 打真服务端，临时目录，不碰线上）
node --test deploy/dl-release/test/*.test.mjs
AAPT2=/path/to/aapt2 \
APK_NO_MARKER=/path/deepseek-chat-1.4.0-beta.4.apk \
APK_NO_MARKER_OLD=/path/deepseek-chat-1.4.0-beta.3.apk \
APK_WITH_MARKER=/path/marker.apk \
bash deploy/dl-release/test/offline-check.sh
```
