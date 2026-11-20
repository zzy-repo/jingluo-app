# 黄金回归套件（Issue #404）

**每域 1 条主路径**，真实 `dist` 产物 + 真浏览器 + stub 后端，单条 ≤60s、整层 ≤5 分钟，并行跑。
它是 PR 反馈链路上的**第一道功能防线**：L0（unit，~1 分钟）测不到「用户真实路径被打断」，
L1（integration，7~20 分钟）太慢不能每次都等。

```bash
pnpm run build          # 需要标准产物（dist，variant=standard）
pnpm run test:golden    # = node tests/run-golden.mjs（并行 + 每条耗时 + 一句话失败定位）
```

## 「改了哪个域必须跑哪条」——提交前对照这张表

| 域 | 黄金路径 | 用例 | 覆盖到的源码（大致） |
| --- | --- | --- | --- |
| 启动 | 冷启动 → 会话列表渲染 → 打开最近会话 | `g01-startup.test.mjs` | `services/chat/store.ts`、`db.ts`、`components/sider/*` |
| 对话 | 发送 → 流式接收 → 停止 → 重新生成 | `g02-chat.test.mjs` | `services/chat/*`（stream / stop / regenerate）、`components/chatInput/*`、`components/messages/*` |
| 渠道 | 切渠道 → Key 校验 → 发一条消息成功 | `g03-channel.test.mjs` | `services/api/providers.ts`、`apiConfig.ts`、`components/settings/ApiConfigFields.tsx` |
| 会话 | 新建 → 重命名 → 置顶 → 删除 → 回空态 | `g04-session.test.mjs` | `services/chat/store.ts`（CRUD/pin）、`components/sider/*` |
| 导入 | 链接导入：manifest → 下载 → 解析 → 入库 | `g05-import.test.mjs` | `services/chat/history/urlImport.ts`、`importArchive.ts`、`backup.ts` |
| 导出+导入 | 导出 → 校验包结构 → 可再次导入 | `g06-export-import.test.mjs` | `services/chat/backup.ts`、`history/exportArchive.ts`、`zipWriter.ts`、`components/settings/SettingsDialog.tsx`（导出/上传） |
| 诊断 | 触发错误 → 诊断复制内容已脱敏 | `g09-diagnostics.test.mjs` | `services/chat/describe.ts`、`replyErrorReport.ts`、`services/diagnostics/redact.ts`、`app/errorReport.ts` |
| 更新 | 检查 → 解析清单 → 选对版本 → 下载校验 | `g10-update.test.mjs` | `services/updateManifest.ts`、`components/settings/AppUpdateField.tsx` |
| 账户与消费 | JWT 登录 → 读余额 → 兑换卡密 → 余额变化（+ 冷启动续期）；mock 驱动 | `g12-consume.test.mjs` | `services/auth/{store,transport}.ts`、`services/consume/{auth,usage,redeem}.ts` |

对应关系按「**改动落在哪就至少跑那一条**」用，不是穷举：动了 `src/services/chat/` 就跑 G1/G2/G4/G5/G6，
动了设置面板/渠道就跑 G3/G5/G6/G9/G10（`g11` 邮箱见 `tests/golden/g11-email.test.mjs`）。
拿不准就 `pnpm run test:golden` 全跑 —— 10 条约 12 秒（g12 单独约 0.9s，自带 mock，不需要 dist）。

> **额度 / 卡密 / 购买的黄金回归已删除（W1-D，#487）**：`g07-quota-purchase.test.mjs` 跟着旧额度/邀请体系
> 一起删了 —— 它断言的「领取 → 刷新 → 兑换」走的是 `device_id` + 本机池那条即将整体替换的链路，
> 重构期间维护它只会产生假红。新链路（JWT + sub2api 消费层）落定后按 #487 阶段③重建，
> 清单与重建要求见 `docs/testing/rebuild-after-refactor.md`。

> **两处合并**（Issue #404 允许：「某两域天然同一流程就合成一条」）：
> · **导出 + 导入** → G6：只有把导出的字节真的喂回导入，`manifest` 首条、条目路径、索引与会话的一一对应才被同时钉住；
> · （原「额度 + 购买」合并成 G7 的那条已随 W1-D 删除，见上。）

### g12「账户与消费」为什么是 mock 驱动、而不是 dist + 浏览器

新链路（JWT 身份层 + 四个消费面板）**还没有页面外壳**：`src/main.tsx` 尚未挂 `AuthGate`，
账户页（W1-C1）未合并，所以 dist 里点不到登录 / 兑换入口。这一条因此把**链路**端到端跑通：
真 `createConsumeClient` / `createAuthTransport` / `store`，对面是 `tools/mock-sub2api`（端口 0，
内核分配；不连 127.0.0.1:18000 的真实例，用例结尾有「所有请求都落在本次 mock 上」的守卫）。
两条路径：① 登录 → 读余额 → 兑换 `MOCK-OK-0001` → 余额 +10；② 冷启动过期 → 续期换新 token → 仍能读余额。
等页面外壳合并后，把「调客户端」换成「点按钮」即可，步骤名与断言不用改。

