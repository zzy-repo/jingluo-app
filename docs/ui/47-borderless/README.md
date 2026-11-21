# #47 无边设计改造 · 前后对比取证

一句话结论：**主输入区 / 文档卡片 / 思考胶囊 / 次按钮 / 返回底部按钮的描边全部清零，靠「浅一档填充色 + 圆角 + 单层极轻阴影」区分区域；浅色与深色两套主题、390 与 360 两档都一样。**

- 车道：#712（车道 D · UI/UX），单：#47
- 分支：`style/47-borderless`（base = `main`）
- 只改视觉层：`data-testid` / `aria-*` / 事件绑定 / 组件导出签名 **一个都没动**（diff 只有 7 个 `*.module.css` / token 文件 + 文档：`git show --stat HEAD`，零 `.ts` / `.tsx` 改动）

## 1. 前后对比（同一屏、同一台机器、同一份构建参数）

「改前」= `origin/main`（`292fafe`），「改后」= 本分支；两边都是 `node scripts/build.mjs` 的真实产物，没有为截图改过任何布局。

| 屏 | 改前 | 改后 | 看图（390 / 360 各一张） |
| --- | --- | --- | --- |
| 首页（浅色） | 输入区 1px 灰描边 + 双层阴影 | 无描边；`rgba(0,0,0,.04)` 填充 + 单层阴影 | `390/before-light-home.png` → `390/after-light-home.png`；`360/before-light-home.png` → `360/after-light-home.png` |
| 首页（深色） | 输入区 1px 白描边（`.06` 白，深底上最扎眼） | 无描边；`.08` 白填充，比页底亮一档 | `390/before-dark-home.png` → `390/after-dark-home.png`；`360/before-dark-home.png` → `360/after-dark-home.png` |
| 长会话（浅色） | 输入区描边 + 「深度思考」胶囊蓝描边 | 胶囊改「品牌浅底」不描边 | `390/before-light-session.png` → `390/after-light-session.png`；`360/before-light-session.png` → `360/after-light-session.png` |
| 长会话（深色） | 同上，深底上一圈白线 | 同上 | `390/before-dark-session.png` → `390/after-dark-session.png`；`360/before-dark-session.png` → `360/after-dark-session.png` |
| 输入区特写（浅色） | 1px 灰框清晰可见 | 框消失，只有填充边界 | `390/before-light-session-input.png` → `390/after-light-session-input.png`；`360/before-light-session-input.png` → `360/after-light-session-input.png` |
| 输入区特写（深色） | 1px 白框 + 胶囊 1px 圈 | 两者都无、靠底色分层 | `390/before-dark-session-input.png` → `390/after-dark-session-input.png`；`360/before-dark-session-input.png` → `360/after-dark-session-input.png` |
| 文档附件卡片（浅色） | 卡片 1px 灰框 + 输入区框 | 卡片改为抬起的一格白，无框 | `390/before-light-attach.png` → `390/after-light-attach.png`；`360/before-light-attach.png` → `360/after-light-attach.png` |
| 聚焦态（只留改后） | — | 填充变深一档，**没有蓝色描边** | `390/after-light-home-focus.png`、`390/after-dark-home-focus.png`、`360/after-light-home-focus.png`、`360/after-dark-home-focus.png` |
| 胶囊未选中态（只留改后） | — | 中性填充、无描边 | `390/after-light-chip-off.png`、`390/after-dark-chip-off.png`、`360/after-light-chip-off.png`、`360/after-dark-chip-off.png` |

> 为什么这组对比能证明是「去描边」而不是「随手调了间距」：见 §2 的 `rect` 列 —— 20 个「屏 × 视口」里 **x / width 一个像素没变**，只有 `height` 少了 **2px**，正好等于去掉的上下两条 1px 描边。

## 2. 量数（`metrics-after.json` / `metrics-before.json` 逐屏摘录）

390 / 360 两档、深浅两主题、5 个状态，逐屏量的「可见描边处数」（判定口径：`border-style ≠ none` 且 `border-width > 0` 且颜色 alpha > 0，只统计 ≥2×2 的元素，见 `#root` 全树遍历）：

