# 旧版 Android / WebView 兼容性实测覆盖（API 26–33）

> **口径（全文强制）**：以下结论全部来自 **Android Emulator（x86_64，swiftshader_indirect）**，不是真机。
> 真机、厂商 ROM（尤其线上反馈来源的老 WebView）**未测**，不得由本表外推。
> 「未测」= **没跑过，不是通过**。WebView 版本一律取 `adb shell dumpsys package com.google.android.webview | grep versionName`
> 的原始输出，**不按 Android 版本推断**。

- 被测产物：debug APK `com.example.deepseekchat` 1.4.0-beta.10（versionCode 17，`minSdk 24`、`targetSdk 36`，`application-debuggable`），6,305,279 B
- 构建：JDK 21 + Gradle 8.14.3 + AGP，`assembleDebug`
- 取证日期：2026-11-18 ~ 2026-11-19
- 测具：`scripts/compat/**`（`boot` / `p0-fallback` / `p2-import` / `p3-net` / `p4-layout` + `run-round.sh` 串行跑）。**每个数字都能在对应 `result-*.json` 里查到**，不在文档里另算。

---

## 覆盖总表

**本表唯一事实来源 = 各目录下的 `result-*.json`。** 表与 json 冲突时以 json 为准，并回来改表。

| AVD | Android | WebView（`dumpsys` 原行） | P0 兜底页 | P1 启动 | P2 导入 | P3 弱网 | P4 390/360 排版 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `compat-api26` | 8.0 | `69.0.3497.100` | **命中出口②**：`booted=false`、`boxPresent=true`、`compatibilityError=null`、进程存活（`api26/result-p0.json`） | 非纯白屏，兜底卡出现（`api26/shots/`） | **不可达**：主包不启动，UI 起不来 | **不可达** | **不可达** |
| `compat-api28` | 9 | `69.0.3497.100` | 同 api26（`api28/result-p0.json`） | 同 api26 | **不可达** | **不可达** | **不可达** |
| `compat-api29` | 10 | `74.0.3729.185` | 同 api26（`api29/result-p0.json`） | 非纯白屏 | **不可达** | **不可达** | **不可达** |
| `compat-api30` | 11 | `83.0.4103.106` | 不触发，`booted=true`、`boxPresent=false`（`api30/result-p0.json`） | 正常启动 | **7 档全跑，全部有终态**（`api30/result-p2-*.json`） | 未测 | 390/360 四屏横溢 0（`api30/result-p4.json`） |
| `compat-api31` | 12 | `91.0.4472.114` | 未单独跑（P2/P4 期间页面正常启动） | 正常启动 | **3 档**（bomb / corrupt-branch / 200MB） | 六态跑完但**未采到正文**，无结论 | 390/360 四屏横溢 0（`api31/result-p4.json`） |
| `deepseek-api33` | 13 | `109.0.5414.123` | 未单独跑（P4 期间页面正常，主界面 `bodyTextLength=52`） | 正常启动 | 三档**全部未到终态**（测具失效，非产品结论） | 109 既有结论见 #150 / #154 | 390/360 四屏横溢 0（`api33/result-p4.json`） |

各档细节在同目录 README：`api26/`、`api28/`、`api29/`、`api30/`、`api31/`、`api33/`。

---

## P0 · 兜底页正向验证（API26 / 28 / 29）

兜底页（`src/index.html` 内联 ES5 守卫）实际有**三条**出口：

| 出口 | 触发条件 | 文案尾部 |
| --- | --- | --- |
| ① 探针缺失 | 12 条特性探针任一不满足 | `…：缺少：<API 列表>` |
| ② window error | 捕获到脚本错误（`addEventListener('error', …, true)`） | `…：<event.message>` |
| ③ 12s 看门狗 | 探针齐但 `__DEEPSEEK_BOOTED__` 12 秒没置位 | `…：脚本 12 秒内没有启动（内核过旧或资源加载失败）` |

### 实测：69 / 74 命中出口②，不是出口①也不是③

| AVD | WebView | 兜底页 | 命中出口 | `__DEEPSEEK_BOOTED__` | `__DEEPSEEK_COMPATIBILITY_ERROR__` |
| --- | --- | --- | --- | --- | --- |
| `compat-api26` | `69.0.3497.100` | 出现（非纯白） | ② window error | `false`（2s/6s/13s/20s 四帧一致） | `null` |
| `compat-api28` | `69.0.3497.100` | 出现（非纯白） | ② window error | `false` | `null` |
| `compat-api29` | `74.0.3729.185` | 出现（非纯白） | ② window error | `false` | `null` |

