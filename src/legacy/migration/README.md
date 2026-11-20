# 老账号额度迁移尾巴（Issue #498）

> **@remove-after 1.6.0** —— 这是一个**临时债**，不是新功能。本目录存在的唯一理由：让老服务下线之后，
> 还留着旧额度的老用户能把这些额度领到新账号（sub2api）里一次。
>
> 目标版本到了（本目录任一文件头部的 `@remove-after` 被 CI 判为过期）就删，删除方法见最后一节。
> 别在这里加需求：这里每多一行，将来删起来就多一行。

## 一句话说清这是什么

老池域（`legacyHosts` 那两台机器）下线后，设备上可能还留着三样线索：旧 `sk-` Key、老设备码、老设备指纹。
登录/注册到新账号之后，客户端**把它们连同当前 JWT 发给迁移服务一次**，由服务端判定「这个老账号还有没有额度、
能不能自动迁移、迁多少」。客户端只负责两件事：**采集** + **发这一次请求**，外加**一个开关**。

- 客户端**不传**目标账号 id（服务端拿 `jwt` 自己去换 `user_id`，传过去的 id 一律不可信）
- 客户端**不做**任何金额换算（老额度 → 元的口径服务端定死）
- 客户端**不缓存**迁移结果，也**不重试**（重试只能由用户点按钮触发）

## 目录里有什么（全部收在本目录 = 好删）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | **唯一对外出口**，只导出两个函数：`collectLegacyIdentity()` / `claimLegacyMigration(token)` |
| `collect.ts` | 从本地存储捞老账号线索；**任一读取失败都不抛**，缺字段就省略 |
| `claim.ts` | POST 一次迁移请求；**超时 / 网络失败不抛**，返回 `{ status:'failed', retryable:true }`；后端字段名与状态名只在这个文件里出现 |
| `types.ts` | `ClaimResult` 六状态判别联合 + `LegacyIdentity` |
| `LegacyMigrationButton.tsx` | 自包含的重试按钮：状态 → 文案 / 能不能再点，全在一处 |
| `README.md` | 本文件 |

对外签名（删这条尾巴时只需确认没有第三个调用方）：

```ts
collectLegacyIdentity(): { oldApiKey?: string; deviceId?: string; deviceFp?: string }
claimLegacyMigration(token: string): Promise<ClaimResult>
```

## 开关：`config/endpoints.json` 的 `migration` 组

```jsonc
"migration": {
  "enabled": false,            // 默认关；服务端也有自己的开关，任一方关掉即不迁
  "baseUrl": "",               // 只有 enabled:true 时才有意义（构建期强制非空 + https）
  "endpoint": "/legacy/claim",
  "timeoutMs": 20000           // 超时只从这里读，源码里没有毫秒字面量
}
```

`enabled !== true` 时**三处都会判**，任一处判到就整条链路不启动：

| # | 位置 | 行为 |
| --- | --- | --- |
| 1 | `claim.ts` 的 `readMigrationConfig()`（**在采集之前**） | 不采集本地槽位、不发请求，直接返回 `failed/retryable:false` |
| 2 | `collect.ts` | 只会被 `claim.ts` 调用；开关关着时根本到不了这里 |
| 3 | `LegacyMigrationButton.tsx` 的 `isMigrationEnabled()` | 直接 `return null`，按钮不渲染 |

注入链路：`config/endpoints.json` → `rspack.config.ts` 的 DefinePlugin（`__ENDPOINTS__.migration`，原文一整组注入）
→ 运行时 `__ENDPOINTS__.migration`。非打包环境（`node --test` / 老壳子）没有这一段，运行时按**关闭**处理，不抛错。

**构建期 fail-fast**：`migration.enabled === true` 但 `baseUrl` 为空 / 不是绝对 URL / 非 https（回环除外）/
`endpoint` 不以 `/` 开头 / `timeoutMs` 不是正整数 → `rspack.config.ts` 的 `assertMigrationConfig()` **直接中止构建**。
理由：运行时对配置的态度是「不合法就当关闭」，开了开关却什么都没发生是查不出来的假红，所以要提前到构建期。

## 安全红线（#498 §六 / #387 同型事故）

1. **`oldApiKey` 是明文凭据**：只允许出现在 `claim.ts` 的**请求体**里。
   不进日志、不进埋点、不进剪贴板、不进 DOM、不进错误文案 —— 本目录**没有任何 console / 上报调用**，
   以后也不要加。
2. 失败信息只用「服务端返回的 `reason`」和「HTTP 状态码」，**绝不拼接请求体里的任何字段**。
   `reason` 会经过 `claim.ts` 的 `readReason()`（去控制字符 + 截断 200 字）再上屏。
