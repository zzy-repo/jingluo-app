# Issue #133 取证：长会话首屏 + 弱网超时兜底（模拟器）

> 环境标签（全文所有数字都只代表这一台环境）：**Android Emulator API33（x86_64、无 GPU、headless，非真实手机）**
> 设备：`sdk_gphone64_x86_64`，Android 13 / SDK 33，WebView `109.0.5414.123`，MemTotal ≈ 2.0 GB
> 屏幕：`wm size` Physical 1080×2280，Override 720×1560，density 320 → **360dp 宽**
> 应用：`com.example.deepseekchat`（鲸落），debug APK，`origin/main@18b44f3` 构建，本地 HEAD `7d2facb`
> 采集方式：WebView DevTools 协议（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + 页级 CDP），
> 截图用 `adb exec-out screencap -p`（headless 模拟器上 `Page.captureScreenshot` 会复用旧帧，见第 6 节）。
> **本单不改产品代码**，脚本与原始结果都在本目录。

结论先写：**长会话首屏在这一档不是瓶颈**（4000 条消息仍然 315 ms 内出最后一条，DOM 节点数恒定 218）；
**弱网兜底有问题**——不可解释的「长时间转圈」确实存在：请求超时会自动重试 2 次，**最终失败文案要到 48 秒才出现**；
而**响应体阶段（已收到 200 头之后）完全没有超时**，龟速流会让界面无限停在 streaming 态。

---

## 1. 长会话首屏

### 1.1 造法（可复现）

`tests/fixtures/domain05/archive-fixture.mjs` 每个会话只有 1 轮问答，撑不出长历史，所以**自建 seed**：
脚本 `firstscreen.mjs` 在页面里直接写 IndexedDB `chat-demo`（DB_VERSION 12）：

- `sessions`（keyPath `id`）：`fact133-big` 一条大会话，`title = 会话 <N> 条`，`messages` 长度为 N；
- `sessionSummaries`（keyPath `id`）：同步写一条摘要，保证列表页不用解大对象；
- 消息形态：`UserMessage { role:'user', content, files:[], createdAt }` +
  `AssistantMessage { role:'assistant', status:'done', stopReason:'end_turn', blocks:[{type:'text', text}] }`；
- 另外塞 30 个 `fact133-small-<i>` 小会话（每个 10 条），让抽屉里是**真实的多会话列表**而不是单条；
- 写入后 `location.reload()`，等 App 就绪再走用户路径：点菜单 → 点会话项 → 量时间。

seeded 数据量（JSON 字节，`sessions` 单条）：

| 消息数（轮数） | seed 字节 |
|---|---|
| 200（100） | 133 172 |
| 1000（500） | 487 173 |
| 2000（1000） | 930 675 |
| 4000（2000） | 1 819 675 |

口径（均为页内 `performance.now()`）：
`readyAt` = reload 到 App 脱离 loading 视图；`listReadyAt` = 到抽屉会话项可点；
`firstRowMs` = 点会话到第一行 `[data-row-id]` 有内容；`lastTextMs` = 到最后一行（`data-row-index=N-1`）有内容；
`topFirstMs` = **双击标题走产品自带的「回到首条消息」（#106）** → 到第 0 行可见。

### 1.2 结果（单次取样，冷启动一次）

| 消息数（轮） | readyAt | listReadyAt | firstRowMs | lastTextMs | topFirstMs | scrollHeight | DOM 节点 | JS heap used/total | Java Heap | TOTAL PSS |
|---|---|---|---|---|---|---|---|---|---|---|
| 200（100） | 229 ms | 258 ms | 146 ms | 146 ms | 425 ms | 29 592 px | 218 | 10.6 / 16.1 MB | 10 400 / 27 848 KB | 93 400 KB |
| 1000（500） | 237 ms | 255 ms | 169 ms | 169 ms | 529 ms | 125 592 px | 218 | 10.1 / 19.4 MB | 10 404 / 27 852 KB | 94 105 KB |
| 2000（1000） | 231 ms | 258 ms | 249 ms | 250 ms | 551 ms | 245 592 px | 218 | 17.1 / 26.6 MB | 10 404 / 27 852 KB | 94 368 KB |
| 4000（2000） | 226 ms | 260 ms | 315 ms | 315 ms | 568 ms | 485 592 px | 218 | 20.4 / 27.1 MB | 10 416 / 27 864 KB | 94 472 KB |

