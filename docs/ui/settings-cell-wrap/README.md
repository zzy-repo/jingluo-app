# #57 设置→数据「反馈与日志」行：窄屏文本列被压成单字符宽

## 根因（实测结论）

`SettingCell` 在移动端是单行 flex：`.text { flex: 1 1 0; min-width: 0 }`、`.cellActions { flex: 0 1 auto; flex-wrap: wrap; min-width: 0 }`。
文本列的 flex-basis 是 0，`min-width: 0` 又去掉了下限，所以**只要动作区的 max-content 占满行宽，文本列就会被压到接近 0**；
再叠加 `word-break: break-word` + `overflow-wrap: anywhere`（min-content = 1 个字），标题就逐字竖排、描述变成一条竖线。

「反馈与日志」是设置页里唯一一行**两个按钮并排**的 cell，动作区宽度直接决定会不会塌：

| 界面语言 | 动作区 max-content（360dp，行宽 312px） | 文本列 | 结果 |
| --- | --- | --- | --- |
| 中文（写反馈 72 + 8 + 检查日志完整性 128） | 208px | 96px | 没塌，但被挤成 96px 窄栏（描述一行 ~6 字） |
| 英文（Send feedback 122.2 + 8 + Check log coverage 151.6） | 281.8px | **22.2px** | 塌成 1 字符宽，标题 12 行竖排 |

**Issue #57 报告的"只在 WebView 91 出现"需要修正**：报告截图里界面是英文（`Feedback & logs` / `Send feedback`，
正文也写的英文标题），英文按钮更宽才是塌陷的直接原因。中文在 WebView 91 上实测文本列 96px、标题 1 行
（与新版内核的 96px 完全一致），说明这不是内核版本差异，而是**文本列没有下限**这一族规则在"动作区接近占满行宽"时必然暴露。
bb3dbf1（`fix/settings-overflow`）建立了 `.cellActions` 包裹 + `min-width: 0`，解决的是单按钮溢出；
本次是两个按钮并排把文本列挤到 0，属于同一族规则的新覆盖场景。

## 修法

只改样式 + 一个 className，不动产品逻辑，且只在移动端媒体查询（`< 768px`）内生效，桌面规则不变：

```css
.wrapActionsCell { flex-wrap: wrap; }                        /* 行允许换行 */
.wrapActionsCell .text { flex: 1 1 100%; padding-right: 0; }  /* 文本整行独占 */
.wrapActionsCell .cellActions { flex: 1 0 100%; }             /* 动作区整行下移，内部按钮右对齐换行 */
```

不再依赖任何引擎的 flex 收缩计算（同 `.locationCell` / `.backgroundAction` 的既有做法），因此不赌内核版本；
`className={styles.wrapActionsCell}` 只加在「反馈与日志」这一行，其它设置行零影响。

## 证据链

### 真机（WebView 91）

- 设备：`compat31` AVD / Android 12（`ro.build.version.release=12`）/ 540×1200 @ density 240（= 360dp），
  390dp 用 `wm size 585x1300` 覆盖。
- 内核真值（`adb shell dumpsys webviewupdate` 复核）：
  `Current WebView package (name, version): (com.google.android.webview, 91.0.4472.114)`。
- 测试时间窗：2026-11-18 19:00–19:26（修后 19:00/19:02/19:24，修前 18:57/18:59/19:26）。
- 被测包（自建 internal debug，`pnpm build:internal` + `cap sync` + `assembleDebug -PartifactVariant=internal`）：
  - 修前：`/tmp/scf-before.apk` sha256 `9346c04ee1f5cd3787524ee5c2658287322ee2b4236241d7da0945ca2db00d03`
  - 修后：`/tmp/scf-fixed.apk` sha256 `c93c67a259587c9b3f490137cf716ed3de97e6bceaa100b40de0644e2062503e`
  - 两者同为 versionName 1.4.0-beta.9 / versionCode 16（只差这两处样式）。
- 测量方式：`repro/wv91.sh` 先 `adb forward` 到 `webview_devtools_remote_<pid>`，再用 page 级 CDP
  （`Runtime.evaluate` 读 computed style、`Page.captureScreenshot` 截图）；导航用 `adb shell input tap` 真实触摸。
  WebView 91 的 `Input.dispatchTouchEvent` 会卡在 `touchEnd`，故点按走 adb；未做任何 CSS 能力模拟。
- 语言：走 App 自己的语言设置（localStorage `chat-demo:locale`），不是 CSS 模拟。

