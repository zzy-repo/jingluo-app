# dl.rose7.cn APK 发布接口（dl-release）

把 APK 发布从「scp + 远端脚本」换成一次 HTTP 上传。发布者只需要：

1. 本地构建出 APK（keystore 不出构建机）；
2. `POST` 一次到本接口；
3. 服务端自己校验 APK 真身、自己算 MD5、原子更新 `releases.json`。

下载站页面（`https://dl.rose7.cn/`）立即反映新版本，无需再手工改 JSON。

---

## 1. 端点

**一条路径 = 一个发布目标**（#620）。口径不靠参数切换：口径一旦能被参数选择，就会有人选错，
而错的那一次正是把 internal 包写进公网清单的那一次（#601 事故形态）。

| 发布目标 | URL | 写哪份清单 | 只收 |
| --- | --- | --- | --- |
| 公网（正式分发） | `https://dl.rose7.cn/api/v1/release` | `/var/www/dl/releases.json`（webroot 内，公开可读） | `artifactVariant="standard"` **且** `buildType="stable"` |
| 私有（内测） | `POST http://127.0.0.1:8799/api/v1/release/private`（**不反代**，见 §5c；公网 POST 它 = 404） | `/var/www/dl-private/releases.internal.json`（**webroot 之外**，公网 file_server 够不着；`DL_PRIVATE_RELEASES_JSON`） | `artifactVariant="internal"`（渠道不限） |

| 项目 | 值 |
| --- | --- |
| 方法 | `POST`（其他方法 → 405） |
| 鉴权 | `Authorization: Bearer <发布令牌>`（两个端点同一枚令牌） |
| 请求类型 | `multipart/form-data` |
| 服务 | `dl-release.service`（Node 单文件零依赖，监听 `127.0.0.1:8799`，仅由 Caddy 反代，公网不可直连） |

Caddy 里只在 `@dl`（`host dl.rose7.cn`）这个 handle 内对 `/api/v1/release`（公网写）、`/api/v1/version`
与 `/api/v1/releases/*`（#621 私有读，带令牌）做了 `reverse_proxy`，其余路径仍是 `file_server` 静态文件。
`/api/v1/release/private`（#620 私有写）**不在反代里**：私有包发布走 `scripts/publish-private-apk.mjs`
+ `ssh`/`scp` 直接落盘（不出公网），接口层那条闸只在本机 `127.0.0.1:8799` / ssh 隧道内可达（§5c、手册 §14.1b）。

> 私有端点不是「另一个公网通道」：它写的是 webroot 之外的目录，回包也**不给公网 URL**。
> 服务启动时会核一遍「私有根不在 webroot 内」，配错了直接拒绝启动（日志 `fatal_private_root_in_webroot`）。

### `GET /api/v1/version`（Issue #441，免令牌）

回答「线上跑的是哪一版」——不靠 ssh 数行数。只回非敏感信息，不需要令牌，也不吃上传限流额度：

```json
{ "ok": true,
  "sha256": "<server.mjs 自身内容的 sha256，启动时算一次并缓存>",
  "builtAt": "<进程启动时间，ISO 8601>",
  "nodeVersion": "v24.16.0",
  "variants": ["internal", "standard"],
  "buildTypes": ["stable", "prerelease"],
  "targets": ["public", "private"] }
```

- `sha256` 是**启动时**读到的字节，之后替换文件不会改变它（进程还在跑旧字节）；
- `builtAt` 是进程启动时刻，重启/回滚后应变化；
- 部署后三方比对（线上文件 / `origin/main` / 本端点）必须一致，流程见
  [`docs/RELEASE-MANUAL.md`](RELEASE-MANUAL.md) §12。

## 2. 请求