读法：

1. **冷启动与历史规模无关**（226–237 ms；列表 255–260 ms）——首屏走的是摘要表，不解大会话。
2. **点开会话是线性但很缓**：200→4000 条消息，146→315 ms，20 倍数据换 2.2 倍耗时；只渲染可视窗口（`OVERSCAN_PX=800`）。
3. **DOM 节点数恒定 218**，与本仓库 #45 桌面 Chromium 的常数一致 —— 虚拟化在 Android WebView 109 上同样生效。
4. **内存几乎不随历史涨**：整段 200→4000 条，TOTAL PSS 只 +1.1 MB；JS heap used 10.6→20.4 MB（大对象预览/摘要期）。
5. **「回到首条」425–568 ms**，主要被 #106 的动画时长支配（220–600 ms 区间），与规模关系很弱。

## 2. 弱网超时兜底

### 2.1 造法

宿主机整形服务器 `shape-server.mjs`（Node，端口 5399），按 URL 首段区分行为，App 的 openai 档 `baseUrl` 指过去：

| 场景 | URL | 宿主行为 | 模拟的弱网形态 |
|---|---|---|---|
| S0 对照 | `/ok/v1` | 200 + SSE，3 个 delta + `finish_reason:'stop'` + `[DONE]` | 正常 |
| S1 半死（连上不回） | `/hold/v1` | 收下请求后一个字节都不写 | 中间设备黑洞 / 服务端卡死 |
| S2 掐断 | `/cut/v1` | 200 + 2 个 delta，1.2 s 后 `socket.destroy()` | 连接中途被断（#41 同型） |
| S3 龟速 | `/trickle/v1` | 1 个 delta，之后每 3 s 一个（共 8 个） | 极低速但连接活着 |
| S4 不可达 | `10.0.2.2:5398/v1` | 端口没有进程监听 | 连接被拒 |

每个场景：改 `localStorage['chat-demo:base-url:openai']` → `location.reload()` → 输入框发一条消息 →
**逐帧（rAF）采样**：最后一条消息行文本、停止按钮是否在、是否出现失败/重试文案，直到落定或预算用尽，最后 `screencap`。

### 2.2 结果

| 场景 | 首次可见反馈 | 中间态 | 最终状态（多久） | 界面能否解释 |
|---|---|---|---|---|
| S0 对照 | 91 ms 出现停止按钮；1.1 s 正文落定 | — | 1 126 ms 停止按钮消失，正文完整 | ✅ 正常收尾 |
| S1 连上不回 | 5.0 s 出现占位文案 `Waiting for the response` | 15.0 s `Retrying (attempt 1 of 2)`；31.0 s `Retrying (attempt 2 of 2)` | **48.0 s** 出 `Request timed out (15s with no response). Check your network and try again.`，停止按钮消失 | ⚠️ 有文案，但要等 48 s |
| S2 中途掐断 | 1.03 s 前两段 delta 上屏 | — | **1.26 s** 出 `The connection was interrupted and the reply is incomplete. What was received is kept — you can regenerate.`，停止按钮消失，已收到的半句保留（设计如此） | ✅ 可解释 |
| S3 龟速 | 76 ms 第一段上屏 | 之后 **≥70 s 无新增内容、无任何提示、停止按钮一直在** | 70 s 观察窗内**始终未落定**（无超时、无错误） | ❌ 无限等待 |
| S4 不可达 | 5.0 s 同样出现占位文案 | 15.0 s / 31.0 s 同样两次 `Retrying` | **48.0 s** 同样出 `Request timed out (15s …)` | ⚠️ 文案可用，但「立刻被拒」也走满 45 s 重试节奏 |

截图：`screens/133-weaknet-s0-ok-360dp.png`、`-s1-hold-long-360dp.png`、`-s2-cut-360dp.png`、
`-s3-trickle-long-360dp.png`、`-s4-unreachable-long-360dp.png`（全部 360dp，`adb exec-out screencap`）。

## 3. 发现（缺陷 / 差距）

