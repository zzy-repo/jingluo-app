# API 36（Android 16 · WebView 133）兼容实测

- 设备：**Android Emulator API 36（x86_64，非真实手机）**，AVD `compat-api36`（本 lane 新建，`swiftshader_indirect`）
- `ro.build.version.release` → `16`；`ro.build.version.sdk` → `36`；`ro.build.id` → `BE2A.250530.026.F3`
- 屏幕：`wm size` → `Physical size: 1080x1920`；`wm density` → `Physical density: 420`
- 内存：`MemTotal: 2018816 kB`
- WebView（原始 `dumpsys` 行）：

```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=133.0.6943.137
$ adb shell dumpsys webviewupdate
  Current WebView package (name, version): (com.google.android.webview, 133.0.6943.137)
    Valid package com.google.android.webview (versionName: 133.0.6943.137, versionCode: 694313738, targetSdkVersion: 34) is  installed/enabled for all users
```

- App：debug APK `1.4.0-beta.10`（`minSdk 24 targetSdk 36`，即 `targetSdk` 与本档同代），包名 `com.example.deepseekchat`，主活动 `.MainActivity`，APK **6,319,781 B**（sha256 `b765bf7e4fee…`）
- 本档定位：**最高版本档**（等于 App 的 `targetSdk 36`）。回答「今天的最新系统镜像上会不会白屏」

## P0 · 兜底页

`result-p0.json`。安装 `Success`（1944 ms）→ `am start -W` 冷启 4762 ms（`LaunchState: COLD`）→
2 s / 9.5 s / 13.1 s / 20 s 四帧 + 终帧。

| 采样 | `__DEEPSEEK_BOOTED__` | 兜底卡在不在 | `__DEEPSEEK_COMPATIBILITY_ERROR__` | 正文长度 |
| --- | --- | --- | --- | --- |
| t=2 s | `true` | `false` | `null` | 1106 |
| t=9.5 s | `true` | `false` | `null` | 1106 |
| t=13.1 s | `true` | `false` | `null` | 1106 |
| t=20 s | `true` | `false` | `null` | 1106 |

结论（逐字）：**未触发兜底页，白屏未复现，12 s 看门狗没有走到。**
`verdict` = `{fallbackBranch: null, fallbackText: null, booted: true, compatibilityErrorValue: null, syntaxErrorInLogcat: false, appAliveAtEnd: true}`；终帧 `pid=2442` 存活。

- logcat（`logcat-api36.txt`）：**无** `E Capacitor: JavaScript Error`，**无** `SyntaxError` / `Unexpected token`（`logcat.syntaxErrors = []`）。
- 页面 UA 原文含 `Chrome/133.0.6943.137`；`readyState=complete`、`title=鲸落`、`hasTextarea=true`。
- 9.5 s 起 UI 树可见真实产品界面（`鲸落` / `Open sidebar` / `How can I help you?` / `Fast mode` / `Expert mode` / `DeepThink` / `Search` / `Voice input` / `Upload files` / `Send` / `Settings`…）；2 s 帧 UI 树尚未挂载，属采样偏早。

## P1 · 真实上游出字

`result-chat.json`。真实上游 `http://140.210.13.146:60010`，渠道写进 localStorage 后重载：

| 项 | 值 |
| --- | --- |
| `verdict` | `TEXT_OK` |
| 首字耗时 `firstTextMs` | 2203 ms |
| 消息行数 `rows` | 2 |
| 终态流式中 `stop` | `true` |
| 助手正文 `finalBody` | `你好呀，我在。` |
| 失败文案 `failureText` | `null` |
| 截图 | `shots/chat-api36.png` |

即：**`targetSdk 36` + Android 16 + WebView 133 这套组合上，白屏、兜底页、出字三项都正常。**

## 与相邻档的对照

| 档 | WebView | P0 | 真实上游出字 |
| --- | --- | --- | --- |
| `compat-api35` | `124.0.6367.219` | 不触发 | `TEXT_OK`，2666 ms |
| **`compat-api36`** | **`133.0.6943.137`** | **不触发** | **`TEXT_OK`，2203 ms** |

## 复跑方式

```bash
export ANDROID_AVD_HOME='<android-avd>'; export PATH="<android-sdk>/platform-tools:$PATH"
node scripts/compat/p0-fallback.mjs --avd compat-api36 --api 36 --no-kill
node scripts/compat/p1-chat.mjs --api 36 --budget 60 \
  --base-url http://140.210.13.146:60010 --key "$E2E_API_KEY"
adb emu kill
```

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `result-p0.json` | 设备指纹（含 `dumpsys` 原文行）、安装/冷启耗时、四帧 `BOOT_STATE` + `uiTexts`、logcat 摘要、`verdict` |
| `logcat-api36.txt` | 冷启全程 logcat |
| `shots/t02s.png` `t06s.png` `t13s.png` `t20s.png` `t-final.png` | 四帧 + 终帧截图 |
| `result-chat.json` | 渠道配置、首字耗时、`finalBody`、逐帧采样 |
| `shots/chat-api36.png` | 出字后的聊天界面截图 |

## 未测边界

- **仅模拟器**（`x86_64` + `swiftshader_indirect`），真机 / 厂商 ROM 未测。
- 本档没跑 P2 导入、P3 弱网、P4 排版。
- 更高版本（API 37+）尚无镜像，未测。
