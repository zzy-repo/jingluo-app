# 变更记录

本文件记录 deepseek-app 的重要变更，版本倒序排列。

## 1.4.0-beta.8 (2026-11-18) — 额度查询与卡密兑换

- 新增：我们的渠道额度查询与卡密兑换（购买暂未开放）
- 新增：日志自动附带设备与 WebView 信息，便于反馈排查
- 修复：长文本咨询导入一直转圈、旧内核检查更新报错等问题
- 内测版本，建议保留重要聊天记录；遇到问题请通过反馈入口提交

> 内部验收记录（不进 dl 用户说明）：
  - 源码范围：integration/next(dd1a30a) + 余额 UI(404ecf4) + 系统信息(553e535/4ba2873/78665f2) + 用例契约对齐(1ba8fb9)
  - 门禁口径：integration 按「回归对比」判定（基线 11 个已知红，只允许不新增失败），详见 docs/release-beta8-baseline.txt
  - 未做：真实付款（网关金额 0.10 与标价 9.90 不符，故意禁用）；HTTPS 收银台未验证；Android 真机 UI 未测（插件仅源码审查）；Web 侧 CORS 全为 mock；低内核白屏修复（1badb1c）留 beta.9（需 WebView83 真机验证）

## 1.4.0-beta.7 (2026-11-18) — 网络不可用时 [未过门禁]

- 网络不可用时，也可把反馈日志保存到手机，再把文件发给我们
- 内测版本，建议保留重要聊天记录；遇到问题请通过反馈入口提交

> 内部验收记录（不进 dl 用户说明）：
  - 源码范围：beta6(21987ea) + 离线日志导出(3076785) + 发布解析器修复(7830304) + updateManifest 旧 WebView 兼容(7c66393) + toLocal/store 两处兼容(18e6172，仅 src，不带导入链)
  - Android gate（日志 owner 执行、父代理看图）：Android14/SDK34/WebView113；断网 network 失败 → SAF 取消并保留表单 → 再次 SAVE，读回 JSON 15964B、sha256 a93ca8f3de6e9b2615f559c62babde1749a32158d58bd9a94a4657bee76336af；日志非空/含失败信息/脱敏通过
  - focused：tsc 0 错、oxlint 0 警 0 错、unit 8/8（标准 runner）；legacy-webview-compat 另以 --experimental-transform-types 实跑 3/3 真实路径通过（标准 runner 下 2 项显式 SKIP，不计动态通过）
  - 边界：旧 Android 未实测、写失败仅 mock 边界；未跑整仓 20 套；真模型上游 e2e 延后；minSdk24/targetSdk36/web target chrome>=105 不等于 WebView92 全功能支持
  - 本次 --skip-tests：只跑了本次 focused 验收，全量测试套件未跑

## 1.4.0-beta.6 (2026-11-18) — 新增会话置顶：常用会话可置顶 [未过门禁]

- 新增会话置顶：常用会话可置顶，置顶状态会保留
- 修复：手机窄屏下设置页操作按钮挤压与溢出
- 修复：提交反馈时附带的截图不再丢失
- 内测版本，建议保留重要聊天记录；遇到问题请通过反馈入口提交

> 内部验收记录（不进 dl 用户说明）：
  - 源码范围：origin/main 3f1b160 + 图片 4f81952 + 设置溢出 bb3dbf1 + 置顶 ccf51af/54acfea/44a518b + ours 改协议 763f13d + 置顶分支 lint 补花括号 9a55a1e；不含模型列表 8cd686a、导入、clipboard、test-runtime
  - focused：tsc 0 错、oxlint 0 警 0 错、unit 4/4（app-update / feedback-images / openai-adapter / provider-ours）
  - ours 真实 UI E2E（用户授权 key 仅走环境变量，未落盘未打印）：POST http://62.106.70.167:60010/v1/chat/completions、Authorization Bearer、model=deepseek-v4.1-flash、首个助手文字 1693ms、回复非空；仅测 ours，未测其他渠道
  - 置顶：手机截图视觉验收（图钉/省略号/40px 更多入口/中文取消菜单无溢出）+ 持久化修复为代码级；真机逐项未复测。溢出：浏览器 280–412 通过，真机字体倍率未验。图片：images=1 仅接收成功，不冒称持久化
  - 未跑：整仓 integration 全量、其他渠道真上游、模型列表；真实 Android 覆盖安装未在 code13 设备复测
  - 本次 --skip-tests：只跑了本次 focused 验收，全量测试套件未跑

## 1.4.0-beta.5 (2026-11-18) — 新增检查更新：设置里可检查是否有新版本 [未过门禁]

