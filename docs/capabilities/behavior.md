# 类别 4：行为 / 布局假设（#209）

这四类假设的共同点：**静态检测测不出来**。CSS 里写了 `flex-wrap` 不代表行会换行，写了
`overflow-y: auto` 不代表内容能滚，`100vh` 在移动端也不保证等于可视高度。所以本表的每一行
都必须靠「设置之后读回实际值」来定性，而不是读声明。

实测环境：**Android Emulator API30（x86_64，非真实手机）**，WebView **83.0.4103.106**
（主战场），宽度 360 / 390 / 412 三档。复现脚本与原始读数在
[`docs/ui/209-behavior/`](../ui/209-behavior/README.md)。

> - 快照基准：`acf6826`（`origin/main` tip，2026-11-19 12:28:21 +0800）· 采集时间：2026-11-19 18:55 (+0800)
> - 本轮只重打基准：四条假设的实测读数来自已提交的 `docs/ui/209-behavior/*.json`，本轮没有设备可重跑，数字一个没动（见文末「未测边界」）
> - 表里的**行号**与**合计数字**都在快照基准上复算过；`tests/unit/capabilities-docs-sync.test.mjs` 会拿本表的行数 / 处置分布 / 风险分布去对，文档落后于代码就红
> - 判定规则只在 `scripts/lib/behaviorAssumptionAudit.mjs`；改口径要同时改那个模块与 `tests/unit/behavior-assumption-audit.test.mjs`

## 盘点表