用户可见文案（三档逐字一致，`#compatibility-error` 的 `textContent`）：

```
页面启动失败。请更新 Android System WebView 或浏览器后重试；仍失败请反馈组件版本与以下信息：Uncaught SyntaxError: Unexpected token ?
```

logcat（三档同一条，主包解析失败）：

```
E Capacitor: JavaScript Error: {"type":"js.error","error":{"message":"Uncaught SyntaxError: Unexpected token ?","url":"https://localhost/static/js/main.030dd2a6.js","line":1,"col":249411,...}}
E Capacitor/Console: File: https://localhost/ - Line 811 - Msg: SyntaxError: Unexpected token ?
```

结论：

1. WebView 69 / 74 上**不是纯白屏** —— 兜底守卫接住了解析失败，卡片确实出现。
2. 但落的是出口 ②：把**未本地化的英文原文**（`Uncaught SyntaxError: Unexpected token ?`）直接展示给用户；且 `__DEEPSEEK_COMPATIBILITY_ERROR__` 为 `null`（只有出口 ① 才写该变量），诊断链路拿不到结构化原因 → **#180**。
3. 出口 ① / ③ 至今**一次都没被真正触发过**（69 / 74 的 12 条探针全过；要触发 ① 需 WebView < 64 或人为注入缺项）。

---

## P1 · 白屏边界

- 实测边界：**WebView 74 → 兜底卡片；WebView 83 → 正常启动。**
- 中间 **75–82 没有可用系统镜像，未测**（不做任何推断）。
- 更老的 < 69 未测。
- 「更高版本也不会炸」（API 34 / 35 / 36）未测。

---

## P2 · 导入（链接导入 → 归档解析）

方法：本机起 Range 服务（`10.0.2.2:5411`），App 逐段 206 下载后自行解析；每档前 `am force-stop` + `logcat -c` + 冷启动，
约 1.5s 采样一次界面文案与 `dumpsys meminfo` 的 TOTAL PSS，直到出现终态文案或超时。

### `compat-api30`（WebView 83）—— 七档全跑

| 档位 | 服务端送出 | 终态 | PSS 峰值 | 证据 |
| --- | --- | --- | --- | --- |
| `ctrl-1mb` | 1,048,576 B / 8 段 | 导入成功 | 116,073 KB | `result-p2-ctrl-1mb.json` |
| `ctrl-10mb` | 10,485,760 B / 11 段 | 导入成功 | 140,672 KB | `result-p2-ctrl-10mb.json` |
| `ctrl-50mb` | 52,428,764 B / 63 段 | 导入成功 | **485,586 KB** | `result-p2-ctrl-50mb.json` |
| `edge-200mb` | 209,715,200 B / 110 段（全量下完） | **失败**：`Import from link failed` | 363,500 KB | `result-p2-edge-200mb.json` |
| `bomb-1000x` | 66,112 B（解压后 64 MB 同一字符） | 导入成功 | **481,587 KB** | `result-p2-bomb-1000x.json` |
| `corrupt-branch` | 2,164 B | 导入 2 条、跳过 2 条损坏项，逐条给出会话名与消息号（#49 降级路径正常） | 315,625 KB | `result-p2-corrupt-branch.json` |
| `truncated` | 2,306,867 B | 错误弹层：`This ZIP is damaged…` | 150,217 KB | `result-p2-truncated.json` |

- **七档没有一次白屏，也没有一次进程被杀**：各档 pid 恒定，logcat 无对应包名 `Killing …(adj …)`；大档结束回到主界面有正文。
  「导入白屏 / OOM」在 API30 + WebView 83 上**没有复现**。
- 内存随**解压后**体积走：1 MB → 116 MB、10 MB → 141 MB、50 MB → 486 MB；64 MB 全同字符炸弹包 → 482 MB，与 50 MB 真实包同量级，
  说明峰值由解压后的字符串决定，不是压缩比。1536 MB RAM 下未触发 `lowmemorykiller`。
- 200MB 档：下载阶段 110 段全部成功、字节数完全等于 200 MB，**失败发生在读文件阶段**，抛的是 `File` / `FileReader` 的 DOMException 原文，
  不是 `historyImportUrl*` 里的任何本地化文案 → 用户看到技术异常，且 200 MB 流量白费（见 `api30/README.md` P2-1）。

### `compat-api31`（WebView 91）—— 交叉验证 3 档

| 档位 | 服务端送出 | 终态 | PSS 峰值 | 证据 |
| --- | --- | --- | --- | --- |
| `bomb-1000x` | 66,112 B | 导入成功 | 132,800 KB | `result-p2-bomb-1000x.json` |
| `corrupt-branch` | 2,164 B | 导入成功（损坏项降级） | 113,745 KB | `result-p2-corrupt-branch.json` |
| `edge-200mb` | 209,715,200 B / 54 段 | **失败**：`Import from link failed` | 155,774 KB | `result-p2-edge-200mb.json` |

