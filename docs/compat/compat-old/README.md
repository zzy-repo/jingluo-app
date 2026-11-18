# 旧版本 Android / WebView 兼容性取证（API 30 / API 31）

> **结论口径（全文强制）**：本文所有结论均来自 **Android Emulator API\<NN\>（x86_64，非真实手机）**。
> 不代表真机通过。真机、厂商 ROM（尤其 OPPO 老 WebView）**未测**。

- 取证分支：`fact/compat-old`，基于 `27ac2fa`（1.4.0-beta.10, #140）
- 被测产物：debug APK，`com.example.deepseekchat` v1.4.0-beta.10（versionCode 17），`targetSdkVersion=36`，`application-debuggable`
- 构建：JDK 21 + Gradle 8.14.3 + AGP，`assembleDebug` → 6,305,279 B
- 取证日期：2026-11-18

---

## 环境更正（重要）

工单原先记录「API 30 / 31 / 33 三个系统镜像均已在本地，离线可用，不用下载」。**该记录对 API 31 是错的。**

实测 `/d/android-sdk/system-images/android-31/google_apis/x86_64/` 当时只有一个空壳，内含 `.installer/.installData`，**没有** `package.xml` / `system.img` / `ramdisk.img`。`avdmanager` 原始报错：

```
$ avdmanager create avd -n compat-api31 -k "system-images;android-31;google_apis;x86_64" -d pixel
Error: Package path is not valid. Valid system image paths are:
system-images;android-33;google_apis;x86_64
system-images;android-30;google_apis;x86_64
```

即真正可用的只有 android-30 与 android-33。**这正是 #57 当时「没有 API-31 镜像所以无法复验」的真实原因，且该原因在本次取证开始时依然成立。**

已修复：通过代理重跑

```bash
sdkmanager "system-images;android-31;google_apis;x86_64"   # 约 1.1 GB，Pkg.Revision=12
```

安装后目录含 `package.xml` / `source.properties` / `kernel-ranchu` / `ramdisk.img` / `build.prop` / `data` / `encryptionkey.img` / `VerifiedBootParams.textproto`，`avdmanager` 随即接受该路径并成功创建 AVD。

**后续 lane 注意**：不要再假设「镜像都在本地」，创建 AVD 前先看 `system-images/<api>/<tag>/<abi>/package.xml` 是否存在。

---

## ① WebView 真实版本（命令原始输出）

### API 30
```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=83.0.4103.106

$ adb shell getprop ro.build.version.release    → 11
$ adb shell getprop ro.build.version.sdk        → 30
```
**WebView = 83.0.4103.106**

### API 31
```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=91.0.4472.114
    versionName=91.0.4472.114

$ adb shell getprop ro.build.version.release    → 12
$ adb shell getprop ro.build.version.sdk        → 31
```
**WebView = 91.0.4472.114**

（版本号一律取自 `dumpsys` 原始输出，未按 Android 版本推断。）

---

## ② 启动是否白屏 / logcat 是否出现 SyntaxError

**两档都没有白屏，两档 logcat 都没有 SyntaxError。**

```
$ grep -c -i "SyntaxError\|Unexpected token" logcat-api30.txt  → 0
$ grep -c -i "SyntaxError\|Unexpected token" logcat-api31.txt  → 0
```

即 #104 的根因症状 `Uncaught SyntaxError: Unexpected token '?'` **在 WebView 83 与 WebView 91 上均未复现**。这与「WebView 83 已支持可选链」的技术事实一致（可选链 Chrome 80+ 支持）。

冷启动后 WebView 侧唯一出现的报错是无害的 Crashpad 目录与 EGL 回落（**逐字粘贴**，API 30）：

```
11-18 15:57:40.208  3427  3427 E chromium: [ERROR:filesystem_posix.cc(62)] mkdir /data/user/0/com.example.deepseekchat/cache/WebView/Crashpad: No such file or directory (2)
11-18 15:57:40.855  3427  3580 E chromium: [ERROR:gl_surface_egl.cc(549)] eglChooseConfig failed with error EGL_SUCCESS
11-18 15:57:40.881  3427  3580 E chromium: [ERROR:gl_surface_egl.cc(549)] eglChooseConfig failed with error EGL_SUCCESS
```
API 31 无 `E chromium` 行（`grep " E chromium" logcat-api31.txt` 无输出）。

---

## ③ 兜底页（fallback）是否生效

**未触发，且本轮无法用「缺少：」分支验证 —— 因为两档 WebView 都满足全部 12 项探测。**

