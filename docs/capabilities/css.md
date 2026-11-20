# 类别 2：CSS 特性与 `@supports` 回退假设盘点

> 追踪单 **#209「能力探测替代一切假设」** 的类别 2 产出。本单**只盘点、只记录、只拆单**，不改任何 `src/**` 产品代码。
>
> - 盘点工具：`scripts/lib/cssAssumptionAudit.mjs`（`auditCssAssumptions(files)` 纯判定函数，不碰盘、不联网、不起浏览器）
> - 单元测试：`tests/unit/css-assumption-audit.test.mjs`
> - 盘点日期：2026-11-19 12:19 (+0800)
> - 快照基准：`acf6826`（`origin/main` tip，2026-11-19 12:28:21 +0800）
> - 采集时间：2026-11-19 18:55 (+0800)
> - 写盘：`node scripts/gen-capabilities-docs.mjs`（`pnpm gen:capabilities`，`pnpm check:capabilities-docs` 只比对不写）——本文件的机器可读数字与 §1 逐特性计数都由它重算，**别手改**

## 0. 口径

| 项 | 值 |
| --- | --- |
| 扫描范围 | `src/**` 全部源文件 **316** 个（`.css` **46** 个，其中 `*.module.css` **39** 个；其余 `.ts / .tsx / .html` 共 **270** 个） |
| 口径拆分 | 46 `.css` + 200 `.ts` + 69 `.tsx` + 1 `.html` = 316 |
| 命中总数 | **350** 处，分布在 **38** 个文件 |
| 运行时下限 | WebView **83**（Chromium 83）。**首支持 ≤ 83 的特性一律记「无风险」，与有没有兜底无关** |
| 构建期因素 | `rspack.config.ts` 用 `builtin:lightningcss-loader`，`targets` 取自 `package.json` 的 `browserslist`（强制含 `chrome >= 83`）。**已被构建期翻译掉的写法不算运行时假设** |

### 判定分类（5 类）

| 判定 | 含义 | 风险 |
| --- | --- | --- |
| `无风险` | 特性首支持 ≤ Chromium 83，低内核上本来就认 | 低 |
| `已有兜底` | 等价兜底（`vh`/`100vh` 基座、`html[data-flex-gap-fallback]` 块、物理属性降级、构建期展开） | 低 |
| `可接受降级` | 无兜底，但低内核上的降级方向是「少一层装饰/优雅回退」，不影响内容与操作 | 低 |
| `真实缺陷` | 无兜底且低内核上实质损坏（规则整体被丢、功能静默失效、可访问性丢失） | 中/高 |
| `假阳性` | **探测通过（或判定通过）但效果为 0**，且判定过程没有任何实测回读 —— #173 的那一类 | 高 |

`已有兜底` 与 `真实缺陷` 的分界不是「有没有写 `@supports`」，而是**兜底是否等价**：`@supports (max-height: 100dvh)` 前必须先有一条 `max-height: … 100vh`，否则低内核上整条规则消失、什么都拿不到。

## 1. 逐特性命中统计

| 特性 | 首支持 Chromium | 命中 | 已有兜底 | 无风险 | 可接受降级 | 真实缺陷 | 假阳性 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 嵌套 `&` | — （构建期） | 149 | 149 | 0 | 0 | 0 | 0 | lightningcss 按 `chrome >= 83` 展开，非运行时假设 |
| flex `gap` | 84 | 112 | 112 | 0 | 0 | 0 | 0 | 兜底已全覆盖（#217 补齐最后 2 处；W1-C1 / W1-C2 的新样式由 `pnpm run gen:gap` 补齐）；`check:gap` 口径见 §2.6 |
| `min()` / `max()` | 79 | 17 | 0 | 17 | 0 | 0 | 0 | 79 ≤ 83，无风险（W1-C1 弹层宽高上限新增 2 处） |
| `:has()` | 105 | **0** | 0 | 0 | 0 | 0 | 0 | 16 处已由 #213 清零：改成渲染期显式状态类 `ds-markdown-before-ul` / `ds-markdown-before-ol`，低内核上零特性依赖 |
| `:focus-visible` | 86 | 17 | 17 | 0 | 0 | 0 | 0 | 16 处全部合规：每处都有同选择器的 `:focus` 兜底 + `:focus:not(:focus-visible)` 收回（#215；W1-C1 的 `.tab` / `.input` 按同一套三件套写）；`pnpm run check:focus` 守住 |
| `@supports` 块（9 处 `(height/max-height: 100dvh)` + 2 处 `(scrollbar-gutter: …)`） | 108 | 11 | 11 | 0 | 0 | 0 | 0 | **11/11 前置等价兜底**：9 处有 `vh` 基座；2 处（`MessageList.module.css:18,68`，#216 / #236）有常驻 `overflow-y: scroll` 槽位 |
| `overscroll-behavior` | 63 | 6 | 0 | 6 | 0 | 0 | 0 | 63 ≤ 83，无风险 |
| `env(safe-area-inset-*)` | 69 | 6 | 0 | 6 | 0 | 0 | 0 | 69 ≤ 83，无风险（见 §5 的一致性备注） |
| `getComputedStyle` 声明回读 | — （运行时） | 3 | 3 | 0 | 0 | 0 | **0** | #218 已修：`viewport.ts:55`、`scrollToFirstMessage.ts:30`、`collector.ts:723` 三处都有实测回读，假阳性归零（历史条目见 §3） |
| `touch-action` | 36 | 5 | 0 | 5 | 0 | 0 | 0 | 36 ≤ 83，无风险 |
| `backdrop-filter` | 76 | 2 | 0 | 2 | 0 | 0 | 0 | 76 ≤ 83，无风险（`-webkit-` 前缀另计 1 处） |
| `inset` | 87 | 16 | 16 | 0 | 0 | 0 | 0 | 构建期由 lightningcss 翻成物理属性，非运行时假设（§2.7） |
| `scrollbar-gutter` | 94 | 5 | 0 | 0 | 0 | **5** | 0 | 声明被丢，滚动条出现时横向跳动 → #216 / #236。**5 处里有 2 处是 `@supports` 收回块本身**，且判定器不认「常驻 `overflow-y: scroll`」这种跨属性等价兜底，所以 5 处全记 `真实缺陷`；人工核对结论见 §2.5 / §4 |
| `:where()` / `:is()` | 88 | 1 | 0 | 0 | 1 | 0 | 0 | 只影响收起动画，降级可接受 |
| `@container` | 105 | **0** | 0 | 0 | 0 | 0 | 0 | 1 处已由 #214 清零：判据换成 `.filesWithDocuments` 里的自定义属性 `--message-file-reason-display`，低内核上零特性依赖 |
| `container-type` | 105 | **0** | 0 | 0 | 0 | 0 | 0 | 同上 → #214（容器本来就不需要浏览器去量） |
| `CSS.supports(...)` 直接调用 | — （运行时） | 0 | — | — | — | — | 0 | #212 统一能力探测后，产品代码不再直接写 `CSS.supports(`，改走 `src/utils/capabilities.ts` 的 `cssSupports()` 包装（见 §5） |
| `dvh` / `svh` / `lvh` 裸用 | 108 | 0 | — | — | — | 0 | 0 | **全部被 `@supports` 包住，零裸用** |
| `clamp()` | 79 | 0 | — | — | — | 0 | 0 | 未使用 |
| `aspect-ratio` | 88 | 0 | — | — | — | 0 | 0 | 未使用 |
| `text-wrap` / `text-wrap: balance` | 114 | 0 | — | — | — | 0 | 0 | 未使用 |
| `color-mix()` | 111 | 0 | — | — | — | 0 | 0 | 未使用（且 lightningcss 会降级） |
| `@layer` | 99 | 0 | — | — | — | 0 | 0 | 未使用 |
| `accent-color` | 93 | 0 | — | — | — | 0 | 0 | 未使用 |
| **合计** | | **350** | **308** | **36** | **1** | **5** | **0** | |

