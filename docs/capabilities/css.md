# 类别 2：CSS 特性与 `@supports` 回退假设盘点

> 追踪单 **#209「能力探测替代一切假设」** 的类别 2 产出。本单**只盘点、只记录、只拆单**，不改任何 `src/**` 产品代码。
>
> - 盘点工具：`scripts/lib/cssAssumptionAudit.mjs`（`auditCssAssumptions(files)` 纯判定函数，不碰盘、不联网、不起浏览器）
> - 单元测试：`tests/unit/css-assumption-audit.test.mjs`
> - 盘点日期：2026-11-19
> - 基线：`origin/main` @ `cb02050`（写作时的基线）
> - 快照基准：`4870b33`（`origin/main` tip，2026-11-19 11:23:55 +0800）· 采集时间：2026-11-19 11:35 (+0800)
> - 数字全部由 `scripts/lib/cssAssumptionAudit.mjs` 在快照基准上跑出来；`tests/unit/capabilities-docs-sync.test.mjs` 会重跑并逐项比对，文档落后于代码就红

## 0. 口径

| 项 | 值 |
| --- | --- |
| 扫描范围 | `src/**` 参与扫描 **237** 个文件（`.css` **44** 个，其中 `*.module.css` **37** 个；其余 `.ts / .tsx / .html` **193** 个） |
| 命中总数 | **306** 处，分布在 **39** 个文件 |
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
| 嵌套 `&` | — （构建期） | 112 | 112 | 0 | 0 | 0 | 0 | lightningcss 按 `chrome >= 83` 展开，非运行时假设 |
| flex `gap` | 84 | 109 | 109 | 0 | 0 | 0 | 0 | 兜底已全覆盖（#217 补齐最后 2 处）；`check:gap` 口径见 §2.6 |
| `min()` / `max()` | 79 | 21 | 0 | 21 | 0 | 0 | 0 | 79 ≤ 83，无风险 |
| `:has()` | 105 | **0** | 0 | 0 | 0 | 0 | 0 | 16 处已由 #213 修复（#231，`fb64b68`）清零：改成渲染期显式状态类 `ds-markdown-before-ul` / `ds-markdown-before-ol`，低内核上零特性依赖 |
| `:focus-visible` | 86 | 13 | 0 | 0 | 0 | **13** | 0 | 无 `:focus` 回退，可访问性丢失 → #215 |
| `@supports` 块（`(height/max-height: 100dvh)` 9 处 + `(scrollbar-gutter)` 1 处，见 §2.1） | 108 | 10 | 10 | 0 | 0 | 0 | 0 | **10/10 前置等价基座，写法正确** |
| `overscroll-behavior` | 63 | 6 | 0 | 6 | 0 | 0 | 0 | 63 ≤ 83，无风险 |
| `env(safe-area-inset-*)` | 69 | 5 | 0 | 5 | 0 | 0 | 0 | 69 ≤ 83，无风险（见 §5 的一致性备注） |
| `getComputedStyle` 声明回读 | — （运行时） | 3 | 3 | 0 | 0 | 0 | 0 | 3 处都带几何回读 → `已有兜底`；#218 已修（#230，`66628e3`），修前那 1 处假阳性留在 §3 备案 |
| `touch-action` | 36 | 3 | 0 | 3 | 0 | 0 | 0 | 36 ≤ 83，无风险 |
| `backdrop-filter` | 76 | 2 | 0 | 2 | 0 | 0 | 0 | 76 ≤ 83，无风险（`-webkit-` 前缀另计 1 处） |
| `scrollbar-gutter` | 94 | 3 | 0 | 0 | 0 | **3** | 0 | 站点已修（#216 → #232，`4870b33`）：`overflow-y: scroll` 基座 + `@supports` 收回。规则只认「同一条声明有没有等价回退」，看不到跨声明的等价替换，仍计 3 处缺陷（口径滞后，见 §2.5） |
| `:where()` / `:is()` | 88 | 1 | 0 | 0 | 1 | 0 | 0 | 只影响收起动画，降级可接受 |
| `@container` | 105 | 1 | 0 | 0 | 0 | **1** | 0 | 整块被丢 → #214 |
| `container-type` | 105 | 1 | 0 | 0 | 0 | **1** | 0 | 同上 → #214 |
| `CSS.supports(...)` 直接调用 | — （运行时） | 0 | — | — | — | — | 0 | #212 统一能力探测后，产品代码不再直接写 `CSS.supports(`，改走 `src/utils/capabilities.ts` 的 `cssSupports()` 包装（见 §5） |
| `dvh` / `svh` / `lvh` 裸用 | 108 | 0 | — | — | — | 0 | 0 | **全部被 `@supports` 包住，零裸用** |
| `clamp()` | 79 | 0 | — | — | — | 0 | 0 | 未使用 |
| `aspect-ratio` | 88 | 0 | — | — | — | 0 | 0 | 未使用 |
| `text-wrap` / `text-wrap: balance` | 114 | 0 | — | — | — | 0 | 0 | 未使用 |
| `color-mix()` | 111 | 0 | — | — | — | 0 | 0 | 未使用（且 lightningcss 会降级） |
| `@layer` | 99 | 0 | — | — | — | 0 | 0 | 未使用 |
| `accent-color` | 93 | 0 | — | — | — | 0 | 0 | 未使用 |
| **合计** | | **306** | **250** | **37** | **1** | **18** | **0** | |