| 视口 | 状态 | 可见描边（改前 → 改后） | 输入区 `border-top-width` | 输入区底色（改前 → 改后） | 输入区 rect（改前 → 改后） |
| --- | --- | --- | --- | --- | --- |
| 390 | 首页·浅色 | **2 → 0** | 1px → 0px | `rgb(255,255,255)` → `rgba(0,0,0,.04)` | `16,710 358×106` → `16,712 358×104` |
| 390 | 首页·深色 | **2 → 0** | 1px → 0px | `rgb(44,44,46)` → `rgba(255,255,255,.08)` | `16,710 358×106` → `16,712 358×104` |
| 390 | 首页聚焦·浅色 | **2 → 0** | 1px → 0px | `rgb(255,255,255)` → `rgba(38,49,72,.1)` | 同上 |
| 390 | 首页聚焦·深色 | **2 → 0** | 1px → 0px | `rgb(44,44,46)` → `rgba(255,255,255,.14)` | 同上 |
| 390 | 附件卡片·浅色 | **3 → 0** | 1px → 0px | 同上 | `16,620 358×196` → `16,624 358×192` |
| 390 | 附件卡片·深色 | **3 → 0** | 1px → 0px | 同上 | `16,620 358×196` → `16,624 358×192` |
| 390 | 长会话·浅色 / 深色 | **2 → 0** | 1px → 0px | 同首页 | 同首页 |
| 360 | 首页 / 聚焦 / 附件 / 长会话（深浅） | **2~3 → 0** | 1px → 0px | 同 390 | x=16、width=328 不变；height 每次 −2px |
| 两档 | 横向溢出 | `overflowCount = 0`（改前 0 / 改后 0） | — | — | — |
| 两档 | 控制台错误 | `consoleErrors: []`（改前 / 改后都是空） | — | — | — |

改前那 2~3 处描边分别是谁（`metrics-before.json` 的 `borders.items`）：`div.wrapper`（输入区 1px）、`button.toggle`（思考胶囊 1px，「选中态」还是 `rgb(183,200,254)` 蓝框 / 深色 `rgb(72,104,178)`）、`div.card`（附件卡片 1px）。

## 3. 命令与输出

### 3.1 `grep` 证明输入区已无描边

```
$ grep -rnE 'border:\s*[0-9]|border-(top|right|bottom|left):|border-(\w+)-width|border-color:|border-style:' src/components/chatInput/
src/components/chatInput/ChatInput.module.css:89:    border: 2px solid rgba(255, 255, 255, 0.4);
src/components/chatInput/VoiceButton.module.css:177:  border: 1.5px solid var(--dsw-alias-border-l2);
```

输入区里剩下的 **只有 2 条**，都是**加载旋转环**（`ChatInput.module.css:89` 是 `.uploading::after` 的上传进度圈、`VoiceButton.module.css:177` 是录音初始化圈，紧跟的 `border-top-color` 把它切成旋转缺口）——
它们是「转圈」这个动效本身，不是区域轮廓。**容器 / 卡片 / 按钮的描边为 0**：

```
$ grep -n 'border' src/components/chatInput/ChatInput.module.css
6:  box-sizing: border-box;
11:  border-radius: 24px;
54:  box-sizing: border-box;
57:  border-radius: 16px;
88:    border-radius: 50%;
89:    border: 2px solid rgba(255, 255, 255, 0.4);   ← 加载环
90:    border-top-color: #fff;
114:  border: none;
158:  box-sizing: border-box;
183:  border: none;
184:  border-radius: 50%;
214:  box-sizing: border-box;
219:  border: none;
311:  border-radius: 18px;
312:  /* 显式 `border: none`：… */
313:  border: none;
370:  border: none;
371:  border-radius: 50%;
```

（`313: border: none` 是这次**必须写**的一条：胶囊原本靠 `border: 1px solid` 覆盖 UA 的 `button { border: 2px outset }`，删掉描边却不写 `border: none` 会**冒出 2px 黑边** —— 这条是被 `metrics` 抓到的，见 §6 负向对照。）

### 3.2 门禁

