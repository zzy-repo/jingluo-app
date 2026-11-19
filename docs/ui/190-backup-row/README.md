# Issue #190 取证：设置 → 数据「Chat backup」行

**结论：当前 `origin/main`（791fb77）上无法复现。** 该行不是坏在我改动的地方，而是 #171（eb1b245，
2026-11-18T16:28Z 合并）已经把它修好了；#190 于 2026-11-18T18:31Z 提出时引用的证据是
`docs/compat/compat-old/` 里 **修复前** 的旧截图（P4-1）。

## 一、先定位行（Issue 原话「Chat backup」= 哪个元素）

- 全仓 `src/` 里没有 `Chat backup` 这个 i18n key（`grep -rin backup src/i18n/*.ts` 只命中导入 ZIP 报错文案与设备码提示）。
- Issue 描述「`Import chat history` 上方那一块」「带 Store/Upload 的整行」→ 唯一匹配的是
  `ChatBackgroundField`：标签 `settingsChatBackground`（`Chat background` / `聊天背景`），
  描述 `settingsChatBackgroundDescription`（`Stored on this device only (IndexedDB)…`），
  右侧 `—`/缩略图 + `Upload` + `Clear`。DOM 类：`.backgroundRow > .backgroundText + .backgroundAction`。

## 二、测量（before = 未做任何修改的 791fb77 构建）

设备：`compat-api30`（WebView 83.0.4103.106）、`compat-api31`（WebView 91.0.4472.114），
均为 **Android Emulator（x86_64，非真实手机）**。视口用 `wm size` + `wm density` 调到
`innerWidth` = 390 / 360 / 412 css。脚本 `measure.mjs` 用页面级 CDP 逐行读尺寸。

| 内核 | 视口 | `backgroundText` clientWidth | scrollWidth | 高 | 计算 `flex` | 一个汉字宽 | 行 `scrollWidth` vs `innerWidth` |
|---|---|---|---|---|---|---|---|
| WV83 | 390 | **342** | 342 | 62 | `1 1 100%` | 14 | 390 = 390 |
| WV83 | 360 | **312** | 312 | 62 | `1 1 100%` | 14 | 360 = 360 |
| WV83 | 412 | **364** | 364 | 61 | `1 1 100%` | 14 | 412 = 412 |
| WV91 | 390 | **342** | 342 | 61 | `1 1 100%` | 14 | 390 = 390 |
| WV91 | 360 | **312** | 312 | 62 | `1 1 100%` | 14 | 360 = 360 |
| WV91 | 412 | **364** | 364 | 61 | `1 1 100%` | 14 | 412 = 412 |

判据对照 Issue：复现要求「文本列被压到 < 1 字符」——实测文本列 = 整行宽度（≥312px，是 14px 一个汉字的 22 倍），
且高度 61–62px ≈ 2 行描述，**不是逐字竖排**（逐字竖排会得到 clientWidth≈14、高度 ≈ 22×字数）。
同页越界元素数 `0`。截图 `before-wv{83,91}-{390,360,412}.png` 与同名 `.json` 是原始证据。

## 三、为什么现在是好的（根因复盘）

`Settings.module.css`：

- 桌面规则 `.backgroundText { flex: 1 0 0; min-width: 0 }` —— `flex-basis: 0` + `flex-shrink: 0`。
  行内 `nowrap` 时若 `.backgroundAction`（44px 缩略图 + 两个按钮）的 min-content 超过行宽，
  正的剩余空间为 0 → 文本列 = basis = 0 → 逐字换行。这就是 #159 / P4-1 的塌陷机制。
- #171 新增 `@media not all and (min-width: 768px)`：`.backgroundRow{flex-wrap:wrap;row-gap:0}`、
  `.backgroundText{flex:1 1 100%}`、`.backgroundAction{flex:1 0 100%;margin-top:12px}`。
  移动端因此换行 + 文本列独占 100%（实测 `flex: 1 1 100%` 已生效），塌陷条件不再成立。

## 四、未测边界

- 未测真机（只有模拟器；WebView 83/91 镜像来自 AVD）。
- 未测 WebView 75–82（无镜像）。
- 未测 zh 语言包下的同一行：本机 AVD 的 WebView `navigator.language` 仍为 `en-US`
  （`settings put system system_locales zh-CN` 后 WebView 未跟随），zh 文案长度差异未覆盖。
  但该行在移动断点下 `flex-basis` 为 `100%`，与文案长度无关。
- 未测「已选背景图」状态下的缩略图（占位符与缩略图同为 44×44，未单独出图）。