- 新增检查更新：设置里可检查是否有新版本，有新版时可下载安装
- 内测版本，建议保留重要聊天记录；遇到问题请通过反馈入口提交

> 内部验收记录（不进 dl 用户说明）：
  - 源码范围：origin/main 1d08b24 + manifest 5a0abc1/4b194d6 + App 3ed3d3a；未含导入/剪贴板/UI 分支
  - focused 验收：tsc 0 错误、oxlint 0 警 0 错、unit 2/2（含 app-update 单测）；全量 integration 未跑；真实模型上游 e2e 未跑（用户决定延后）
  - Android 证据 docs/in-app-update-acceptance.md：HTTPS 真实下载 code12→13、权限拒绝/允许返回、取消重试、确认安装成功、360/390/412 不溢出；本发布机不复测设备行为、未逐条核实会话内容
  - 本次 --skip-tests：只跑了本次 focused 验收，全量测试套件未跑

## 1.4.0-beta.4 (2026-11-18) — 设置页四渠道下拉（DeepSeek 官方 [未过门禁]

- 新增：设置页四渠道下拉（DeepSeek 官方 / Anthropic 兼容 / OpenAI 兼容 / 我们的渠道），内置渠道只暴露 API Key
- 修复：反馈与日志真实提交到后端，超限自动裁剪、失败降级重试，成功回显工单号
- 改进：APK 发布改走 dl HTTP 发布接口，tag 触发 GitHub Release
- 发布门禁说明：本次按维护者决定先发布——type/lint/unit 已通过、反馈上传 e2e 已通过；integration 因包含未冻结的导入用例被排除而未完成，真实模型上游 e2e 未跑，二者发布后补测

## 1.4.0-beta.3 (2026-11-17) — 会话自动标题

> 只补齐 Anthropic / OpenAI 兼容模式下缺失的会话标题；**DeepSeek 官方模式零变化**（服务端原生 title 字段链路逐字未动），
> 1.4.0-beta.2 的动效层与消息流同样未改。

- 新增：自动生成会话标题（Anthropic / OpenAI 兼容模式）。首轮回答正常结束后异步触发一次，
  走当前生效的服务类型（`{base}/v1/messages` 或 `{base}/v1/chat/completions`），非流式、不开 thinking
- 参考 DSH（`dsh-session-title-first-prompt-llm`）实现，省 token 的三条约束：
  1. **只喂首条用户消息**，并包成 JSON 数组（模型看到的是数据而非新指令，防提示词注入）；
     `maxInputBytes = 2048` 硬上限，超出按字节截断
  2. **最小 `max_tokens = 32`**，输出目标约 8–14 个中文字符 / 3–5 个英文单词，标题语言跟随消息语言
  3. `timeoutMs = 8000` 硬超时，输出只取第一个非空行并剥掉强调外壳 / 引号 / 控制字符
- 失败回退：超时、网络错误、非 2xx、空输出、`finish` 原因异常、清洗后为空 —— 任一情况都回退到
  **本地截取首条消息前 20 字**（优先在句读处断开、剥掉「你好 / 请问 / 帮我」等语气前缀），回退后仍算成功，不给用户报错
- 手动改名永不覆盖：沿用 `titleRequests` 的「只写一次」语义，同一会话只触发一次标题请求，
  用户手动改名后自动标题再也不会覆盖（见 `src/services/chat/store.ts`）
- 新增验收 `tests/test.auto-title.spec.mjs`：11 个场景（超时 / 500 / 空 / 脏输出 / `finish` 异常 / 手动改名 / DeepSeek 回归等）；
  `rspack.config.ts` 支持 `DIST_OUT` 指定输出目录，测试另起标准构建、不影响 `dist/`
- 版本号：versionCode 10 / versionName 1.4.0-beta.3（功能代码见 commit `551db39`）

## 1.4.0-beta.2 (2026-11-17) — 动效优化

> 只优化「外壳」的交互动效（侧边栏、设置弹窗、按钮按压、列表切项、主题切换），**消息流一律不碰**：
> 流式打字机、思考块、气泡、附件预览、搜索卡片的 DOM 与 CSS 相对 1.4.0-beta.1 逐字未变（`git diff` 为空）。

- 新增动效令牌层 `src/app/motion.css`：iOS 风格缓动 `cubic-bezier(0.32, 0.72, 0, 1)`，
  时长按压 110ms / 淡入淡出 180ms / 常规 220ms / 抽屉 280ms；全部只用于 `transform` 与 `opacity`
- 侧边栏（移动端抽屉）：从左侧 `translateX(-100% → 0)` 滑入，遮罩同步 `opacity 0 → 1` 淡入；
  关闭反向滑出，**DOM 保留到退出动画结束再卸载**，动画期间遮罩仍可点击关闭、不会「点不动」
