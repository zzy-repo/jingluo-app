# #821 KaTeX 美化包渲染乱码（二次修复）

**背景：** #825 已把「不支持的宏」改成按块降级（`mathBlocks.ts`），不再整段露出 TeX。但美化规则用的 `\scalebox` / `\raisebox` / `\rotatebox` 在那条路径里被判成**不支持**，
于是每个示例仍显示「这一行用了不支持的排版命令 ▶ 查看原文」（真机截图），气泡本身画不出来。本次让这些命令**真的渲染**，不再降级。

**与 #825 的关系：** 保留 `planMathRender` 的整块 → 逐块降级流程不动；只在它调用的 `render` 回调里先做 `normalizeBeautifyMath`，
所以整块和逐块两条路径都走改写。真写坏的公式照旧降级。

**同一批 10 个示例的对照（模拟器，同一份灌入数据，393 / 360 宽）：**

| | `origin/main` | 本次 |
| --- | --- | --- |
| 渲染成功的公式 | 0 / 5（每个会话） | 5 / 5 |
| 「不支持的排版命令」降级块 | 6（每个会话；例 4 拆成 2 块） | 0 |
| 页面横向滚动 | — | 0 |
| `.katex-error` | — | 0 |


环境：Android 13 **模拟器**（非真机），WebView 默认字体。393 为默认宽度，360 为 `wm density 480`。
输入：`美化4.1（安卓深色）` 与 `用户同款气泡（安卓浅色）` 两份规则文件里「完整示例」各 5 个，逐字放在 `tests/fixtures/katex-beautify-821/`。

## 失败类型

**B（源码外露）。** `MathFormula` 用 `throwOnError:true`，KaTeX 不认 `\scalebox` → 抛 `Undefined control sequence`，整条消息退回原文。
两份规则共 10 个示例，修复前 10/10 抛错（`tests/unit/katex-beautify-821.test.mjs` T1b）。

顺着 B 往下还暴露了三层问题（光补 `\scalebox` 不够）：

| 层 | 现象 | 处理 |
| --- | --- | --- |
| A | `\raisebox` 里放 `\begin{array}` 报 `Can't use function '\begin' in text mode` | 内容包 `$…$` |
| A | `\scalebox{…}{\begin{array}…\end{array}}` 后紧跟一个 `\end{array}`，花括号组跨过环境边界，报 `Expected & or \\ or \cr or \end` | 把组的右括号后移到补齐 `\end` 之后 |
| C | `◖ ◗ ◣ ◢` 走各机型回退字体，大小与基线不一，气泡对不齐 | 改成 `\rule` + 固定 class，CSS 画形状 |
| D | `\rule{30em}{0pt}` 撑宽 + 块首负 `\hspace` → 公式块 600+px 横滚，内容被裁在左边界外 | 去掉 |

另：浅色气泡底（`#F0F0F0`）上的文字继承深色主题的白色，看不清 → `\colorbox` 内文字按底色明暗取深/浅。

## 安全

`trust` 不是开关，只放行改写自己生成的 `font-size`（≤10em）/`rotate`（≤360°）和 4 个固定 class；
用户手写的 `\htmlStyle{position:fixed…}`、`url(…)`、`\href`、`\includegraphics` 都拒绝（T3 / T4）。

## 截图（模拟器，修复前 / 修复后）

| 文件 | 内容 |
| --- | --- |
| `before-user-light-{393,360}.png` | 修复前：整段 LaTeX 源码外露 |
| `before-dark-light-{393,360}.png` | 同上，深色头像规则 |
| `after-user-{light,dark}-{393,360}.png` | 修复后：用户气泡，浅/深主题 |
| `after-dark-{light,dark}-{393,360}.png` | 修复后：深色头像规则，浅/深主题 |

公式块量值（`scrollWidth/clientWidth`）：393 宽 353/353；360 宽 用户气泡 337/320，头像规则 328/320。页面级横向滚动：无。`.katex-error`：0。

## 未覆盖 / 已知差距

- **真机未测。** 全部结果来自模拟器，字体渲染（`☆` 等）以真机为准。
- **头像版式只是近似。** 规则里的 `\scalebox` 是盒子整体缩放，这里用 `font-size` 近似；`\rotatebox{-90}` 用 CSS rotate 近似。深色头像规则的头像是一个圆团加小白缺口，与规则原意（圆 + 白色形状）不逐像素一致。
- **浅色主题下 ☆ 不可见**：规则把它写死成 `#ffffff`，未做主题色映射。
- 360 宽有 8~17px 的公式块内部横向滚动，页面本身不溢出。
- 没有做按消息 memo / 节点数降级（#486 §5 的性能项）。
