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
- 客户端**不做**任何金额换算（老额度 → USD 的口径服务端定死）
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

## 接线点（**本单没有接线，待 W1-B 合并后接**）

`src/services/auth/store.ts` 在本分支（`origin/main` = `e9c298a`）里**还不存在** —— 登录态由 W1-B 在建，
按维护者定的顺序（先代码 → 再验收 → 后测试），本单**不碰**那个文件。等 W1-B 落地后，在它「登录 / 注册成功、
access token 已经写进 store」的那一行**后面**加这三行（一行调用 + 一个 try/catch）：

```ts
// 老账号额度迁移（#498 尾巴）：只发一次，失败静默，绝不阻断登录
try { void maybeMigrateAfterAuth(token) } catch { /* 迁移永不影响登录 */ }
```

其中 `maybeMigrateAfterAuth` 就是下面这段薄包装（放哪都行，只要别放进 `src/legacy/migration/` 以外的新文件里
—— 它属于接线点，不属于这条尾巴）：

```ts
import { claimLegacyMigration } from '../legacy/migration/index.js'

const maybeMigrateAfterAuth = async (token: string): Promise<void> => {
  await claimLegacyMigration(token)   // 自己保证不抛；结果交给 UI 决定要不要显示按钮
}
```

**为什么是 `void` + try/catch**：登录成功的路径上多一个 `await` 就等于「迁移慢了，登录就慢」；
而 `void` 掉一个会抛的 Promise 会变成 unhandled rejection（整页红屏）。两层都要有。

**结果怎么给 UI**：`claimLegacyMigration` 的返回值不要丢。两种接法都行，接线方任选其一：

- 存进登录态 store（例如 `migrationResult` 字段），账户页读它渲染按钮——推荐，重挂不丢；
- 或直接 `createPortal` 到当前页面的一个容器里。

本单**不改** `src/services/auth/**`、`src/components/consume/**`、`src/services/consume/**`、`ci.yml`。

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
| `already_migrated` | 什么都不渲染（**永久**） |
| `no_legacy` | 什么都不渲染（静默） |
| `need_manual` | 「如需迁移历史额度，请联系客服」（**永不出现重试**） |
| `expired` | 「额度迁移已结束」（**永不出现重试**） |
| `failed` + `retryable:false` | 「迁移失败（原因）」（**永不出现重试**） |

换账号时请给组件换 `key`（它把 `initial` 当初始值读，之后自己维护重试结果）。

## 后端真实契约（已对齐 `sub2api-private@8b12ab2`）

后端：`felix4396/sub2api-private@8b12ab2`，实现 `tools/kunming-migration/legacy-sync/server.py`，
端点 `POST /legacy/claim`。本 PR 已按它对齐，**改动全部落在 `claim.ts` 的两个函数里**：

| 函数 | 管什么 | 这次改了什么 |
| --- | --- | --- |
| `toBackendPayload(identity, jwt)` | 本地线索 → 请求体。**唯一**出现 `oldApiKey` / `deviceId` / `deviceFp` / `jwt` 这些键名的地方 | 入参四项名不变（后端确认 `jwt` 放 body，body 优先） |
| `fromBackendResult(body)` | 响应体 → `ClaimResult` 六状态。**唯一**认识后端状态名 / 金额字段的地方 | 金额从 `usdAmount`（美元）改成 `{ amount, currency }`（**元**，`100 积分 = 1 元`，币种当前是 `CNY`） |

对齐后的三条语义（都只在这两个函数 / `types.ts` 里体现，调用点不受影响）：

1. **金额按币种显示**：`ClaimResult` 带 `amount?` + `currency?`，界面按币种选符号（`CNY` → `¥`），
   **不硬编码 `$`**，也不做任何换算。
2. **状态机不变**：`migrated` / `already_migrated` / `no_legacy` / `need_manual` / `expired` / `failed`（+`retryable`）。
3. **`deviceId` 只做一致性校验**：后端只把 `oldApiKey` 当持有证明（没有它一律 `need_manual`），
   `deviceId` 与老账号**不匹配时直接拒绝** → 客户端收到 `failed` + `retryable:false` + `reason:"device_mismatch"`，
   显示「设备信息不匹配，请联系客服」，**不给重试**。

`need_manual` 的文案是**通用**的（「如需迁移历史额度，请联系客服」）—— 刻意不区分「没有旧 Key」和
「Key 无效」，避免把这里变成一个「这把 Key 存不存在」的探测接口。

以后后端再改协议：**只改这两个函数**，其余文件（含界面、接线点）一行都不用动。

## 删除方法（目标版本 1.6.0）

四步，全部机械可查：

1. **删本目录**：`git rm -r src/legacy/migration/`（连带 `LegacyMigrationButton.tsx` 的挂载点一起删）；
2. **删两处调用**：
   - 登录/注册成功后那三行 `try { void maybeMigrateAfterAuth(token) } catch {…}`（在 `src/services/auth/store.ts`，
     W1-B 合并后才存在）；
   - 账户/消费页里 `<LegacyMigrationButton …/>` 的挂载及其 import；
3. **删配置与注入**：`config/endpoints.json` 的 `"migration"` 组 +
   `rspack.config.ts` 的 `assertMigrationConfig()` 与 DefinePlugin 里的 `migration: endpoints.migration,` 一行 +
   `src/env.d.ts` 里 `__ENDPOINTS__.migration` 那段声明；
4. **关配置**（下线当天的第一步）：把 `migration.enabled` 改成 `false` 并重新出包——
   这一步不需要改任何代码，也不依赖新版本先铺开；老版本客户端则由**服务端**自己的开关 + `expired` 兜底。

文案：本目录用了 6 条 `legacyMigrate*`（`Title` / `Done` / `Manual` / `Expired` / `Failed` / `DeviceMismatch`），
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
