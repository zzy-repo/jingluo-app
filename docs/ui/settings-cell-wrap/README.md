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

### 新版内核对照（Chromium 156）

| 视口 | 版本 | 文本列 | 标题行数 | 动作区 |
| --- | --- | --- | --- | --- |
| 390×844 | 修前 | 126 | 1 | 208（并排） |
| 390×844 | 修后 | 342（独占一行） | 1 | 342 |
| 360×780 | 修前 | 96 | 1 | 208（并排） |
| 360×780 | 修后 | 312（独占一行） | 1 | 312 |

截图 `{before,after}-chromium156-{390x844,360x780}.png`、数字 `{before,after}-chromium156-metrics.json`
（脚本 `repro/settings-cell-shots.mjs`，用 `~/.cache/ms-playwright/chromium-1248`=Chrome 156）。

## 命令与结果

- `npx tsc -p tsconfig.json` → exit 0
- `npx oxlint src rspack.config.ts` → `Found 0 warnings and 0 errors.`（155 files, 100 rules）
- `node tests/run-layer.mjs unit` → `Total 21: PASS 21, FAIL 0; elapsed 23600ms`

## 边界（未测）

- 极窄视口（< 320dp，如分屏 1/3）未单独验证。
- 系统字体放大 1.3× / 1.5× 下这一行的换行未单独验证（修法是整行换行，理论上更抗放大）。
- 桌面（≥768px）规则未改，因此桌面无行为变化；桌面未额外截图。
- 纯样式改动，未新增自动化用例（现有测试层不跑 CSS 布局）；回归依赖上面的 metrics JSON。
