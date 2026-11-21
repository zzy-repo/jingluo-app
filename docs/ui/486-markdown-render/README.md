# #486 P0：代码块行号 / 换行、公式复制、表格复制 GFM、代码下载（验收截图）

**这是浏览器视口截图（Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
pnpm build
node scripts/shot-mobile.mjs --page=486-markdown-render --viewport=390,360
```

会话 fixture 由脚本本地写进 IndexedDB：一条带**代码块（14 行，第 4 行故意超长）/ 三列表格 /
行间公式 / 行内公式**的回答。所有断言都在 `PAGES['486-markdown-render']` 的 `run()` 里，
`metrics.json` 是它的落盘量数 —— 这张图想说明的每一件事都有一个数字跟着。

## 文件

| 文件 | 内容 |
| --- | --- |
| `390/486-markdown-render-01-默认-无行号-折行-390.png` | 默认态：没有行号，长行折行（= 改造前的现状，基线不许被这次改动改动） |
| `390/486-markdown-render-02-行号开-390.png` | 点「行号」：1…14 与逻辑行一一对应，折行后的续行仍对齐源码列 |
| `390/486-markdown-render-03-行号开-换行关-横向滚动-390.png` | 再点「换行」：`white-space: pre`，长行改成 `pre` 内横向滚动（页面不横向滚） |
| `390/486-markdown-render-04-刷新后开关仍生效-390.png` | **刷新页面后**：行号仍开、换行仍关（持久化证据） |
| `390/486-markdown-render-05-行号开-换行开-390.png` | 把「换行」再打开：折行 + 行号同时生效 |
| `390/486-markdown-render-06-表格悬停出复制-390.png` | 悬停表格：右上角浮出「复制表格」 |
| `390/486-markdown-render-07-表格已复制-390.png` | 点完复制：按钮变 ✓，剪贴板里是标准 GFM（量数见下表） |
| `390/486-markdown-render-08-行间公式悬停出复制-390.png` | 悬停行间公式：右上角浮出「复制 TeX 源码」 |
| `390/486-markdown-render-09-行间公式已复制-390.png` | 点完复制：剪贴板是纯 TeX，不带 `$$` |
| `390/486-markdown-render-10-行内公式复制入口-键盘聚焦-390.png` | 行内公式：按钮聚焦后由父级 `:focus-within` 显形（键盘可达，不是不可见的 Tab 停靠点） |
| `390/486-markdown-render-11-行内公式已复制-390.png` | `Enter` 触发后剪贴板是行内公式的纯 TeX |
| `390/486-markdown-render-12-代码已下载-390.png` | 点「下载代码」：Web 端落 Blob 下载，toast「已保存」 |
| `360/…-360.png` | 同上十二张，360 × 740 档 |

`metrics.json` 在每个宽度目录下（`390/metrics.json` / `360/metrics.json`）。

## 量到的数字

| 项 | 390 | 360 |
| --- | --- | --- |
| 默认态 `data-line-numbers` / `data-wrap` | `false` / `true` | `false` / `true` |
| 默认态 `white-space` | `pre-wrap` | `pre-wrap` |
| 点「行号」后行号个数（逻辑行 14） | 14（`1`…`14`） | 14（`1`…`14`） |
| 行号字形到源码列的空隙 `gutterGap` | 6.5px | 6.5px |
| 折行续行与首段左边缘差（悬挂缩进） | 0px（57.8 / 57.8） | 0px（57.8 / 57.8） |
| 关「换行」后 `white-space` / pre 内是否横向滚动 | `pre` / `true`（1197 > 350） | `pre` / `true`（1197 > 320） |
| **刷新后** `data-line-numbers` / `data-wrap` | `true` / `false`（未回落） | `true` / `false`（未回落） |
| 表格复制按钮 opacity（悬停前 → 后） | 0 → 1 | 0.24 → 1（过渡中读数） |
| 表格剪贴板 | 5 行标准 GFM（见下） | 同左 |
| 行间公式剪贴板 | `\int_0^1 x^2\,\mathrm{d}x = \frac{1}{3}` | 同左 |
| 行内公式剪贴板 | `a^2 + b^2 = c^2` | 同左 |
| 下载文件名 / 字节 / 是否与代码块一致 | `snippet.py` / 427 / `true` | 同左 |
| **`overflowCount`** | **0** | **0** |
| **`consoleErrors`** | **`[]`** | **`[]`** |

表格剪贴板原文（两档一致，`tableClipboard.text`）：

```text
| 能力 | 开关位置 | 默认值 |
| :--- | :---: | ---: |
| 行号 | 标题栏「行号」 | 关 |
| 换行 | 标题栏「换行」 | `开` |
| 公式复制 | 公式右上角 | **悬停出现** |
```

## 口径

- `overflowCount` 只统计**页面级**溢出：元素右边缘超出视口、且**没有任何祖先**能吃掉这段宽度
  （`overflow-x` 为 auto / scroll / overlay）。宽表与长代码行是**故意**在自己的滚动容器里横滚的，
  那部分不撑破页面；一旦它们把文档撑宽（`documentScrollWidth > clientWidth`），这条会立刻红。
- 行号采用「每行一个块级 span + 行内数字 + 悬挂缩进」，不是「行号槽 + 代码列」两列式：
  两列式在折行时会让下面所有行号错位，而这里量到折行续行与首段的左边缘差是 0px。
- 行号关闭时渲染走原来的整段 `innerHTML`，一条标签都不多（默认态 `gutterItems = 0` 就是这条的证据）。

## 观察与未测边界

- 行号 / 换行两个开关落的是**既有** `chat-demo:*` 键（`services/settings.ts`），与语言、主题、
  阅读设置同一份 store；刷新（`page.reload` 后重新进会话）读回的是同一个值。
- 公式复制取的是 `.katex-mathml annotation[encoding="application/x-tex"]` 里的 TeX 原文，
  不是可见字形；取不到时回落到 mdast 的同一个 `value`。
- 下载走 `utils/savePlainText.ts → services/exportText.ts::saveTextFile`：Android 是 `ExportText`
  原生桥（SAF 面板），Web 是 Blob 下载。**本图为 Web 分支**；原生分支需要真机 / 模拟器（未测）。
- 未测边界：真机 / 模拟器上的 SAF 保存与取消；深色主题下的行号对比度；≥500 行代码块切换时的
  长任务耗时；公式超宽时的横向滚动与按钮位置。