```
POST /api/v1/release
Authorization: Bearer <token>
Content-Type: multipart/form-data; boundary=...
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `apk` | 文件 | 是 | APK 本体，≤ 50 MB |
| `meta` | JSON 字符串 | 是 | `{"version","versionCode","buildType","changes":[...]}` |

`meta` 细节：

- `changes`: 字符串数组，写进 `releases.json`，也会被 GitHub Actions 用来生成 Release Notes。
- `buildType`: `stable` / `prerelease`；省略时按版本号自动判定（含 `-alpha`/`-beta`/`-rc` → `prerelease`）。
  **公网端点只收 `stable`**（预发布版走 GitHub Release 的 `prerelease` 资产）；私有端点不限渠道。
- `artifactVariant`: 客户端写什么都不被采信（只记一条 `meta_variant_ignored`）。变体由 APK 内标记 /
  服务器白名单判定，判据在服务端；`standard` 才能进公网清单，`internal` 只能进私有清单。
- `version` / `versionCode`: **仅供参考**。服务端一律以 APK 二进制里解析出的 `versionName` / `versionCode` 为准，与 APK 冲突时只记一条 `meta_versioncode_mismatch` / `meta_version_mismatch` 日志，不会采信客户端。
- `breaking`（可选）: 布尔值，原样写入记录。

### 示例

```bash
TOKEN=$(ssh aliyun 'cat /etc/dl-release/token')

curl -sS -X POST https://dl.rose7.cn/api/v1/release \
  -H "Authorization: Bearer $TOKEN" \
  -F "apk=@android/app/build/outputs/apk/release/app-release.apk" \
  -F 'meta={
        "version":"1.4.0-beta.4",
        "versionCode":11,
        "buildType":"prerelease",
        "changes":["新增：xxx","修复：yyy"]
      }'
