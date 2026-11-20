# 黄金回归套件（Issue #404）

**每域 1 条主路径**，真实 `dist` 产物 + 真浏览器 + stub 后端，单条 ≤60s、整层 ≤5 分钟，并行跑。
它是 PR 反馈链路上的**第一道功能防线**：L0（unit，~1 分钟）测不到「用户真实路径被打断」，
L1（integration，7~20 分钟）太慢不能每次都等。

```bash
TEST_AUTH_SEAM=1 pnpm run build   # 标准产物（dist，variant=standard）+ 登录接缝（见下）
pnpm run test:golden              # = node tests/run-golden.mjs（并行 + 每条耗时 + 一句话失败定位）
```

> **构建必须带 `TEST_AUTH_SEAM=1`**（#510）：`src/main.tsx` 把整个 App 包在 `<AuthGate>` 里之后，
> 未登录冷启动只画登录页，侧栏 / 设置 / 输入框全都拿不到 —— 那样 G1~G11、G15 会在第一步就红，
> 红的是环境不是用例。CI 的 golden job 就是带这个开关构建的（见 `.github/workflows/ci.yml`），
> 并在构建后跑 `check:test-seam --expect-seam` 做正向对照。发版产物**绝不允许**带它。

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
| 文档附件 | 选 tiny.txt → 卡片 success → 发送「帮我总结」→ 收到回复（顺带 docx/pdf 只断非空正文 + 表格/页码标记） | `g13-documents.test.mjs` ✅（A 线 #480 落地，#567 的 g13） | `services/attachments/parsers/{txt,docx,pdf}.ts`、`attachments/{manager,inject,providerCapability,requestDocs}.ts`、`attachments/contextBuilder.ts`（buildWithDocuments）、`components/attachments/*`（卡片五态）、`chat/{store,reply}.ts`（请求组装） |
| 图片 vision | 附 1 张 png → 内联编码 → 发一条消息（三渠道形状不同、图片字节相同） | `g14-vision.test.mjs` ✅（B 线 #548 落地） | `services/attachments/imageSource.ts`（编码）、`chat/drafts.ts`（选图编码 / 就绪态）、`chat/reply.ts`（内联块）、`api/openaiAdapter.ts`（data URL 翻译） |
| 支付/购买 | 打开「账户与消费」→ 套餐列表 → 下单（`/api/pay-link`）→ 回跳 → 卡密 → 一键复制 | `g15-purchase.test.mjs` | `components/consume/{AccountConsumePage,BuyTab,MyCardsTab}.tsx`、`services/ours/{api,purchases,transport}.ts`、`components/consume/quotaPanelModel.ts`（额度口径） |

> **三条黄金哨兵都已落地**（#567 定的三主线各一条：A 文档附件 g13 / B 图片 vision g14 / C 购买 g15）：
> `g13`（A 线 #480）、`g15`（C 线购买）、**`g14`（B 线 #548，随本次合并进 main）** 全部在树上并有 ✅ 判定。
> 它们要用的最小真二进制夹具见下面「夹具怎么用」。

对应关系按「**改动落在哪就至少跑那一条**」用，不是穷举：动了 `src/services/chat/` 就跑 G1/G2/G4/G5/G6，
动了设置面板/渠道就跑 G3/G5/G6/G9/G10（`g11` 邮箱见 `tests/golden/g11-email.test.mjs`），
动了 `src/components/consume/**` 或 `src/services/ours/**`（套餐 / 下单 / 卡密 / 额度口径）就跑 **G15**，
动了 `src/services/attachments/**` 或 `src/components/attachments/**`（文档解析 / 注入 / 卡片）就跑 **G13**，
动了图片那条通路（`attachments/imageSource.ts`、`chat/drafts.ts` 的选图编码、`chat/reply.ts` 的 `toFileBlocks`
内联块、`api/openaiAdapter.ts` 的 data URL 翻译）就跑 **G14**（文档与图片是同目录的两条独立通路，各跑各的）。
拿不准就 `pnpm run test:golden` 全跑 —— 12 条约 18 秒（g12 单独约 0.9s，自带 mock，不需要 dist；
g13 单跑约 1.2s、4 并发整层里约 3.9s；g14 约 4.3s；g15 约 1.7s）。