| 视口 | 版本 | 文本列宽 | 标题行数 | 动作区宽 | 按钮（宽） | 行高 |
| --- | --- | --- | --- | --- | --- | --- |
| 360dp 英文 | 修前 | **22.2** | **12** | 281.8 | 122.2 / 151.6 并排 | **1156** |
| 360dp 英文 | 修后 | 312 | 1 | 312（独占一行） | 122.2 / 151.6 右对齐 | 138 |
| 390dp 英文 | 修前 | **52.2** | **3** | 281.8 | 122.2 / 151.6 并排 | 400 |
| 390dp 英文 | 修后 | 342 | 1 | 342（独占一行） | 122.2 / 151.6 右对齐 | 138 |
| 360dp 中文 | 修前 | 96 | 1 | 208 | 72 / 128 并排 | 158 |
| 360dp 中文 | 修后 | 312 | 1 | 312（独占一行） | 72 / 128 右对齐 | 138 |
| 390dp 中文 | 修后 | 342 | 1 | 342（独占一行） | 72 / 128 右对齐 | 138 |

两种语言、两种宽度下 `document.documentElement.scrollWidth === clientWidth`，无横向溢出；
`text` 的 computed flex 由 `1 1 0px` / `auto` 变为 `1 1 100%`，`cellActions` 由 `0 1 auto` 变为 `1 0 100%`（见 JSON）。

回归（同一份 metrics JSON 里的其它行，360dp 英文/中文）：导入历史对话 `text 232 / actions 72`、
从链接导入 `text 312`、导出所有历史对话 `text 211.7 / actions 92.3`、删除所有对话 `text 232 / actions 72`，
标题均 1 行，`scrollWidth-clientWidth=0` —— 与修前一致，未被本次改动影响。

原始数字（computed style + bounding box）：`before-wv91-*.json` / `after-wv91-*.json`；
截图：`before-wv91-{360,390}-{en,zh}.png`、`after-wv91-{360,390}-{en,zh}.png`（设备像素 540/585 宽，即 360dp/390dp）。

### 新版内核对照（Chromium 156，两种语言，修前/修后）

`Chromium 156.0.8078.4`（playwright `chromium-1248`）+ `repro/settings-cell-shots.mjs`，
行宽 312（360dp）/ 342（390dp）：

| 视口 | 语言 | 版本 | 文本列 | 标题行数 | 动作区 | 行高 | 文本自身横向溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 360×780 | 英文 | 修前 | **8** | **13** | 296（并排） | 1970 | 4 |
| 360×780 | 英文 | 修后 | 312 | 1 | 312（独占一行） | 156 | 0 |
| 390×844 | 英文 | 修前 | **35.9** | **6** | 298（并排） | 628 | 0 |
| 390×844 | 英文 | 修后 | 342 | 1 | 342（独占一行） | 138 | 0 |
| 360×780 | 中文 | 修前 | 96 | 1 | 208（并排） | 158 | 0 |
| 360×780 | 中文 | 修后 | 312 | 1 | 312（独占一行） | 138 | 0 |
| 390×844 | 中文 | 修前 | 126 | 1 | 208（并排） | 140 | 0 |
| 390×844 | 中文 | 修后 | 342 | 1 | 342（独占一行） | 138 | 0 |

**这张表同时否掉了「只在 WebView 91 出现」的表述**：同一份修前代码，在 Chrome 156 上英文界面照样把文本列压到 8px / 13 行
（WebView 91 上是 22.2px / 12 行，差值来自按钮 max-content 298.1 vs 281.8 的字体度量差异，不是求解算法差异）。
中文两端都是 96px / 1 行。触发条件是**按钮宽度接近行宽**，英文按钮更宽才把它顶出来。

数字：`verify-chromium156-{before,after}-{en,zh}.json`；
截图：`verify-chromium156-{before,after}-{360x780,390x844}-{en,zh}.png`
（360dp 英文修前那张就是 issue 描述里的逐字竖排）。早期一轮的数字另存 `{before,after}-chromium156-metrics.json`。

### 机制取证：哪个变量在起作用（360dp / 英文 / Chrome 156）

`repro/settings-cell-mechanism.mjs` → `mechanism-chromium156-360-en.json`，只改一个变量后重新量：

行宽 312，动作区 `.cellActions` max-content = **298.1**，`.text` min-content = 20.2 / max-content = 620.5。