3. 传输只走 `CapacitorHttp`：复用 `src/services/consume/http.ts` 的 `capacitorTransport`
   （不用 `createConsumeHttp`，因为那个实例把路径锁在 consume 的两个前缀里，而迁移服务是**另一台后端**）。
   不自己写 `fetch` / `XMLHttpRequest`：sub2api 系的 CORS `allowed_origins` 默认是空数组（#484 §4.6）。
4. 采集失败**不阻断登录**：`claimLegacyMigration` 永不抛，接线点也用 `void` 掉（见下一节）。
5. **不自动重试**：只有用户点按钮才重发一次。

## 接线点（已接线：`src/services/auth/store.ts` 的 `applySession()`）

W1-B 的 `src/services/auth/store.ts` 已在 main 上（#499）。它把「登录成功」收在一个函数里：
`applySession(session)` —— `signIn()` 与 `signUp()` 成功后**都**走它，而启动恢复 `restoreAuth()` 不走。
所以「登录 / 注册成功后调用一次」的落点就是它，本单在这里加了 3 行（外加 1 行 import）：

```ts
import { claimLegacyMigration } from '../../legacy/migration/index.js'   // ← 删这条尾巴时一起删

const applySession = (session: AuthSession): void => {
  …既有落盘 + setState…
  // 老账号额度迁移（#498 的临时尾巴，@remove-after 1.6.0）：登录 / 注册成功后**只发一次**。
  try { void claimLegacyMigration(session.token.accessToken) } catch { /* 迁移永不影响登录 */ }
}
```

三条理由写在这里，免得下一个人「顺手补个 await」：

1. **`void` 掉**：登录成功的路径上多一个 `await` 就等于「迁移慢了，登录就慢」；
2. **再包一层 try/catch**：`void` 一个会抛的 Promise 会变成 unhandled rejection（整页红屏）；
   `claimLegacyMigration` 自身保证不抛，这层是双保险；
3. **只在这里调用一次**：`applySession` 只被 `signIn` / `signUp` 调用，启动恢复不走它，
   所以「每次启动又发一遍」不会发生；重复登录时服务端按老账号标识幂等，最多回 `already_migrated`。

**结果怎么给 UI**：现在这一行把返回值丢掉了（返回值丢了不影响契约：`already_migrated` 由服务端兜底，
按钮只要「在用户点的时候再问一次」就够）。要显示「历史额度已迁移：¥X」的话，把 `void` 换成
`void claimLegacyMigration(...).then((result) => useAuthStore.setState({ migrationResult: result }))`
或存进任意登录态 store，然后把结果作为 `<LegacyMigrationButton initial={…} />` 传进去。

## 按钮怎么挂（本单没有挂载）

组件是自包含的，按路径直接 import 即可（**不走** `index.ts` 的出口，那个出口只放两个函数）：

```tsx
import { LegacyMigrationButton } from '../legacy/migration/LegacyMigrationButton.js'

// 账户 / 消费页（W1-C 正在写的那一片）里，放在「额度」卡片下面：
<LegacyMigrationButton
  initial={migrationResult}          // 登录后那次调用的结果；没有就省略 = 按「可迁移」显示
  getToken={() => session?.accessToken}
/>
```

渲染规则（组件里 `viewOf()` 一处收口，与 #498 §四 的表一一对应）：

| 结果 | 界面 |
| --- | --- |
| 还没跑过 / `failed` + `retryable:true` | 按钮「迁移历史额度」，可再点 |
| `migrated` | 「历史额度已迁移：¥X」（按 `currency` 选符号） |
| `already_migrated` + 金额 > 0 | 什么都不渲染（**永久**） |
| `already_migrated` + 金额 0 / 缺省 | 「已迁移过，如未到账请联系客服」+「仍要迁移」（手动，不自动调用） |
| `no_legacy` | 什么都不渲染（静默） |
| `need_manual` | 「如需迁移历史额度，请联系客服」（**永不出现重试**） |
| `expired` | 「额度迁移已结束」（**永不出现重试**） |
| `failed` + `retryable:false` | 「迁移失败（原因）」（**永不出现重试**） |

换账号时请给组件换 `key`（它把 `initial` 当初始值读，之后自己维护重试结果）。

## 后端真实契约（已按实测对齐 `sub2api-private@8b12ab2`）

后端：`felix4396/sub2api-private@8b12ab2`，实现 `tools/kunming-migration/legacy-sync/server.py`，
端口 `60016`，端点 `POST /legacy/claim`。改动**全部落在 `claim.ts` 的两个函数里**：

| 函数 | 管什么 | 对齐了什么 |
| --- | --- | --- |
| `toBackendPayload(identity, jwt)` | 本地线索 → 请求体。**唯一**出现 `oldApiKey` / `deviceId` / `deviceFp` / `jwt` 这些键名的地方 | 入参四项名不变，`jwt` 放 body（后端确认 body 优先） |
| `fromBackendResult(body)` | 响应体 → `ClaimResult`。**唯一**认识状态名 / 金额字段 / 枚举外状态的地方 | 金额 `{amount, currency, balance}`；枚举外状态归一 |

