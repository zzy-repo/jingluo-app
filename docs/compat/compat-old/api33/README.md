# API 33（Android 13 · WebView 109）兼容实测

- 设备：Android Emulator API 33（x86_64，非真实手机），AVD `deepseek-api33`（既有 AVD，非本 lane 新建）
- `ro.build.version.sdk` → `33`；设备 `dpr = 3`
- WebView（原始 `dumpsys` 行）：

```
$ adb shell dumpsys package com.google.android.webview | grep versionName
    versionName=109.0.5414.123
```

- App：debug APK `1.4.0-beta.10`（versionCode 17，`minSdk 24 targetSdk 36`），包名 `com.example.deepseekchat`
- 本档定位：**最新的对照档**。109 上的长会话 / 弱网结论属既有单（#133、#150、#154），本轮只补 P2 与 P4 的横向对照

## P0 · 兜底页

**本档没有单独跑 P0**（没有 `result-p0.json`）。可确认的事实：P4 两档视口下页面都正常渲染
（`main` 屏 `bodyTextLength=52`，即空会话主界面），主包正常执行完毕，兜底页未触发。

「兜底页三条出口都验证过」这句话**不适用于本档** —— 出口 ② 的正向证据在 `api26/`、`api28/`、`api29/`。

## P2 · 导入（三档全部未到终态 —— 测具失效，不是产品结论）

三档（`bomb-1000x` / `corrupt-branch` / `edge-200mb`）结果一致：

| 档位 | `verdict` | `timedOut` | `requestCount` | `requestBytes` | PSS 峰值 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `bomb-1000x` | `NO_TERMINAL_TEXT` | `true` | 0 | 0 | 102,823 KB | `result-p2-bomb-1000x.json` |
| `corrupt-branch` | `NO_TERMINAL_TEXT` | `true` | 0 | 0 | 104,046 KB | `result-p2-corrupt-branch.json` |
| `edge-200mb` | `NO_TERMINAL_TEXT` | `true` | 0 | 0 | 94,572 KB | `result-p2-edge-200mb.json` |

### 根因：测具没能把 URL 写进链接框

json 里的直接证据：

- `typed.state.value` = `http://10.0.2.2:5398/v1` —— 这是**测具自己形状服务的根地址**，不是归档 URL
  （正确值形如 `http://10.0.2.2:5398/a/<档>.zip`）。`corrupt-branch` 档更把两串粘在一起：
  `http://10.0.2.2:5398http://10.0.2.2/v1`。
- `typed.state.importDisabled` = `true`，于是 `startClick.clicked=false`、`startClick.reason="disabled"`；
  `confirmClick.clicked=false`。
- 全程 `requestCount=0`，形状服务一次请求都没收到，所以三档只可能是超时。

即：**测具向 React 受控 `<input type="url">` 写值的方式在 WebView 109 上没生效**（同样的手法在 83 / 91 上成功），
按钮一直是禁用态，链路根本没启动。**本档 P2 不出任何产品结论**：不说「109 导入失败」，也不说「109 通过」。

修法在测具侧（`scripts/compat/lib/cdp.mjs` 的输入注入方式，需改用原生 `input text` 或 React 认可的输入事件序列），不改产品。

## P3 · 弱网

本档**未跑** P3。109 上的弱网结论沿用既有单：滴流无限 streaming **#150**、断网误分类 **#154**
（证据在 #133 那一轮的取证，`docs/repro/` 下，不在本目录）。

## P4 · 排版抽查（390 / 360 CSS px）

`result-p4.json`，两档视口 × 四屏，`horizontalOverflow` 全为 0、`overflowElements` 全为空：

| 视口 | density | `innerWidth` / `scrollWidth` | 四屏正文长度 |
| --- | --- | --- | --- |
| 390css | 443 | 391 / 391 | main 52、settings-general 720、settings-data 1043、import-form 1043 |
| 360css | 480 | 360 / 360 | main 52、settings-general 720、settings-data 1043、import-form 1043 |

- `main` 的 52 是因为本档是空会话（没有历史消息），不是渲染缺失 —— 设置类屏的 720 / 1043 说明 DOM 正常。
- 未测屏：`session`（选择器未命中，本机没有可打开的会话）、`import-confirm`（链接输入框为空时按钮 `disabled`，属预期）。
- 横向溢出为 0，与 83 / 91 一致。**#190 记录的「Chat backup」行单字塌陷属 WebView 83 / 91 范围**；
  本档设置-数据屏已截图（`shots/p4-{390,360}css-settings-data.png`），但 `result-p4.json` 不测量列宽，
  所以本档**不据此断言 #190 是否存在** —— 需要看图逐帧判定。

## 复跑方式

```bash
export PATH="/d/android-sdk/platform-tools:$PATH"
export ANDROID_AVD_HOME=D:/android-avd ANDROID_HOME=/d/android-sdk ANDROID_SDK_ROOT=/d/android-sdk
node scripts/compat/boot.mjs --avd deepseek-api33
bash scripts/compat/run-p2.sh 33        # 三档（当前测具在 109 上失效，需先修输入注入）
node scripts/compat/p4-layout.mjs --api 33
```

## 证据文件

- `result-p2-{bomb-1000x,corrupt-branch,edge-200mb}.json` + `logcat-p2-*.txt`
- `result-p4.json` + `shots/p4-{390,360}css-{main,settings-general,settings-data,import-form}.png`

## 未测边界

- 真机：未测（模拟器）
- P0 兜底页三出口：未单独跑（主包正常启动）
- P2：三档因测具失效**未取得结论**，需修输入注入后重跑
- P3：未跑（109 的弱网结论引用 #150 / #154 既有取证）
- P4 的 `session` / `import-confirm` 两屏：未测