| 变体 | 文本列 | 标题行数 | 动作区 | 文本横向溢出 |
| --- | --- | --- | --- | --- |
| 基线（`.text{flex:1 1 0;min-width:0}`，行 `nowrap`） | 8 | 13 | 296 | 4 |
| `.text{min-width:96px}` | 104 | 2 | 200 | 0 |
| `.text{flex:1 1 40%}` | 95.3 | 2 | 208.7 | 0 |
| `.text{flex:1 1 auto}` | 207.1 | 1 | 96.9 | 0 |
| `.text{overflow-wrap:normal;word-break:normal}` | 8 | 3 | 296 | **55** |
| 行 `flex-wrap:wrap` | 312 | 1 | 298.1 | 0 |
| 行 `wrap` + `.cellActions{flex:1 0 100%}`（**本次修法**） | 312 | 1 | 312 | 0 |

读法：

1. **不是收缩失败，是"只能吃剩饭"**。`.text` 的 `flex-basis: 0` + `min-width: 0`（后者关掉了 flex 的 automatic
   minimum size）使它对本行的基准尺寸贡献恒为 0；行的基准尺寸 ≈ 动作区 max-content 298.1。可用空间 =
   312 − 298.1 − 8(gap) = **5.9**，实测 8（含 8px `padding-right`），即文本列宽 = 行宽 − 动作区 max-content − gap。
   所以它拿到的是一个"加法结果"，跟老内核的收缩取整无关。
2. **`overflow-wrap: anywhere` 决定"怎么难看"而不是"窄不窄"**。同一份 8px 盒子里，去掉 `anywhere`/`break-word`
   后 min-content 从 20.2 涨到 71.4，文本不再逐字换行而是横向溢出 55px。也就是说：塌陷由 (1) 决定，
   "一字一行"这个视觉签名由 `anywhere` 决定。
3. **换行与否由行容器的 `flex-wrap` 决定**。行是 `nowrap`，动作区永远不肯整行下移；一旦允许 `wrap`，
   动作区（298.1）自动掉到第二行，文本立刻拿到整行 312。
4. **内核版本不在这条链上**：`min-width:0` 覆盖自动最小尺寸、`flex-basis:0`、
   `overflow-wrap:anywhere`（Chrome 80+）在 91 与 156 上行为一致，真机 JSON 与 Chromium 156 JSON 的
   唯一差别是按钮 max-content（281.8 / 298.1）。修法因此不赌内核：把竞争关系去掉（文本整行、动作区整行下移）。

## 命令与结果（本会话在 `fix/57-webview91-layout`（rebased 到 `72bd444`）上跑的真输出）

- `pnpm run type` → `tsc -p tsconfig.json`，exit 0
- `pnpm run lint` → `Found 0 warnings and 0 errors.` / `Finished in 82ms on 177 files with 100 rules using 16 threads.`
- `pnpm test`（剥掉代理）→ `Total 51: PASS 51, FAIL 0; elapsed 22058ms`
- `NODE_ENV=production node node_modules/@rspack/cli/bin/rspack.js build` → `Rspack compiled successfully in 835 ms`
  + `pnpm check:legacy` → `JS 文件 88 个；词法层违规 0 个；AST 层违规 0 个（acorn 8.19.0, ecmaVersion 2022）` /
  `dvh 声明 14 处；带 vh 回退 14 处` / `运行时 API…违规 0 个` / `结论：合格 —— 全部产物可用 Chrome 83 解析`

## 边界（未测）

- **WebView 91 本次未复验**：`D:\android-avd` 里只剩 `deepseek-api33` / `probe33`，`compat31` 已不存在；
  本机 SDK 只装了 `system-images/android-34`，重建 API 31 镜像不在本单范围；唯一在跑的模拟器
  `emulator-5554`（Android 13 / WebView 109）被另一条线占着，按"不同时跑多台模拟器"不抢。
  因此上表真机一栏是 2026-11-18 18:57–19:26 那次记录（`{before,after}-wv91-*.json` + 截图），本会话未重跑。
- 极窄视口（< 320dp，如分屏 1/3）未单独验证。
- 系统字体放大 1.3× / 1.5× 下这一行的换行未单独验证（修法是整行换行，理论上更抗放大）。
- 桌面（≥768px）规则未改，因此桌面无行为变化；桌面未额外截图。
- 纯样式改动，未新增自动化用例（现有测试层不跑 CSS 布局）；回归依赖上面的 metrics JSON。