> **购买域的黄金回归换过人（W1-D #487 → #567）**：老的 `g07-quota-purchase.test.mjs` 跟着旧额度/邀请体系
> 一起删了 —— 它断言的「领取 → 刷新 → 兑换」走的是 `device_id` + 本机池那条整条被替换的链路。
> 现在的替代是**两条、各管一段**：`g12-consume.test.mjs` 管消费层链路（登录 / 余额 / 兑换，mock 驱动），
> **`g15-purchase.test.mjs` 管购买主路径**（套餐 → `/api/pay-link` → 回跳 → 卡密 → 复制，dist + 浏览器）。
> 改 `src/components/consume/**` 或 `src/services/ours/**` 就跑 G15，别再去找 `g07`。

> **两处合并**（Issue #404 允许：「某两域天然同一流程就合成一条」）：
> · **导出 + 导入** → G6：只有把导出的字节真的喂回导入，`manifest` 首条、条目路径、索引与会话的一一对应才被同时钉住；
> · （原「额度 + 购买」合并成 G7 的那条已随 W1-D 删除；购买侧现由 G15 单独承接，见上。）

### g12「账户与消费」为什么是 mock 驱动、而不是 dist + 浏览器

写这条用例时新链路（JWT 身份层 + 四个消费面板）**还没有页面外壳**（`src/main.tsx` 尚未挂 `AuthGate`、
账户页 W1-C1 未合并），dist 里点不到登录 / 兑换入口，所以它选了「跑链路」而不是「点按钮」：
真 `createConsumeClient` / `createAuthTransport` / `store`，对面是 `tools/mock-sub2api`（端口 0，
内核分配；不连 127.0.0.1:18000 的真实例，用例结尾有「所有请求都落在本次 mock 上」的守卫）。
两条路径：① 登录 → 读余额 → 兑换 `MOCK-OK-0001` → 余额 +10；② 冷启动过期 → 续期换新 token → 仍能读余额。

**现在页面外壳已经合并**（`AuthGate` 已挂、账户页已在 dist 里），但 g12 仍然保留 mock 驱动的写法：
它守的是**消费层链路**（登录 / 余额 / 兑换），而「点按钮」那条用户路径由 **G15** 从 dist 里点
（账户与消费 → 卡密 / 购买 / 额度三个 tab 都在 G15 与 g12 的覆盖范围内，两条不重复断言）。

### g14「图片 vision」为什么抓请求体、而不是看界面

图片比纯文本多一段「本地编码 → 内联进请求体」的链路（`imageSource.ts` 编码 → 草稿就绪态 →
`store.prepareInlineImages` → `reply.toFileBlocks` → `openaiAdapter` 翻成 data URL）。**任何一环接错，
界面上都不会红**：文字照发、回复照收，只是模型看不见图（发出去是一张空图也一样绿）。所以这一条
不看界面长什么样，直接把真浏览器发出去的请求体抓下来按**字节**钉三件事：

1. 图片在请求体里，且 `media_type` / data URL 前缀是 `image/png`；
2. 这份 base64 **逐字等于** `tests/fixtures/golden/tiny.png`（阈值内原图直发，一个字节不改）；
3. 把它解回像素是 8×8 纯色 `#3366cc`（「有段 base64」不算过，能出图才算）。

三渠道（anthropic / openai / ours）各跑一次：**形状不同**（`{type:'image', source:{type:'base64'…}}`
vs `{type:'image_url', image_url:{url:'data:…'}}`）、**字节相同**。渠道配置用 localStorage 预置
（`provider-kind` + `api-key` + 自填渠道的 `base-url:<kind>` / `model:<kind>`），上游用 `page.route`
拦成两套 SSE —— 「切渠道」本身归 G3，这里不重复。

## 夹具怎么用（`tests/fixtures/golden/`）

g13（文档附件）/ g14（图片 vision）需要**真文件**喂进真实解析链路，这里的 `tiny.*` 就是为此准备的最小夹具：
**它们是真二进制、随仓库入库**，用例直接读文件即可 ——

