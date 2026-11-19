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
| 额度+购买 | 领取 → 刷新 → 兑换 ｜ 套餐 → 前往购买 → 关页刷新额度 | `g07-quota-purchase.test.mjs` | `services/invite/*`、`services/ours/*`（pay-link / transport）、`components/settings/OursServicesDialog.tsx` |
| 诊断 | 触发错误 → 诊断复制内容已脱敏 | `g09-diagnostics.test.mjs` | `services/chat/describe.ts`、`replyErrorReport.ts`、`services/diagnostics/redact.ts`、`app/errorReport.ts` |
| 更新 | 检查 → 解析清单 → 选对版本 → 下载校验 | `g10-update.test.mjs` | `services/updateManifest.ts`、`components/settings/AppUpdateField.tsx` |

对应关系按「**改动落在哪就至少跑那一条**」用，不是穷举：动了 `src/services/chat/` 就跑 G1/G2/G4/G5/G6，
动了设置面板/渠道就跑 G3/G5/G6/G7/G9/G10，动了「我们的服务」（额度/卡密/收款）就跑 G7。
拿不准就 `pnpm run test:golden` 全跑 —— 9 条约 11 秒。

> **两处合并**（Issue #404 允许：「某两域天然同一流程就合成一条」）：
> · **导出 + 导入** → G6：只有把导出的字节真的喂回导入，`manifest` 首条、条目路径、索引与会话的一一对应才被同时钉住；
> · **额度 + 购买** → G7：同一个「我们的服务」弹层、同一套桩后端、用户连着点（领完额度就看能不能买），
>   而「兑换后余额变没变、关掉收款页回没回来」本来就是跨步骤的事实。

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
| 额度 | 领取 → 刷新 → 兑换成功一次（与「购买」合并） | `g07-quota-purchase.test.mjs` | ✅ |
| 购买 | 套餐 → 前往购买（现取 pay-link）→ App 内打开 → 关页刷新额度 | `g07-quota-purchase.test.mjs` | ✅ |
| 诊断 | 触发错误 → 诊断复制内容已脱敏 | `g09-diagnostics.test.mjs` | ✅ |

**购买为什么不是「下单（cid）→ 回跳 → 轮询到卡」**：那条链路已被 #331 整条删除（`startCheckout` /
`pollOrder` / `orderStore` 连函数名都没留）。现行主路径是 `GET /api/plans` 空态 → `GET /api/pay-link`
现取联动小铺收款页 → `Browser.open` 在 App 内打开 → 关页回调刷新额度，**App 侧没有订单、不轮询、
不显示「支付成功」**。G7 按现行链路跑，并额外断言「整条链路没有一条建单/查单/拉套餐请求」——
后端全桩，不产生资金流。

实测（2026-11-20，本机 4 并发，标准产物）：G1 3.3s / G2 3.5s / G3 5.2s / G4 7.5s / G5 4.2s /
G6 3.9s / G7 5.0s / G9 3.4s / G10 3.9s，**墙钟 11.4s**（第二批加入前是 5.7s）。

负向验证（每条都人为破坏一次、确认变红后再还原）：

| 用例 | 破坏方式 | 红在哪一句 |
| --- | --- | --- |
| G3 | `providers.ts` 里 anthropic 的 `auth` 改回 `'bearer'` | 探测/发消息都带不上 `x-api-key` |
| G4 | `store.ts` 的 `removeSessionData` 不再 `db.deleteSession` | 「删除真的落到 IndexedDB（sessions=2）」 |
| G6 | `exportArchive.ts` 不再写 `manifest.json` | 「首条是 manifest.json（实际 chat_sessions/…）」 |
| G7 | 兑换成功后不再 `refreshBalance()` | 「兑换成功后额度自动刷新（期望 450 实际 150）」 |
| G9 | `redact.ts` 跳过值维度脱敏（只留 key 维度） | 「复制内容里没有任何一项敏感值原文（设备码,卡密,手机号）」 |