```

## 3. 响应

成功 `200`（公网端点）：

```json
{
  "ok": true,
  "target": "public",
  "url": "https://dl.rose7.cn/apk/deepseek-chat-1.4.0.apk",
  "latest": "1.4.0",
  "md5": "9f2c...（服务端自己算的）",
  "sha256": "70ffd8...（服务端自己算的）",
  "artifactVariant": "standard",          // 公网端点这里恒为 "standard"
  "artifactVariantSource": "apk-manifest" // 或 "sha256-allowlist"
}
```

成功 `200`（私有端点 —— 注意**没有 `url`**，改给 `file` 相对路径；私有包不该有公网直链）：

```json
{
  "ok": true,
  "target": "private",
  "file": "apk/deepseek-chat-1.4.0-beta.10.apk",
  "latest": "1.4.0-beta.10",
  "md5": "...", "sha256": "...",
  "artifactVariant": "internal", "artifactVariantSource": "apk-manifest"
}
```

失败统一：

```json
{ "ok": false, "error": { "code": "VERSION_CONFLICT", "message": "人类可读原因" } }
```

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 不是 multipart、缺 `apk`/`meta`、`meta` 不是合法 JSON 对象、`changes` 不是字符串数组 |
| 400 | `INVALID_APK` | `aapt2` 解析失败（不是 APK / 损坏），或包名不是 `com.example.deepseekchat` |
| 400 | `APK_DEBUGGABLE` | APK 里 `application/android:debuggable` 为 `true`，或无法确认该属性（fail-closed）。可调试包会被 `adb run-as` 读私有数据，发布路径一律拒收（Issue #60） |
| 400 | `VARIANT_NOT_PUBLIC` | **公网端点收到 `artifactVariant !== "standard"` 的包**（internal，或变体判不出来 = unknown）。公网清单是公开的，`file` 字段等于把内部包直链广播出去（#601 / 裁决 #614 决定 3）。internal 包改走 `POST /api/v1/release/private`。零落盘，`releases.json` 一个字节不改（#620 的接口层硬闸） |
| 400 | `VARIANT_NOT_PRIVATE` | **私有端点收到 `artifactVariant="standard"` 的包**：standard 走 GitHub Release（裁决 #614 决定 2），不进私有清单。两份清单都不动 |
| 400 | `BUILD_TYPE_NOT_PUBLIC` | **公网端点收到 `buildType !== "stable"`**（显式 `prerelease`，或按版本号推导出 `prerelease`）：预发布版走 GitHub Release 的 `prerelease` 资产。零落盘 |
| 400 | `LOOPBACK_BUILD_REJECTED` | APK 内 `<meta-data …LOOPBACK_CONSUME="true">`：这是用回环地址（`127.0.0.1` / `localhost` / `::1`）打出的 consume 构建，**仅用于本地联调**（真机上 `127.0.0.1` 指的是手机自己，只能配 `adb reverse`），禁止入库分发。标记缺失（历史包）照旧放行（Issue #601） |
| 401 | `UNAUTHORIZED` | 令牌缺失/错误（常数时间比较） |
| 404 | `NOT_FOUND` | 路径不是 `/api/v1/release` |
| 405 | `METHOD_NOT_ALLOWED` | 非 POST |
| 409 | `VERSION_CONFLICT` | `versionCode` 不大于当前 `latest`（防降级），且版本号与 latest 不同 |
| 409 | `VARIANT_CONFLICT` | APK 内变体标记与服务器 sha256 白名单不一致（不静默取一个） |
| 409 | `MANIFEST_INTERNAL_ENTRY` | 公网端点：合并后的公网清单里还有 `artifactVariant !== "standard"` 的条目（历史上漏进过一条 internal）。整单拒收，先把它们挪进私有清单再发（#620） |
| 409 | `MANIFEST_STANDARD_ENTRY` | 私有端点：合并后的私有清单里还有 `standard` 条目（两种口径互斥，与 `validate-releases-manifest.mjs --private` 同判据） |
| 413 | `PAYLOAD_TOO_LARGE` | APK > 50 MB（或整个请求体超限） |
| 429 | `RATE_LIMITED` | 同 IP 每分钟超过 2 次，带 `Retry-After` |
| 500 | `INTERNAL` | 写盘 / 状态文件更新等内部错误 |

## 4. 服务端校验（不信任客户端）

| # | 校验 | 实现 |
| --- | --- | --- |
| 1 | 令牌 | 从 `/etc/dl-release/token`（`chmod 600`，root:root）读；比较双方各取 SHA-256 摘要后 `crypto.timingSafeEqual`，定长比较不泄漏长度 |
| 2 | 体积 ≤ 50 MB | `Content-Length` 预检 + 流式累计超限即 `413`；APK 分片再单独卡 50 MB |
| 3 | 服务端算 MD5 | `crypto.createHash('md5')` 对收到的字节流计算，不接受客户端提供的 md5 |
| 4 | 解析真实 versionName/versionCode/packageName | `aapt2 dump badging`（二进制位于 `/opt/dl-release/bin/aapt2`，从 Google Maven `com.android.tools.build:aapt2` 的 `aapt2-<ver>-linux.jar` 解出；ECS 上原本没有 Android SDK） |
| 5 | 包名白名单 | 必须是 `com.example.deepseekchat` |
| 5b | 拒绝 debuggable 包 | 解 APK 内 `AndroidManifest.xml`（二进制 AXML，见 `deploy/dl-release/apk-manifest.mjs`），`application/android:debuggable` 为 `true` 或判不出来 → `400 APK_DEBUGGABLE`；与客户端 meta 无关 |
| 5c | 拒绝「回环 consume」包 | 同一个零依赖 AXML 解析读 `<meta-data android:name="com.example.deepseekchat.LOOPBACK_CONSUME" android:value="true">`（构建期由 `android/app/build.gradle` 写入，只有显式 `-PallowLoopbackConsume=true` 才写）→ `400 LOOPBACK_BUILD_REJECTED`，临时文件清掉、`releases.json` 不动。**读不到标记（历史包）→ 放行**，不追溯（Issue #601） |
| 6 | 防降级 | APK 真值 `versionCode` 必须 > `releases.json` 当前 latest 的 `versionCode`，否则 `409` |
| 6b | 算 sha256 | 与 md5 同时计算，写入记录，供 App 内更新做完整性强校验（App 不用 md5 决策） |
| 6c | 判定构建变体 | APK 内 `com.example.deepseekchat.ARTIFACT_VARIANT` 标记（`aapt2 dump xmltree`）> 服务器 sha256 白名单 > unknown；**客户端 meta 不采信** |
| 6d | **目标清单 × 变体**（#620） | 公网端点 + 非 `standard`（含 unknown）→ `400 VARIANT_NOT_PUBLIC`；私有端点 + 非 `internal` → `400 VARIANT_NOT_PRIVATE`。判据在 `deploy/dl-release/release-target.mjs`（纯函数），与 `scripts/publish-private-apk.mjs` 的 G1、`scripts/validate-releases-manifest.mjs` 的 public/private 双口径**同一份枚举**（`tests/unit/release-api-variant-gate.test.mjs` 钉住三处同值） |
| 6e | **目标清单 × 渠道**（#620） | 公网端点只收 `buildType="stable"`（显式或推导），否则 `400 BUILD_TYPE_NOT_PUBLIC`；私有端点不限渠道 |
| 6f | 合并后整份清单的变体互斥（#620） | 公网合并结果里出现非 standard / 私有合并结果里出现 standard → `409`，写盘前 fail-closed（同 #330 的 `MANIFEST_DIRTY` 手法） |
| 7 | 同版本重传 | `versionName` 与 latest 完全相同时允许覆盖（幂等），记录不重复出现，`releases[]` 数量不变 |

## 5. 副作用

- APK 落到目标目录：公网端点 → `/var/www/dl/apk/deepseek-chat-<version>.apk`；私有端点 →
  `/opt/dl-private/apk/deepseek-chat-<version>.apk`（私有根 `DL_PRIVATE_ROOT=/opt/dl-private`，webroot 之外）。文件名由**服务端解析出的
  versionName** 决定，先写 `.upload-*` 临时文件再 `rename`，同一文件系统内原子替换。
- 目标清单原子更新（公网 → `releases.json`；私有 → `releases.internal.json`）：同目录临时文件 → `fsync` → `rename` → `fsync` 目录。结构保持 `latest` + `releases[]`（`version` / `versionCode` / `releasedAt` / `file` / `size` / `md5` / `sha256` / `changes` / `buildType` / `breaking`，
变体可判定时再加 `artifactVariant` + `artifactVariantSource`，判不出来就**不写**该字段），按 `versionCode` 降序，新版本在首位。
- 失败路径不写任何生产文件（临时文件即删）。

## 5b. 构建变体与白名单（2026-11 新增）

- 上传时的 `meta.artifactVariant` **不被采信**，只记录一条 `meta_variant_ignored` 日志。
- 变体判定优先级：APK 内标记（`aapt2 dump xmltree` 解析 `<meta-data name="com.example.deepseekchat.ARTIFACT_VARIANT">`）
  → 服务器 sha256 白名单 `/etc/dl-release/artifact-variants.json` → unknown（不写字段，绝不默认 standard）。
- 白名单格式：`{"apks": {"<sha256>": {"variant": "internal", "version": "1.4.0-beta.4", "note": "依据…"}}}`
  （仅 root 可写，服务端只读；只用于没有标记的历史包）。
- 详细契约见 `docs/releases-manifest.md`。

## 5c. 两个发布目标（#620）

```bash
TOKEN=$(ssh aliyun 'cat /etc/dl-release/token')
APK=android/app/build/outputs/apk/release/app-release.apk