1. **超时兜底「有但太慢」（中）**：`DEFAULT_REQUEST_TIMEOUT_MS=15000` 之外还有 2 次自动重试，
   因此**用户真实感知到的失败时间 ≈ 48 s**（15 s × 3 次 + 每次重连开销）。文案本身可解释
   （`requestTimeout`，含秒数），不会永久转圈；但 40 s 内观察不到任何失败结论，体感接近「卡死」。
   建议方向（不在本单修改）：失败前要有阶段提示（当前 `Retrying (attempt x of y)` 只在 15 s/31 s 一闪而过），
   或把重试次数降到 1 次 / 给退避，并让超时文案带上「已重试 N 次」。
2. **响应体阶段没有超时（高，缺口）**：15 s 计时器只覆盖**拿到响应头之前**。头到手后进入流式，
   S3 那种「每 3 s 一个字节」的连接会让界面**无限停在 streaming 态**（70 s 窗口内无任何提示，停止按钮一直在）。
   用户只能自己点停止。这与 #41（`stream_interrupted`）不是同一层问题：那是断了会报错，这是不断也不动。
   建议另开单：给流式阶段加「空闲超时」（如连续 N 秒无新 chunk 即判失败并保留已收内容）。
3. **连接被拒也要等 45 s（低）**：S4 的 TCP 立即被拒，本来可以立刻告诉用户「连不上」，
   实际走完两次重试才报超时。文件类下载路径已有 `historyImportUrlNetwork` 这类即时文案，聊天路径没有。
4. **流式态没有 `role="status"`（说明，非缺陷）**：等待期界面用文字 `Waiting for the response`（英文 locale）
   + 停止按钮表达，不是 `role="status"`。做自动化断言时不能拿 `role="status"` 当「还在等」的判据。
5. **取证工具坑（写给后续同学）**：App 被 `force-stop` 重启后 pid 变了，旧的 `adb forward tcp:9222` 会指向已死的 webview，
   表现是「attach 成功但每条 `Runtime.evaluate` 都石沉大海」。必须先 `adb forward --remove-all`（`cdp.mjs` 已加）。
6. **取证工具坑 2**：headless/无 GPU 模拟器上，连续两次 `Page.captureScreenshot` 会返回同一帧；
   截图请走 `adb exec-out screencap -p`。

## 4. #133 处置

- 标签：`status:done`；评论见 issue 上的取证小结（含本文件路径）。
- 本单是取证单，**没有产品代码改动**（`git status` 只有本目录脚本与 html/json 结果）。

## 5. 未测边界（不要外推）

- **真机未测**：以上全部是 Android Emulator API33 x86_64。真实手机（尤其低端机、eMMC、4 GB 内存档）的首屏耗时、
  掉帧、以及 WebView 版本差异都可能不同；**本文件的毫秒数不得移植成真机结论**。
- **iOS 未测**；桌面端不属本单（#45 已有 Chromium 数据）。
- **真实弱网未测**：S1–S4 是宿主机**可控整形**（黑洞 / 掐断 / 龟速 / 拒连），不等于地铁、电梯、2G 抖动、
  DNS 污染、运营商劫持等真实链路；未观测 DNS 慢解析、TLS 握手超时、代理认证弹窗等形态。
- 首屏是**单次取样**（每档 1 次），不是统计分布；冷启动前没有清 OS 缓存，档与档之间的热缓存状态不完全一致。
- 长会话只造了「纯文本 + 已完成」消息，没覆盖大量 thinking / 工具块 / 附件 / 图片的历史，
  这类消息的渲染成本明显更高，模型不同。

## 6. 复现

```bash
export PATH="$PATH:/d/android-sdk/platform-tools"; export MSYS_NO_PATHCONV=1
# 1) 起整形服务器
node docs/ui/133-weak-device/shape-server.mjs &
# 2) 造历史 + 量首屏（默认 200,1000,2000,4000）
SIZES=200,1000,2000,4000 node docs/ui/133-weak-device/firstscreen.mjs
# 3) 弱网四类源（第一轮 40s 预算看中间态；第二轮拉长预算看最终文案）
node docs/ui/133-weak-device/weaknet.mjs
node docs/ui/133-weak-device/weaknet2.mjs
```

结果文件：`firstscreen-results.json`、`weaknet-results.json`、`weaknet-results-long.json`，截图在 `screens/`。