> **不要手拼 base64。** 这几天反复踩的坑就在这里：手拼的 png 前缀对、CRC 错，浏览器 `<img>` 直接不出图；
> 手拼的 docx 少了 `_rels/.rels`，`zipReader` 读得到条目、OOXML 侧认不出主文档。
> 断言挂在这种文件上，红起来像是产品坏了，其实是夹具坏了。

| 夹具 | 体积 | 内容 | 谁用 |
| --- | --- | --- | --- |
| `tiny.txt` | 114 B | 3 段中英混排纯文本 | g13 → `parseTxtFile` |
| `tiny.docx` | 1.7 KB | 合法 OOXML（5 条目 zip）：1 个 Heading1 标题 + 1 段正文 + **1 个 2×2 表格** | g13 → `parseDocxFile` |
| `tiny.pdf` | 700 B | 合法 PDF 1 页、**有文本层**，正文 `Hello golden` + 一行补充（凑过 `pdfMinCharsPerPage=20`） | g13 → `parsePdfFile`（pdfjs） |
| `tiny.png` | 74 B | 8×8 纯色 RGB（`#3366cc`） | g14 → 图片附件 / vision 上传 |

取用方式（黄金用例里就这么读，别内联字节）：

```js
import { readFile } from 'node:fs/promises'
const bytes = await readFile(new URL('../fixtures/golden/tiny.docx', import.meta.url))
const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
```

**重新生成**（唯一入口，不要手改这四个文件）：

```bash
node tests/fixtures/golden/make-fixtures.mjs           # 生成 + 自检（幂等：内容没变就不写盘）
node tests/fixtures/golden/make-fixtures.mjs --check   # 只自检不写盘
```

脚本有**两层自检**，不过就 throw：① 字节级结构（zip 中央目录与每个条目 CRC / PNG 每个 chunk 的 CRC 与像素 /
PDF 的 xref 偏移与 `/Length`）；② **真解析器**——`parseTxtFile` / `parseDocxFile` / `parsePdfFile` 在树上存在就
真解析一遍并断言取到了正文与表格行列，不存在（#480 还没合入 main）或环境缺件（node 里没有 pdfjs）时打印
`SKIP` 并给出原因，**不假装通过**。

与 `tests/fixtures/480/` 的分工：那边的 `minimal.docx` / `text-layer.pdf` / 六种编码 txt 是 #528 L0/L1
**验收矩阵**的样本（要覆盖空文件、加密、XXE、zip 炸弹这些坏形态）；这里只保留**黄金路径够用的最小合法文件**，
一份一 KB 上下，目的是「链路没断」可断言、跑得快。

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

## 第三批（#567）：购买主路径 G15

`g07-quota-purchase` 已随 W1-D 删除（见上），C 线（支付 / 购买）由 **G15** 承接 —— 它钉的是**现在这条**链路：

```
设置 → 数据管理 → 账户与消费 → 购买 tab（GET /api/plans）
  → 去支付（GET /api/pay-link）→ App 内打开收款页 → 关页回跳
  → 我的卡密 tab（GET /api/orders）→ 复制卡密 → 我的额度 tab（GET /v1/usage）
```

只断五件事（#567 清单）：① 卡密出现在「我的卡密」（后 4 位）② 复制拿到**完整**卡密
③ `/buy` 请求数为 0（那条建单链路 #331 已整条下线）④ 额度来源是 sub2api 的
`usage.total.actual_cost`（不是 `quota.used`、也不是邀请服务的 `remaining_points`）
⑤ 支付侧走 apia（`/api/plans` 与 `/api/pay-link` 各 ≥1 次），**sub2api 不参与下单**。

后端全桩：`window.Capacitor` 换成原生桥替身（`androidBridge` + `PluginHeaders`），
apia（plans / pay-link / orders）与 sub2api（`/v1/usage`）都落在用例自己的 route 表上，
表外路径一律 404。收款页的「关页回跳」由替身接住 `Browser.addListener` 的回调、由用例触发，
**不依赖任何真浏览器插件、不连真服务**。

| 域 | 黄金路径 | 用例 | 状态 |
| --- | --- | --- | --- |
| 支付/购买 | 套餐 → 下单（pay-link）→ 回跳 → 卡密 → 一键复制 | `g15-purchase.test.mjs` | ✅ |