# 正式包（standard + stable）→ 公网清单，公开可下载
curl -sS -X POST https://dl.rose7.cn/api/v1/release \
  -H "Authorization: Bearer $TOKEN" \
  -F "apk=@$APK" -F 'meta={"buildType":"stable","changes":["…"]}'

# 内测包（APK 内 ARTIFACT_VARIANT=internal）→ 私有清单（webroot 之外），公网清单零影响
# ⚠️ 这个端点**不反代**（公网 POST 它 = 404）：只有本机 8799 能发，所以在 DL 主机上执行，
#    或 `ssh -L 8799:127.0.0.1:8799 aliyun` 开隧道后打 127.0.0.1。日常发布走脚本（`scripts/publish-private-apk.mjs`，见 docs/RELEASE-MANUAL.md §14.2）。
curl -sS -X POST http://127.0.0.1:8799/api/v1/release/private \
  -H "Authorization: Bearer $TOKEN" \
  -F "apk=@$APK" -F 'meta={"changes":["…"]}'
```

判据与拒绝码（都是 4xx + 明确 `code`，且**失败路径零落盘**）：

| 你发了什么 | 发到哪个端点 | 结果 |
| --- | --- | --- |
| internal 包 | `/api/v1/release`（公网） | `400 VARIANT_NOT_PUBLIC` |
| 变体判不出来（老包且没登记白名单） | `/api/v1/release` | `400 VARIANT_NOT_PUBLIC`（**不默认 standard**） |
| `buildType=prerelease`（或版本号 `-beta`） | `/api/v1/release` | `400 BUILD_TYPE_NOT_PUBLIC` |
| standard 包 | `/api/v1/release/private` | `400 VARIANT_NOT_PRIVATE` |
| internal 包 | `/api/v1/release/private`（本机/隧道，不反代） | `200`，写 `/var/www/dl-private/releases.internal.json` |
| standard + stable 包 | `/api/v1/release` | `200`，写 `/var/www/dl/releases.json` |

公网清单里出现 internal 条目这件事，除了接口拒绝（写之前）和 `check:webroot-hygiene` 的 R4（写完之后的
巡检）之外，还有 `scripts/validate-releases-manifest.mjs` 的公网口径（离线校验）拦一道 —— 三处同一份枚举。

## 5d. 客户端读私有清单（Issue #622 —— #377「内测用户无法自动更新」的解法）

服务端给了带令牌的读端点（#621），客户端那一半是 `src/services/updateManifest.ts`：
**internal 变体优先读私有清单，任何失败静默回退公网 `releases.json`**。

| 项 | 值 |
| --- | --- |
| 配置 | `config/endpoints.json` 的 `update.privateManifest`：`enabled`（默认 `false`）/ `url`（完整端点）/ `tokenEnv`（令牌来源的环境变量名，默认 `DL_PRIVATE_TOKEN`） |
| 注入 | 构建期由 `rspack.config.ts` 的 `privateManifestInjection` 注入成 `__ENDPOINTS__.update.privateManifest`（`enabled` + `url` + `token`） |
| 判据 | 请求条件是 **`enabled === true` 且本机变体是 `internal`**（`__INTERNAL_BUILD__`）；standard 包即使被误配成 `enabled:true` 也不请求 |
| 令牌 | **只进 `X-DL-Token` 请求头**：不进 URL、不进日志、不进埋点（`updateManifest.ts` 不 import 诊断通道，`tests/unit/private-manifest-622.test.mjs` 有静态扫描断言） |
| 回退 | 401 / 429 / 超时 / 网络 / 清单被写脏 → **静默回退公网**，不让整个检查失败；取消照常上抛 |
| 解析 | 与公网清单**同一套 schema**：`parseManifest` + `selectUpdate`，没有第二份筛选逻辑（#484 的硬规矩） |

**令牌随 internal 包分发到设备 —— 这是本设计的固有代价，不是疏忽。** 三条边界说明它的影响面：

1. 令牌只进 **internal 产物**：`internalBuild=false` 时整段按 `enabled:false` 注入（`url` 与 `token` 都为空串），
   public / standard 包里连私有端点地址都不出现（实测见 #622 的 PR：standard 产物里令牌与端点命中数都是 0）。
2. 泄漏后的能力上限 = **读私有清单 + 下载 internal 包**，不含任何用户数据、不含发布能力
   （写端点用的是同一枚令牌 —— 这是目前的**已知放大点**：拿到令牌的人也能发私有包，拆只读令牌的方案见 #641）。
3. 令牌可以轮换，代价只是**重出 internal 包**（standard 包不受影响）。

### 轮换令牌（读端点这一侧）

```bash
# 1) 主机上换令牌（与 §7 同一条命令）
head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48 > /etc/dl-release/token
chmod 600 /etc/dl-release/token && node --check /opt/dl-release/server.mjs && systemctl restart dl-release

