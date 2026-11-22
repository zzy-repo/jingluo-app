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
| `scripts/lib/artifactName.mjs` / `scripts/artifact-name.mjs` | `artifactPrefix` | 产物文件名（`jingluo-chat-<version>.apk`）的唯一拼法入口，发布脚本 / CI / 分发接口共用 |
| `deploy/dl-release/server.mjs` | `artifactPrefix` | 接口落盘名（线上读 `/etc/dl-release/appIdentity.json`）；读不到不启动 |
| `scripts/check-artifact-prefix.mjs`（`pnpm check:artifact-prefix`） | `artifactPrefix` | 门禁：前缀不许退回历史值、生产者零字面量、生成与识别一致（#836） |

## `artifactPrefix`：产物文件名前缀（#836）

`artifactPrefix` 不是「身份」——它只决定**安装包产物叫什么名字**（`jingluo-chat-<version>.apk`），
不影响设备指纹、签名、已装用户。之所以放在这份配置里：维护者改应用名 / 包名 / 产物名时，
希望三件事在同一屏里看得见、一处改。

它的约束由 `pnpm check:artifact-prefix` 单独守（不参与 `PUBLISHED_IDENTITY` 断言）：

- 语法：小写字母/数字 + 连字符（`jingluo-chat`）；
- **不许是历史前缀** `deepseek-chat` —— 改回去等于撤销 #836；
- 生产者（发布脚本 / CI / 分发接口 / 校验器）不许再写一份字面量；
- 历史资产（dl / 62 上已有的 `deepseek-chat-*.apk`）**不改名不删除**，识别侧要同时认老前缀。

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

---

# 服务端端点与分发地址（`config/endpoints.json`）

`config/endpoints.json` 是**服务端端点 + 分发地址的唯一来源**（端点见 Issue #274，分发见 #269）。
两边都是「改一处 + 重打包」，但用途不同：

| 字段 | 用途 | 谁读它 | 换机器时改哪一行 |
| --- | --- | --- | --- |
| `feedbackUrl` | 旧池域**反馈上传**（唯一还在用的旧池地址；新网关上 `/feedback` 返回 502，没有后继，见 #869）。`chatBaseUrl` / `inviteBaseUrl` 已随 #869 删除：对话 / 登录 / 购买链接统一走 `consume.baseUrl`（见下面 consume 一节） | `rspack.config.ts` → `__ENDPOINTS__`；`scripts/lib/endpoints.mjs` | 改这一行 + 同步 `allowedHosts` / `allowedPorts`（`pnpm check:endpoints` 会拦） |
| `legacyHosts` | 已下线**聊天**主机的重写表 | `src/services/api/apiConfig.ts` 的 `LEGACY_HOSTS` | **别删**（删了老用户本地存的旧地址就失联）；换机时把旧主机加进来 |
| `allowedHosts` / `allowedPorts` | `check:ip` 豁免名单 / 端口白名单（旧池 IP + 网关域名 `apia.ecsafe.cn:443`；只收域名与既有旧池 IP，不收通配） | 两个门禁脚本 | 与 `feedbackUrl` / 网关 BASE 一起改 |
| `download.primaryBase` | **分发首选机**（清单 `releases.json` + `/apk/`） | Web：`__ENDPOINTS__.dlPrimaryBase`（`updateManifest.ts`）；原生：`BuildConfig.DL_PRIMARY`（`UpdateEndpoint.java`） | **换分发机只改这一行** |
| `download.fallbackBase` | **分发回退机**（所有历史版本的最后兜底） | `__ENDPOINTS__.dlFallbackBase` / `BuildConfig.DL_FALLBACK` | 换回退机才改 |

要点：

1. **分发地址不进 `URL_FIELDS`。** `validateEndpoints` 的第 6 条要求「三个服务端点在同一台机器上」，
   而分发机是另一台机器（清单 + `/apk/`）。所以 `download.*` 由 `validateDownload` 单独校验：
   必须是「协议://主机[:端口]」（不带路径 / 查询串 / 凭据、不带尾斜杠）、回退机必须 https、两个 base 不许相同。
2. **下载白名单不单独配。** 原生 `UpdateEndpoint` 的主机 / 端口 / 协议全部由这两个 base 派生。
   以前 base 与 `PRIMARY_HOST` / `FALLBACK_HOST` 是两份副本，改一处漏一处 —— 现在配置里只有两个 base。