- 设置弹窗：移动端改为底部弹层 `translateY(100% → 0)` 滑起 + 遮罩淡入淡出；桌面端保留居中缩放淡入
  （`scale 0.97 → 1`）；关闭时同样等动画播完再卸载；遮罩拆成独立伪元素层，压暗与背景模糊一起淡入淡出
- 按钮 / 列表项按压反馈：`:active` 时 `transform: scale(0.96)`（图标按钮 0.92、列表行 `opacity .7`），110ms 回弹
- 会话列表切项：选中项 `opacity .82 → 1` 轻微淡入（≤180ms）；主题切换：整壳 `opacity` 淡入 180ms
- 无障碍：`prefers-reduced-motion: reduce` 下所有动效时长降为 0.01ms，动画类名 `animation: none`，
  且抽屉 / 弹窗不排帧、不保留退出时长的 DOM（实测 `transition-duration = 1e-05s`）
- 技术约束：`src/` 下 37 个 CSS 文件没有任何 `transition`/`animation` 动 `width/height/top/left/margin` 等布局属性，
  相对 1.4.0-beta.1 也没有引入 `transform`/`opacity` 之外的新动画属性（由 `tests/test.motion.spec.mjs` 自动校验）
- 新增验收 `tests/test.motion.spec.mjs`：中间帧截图 + 计算样式断言 + reduced-motion + 静态属性检查 + 功能回归（mock 上游）
- 版本号：versionCode 9 / versionName 1.4.0-beta.2（本轮仅本地验证与 5181 部署，未发布 APK / 未打 tag）

## 1.4.0-beta.1 (2026-11-17) — 内测版

> 内测版包：服务地址与模型已固定，用户只需填写 API Key。下载页与 GitHub Release 均标注「内测版」（pre-release）。

- 服务地址、模型、服务类型在**构建期固定**（`INTERNAL_BUILD=1 pnpm build:internal`，versionCode 8 / versionName 1.4.0-beta.1）：
  - 服务地址固定为 `http://123.207.199.196:60010`，模型固定为 `deepseek-v4.1-flash`，服务类型固定为「Anthropic 协议」预设（该上游只有 `/v1/messages`，没有 `/anthropic` 前缀，且不带 `anthropic-version` 头以免中转 CORS 预检失败）
  - 三项常量集中在 `src/services/api/internalBuild.ts` 一处，改地址/模型只改这里
  - 这些值**不写 localStorage**：内测包不再读取已存的地址/模型/服务类型，`setBaseUrl`/`setModel`/`setProviderKind` 变为空操作
- 设置页隐藏编辑入口：`providers.ts` 的 spec 新增 `fixed` 概念，固定项的 `baseUrl`/`model` 不进 `fields`，因此不渲染「服务地址」「模型」输入行；可选项只剩一个 spec 时不渲染「服务类型」下拉
- **API Key 仍由用户填写**（唯一可编辑项），保存前的 `/v1/models` 校验、连通性测试按钮行为不变
- 移除设置页「位置信息」（location / 所在地）：UI 项整段删除，`settings.location`、`src/services/location.ts` 与 `latestReminder` 的读取逻辑保留但不再暴露入口；`createLatestReminder` 在没有位置信息时**省略该段**，不再产生空段或 `undefined`
- 协议适配零改动：deepseek / anthropic / openai 三条链路的路径、字段门控（REQUEST_GATES）、翻译器（`openaiAdapter.ts`）逐字未变；正式构建（`pnpm build`）行为与 1.3.0 完全一致
- 测试：9 个既有 spec 全绿（对标准构建，断言未削弱）；新增 `tests/test.internal-build.spec.mjs`（内测构建验收：DOM 只有 API Key、请求 URL/模型固定、扩展字段剥离、localStorage 不落固定项、console error=0）与本地 mock 上游 `tests/mock-anthropic.mjs`（node 标准库，监听 `123.207.199.196:60010` 并回标准 Anthropic SSE）

## 1.3.0 (2026-11-17)