> `100dvh` 的每一处声明，**没有一处**落在 `@supports` 之外（`dvh` 裸用命中数为 0）。这是本仓 #13 之后形成的最好的一条既有纪律，也是本次盘点最重要的**正面结论**：`dvh` 这一类零缺陷。

## 2. 明细表

列定义：`文件:行 | 假设内容 | 类别 | 风险(高/中/低) | 处置(已有兜底/需探测/需动态验证/拆单)`。类别固定为 **2**（CSS 特性）。

### 2.1 `@supports` 块（11 处，全部已有等价兜底）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `app/App.module.css:105` | `@supports (height: 100dvh)`，块外 `:107` 前有 `height: var(--app-viewport-height, 100vh)`（`:107`） | 2 | 低 | 已有兜底 |
| `components/chatInput/ChatInput.module.css:228` | `@supports (max-height: 100dvh)`，块外 `:227` 有 `max-height: calc(var(--app-viewport-height, 100vh) - 120px)` | 2 | 低 | 已有兜底 |
| `components/messages/MessageList.module.css:18` | `@supports (scrollbar-gutter: stable both-edges)` 现代内核收回 `overflow-y: auto`（#216），块外 `:13` 有常驻 `overflow-y: scroll` | 2 | 低 | 已有兜底 |
| `components/messages/MessageList.module.css:68` | `@supports (scrollbar-gutter: stable)` 窄屏收回块（#236），块外同媒体查询里先写 `overflow-y: scroll` | 2 | 低 | 已有兜底 |
| `components/settings/AppUpdateField.module.css:24` | `@supports (max-height: 100dvh)`，块外 `:21` 有 `min(70vh, calc(…, 100vh) - 32px)` | 2 | 低 | 已有兜底 |
| `components/settings/AppUpdateField.module.css:37` | 同上，`@media (max-height: 760px)` 内的孪生块，块外 `:33` | 2 | 低 | 已有兜底 |
| `components/settings/OursServices.module.css:50` | `@supports (max-height: 100dvh)`，块外 `:49` 有 `vh` 基座 | 2 | 低 | 已有兜底 |
| `components/settings/OursServices.module.css:256` | 同上（原 `:243`，代码位移后行号变了），块外有 `vh` 基座 | 2 | 低 | 已有兜底 |
| `components/settings/Settings.module.css:804` | `.deleteConfirm`（原 `:781`），块外有 `vh` 基座 | 2 | 低 | 已有兜底 |
| `components/settings/Settings.module.css:842` | `.feedbackDialog`（原 `:819`），块外有 `vh` 基座 | 2 | 低 | 已有兜底 |
| `components/settings/Settings.module.css:861` | `.feedbackMain`（原 `:838`），块外有 `vh` 基座 | 2 | 低 | 已有兜底 |

### 2.2 `:has()`（原 16 处，现 0 处 —— #213 已修复）

处置方式：`:has()` 的语义是「标题/段落后紧跟列表」，而**渲染期就知道**这件事（mdast 里下一个兄弟节点）。
所以由 `components/markdown/MarkdownAstRenderer.tsx` 在已知状态时打显式类名（判定函数在
`components/markdown/blockSpacing.ts`），CSS 只写 `h4.ds-markdown-before-ul` 这类**普通选择器**组合。
不用 `@supports selector(:has(*))` 兜底 —— 那条在 Chromium 83 上本身就可能解析异常。

| 原位置 | 假设内容 | 类别 | 风险 | 处置（#213） |
| --- | --- | --- | --- | --- |
| `components/markdown/markdown.css:67,68,69,70,71,72` | `h4..h6:has(+ ul\|ol)` 贴合标题与列表间距 | 2 | 中 | 改 `h4..h6.ds-markdown-before-ul\|ol`，渲染期打标，83 上等价 |
| `components/messages/thinking.markdown.css:57,58,59,60,61,62,63,64` | `h3..h6:has(+ ul\|ol)`，同构 8 条 | 2 | 中 | 同上（`h3..h6`），83 上等价 |
| `components/messages/thinking.markdown.css:71,72` | `p:has(+ ol)`，两条完全重复（复制粘贴） | 2 | 中 | 合并为一条 `.ds-markdown-paragraph.ds-markdown-before-ol`，83 上等价 |

### 2.3 `:focus-visible`（13 处，已由 #215 全部补齐）

修复前的形态是「焦点环只有 `:focus-visible` 一个来源」：Chromium 83 不认识这个伪类，整条选择器列表失效 → 规则被丢 → 键盘用户完全看不到焦点环。下表行号是**修复前**的位置。

现在的写法是三条规则一组（同选择器）：

```css
&:focus { /* 兜底：Chromium 83 只认这段 */ }
&:focus:not(:focus-visible) { /* 收回现代内核的鼠标点击态 */ }
&:focus-visible { /* 键盘态：现代内核正常渲染 */ }
```

`:focus:not(:focus-visible)` 本身在 83 上也是无效选择器 → 整条被丢 → 兜底环留下；现代内核里它把鼠标点击后的环收回，避免「点一下就出环」的回归。`pnpm run check:focus`（`scripts/lib/focusVisibleAudit.mjs`）逐条校验三件事：同选择器的 `:focus` 真的给出了可见焦点环（只写 `outline: none` 不算）、配了收回规则、没有更窄的 at-rule 上下文。