| 文件:行 | 假设内容 | 类别 | 风险(高/中/低) | 处置(已有兜底/需探测/需动态验证/拆单) |
| --- | --- | --- | --- | --- |
| `src/components/base/Modal.module.css:128` `.footer` 只有 `display:flex` + `justify-content:flex-end` + `gap:8px`，无 `flex-wrap`、无移动端 `white-space` 放宽 | 窄屏按钮会换行 | 4 | 中 | 需动态验证 |
| `src/components/settings/Settings.module.css:787` `.deleteActions` 有 `flex-wrap: wrap`；`:795` 移动端再给 `white-space:normal; overflow-wrap:anywhere; max-width:100%` | 窄屏按钮会换行 | 4 | 低 | 已有兜底 |
| `src/components/settings/PurchaseRecordsDialog.module.css:236` `.actions` 有 `flex-wrap: wrap`（`:238`），同文件 `:2` 注释写明「窄屏不横向滚动」的约定 | 窄屏按钮会换行 | 4 | 低 | 已有兜底 |
| `src/components/settings/PaymentRecords.module.css:139` `.actions` 只有 `display:flex` + `justify-content:flex-end` + `gap`，无 `flex-wrap` | 窄屏按钮会换行 | 4 | 中 | 需探测 |
| `src/components/settings/PaymentTrailDialog.module.css:49` `.actions` 同上，无 `flex-wrap` | 窄屏按钮会换行 | 4 | 中 | 需探测 |
| `src/components/settings/AppUpdateField.module.css:21` 卡片上限 `min(70vh, calc(var(--modal-viewport-height, 100vh) - 32px))`；`:33` 矮屏（含 360×740）再降到 `62vh` | 弹窗内容超出会滚动 | 4 | 低 | 已有兜底 |
| `src/components/settings/AppUpdateField.module.css:54` `.main { overflow-y: auto }` + `:52` `min-height: 0` + `:57` `touch-action: pan-y` | 弹窗内容超出会滚动 | 4 | 低 | 已有兜底 |
| `src/components/settings/Settings.module.css:69` `.content`（`flex:1 0 0`、`min-height:0`、`:77` `overflow-y:auto`）是实测滚动宿主；`:818` 卡片给 `max-height: calc(var(--modal-viewport-height, 100vh) - 32px)` | 弹窗内容超出会滚动 | 4 | 低 | 已有兜底 |
| `src/components/base/Modal.module.css:40` `.content` 自身无 `max-height`、无 `overflow`，`overflow-y` 完全由调用方决定 | 弹窗内容超出会滚动 | 4 | 中 | 需动态验证 |
| `src/components/settings/PaymentRecords.module.css:12` `.main { overflow-y: auto }`，无 `min-height: 0`、无 `touch-action` | 弹窗内容超出会滚动 | 4 | 中 | 需探测 |
| `src/components/settings/PaymentTrailDialog.module.css:12` `.main { overflow-y: auto }`，无 `touch-action` | 弹窗内容超出会滚动 | 4 | 中 | 需探测 |
| `src/components/settings/PurchaseRecordsDialog.module.css:11` `.main { overflow-y:auto; overflow-x:hidden }`，无 `touch-action` | 弹窗内容超出会滚动 | 4 | 中 | 需探测 |
| `src/app/viewport.ts:49` `findScrollableAncestor` 按**计算值** `overflow: auto\|scroll` 找可滚祖先（`:55` `getComputedStyle`），`:79` `shouldPreventTouchMove` / `:104` `usePreventPageScroll` 找不到就 `preventDefault` | 触摸滑动会滚容器 | 4 | 低 | 已有兜底 |
| `src/components/settings/AppUpdateField.module.css:57` `.main { touch-action: pan-y }` 显式放行纵向手势 | 触摸滑动会滚容器 | 4 | 低 | 已有兜底 |
| 其余弹窗的滚动容器不写 `touch-action`（缺省 `auto`，实测不阻碍滚动；锁死滚动的是 `none`/`pan-x`，仓库里没有） | 触摸滑动会滚容器 | 4 | 低 | 已有兜底 |
| `src/app/viewport.ts:104` 的祖先链判定假设「触摸目标一定是滚动宿主的后代」：设置弹窗里滚动宿主 `content-_85c1b` 是 `.main` 的**子**层，落在 `.main` 内边距/头部空白上的拖动找不到可滚祖先会被 `preventDefault` | 触摸滑动会滚容器 | 4 | 低 | 需动态验证 |
| `src/components/settings/Settings.module.css:5` `max-height: calc(100vh - 32px)`，裸 `100vh`、无 `@supports (100dvh)` 兜底 | 100vh 等于可视高度 | 4 | 中 | 需探测 |
| `src/components/settings/PaymentRecords.module.css:5` `min(640px, calc(100vh - 48px))`，无 `@supports` 兜底 | 100vh 等于可视高度 | 4 | 中 | 需探测 |
| `src/components/settings/PaymentTrailDialog.module.css:5` `min(720px, calc(100vh - 32px))`，无 `@supports` 兜底 | 100vh 等于可视高度 | 4 | 中 | 需探测 |
| `src/components/settings/PurchaseRecordsDialog.module.css:7` `min(680px, calc(100vh - 48px))`，无 `@supports` 兜底 | 100vh 等于可视高度 | 4 | 中 | 需探测 |
| `src/components/settings/Settings.module.css:818`（`:820` `@supports (max-height:100dvh)` 里升 `100dvh`）、`:837`/`:839` `min(560px, …)`、`:780`/`:781` `.feedbackDialog` | 100vh 等于可视高度 | 4 | 低 | 已有兜底 |
| `src/components/settings/AppUpdateField.module.css:21`/`:24`、`:33`/`:37` `vh` 与 `dvh` 分开写在 `@supports` 两侧（#13 的坑） | 100vh 等于可视高度 | 4 | 低 | 已有兜底 |
| `src/app/App.module.css:104`/`:105` `height: var(--app-viewport-height, 100vh)` + `@supports` 升 `100dvh` | 100vh 等于可视高度 | 4 | 低 | 已有兜底 |
| `src/components/chatInput/ChatInput.module.css:227`/`:228` `max-height: calc(var(--app-viewport-height, 100vh) - 120px)` + `@supports` | 100vh 等于可视高度 | 4 | 低 | 已有兜底 |
| `src/components/settings/OursServices.module.css:49`/`:50`、`:242`/`:243` `calc(100vh - 48px)` + `@supports` 升 `100dvh` | 100vh 等于可视高度 | 4 | 低 | 已有兜底 |
| `src/app/viewport.ts:122` `syncModalViewport` 用 `visualViewport` 写 `--modal-viewport-height`；`useMobileViewport` 只在输入聚焦时写 `--app-viewport-height` | 100vh 等于可视高度 | 4 | 低 | 已有兜底 |

