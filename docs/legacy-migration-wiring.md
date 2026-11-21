# 老账号额度迁移（#498）接线核查：这条链路现在通不通

> 2026-11-21 实测一次，回答一个具体问题：**「登录后把老设备线索发到迁移地址」这条链路，
> 在 #608（拆登录墙）、#727（登录卡改 `SettingsAuthCard`）、#740（401 单飞刷新）几轮重构之后
> 还有没有接在登录成功上。**
>
> 一句话结论：**代码链路完好，没有被任何一轮重构打断**；出厂配置里开关是**关的**
> （`config/endpoints.json` 的 `migration.enabled: false`，自 #503 起从未打开），所以线上
> 一条请求都不会发 —— 这是设计，不是坏。唯一的「从未接上」是**指纹**一项（见 §六）。
> 下次再怀疑「迁移是不是又被改坏了」，照 §七 的三条命令自查，不要重新设计。

## 一、这条链路由哪几段组成（唯一的调用点）

| 段 | 位置 | 谁在调 / 什么时候 |
| --- | --- | --- |
| 触发点 | `src/services/auth/store.ts:257` | `applySession(session)` 的最后一行：`try { void claimLegacyMigration(session.token.accessToken) } catch {}` |
| 为什么是这里 | `src/services/auth/store.ts:242` | `signIn()` 与 `signUp()` 成功后**都**走 `applySession`；启动恢复 `restoreAuth()` **不走它** —— 所以「每次启动又发一遍」在结构上不可能 |
| 登录卡（#727 之后） | `src/components/consume/SettingsAuthCard.tsx:101`（登录）/ `:109`（注册） | 卡片直接调 `useAuthStore` 的 `signIn` / `signUp`，**没有自己的一套请求**，所以 #727 改版没有绕开触发点 |
| 采集 | `src/legacy/migration/collect.ts:74` | `collectLegacyIdentity()`：读 `chat-demo:api-key`、`chat-demo:ours-device-id`、`chat-demo:ours-device-fp`，缺哪个省哪个，永不抛 |
| 发请求 | `src/legacy/migration/claim.ts:236` | `claimLegacyMigration(token)`：`POST {baseUrl}/legacy/claim`，只发一次、不重试、永不抛 |
| 开关 | `config/endpoints.json:38` | `migration: { enabled: false, baseUrl: "", endpoint: "/legacy/claim", timeoutMs: 20000 }` |
| 注入 | `rspack.config.ts:498` | DefinePlugin 把整组 `endpoints.migration` 注入成 `__ENDPOINTS__.migration`（`enabled:true` 且 `baseUrl` 空 / 非 https 会在**构建期**中止，见 `assertMigrationConfig`） |
| 传输 | `src/services/consume/http.ts:161` | 复用 `capacitorTransport`（原生 `CapacitorHttp`）。**非原生环境**（浏览器 / 预览页）它直接返回 `unsupported` → `failed/retryable:false`，不发请求 |

`grep -rn "claimLegacyMigration\|collectLegacyIdentity\|legacy/claim"` 的完整命中面：
`claimLegacyMigration` 只有两个调用方 —— `src/services/auth/store.ts:257`（真接线）与
`LegacyMigrationButton.tsx`（用户手点重试，**本单没有挂载点**，见 §六）；
`collectLegacyIdentity` 只被 `claim.ts` 调；`legacy/claim` 只出现在 `claim.ts` 的
`DEFAULT_ENDPOINT`、`config/endpoints.json` 与文档里。

## 二、请求契约（实测，不是照抄文档）

`POST {migration.baseUrl}/legacy/claim`，`content-type: application/json`，
body **只有四个字段**（`claim.ts` 的 `toBackendPayload()` 是唯一拼装点）：

```json
{ "jwt": "<sub2api access token>", "oldApiKey": "sk-…", "deviceId": "d-…", "deviceFp": "<64 位十六进制>" }
```

- **没有 `email`**：后端不用客户端给邮箱 —— 它拿 `jwt` 换 `user_id`，再从 `/auth/me` 里取邮箱
  写进 `legacy_sync_log.email`（后端 `sub2api-private` 仓库的 legacy-sync 服务，入参就四个：
  `oldApiKey` / `deviceId` / `deviceFp` / `jwt`）。**客户端不要自己加 email**，
  加了也只是被忽略，反而给「客户端能决定迁移到哪个账号」留了想象空间。