3. **`legacyHosts` 里的 `62.106.70.167` 与 `download.primaryBase` 是同一台机器，但语义相反**：
   前者是「旧聊天主机，存过即视为没配过」，后者是「当前分发机」。别因为「这机器已经不在用了」顺手删掉前者。
4. **换分发机之后**：`pnpm check:endpoints` + `pnpm check:ip` + `pnpm check:identity` → 重新打包
   （`pnpm build[:internal]` → `npx cap sync android` → `./gradlew assembleRelease`）。详细步骤见
   [`docs/RELEASE-MANUAL.md`](../docs/RELEASE-MANUAL.md) §13。

### 消费侧 / 支付侧端点：`consume` 与 `pay`（#484 / #487）

> **接口约束正文在 [`docs/sub2api-client-contract.md`](../docs/sub2api-client-contract.md)。**
> 那一份说「客户端**允许**调哪些路径、怎么鉴权、怎么重试」；这一节只说
> 「`config/endpoints.json` 里的这两组字段是什么、谁读、改了要做什么」。

`config/endpoints.json` 新增两组（**不要动**原有的 `download`）：

| 字段 | 含义 | 谁消费 | 改它要重新打包吗 |
| --- | --- | --- | --- |
| `consume.baseUrl` | sub2api 的 base（scheme + host + 可选端口；bundle 里可带路径前缀如 `/staging`）。一个 host 同时承载 `/api/v1`（JWT）与 `/v1`（sk- Key），**也是 `ours` 的推理地址**（#812：推理必须与登录同环境，代码里由 `src/services/api/environment.ts` 的 `inferenceBaseUrl()` 派生，不存在第二个开关） | Web：`__ENDPOINTS__.consume.baseUrl`（构建期注入）→ `src/services/consume/**`；原生：`BuildConfig.CONSUME_BASE` | **要**。地址在构建期被替换进 JS，原生侧进 dex 字符串表，**没有任何热更新通道能改它** |
| `consume.apiV1Prefix` | JWT 通道前缀，默认 `/api/v1` | 消费层拼路径（`baseUrl + apiV1Prefix + …`） | 要（同一次构建） |
| `consume.gatewayPrefix` | sk- Key 通道前缀，默认 `/v1` | 消费层拼路径、`/v1/usage` 与 `/v1/chat/completions` | 要（同一次构建） |
| `consume.timeoutMs.read` / `.write` / `.redeem` | 只读 / 写 / 兑换三档超时（毫秒）。**调用点不许再硬编码毫秒数** | 消费层传输封装 | 要（同一次构建） |
| `pay.baseUrl` | apia 的 base（只负责买：套餐、下单、支付、发卡密、订单查询） | Web：`__ENDPOINTS__.pay.baseUrl` → `src/services/ours/**`；原生：`BuildConfig.PAY_BASE` | **要**（同上） |
| `pay.timeoutMs.read` / `.write` | 支付侧两档超时 | 支付传输封装 | 要（同一次构建） |

**为什么这两组必须分开**（不是风格，是构建期校验项）：`consume` 与 `pay` 是两个职责不同的后端，
`check:endpoints` 的新增校验会把「两者 base 相同」判为 FAIL。合并成一个 base 的那一刻，
「买」和「用」的边界就没了，卡密该进谁的余额也说不清。

**改这两组之前 / 之后必须做的事**

1. 改之前：`consume.baseUrl` 的 host 要同时加进 `allowedHosts`（`check:ip` 的豁免名单），否则
   门禁把新域名判成硬编码地址；`pay.baseUrl` 同理。
2. 改之后：`pnpm check:endpoints` + `pnpm check:ip`（两者都会读这份 JSON）→ 重新打包。
3. **构建期 fail-fast**：base 必须是 `https`；不得命中废弃域黑名单（`140.210.13.146`、`:60013`、旧池域）；
   `consume.baseUrl ≠ pay.baseUrl`；缺字段 / 空值 / 未知键直接中止构建并点名键名与文件行号。
