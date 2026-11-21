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
  "releases": [ /* 版本记录，versionCode 严格降序，releases[0] 恒为最新发布 */ ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `latest` | string | 最新**发布**版本号，**必须**等于 `releases[0].version`（**没有例外**，见下） |
| `releases` | array | 非空，按 `versionCode` **严格降序** |

> ### 公网清单里**不可能**出现 `internal` 条目（Issue #609 / 裁决 #614 决定 3）
>
> 这里原来是「私有 internal 条目可以排在首位、`latest` 指向第一条公共记录」——**那个形状已经废止**。
> 它成立的前提是「internal 条目会写进公网清单」，而 #601 事故正是这么来的：
> 清单是公开的（`GET /releases.json` → 200），`file` 字段等于把内部包直链广播出去，
> 「文件名不可猜测」一点用都没有。
>
> 现在的口径（校验器 **public 口径**，默认）：
>
> - `artifactVariant: "internal"` 的条目 → **FAIL**（不是 warning，是 exit 1）；
> - 公网清单只允许 `artifactVariant: "standard"` 的文字值；缺 `artifactVariant` 的历史条目仍是 warning；
> - `latest` **必须**等于 `releases[0].version`，唯一的例外被删掉了；
> - 私有包改走**独立私有清单** `<private-root>/releases.internal.json`（webroot 之外），
>   用 `--private` 口径校验（只收 internal 条目，且 sha256 / buildType / 来源必须齐全）。
>
> 两份样例：公网 `deploy/dl-release/fixtures/live-2026-11-18.json`（PASS）、
> 私有 `deploy/dl-release/fixtures/private-valid-internal.json`（`--private` PASS）；
> 反例是 `invalid-internal-in-public-*.json`（#601 泄漏的那份形状，公网口径必 FAIL）。
> 发布入口是 `scripts/publish-private-apk.mjs`（手册 §14）。
>
> **同一份口径有四道门，判据必须同值（Issue #620）**：
> 1. 接口层（写之前）：`POST /api/v1/release` 只收 `standard`+`stable`，否则 `400`；
>    合并后的清单里出现 internal → `409 MANIFEST_INTERNAL_ENTRY`（`deploy/dl-release/release-target.mjs`）；
> 2. 发布脚本（写之前）：`scripts/publish-private-apk.mjs` 的 G1；
> 3. 校验器（离线）：本文件描述的 public / private 双口径；
> 4. 卫生门禁（写完之后的巡检）：`scripts/check-webroot-hygiene.mjs` 的 R4 —— 真 webroot 的
>    `releases.json` 里 internal 条目数必须为 0，读不出来也判红。

## 2. 单条版本记录

| 字段 | 类型 | 必需 | 约束 |
| --- | --- | --- | --- |
| `version` | string | ✅ | `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`（例 `1.4.0-beta.4`），全表唯一 |
| `versionCode` | integer | ✅ | 正整数，严格降序 |
| `releasedAt` | string | ✅ | ISO8601 带 `+08:00`，例 `2026-11-18T10:29:05+08:00` |
| `file` | string | ✅ | **仓库相对路径** `apk/<name>.apk`，全表唯一；绝对 URL = `https://dl.rose7.cn/` + `file`。历史记录与 `version` 同构；私有包的文件名多带 `<variant>-<随机段>`（见手册 §14.5 —— 随机段**不是**安全边界，只是同版本重发不撞名），校验器对这种情况只给 warning |
| `size` | integer | ✅ | 字节数，正整数 |
| `md5` | string | ✅ | 32 位小写 hex（服务端自己算） |
| `sha256` | string | ➕ 新版本必须 | 64 位小写 hex，针对 `file` 指向的完整文件字节（服务端自己算） |
| `changes` | string[] | ✅ | 非空字符串数组，用户可见的变更说明 |
| `buildType` | `"stable"` \| `"prerelease"` | ✅（旧记录可缺） | 语义：版本号含 alpha/beta/rc → `prerelease` |
| `artifactVariant` | `"internal"` \| `"standard"` | ➕ 可选 | 构建变体：内测包 / 对外包。**缺失 = 未知，不等于 standard** |
| `artifactVariantSource` | `"apk-manifest"` \| `"sha256-allowlist"` | ⚠️ 与 `artifactVariant` 同存同缺 | 变体判定来源，留痕用 |
| `breaking` | boolean | 可选 | 是否有不兼容变更 |
| `releasedAt` | string | 可选（历史记录多缺） | ISO8601；App 的更新弹窗拿它显示「发布时间」，解析不出来就显示「未提供」（Issue #517）。别名 `publishedAt` 也认 |
| `updatePolicy` | object | 可选 | 这次更新该怎么提示（强制 / 软性 / 普通），见 §2.1。**没下发 = App 沿用设置面板里的结果**，不弹策略弹窗 |

> ⚠️ `buildType` 与 `artifactVariant` 是**两个不同维度**，不要混用：
> `buildType` 表达「稳定版还是预发布版」（由版本号决定）；
> `artifactVariant` 表达「这个包是内测构建还是对外构建」（由构建方式决定）。
> 两者可以任意组合，例如 `1.4.0-beta.4` + `internal`。

### 2.1 更新策略 `updatePolicy`（Issue #517）

服务端在**单条记录**上下发「这次更新是不是必须装」，客户端据此决定弹窗形态：

```jsonc
{
  "versionCode": 14040,
  "version": "1.4.4",
  "releasedAt": "2026-11-20T10:00:00+08:00",
  "updatePolicy": {
    "mode": "normal",              // normal | soft | forced（别名：none→normal、hard/force→forced）
    "minSupportedVersionCode": 0,  // 低于此值一律强制；0/缺省 = 没设下限
    "snoozeHours": 24,             // soft 的「稍后提醒」时长，夹到 [1, 720] 小时
    "reason": "当前版本存在严重缺陷，请更新后继续使用", // forced 时展示给用户（可选，>500 字符丢弃）
    "expiresAt": "2026-12-31T23:59:59+08:00"           // 策略过期即整体失效（可选）
  }
}
```

客户端判定顺序（唯一实现：`src/services/updatePolicy.ts` 的 `resolveUpdatePolicy()`，表驱动用例
`tests/unit/update-policy-517.test.mjs`）：

1. `expiresAt` 已过期 → **normal**（陈旧缓存 / 误配不许把用户永久锁在强制弹窗里，连下限一起失效）；
2. `versionCode < minSupportedVersionCode` → **forced**，**优先于** `mode`；
3. 否则按 `mode`；
4. `mode` 缺失 / 非法 / 整份策略不像对象 → **normal**（判定失败一律站用户这边）。

| 档位 | 弹窗行为 |
| --- | --- |
| `forced` | 不渲染关闭按钮、点遮罩无效、`Esc` 无效、返回键无效；只保留下载出口（不能把用户困在点不动的界面里） |
| `soft` | 「稍后提醒」按 `snoozeHours` 写入本地设置 `chat-demo:update-snooze-until`，期内同一版本不再弹；`X` / `Esc` / 遮罩 / 返回键等同于「稍后提醒」 |
| `normal` | 随时可关（关闭 / `Esc` / 遮罩 / 返回键），**不写** snooze |

> 没下发 `updatePolicy` 的记录**不弹策略弹窗**：老服务端（以及现有 L1 契约）行为一个字不变，
> 结果仍在「设置 → 应用更新」面板里展示（渠道切换 / 诊断 / 缓存兜底都还在那里）。

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
# 结构 + 新字段契约（默认公网口径）
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/live-2026-11-18.json
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/invalid-*.json   # 应全部 FAIL
# 私有清单口径（#609：webroot 之外那份）
node scripts/validate-releases-manifest.mjs --private deploy/dl-release/fixtures/private-valid-internal.json
node scripts/validate-releases-manifest.mjs --private deploy/dl-release/fixtures/private-invalid-*.json  # 应全部 FAIL

# 公网清单 internal 条目数 = 0（真 webroot；本机没有 /var/www/dl 时自动跑内置演练）
DL_WEBROOT=/var/www/dl node scripts/check-webroot-hygiene.mjs

# 服务端行为（真 APK 打真服务端，临时目录，不碰线上）
node --test deploy/dl-release/test/*.test.mjs
AAPT2=/path/to/aapt2 \
APK_STANDARD=/path/deepseek-chat-1.4.0.apk \
APK_INTERNAL=/path/deepseek-chat-1.4.0-beta.10.apk \
APK_NO_MARKER=/path/no-marker-history.apk \
APK_DEBUGGABLE=/path/deepseek-chat-1.4.0-beta.8.apk \
bash deploy/dl-release/test/offline-check.sh
```