# 2) 本机出新的 internal 包（令牌只在构建环境里，不进仓库、不进 config/endpoints.json）
DL_PRIVATE_TOKEN="$(ssh aliyun cat /etc/dl-release/token)" INTERNAL_BUILD=1 \
  DIST_OUT=dist-internal node scripts/build.mjs --internal

# 3) 按 docs/RELEASE-MANUAL.md §14 发这个 internal 包（写私有清单 + 私有根）
#    —— 老 internal 包里的令牌此刻已经失效：它们会静默回退公网清单（不崩、不弹错，只是看不到内测版）
```

忘了给令牌就出内测包时，构建会直接中止（`update.privateManifest.enabled=true，但构建环境没有 DL_PRIVATE_TOKEN`），
不会出一个「装了却永远静默走公网」的包。

## 6. 限流与日志

- 限流：每 IP 每分钟 2 次（滑动窗口）。IP 取 Caddy 覆盖写入的 `X-Real-IP`，缺失时取 `X-Forwarded-For` **最右一跳**（客户端自带的 XFF 无法绕过）。
- 日志：`journalctl -u dl-release -f`。字段化输出 `event=...`，**不打印令牌、Authorization、请求体**。事件包括 `release_ok` / `release_private_ok` / `reject_auth` / `reject_not_apk` / `reject_package` /
`reject_downgrade` / `reject_rate_limit` / `reject_variant_target` / `reject_build_type_target` /
`reject_manifest_variant` / `fatal_private_root_in_webroot` / `meta_versioncode_mismatch` 等。

## 7. 运维

```bash
# 状态 / 日志
systemctl status dl-release
journalctl -u dl-release -n 50 --no-pager