- 两档启动后都进入了**真实产品 UI**（主聊天页 / 设置页），说明 web bundle 正常执行完毕。
- 兜底闸位于 `dist/index.html` 的内联 **classic script**（非 module），检测 12 项：`Promise / fetch / URL / AbortController / TextDecoder / ResizeObserver / CSS.escape / Object.defineProperty / Array.prototype.forEach / Map / Set / WeakMap`；缺项则显示
  `页面启动失败。请更新 Android System WebView 或浏览器后重试；仍失败请反馈组件版本与以下信息：` + `缺少：<列表>`
- 另有 12s 看门狗：`window.__DEEPSEEK_BOOTED__` 未置位即判定 `脚本 12 秒内没有启动（内核过旧或资源加载失败）`
- WebView 83 / 91 对这 12 项**全部支持**，因此**两条兜底分支本轮都未走到**（既没有「缺少：」也没有「12 秒内没有启动」）。这是预期结果，但意味着**兜底页的正向有效性本轮未被证明**，需要更老的 WebView（< 80）才能真正验证。

---

## ④ 主流程冒烟（4 项，逐项判定）

| # | 项目 | 结果 | 依据 |
|---|---|---|---|
| 1 | 能进主界面 | **通过** | 主聊天页 UI 树含 `How can I help you?` / `Chat mode` / `Fast mode` / `Expert mode` / `DeepThink` / `Search` / `Voice input` / `Upload files` / `Send` / `AI-generated, for reference only`；截图 `api30/shot-api30-chat.png` |
| 2 | 能发一条消息（fake key / fake backend） | **未测** | 本轮未搭 fake backend stub，也未配置 fake key；**不能记为通过** |
| 3 | 设置页能打开 | **通过** | 首次启动自动弹出设置页，两档均正常渲染（见 ⑤ 截图） |
| 4 | 设置 → 数据管理能打开 | **未通过** | 点击 `Data` 页签后内容**未切换**，仍显示 General 的 Channel / API Key / Connection test。置于灰底选中态却无内容变化。截图 `api30/shot-api30-data-tab.png` |

> 说明：App 首次启动（无 API Key）会**自动打开设置页**，属预期行为，不是白屏也不是缺陷。

---

## ⑤ 设置页 390 / 360 排版回归（#57 复验）—— 本轮重点

视口换算：`css_px = 物理宽 / (density / 160)`，物理宽固定 1080。
- **390 css** → `wm density 443`（1080×160/443 = 390）
- **360 css** → `wm density 480`（1080×160/480 = 360）

### API 30（WebView 83）—— **#57 复现，且比原描述更严重**

绝对路径：
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-390-settings.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-390-data.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-390-scrolled.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-360-scrolled.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-default.png`（原生 411 css）
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-data-tab.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\shot-api30-chat.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api30\logcat-api30.txt`

现象：
1. **390 css**：`Chat background` 段标题塌成**每行一个字符**的竖排（`C` `h` `a` `t` `b` `a` `c` `k` 逐行向下），副标题整段同样竖排。
2. **原生 411 css**（未改 density）同样竖排 —— 证明**不是 density override 造成的假象**，是真实 CSS 布局缺陷。
3. **360 css**：恶化成**整个弹层横向溢出** —— 右上角 `×` 关闭按钮与 `Data` 页签被推出屏幕右边缘不可见，正文仍竖排。
4. 表头 `Settings` / 页签 `General` / `Data` / 行标签 `Channel` / `API Key` / `Connection test` 渲染正常 —— 说明是**文本块宽度约束**失效（flex/grid 子项未给 `min-width:0` 类问题），不是整体缩放。

### API 31（WebView 91）—— **#57 未复现**

绝对路径：
- `D:\all_project\runs\compatold\docs\compat\compat-old\api31\shot-api31-390-settings.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api31\shot-api31-360-settings.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api31\shot-api31-default.png`
- `D:\all_project\runs\compatold\docs\compat\compat-old\api31\logcat-api31.txt`

现象：390 与 360 两档**排版均正常** —— `Chat background` 单行完整，副标题 `Stored on this device only (IndexedDB), never uploaded; resized to 1600px max edge` 正常折成 2 行，`Upload` / `Clear` 按钮完整在屏内，`×` 与 `Data` 页签均未溢出。**#57 的修复在 WebView 91 上有效。**

---

## ⑥ 与 API 33（WebView 109）基线的差异归因

| 维度 | API 30 / WebView 83 | API 31 / WebView 91 | API 33 / WebView 109（基线） |
|---|---|---|---|
| 设置页 390/360 排版 | **塌成一列 + 360 横向溢出** | 正常 | 正常 |
| 启动白屏 | 无 | 无 | 无 |
| `?.` SyntaxError | 无 | 无 | 无 |
| 兜底页触发 | 未触发 | 未触发 | 未触发 |

**归因：`设置页排版塌陷` = WebView 版本差异导致，不是 Android 版本差异导致。**