| 文件:行（修复前） | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/base/Button.module.css:28,100` | 焦点环唯一来源，同规则无 `:focus` | 2 | 中 | #215 已修（`.button` / `.dangerOutlined`） |
| `components/base/IconButton.module.css:29` | 同上 | 2 | 中 | #215 已修 |
| `components/base/Select.module.css:29` | 同上 | 2 | 中 | #215 已修（`inset` 环） |
| `components/chatInput/VoiceButton.module.css:45` | 同上 | 2 | 中 | #215 已修 |
| `components/markdown/markdown.css:95` | `.ds-markdown a:not(.ds-a):focus-visible` 链接焦点 | 2 | 中 | #215 已修（`:95` 那条 `&:hover, :focus` 是后代选择器，本来就不是这个链接的兜底） |
| `components/session/MobileHeader.module.css:32` | 同上 | 2 | 中 | #215 已修 |
| `components/session/Welcome.module.css:82` | 同上 | 2 | 中 | #215 已修（`outline` 环） |
| `components/settings/OursServices.module.css:172` | 同上（`:221` 另有 `&:focus` 不同选择器，不构成回退） | 2 | 中 | #215 已修 |
| `components/settings/Settings.module.css:64,247,1121` | 同上 | 2 | 中 | #215 已修（`navItem` / `themeOption` / `douyinPill`） |
| `components/sider/Sider.module.css:158` | 同上 | 2 | 中 | #215 已修（`inset` 环） |

### 2.4 容器查询（2 处，真实缺陷 → #214，已修）

> #214 已修：这 2 处是同一件事的两半——`.imageThumb` 上 `container-type: inline-size` 当容器，
> 再用 `@container (max-width: 63px)` 在窄缩略图上 `display: none` 掉失败原因。二者**整条 / 整块**被 83 丢弃，
> 于是 `64px` 那一档（`64 - 2×1px = 62px ≤ 63px`）又冒两行白字糊住缩略图。
> 缩略图宽度本来就由 `UserMessage.module.css` 的 `.filesWithDocuments { --message-file-image-size: 64px }`
> 决定，与视口无关（`flex-shrink: 0` + `flex-wrap: wrap`），**没有等价的 `@media`**；
> 等价写法是把判据翻成同一个类里的 `--message-file-reason-display: none`，`.reason` 写
> `display: var(--message-file-reason-display, flex)`（默认 flex = 基线，自定义属性 49 起就有）。
> `src/**` 现在 0 处容器查询；新增守卫 `pnpm run check:container`
> （`scripts/lib/containerQueryAudit.mjs` + `tests/unit/container-query-fallback.test.mjs`）持续盯
> 「0 处容器查询」+「就算写也必须块外有等价基线」。下表是**修前**的盘点快照，本节数字不再逐行重算。

| 文件:行（修前） | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/messages/MessageFile.module.css:28` | `container-type: inline-size` | 2 | 中 | #214 已删（容器不再需要） |
| `components/messages/MessageFile.module.css:95` | `@container (max-width: 63px) { .reason { display: none } }` | 2 | 中 | #214 已删，改成 `--message-file-reason-display` |

修后对应的两处（供下一轮核对）：

| 文件:行（修后） | 内容 |
| --- | --- |
| `components/messages/UserMessage.module.css:26-31` `.filesWithDocuments` | `--message-file-image-size: 64px` + `--message-file-reason-display: none` |
| `components/messages/MessageFile.module.css:84` `.reason` | `display: var(--message-file-reason-display, flex)` |

### 2.5 `scrollbar-gutter`（2 处 → 5 处：3 处声明 + 2 处 `@supports` 收回块 → #216 / #236，均已修）

> #216 已修：`.container` 外面先写 `overflow-y: scroll`（槽位恒宽，不依赖 `scrollbar-gutter`），
> 再由 `@supports (scrollbar-gutter: stable both-edges)` 把它收回 `auto`；窄屏分支显式写死 `overflow: hidden`
> 防兜底泄漏。上表两行是**修前**的盘点快照，本节数字不再逐行重算；新增守卫 `pnpm run check:gutter`
> （`scripts/lib/scrollbarGutterAudit.mjs` + `tests/unit/scrollbar-gutter-fallback.test.mjs`）持续盯「每处都有等价回退」。
>
> #236 已修：窄屏（< 768px）滚动这件事换手给了 `.scroll`，它原来一条 `scrollbar-gutter` 都没写，
> 于是 #216 的兜底照不到它。处置与 #216 同形（常驻槽位 + `@supports` 收回），但**只在会出现
> 占位式滚动条的环境里做**（嵌套两层媒体查询：窄屏 + `(hover: hover) and (pointer: fine)`），
> overlay 滚动条的手机不被占宽度。实测数据见 `scripts/measure-narrow-scroll-shift.mjs`
> （`pnpm run measure:scroll-shift`）。

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/messages/MessageList.module.css:13` | `scrollbar-gutter: stable both-edges` 预留滚动条槽 | 2 | 中 | #216 已修（前置 `overflow-y: scroll` 常驻槽位，不依赖 `scrollbar-gutter`） |
| `components/messages/MessageList.module.css:18` | `@supports (scrollbar-gutter: stable both-edges)` 收回块（同一行另计入 §2.1） | 2 | 中 | #216 已修（收回块，兜底在 `:13`） |
| `components/messages/MessageList.module.css:33` | `scrollbar-gutter: auto` 复位（初始值，低内核丢弃等于没写） | 2 | 中 | #216 已修（同分支显式写死 `overflow: hidden`，防兜底泄漏） |
| `components/messages/MessageList.module.css:68` | `@supports (scrollbar-gutter: stable)` 窄屏收回块（同一行另计入 §2.1） | 2 | 中 | #236 已修（同作用域 `overflow-y: scroll` 兜底） |
| `components/messages/MessageList.module.css:71` | `scrollbar-gutter: stable` 预留窄屏 `.scroll` 的滚动条槽 | 2 | 中 | #236 已修（指针作用域内 `overflow-y: scroll` + 同作用域 `@supports` 收回） |

> **判定口径（这段别读成「没修好」）**：静态判定器给 `scrollbar-gutter` 的 `fallback` 是 `null` —— 它不认「同一条规则附近先写常驻
> `overflow-y: scroll`」这种**跨属性等价兜底**，也不区分 `@supports (scrollbar-gutter: …)` 是「探测」还是「收回块」，于是这 5 行
> 全部落进 `真实缺陷`。人工核对（加上守卫 `pnpm run check:gutter`，判据是「每处 `scrollbar-gutter` 都有等价回退」）的结论是：
> 3 处声明都已覆盖，2 处 `@supports` 就是收回块本身。**判定规则不改**：放宽到认 `overflow-y: scroll` 会顺手放过真正没兜底的写法，
> 要不要放宽留给后续单。本文档的职责是把「规则怎么算」和「人怎么核」分开写清楚。

### 2.6 flex `gap`（126 处：全部已有兜底；#217 补齐了最后 2 处）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| 38 个 `*.module.css` + `markdown.css` 共 120 处 | flex 容器上的 `gap` / `row-gap` | 2 | 低 | 已有兜底（`html[data-flex-gap-fallback]` + `margin` 块，由 `pnpm run check:gap` 逐条产出清单） |
| `components/markdown/markdown.css:370` | `.md-code-block-switch { display:flex; gap:4px }`，文件不是 CSS Module、原先不在 `check:gap` 扫描范围 | 2 | 低 | **#217 已补**：裸写 `html[data-flex-gap-fallback]` 兜底块（` :global()` 在非 module 文件里非法），扫描范围同时扩到全部 `.css` |
| `components/messages/ReplyArea.module.css:224` | `.toolBody { display:flex; flex-wrap:wrap; row-gap:6px }`，原先被 `flex-wrap` 排除规则放过 | 2 | 低 | **#217 已补**：`margin-bottom: 6px`；排除规则改为「交叉轴 gap 只在**不换行**时才不需要兜底」 |
| `components/messages/AssistantMessage.module.css:21,27` | `.waiting { display:flex; flex-wrap:wrap; column-gap:6px; row-gap:2px }`（#328 等待提示可能出现第二行） | 2 | 低 | **#328 已补**：`margin-right: 6px` + `margin-bottom: 2px`，由 `pnpm run check:gap` 生成 |
| `components/settings/PaymentTrailDialog.module.css:71,113` | `.tabs { display:flex; flex-wrap:wrap; gap:6px }`（#326 状态筛选页签）与 `.moreError { display:flex; flex-wrap:wrap; gap:8px }`（#326 加载更多失败行） | 2 | 低 | **#326 已补**：两处都生成 `html[data-flex-gap-fallback]` 兜底块（`.tabs` 用 `margin-right/bottom: 6px`，`.moreError` 用 `margin-right/bottom: 8px`），`pnpm run check:gap` 报「已兜底 121 条」 |

> 口径（#217 之后统一）：`pnpm run check:gap` 报「扫描 **48** 个 CSS 文件（其中 **41** 个 CSS Module）：已兜底 **150** 条，跳过 **3** 条」。41 = `find src -name '*.module.css' | wc -l`；3 条跳过 = #159 的 `Settings.module.css:.backgroundRow` 1 条 + 非 flex 容器 2 条。（#501 复核：`#499` 登录/注册页、`#502`/`#505` 面板与账户消费页进场后口径从 45/38/121 漂到这里，本条与 `tests/unit/flex-gap-fallback.test.mjs` 的模块数断言同步。）原先的两种口径（38 module / 109 处 vs 含非 module 的 109 处）已合并成同一个口径。

### 2.7 `inset`（16 处，构建期降级 → 已有兜底）

`inset` 首支持 Chromium 87，但 lightningcss 按 `chrome >= 83` 会把它翻成 `top/right/bottom/left`（`docs/compat/matrix/README.md` §4 实测 dist 里 `inset` 为 **0 处**，可交叉验证）。

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `app/App.module.css:3,28,77` | `inset: 0` 铺满 | 2 | 低 | 已有兜底（构建期翻译） |
| `app/ErrorBoundary.module.css:9` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/base/Modal.module.css:4,22` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/chatInput/ChatInput.module.css:68,99` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/chatInput/DragMask.module.css:3` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/chatInput/VoiceButton.module.css:79,90` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/messages/MessageFile.module.css:54` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/search/SearchPanel.module.css:60` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/session/SessionView.module.css:3` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/session/Welcome.module.css:3` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/sider/Sider.module.css:282` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |

### 2.8 无风险特性（首支持 ≤ Chromium 83）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/base/Toast.module.css:9`<br>`components/markdown/markdown.css:184,195`<br>`components/messages/MessageFile.module.css:88`<br>`components/session/Welcome.module.css:43`<br>`components/settings/AppUpdateField.module.css:21,26,33,40`<br>`components/settings/PaymentRecords.module.css:4,5`<br>`components/settings/PaymentTrailDialog.module.css:4,5`<br>`components/settings/PurchaseRecordsDialog.module.css:6,7`<br>`components/settings/Settings.module.css:204,209,344,846,860,862` | CSS `min()` / `max()`（21 处） | 2 | 低 | 无需探测（79 ≤ 83） |
| `app/global.css:52`<br>`components/base/Select.module.css:82`<br>`components/chatInput/ChatInput.module.css:193`<br>`components/messages/MessageList.module.css:42`<br>`components/settings/AppUpdateField.module.css:59`<br>`components/settings/Settings.module.css:866` | `overscroll-behavior[-y]`（6 处） | 2 | 低 | 无需探测（63 ≤ 83） |
| `components/base/Toast.module.css:3`<br>`components/session/SessionView.module.css:68`<br>`components/session/Welcome.module.css:152`<br>`components/settings/Settings.module.css:689,846` | `env(safe-area-inset-*)`（5 处） | 2 | 低 | 无需探测（69 ≤ 83）；缺省值一致性见 §5 |
| `components/messages/AssistantMessage.module.css:152,180`<br>`components/session/MobileHeader.module.css:29`<br>`components/settings/AppUpdateField.module.css:57`<br>`components/settings/Settings.module.css:875` | `touch-action`（5 处） | 2 | 低 | 无需探测（36 ≤ 83）；#347 / #353 给折叠区开关补了第 5 处 |
| `components/base/Modal.module.css:25`<br>`components/chatInput/DragMask.module.css:12` | `backdrop-filter`（2 处；`DragMask.module.css:11` 另有 `-webkit-backdrop-filter` 前缀版） | 2 | 低 | 无需探测（76 ≤ 83） |
| `components/base/Modal.module.css:95` | `:where(.content)[data-motion-state='closed']` | 2 | 低 | 可接受降级（88 > 83，只丢收起动画） |
| 22 个文件 / 141 行 | 嵌套 `&`（`:hover` / `&.x` / `&[aria-…]`），逐文件行号见附录 A | 2 | 低 | 已有兜底（构建期 lightningcss 展开） |

> `services/diagnostics/collector.ts:465` 不在上表里：它是 `#212` 的包装函数 `cssSupports()` 间接调用，字面量不是 `CSS.supports(`，
> 静态扫描抓不到（§5 末条已记过这个盲区）。上一版把它单列一行「无需探测」，属于把复算结果和人工补记混在一张表里，本版挪到正文。

## 3. 假阳性清单（#209 验收项：至少 1 个被正确识别）

**当前假阳性 0 条**（复算 `summary.falsePositives.length === 0`）：#218 修完之后三处 `getComputedStyle` 都有实测回读，判定器不再报假阳性。下面两张表是**历史条目**，保留下来是为了下一轮知道「当年长什么样、凭什么算假阳性、后来怎么修的」——不是删掉了事。

| # | 位置 | 探测形式 | 为什么是假阳性 | 同仓正确姿态对照 | 单号 |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/app/viewport.ts:29`（#218 修前） | 历史类：`getComputedStyle(element)` → 读 `.overflowX` / `.overflowY` 匹配 `/auto\|scroll/` 即认为「这里能滚」 | 读的是**声明值**。声明 `overflow-y: auto` 只说明「溢出时允许滚」，不说明此刻存在可滚距离：高度链断开时盒子无界、`scrollHeight === clientHeight`，判定照样通过 → 放行 `touchmove` → 容器滚不动、整页也没被锁 → **手指在动、内容一像素不动、零报错** | `src/components/session/scrollToFirstMessage.ts:30` 读同一个属性，但判据是「声明命中 **且** `scrollHeight - clientHeight > 0`」，有实测回读 | **#218** |
| 2 | （类别级：`#173` 之前的探测写法，无单点位置） | 历史类：`CSS.supports('gap', …)` / `@supports (gap: 12px)` | 解析通过即认为 flex `gap` 生效 | `gap` 自 Chromium 66 起作为多列/grid 属性存在，#173 已确认 WebView 83 上两种探测都返回「支持」，而 flex `gap` 要 Chromium 84 → 探测通过、间距为 0 | `src/utils/flexGap.ts`：离屏造 flex 容器量 `getBoundingClientRect` 差值 ≥ 7.5 才判定支持，再挂 `html[data-flex-gap-fallback]` | 已由 #173 关闭；守卫 `pnpm run check:gap` 现报 0 条假阳性探测 |

**结论（2026-11-19 12:19 复算）**：两类都清零了。#173 那一类（CSS 探测 flex `gap`）由 `check:gap` 守着，实测 `forbidden = 0`；换宿主到 JS 声明值回读的那一类（第 1 条）已由 #218 修掉——`viewport.ts` 现在读的是实测回读而不是纯声明值，复算 `falsePositives = 0`。**判定规则一行没动**（`LAYOUT_CONTEXTUAL` / `judgeProbe` 原样在），下一个人按同一个骨架写还是会报出来。

判定规则写在 `scripts/lib/cssAssumptionAudit.mjs` 的 `LAYOUT_CONTEXTUAL` / `judgeProbe`：**同一文件里存在实测回读（`scrollHeight` / `clientHeight` / `getBoundingClientRect` / `getClientRects` / `checkVisibility`）的，降级为「已有兜底」；没有回读的才是假阳性。** 这条规则保证「按正确姿态写的代码不会被误报成缺陷」。

## 4. 真实缺陷与拆单（7 单）

| 单号 | 特性 / 形态 | 命中 | 风险 | 一句话 |
| --- | --- | --- | --- | --- |
| [#213](https://github.com/zzy-repo/deepseek-app/issues/213) | `:has()` | 16 | 中 | 低内核上整条选择器列表被丢，标题与列表间距退回默认值 |
| [#214](https://github.com/zzy-repo/deepseek-app/issues/214) | `@container` + `container-type` | 2 | 中 | 已修：容器查询整块被丢，窄缩略图上仍渲染两行失败原因；判据换成自定义属性 `--message-file-reason-display`，`src` 里容器查询归零 |
| [#215](https://github.com/zzy-repo/deepseek-app/issues/215) | `:focus-visible` | 13 | 中 | 已修：每处补 `:focus` 兜底 + `:focus:not(:focus-visible)` 收回，`check:focus` 守住不回流 |
| [#216](https://github.com/zzy-repo/deepseek-app/issues/216) | `scrollbar-gutter` | 2 | 中 | 声明被丢，滚动条出现/消失瞬间消息列表横向跳动 |
| [#236](https://github.com/zzy-repo/deepseek-app/issues/236) | `scrollbar-gutter`（#216 的 follow-up） | 1 | 中 | 窄屏滚动容器 `.scroll` 换手后没继承 #216 的兜底，classic 滚动条出现时仍跳 15px |
| [#217](https://github.com/zzy-repo/deepseek-app/issues/217) | flex `gap` 兜底覆盖面 | 2 | 中 | 已修：`check:gap` 扫全部 `.css`，`flex-wrap` 排除规则改为「不换行才排除」 |
| [#218](https://github.com/zzy-repo/deepseek-app/issues/218) | `getComputedStyle` 声明回读 | 1 | **高** | 已修：`viewport.ts:55` 补实测回读，复算 `falsePositives` 归零（§3 的第 1 条） |

> **本轮复算仍然记 5 处 `真实缺陷` 的只有 `scrollbar-gutter`**（`MessageList.module.css:13 / :18 / :33 / :68 / :71`）：静态判定器不认「常驻 `overflow-y: scroll`」这种跨属性等价兜底，也不区分 `@supports (scrollbar-gutter: …)` 是探测还是收回块，所以 5 行全部落进 `真实缺陷`。人工核对 + `pnpm run check:gutter` 的结论是 3 处声明都已覆盖、2 处 `@supports` 就是收回块本身（明细见 §2.5）。**这条不改判定规则**，把口径写清楚比改宽规则重要——改宽会顺手放过真正没兜底的写法。

## 5. 不算命中 / 需要说明的边界项

盘点过程中被 grep 出来、经核对**不属于** CSS 特性假设的，一并记下来，避免下一轮重复怀疑：

- `src/services/chat/history/urlImport.ts:813` 的 `clamp(...)` 是 TypeScript 里的数值函数，不是 CSS `clamp()`。
- `src/services/uploadExts.ts:747` 的 `'svh'` 是文件扩展名白名单里的一项，不是 `svh` 长度单位。
- `src/index.html` **没有任何 CSS**：它只有 ES5 时代的启动守卫（`Promise` / `fetch` / `ResizeObserver` / `CSS.escape` / `Intl.DisplayNames` 等 API 探测 + 12 秒启动超时），属于类别 1 的范围。
- 仓库根的 `index.html`（APK 下载落地页，不进打包）`:12` 有一处 `env(safe-area-inset-bottom)`，**没有 `0px` 缺省值**。该页在外部浏览器里打开，不跑在 WebView 83 上，且 `env()` 首支持 Chromium 69，**无风险**。
- `env(safe-area-inset-*)` 的缺省值写法不一致：`Settings.module.css:846` 写了 `, 0px`，而 `Toast.module.css:3`、`SessionView.module.css:68`、`Welcome.module.css:152`、`Settings.module.css:689` 与根 `src/index.html`（那里根本没有 `env()` 用法）都没写。`env()` 的缺省值不写时按 `0px` 处理，**不构成缺陷**，仅记录为一致性备注。
- `src/app/theme.ts:6,26,27,58`、`src/components/messages/ReadingBars.tsx:104,106`、`src/utils/usePresence.ts:18` 用 `matchMedia` 做媒体查询判断 —— 探的是**媒体查询结果**而不是 CSS 特性支持度，不属于本类。
- `src/services/diagnostics/collector.ts:689` 的注释与 `:718` 的 `getComputedStyle(...).display` 用于诊断事实收集（判断元素是否可见），同一文件内有布局盒实测，判定为正确姿态。
- **`CSS.supports` 现在藏在包装函数后面**：#212 统一能力探测后，`src/utils/capabilities.ts:107-114` 的 `cssSupports()` 先取 `host.CSS` 再以绑定形式调用 `css.supports(property, value)`，字面量不是 `CSS.supports(`，静态扫描抓不到（`collector.ts:465` 就是这样间接调用的）。记为探测盲区，见 §6 第 2 条。

## 6. 未测边界

1. **没有在任何真机 / 模拟器上跑过 Chromium 83。** 本单全部结论是「代码判据 + 规范行为 + MDN 版本表」的静态推断。与 `docs/compat/matrix/README.md` §8 的定位一致：矩阵与盘点都不等于真机验证。
2. **组件内联 `style` 属性字符串、CSS-in-JS 生成的样式不在扫描范围**（`matrix-scan` 亦有同样的已知盲区）。本次盘点只覆盖 `.css` / `*.module.css` 文件、脚本里的 `CSS.supports` / `getComputedStyle` 调用、以及 `<style>` 块。另外一个新暴露的盲区：**经过包装函数间接调用的探测抓不到** —— #212 之后 `src/utils/capabilities.ts:114` 用绑定形式调用 `css.supports(...)`，静态匹配会漏，凡新增包装层都需要人工在 §1 补一行。
3. 首支持版本号取自 MDN / caniuse 的公开表（`dvh` 108、`:has()` 105、`@container` 105、`:focus-visible` 86、`:where()/:is()` 88、`inset` 87、flex `gap` 84、`scrollbar-gutter` 94、`min()/max()` 79、`overscroll-behavior` 63、`touch-action` 36、`env()` 69、`backdrop-filter` 76、`color-mix()` 111、`aspect-ratio` 88、`text-wrap` 114、`@layer` 99、`accent-color` 93），**没有逐条在 83 内核上实测**。
4. `:focus-visible` 的实际可见性风险有一档不确定性：若系统/浏览器默认 focus ring 未被项目 CSS 的 `outline` 规则覆盖，低内核上焦点仍可能可见。需要实测才能定档（已写进 #215 的未测边界）。
5. 没有统计「同一特性被 lightningcss 部分降级」的情形（例如 `color-mix()` 在低目标下会被翻成静态色）。本次 `color-mix()` 命中为 0，暂无影响。

## 附录 A：嵌套 `&` 命中位置（141 行 / 22 文件，全部构建期展开）

```
components/base/Button.module.css: 22, 27, 36, 40, 44, 77, 88, 97, 108, 112, 118, 122
components/base/IconButton.module.css: 16, 24, 28, 37, 41, 45
components/base/Menu.module.css: 30, 43
components/base/Modal.module.css: 34
components/base/Select.module.css: 24, 28, 37, 41, 45, 109
components/base/Toast.module.css: 50
components/chatInput/ChatInput.module.css: 60, 70, 197, 284, 288, 293, 298, 334, 338
components/chatInput/VoiceButton.module.css: 34, 40, 44, 53, 57
components/files/FileCard.module.css: 15, 23
components/markdown/CodeBlock.module.css: 32, 38
components/markdown/markdown.css: 94
components/messages/AssistantMessage.module.css: 3, 5, 63, 75, 79, 154, 187, 255, 257
components/messages/ReplyArea.module.css: 14, 61, 75, 78, 102, 147, 152, 154, 167, 171, 175, 180, 182, 265
components/messages/UserMessage.module.css: 6, 10, 69
components/search/SearchPanel.module.css: 51
components/search/SiteLogo.module.css: 47
components/session/MobileHeader.module.css: 31, 40, 44, 50
components/session/Welcome.module.css: 76, 81, 91, 95
components/settings/OursServices.module.css: 76, 167, 171, 180, 184, 229, 233, 237, 263
components/settings/Settings.module.css: 49, 58, 60, 63, 72, 76, 101, 249, 254, 256, 259, 265, 269, 432, 581, 597, 620, 660, 686, 690, 791, 795, 921, 925, 929, 949, 1008, 1012, 1041, 1117, 1286, 1290, 1321, 1325, 1332, 1336
components/sider/SessionItem.module.css: 15, 19, 28, 31, 33
components/sider/Sider.module.css: 63, 68, 108, 149, 153, 157, 166, 170
```

## 附录 B：复现方式

```bash
# 逐特性命中清单（不写盘、不联网，纯判定）
node --input-type=module -e "
import { auditCssAssumptions, collectSources } from './scripts/lib/cssAssumptionAudit.mjs'
const { hits, summary } = auditCssAssumptions(collectSources('./src'))
console.log(summary.files, summary.hits, JSON.stringify(summary.byVerdict))
for (const h of summary.falsePositives) console.log('FP', h.file + ':' + h.line, h.probe)
for (const h of summary.defects) console.log('DEF', h.file + ':' + h.line, h.feature)
"

# flex gap 兜底守卫（#173，本条盘点不改其逻辑）
pnpm run check:gap

# 本盘点的单元测试
node --test tests/unit/css-assumption-audit.test.mjs
```

## 复核记录

- 复核（2026-11-20 18:20，基准 `553cddd`，本单 #487 W1-B 后半分支 `feat/auth-gate-wiring`）：新增 `src/services/consumeClient.ts` 1 个 `.ts` 与 `src/components/auth/AccountRow.tsx` 1 个 `.tsx`，扫描范围 301 → **303** 个源文件（其余 253 → **255**），`.css` 仍是 48 个（`*.module.css` 41）。`AuthPages.module.css` 只新增了账号行的两条排版规则（无 `gap` / 无新特性），**没有新增样式表**，命中总数仍是 **389 处 / 41 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-20 18:05，基准 `f8b8125`，本单 #498 分支 `feat/legacy-migration-tail`）：新增 `src/legacy/migration/**` 4 个 `.ts` 与 1 个 `.tsx`，扫描范围 296 → **301** 个源文件（其余 `.ts / .tsx / .html` 248 → **253**），`.css` 仍是 48 个（`*.module.css` 41）。迁移按钮复用既有 `Settings.module.css` 的类名，**没有新增任何 `.css` / 内联样式**，命中总数仍是 **389 处 / 41 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-19 18:32，基准 `452debb`，本单 #303 分支 HEAD `204bd6e`）：新增 1 个 `.ts` 源文件（`src/services/api/keyRejection.ts`），扫描范围 246 → **247** 个源文件（`.ts` 147 → **148**，其余 `.ts / .tsx / .html` 202 → **203**），`.css` 仍是 44 个（`*.module.css` 37）。新文件是纯状态计算，**不含任何 CSS 特性假设**，命中总数仍是 **343 处 / 39 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-19 18:35，基准 `68c4d9d`，本单 #305）：`src/components/settings/logView.ts` 新增 1 个 `.ts` 源文件（扫描范围 243 → **244** 个），`Settings.module.css` 的日志预览区新增 8 处 flex `gap`（`.feedbackLogViewer` / `.feedbackLogToolbar` / `.feedbackLogToolbarRow` / `.feedbackLogChipRow` / `.feedbackLogGroupToggle` / `.feedbackLogGroupHeader` / `.feedbackLogGroup` / `.feedbackLogGroupItems`）与 4 处嵌套 `&`（`:hover` / `::placeholder` / `:focus`），因此命中总数 331 → **343**（flex `gap` 109 → **117**、嵌套 136 → **140**，其余特性未变），分布文件数仍是 39。这 8 处 gap 全部由 `pnpm run check:gap` 自动补齐 `html[data-flex-gap-fallback]` 兜底块（已兜底 111 → **119** 条），没有新增裸 gap；新增的 `@media (max-width: 420px)` 只是窄屏排版，不构成新特性假设。
- 复核（2026-11-19 19:20，基准 `1577841`，本单 #310 分支）：新增 2 个 `.ts` 源文件（`src/services/updateFailure.ts` / `src/services/updateReport.ts`），扫描范围 248 → **250** 个源文件（其余 `.ts / .tsx / .html` 204 → **206**），`.css` 仍是 44 个（`*.module.css` 37）。`AppUpdateField.module.css` 只新增诊断区排版（淡色事实列表 + 复制链接），**间距全部用 `margin`、没有新增 flex `gap`**，所以 `check:gap` 的兜底条数不变、也不需要新的 `#173-fallback` 块。**命中总数仍是 343 处 / 39 个文件**，逐特性表与 §2 明细未变。
- 复核（2026-11-19 19:50，基准 `0c89bf5`，本单 #331 分支 `chore/331-retire-buy`）：删 2 个 `.ts`（`ours/orderStore.ts`、`ours/returnParams.ts`）、加 1 个 `.ts`（`ours/storage.ts`），扫描范围 249 → **248** 个源文件（`.ts / .tsx / .html` 205 → **204**），`.css` 仍是 44 个（`*.module.css` 37）。旧支付链路删掉的是 TS 逻辑，**不含任何 CSS 特性假设**，命中总数仍是 **343 处 / 39 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-19 20:05，基准 `42a3a68`，本单 #339 分支 `fix/deepseek-model-residue-339`）：新增 1 个 `.ts` 源文件（`src/services/api/configMigration.ts`），扫描范围 248 → **249** 个源文件（其余 `.ts / .tsx / .html` 204 → **205**），`.css` 仍是 44 个（`*.module.css` 37）。`Settings.module.css` 只为内置模型的只读值加了 1 个 `.modelValue` 规则（`flex: 0 1 auto` / `min-width: 0` / `color` / 断行三件套），**没有新增 flex `gap`、没有新增嵌套 `&`、没有新特性**，命中总数仍是 **343 处 / 39 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-19 21:20，基准 `a757bec`，本单 #328 分支 `feat/wait-notice-328`）：新增 1 个 `.ts`（`src/services/chat/waitStage.ts`）与 1 个 `.tsx`（`src/components/messages/WaitNotice.tsx`），扫描范围 249 → **251** 个源文件（`.ts / .tsx / .html` 205 → **207**），`.css` 仍是 44 个（`*.module.css` 37）。`AssistantMessage.module.css` 里 `.waiting` 从固定高度改成 `min-height` + `flex-wrap`，并把 `gap: 6px` 拆成 `column-gap: 6px` / `row-gap: 2px`，因此 flex `gap` 命中 117 → **118**、命中总数 343 → **344**（其余特性未变，分布仍是 39 个文件）。这一处新增的交叉轴 `row-gap` 由 `pnpm run check:gap` 给既有兜底规则追加了 `margin-bottom: 2px`（兜底条数仍是 **119** 条，现跑现报「已兜底 119 条，跳过 3 条」），§2.6 明细已补一行。两个新文件不含任何 CSS 特性假设。
- 复核（2026-11-20 00:20，基准 `5f850a5`，本单 #346 分支 `fix/copy-diagnostic-touch-346`）：`AssistantMessage.module.css` 的 `.noticeAction`（提示条里的「改 Key / 去充值 / 复制诊断信息」）为了把命中区撑到 44px，新增 1 处 `touch-action: manipulation`（`:141`），因此 `touch-action` 命中 3 → **4**、命中总数 344 → **345**（分布仍是 39 个文件）。`display: inline-flex` / `min-height` / `min-width` / `justify-content` / `vertical-align` 都不在盘点口径里，**没有新增 flex `gap`、没有新增嵌套 `&`**，所以 `check:gap` 的兜底条数不变（仍是 119 条）。§1 逐特性表、§2.8 明细与合计行已同步。
- 复核（2026-11-20 11:40，本单 #451 分支 `feat/key-identity-451`）：新增 1 个 `.ts` 源文件（`src/services/invite/keyIdentity.ts`，Key 身份时间记录），扫描范围 255 → **256** 个源文件（其余 `.ts / .tsx / .html` 211 → **212**），`.css` 仍是 44 个（`*.module.css` 37）。新文件不含任何 CSS 特性假设；`OursServicesDialog.tsx` 新增的 Key 身份区只复用既有的 `styles.section` / `styles.value` / `styles.hint`，**没有新增 flex `gap`、嵌套 `&` 或新特性**，命中总数、逐特性表与 §2 明细未变。
- 复核（2026-11-20 01:00，基准 `519a721`，本单 #421 分支 `feat/email-adapt`）：新增 2 个 `.ts` 源文件（`src/services/invite/email.ts` 采用动作、`src/services/invite/emailCooldown.ts` 发码倒计时纯函数），扫描范围 252 → **254** 个源文件（其余 `.ts / .tsx / .html` 208 → **210**），`.css` 仍是 44 个（`*.module.css` 37）。两个新文件都不含任何 CSS 特性假设；`OursServicesDialog.tsx` 新增的邮箱区只复用了既有的 `styles.redeemForm` / `styles.input` / `styles.hint`，**没有新增 flex `gap`、嵌套 `&` 或新特性**，本单自身增量为 **0 处命中 / 0 个文件**（其创建时基准 `519a721` 为 344 处 / 39 个文件；rebase 到 `f415f5d` 后主干已因 #346 / #347 增至 **347 处 / 39 个文件**，本单不改变该合计），逐特性表与 §2 明细未变。
- 复核（2026-11-20 02:05，基准 `f6ec443`，本单 #347 / #353 分支 `fix/upstream-error-copy-347`）：`AssistantMessage.module.css` 的错误提示条为了加**折叠区「查看上游原文」**（`.noticeUpstream` / `.noticeUpstreamToggle` / `.noticeUpstreamText`）新增 2 处命中：`.noticeUpstream` 里的 `> summary` 子选择器（嵌套 `&` 140 → **141**）与折叠开关的 `touch-action: manipulation`（`touch-action` 4 → **5**，`:180`）。命中总数 345 → **347**（已有兜底 301 → **302**、无风险 38 → **39**，分布仍是 39 个文件）；`display: flex` / `flex-direction` / `min-height` / `max-height` / `overflow` / `white-space` / `overflow-wrap` 都不在盘点口径里，折叠区与主体之间的间距刻意用 `margin-top` 而不是 `gap`，所以 **`check:gap` 的兜底条数不变（仍是 119 条）**，也没有新增裸 gap。§1 逐特性表、§2.8 明细、合计行与附录 A（重新按复算结果生成）已同步。
- 复核（2026-11-20 08:30，基准 `dfe6db0`，本单 #434 / #374 分支 `fix/error-readability-434-374`）：新增 1 个 `.ts` 源文件（`src/services/api/keyFailure.ts`：Key 失效的细分与尾号），扫描范围 254 → **255** 个源文件（其余 `.ts / .tsx / .html` 210 → **211**），`.css` 仍是 44 个（`*.module.css` 37）。本单改的都是 TS / TSX（分类、提示文案、折叠区与一个 i18n key），**不含任何 CSS 特性假设**，命中总数仍是 **347 处 / 39 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-20 08:35，基准 `dfe6db0`，本单 #326 分支 `feat/payment-trail-paging-326`）：`PaymentTrailDialog.module.css` 为支付记录的分页与状态筛选新增 2 处 flex `gap` —— `.tabs`（六个状态页签换行排开，`gap: 6px`，`:71`）与 `.moreError`（「加载更多」失败提示行，`gap: 8px`，`:113`）。flex `gap` 118 → **120**、命中总数 347 → **349**（已有兜底 302 → **304**，分布仍是 39 个文件）；两处都由 `pnpm run check:gap` 生成 `html[data-flex-gap-fallback]` 兜底块（已兜底 119 → **121** 条），没有新增裸 gap；新增的 `border-radius` / `min-height` / `font-weight` 等不在盘点口径里，嵌套 `&` 未变（附录 A 不受影响）。§1 逐特性表、§2.6 明细与合计行已同步。
- 复核（2026-11-20 12:20，基准 `e5ee313`，本单 #386 分支 `feat/scroll-to-bottom-386`）：新增 1 个 `.css`（`src/components/session/ScrollToBottomButton.module.css`：输入框上方「回到底部」小圆按钮的定位、44×44 命中区、淡入 keyframes 与 reduced-motion 关断），扫描范围 256 → **259** 个源文件（`.css` 44 → **45**，其中 `*.module.css` 37 → **38**；其余 `.ts / .tsx / .html` 212 → **214**）。新文件**一处可盘点特性都没有**：没有 flex `gap`、没有 `inset`（显式写 `top/right/bottom/left`）、没有 `min()/max()`、没有 `@supports`、没有 `:focus-visible`（焦点环复用 `IconButton` 的既有三档兜底）、也没有嵌套 `&`（全部是顶层单类选择器），所以**命中总数仍是 349 处 / 39 个文件**，逐特性表与 §2 明细的 `文件:行` 一字未动。
- 复核（2026-11-20 13:35，基准 `b34ffb4`，本单 #301 分支 `feat/log-spec-301`）：新增 1 个 `.ts` 源文件（`src/services/diagnostics/reasons.ts`），扫描范围 261 → **262** 个源文件（其余 `.ts / .tsx / .html` 216 → **217**），`.css` 仍是 45 个（`*.module.css` 38）。新文件是纯常量与类型，**不含任何 CSS 特性假设**，命中总数仍是 **355 处 / 39 个文件**，逐特性表与 §2 明细的 `文件:行` 未变（本单只改 TS 侧的字面量）。
- 复核（2026-11-20 17:35，基准 `54a45f8`，本单 #487 W1-C1 分支 `feat/account-consume-page`，「账户与消费」页）：新增 1 个 `.css`（`src/components/consume/AccountConsume.module.css`：页面壳 / 卡密列表 / 套餐 / 兑换表单，**一行没复制旧弹层 CSS**），扫描范围 291 → **295** 个源文件（`.css` 47 → **48**，其中 `*.module.css` 40 → **41**；其余 `.ts / .tsx / .html` 244 → **247**）。新样式里有三类可盘点特性：flex `gap` 15 处（`pnpm run gen:gap` 生成兜底，134 → **149**，兜底同步 149）、`min()`/`max()` 2 处（79 ≤ 83 无风险，21 → **23**）、`:focus-visible` 2 处（按 #215 三件套写全，14 → **16**，兜底同步 16）。命中总数 370 → **389**、分布 40 → **41** 个文件；分类分布 = 兜底 341 / 无风险 42 / 可降级 1 / 真实缺陷 **仍 5**（`scrollbar-gutter` 那 5 处，与本单无关），假阳性 0。
- 复核（2026-11-20 16:20，基准 `d198ccc`，本单 #487 W1-A 分支 `feat/consume-layer`）：新增 9 个 `.ts` 源文件（`src/services/consume/**`），扫描范围 262 → **271** 个源文件（其余 `.ts / .tsx / .html` 217 → **226**），`.css` 仍是 45 个（`*.module.css` 38）。新文件是纯 TS 逻辑（HTTP 封装 / 错误归一 / 业务方法），**不含任何 CSS 特性假设**（无新增 `.css`、无内联样式），命中总数、逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-20 16:35，基准 `e504986`，本单 #487 W1-B 分支 `feat/auth-layer-skeleton`）：新增 1 个 `.css`（`src/components/auth/AuthPages.module.css`，登录 / 注册页），扫描范围 271 → **280** 个源文件（`.css` 45 → **46**、`*.module.css` 38 → **39**、其余 226 → **234**），命中总数 355 → **370** 处（分布 39 → **40** 个文件）。增量：嵌套 `&` 141 → **146**；flex `gap` 126 → **134**，全部由 `node scripts/gen-flex-gap-fallback.mjs` 生成 `html[data-flex-gap-fallback]` 兜底块（`真实缺陷` 仍 0）；`:focus-visible` 13 → **14**，按 #215 的三段写法（`:focus` 兜底 + `:focus:not(:focus-visible)` 收回 + `:focus-visible`）补齐，仍记 `已有兜底`；`env(safe-area-inset-*)` 5 → **6**（69 ≤ 83，`无风险`）。`真实缺陷` 仍 5、`可接受降级` 仍 1、假阳性仍 0。
- 复核（2026-11-20 17:00，基准 `3392efa`，本单 #487 W1-C2 分支 `feat/consume-panels`）：新增 1 个 `panels.module.css`（`src/components/consume/`，四个面板共用）、6 个 `.ts` 与 4 个 `.tsx`，扫描范围 280 → **291** 个源文件（`.css` 46 → **47**、`*.module.css` 39 → **40**、其余 234 → **244**）。新样式表**刻意不写 flex `gap`**（间距全部用 `margin`，理由见该文件头注释：WebView 83 上 flex gap 恒为 0，#173），也没有 `:focus-visible` / `inset` / `scrollbar-gutter` / `@supports` / 嵌套 `&`，颜色全走 `--dsw-alias-*` 令牌 —— **命中总数仍是 370 处 / 40 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 复核（2026-11-20 17:20，基准 `3392efa`，本单 #487「统一计量单位为元」分支 `chore/unify-currency-cny`）：新增 1 个 `.ts` 源文件（`src/utils/money.ts`），扫描范围 280 → **281** 个源文件（其余 `.ts / .tsx / .html` 234 → **235**），`.css` 仍是 46 个（`*.module.css` 39）。本次只动 TS（金额口径与格式化）与文档，**没有新增任何 `.css` / 内联样式**，命中总数仍是 **370 处 / 40 个文件**，逐特性表与 §2 明细的 `文件:行` 未变。
- 合并复核（2026-11-20 17:35，基准 `77cd6e8`，`chore/unify-currency-cny` rebase 到 #505 之后）：重新跑 `scripts/lib/cssAssumptionAudit.mjs`，源文件 **296** 个（`.css` **48**，其中 `*.module.css` **41**；其余 248），**命中总数 389 处 / 41 个文件**；上表三行已按复算结果更新，逐特性表与 §2 明细的 `文件:行` 未变。