实测（2026-11-20，本机，标准产物 + `TEST_AUTH_SEAM=1`）：G15 约 1.7s（7 步）。

整层实测（2026-11-20，本机 4 并发）：G1 2.7s / G2 3.0s / G3 4.3s / G4 7.0s / G5 4.0s /
G6 4.2s / G9 2.7s / G10 2.3s / G11 3.1s / G12 1.5s / **G15 1.7s**，11 条全绿、**墙钟 10.1s**。
（G7 5.0s 那一行随 W1-D 删除；购买侧现由 G15 承接。）

负向验证（每条都人为破坏一次、确认变红后再还原）：

| 用例 | 破坏方式 | 红在哪一句 |
| --- | --- | --- |
| G3 | `providers.ts` 里 anthropic 的 `auth` 改回 `'bearer'` | 探测/发消息都带不上 `x-api-key` |
| G4 | `store.ts` 的 `removeSessionData` 不再 `db.deleteSession` | 「删除真的落到 IndexedDB（sessions=2）」 |
| G6 | `exportArchive.ts` 不再写 `manifest.json` | 「首条是 manifest.json（实际 chat_sessions/…）」 |
| G9 | `redact.ts` 跳过值维度脱敏（只留 key 维度） | 「复制内容里没有任何一项敏感值原文（设备码,卡密,手机号）」 |
| G15 | 「复制卡密」改成复制空串（`copyCard` 里 `copyText('')`） | 「复制动作把完整卡密交给剪贴板（实际=空串）」 |
| G15 | 卡密来源从 apia 换成 sub2api（`fetchPurchases(..., 'http://127.0.0.1:18000/api/v1')`） | 「关掉收款页后卡密出现在「我的卡密」（实际=订单查询被拒绝）」 |
| G15 | 前端去调已下线的 `/buy`（购买 tab 挂载时补一次 `/buy?cid=…`） | 「没有走已下线的 /buy 建单链路（实际=1 次）」 |

## 第四批（#567）：文档附件主路径 G13

A 线（#480）的黄金哨兵。**钉的是「选文件 → 解析 → 注入 → 发送 → 回复」这条整链路**：

```
输入区「添加文档（TXT / DOCX / PDF）」→ 选 tiny.txt
  → AttachmentManager.addFile（sha256 + 落 IndexedDB）→ parseTxtFile（真解析）
  → 卡片进入 success（状态行「已就绪」）
  → 填「帮我总结」→ 发送 → toRequestMessages 挂附件引用 → buildWithDocuments 注入
  → buildMessageBody 组装 → POST /messages（本机 mock 上游收下 body）→ 流式回复上屏
```

只断三件事（#567 清单，一条不多）：

| # | 断言 | 判据落在哪 |
| --- | --- | --- |
| ① | 附件卡片进入 **success** | 输入区卡片的状态行**逐字等于**「已就绪」（「部分内容已就绪 · N 条警告」含同样三个字，所以比整行、不比子串） |
| ② | 上行 user message 里有 `<document name="tiny.txt">` 文本块 | 上游那一端被抓下来的 POST body：块头块尾都在 + 块内是夹具真正文 + 尾部跟 `用户问题：帮我总结` |
| ③ | 请求体里**没有** base64 / `file_id` / `{type:'document'}` 块 | 同一份 body 的 JSON 全文：`file_id`、`{type:document|file|image}`、`;base64,` / `data:…;base64,`、300+ 字符的裸 base64 串，一条都不许有；另外断言 user `content` 仍是**纯字符串**（文本注入，不是块数组） |

**顺带覆盖 DOCX / PDF**（同一份文件里的第二步，不是第二条路径）：只断「解析出非空正文 +
表格标记 `| 甲 | 乙 |` / 页码标记 `[第1页]` 出现在请求体里」，**不断言解析细节**
（标题层级 / 合并单元格 / 跨页切分 / 编码嗅探都在 L0 的 `parsers-*` 里，这里不重复）。

证据链为什么可信：请求体不是读中间变量得来的 —— `AttachmentManager` 真的把原件写进 IndexedDB、
真的调 `parseTxtFile` 解析、`buildWithDocuments()` 真的按预算注入，最后**在 mock 上游的 HTTP 服务里
把收到的 body 抓下来**（`tests/fixtures/domain01-02/mock-upstream.mjs` 的 `state.chatCalls`）。
所以「字节真发出去了」这件事本身也被钉住了。

