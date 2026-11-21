# #711 设置弹窗侧边栏下线「记忆」分组 —— 验收截图

**不是真机截图**：Playwright Chromium（headless）浏览器视口，`deviceScaleFactor=2` + `isMobile` +
`hasTouch` + `locale=zh-CN` + `reducedMotion=reduce`，390×844 与 360×740 两档。

场景定义：`scripts/shot-mobile.mjs` 的 `PAGES['711-settings-no-memory']`。它打开设置弹窗后
**先断言再截图**（不合口径直接抛错，不会留下「看着像过」的图）：

- 侧边栏 tab 数必须 `2`，文案必须恰为 `通用设置 / 数据管理`（顺序也算）；
- 任何 tab 文案都不许命中 `/记忆|Memory/`，`[data-testid="memory-embedding-toggle"]` 命中数必须 `0`；
- 默认选中 `通用设置`，切到 `数据管理` 后该面板不得为空，切回来 `通用设置` 也不得为空；
- 三个状态各量一次横向溢出，`overflowCount` 必须 `0`。

## 结论（`after/` = 本次改动后）

| 视口 | 侧边栏项数 | tab 文案 | 「记忆」文案 | `memory-embedding-toggle` | 横向溢出 | `consoleErrors` |
| --- | --- | --- | --- | --- | --- | --- |
| 390×844 | **2** | 通用设置 / 数据管理 | 无 | **0** | **0** | `[]` |
| 360×740 | **2** | 通用设置 / 数据管理 | 无 | **0** | **0** | `[]` |

数字来源：`after/390/metrics.json`、`after/360/metrics.json`（`asideGeneral` / `asideData` /
`overflowSeen` / `overflowCount` / `consoleErrors`）。

## 负向对照（`before/` = `origin/main` 旧产物，同一个场景脚本的「记录版」）

同一台机器、同一份 Chromium、同一条打开路径，只把产物换成改动前的 `origin/main`（`git worktree` +
`pnpm build`），并把场景里的**硬断言换成「点开『记忆』看一眼」**（否则它会当场抛错、拍不到旧版截图）：

| 视口 | 侧边栏项数 | tab 文案 | 点「记忆」后的面板 | `memory-embedding-toggle` |
| --- | --- | --- | --- | --- |
| 390×844 | **3** | 通用设置 / **记忆** / 数据管理 | 记忆向量化（embedding）…已关闭 | **1** |
| 360×740 | **3** | 通用设置 / **记忆** / 数据管理 | 同上 | **1** |

也就是说：**改前的入口确实在、确实点得开**，改后这两档都拍不出来 —— 不是「本来就看不见」的假绿。
反向再验一次：把改动前的产物交给 `after/` 那套硬断言，它会立刻抛
`侧边栏应只有 2 项，实际 3 项：["通用设置","记忆","数据管理"]`（这条在本单 PR 正文里贴了原文）。

## 复现方式（两档一次跑完）

```bash
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8
pnpm build                                                            # 需要先有 dist/
node scripts/shot-mobile.mjs --page=711-settings-no-memory --viewport=390,360
# 默认就落 docs/ui/711-settings-no-memory/after（与 before/ 并列）
```

`before/` 的复现：把 `origin/main` 单独检出（worktree）、`pnpm build`、把上面的场景名换成一次性名字
（本文写作 `711-before-probe`），删掉场景里的 `throw` 段、改成「点开名字匹配 `/记忆/` 的那个 tab 并数
`memory-embedding-toggle`」，`--out` 指到仓库外的临时目录后再拷回本目录。两档的原始量数在
`before/{390,360}/metrics.json`（`asideGeneral.tabCount = 3`、`memoryToggleOnMemoryTab = 1`）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `after/390/711-settings-no-memory-01-侧边栏-通用设置-390.png` | 改后：设置弹窗落在「通用设置」，侧边栏只有两项 |
| `after/390/711-settings-no-memory-02-侧边栏特写-390.png` | 改后：导航条特写（两项并排，没有第三个 tab） |
| `after/390/711-settings-no-memory-03-数据管理-390.png` | 改后：切到「数据管理」，面板非空、依旧没有 embedding 开关 |
| `after/360/…` | 同上三张，360×740 档 |
| `before/390/711-settings-no-memory-before-01-侧边栏三项-记忆可打开-390.png` | 改前（`origin/main`）：侧边栏三项，「记忆」已点开，面板里是那个 embedding 开关 |
| `before/390/711-settings-no-memory-before-02-侧边栏特写三项-390.png` | 改前：导航条特写（三项） |
| `before/360/…` | 同上两张，360×740 档 |
| `after/{390,360}/metrics.json` | 改后量数（`overflowCount = 0`、`consoleErrors: []`、tab 数 2） |
| `before/{390,360}/metrics.json` | 改前量数（tab 数 3、点开「记忆」后 `memory-embedding-toggle` = 1） |

## 未测边界

- 真机 / Android WebView：未测，结论只对上述 Chromium 视口成立。
- 桌面宽度（≥ 1024px，左侧竖排导航）：未单独截图；侧边栏与面板是同一份 `sections` 数据与同一条
  三元的渲染分支，宽度只换了布局方向（`styles.navigation` 的媒体查询），这里没有按宽度分支的逻辑。
- 英文界面：未单独截图。i18n 两份都删了同 7 个 key（`check:i18n` 835/835 齐平），
  `tests/unit/settings-memory-section-off-711.test.mjs` 的 T6 钉住 zh / en 都不再有那两组 key。
- 「旧值兜底」（store 里残留 `section: 'memory'` → 落 `general`）是**状态层**行为，浏览器里没有
  入口能造出这个值（`openSettings` 写入前已收敛），证据是单测 T2 / T3 与 `npx tsc` 的负向对照，
  不在本目录截图中。