```
$ npx tsc -p tsconfig.json                      # exit 0，无输出
$ npx oxlint src                                # Found 0 warnings and 0 errors.（278 files / 100 rules）
$ node tests/run-layer.mjs unit                 # Total 217: PASS 215, FAIL 2, DEGRADED 0
$ node tests/run-golden.mjs                     # 总计 13 条：PASS 12 / FAIL 1（g15 在 main 上同红，见下）
$ node scripts/check-css-gap-fallback.mjs        # gap=0
$ node scripts/check-focus-visible-fallback.mjs  # focus=0（每处 :focus-visible 仍有 :focus 兜底）
$ node scripts/check-bundle-syntax.mjs           # legacy=0（Chromium 83：无 ?. / ??= / static {} / 顶层 await）
$ node scripts/check-test-layout.mjs --strict    # 合计：孤儿 0 / 命名违规 0 / 落位违规 0 → OK
$ node scripts/check-ui-shots.mjs                # 398 张截图全部有出处（新增 36 张）→ OK
$ node scripts/check-doc-refs.mjs                # 合格：所有引用都指得着 → exit 0
$ node scripts/check-repo-hygiene.mjs            # OK：无本机绝对路径、无超限文件 → exit 0
$ node scripts/check-capabilities.mjs            # warn 档 exit 0（10 处存量缺陷与本单无关）
$ node scripts/gen-capabilities-docs.mjs         # 本单新增 1 处嵌套 `&` → css.md 命中 338 → 339，已按生成器重写
```

`unit` 那 2 条失败**都不是本单引入**，均在干净的 `origin/main`（`292fafe`，独立 worktree）上复跑对照：

| 用例 | 本分支 | `origin/main` 对照 | 定性 |
| --- | --- | --- | --- |
| `attachment-endpoint-303` | FAIL | **FAIL** | main 存量红 |
| `quota-exhausted` | FAIL | **FAIL** | main 存量红 |

本轮开发中曾出现、已闭环的 3 条（留痕，避免下一个接手的人重复排查）：

| 用例 | 现象 | 处置 |
| --- | --- | --- |
| `container-query-fallback` | ⑦ 逐字断言 `MessageFile.module.css` 的 `.image` 仍有 `border: 1px solid`（#214「64px 窄档 = 62px 内容盒 ≤ 63px」的等价性证据） | **把该文件的描边改回原样**（不改断言）—— 见 §5「刻意保留」 |
| `capabilities-docs-sync` | 新增 1 处嵌套 `&` 使 `docs/capabilities/css.md` 复算数漂 1；另有 4 处 `文件:行` 被本单的行号位移带走 | 用 `gen-capabilities-docs.mjs` 重写 §0/§1，并**按实时命中重锚** §2.1/2.7/2.8 与附录 A（不改判定） |
| `diagnostics-stream-timing` / `gate-negative-controls` / `g04-session` | 批次满载时计时型抖动（单跑绿、`origin/main` 上同样超时） | 单跑连绿；`gate-negative-controls` 在干净 main 上同样 180s 超时 → 环境性 |

`golden`：`g15-purchase` 在**干净 main 上同样红**（同一句失败文案：`「我的额度」读到 sub2api 额度 · 期望=quota-spent 出现 · 实际=…去登录`，需要真 sub2api 登录态），其余 12 条全绿；本单**没有改任何 golden 期望值**。
`g04-session` 在并行满载时红过一次（`locator('[class*="item-"]')` click 15s 超时），**单跑连绿 2 次、满血整层复跑也绿**——负载型抖动，与本单无关。

## 4. 改了什么（按 #47 正文四条对账）