> `100dvh` 的每一处声明，**没有一处**落在 `@supports` 之外（`dvh` 裸用命中数为 0）。这是本仓 #13 之后形成的最好的一条既有纪律，也是本次盘点最重要的**正面结论**：`dvh` 这一类零缺陷。

## 2. 明细表

列定义：`文件:行 | 假设内容 | 类别 | 风险(高/中/低) | 处置(已有兜底/需探测/需动态验证/拆单)`。类别固定为 **2**（CSS 特性）。

### 2.1 `@supports` 块（10 处，全部已有等价兜底）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `app/App.module.css:105` | `@supports (height: 100dvh)`，块外 `:107` 前有 `height: var(--app-viewport-height, 100vh)`（`:107`） | 2 | 低 | 已有兜底 |
| `components/chatInput/ChatInput.module.css:228` | `@supports (max-height: 100dvh)`，块外 `:227` 有 `max-height: calc(var(--app-viewport-height, 100vh) - 120px)` | 2 | 低 | 已有兜底 |
| `components/settings/AppUpdateField.module.css:24` | `@supports (max-height: 100dvh)`，块外 `:21` 有 `min(70vh, calc(…, 100vh) - 32px)` | 2 | 低 | 已有兜底 |
| `components/settings/AppUpdateField.module.css:37` | 同上，`@media (max-height: 760px)` 内的孪生块，块外 `:33` | 2 | 低 | 已有兜底 |
| `components/settings/OursServices.module.css:50` | `@supports (max-height: 100dvh)`，块外 `:49` 有 `vh` 基座 | 2 | 低 | 已有兜底 |
| `components/settings/OursServices.module.css:243` | 同上，`:242` 有 `vh` 基座 | 2 | 低 | 已有兜底 |
| `components/settings/Settings.module.css:781` | `.deleteConfirm`，块外 `:780` | 2 | 低 | 已有兜底 |
| `components/settings/Settings.module.css:819` | `.feedbackDialog`，块外 `:811` | 2 | 低 | 已有兜底 |
| `components/settings/Settings.module.css:838` | `.feedbackMain`，块外 `:837` | 2 | 低 | 已有兜底 |
| `components/messages/MessageList.module.css:18` | `@supports (scrollbar-gutter: stable both-edges)` 把 `:14` 的槽位声明收回 `:33` 的 `auto`，块外 `:13` 有 `overflow-y: scroll` 基座（#232 加的等价回退） | 2 | 低 | 已有兜底 |

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

### 2.3 `:focus-visible`（13 处，真实缺陷 → #215）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/base/Button.module.css:28,100` | 焦点环唯一来源，同规则无 `:focus` | 2 | 中 | 拆单 #215 |
| `components/base/IconButton.module.css:29` | 同上 | 2 | 中 | 拆单 #215 |
| `components/base/Select.module.css:29` | 同上 | 2 | 中 | 拆单 #215 |
| `components/chatInput/VoiceButton.module.css:45` | 同上 | 2 | 中 | 拆单 #215 |
| `components/markdown/markdown.css:101` | `.ds-markdown a:not(.ds-a):focus-visible` 链接焦点 | 2 | 中 | 拆单 #215 |
| `components/session/MobileHeader.module.css:32` | 同上 | 2 | 中 | 拆单 #215 |
| `components/session/Welcome.module.css:82` | 同上 | 2 | 中 | 拆单 #215 |
| `components/settings/OursServices.module.css:172` | 同上（`:221` 另有 `&:focus` 不同选择器，不构成回退） | 2 | 中 | 拆单 #215 |
| `components/settings/Settings.module.css:64,247,1121` | 同上 | 2 | 中 | 拆单 #215 |
| `components/sider/Sider.module.css:158` | 同上 | 2 | 中 | 拆单 #215 |

