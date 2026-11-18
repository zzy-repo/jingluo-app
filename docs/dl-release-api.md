# dl.rose7.cn APK 发布接口（dl-release）

把 APK 发布从「scp + 远端脚本」换成一次 HTTP 上传。发布者只需要：

1. 本地构建出 APK（keystore 不出构建机）；
2. `POST` 一次到本接口；
3. 服务端自己校验 APK 真身、自己算 MD5、原子更新 `releases.json`。

下载站页面（`https://dl.rose7.cn/`）立即反映新版本，无需再手工改 JSON。

---

## 1. 端点

| 项目 | 值 |
| --- | --- |
| URL | `https://dl.rose7.cn/api/v1/release` |
| 方法 | `POST`（其他方法 → 405） |
| 鉴权 | `Authorization: Bearer <发布令牌>` |
| 请求类型 | `multipart/form-data` |
| 服务 | `dl-release.service`（Node 单文件零依赖，监听 `127.0.0.1:8799`，仅由 Caddy 反代，公网不可直连） |

Caddy 里只在 `@dl`（`host dl.rose7.cn`）这个 handle 内对该路径做了 `reverse_proxy`，其余路径仍是 `file_server` 静态文件。

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

成功 `200`：

```json
{
  "ok": true,
  "url": "https://dl.rose7.cn/apk/deepseek-chat-1.4.0-beta.4.apk",
  "latest": "1.4.0-beta.4",
  "md5": "9f2c...（服务端自己算的）",
  "sha256": "70ffd8...（服务端自己算的）",
  "artifactVariant": "internal",          // 判定不出来时为 null
  "artifactVariantSource": "apk-manifest" // 或 "sha256-allowlist"；null 表示 unknown
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
| 401 | `UNAUTHORIZED` | 令牌缺失/错误（常数时间比较） |
| 404 | `NOT_FOUND` | 路径不是 `/api/v1/release` |
| 405 | `METHOD_NOT_ALLOWED` | 非 POST |
| 409 | `VERSION_CONFLICT` | `versionCode` 不大于当前 `latest`（防降级），且版本号与 latest 不同 |
| 409 | `VARIANT_CONFLICT` | APK 内变体标记与服务器 sha256 白名单不一致（不静默取一个） |
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
| 6 | 防降级 | APK 真值 `versionCode` 必须 > `releases.json` 当前 latest 的 `versionCode`，否则 `409` |
| 6b | 算 sha256 | 与 md5 同时计算，写入记录，供 App 内更新做完整性强校验（App 不用 md5 决策） |
| 6c | 判定构建变体 | APK 内 `com.example.deepseekchat.ARTIFACT_VARIANT` 标记（`aapt2 dump xmltree`）> 服务器 sha256 白名单 > unknown；**客户端 meta 不采信** |
| 7 | 同版本重传 | `versionName` 与 latest 完全相同时允许覆盖（幂等），记录不重复出现，`releases[]` 数量不变 |

## 5. 副作用

- APK 落到 `/var/www/dl/apk/deepseek-chat-<version>.apk`（文件名由**服务端解析出的 versionName** 决定，先写 `.upload-*` 临时文件再 `rename`，同一文件系统内原子替换）。
- `releases.json` 原子更新：同目录临时文件 → `fsync` → `rename` → `fsync` 目录。结构保持 `latest` + `releases[]`（`version` / `versionCode` / `releasedAt` / `file` / `size` / `md5` / `sha256` / `changes` / `buildType` / `breaking`，
变体可判定时再加 `artifactVariant` + `artifactVariantSource`，判不出来就**不写**该字段），按 `versionCode` 降序，新版本在首位。
- 失败路径不写任何生产文件（临时文件即删）。

## 5b. 构建变体与白名单（2026-11 新增）

- 上传时的 `meta.artifactVariant` **不被采信**，只记录一条 `meta_variant_ignored` 日志。
- 变体判定优先级：APK 内标记（`aapt2 dump xmltree` 解析 `<meta-data name="com.example.deepseekchat.ARTIFACT_VARIANT">`）
  → 服务器 sha256 白名单 `/etc/dl-release/artifact-variants.json` → unknown（不写字段，绝不默认 standard）。
- 白名单格式：`{"apks": {"<sha256>": {"variant": "internal", "version": "1.4.0-beta.4", "note": "依据…"}}}`
  （仅 root 可写，服务端只读；只用于没有标记的历史包）。
- 详细契约见 `docs/releases-manifest.md`。

## 6. 限流与日志

- 限流：每 IP 每分钟 2 次（滑动窗口）。IP 取 Caddy 覆盖写入的 `X-Real-IP`，缺失时取 `X-Forwarded-For` **最右一跳**（客户端自带的 XFF 无法绕过）。
- 日志：`journalctl -u dl-release -f`。字段化输出 `event=...`，**不打印令牌、Authorization、请求体**。事件包括 `release_ok` / `reject_auth` / `reject_not_apk` / `reject_package` / `reject_downgrade` / `reject_rate_limit` / `meta_versioncode_mismatch` 等。

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

`.github/workflows/release.yml`，`push` 到 `v*` tag 时触发：

1. 从 tag 名解析版本号（`v1.4.0-beta.4` → `1.4.0-beta.4`）；
2. 拉 `https://dl.rose7.cn/releases.json`，找到该版本的 `file` / `md5` / `size` / `changes`（找不到就失败并列出已发布版本）；
3. 下载 `https://dl.rose7.cn/apk/deepseek-chat-<ver>.apk` 并校验 MD5（不符报 `::error::`），**不在 CI 里构建 APK**；
4. 用内置 `GITHUB_TOKEN`（`permissions: contents: write`）`gh release create <tag> --target <commit sha> --notes-file notes.md`；Release 已存在则 `gh release upload --clobber` + `gh release edit`；
5. 版本号含 `-beta` / `-rc` 时自动 `--prerelease`。

> 迁移提示：`release-apk.sh` 现在仍是 scp + 远端脚本。切到 HTTP 后，脚本只需要在构建完成后调用
> `POST https://dl.rose7.cn/api/v1/release`（`apk` + `meta`），再从响应的 `url`/`latest`/`md5` 取结果，
> 不再需要 ssh/scp，也不需要远端改 `releases.json`。