依据：
1. API 30 与 API 31 同时跨越了「Android 11 → 12」和「WebView 83 → 91」两个变量，单看这两档无法区分。
2. 但 API 33（WebView 109）与 API 31（WebView 91）**Android 版本不同、WebView 版本也不同，排版却都正常**；而 API 33 基线此前已确认正常。
3. 结合 #57 历史：该排版问题此前是按「WebView 91 布局」修的，修复点在 CSS 层。**WebView 83 → 91 之间恰好是 `gap` / `flex-basis:auto` / `min-width:auto` 在 flex 子项上行为差异的典型区间**，与观察到的「文本块宽度塌陷」症状吻合。
4. 因此结论是 **WebView 内核版本**决定，而非 Android 平台版本决定。（严格证明需在同一 Android 版本上换 WebView 版本对照，本轮未做 —— 见 ⑧。）

---

## ⑦ 缺陷清单（**未修复**，仅取证）

### D1 — 设置页在 WebView 83 下文本块塌成一列（严重）
- **严重级：高**（可用性受损，设置页信息不可读；360 css 下关闭按钮不可达 = 无法退出设置页）
- 环境：Android Emulator API30（x86_64，非真实手机），WebView 83.0.4103.106
- 现象：`Chat background` 标题与副标题均每行一个字符竖排；360 css 下整个弹层横向溢出，`×` 与 `Data` 页签被推出屏幕外
- 复现：100%（原生 411 / 390 / 360 三档均复现）
- 证据：`api30/shot-api30-default.png`、`api30/shot-api30-390-scrolled.png`、`api30/shot-api30-360-scrolled.png`
- 备注：疑似 flex/grid 子项缺少 `min-width: 0`（或 `flex-shrink`/`overflow-wrap` 在旧内核下行为差异），**未改代码，待统一开单**

### D2 — 设置页 `Data` 页签点击后内容不切换（严重）
- **严重级：高**（数据管理入口不可用）
- 环境：Android Emulator API30（x86_64，非真实手机），WebView 83.0.4103.106
- 现象：点击 `Data` 页签（灰底选中态）后，内容区仍为 General 的 Channel / API Key / Connection test，无任何变化
- 证据：`api30/shot-api30-data-tab.png`
- 备注：**未在 API 31 / API 33 上对照**，因此无法判断是 WebView 83 专属还是通用缺陷 —— 列入待查，**不要直接当 WebView 83 专属缺陷开单**

### D3 — 冒烟项 2、4 未通过/未测
- 见 ④ 表格。属**取证缺口**而非确认缺陷（D2 除外）。

---

## ⑧ 未测边界

1. **真机**：全程模拟器（x86_64），无任何真机结论。
2. **其他厂商 ROM**：未测。**OPPO 等老 WebView 是 #104 线上症状的真实来源，本轮完全没覆盖** —— 这是最大缺口。
3. **比 WebView 83 更老的内核**：未测。因此「兜底页的『缺少：』分支」与「12s 看门狗分支」**都未获正向验证**（83/91 全部满足 12 项探测）。
4. **> API 33**：未测（API 34 / 35 / 36 未跑）。
5. **Android < API 30**：未测（minSdk 24 下限方向未验证）。
6. **同一 Android 版本换 WebView 版本对照**：未做 —— 所以 ⑥ 的归因是**强推断而非受控实验**。
7. **发消息链路**：未测（无 fake backend）。
8. **深色模式 / 横屏 / 多语言**：未测（本轮 locale 为 en-US，UI 呈现英文）。

---

## 附：可复现命令

```bash
export MSYS_NO_PATHCONV=1; export ANDROID_AVD_HOME=D:/android-avd
export ANDROID_HOME=/d/android-sdk; export ANDROID_SDK_ROOT=/d/android-sdk
ADB=/d/android-sdk/platform-tools/adb.exe

# 一次只开一台（AGENTS.md 硬规则）
/d/android-sdk/emulator/emulator.exe -avd compat-api30 -no-snapshot -no-boot-anim -no-audio -gpu swiftshader_indirect &

$ADB shell dumpsys package com.google.android.webview | grep versionName
$ADB install -r "D:/all_project/runs/compatold/android/app/build/outputs/apk/debug/app-debug.apk"
$ADB logcat -c && $ADB shell am start -n com.example.deepseekchat/.MainActivity
$ADB logcat -d > logcat-api30.txt

# 视口
$ADB shell wm size 1080x1920
$ADB shell wm density 443      # 390 css
$ADB shell wm density 480      # 360 css
$ADB shell wm density reset
$ADB exec-out screencap -p > shot.png

$ADB emu kill
```

## 附：AVD 保留情况

保留且未被删除：`compat-api30`、`compat-api31`（本轮新建）、`deepseek-api33`、`probe33`（既有，未改动）。