- **没有 `Authorization` 头**：`jwt` 只放在 body（契约要求 body 优先），两处身份来源不打架。
- 没采集到的字段**整键不出现**（`JSON.stringify` 丢 `undefined`），绝不拿空串 / 占位冒充「有」。
- `deviceId` **不是凭据**：后端只把它当一致性校验（给了就必须和老账号对得上，否则
  `failed + device_mismatch`，不给重试）；只有 `oldApiKey` 是持有证明 —— 没有它一律
  `need_manual`。这一条是 #498 §3.2 / #395 的历史结论，代码与后端都照它写。

## 三、git 证据：什么时候被谁改过

```text
$ git log -S "claimLegacyMigration" --oneline
23ec1c58 docs+fix(consume): #676 契约逐节核对表 + 修正路径/字段不符项 (#688)
553cdddc feat(legacy): 老账号额度迁移尾巴（一个开关 + 一次调用，@remove-after 标注）（#498） (#503)

$ git log -S "legacy/claim" --oneline
23ec1c58 docs+fix(consume): #676 契约逐节核对表 + 修正路径/字段不符项 (#688)
553cdddc feat(legacy): 老账号额度迁移尾巴（一个开关 + 一次调用，@remove-after 标注）（#498） (#503)
```

- `553cdddc`（#503）一次落地：模块 + 开关 + **接线点那 3 行**（`git blame` 显示
  `src/services/auth/store.ts:254-257` 全部来自这个 commit）。
- `23ec1c58`（#688）只改**文档与两处映射函数**（`/auth/me` → `/user/profile` 那一批），
  没动接线点。
- 之后的三轮大改**都没有碰过这个符号**：
  `40b08144`（#608 拆登录墙）、`6d2be0ed`（#727 账户与消费页重构）、
  `eaea0dc9`（#740 401 单飞刷新）都不在 `-S` 命中里；`git log -- src/services/auth/store.ts`
  只有四个 commit，`#503` 之后的 `#740` 是在它旁边加 `sessionEpoch`，那 3 行原样保留。

换句话说：**「怀疑被改坏」这件事，git 层面没有证据**。真正没跑起来的原因只有一个 —— 开关关着。

## 四、运行时证据（2026-11-21，headless Chromium + 原生桥桩）

环境：`/root/wt-migrate`（`origin/main` @ `05fb9669`）起 dev server
`npx rspack serve --port 8101 --host 100.113.135.55`；测试账号 `2067922098@qq.com`（真登录，
真打 staging `https://apia.ecsafe.cn/staging`）；本地把 `migration.baseUrl` 指向
`http://127.0.0.1:60017`（回环，`readMigrationConfig` 允许的唯一 http 例外）桩住迁移服务并把
请求原文落盘。

浏览器里必须打**原生桥桩**（与 `scripts/shot-mobile.mjs` / `tests/golden/g16` 同一套配方）：
`Capacitor.isNativePlatform()` 在浏览器里为假，`capacitorTransport` 会直接返回 `unsupported`，
一个请求都发不出去 —— 这不是迁移的毛病，是「sub2api 系 CORS 只能走原生」的既定口径。

| 场景 | `migration.enabled` | 发往 `/legacy/claim` 的请求 | 说明 |
| --- | --- | --- | --- |
| 登录成功 | `false`（出厂值） | **0 条** | 开关在**采集之前**就返回，连本地槽位都不读 |
| 登录成功 | `true` | **1 条**，`POST …/legacy/claim` | 见下方原文 |
| 登录成功后再刷新页面 | `true` | **+0 条** | 刷新走 `restoreAuth`，它不调 `applySession` → 不会「每次启动发一遍」 |
| 只填 Key（未登录） | `true` | **0 条** | 没登录就没有 JWT，触发点根本没跑到 |
| 密码错（登录失败） | `true` | **0 条** | `applySession` 只在 `result.ok` 之后调；界面照常显示「账号或密码错误」 |

抓到的请求（方法 / URL / body 键名 / 返回）：

```text
POST http://127.0.0.1:60017/legacy/claim
content-type: application/json          authorization: (null)
body keys = ["jwt", "oldApiKey", "deviceId", "deviceFp"]
body = {"jwt":"<…>","oldApiKey":"sk-leg…old","deviceId":"d-0123…cdef","deviceFp":"a1b2…8f90"}
→ 200 {"status":"migrated","amount":12.34,"currency":"CNY","balance":100}
```