1MB / 10MB / 50MB / truncated 四档**在 WebView 91 上未测**。

### `deepseek-api33`（WebView 109）—— 三档未到终态，**不构成产品结论**

三档（`bomb-1000x` / `corrupt-branch` / `edge-200mb`）全部 `timedOut=true`、`requestCount=0`、`verdict=NO_TERMINAL_TEXT`。

原因是**测具**：`result-p2-*.json` 里 `typed.state.value` 记的是 `http://10.0.2.2:5398/v1`（测具自己形状服务的根地址），
不是归档 URL；`corrupt-branch` 那档更把两串地址粘在一起（`http://10.0.2.2:5398http://10.0.2.2/v1`）。
于是「Import link」按钮始终 `disabled`，`startClick.clicked=false / reason=disabled`，一次请求都没发出。
→ 归因为**测具向 React 受控输入框写值失效**，产品侧无结论。

---

## P3 · 弱网（六态）

`api31/result-p3.json` 跑完六态：`s0-ok`(30s) / `s1-hold`(100s) / `s2-cut`(40s) / `s3-trickle`(70s) / `s4-unreachable`(100s) / `s5-offline`(60s)。

**但六态全部 `firstTextMs=null`、`rows=0`、`finalBody` 为空串** —— 采样选择器一次都没命中会话区，
等于什么都没观测到。截图 `api31/shots/p3-s0-ok.png` … `p3-s5-offline.png` 六张在，但没有可判定的产品行为。

→ P3 在 API31 上记为**未取得结论**（不是通过，也不是失败）。重做需要：先有可用会话（真实 key 或 fake backend），
再让 `p3-net.mjs` 的采样器命中消息容器。WebView 109 的弱网结论引用既有单：滴流无限 streaming **#150**、断网误分类 **#154**。

---

## P4 · 排版（390 / 360 CSS px）

视口换算：`css_px = 物理宽 / (density / 160)`，物理宽固定 1080。

- **390 css** → `wm density 443`（1080×160/443）
- **360 css** → `wm density 480`

三档 × 二视口 × 四屏，`horizontalOverflow` 全为 **0**、`overflowElements` 全为空：

| AVD | 390css（`innerWidth` / `scrollWidth`） | 360css | 四屏正文长度（390 / 360） | 证据 |
| --- | --- | --- | --- | --- |
| `compat-api30` | 391 / 391 | 360 / 360 | main 1025/1025、settings-general 775/775、settings-data 1062/1062、import-form 1062/1062 | `api30/result-p4.json` + `shots/p4-{390,360}css-*.png` |
| `compat-api31` | 391 / 391 | 360 / 360 | main 1025/1008、settings-general 775/758、settings-data 1062/1045、import-form 1062/1045 | `api31/result-p4.json` |
| `deepseek-api33` | 391 / 391 | 360 / 360 | main 52/52、settings-general 720/720、settings-data 1043/1043、import-form 1043/1043 | `api33/result-p4.json` |

**未测屏（三档一致）**：

- `session`（会话详情）：`skipped` = 「本机没有会话条目 / 设备上没有可打开的会话」—— 不拿主界面冒充。
- `import-confirm`（导入确认弹层）：`skipped` = 「没有找到 Import link 按钮」—— 链接输入框为空时按钮 `disabled`，属预期；
  该弹层的真实路径由 P2 覆盖。

### 排版缺陷（已开单）

- **#190**｜设置 → 数据「Chat backup」行文本列塌成单字符宽（WebView 83 / 91 × 390 / 360 / 412）。
  证据 `api30/shots/p4-{390,360}css-settings-data.png`、`api31/shots/p4-{390,360}css-settings-data.png`。
  该行纵向塌陷的同时右侧操作列被挤空，同屏 `Channel` / `API Key` / `Connection test` 都正常横排。
- **#173**｜`CSS.supports('gap', '12px')` 在 WebView 83 上**假阳性**（返回 `true` 但 flex `gap` 实际不生效），71 处 `gap` 依赖待排查。
  这是「用 `CSS.supports` 做特性检测」在旧内核上的坑，直接影响任何基于它做的兼容判定。

> 本表只测**横向溢出**，不测列宽。所以「横溢 0」不等于「排版正常」—— #190 的塌陷就发生在横溢 0 的情况下。

---

## 归因：是 WebView 版本，不是 Android 版本

