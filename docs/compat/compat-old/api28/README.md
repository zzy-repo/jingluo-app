# API 28（Android 9.0 · x86_64 模拟器）· WebView 69.0.3497.100

## 环境口径

```
Android Emulator API28（x86_64，非真实手机）
```
（不是真机，模拟器 GPU 为 swiftshader_indirect，勿当真实手机结论）

WebView 原始版本行（`adb shell dumpsys package com.google.android.webview | grep versionName`）：

```
    versionName=69.0.3497.100
```

- AVD：`compat-api28`（`ANDROID_AVD_HOME=D:/android-avd`，镜像 `system-images;android-28;google_apis;x86_64`）
- 被测包：`com.example.deepseekchat` 1.4.0-beta.10（versionCode 17，targetSdk 36，debug APK 6,305,279 B）

## P0 · 兜底页正向验证（2026-11-19 00:39 实测）

**结论：主包解析失败，兜底页命中「window error」分支，把未本地化的英文原文甩到用户面前。**

冷启动后 2s / 6s / 13s / 20s 四帧 + 最终帧采样，`window.__DEEPSEEK_BOOTED__` 全部为 `false`，App 进程存活（pid 3756，未被杀）。

用户可见文案（`#compatibility-error` 的 `textContent` 原文，四帧一致）：

```
页面启动失败。请更新 Android System WebView 或浏览器后重试；仍失败请反馈组件版本与以下信息：Uncaught SyntaxError: Unexpected token ?
```

- 兜底页出现：是（**不是纯白屏**）
- 命中分支：`window.addEventListener('error', ...)` → `showFailure(event.message)`（`src/index.html` 第 46、76-84 行）
- 不是 `缺少：<API 列表>` 分支（12 条探针全部通过；由「error 分支文案胜出」反推 —— `showFailure` 有「已有提示不覆盖」逻辑，探针缺项会先占位并显示「缺少：…」。探针结果未单独读取，属反推）
- 不是 `脚本 12 秒内没有启动` 分支（实测文案非此串）
- `window.__DEEPSEEK_COMPATIBILITY_ERROR__` = `null`（该变量只在探针缺失分支赋值，error 分支不写 → 诊断链路拿不到原因）

logcat 原始行：

```
11-18 16:39:31.952  3756  4053 E Capacitor: JavaScript Error: {"type":"js.error","error":{"message":"Uncaught SyntaxError: Unexpected token ?","url":"https://localhost/static/js/main.030dd2a6.js","line":1,"col":249411,"errorObject":"{}"}}
11-18 16:39:31.997  3756  3756 E Capacitor/Console: File: https://localhost/ - Line 811 - Msg: SyntaxError: Unexpected token ?
```

主包 `main.030dd2a6.js` 第 249411 列处的 `?`（可选链 / 空值合并）在 Chromium 69 上不支持 → 整包 SyntaxError → 不启动。

截图显示红色兜底卡片右侧被黑色区块遮挡、文字溢出卡片外（`shots/t20s.png`、`shots/t-final.png`）。**该遮挡原因未查明**，可能与 swiftshader 合成或截图时机有关，不作为产品缺陷断言。

## 复现

```bash
export PATH="/d/android-sdk/platform-tools:$PATH"
cd /d/all_project/runs/compatold
node scripts/compat/p0-fallback.mjs --avd compat-api28 --api 28 --no-kill
```

## 证据文件

- `result-p0.json` — 全部原始测量值
- `logcat-api28.txt` — 冷启动全程 logcat（含 Chromium/Capacitor CONSOLE 行）
- `shots/t02s.png` `shots/t06s.png` `shots/t13s.png` `shots/t20s.png` `shots/t-final.png`

## 未测边界

- 真机上的同版本 WebView（本档为模拟器）
- 「缺少：<API 列表>` 分支与「脚本 12 秒内没有启动」分支仍未触发（探针全过；需要 WebView < 64 或人为注入缺失场景）
- P1 之后的导入 / 弱网 / 排版项：主包起不来，UI 不可达，全部未测（不是「通过」）