桩服务侧只收到**一次**（`/tmp/migration-requests.jsonl` 一行），与「只调一次、不自动重试」一致。

## 五、为什么默认关（`migration.enabled: false`）

`git log -p -- config/endpoints.json` 显示这一段是 #503 一次写进 `enabled:false / baseUrl:""`，
**此后没有被打开过**。四条理由（也都是当初写进去的理由）：

1. **迁移窗口由后端决定，不由客户端猜**：老服务下线、老额度冻结之后才有得迁；客户端提前打开
   等于让每次登录都去打一台还没就位的服务。后端自己也有总开关（`LEGACY_SYNC_ENABLED` 默认关）
   与 `MIGRATION_DEADLINE` 窗口 —— 两端都要显式打开才会真的迁，这是「任一方关掉即不迁」的意图。
2. **baseUrl 还没定**：`enabled:true` 时构建期强制 `baseUrl` 非空且必须 https（回环除外），
   现在 `baseUrl: ""`。地不地址不定就打开，出包会直接被 `assertMigrationConfig()` 拦下 ——
   这是故意的：宁可构建失败，也不要「开了开关却什么都没发生」的假红。
3. **`oldApiKey` 是明文凭据**：开关一开，每次登录都会把本机残留的旧 `sk-` Key 发到迁移服务。
   这条数据流的方向必须由维护者显式同意（迁移服务是我们自己的另一台后端，不是 consume 那台）。
4. **staging 数据不作数**：`docs/consume-676-contract-audit.md` 已经写明 —— staging 没有老账号
   要迁，需要迁移老用户时再一起做「挂载点 + https base + 探活」三件事。

要验「打开之后真的会发」，把 `enabled` 设 `true`、`baseUrl` 设成迁移服务地址即可（本地联调用回环），
验完改回 `false`；不要在默认档里留 `true`。

## 六、已知缺口（都不是这几轮重构造成的，是 #503 起就写明的取舍）

1. **指纹一项从未接上（唯一真的「从未接上」）**：`collect.ts:35` 读的是缓存位
   `chat-demo:ours-device-fp`，而**全仓没有任何写入方**（`grep -rn "ours-device-fp" src/` 只有这
   一处读）。所以生产请求里 `deviceFp` 通常**不存在**。为什么不在采集时现算：本仓库的指纹
   （`services/invite/fingerprint.ts` 的 `resolveDeviceFp()`）是**异步**的、且 #395 明确禁止拿
   常量 / 全零 / 占位冒充指纹；采集层是同步 API（`collectLegacyIdentity(): LegacyIdentity`）。
   后端把 `deviceFp` 当**仅记录**（不一致也不影响迁移判定），所以这个缺口不影响「能不能迁」。
   真要补：在登录成功后 `await resolveDeviceFp()` 并把结果写进该缓存位（写入方放在那个文件里，
   而不是改采集层签名）。
2. **`LegacyMigrationButton` 没有挂载点**：结果被 `void` 掉，界面不显示「历史额度已迁移：¥X」，
   `already_migrated` 金额 0 的「仍要迁移」入口也不存在。README「按钮怎么挂」一节写着怎么挂
   （账户/消费页，额度卡片下面）；#498 的口径本身就是「客户端只留一个开关 + 一次调用」，
   所以这是**待挂**，不是坏。
3. **零自动化覆盖**：`grep -rn "claimLegacy\|legacy/claim" tests/` 一条都没有。所以「被重构改坏」
   这类事只能靠 §四 那种手工取证发现 —— 这也是这次要留这份文档的原因。

## 七、下次怀疑它坏了：三条命令

```bash
grep -rn "claimLegacyMigration" src/            # 触发点还在不在 store.ts 的 applySession 里
git log -S "claimLegacyMigration" --oneline      # 哪次改动碰过它（本次：只有 #503 / #688）
node -e "console.log(require('./config/endpoints.json').migration)"   # 开关是开是关
```

三条都符合预期（调用点在 `applySession` 里 + 没有被新 commit 碰过 + 开关状态是你以为的那个）
还发不出请求，再往下查两处：`__ENDPOINTS__.migration` 有没有被注入（构建产物里搜 `migration`），
以及当前是不是**非原生环境**（`capacitorTransport` 在浏览器里恒返回 `unsupported`）。
