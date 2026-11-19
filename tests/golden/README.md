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
| 导入 | 链接导入：manifest → 下载 → 解析 → 入库 | `g05-import.test.mjs` | `services/chat/history/urlImport.ts`、`importArchive.ts`、`backup.ts` |
| 更新 | 检查 → 解析清单 → 选对版本 → 下载校验 | `g10-update.test.mjs` | `services/updateManifest.ts`、`components/settings/AppUpdateField.tsx` |

对应关系按「**改动落在哪就至少跑那一条**」用，不是穷举：动了 `src/services/chat/` 就跑 G1/G2/G5，
动了设置面板就跑 G5/G10。拿不准就 `pnpm run test:golden` 全跑 —— 4 条约 6 秒。

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

实测（2026-11-20，本机 4 并发）：G1 3.4s / G2 4.6s / G5 5.8s / G10 4.8s，**墙钟 5.8s**。

## 第二批（未做，留 Issue #404 后续）

本批只做了 4 个最容易改坏的域（启动 / 对话 / 导入 / 更新）。剩余 6 域按 Issue #404 的表补，
允许合并（某两域天然同一流程就合成一条），预计仍是 6 条以内、总时长仍在预算内：

| 域 | 黄金路径 | 状态 |
| --- | --- | --- |
| 渠道 | 切渠道 → Key 校验 → 发一条消息成功 | 待补（与「对话」有共用装配，可复用 `fixtures/domain01-02/mock-upstream.mjs`） |
| 会话 | 新建 → 重命名 → 置顶 → 删除 → 回空态 | 待补 |
| 导出 | 导出 → 校验包结构 → 可再次导入 | 待补（与「导入」天然同一流程，可并入一条往返） |
| 额度 | 领取 → 刷新 → 兑换成功一次 | 待补 |
| 购买 | 套餐 → 下单（cid）→ 回跳 → 轮询到卡 | 待补 |
| 诊断 | 触发错误 → 诊断复制内容已脱敏 | 待补 |