---

# P0 · 兜底页正向验证（2026-11-19 补测，API26 / API28 / API29）

## 为什么要补这一档

兜底页（`src/index.html` 内联 ES5 守卫）实际有**三条**出口，此前一条都没被触发过：

| 出口 | 触发条件 | 文案 |
| --- | --- | --- |
| ① 探针缺失 | 12 条特性探针任一不满足 | `…：缺少：<API 列表>` |
| ② window error | 捕获到脚本错误（`addEventListener('error', …, true)`） | `…：<event.message>` |
| ③ 12s 看门狗 | 探针齐但 `__DEEPSEEK_BOOTED__` 12 秒没置位 | `…：脚本 12 秒内没有启动（内核过旧或资源加载失败）` |

在 WebView 83 / 91 / 109 上三条都不触发（主包正常启动）。只有在 WebView < 80（主包含可选链）才能实测。

## 实测结果（三档一致）

| AVD | WebView 原始版本行 | 兜底页 | 命中出口 | `__DEEPSEEK_BOOTED__` | `__DEEPSEEK_COMPATIBILITY_ERROR__` |
| --- | --- | --- | --- | --- | --- |
| compat-api26 | `versionName=69.0.3497.100` | 出现（非纯白） | ② window error | false | `null` |
| compat-api28 | `versionName=69.0.3497.100` | 出现（非纯白） | ② window error | false | `null` |
| compat-api29 | `versionName=74.0.3729.185` | 出现（非纯白） | ② window error | false | `null` |

用户可见文案（三档逐字一致，四帧采样 2s/6s/13s/20s + 最终帧）：

```
页面启动失败。请更新 Android System WebView 或浏览器后重试；仍失败请反馈组件版本与以下信息：Uncaught SyntaxError: Unexpected token ?
```

logcat（三档同一条主包）：

```
E Capacitor: JavaScript Error: {"type":"js.error","error":{"message":"Uncaught SyntaxError: Unexpected token ?","url":"https://localhost/static/js/main.030dd2a6.js","line":1,"col":249411,...}}
E Capacitor/Console: File: https://localhost/ - Line 811 - Msg: SyntaxError: Unexpected token ?
```

结论：

1. WebView 69 / 74 上**不是纯白屏** —— 兜底守卫确实接住了解析失败，卡片出现。
2. 但落的是出口 ②，把**未本地化的英文原文**（`Uncaught SyntaxError: Unexpected token ?`）直接展示给用户，且 `__DEEPSEEK_COMPATIBILITY_ERROR__` 为 `null`（只有出口 ① 才写这个变量）→ 诊断链路拿不到结构化原因。
3. 出口 ① / ③ 仍然**未触发过**（69/74 的 12 条探针全过；要触发 ① 需要 WebView < 64 或人为缺项）。
4. 白屏边界实测：WebView 74 → 兜底卡；WebView 83 → 正常启动。中间 75–82 无系统镜像可用，**未测**（不做推断）。

## 覆盖总表（P0–P4）

| AVD / Android | WebView 原始版本（dumpsys） | P0 兜底页 | P1 白屏边界 | P2 导入 | P3 弱网 | P4 390/360 排版 |
| --- | --- | --- | --- | --- | --- | --- |
| compat-api26 | `versionName=69.0.3497.100` | 兜底出口②，文案泄漏英文原文（证据 `api26/`） | 非白屏（同上） | 未测：UI 不可达 | 未测：UI 不可达 | 未测：UI 不可达 |
| compat-api28 | `versionName=69.0.3497.100` | 同上（`api28/`） | 非白屏 | 未测：UI 不可达 | 未测：UI 不可达 | 未测：UI 不可达 |
| compat-api29 | `versionName=74.0.3729.185` | 同上（`api29/`） | 非白屏 | 未测：UI 不可达 | 未测：UI 不可达 | 未测：UI 不可达 |
| compat-api30 | `versionName=83.0.4103.106` | 不触发，`booted=true`（`api30/result-p0.json`） | 正常启动 | 未测 | 未测 | 主界面 390css(391) / 360css(360) 横溢 0 元素；设置页/会话页未测（`api30/result-p4.json`） |
| compat-api31 | `versionName=91.0.4472.114` | 不触发，`booted=true`（`api31/`） | 正常启动 | 未测 | 未测 | 未测（仅 #57 排版对照，见上） |
| deepseek-api33 | `versionName=109.0.5414.123` | 不触发 | 正常启动 | 未测（109 既有结果见 #133） | 109 既有：48s 超时 / 滴流无限 streaming #150 / offline 误分类 #154 | 未测 |

「未测」= 没跑过，不是通过。P1（API 34/35/36「更高版本也不会炸」）未测：镜像尚未装完，本轮未跑。
