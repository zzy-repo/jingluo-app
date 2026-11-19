# 类别 2：CSS 特性与 `@supports` 回退假设盘点

> 追踪单 **#209「能力探测替代一切假设」** 的类别 2 产出。本单**只盘点、只记录、只拆单**，不改任何 `src/**` 产品代码。
>
> - 盘点工具：`scripts/lib/cssAssumptionAudit.mjs`（`auditCssAssumptions(files)` 纯判定函数，不碰盘、不联网、不起浏览器）
> - 单元测试：`tests/unit/css-assumption-audit.test.mjs`
> - 盘点日期：2026-11-19 12:19 (+0800)
> - 快照基准：`9e9f231`（`origin/main` tip，2026-11-19 12:28:21 +0800）
> - 采集时间：2026-11-19 12:19 (+0800)

## 0. 口径

| 项 | 值 |
| --- | --- |
| 扫描范围 | `src/**` 全部源文件 **240** 个（`.css` **44** 个，其中 `*.module.css` **37** 个；其余 `.ts / .tsx / .html` 共 **196** 个） |
| 口径拆分 | 44 `.css` + 141 `.ts` + 54 `.tsx` + 1 `.html` = 240 |
| 命中总数 | **331** 处，分布在 **39** 个文件 |
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
| 嵌套 `&` | — （构建期） | 136 | 136 | 0 | 0 | 0 | 0 | lightningcss 按 `chrome >= 83` 展开，非运行时假设 |
| flex `gap` | 84 | 109 | 109 | 0 | 0 | 0 | 0 | 兜底已全覆盖（#217 补齐最后 2 处）；`check:gap` 口径见 §2.6 |
| `min()` / `max()` | 79 | 21 | 0 | 21 | 0 | 0 | 0 | 79 ≤ 83，无风险 |
| `:has()` | 105 | **0** | 0 | 0 | 0 | 0 | 0 | 16 处已由 #213 清零：改成渲染期显式状态类 `ds-markdown-before-ul` / `ds-markdown-before-ol`，低内核上零特性依赖 |
| `:focus-visible` | 86 | 13 | 13 | 0 | 0 | 0 | 0 | 13 处已由 #215 补齐：每处都有同选择器的 `:focus` 兜底 + `:focus:not(:focus-visible)` 收回；`pnpm run check:focus` 守住 |
| `@supports` 块（9 处 `(height/max-height: 100dvh)` + 2 处 `(scrollbar-gutter: …)`） | 108 | 11 | 11 | 0 | 0 | 0 | 0 | **11/11 前置等价兜底**：9 处有 `vh` 基座；2 处（`MessageList.module.css:18,68`，#216 / #236）有常驻 `overflow-y: scroll` 槽位 |
| `overscroll-behavior` | 63 | 6 | 0 | 6 | 0 | 0 | 0 | 63 ≤ 83，无风险 |
| `env(safe-area-inset-*)` | 69 | 5 | 0 | 5 | 0 | 0 | 0 | 69 ≤ 83，无风险（见 §5 的一致性备注） |
| `getComputedStyle` 声明回读 | — （运行时） | 3 | 3 | 0 | 0 | 0 | **0** | #218 已修：`viewport.ts:55`、`scrollToFirstMessage.ts:30`、`collector.ts:701` 三处都有实测回读，假阳性归零（历史条目见 §3） |
| `touch-action` | 36 | 3 | 0 | 3 | 0 | 0 | 0 | 36 ≤ 83，无风险 |
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
| **合计** | | **331** | **288** | **37** | **1** | **5** | **0** | |

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

### 2.6 flex `gap`（109 处：全部已有兜底；#217 补齐了最后 2 处）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| 37 个 `*.module.css` + `markdown.css` 共 109 处 | flex 容器上的 `gap` / `row-gap` | 2 | 低 | 已有兜底（`html[data-flex-gap-fallback]` + `margin` 块，由 `pnpm run check:gap` 逐条产出清单） |
| `components/markdown/markdown.css:370` | `.md-code-block-switch { display:flex; gap:4px }`，文件不是 CSS Module、原先不在 `check:gap` 扫描范围 | 2 | 低 | **#217 已补**：裸写 `html[data-flex-gap-fallback]` 兜底块（` :global()` 在非 module 文件里非法），扫描范围同时扩到全部 `.css` |
| `components/messages/ReplyArea.module.css:224` | `.toolBody { display:flex; flex-wrap:wrap; row-gap:6px }`，原先被 `flex-wrap` 排除规则放过 | 2 | 低 | **#217 已补**：`margin-bottom: 6px`；排除规则改为「交叉轴 gap 只在**不换行**时才不需要兜底」 |

> 口径（#217 之后统一）：`pnpm run check:gap` 报「扫描 **44** 个 CSS 文件（其中 **37** 个 CSS Module）：已兜底 **111** 条，跳过 **3** 条」。44 = `find src -name '*.css' | wc -l`；3 条跳过 = #159 的 `Settings.module.css:.backgroundRow` 1 条 + 非 flex 容器 2 条。原先的两种口径（37 module / 109 处 vs 含非 module 的 109 处）已合并成同一个口径。

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
| `components/session/MobileHeader.module.css:29`<br>`components/settings/AppUpdateField.module.css:57`<br>`components/settings/Settings.module.css:865` | `touch-action`（3 处） | 2 | 低 | 无需探测（36 ≤ 83） |
| `components/base/Modal.module.css:25`<br>`components/chatInput/DragMask.module.css:12` | `backdrop-filter`（2 处；`DragMask.module.css:11` 另有 `-webkit-backdrop-filter` 前缀版） | 2 | 低 | 无需探测（76 ≤ 83） |
| `components/base/Modal.module.css:95` | `:where(.content)[data-motion-state='closed']` | 2 | 低 | 可接受降级（88 > 83，只丢收起动画） |
| 22 个文件 / 136 行 | 嵌套 `&`（`:hover` / `&.x` / `&[aria-…]`），逐文件行号见附录 A | 2 | 低 | 已有兜底（构建期 lightningcss 展开） |

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

