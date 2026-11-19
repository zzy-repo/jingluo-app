# #213 `:has()` → 显式状态类：渲染契约截图（390 / 360）

**这些图是在桌面 Chromium 里截的浏览器视口截图，不是 WebView 实机截图。**

- 引擎：`HeadlessChrome/156.0.8078.4`（`navigator.userAgent`，见 `metrics.json`）
- 视口：390×844 / 360×740，DPR 2
- 产物 CSS：`dist/static/css/main.<hash>.css`（真实打包产物，`pnpm build` 后截）
- DOM：按 `MarkdownAstRenderer` 现在的输出结构手写复现（标题 / 段落是否带 `ds-markdown-before-ul|ol`），
  用于固定「类名 → 间距」这条契约。**没有在 Chromium 83 / WebView 83 上跑过**（见 #213 未测边界）。

## 看什么

| 面板 | DOM | 期望 `margin-bottom` |
| --- | --- | --- |
| 有状态类：标题后紧跟列表 | `<h4 class="ds-markdown-before-ul">` + `<ul>` | `8px`（贴合，原 `h4:has(+ ul)` 的效果） |
| 无状态类：标题后是段落 | `<h4>` + `<p class="ds-markdown-paragraph">` | `16px`（默认间距，不应被收紧） |
| 思考内容：`h3` + 有序列表 | `.ds-think-content .ds-markdown h3.ds-markdown-before-ol` | `4px`（thinking 主题的贴合档） |
| 思考内容：段落 + 有序列表 | `.ds-markdown-paragraph.ds-markdown-before-ol` | `4px`（合并重复选择器后的那一条） |

`metrics.json` 是页面里 `getComputedStyle(...).marginBottom` 的实测回读，390 与 360 两档数值一致。

## 为什么这里只能截「现代内核」

`:has()` 首支持 Chromium 105，本机没有 WebView 83 环境可跑真实降级表现（#213 已把这条写进未测边界）。
本单去掉 `:has()` 之后，**Chromium ≥ 105 上的渲染结果与修复前完全一致**（同样的 8px / 4px），
变化的只有 < 105 的内核：旧写法在 83 上整条规则被丢弃、间距退回默认值，新写法在 83 上照样生效。
所以截图证明的是「契约仍然成立、没有误伤默认间距」，等价性由 `blockSpacing.ts` 的判定单测 +
打包产物 `grep -c ':has(' = 0` 共同背书。