- 设置页新增第三个服务类型「OpenAI 兼容 / OpenAI-compatible」（versionCode 7）：可自填服务地址、API Key 与模型，发消息走 `POST /v1/chat/completions`，鉴权头为 `Authorization: Bearer <key>`，模型探测走 `GET /v1/models`
- 新增协议翻译层 `src/services/api/openaiAdapter.ts`：
  - 请求方向：`system` → messages 头部 `{role:'system'}`；user/assistant 原样映射，block 数组只取 `type:'text'`（图片/文档直接丢弃）；`safety_check`/`title`/`tools` 沿用 REQUEST_GATES 不发；`thinking` 直接丢弃（OpenAI 无对应字段，`reasoning_effort` 不是通用 chat/completions 参数）；必带 `stream: true` 与 `stream_options.include_usage`
  - 响应方向：OpenAI SSE → Anthropic 事件流，序列固定为 `message_start → content_block_start → content_block_delta* → content_block_stop → message_delta(stop_reason + usage) → message_stop`；`finish_reason` 映射 `stop→end_turn`、`length→max_tokens`、`tool_calls/function_call→end_turn`、`content_filter→refusal`
  - 脏数据容错：空 `choices`、`delta` 空对象、`: ping` 注释行、非 JSON 的 data 行、同一 chunk 多条 choices（只取 index 0）、没有 `[DONE]` 的断流都能正常收尾不卡死；上游若下发 `reasoning_content` 会另开一个 thinking 块
- OpenAI 兼容模式只保留基础对话（流式文本、停止、重新生成 / 编辑 / 分支）：智能搜索、附件/图片、语音输入、朗读、自动标题、深度思考入口全部隐藏（由 `caps` 驱动，DOM 里 `count=0`）
- deepseek / anthropic 两种模式零影响：三条路径、四个私有字段、能力降级行为与 1.2.3 逐字一致，原有回归断言仍全绿
- 测试：新增 `tests/test.openai-adapter.spec.mjs`（28 项断言，直接 import 适配器，不启浏览器）并纳入 `tests/run-acceptance.mjs`（覆盖 openai 路径/鉴权头/请求体/端到端逐字渲染/能力降级 + 原有 deepseek/anthropic 回归）

## 1.2.3 (2026-11-17)

- 设置页新增「服务类型」下拉（versionCode 6）：
  - **DeepSeek 官方**（默认）：只需填 API Key，服务地址与模型使用内置默认值；`/models`、`/anthropic/v1/messages`、`/v1/tools` 三条路径与改造前逐字一致，`safety_check`/`title`/`tools`/`latest_reminder`/`thinking` 原样发送
  - **Anthropic 协议**：可自填服务地址与模型，路径改为 `/v1/models`、`/v1/messages`，鉴权同为 `x-api-key`
- Anthropic 兼容模式**只保留基础对话**：流式文本、停止、重新生成/编辑/分支与可选「深度思考」（自动补 `budget_tokens: 4096`）可用；智能搜索、阅读链接、自动标题、附件/图片、语音输入、朗读等入口在界面上隐藏或置灰，不会出现「发了请求却静默丢弃」的半吊子适配
- Anthropic 兼容模式请求体自动剥离 DeepSeek 私有字段：不发 `safety_check`、`title`、`tools` 与 `role:'latest_reminder'`；`latest_reminder` 的内容折进 `system` 前缀，信息不丢
- 上游返回网页（`text/html`，通常是路径填错或网关异常）时给出明确中文错误，不再把 HTML 当回答显示
- 新增本地 mock 端到端验收 `tests/run-acceptance.mjs` 及 8 个专项回归用例（路径/请求体/能力降级/HTML 上游/旧配置兼容等），不依赖真实上游
- 测试脚本默认使用 `http://127.0.0.1:5181`（安全上下文），语音输入用例不再因非 HTTPS 页面被置灰而失败

## 1.2.2 (2026-11-17)

- 修复设置页「测试」按钮误报 `Invalid api key`：探测请求改用 API Key 输入框的当前值，而不是 store 里已保存（可能为空）的旧值，不必先点「确定」再测试（versionCode 5）
- 未填写 API Key 时点「测试」会直接提示「请先填写 API Key」，不再发出空 `Authorization: Bearer` 请求
- 新增 Playwright 回归测试 `tests/test.probe-auth.spec.mjs`、`tests/test.probe-nokey.spec.mjs`

## 1.2.1 (2026-11-17)

- 允许 Android WebView 混合内容，修复 http 上游地址无法连通的问题（versionCode 4）

## 1.2.0 (2026-11-17)

- 新增聊天背景图功能：支持选择本地图片作为聊天背景，图片压缩至 1600px 上限后存入 IndexedDB，提供亮/暗主题遮罩保证可读性（versionCode 3）
- 数据库版本 11 → 12 迁移，新增 appAssets 表，迁移过程不丢数据
- 设置页新增「聊天背景」配置项，支持应用/更换/清除背景

## 1.1.0 (2026-11-17)

- 新增服务地址（Service URL）与模型可配置，API Key 本地存储（versionCode 2）
- 新增 API Key 连通性测试，配置错误提示更清晰
- 历史记录导入错误提示优化

## 1.0.0 (2026-11-17)

- 首个版本：Capacitor 套壳 Android 应用（versionCode 1）
- 支持自定义服务地址访问 DeepSeek 兼容接口