合计 26 行：**已有兜底 14 行 / 需动态验证 3 行 / 需探测 9 行 / 拆单 0 行**，风险 **高 0 / 中 11 / 低 15**。

## 四条假设的动态验证结论

全部在 Android Emulator API30 + WebView 83 上，360 / 390 / 412 三档各测一遍。
判据先定后测，写在 `scripts/lib/behaviorAssumptionAudit.mjs` 里并有用例钉住。

| 假设 | 结论 | 关键读数 |
| --- | --- | --- |
| ① 窄屏按钮会换行 | **成立（结果层面）· 机制不成立** | 三档 `innerWidth` 360 / 390 / 412 下共 12 条多按钮行，**换行 0 条、溢出 0 条、文字被裁 0 条**。最宽的内容行 `Send feedback / Check log coverage` 跨度恒为 281.8px，360 上距可用 312px 只剩 **30.2px**；`.footer` 无 `flex-wrap`，余量吃光后是溢出而不是换行 |
| ② 弹窗内容超出会滚动 | **成立** | 设置弹窗滚动宿主 `content-_85c1b`：360 → `clientHeight 528 / scrollHeight 1138`（藏 610px），390 → `595 / 1102`（507），412 → `460 / 1098`（638）；其计算值 `overflow-y: auto`、`min-height: 0px` |
| ③ 触摸滑动会滚容器 | **成立** | `adb shell input swipe` 真实触摸一次：`scrollTop` 0 → **328.7**（360）、0 → **377.3**（390）、0 → **180.2**（412）；连滑到底 `remainingScroll ≈ 0`，末端 `Delete`（top 1220.5）进入可视区。坐标已按 `devicePixelRatio`（1.5 / 1.5 / 2.625）换算成显示像素 |
| ④ `100vh` 等于可视高度 | **成立（机械性成立，非 `dvh` 之功）** | 静息态 `100vh` = `visualViewport.height` = 728 / 795.3 / 660.2，差 **0**；软键盘弹出态（`dumpsys input_method` 读到 `mInputShown=true`）两者同降为 **479.3 / 546 / 378.3**，差仍 **0**。机制是 `AndroidManifest.xml:19` 的 `windowSoftInputMode="adjustResize"`（窗口本身改小）；`CSS.supports('height','100dvh')` 实测 **false**，所有 `@supports (…100dvh)` 分支在 83 上整条不生效 |

**没有一条假设被实测证伪，因此本单不开独立 Issue。** 26 行里有 9 行「需探测」，是因为它们
没有兜底、当前能成立靠的是上面那条 `adjustResize` 机制，而不是自己的 CSS —— 这类不属于「实测
不成立」，不进 issue 队列，记在本表里等后续覆盖面扩大（真机 / 91 / 109 / 订单态数据）时再看。

## 未测边界

- **全程模拟器，不是真机。** 真机的地址栏收放、厂商 ROM 分屏、手势导航、异形屏安全区未覆盖。
- `PaymentRecords` / `PaymentTrailDialog` / `PurchaseRecordsDialog` 三个弹窗**未测**（原因：
  需要登录态订单数据，模拟器上是空态，弹不出有内容的列表），表里对应 4 行为「需探测」。
- `100vh` 的结论绑定 `adjustResize`。若 Activity 改成 `adjustPan` 或全屏 edge-to-edge，
  结论立即失效，而代码里没有对「100vh 是否等于可视高度」做运行时探测。
- 系统字号放大 / 字体缩放的越界场景未测（`.footer` 无 `flex-wrap`，余量仅 30.2px）。
- WebView 91 / 109 未测，本单只针对 83。