| 维度 | WebView 83 / API30 | WebView 91 / API31 | WebView 109 / API33 |
| --- | --- | --- | --- |
| 主包启动 | 正常 | 正常 | 正常 |
| `?.` SyntaxError | 无 | 无 | 无 |
| 兜底页 | 不触发 | 不触发 | 不触发 |
| 390/360 横向溢出 | 0 | 0 | 0 |

WebView 83 / 91 / 109 跨了 Android 11 / 12 / 13 三个平台版本，启动与兜底行为一致；而 69 / 74（Android 8 / 10）全部因 `?.` 解析失败落兜底卡。
即：**决定启动成败的是 WebView 内核版本，不是 Android 平台版本。**

严格证明需要「同一 Android 版本换 WebView 版本」的受控对照，**本轮未做** —— 上面的归因是强推断，不是受控实验。

---

## 更正说明（旧结论被推翻）

- **已删除条目 D2「设置 → 数据页签点击后内容不切换」—— 推翻。**
  `api30/result-p4.json` 里 `settings-data` 屏与 `settings-general` 屏正文长度分别为 **1062 / 775**，文本内容也不同
  （Data 屏出现 `Delete all chats`、支付记录等条目），说明点击后内容**确实切换了**。
  当时记录到的「点了不切换」是首次冷启动自动弹出设置页时的**点击时机 / 未重绘**误判，不是产品缺陷。原条目作废，此处留痕。
- **旧表「api30 P2 未测 / api31 P3 未测 / api33 P2+P4 未测」全部作废**：现已有对应 `result-*.json` 与截图，见上各表。

---

## 未测边界（汇总）

1. **真机**：全程模拟器（x86_64），无任何真机结论。
2. **厂商 ROM / OPPO 等老 WebView**：完全未覆盖 —— 这是线上症状的真实来源，也是最大缺口。
3. **WebView 75–82**：无系统镜像，未测，**不得由 Android 版本推断**。
4. **WebView < 69**：未测，因此兜底出口 ① / ③ 仍未获正向验证。
5. **API 34 / 35 / 36**：未测。
6. **同一 Android 版本换 WebView 版本对照**：未做（归因是强推断）。
7. **发消息 / 收流式回复链路**：未测（无 fake backend、无 key）。
8. **深色模式 / 横屏 / 多语言**：未测（本轮 locale 为 en-US，UI 呈现英文）。
9. **P3 弱网**：跑了但没有有效观测（见 P3 节）。
10. **P4 的 `session` / `import-confirm` 两屏**：三档均未测（选择器未命中 / 按钮 `disabled`）。
11. **API31 的 P2 四档、API33 的 P2 全部**：未取得结论（前者未跑，后者测具失效）。

---

## 环境更正（仍然有效）

工单曾记录「API 30 / 31 / 33 三个镜像均已在本地」。**该记录对 API 31 是错的**：
`/d/android-sdk/system-images/android-31/google_apis/x86_64/` 当时只有空壳（`.installer/.installData`，无 `package.xml` / `system.img`），
`avdmanager` 报 `Error: Package path is not valid. Valid system image paths are: …android-33…, …android-30…`。
后经 `sdkmanager "system-images;android-31;google_apis;x86_64"`（约 1.1 GB）补齐才建出 AVD。

**后续注意**：不要假设「镜像都在本地」，建 AVD 前先看 `system-images/<api>/<tag>/<abi>/package.xml` 在不在。

---

## 复跑方式

```bash
export MSYS_NO_PATHCONV=1; export ANDROID_AVD_HOME=D:/android-avd
export ANDROID_HOME=/d/android-sdk; export ANDROID_SDK_ROOT=/d/android-sdk
export PATH="/d/android-sdk/platform-tools:$PATH"

# 一次只开一台（AGENTS.md 硬规则：不并发跑模拟器）
node scripts/compat/boot.mjs --avd compat-api30          # 装 APK + 打印 WebView 原始版本行
node scripts/compat/p0-fallback.mjs --avd compat-api26 --api 26 --no-kill
bash scripts/compat/run-p2.sh 30                          # 7 档串行，每档落 result-p2-<档>.json + logcat
node scripts/compat/p3-net.mjs --api 31                   # 六态弱网
node scripts/compat/p4-layout.mjs --api 30                # 390 / 360 排版

# 视口手工切换
adb shell wm size 1080x1920; adb shell wm density 443     # 390 css
adb shell wm density 480                                   # 360 css
adb shell wm density reset
adb emu kill
```

AVD 保留：`compat-api26`、`compat-api28`、`compat-api29`、`compat-api30`、`compat-api31`、`deepseek-api33`。