- `src/services/chat/history/urlImport.ts:1055` 的 `clamp(...)` 是 TypeScript 里的数值函数，不是 CSS `clamp()`。
- `src/services/uploadExts.ts:747` 的 `'svh'` 是文件扩展名白名单里的一项，不是 `svh` 长度单位。
- `src/index.html` **没有任何 CSS**：它只有 ES5 时代的启动守卫（`Promise` / `fetch` / `ResizeObserver` / `CSS.escape` / `Intl.DisplayNames` 等 API 探测 + 12 秒启动超时），属于类别 1 的范围。
- 仓库根的 `index.html`（APK 下载落地页，不进打包）`:12` 有一处 `env(safe-area-inset-bottom)`，**没有 `0px` 缺省值**。该页在外部浏览器里打开，不跑在 WebView 83 上，且 `env()` 首支持 Chromium 69，**无风险**。
- `env(safe-area-inset-*)` 的缺省值写法不一致：`Settings.module.css:846` 写了 `, 0px`，而 `Toast.module.css:3`、`SessionView.module.css:68`、`Welcome.module.css:152`、`Settings.module.css:689` 与上面的根 `index.html:12` 都没写。`env()` 的缺省值不写时按 `0px` 处理，**不构成缺陷**，仅记录为一致性备注。
- `src/app/theme.ts:6,26,27,58`、`src/components/messages/ReadingBars.tsx:104,106`、`src/utils/usePresence.ts:18` 用 `matchMedia` 做媒体查询判断 —— 探的是**媒体查询结果**而不是 CSS 特性支持度，不属于本类。
- `src/services/diagnostics/collector.ts:689` 的注释与 `:718` 的 `getComputedStyle(...).display` 用于诊断事实收集（判断元素是否可见），同一文件内有布局盒实测，判定为正确姿态。
- **`CSS.supports` 现在藏在包装函数后面**：#212 统一能力探测后，`src/utils/capabilities.ts:107-114` 的 `cssSupports()` 先取 `host.CSS` 再以绑定形式调用 `css.supports(property, value)`，字面量不是 `CSS.supports(`，静态扫描抓不到（`collector.ts:465` 就是这样间接调用的）。记为探测盲区，见 §6 第 2 条。

## 6. 未测边界

1. **没有在任何真机 / 模拟器上跑过 Chromium 83。** 本单全部结论是「代码判据 + 规范行为 + MDN 版本表」的静态推断。与 `docs/compat/matrix/README.md` §8 的定位一致：矩阵与盘点都不等于真机验证。
2. **组件内联 `style` 属性字符串、CSS-in-JS 生成的样式不在扫描范围**（`matrix-scan` 亦有同样的已知盲区）。本次盘点只覆盖 `.css` / `*.module.css` 文件、脚本里的 `CSS.supports` / `getComputedStyle` 调用、以及 `<style>` 块。另外一个新暴露的盲区：**经过包装函数间接调用的探测抓不到** —— #212 之后 `src/utils/capabilities.ts:114` 用绑定形式调用 `css.supports(...)`，静态匹配会漏，凡新增包装层都需要人工在 §1 补一行。
3. 首支持版本号取自 MDN / caniuse 的公开表（`dvh` 108、`:has()` 105、`@container` 105、`:focus-visible` 86、`:where()/:is()` 88、`inset` 87、flex `gap` 84、`scrollbar-gutter` 94、`min()/max()` 79、`overscroll-behavior` 63、`touch-action` 36、`env()` 69、`backdrop-filter` 76、`color-mix()` 111、`aspect-ratio` 88、`text-wrap` 114、`@layer` 99、`accent-color` 93），**没有逐条在 83 内核上实测**。
4. `:focus-visible` 的实际可见性风险有一档不确定性：若系统/浏览器默认 focus ring 未被项目 CSS 的 `outline` 规则覆盖，低内核上焦点仍可能可见。需要实测才能定档（已写进 #215 的未测边界）。
5. 没有统计「同一特性被 lightningcss 部分降级」的情形（例如 `color-mix()` 在低目标下会被翻成静态色）。本次 `color-mix()` 命中为 0，暂无影响。

## 附录 A：嵌套 `&` 命中位置（136 行 / 22 文件，全部构建期展开）

```
components/base/Button.module.css: 22, 27, 36, 40, 44, 77, 88, 97, 108, 112, 118, 122
components/base/IconButton.module.css: 16, 24, 28, 37, 41, 45
components/base/Menu.module.css: 30, 43
components/base/Modal.module.css: 34
components/base/Select.module.css: 24, 28, 37, 41, 45, 109
components/base/Toast.module.css: 50
components/chatInput/ChatInput.module.css: 60, 70, 197, 284, 288, 293, 298, 328, 332
components/chatInput/VoiceButton.module.css: 34, 40, 44, 53, 57
components/files/FileCard.module.css: 15, 23
components/markdown/CodeBlock.module.css: 32, 38
components/markdown/markdown.css: 94
components/messages/AssistantMessage.module.css: 3, 5, 43, 55, 59, 106, 161, 163
components/messages/ReplyArea.module.css: 14, 61, 75, 78, 102, 147, 152, 154, 167, 171, 175, 180, 182, 265
components/messages/UserMessage.module.css: 6, 10, 69
components/search/SearchPanel.module.css: 51
components/search/SiteLogo.module.css: 47
components/session/MobileHeader.module.css: 31, 40, 44, 50
components/sessio
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
