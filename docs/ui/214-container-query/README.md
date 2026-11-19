# issue #214：`@container` 容器查询在 WebView 83 上整块被丢弃

## 现象

容器查询（`@container` / `container-type`）首支持 Chromium **105**，本仓运行时下限是 **WebView 83（Chromium 83）**。
83 上：

- `@container` 是未知 at-rule → **整块规则被丢弃**（不是只丢一条声明）；`@supports (container-type: inline-size)` 也探测不到它；
- `container-type` 是未知声明 → **整条被丢弃**，元素不再是查询容器。

命中 2 处，都在 `src/components/messages/MessageFile.module.css`，是同一件事的两半：

| 行（修前） | 内容 | 作用 |
| --- | --- | --- |
| `:28` | `container-type: inline-size` | 把缩略图 `.imageThumb` 变成查询容器 |
| `:95` | `@container (max-width: 63px) { .reason { display: none } }` | 缩略图窄到放不下文案时，只留状态、不显示两行失败原因 |

现场：同一条消息里既有图片又有文件时，图片缩略图缩到 `64px`（`.filesWithDocuments` 那一档），
`64px` 盒减掉两侧 `1px` 边框 = `62px` 内容盒 ≤ `63px` 阈值，本该隐藏的失败原因又冒出来，把缩略图糊满。

## 修复

**两处全部删掉，判据换成自定义属性**（不保留 `@container`，也不写成 `@media` 兜底）：

- 缩略图宽度**不是浏览器量出来的**，而是我们自己给的 `--message-file-image-size`——整个 `src` 里只有一个地方
  覆盖它：`UserMessage.module.css` 的 `.filesWithDocuments { --message-file-image-size: 64px }`；另有
  `flex-shrink: 0` + `flex-wrap: wrap`，宽度与视口无关。所以「窄了就隐藏原因」的等价写法不是 `@media`
  （没有对应的视口量），而是**同一个修饰类里的另一个自定义属性**：
  `.filesWithDocuments { --message-file-reason-display: none }`。
- `.reason` 写 `display: var(--message-file-reason-display, flex)`：默认 `flex` 就是基线——任何内核
  （含 Chromium 83）都拿得到「正常显示原因」这一版；缩放档由 `64px` 的那条声明顺手关掉它。
  自定义属性 Chromium **49** 起就有，零特性假设。
- 防回归：`pnpm run check:container`（`scripts/lib/containerQueryAudit.mjs` + `scripts/check-container-query-fallback.mjs`）
  卡住「`src/**` 里 `@container` / `container-type` 一律为 0」，并在审计里逐块检查「块内声明在块外有无同一选择器的基线」
  ——`@supports` 里包一层、外面空着的写法（#173 教育过的错法）同样判红。
  `tests/unit/container-query-fallback.test.mjs` 把这个门禁挂进 `pnpm test`。

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `generate.mjs` | `node generate.mjs`：把两条真实 CSS Module 规则原样搬到裸 HTML，渲染三档变体并截图、打印 `.reason` 的计算样式 |
| `390/*.png` `360/*.png` | 390x844 / 360x740 截图（deviceScaleFactor 2），文件名即变体 |
| `390/*.html` `360/*.html` | 对应页面源码（规则由脚本从 `src/**` 抽出，跑 `generate.mjs` 会重新生成） |

为什么不直接跑 app：聊天页要出现「上传失败的图片 + 同条消息还带文件」得先造假附件并拦上传接口，
`scripts/shot-mobile.mjs` 里没有这类场景；#214 的差异只由上面那两条规则决定，规则原样搬运即可复现，不掺手写样式。

| 变体 | 含义 |
| --- | --- |
| `before-chromium83-simulated` | 修前规则，**删掉 `container-type` 声明与 `@container` 整块** = Chromium 83 的解析结果 |
| `before-chromium105plus` | 修前规则原样 = 支持容器查询的内核（105+）上的现状 |
| `after-fix` | 修后规则（`--message-file-reason-display`），任意内核 |

## 实测结论

浏览器：**Chromium 156.0.8078.4（Playwright 自带 headless），非 WebView 实机**；`isMobile`，`deviceScaleFactor: 2`。
数值取自页面里 `getComputedStyle(.reason).display`，即真实渲染结果，不是推断。

| 视口 | 变体 | 64px 档（既有图片又有文件） | 120px 档（纯图片，对照） |
| --- | --- | --- | --- |
| 390x844 | `before-chromium83-simulated` | `display: flex` — 失败原因糊满缩略图（**缺陷复现**） | `display: flex` — 正常 |
| 390x844 | `before-chromium105plus` | `display: none` — 隐藏（现代内核现状） | `display: flex` — 正常 |
| 390x844 | `after-fix` | `display: none` — 与 105+ 一致 | `display: flex` — 正常 |
| 360x740 | `before-chromium83-simulated` | `display: flex` — **缺陷复现** | `display: flex` — 正常 |
| 360x740 | `before-chromium105plus` | `display: none` | `display: flex` — 正常 |
| 360x740 | `after-fix` | `display: none` — 与 105+ 一致 | `display: flex` — 正常 |

三档缩略图实测都是 `64x64` / `120x120`，宽度确实不含视口成分。

## 未测边界

- **没有真 WebView 83 实机**。83 那一行是「把未知声明/未知 at-rule 删掉后重新渲染」得到的解析结果，
  不等于历史内核跑出来的结果（旧内核的其他排版差异不在此覆盖范围）。
- 没探 60–66px 边界：结论依赖「缩略图宽度只由 `.filesWithDocuments` 决定」这一点，若将来引入第三档宽度或
  让缩略图随容器伸缩，`--message-file-reason-display` 需要跟着那张声明一起改。
- 只覆盖「上传失败、原因写在底部渐变上」的两档（64 / 120）；重试态、多文件换行、超长文案未逐档截图。
- 截图是裸 HTML 复现两条规则，不是 app 内真实页面；外层 `.files` / 气泡的排版未纳入比对。