### 2.4 容器查询（2 处，真实缺陷 → #214）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/messages/MessageFile.module.css:28` | `container-type: inline-size` | 2 | 中 | 拆单 #214 |
| `components/messages/MessageFile.module.css:95` | `@container (max-width: 63px) { .reason { display: none } }` | 2 | 中 | 拆单 #214 |

### 2.5 `scrollbar-gutter`（复算 3 处；#216 站点已修，规则口径仍计缺陷）

> #216 已修（#232，`4870b33`）：`.container` 先写 `overflow-y: scroll`（槽位恒宽，不依赖 `scrollbar-gutter`），
> 再由 `@supports (scrollbar-gutter: stable both-edges)` 把它收回 `auto`；窄屏分支显式写死 `overflow: hidden`
> 防兜底泄漏。守卫 `pnpm run check:gutter`（`scripts/lib/scrollbarGutterAudit.mjs` +
> `tests/unit/scrollbar-gutter-fallback.test.mjs`）持续盯「每处都有等价回退」。
>
> **为什么站点修好了、复算还报 3 处缺陷**：`scripts/lib/cssAssumptionAudit.mjs` 里 `scrollbar-gutter` 这条规则的
> `fallback` 是 `null` —— 它只问「写 `scrollbar-gutter` 的那条声明自己有没有等价回退」，而 #232 的回退是
> **另一条声明**（`overflow-y: scroll`）加一个 `@supports` 包裹，规则看不见这种跨声明等价替换。这是**口径滞后**，
> 不是回归：规则不删（探测能力不能随站点一起消失），这层等价性由 `check:gutter` 覆盖，规则口径升级留给后续单。
> 下表三行是复算的真实命中。

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/messages/MessageList.module.css:13` | `overflow-y: scroll` 预留滚动条槽（#232 加的等价回退，规则不认） | 2 | 中 | 已修（#216 → #232）；规则口径滞后 |
| `components/messages/MessageList.module.css:18` | `@supports (scrollbar-gutter: stable both-edges)` 包住 `:14` 的槽位声明 | 2 | 中 | 已修（#216 → #232）；规则口径滞后 |
| `components/messages/MessageList.module.css:33` | `scrollbar-gutter: auto` 复位 | 2 | 中 | 已修（#216 → #232）；规则口径滞后 |

### 2.6 flex `gap`（109 处：全部已有兜底；#217 补齐了最后 2 处）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| 37 个 `*.module.css` + `markdown.css` 共 109 处 | flex 容器上的 `gap` / `row-gap` | 2 | 低 | 已有兜底（`html[data-flex-gap-fallback]` + `margin` 块，由 `pnpm run check:gap` 逐条产出清单） |
| `components/markdown/markdown.css:357` | `.md-code-block-switch { display:flex; gap:4px }`，文件不是 CSS Module、原先不在 `check:gap` 扫描范围 | 2 | 低 | **#217 已补**：裸写 `html[data-flex-gap-fallback]` 兜底块（` :global()` 在非 module 文件里非法），扫描范围同时扩到全部 `.css` |
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
| `components/chatInput/VoiceButton.module.css:66,77` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/messages/MessageFile.module.css:50` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/search/SearchPanel.module.css:60` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/session/SessionView.module.css:3` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/session/Welcome.module.css:3` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |
| `components/sider/Sider.module.css:269` | `inset: 0` | 2 | 低 | 已有兜底（构建期翻译） |

### 2.8 无风险特性（首支持 ≤ Chromium 83）

| 文件:行 | 假设内容 | 类别 | 风险 | 处置 |
| --- | --- | --- | --- | --- |
| `components/base/Toast.module.css:9`<br>`components/markdown/markdown.css:171,182`<br>`components/messages/MessageFile.module.css:82`<br>`components/session/Welcome.module.css:43`<br>`components/settings/AppUpdateField.module.css:21,26,33,40`<br>`components/settings/PaymentRecords.module.css:4,5`<br>`components/settings/PaymentTrailDialog.module.css:4,5`<br>`components/settings/PurchaseRecordsDialog.module.css:6,7`<br>`components/settings/Settings.module.css:191,196,321,823,837,839` | CSS `min()` / `max()`（21 处） | 2 | 低 | 无需探测（79 ≤ 83） |
| `app/global.css:52`<br>`components/base/Select.module.css:69`<br>`components/chatInput/ChatInput.module.css:193`<br>`components/messages/MessageList.module.css:42`<br>`components/settings/AppUpdateField.module.css:59`<br>`components/settings/Settings.module.css:843` | `overscroll-behavior[-y]`（6 处） | 2 | 低 | 无需探测（63 ≤ 83） |
| `components/base/Toast.module.css:3`<br>`components/session/SessionView.module.css:68`<br>`components/session/Welcome.module.css:138`<br>`components/settings/Settings.module.css:666,823` | `env(safe-area-inset-*)`（5 处） | 2 | 低 | 无需探测（69 ≤ 83）；缺省值一致性见 §5 |
| `components/session/MobileHeader.module.css:29`<br>`components/settings/AppUpdateField.module.css:57`<br>`components/settings/Settings.module.css:842` | `touch-action`（3 处） | 2 | 低 | 无需探测（36 ≤ 83） |
| `components/base/Modal.module.css:25`<br>`components/chatInput/DragMask.module.css:12` | `backdrop-filter`（2 处；`DragMask.module.css:11` 另有 `-webkit-backdrop-filter` 前缀版） | 2 | 低 | 无需探测（76 ≤ 83） |
| `components/base/Modal.module.css:95` | `:where(.content)[data-motion-state='closed']` | 2 | 低 | 可接受降级（88 > 83，只丢收起动画） |
| `cssSupports()` 包装后的调用（不是静态命中，见 §5 最后一条） | `cssSupports('height', '100dvh')` 写入诊断事实（#212 的包装函数） | 2 | 低 | 无需探测（探的是能力本身，判定正确） |
| 22 个文件 / 112 行 | 嵌套 `&`（`:hover` / `&.x` / `&[aria-…]`），逐文件行号见附录 A | 2 | 低 | 已有兜底（构建期 lightningcss 展开） |

## 3. 假阳性清单（#209 验收项：至少 1 个被正确识别）

**当前假阳性 0 条**：复算 `summary.falsePositives.length === 0`。下面这张表全部是**历史**记录（曾经的假阳性、后来怎么修的），保留是为了让「这一类骨架还会不会长回来」有据可查 —— 判定规则一条没删。

| # | 位置 | 探测形式 | 为什么是假阳性 | 同仓正确姿态对照 | 单号 |
| --- | --- | --- | --- | --- | --- |
| 历史 1 | `src/app/viewport.ts:29`（现 `:55`） | 历史类：`getComputedStyle(element)` → 读 `.overflowX` / `.overflowY` 匹配 `/auto\|scroll/` 即认为「这里能滚」 | 读的是**声明值**。声明 `overflow-y: auto` 只说明「溢出时允许滚」，不说明此刻存在可滚距离：高度链断开时盒子无界、`scrollHeight === clientHeight`，判定照样通过 → 放行 `touchmove` → 容器滚不动、整页也没被锁 → **手指在动、内容一像素不动、零报错** | `src/components/session/scrollToFirstMessage.ts:30` 读同一个属性，但判据是「声明命中 **且** `scrollHeight - clientHeight > 0`」，有实测回读 | **#218**（已修：#230，`66628e3`） |
| 历史 2 | `CSS.supports('gap', …)` / `@supports (gap: 12px)`（两处都已删） | 历史类：解析通过即认为 flex `gap` 生效 | `gap` 自 Chromium 66 起作为多列/grid 属性存在，#173 已确认 WebView 83 上两种探测都返回「支持」，而 flex `gap` 要 Chromium 84 → 探测通过、间距为 0 | `src/utils/flexGap.ts`：离屏造 flex 容器量 `getBoundingClientRect` 差值 ≥ 7.5 才判定支持，再挂 `html[data-flex-gap-fallback]` | 已由 #173 关闭；守卫 `pnpm run check:gap` 现报 0 条假阳性探测 |

**结论：产品 CSS 里 #173 那一类已清零**（`check:gap` 实测 `forbidden = 0`）；它的**同一个骨架换了宿主** —— 从 CSS 探测搬到 JS 的声明值回读 —— 那一支也已清零（#218 → #230，`66628e3`：判据改为「声明命中 **且** 布局盒回读」，`src/**` 里现存的 3 处 `getComputedStyle` 全带几何回读，落 `已有兜底`）。所以本节的「当前假阳性」是 0 条，两条都是历史。

判定规则写在 `scripts/lib/cssAssumptionAudit.mjs` 的 `LAYOUT_CONTEXTUAL` / `judgeProbe`：**同一文件里存在实测回读（`scrollHeight` / `clientHeight` / `getBoundingClientRect` / `getClientRects` / `checkVisibility`）的，降级为「已有兜底」；没有回读的才是假阳性。** 这条规则保证「按正确姿态写的代码不会被误报成缺陷」。

## 4. 真实缺陷与拆单（6 单）

| 单号 | 特性 / 形态 | 命中 | 风险 | 一句话 |
| --- | --- | --- | --- | --- |
| [#213](https://github.com/zzy-repo/deepseek-app/issues/213) | `:has()` | 16 | 中 | 低内核上整条选择器列表被丢，标题与列表间距退回默认值。**已修（#231，`fb64b68`）**，现 0 处 |
| [#214](https://github.com/zzy-repo/deepseek-app/issues/214) | `@container` + `container-type` | 2 | 中 | 容器查询整块被丢，窄缩略图上仍渲染两行失败原因 |
| [#215](https://github.com/zzy-repo/deepseek-app/issues/215) | `:focus-visible` | 13 | 中 | 无 `:focus` 回退，键盘用户完全看不到焦点环（可访问性） |
| [#216](https://github.com/zzy-repo/deepseek-app/issues/216) | `scrollbar-gutter` | 3 | 中 | 声明被丢，滚动条出现/消失瞬间消息列表横向跳动。**已修（#232，`4870b33`）**，复算仍计 3 处，见 §2.5 |
| [#217](https://github.com/zzy-repo/deepseek-app/issues/217) | flex `gap` 兜底覆盖面 | 2 | 中 | 已修：`check:gap` 扫全部 `.css`，`flex-wrap` 排除规则改为「不换行才排除」 |
| [#218](https://github.com/zzy-repo/deepseek-app/issues/218) | `getComputedStyle` 声明回读 | 1 | **高** | 判定通过但滚不动，静默失效（§3 的第 1 条）。**已修（#230，`66628e3`）**，现 0 处 |

## 5. 不算命中 / 需要说明的边界项

盘点过程中被 grep 出来、经核对**不属于** CSS 特性假设的，一并记下来，避免下一轮重复怀疑：

- `src/services/chat/history/urlImport.ts:1055` 的 `clamp(...)` 是 TypeScript 里的数值函数，不是 CSS `clamp()`。
- `src/services/uploadExts.ts:747` 的 `'svh'` 是文件扩展名白名单里的一项，不是 `svh` 长度单位。
- `src/index.html` **没有任何 CSS**：它只有 ES5 时代的启动守卫（`Promise` / `fetch` / `ResizeObserver` / `CSS.escape` / `Intl.DisplayNames` 等 API 探测 + 12 秒启动超时），属于类别 1 的范围。
- 仓库根的 `index.html`（APK 下载落地页，不进打包）`:12` 有一处 `env(safe-area-inset-bottom)`，**没有 `0px` 缺省值**。该页在外部浏览器里打开，不跑在 WebView 83 上，且 `env()` 首支持 Chromium 69，**无风险**。
- `env(safe-area-inset-*)` 的缺省值写法不一致：`Settings.module.css:823` 写了 `, 0px`，而 `Toast.module.css:3`、`SessionView.module.css:68`、`Welcome.module.css:138`、`Settings.module.css:666` 与上面的根 `index.html:12` 都没写。`env()` 的缺省值不写时按 `0px` 处理，**不构成缺陷**，仅记录为一致性备注。
- `src/app/theme.ts:6,26,27,58`、`src/components/messages/ReadingBars.tsx:104,106`、`src/utils/usePresence.ts:18` 用 `matchMedia` 做媒体查询判断 —— 探的是**媒体查询结果**而不是 CSS 特性支持度，不属于本类。
- `src/services/diagnostics/collector.ts:671` 的注释与 `:700` 的 `getComputedStyle(...).display` 用于诊断事实收集（判断元素是否可见），同一文件内有布局盒实测，判定为正确姿态。
- **`CSS.supports` 现在藏在包装函数后面**：#212 统一能力探测后，`src/utils/capabilities.ts:106-118` 的 `cssSupports()` 先取 `host.CSS` 再以绑定形式调用 `css.supports(property, value)`，字面量不是 `CSS.supports(`，静态扫描抓不到（`src/services/diagnostics/capabilityTruth.ts:74` 就是这样间接调用的）。记为探测盲区，见 §6 第 2 条。

## 6. 未测边界

1. **没有在任何真机 / 模拟器上跑过 Chromium 83。** 本单全部结论是「代码判据 + 规范行为 + MDN 版本表」的静态推断。与 `docs/compat/matrix/README.md` §8 的定位一致：矩阵与盘点都不等于真机验证。
2. **组件内联 `style` 属性字符串、CSS-in-JS 生成的样式不在扫描范围**（`matrix-scan` 亦有同样的已知盲区）。本次盘点只覆盖 `.css` / `*.module.css` 文件、脚本里的 `CSS.supports` / `getComputedStyle` 调用、以及 `<style>` 块。另外一个新暴露的盲区：**经过包装函数间接调用的探测抓不到** —— #212 之后 `src/utils/capabilities.ts:106-118` 用绑定形式调用 `css.supports(...)`，静态匹配会漏，凡新增包装层都需要人工在 §1 补一行。
3. 首支持版本号取自 MDN / caniuse 的公开表（`dvh` 108、`:has()` 105、`@container` 105、`:focus-visible` 86、`:where()/:is()` 88、`inset` 87、flex `gap` 84、`scrollbar-gutter` 94、`min()/max()` 79、`overscroll-behavior` 63、`touch-action` 36、`env()` 69、`backdrop-filter` 76、`color-mix()` 111、`aspect-ratio` 88、`text-wrap` 114、`@layer` 99、`accent-color` 93），**没有逐条在 83 内核上实测**。
4. `:focus-visible` 的实际可见性风险有一档不确定性：若系统/浏览器默认 focus ring 未被项目 CSS 的 `outline` 规则覆盖，低内核上焦点仍可能可见。需要实测才能定档（已写进 #215 的未测边界）。
5. 没有统计「同一特性被 lightningcss 部分降级」的情形（例如 `color-mix()` 在低目标下会被翻成静态色）。本次 `color-mix()` 命中为 0，暂无影响。

## 附录 A：嵌套 `&` 命中位置（112 行 / 22 文件，全部构建期展开）

```
components/base/Button.module.css: 22, 27, 31, 64, 75, 84, 95, 99
components/base/IconButton.module.css: 16, 24, 28, 32
components/base/Menu.module.css: 30, 43
components/base/Modal.module.css: 34
components/base/Select.module.css: 24, 28, 32, 96
components/base/Toast.module.css: 50
components/chatInput/ChatInput.module.css: 60, 70, 197, 284, 288, 293, 298, 328, 332
components/chatInput/VoiceButton.module.css: 34, 40, 44
components/files/FileCard.module.css: 15, 23
components/markdown/CodeBlock.module.css: 32, 38
components/markdown/markdown.css: 94
components/messages/AssistantMessage.module.css: 3, 5, 43, 55, 59, 106, 161, 163
components/messages/ReplyArea.module.css: 14, 61, 75, 78, 102, 147, 152, 154, 167, 171, 175, 180, 182, 265
components/messages/UserMessage.module.css: 6, 10, 65
components/search/SearchPanel.module.css: 51
components/search/SiteLogo.module.css: 47
components/session/MobileHeader.module.css: 31, 37
components/session/Welcome.module.css: 76, 81
components/settings/OursServices.module.css: 76, 167, 171, 216, 220, 224, 250
components/settings/Settings.module.css: 49, 58, 60, 63, 88, 236, 241, 243, 246, 399, 548, 564, 587, 627, 653, 657, 758, 762, 888, 892, 896, 916, 1081, 1085, 1116, 1120
components/sider/SessionItem.module.css: 15, 19, 28, 31, 33
components/sider/Sider.module.css: 63, 68, 108, 149, 153, 157
```

（上一版记的是 27 个文件 / 112 行；#213 把 `thinking.markdown.css` 那批并入 `markdown.css` 后收敛到 22 个文件，行数不变。）

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

# 文档与复算是否还对得上
node --test tests/unit/capabilities-docs-sync.test.mjs
```