| 域 | 黄金路径 | 用例 | 状态 |
| --- | --- | --- | --- |
| 文档附件 | 选 tiny.txt → 卡片 success → 发送「帮我总结」→ 收到回复 | `g13-documents.test.mjs` | ✅ |

实测（2026-11-20，本机，标准产物 + `TEST_AUTH_SEAM=1`）：G13 单跑约 1.2s（6 步；txt 主路径约 0.5s，
DOCX/PDF 那一步约 0.8s）；4 并发整层里约 3.9s。整层对账：加 G13 前 10 条 / 墙钟 10.9s，
加 G13 后 **11 条全绿 / 墙钟 14.2s**（预算 300s）。

负向验证（每条都人为破坏一次、确认变红后再还原）：

| 用例 | 破坏方式 | 红在哪一句 |
| --- | --- | --- |
| G13 | `inject.ts::injectDocumentBlocks` 直接 `return content`（注入函数返回原文） | 「上行 user message 里含 `<document name="tiny.txt">` 文本块（实际=`帮我总结`）」——②整组红，①③仍绿（即失败定位到「注入」这一步，不是解析也不是上传） |
| G13 | `contextBuilder.ts` 的块正文改成 `[file_id="…"]` + `data:application/octet-stream;base64,…` | 「请求体里没有 base64 / file_id / {type:document\|file\|image} 块（实际=命中：file_id、base64 data URI、长 base64 串（400 字符））」——③红，②仍绿 |

> 记一个坑：第一次把 `inject.ts::documentBlock()` 改成 base64 形态时 G13 **没有红** —— 因为请求主路径
> 并不经过 `documentBlock()`（`contextBuilder.buildWithDocuments()` 按预算自己用 `documentHeader()` +
> `DOCUMENT_FOOTER` 拼块，只有无预算的 `injectDocuments()` 才用 `documentBlock()`）。改成污染
> `contextBuilder` 的块正文后立刻红。谁要动「块怎么拼」，改这两处**必须一起想**，而 G13 钉的是
> **请求主路径**那一处。

## 第五批（#548）：图片 vision 主路径 G14

B 线（#548）的黄金哨兵，与第四批的 G13 **并行**（同目录、两条独立通路：文档走文本注入，图片走内联/`file_id`）。
**钉的是「选图 → 本地编码 → 内联进请求体 → 三渠道各自翻译 → 回复」这条整链路**：

```
输入区「图片」→ 选 tiny.png
  → imageSource.toImagePart()（阈值内原图直发，阈值外 canvas 重编码 webp）
  → 草稿就绪态 status:'inline'（无 serverId，不进 Files API）
  → 发送 → store.prepareInlineImages → reply.toFileBlocks(files, vision)
  → anthropic {type:'image', source:{type:'base64'}} / openai {type:'image_url'} / ours 自有形状
  → POST /messages（page.route 拦下的 SSE）→ 回复上屏
```

只断三件事（上面「g14 为什么抓请求体」已经说明为什么按字节断）：图片在请求体里且媒体类型对、
这份 base64 逐字等于 `tests/fixtures/golden/tiny.png`、解回像素是 8×8 纯色 `#3366cc`。

| 域 | 黄金路径 | 用例 | 状态 |
| --- | --- | --- | --- |
| 图片 vision | 附 1 张 png → 内联编码 → 发一条消息（三渠道形状不同、字节相同） | `g14-vision.test.mjs` | ✅ |

实测（2026-11-20，本机，标准产物 + `TEST_AUTH_SEAM=1`）：G14 约 4.3s（7 步，三渠道各一次）；
整层 12 条 4 并发**墙钟 18.0s**（预算 300s）。

负向验证（人为破坏一次、确认变红后再还原）：

| 用例 | 破坏方式 | 红在哪一句 |
| --- | --- | --- |
| G14 | `reply.ts` 的 `toFileBlocks` 不再产出内联图片块（`const part = undefined && imagePartOf(id)`） | 「请求体里带上了图片 · 实际=user content="这张图是什么颜色？"」（三渠道第一站就红） |
