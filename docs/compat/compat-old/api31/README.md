# API 31（Android 12 · WebView 91）兼容实测

- 设备：Android Emulator API 31（x86_64，非真实手机），AVD `compat-api31`，`swiftshader_indirect`
- `adb shell getprop ro.build.version.release` → `12`；`ro.build.version.sdk` → `31`
- 屏幕：`wm size 1080x1920`；P4 用 `wm density` 切 443（390css）/ 480（360css）
- WebView（原始 `dumpsys` 行）：

```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=91.0.4472.114
```

- App：debug APK `1.4.0-beta.10`（versionCode 17，`minSdk 24 targetSdk 36`），包名 `com.example.deepseekchat`
- 本档是 **交叉验证档**：完整的七档导入在 `api30/` 跑过，这里只对三个关键档（内存炸弹 / 坏分支 / 200MB 上限）复验 91 上的行为

## P0 · 兜底页

**本档没有单独跑 P0**（没有 `result-p0.json`）。

看到的事实：P2、P4 两轮都能进到真实产品 UI（主界面 / 设置-General / 设置-数据 / 导入表单），
说明主包在 WebView 91 上正常执行完毕，兜底页**没有触发**。这两条不能冒充「P0 三出口全部验证」——
兜底页出口 ①/③ 的正向验证在 `api26/`、`api28/`、`api29/` 记录。

## P2 · 导入（三档）

做法同 `api30/`：本机 Range 服务（`10.0.2.2:5411`），每档前 `am force-stop` + `logcat -c` + 冷启动，
约 1.5s 采样界面文案与 `dumpsys meminfo` 的 TOTAL PSS，直到终态文案或超时。

| 档位 | 服务端实际送出 | 终态（`verdict`） | 请求数 / 字节 | PSS 峰值 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `bomb-1000x` | 66,112 B（解压后 64 MB 同一字符） | `TERMINAL_TEXT:Imported` | 4 / 66,112 B | 132,800 KB | `result-p2-bomb-1000x.json` |
| `corrupt-branch` | 2,164 B | `TERMINAL_TEXT:Imported`（损坏项降级，逐条给出会话名与消息号） | 1 / 2,164 B | 113,745 KB | `result-p2-corrupt-branch.json` |
| `edge-200mb` | 209,715,200 B / 54 段 | **失败** `TERMINAL_TEXT:Import from link failed` | 54 / 209,715,200 B | 155,774 KB | `result-p2-edge-200mb.json` |

三档 `timedOut` 均为 `false`，即都走到了真实终态，不是被超时截断。

### 结论（本机、本档）

- **没有白屏，没有进程被杀**：三档采样到的 pid 恒定，大档结束回到主界面仍有正文。
- **200MB（产品自述上限）在 91 上同样是失败**，且失败发生在下载完成之后（54 段、字节数正好 209,715,200），
  与 `api30/`（83）表现一致 —— 说明这条不是单一 WebView 版本的偶发，两档同现象。
- 内存峰值明显低于 83：`bomb-1000x` 132,800 KB vs 83 的 481,587 KB；`edge-200mb` 155,774 KB vs 363,500 KB。
  同一炸弹包在 91 上峰值只有 83 的四分之一左右，**归档解析的内存行为随 WebView 版本变化**，这是实测值，不是推测。
- **1MB / 10MB / 50MB / truncated 四档在本档未测**（不拿 83 的数字外推成 91 的结论）。

## P3 · 弱网（六态：跑了，但没有有效观测）

`result-p3.json` 跑完六态：`s0-ok`(30s) / `s1-hold`(100s) / `s2-cut`(40s) / `s3-trickle`(70s) / `s4-unreachable`(100s) / `s5-offline`(60s)，
形状服务 `10.0.2.2:5419`。

**但六态全部 `firstTextMs=null`、`rows=0`、`finalBody` 为空串，`finalStop=false`** —— 采样器一次都没命中会话区。
截图 `shots/p3-s0-ok.png` … `p3-s5-offline.png` 六张在，但没有可判定的产品行为。

→ 本档 P3 记为**未取得结论**：不是通过，也不是失败。要重做，先得有可用会话（真实 key 或 fake backend），
再让 `p3-net.mjs` 的采样选择器命中消息容器。

WebView 109 上的弱网既有结论见 #150（滴流无限 streaming）与 #154（断网误分类）。

## P4 · 排版抽查（390 / 360 CSS px）

`result-p4.json`，两档视口 × 四屏，`horizontalOverflow` 全为 0、`overflowElements` 全为空：

| 视口 | density | `innerWidth` / `scrollWidth` | 四屏正文长度 |
| --- | --- | --- | --- |
| 390css | 443 | 391 / 391 | main 1025、settings-general 775、settings-data 1062、import-form 1062 |
| 360css | 480 | 360 / 360 | main 1008、settings-general 758、settings-data 1045、import-form 1045 |

- 未测屏：`session`（会话详情，选择器 `[data-session-id], [class*="sessionItem"]` 未命中，本机没有可打开的会话）；
  `import-confirm`（导入确认弹层，链接输入框为空时按钮 `disabled`，属预期，该弹层由 P2 覆盖）。
- #57（`Chat background` 段标题逐字竖排 + 360css 弹层横向溢出）在本档的早期对照里**未复现**，390 / 360 两档排版正常。
  但后续更细的观测（#190）在 WebView 91 上也看到了「设置 → 数据」屏「Chat backup」行文本列塌陷。
  两者不是同一处断言：`result-p4.json` 只测横向溢出、不测列宽，**「横溢 0」不能当作「排版正常」的证据**，
  #190 的逐档复核以 `shots/p4-{390,360}css-settings-data.png` 为准。

## 复跑方式

```bash
export PATH="/d/android-sdk/platform-tools:$PATH"
export ANDROID_AVD_HOME=D:/android-avd ANDROID_HOME=/d/android-sdk ANDROID_SDK_ROOT=/d/android-sdk
node scripts/compat/boot.mjs --avd compat-api31
bash scripts/compat/run-p2.sh 31        # 三档（bomb / corrupt-branch / edge-200mb）
node scripts/compat/p3-net.mjs --api 31
node scripts/compat/p4-layout.mjs --api 31
```

## 证据文件

- `result-p2-{bomb-1000x,corrupt-branch,edge-200mb}.json` + `logcat-p2-*.txt`（三档各自的原始 logcat）
- `result-p3.json` + `shots/p3-s0-ok.png` … `p3-s5-offline.png`
- `result-p4.json` + `shots/p4-{390,360}css-{main,settings-general,settings-data,import-form}.png`

## 未测边界

- 真机、厂商 ROM：未测（本档为模拟器）
- P0 兜底页三出口：未单独跑（主包正常启动，三条出口都不触发）
- P2 的 1MB / 10MB / 50MB / truncated 四档：未测
- P3：跑了六态但没有有效观测，不出结论
- P4 的 `session` / `import-confirm` 两屏：未测