## 与 L1 的分工（硬要求）

黄金套件**只测「主路径没断」**，不重复断言 L1 已覆盖的细节分支。判据：

> 一条断言如果删掉它，`tests/integration/` 里还有别的用例会因为同一处坏掉而变红 → 它不该出现在这里。

所以这里**故意不测**：列表读失败的重试、首字未到就停止、连点三次重新生成、置灰态、
清单校验的每一条失败分类、导入包的各种损坏形态……那些都在
`tests/integration/domain01-session-load.test.mjs`、`domain02-stop-regenerate.test.mjs`、
`url-import-native.test.mjs`、`domain10-update-check-flow.test.mjs` 里，改它们时跑 L1。

## 写法约定

- 装配全在 `tests/helpers/golden.mjs`：`serveGoldenApp()`（缺产物**直接红**，不像 L1 那样 SKIP(env)）、
  `openGoldenPage()`（清 storage + 预置键 + reload，可选 `initScripts` 打桩原生桥）、`waitFor/waitForText`。
- 每条用例用 `runGolden({ id, domain, title }, async (ctx) => …)` 包起来：
  - `ctx.begin('步骤名')` 标当前步骤（异常与耗时都挂在这一步）；
  - `ctx.expect(步骤, 条件, { expected, actual })` 记一条断言；
  - `ctx.abort(步骤, expected, actual)` 用于「后面必然连带失败」的前置条件（避免一次改动刷出十条红字）。
- 失败行必须是**一句话**：`✗ G1 启动 · 会话列表渲染 · 期望=3 条 · 实际=0 条`。
- 后端一律 stub：SSE 用 `tests/fixtures/domain01-02/mock-upstream.mjs`，原生 HTTP 桥在用例里用
  `addInitScript` 打桩，发布清单用 `context.route` **两台分发机都拦**。不连真实服务。

## 预算（run-golden.mjs 机械执行，不靠人记）

- 单条 ≤60s：超时即杀，判 `TIMEOUT`（= 红）。
- 整层 ≤5 分钟：墙钟超预算直接 exit 1。
- 退出码：任一条红 → 1，参数/环境错误 → 2。

实测（2026-11-20，本机 4 并发）：9 条全部 PASS，**墙钟 11.4s**（逐条耗时见文末「第二批」）。

## 第二批（已完成：剩余 6 域 → 5 条）

第一批做了 4 个最容易改坏的域（启动 / 对话 / 导入 / 更新），第二批补齐剩余 6 域（5 条，两处合并见上）：

| 域 | 黄金路径 | 用例 | 状态 |
| --- | --- | --- | --- |
| 渠道 | 切渠道 → Key 校验 → 发一条消息成功 | `g03-channel.test.mjs` | ✅ |
| 会话 | 新建 → 重命名 → 置顶 → 删除 → 回空态 | `g04-session.test.mjs` | ✅ |
| 导出 | 导出 → 校验包结构 → 可再次导入（与「导入」合并成往返） | `g06-export-import.test.mjs` | ✅ |
| 诊断 | 触发错误 → 诊断复制内容已脱敏 | `g09-diagnostics.test.mjs` | ✅ |

**购买/额度这条为什么现在没有黄金用例**：`g07-quota-purchase` 已随 W1-D 删除（见上）。它当时钉的是
「领取 → 刷新额度 → 兑换 +300 → 关收款页再刷新」这条**旧链路**（`device_id` + `/apply` `/me` +
本机池 `/redeem-card` + apia `GET /api/pay-link`）。重构后应由新链路的一条用例替代：
`settings/public` → JWT 登录 → `GET /v1/usage` 额度 → `POST /api/v1/redeem` 兑换 → apia pay-link 购买。

实测（2026-11-20，本机 4 并发，标准产物）：G1 3.3s / G2 3.5s / G3 5.2s / G4 7.5s / G5 4.2s /
G6 3.9s / G9 3.4s / G10 3.9s，**墙钟 11.4s**（第二批加入前是 5.7s；G7 5.0s 那一行随 W1-D 删除）。

负向验证（每条都人为破坏一次、确认变红后再还原）：

| 用例 | 破坏方式 | 红在哪一句 |
| --- | --- | --- |
| G3 | `providers.ts` 里 anthropic 的 `auth` 改回 `'bearer'` | 探测/发消息都带不上 `x-api-key` |
| G4 | `store.ts` 的 `removeSessionData` 不再 `db.deleteSession` | 「删除真的落到 IndexedDB（sessions=2）」 |
| G6 | `exportArchive.ts` 不再写 `manifest.json` | 「首条是 manifest.json（实际 chat_sessions/…）」 |
| G9 | `redact.ts` 跳过值维度脱敏（只留 key 维度） | 「复制内容里没有任何一项敏感值原文（设备码,卡密,手机号）」 |
