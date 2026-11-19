# API 34（Android 14 · WebView 113）兼容实测

- 设备：**Android Emulator API 34（x86_64，非真实手机）**，AVD `compat-api34`（本 lane 新建，`swiftshader_indirect`）
- `ro.build.version.release` → `14`；`ro.build.version.sdk` → `34`；`ro.build.id` → `UE1A.230829.050`
- 屏幕：`wm size` → `Physical size: 1080x1920`；`wm density` → `Physical density: 420`
- 内存：`MemTotal: 2021100 kB`
- WebView（原始 `dumpsys` 行，**不是按 Android 版本推断**）：

```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=113.0.5672.136
$ adb shell dumpsys webviewupdate
  Current WebView package (name, version): (com.google.android.webview, 113.0.5672.136)
    Valid package com.google.android.webview (versionName: 113.0.5672.136, versionCode: 567263637, targetSdkVersion: 34) is  installed/enabled for all users
```

- App：debug APK `1.4.0-beta.10`（`minSdk 24 targetSdk 36`），包名 `com.example.deepseekchat`，主活动 `.MainActivity`，APK **6,319,781 B**（sha256 `b765bf7e4fee…`）
- 本档定位：**高版本第一档**。补齐 API33 之上的空白，回答「WebView 113 上还会不会白屏 / 落兜底页」

## P0 · 兜底页

`result-p0.json`。安装 `Success`（2891 ms）→ `am start -W` 冷启 3493 ms（`LaunchState: COLD`）→
按 2 s / ~8 s / 13 s / 20 s 四帧采样（`shots/t02s.png`、`t06s.png`、`t13s.png`、`t20s.png`），20 s 后补一帧终帧（`shots/t-final.png`）。

| 采样 | `__DEEPSEEK_BOOTED__` | 兜底卡在不在 | `__DEEPSEEK_COMPATIBILITY_ERROR__` | 正文长度 |
| --- | --- | --- | --- | --- |
| t=2 s | `true` | `false` | `null` | 1106 |
| t=8.1 s | `true` | `false` | `null` | 1106 |
| t=13 s | `true` | `false` | `null` | 1106 |
| t=20 s | `true` | `false` | `null` | 1106 |

结论（逐字）：**未触发兜底页，主包正常执行完毕，`booted=true`，无语义错误。**
`verdict` = `{fallbackBranch: null, fallbackText: null, booted: true, compatibilityErrorValue: null, syntaxErrorInLogcat: false, appAliveAtEnd: true}`；
终帧进程 `pid=3120` 存活。

- logcat（`logcat-api34.txt`，1,856,940 B 全量）里 **没有** `E Capacitor: JavaScript Error`，**没有** `SyntaxError` / `Unexpected token`（`logcat.syntaxErrors = []`）。
- 页面 UA 原文：`Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UE1A.230829.050; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.5672.136 Mobile Safari/537.36`

**环境噪声（如实记录）**：本镜像的 `com.android.bluetooth` 在开机后崩溃，系统弹窗「Bluetooth keeps stopping」盖在 App 上方，
四帧 `uiTexts` 都是 `["Bluetooth keeps stopping","App info","Close app"]`。
所以**这一档的截图看到的是系统崩溃弹窗**，看不到 App 界面；App 自身状态由 CDP 侧 `BOOT_STATE` 判定
（`readyState=complete`、`bodyTextLength=1106`、`hasTextarea=true`、`title=鲸落`），与弹窗无关。
这不影响 P0 结论（兜底页判定走 DOM，不走截图），但**不能拿这四张图当「界面正常」的证据**。

## P1 · 真实上游出字（P0 白屏问题的用户侧验证）

`result-chat.json`。P0 只证明「页面起来了」，这里再证明「能真的收到模型回字」——上游 `http://140.210.13.146:60010`
（直连，非本档形状服务），渠道配置写进 localStorage 后重载：

```json
{"kind":"openai","baseUrl":"http://140.210.13.146:60010","model":"deepseek-v4.1-flash","keyLength":56}
```

（Key 由邀请码服务现签，已脱敏，不进仓库。）

| 项 | 值 |
| --- | --- |
| `verdict` | `TEXT_OK` |
| 首字耗时 `firstTextMs` | 1624 ms |
| 消息行数 `rows` | 2（用户 1 + 助手 1） |
| 终态是否还在流式（`stop` 按钮） | `true` |
| 助手正文 `finalBody` | `你好呀，我在呢。` |
| 失败文案 `failureText` | `null` |
| 截图 | `shots/chat-api34.png` |

即：**WebView 113 上不是「能渲染但聊不了」，真实上游能出字。**

## 与相邻档的对照

| 档 | WebView | P0 | 真实上游出字 |
| --- | --- | --- | --- |
| `compat-api29` | `74.0.3729.185` | 命中出口②（`Uncaught SyntaxError: Unexpected token ?`） | 不可达 |
| `compat-api30` | `83.0.4103.106` | 不触发 | 未测 |
| `compat-api31` | `91.0.4472.114` | 未单独跑（P2/P4 期间页面正常） | 未测 |
| `deepseek-api33` | `109.0.5414.123` | 未单独跑（P4 期间页面正常） | 未测 |
| **`compat-api34`** | **`113.0.5672.136`** | **不触发** | **`TEXT_OK`，1624 ms** |

## 复跑方式

```bash
export ANDROID_AVD_HOME='<android-avd>'; export PATH="<android-sdk>/platform-tools:$PATH"
# P0（自己拉起 AVD，跑完保留设备）
node scripts/compat/p0-fallback.mjs --avd compat-api34 --api 34 --no-kill
# P1（复用同一台设备；Key 走环境变量或 --key，勿写入仓库）
node scripts/compat/p1-chat.mjs --api 34 --budget 60 \
  --base-url http://140.210.13.146:60010 --key "$E2E_API_KEY"
adb emu kill
```

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `result-p0.json` | 设备指纹（含 `dumpsys` 原文行）、安装/冷启耗时、四帧 `BOOT_STATE` + `uiTexts`、logcat 摘要、`verdict` |
| `logcat-api34.txt` | 冷启全程 logcat 全量（1,856,940 B） |
| `shots/t02s.png` `t06s.png` `t13s.png` `t20s.png` `t-final.png` | 四帧 + 终帧截图（**均被系统蓝牙崩溃弹窗覆盖**，见上文环境噪声） |
| `result-chat.json` | 渠道配置、首字耗时、`finalBody`、逐帧采样 |
| `shots/chat-api34.png` | 出字后的聊天界面截图 |

## 未测边界

- **仅模拟器**：`x86_64` + `swiftshader_indirect`。真机、厂商 ROM、真实 ARM 设备**未测**，不得外推。
- 75–112 区间的 WebView 版本**未逐个测**（已有 74 / 83 / 91 / 109 / 113 五点，边界只能判到「74 落兜底、83 正常」）。
- 本档**没跑** P2 导入、P4 排版、长会话 / 附件 / 语音等其余项。
- 系统蓝牙崩溃弹窗是本镜像噪声；本档不据此判断 App 稳定性。