四条实测出来的边界（每条都写进了代码注释，别「顺手简化」）：

1. **金额是 `{amount, currency:"CNY", balance}`，单位是元**（100 积分 = 1 元，1:1 搬运，**不做换算**）。
   界面按 `currency` 选符号（`CNY` → `¥`），**不硬编码 `$`**；`balance` 不用。
2. **业务失败一律 `200`，从不回 `401`** → `claim.ts` **先看 body 的 `status`，再看 HTTP 状态码**。
   靠状态码判成败会把 `need_manual` / `already_migrated` 误当成网络错误。只有 body 里没有 `status`
   （反代把自己的错误页塞进 4xx/5xx）时才回落到状态码判定。
3. **有枚举外状态**：后端会回 `unauthorized`（jwt 无效）、`upstream_error`（上游异常，**不带 `retryable`**）。
   客户端**一律归成 `failed + retryable:false`**（不崩、不当成功、不重试），`reason` 固定为
   `unknown_status`——不把后端内部状态名端给用户看。
4. **`already_migrated` 的金额可能是 0**：后端 `legacy_sync_log` 上有 `UNIQUE(sub2api_user_id)`，
   用户认领**第二个**老账号时会回 `{status:"already_migrated", amount:0.0}` 而**那个账号根本没迁**。
   所以「金额 > 0」才算真的到账：金额 0 / 缺省 → 显示「已迁移过，如未到账请联系客服」+ 一个
   「仍要迁移」按钮（**不自动调用**，只有用户点才发），绝不永久隐藏。

其它两条（不变）：

- **`deviceId` 只做一致性校验**：后端只把 `oldApiKey` 当持有证明（没有它一律 `need_manual`），
  `deviceId` 与老账号不匹配时**直接拒绝** → 客户端收到 `failed` + `retryable:false` +
  `reason:"device_mismatch"`，显示「设备信息不匹配，请联系客服」，**不给重试**；
- **`need_manual` 文案通用**（「如需迁移历史额度，请联系客服」）—— 刻意不区分「没有旧 Key」和
  「Key 无效」，避免把这里变成一个「这把 Key 存不存在」的探测接口。

传输：后端 `OPTIONS` 返回 **501 且无 CORS**，浏览器端调不通 → 必须走原生 `CapacitorHttp`
（我们本来就是这么做的：`services/consume/http.ts` 的 `capacitorTransport`，**别改成 `fetch`**）。

以后后端再改协议：**只改这两个函数**，其余文件（含界面、接线点）一行都不用动。

## 删除方法（目标版本 1.6.0）

四步，全部机械可查：

1. **删本目录**：`git rm -r src/legacy/migration/`（连带 `LegacyMigrationButton.tsx` 的挂载点一起删）；
2. **删两处调用**：
   - `src/services/auth/store.ts` 的 `applySession()` 里那 3 行 `try { void claimLegacyMigration(…) } catch {…}`
     **和文件顶部的 `import { claimLegacyMigration } from '../../legacy/migration/index.js'`**；
   - 账户/消费页里 `<LegacyMigrationButton …/>` 的挂载及其 import；
3. **删配置与注入**：`config/endpoints.json` 的 `"migration"` 组 +
   `rspack.config.ts` 的 `assertMigrationConfig()` 与 DefinePlugin 里的 `migration: endpoints.migration,` 一行 +
   `src/env.d.ts` 里 `__ENDPOINTS__.migration` 那段声明；
4. **关配置**（下线当天的第一步）：把 `migration.enabled` 改成 `false` 并重新出包——
   这一步不需要改任何代码，也不依赖新版本先铺开；老版本客户端则由**服务端**自己的开关 + `expired` 兜底。

文案：本目录用了 8 条 `legacyMigrate*`（`Title` / `Done` / `Manual` / `Expired` / `Failed` / `DeviceMismatch` /
`AlreadyUnsettled` / `RetryAnyway`），
删的时候一起从 `src/i18n/zh.ts` 与 `src/i18n/en.ts` 删掉（成对删，`check:i18n` 会核对两边 key 集合相等）。

## 验收自查（本单交付时跑过）

```bash
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8
node -e "JSON.parse(require('fs').readFileSync('config/endpoints.json'))"   # 配置仍是合法 JSON
npx tsc -p tsconfig.json && npx oxlint src rspack.config.ts                  # 类型 + lint
node tests/run-layer unit                                                     # 单测层（本单不写新用例）
node scripts/check-i18n.mjs                                                   # 文案成对 + 无新增孤立 key
pnpm run check:endpoints && pnpm run check:consume-api                        # 地址零副本 / 路径白名单
```
