# API 35（Android 15 · WebView 124）兼容实测

- 设备：**Android Emulator API 35（x86_64，非真实手机）**，AVD `compat-api35`（本 lane 新建，`swiftshader_indirect`）
- `ro.build.version.release` → `15`；`ro.build.version.sdk` → `35`；`ro.build.id` → `AE3A.240806.043`
- 屏幕：`wm size` → `Physical size: 1080x1920`；`wm density` → `Physical density: 420`
- 内存：`MemTotal: 2018936 kB`
- WebView（原始 `dumpsys` 行）：

```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=124.0.6367.219
$ adb shell dumpsys webviewupdate
  Current WebView package (name, version): (com.google.android.webview, 124.0.6367.219)
    Valid package com.google.android.webview (versionName: 124.0.6367.219, versionCode: 636771938, targetSdkVersion: 34) is  installed/enabled for all users
```

- App：debug APK `1.4.0-beta.10`（`minSdk 24 targetSdk 36`），包名 `com.example.deepseekchat`，主活动 `.MainActivity`，APK **6,319,781 B**（sha256 `b765bf7e4fee…`）
- 本档定位：**高版本中间档**。补 API34 与 API36 之间的版本点，确认不是「只有某一版镜像能跑」

> 补记：本档原先缺 `platforms/android-35`（只有 system image），本轮用
> `sdkmanager --install "platforms;android-35"` 补齐后新建 AVD `compat-api35` 才跑起来。

## P0 · 兜底页

`result-p0.json`。安装 `Success`（6120 ms）→ `am start -W` 冷启 4560 ms（`LaunchState: COLD`）→
2 s / 7.6 s / 13 s / 20 s 四帧 + 20 s 后终帧。

| 采样 | `__DEEPSEEK_BOOTED__` | 兜底卡在不在 | `__DEEPSEEK_COMPATIBILITY_ERROR__` | 正文长度 |
| --- | --- | --- | --- | --- |
| t=2 s | `true` | `false` | `null` | 1106 |
| t=7.6 s | `true` | `false` | `null` | 1106 |
| t=13 s | `true` | `false` | `null` | 1106 |
| t=20 s | `true` | `false` | `null` | 1106 |

结论（逐字）：**未触发兜底页，白屏未复现，主包正常执行完毕。**
`verdict` = `{fallbackBranch: null, fallbackText: null, booted: true, compatibilityErrorValue: null, syntaxErrorInLogcat: false, appAliveAtEnd: true}`；终帧 `pid=2628` 存活。

- logcat（`logcat-api35.txt`）：**无** `E Capacitor: JavaScript Error`，**无** `SyntaxError` / `Unexpected token`（`logcat.syntaxErrors = []`）。
- 页面 UA 原文含 `Chrome/124.0.6367.219`；`readyState=complete`、`title=鲸落`、`hasTextarea=true`。
- 7.6 s 之后的三帧 `uiTexts` 已能看到真实产品 UI（`鲸落` / `Open sidebar` / `How can I help you?` / `Fast mode` / `Expert mode` / `DeepThink` / `Search` / `Voice input` / `Upload files` / `Send` / `Settings` …），
  首帧（2 s）UI 树还没挂上，属采样时刻偏早，不是白屏（DOM 侧 2 s 就已 `bodyTextLength=1106`）。

## P1 · 真实上游出字

`result-chat.json`。同 API34 的口径：真实上游 `http://140.210.13.146:60010`，渠道写进 localStorage 后重载，再发一条消息。

| 项 | 值 |
| --- | --- |
| `verdict` | `TEXT_OK` |
| 首字耗时 `firstTextMs` | 2666 ms |
| 消息行数 `rows` | 2 |
| 终态流式中 `stop` | `true` |
| 助手正文 `finalBody` | `你好呀，我在呢。` |
| 失败文案 `failureText` | `null` |
| 截图 | `shots/chat-api35.png` |

## 与相邻档的对照

| 档 | WebView | P0 | 真实上游出字 |
| --- | --- | --- | --- |
| `compat-api34` | `113.0.5672.136` | 不触发 | `TEXT_OK`，1624 ms |
| **`compat-api35`** | **`124.0.6367.219`** | **不触发** | **`TEXT_OK`，2666 ms** |
| `compat-api36` | `133.0.6943.137` | 不触发 | `TEXT_OK`，2203 ms |

## 复跑方式

```bash
export ANDROID_AVD_HOME='<android-avd>'; export PATH="<android-sdk>/platform-tools:$PATH"
node scripts/compat/p0-fallback.mjs --avd compat-api35 --api 35 --no-kill
node scripts/compat/p1-chat.mjs --api 35 --budget 60 \
  --base-url http://140.210.13.146:60010 --key "$E2E_API_KEY"
adb emu kill
```

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `result-p0.json` | 设备指纹（含 `dumpsys` 原文行）、安装/冷启耗时、四帧 `BOOT_STATE` + `uiTexts`、logcat 摘要、`verdict` |
| `logcat-api35.txt` | 冷启全程 logcat |
| `shots/t02s.png` `t06s.png` `t13s.png` `t20s.png` `t-final.png` | 四帧 + 终帧截图 |
| `result-chat.json` | 渠道配置、首字耗时、`finalBody`、逐帧采样 |
| `shots/chat-api35.png` | 出字后的聊天界面截图 |

## 未测边界

- **仅模拟器**（`x86_64` + `swiftshader_indirect`），真机 / 厂商 ROM 未测。
- 本档没跑 P2 导入、P3 弱网、P4 排版。
- `platforms;android-35` 是本轮现场补装的；若换机复跑需先补该 platform。