| #47 要求 | 落点 |
| --- | --- |
| ① 主输入区去 1px 描边，改浅一档填充色；聚焦用柔和阴影/轻微背景变化，不用蓝描边 | `ChatInput.module.css`：`.wrapper` 删 `border`，`background: var(--dsw-alias-bg-skeleton)`；新增 `&:focus-within { background: var(--dsw-alias-interactive-bg-active) }`（Chromium 83 支持 `:focus-within`，刻意不引入 `:focus-visible`） |
| ② 输入区内部区块去描边 | `.attachment`（64px 草稿缩略图）删 1px，底色改 `--dsw-alias-bg-base`；`.toggle`（思考/联网胶囊）删 1px + 显式 `border: none`，改填充区分选中态 |
| ③ 双层 `box-shadow` 合并成一层极轻阴影 | `.session`：两层 → `0 2px 10px rgba(0,0,0,.035)`；`.home`：三层 → `0 8px 24px rgba(0,0,0,.04)`；深色下 `none`（保持原状） |
| ④ 按钮 / 卡片统一去 border，保留或加大圆角，深色优先 | `Button.module.css`（`.outlined` 改填充、`.dangerOutlined` 常态只留红字）、`FileCard.module.css`（`.card` 去 1px，底色改 `--dsw-alias-bg-base`；`.failed`/`.pending`/`.cancelled`/`.partial` 的状态边框改成底色或纯文字色）、`AssistantMessage.module.css`（`.summary` 来源胶囊去 1px + 2px 左边框改底色）、`UserMessage.module.css`（就地编辑去品牌色 1px → 填充 + 柔和光晕）、`ScrollToBottomButton.module.css`（去 1px） |
| 全局 token（**只动描边类**） | `theme.css`：浅色 `--dsw-alias-border-l2` `.1 → .08`；深色 `--dsw-alias-border-l2` `.12 → .08`、`--dsw-alias-border-l3` `.16 → .12`。颜色语义 token 一个没动 |

## 5. 刻意保留 / 未动的地方

- **`MessageFile.module.css` 的 `.image` 1px 边框保留**：它是 #214「64px 缩略图 → 内容盒 62px ≤ 原阈值 63px」等价性证明的实测依据，`tests/unit/container-query-fallback.test.mjs` ⑦ 逐字断言这条 CSS。改它 = 改断言语义，超出「只改视觉」的边界。
- **代码块 / 表格 / 公式**（`CodeBlock.tsx`、`src/services/markdown/**`、`markdown.css` 的 code/table/katex 块）：一行未动 —— 那是 #486 的车道。
- **设置弹窗（`Settings.module.css`）、侧边栏、消费/账号页**：一行未动 —— #711 在改同一片区域，避免撞车。
- 深色 / 浅色两套主题都有实测，不是只改深色。

## 6. 负向对照（破坏它必须红 —— 两次都真跑过）

做法：临时改一处 CSS → `node scripts/build.mjs` → 用同一套 `#root` 全树普查量 390 档 → 还原 → 重新构建（还原后重截的图与正式产物 md5 一致，`7232c33e…`）。

| 破坏方式 | 期望 | 实测（390 档，10 个「主题 × 状态」） |
| --- | --- | --- |
| 把 `.wrapper` 的 1px 描边加回去（`border: 1px solid var(--dsw-alias-border-l2-darkmode-thin)`） | `borders.visible` 必须 > 0 | 10/10 屏由 **0 → 1**：`div.wrapper` / `1px` / `rgba(0,0,0,.1)`，`composer.border.top` 由 `0px` 变回 `1px`，rect 高度由 104 变回 106 |
| 删掉 `.toggle` 的 `border: none`（只删 1px 描边、不显式清零） | 可见描边必须被计数抓到 | 10/10 屏由 **0 → 1**：`button.toggle` / **`2px`** / **`rgb(0,0,0)`** —— UA 的 `button { border: 2px outset }` 顶上来。**这条是本次开发中被这套量数真抓出来的缺陷**，随后补的 `border: none` |
| 把聚焦反馈做成蓝色描边（未采用） | 聚焦态截图应能看见蓝框 | 未采用：聚焦态实测 `background-color` `rgba(0,0,0,.04)` → `rgba(38,49,72,.1)`（深色 `.08` → `.14`），`borders.visible` 仍为 **0** |

## 7. 量数原始文件

- `390/metrics-after.json`、`360/metrics-after.json`：改后（顶层 `overflowCount: 0`、`consoleErrors: []`、每屏 `borders.items`）
- `390/metrics-before.json`、`360/metrics-before.json`：改前（同一套口径）
- 截图脚本不在仓库里（`#root` 全树描边普查 + 8 个「主题 × 状态」截屏），产物即上面这些图与 metrics。