4. staging 明文联调（`http://`，#601 守卫的补正面）：非回环明文默认**仍然中止**；确实要做 staging 联调包时
   **两层一起显式放行** —— `ALLOW_INSECURE_CONSUME=true`（web 构建期）**且**
   `-PallowInsecureConsume=true`（原生构建期），产物会带 `INSECURE_CONSUME=true` 标记（staging-only，
   `verify:apk` 不带 `--allow-insecure` 直接 exit 1）。只认字面 `true`；本 JSON 里的生产值**不许**改。
   完整命令链见 [`docs/RELEASE-MANUAL.md`](../docs/RELEASE-MANUAL.md)「staging 明文联调包」。
5. 灰度 / 临时换地址：**构建期环境变量** `CONSUME_BASE_OVERRIDE=<base>`（支付侧 `PAY_BASE_OVERRIDE`），
   优先级高于这份 JSON、**不落盘**；判据与配置文件**同一套**（https / 回环例外 / 废弃域黑名单 / consume≠pay）。
   然后必须重新 `pnpm build` + `npx cap sync android` —— 地址是在 `pnpm build` 时注入 web 层的。
   ⚠️ **不要用 `-PconsumeBase`**：它只写原生侧 `BuildConfig.CONSUME_BASE`，没有任何 Java/Kotlin 读它，
   web 层照旧打配置里的地址（#651 实测到的「看起来改了、实际仍打生产」）；现在 gradle 会拿
   `assets/public/build-info.json` 里的 `endpoints.consume.baseUrl` 交叉核对，不一致直接 `BUILD FAILED`。
   换 host 的完整步骤（改一行 → 重打包 → 灰度验证 → 回滚）见
   [`docs/RELEASE-MANUAL.md`](../docs/RELEASE-MANUAL.md)「换 sub2api host」。

**状态说明**：这两组字段由 #487 的配置改造落地；本文件只描述契约。
如果 `config/endpoints.json` 里还没有 `consume` / `pay`，说明配置改造尚未合并 —— 此时
`src/services/consume/**` 不应存在（消费层的存在以这两组字段存在为前提）。

---

# 落地补充（W1-A / #487）：`consume` / `pay` 的校验口径与当前取值

> 上面那一节的**契约**已经由 #488 写完，这里只补三件「实现落地后才确定」的事。

| 项 | 落地值 / 口径 |
| --- | --- |
| 当前 `consume.baseUrl` | **`http://127.0.0.1:18000`** —— 本地联调实例（维护者 2026-11-20 明确：联调与 base URL 都以本地实例为准）。**生产 host 待维护者提供**，出正式包前必须换掉 |
| https 规则 | 两个 base 一律 https；**默认唯一例外是本机回环**（`127.0.0.1` / `localhost` / `[::1]`）。非回环的明文 `http://` 仍然中止构建。staging 明文联调包必须**显式**放行（`ALLOW_INSECURE_CONSUME=true` + `-PallowInsecureConsume=true`），产物带 `INSECURE_CONSUME=true` 自证标记且禁止公开分发（#601 / #651） |
| 校验在哪 | `scripts/lib/consumeEndpoints.mjs`（`scripts/build.mjs` 打包前跑）与 `android/app/build.gradle` 的 `[consume]` 段，**同一套判据**；门禁 `pnpm check:consume-api` 再独立跑一遍 |

**一处需要更正上面的说法**：`consume.baseUrl` / `pay.baseUrl` 的 host **不需要**加进 `allowedHosts`。
**#869 更新**：App 只配置一个网关 BASE（`consume.baseUrl`，`pay.baseUrl` 暂时与它相同，等最后一个旧 cardpay 读取方迁走后删除 `pay` 段）。
`allowedHosts` / `allowedPorts` 现在登记两类东西：旧池反馈地址（`feedbackUrl`）与网关域名（`apia.ecsafe.cn`、443）。
原来的「三个端点必须在同一台机器」判据已删除，改成「每个地址的 `主机:端口` 都登记在白名单里，网关不许是裸 IP」。
`consume.baseUrl` 与 `pay.baseUrl` 仍不许相同，**唯一例外**是两者都等于统一网关 BASE（`scripts/lib/consumeEndpoints.mjs` 的
`UNIFIED_GATEWAY_BASE`，`build.gradle` 同口径）。`/staging` 前缀只是兼容入口，新代码不要再写。

其余落地细节（接口白名单、错误信封、幂等规则、字段实测状态）见
[`docs/consume-layer.md`](../docs/consume-layer.md) 与
[`docs/sub2api-client-contract.md`](../docs/sub2api-client-contract.md)。