# 重启（改完 server.mjs 后）
node --check /opt/dl-release/server.mjs && systemctl restart dl-release

# 轮换令牌（同时要更新调用方）
head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48 > /etc/dl-release/token
chmod 600 /etc/dl-release/token && systemctl restart dl-release

# 健康检查（仅本机）
curl -s http://127.0.0.1:8799/healthz
```

Caddy 变更（务必先 `set -a; . /opt/caddy/caddy.env`，且**禁止** `systemctl restart`）：

```bash
cd /opt/caddy
set -a; . /opt/caddy/caddy.env; set +a
./caddy-alidns validate --config /opt/caddy/Caddyfile --adapter caddyfile
./caddy-alidns reload --config /opt/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
```

## 8. GitHub Release 流水线

`.github/workflows/release.yml`，**手动 `workflow_dispatch` 触发**（裁决 #614 决定 2 之后：正式发布渠道是
GitHub Release，dl 只是历史分发，所以「发 Release」不再由 tag push 自动跑，也**不再读 `releases.json`**）：

1. 校验输入 `tag` 存在且形如 `v<version>`（不存在 → 提示先 push tag）；
2. 校验 **tag 指向的 commit** 里 `package.json` 的 `version` == tag 版本、`androidVersionCode` 为正整数；
3. 取 APK 字节：`apk_url`（https 直链）→ 已有 Release 的 `.apk` 资产 → `https://dl.rose7.cn/apk/deepseek-chat-<ver>.apk`
   依次尝试；算 `sha256` / `md5` / size。**这里只是取字节，不做任何清单校验**，**不在 CI 里构建 APK**；
4. `node scripts/check-apk-debuggable.mjs`：debuggable 包或判不出来 → 拒（fail-closed）；
5. 由 `CHANGELOG.md` 同版本小节生成 notes，并把 sha256 写进正文；
6. 用内置 `GITHUB_TOKEN`（`permissions: contents: write`）`gh release create <tag> --target <commit sha> --notes-file notes.md`；Release 已存在则 `gh release upload --clobber` + `gh release edit`；
7. 版本号含 `-beta` / `-rc` 时自动 `--prerelease`。

> 发布方提示：一键发版脚本 `release-apk.sh` 已删除（原因见 [`RELEASE.md`](../RELEASE.md)），现在上传由
> **发版人手工执行一条 `curl`** 完成，对应 [`docs/RELEASE-MANUAL.md`](RELEASE-MANUAL.md) 的步骤 4。
> 手动上传时**必须人工核对响应里的 `sha256` / `artifactVariant` / `latest`**（脚本原来替你做的强校验现在归人）。
> 不再需要 ssh/scp，也不需要远端改 `releases.json`。
