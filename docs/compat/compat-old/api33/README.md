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

## P2 · 导入（三档全部跑到终态；上一轮的「测具失效」已修，本轮为重跑）

**这一节是重跑结果，覆盖上一版「三档全部未到终态 —— 测具失效」的记录。**
上一轮（WebView 109）三档 `requestCount=0`、`typed.state.value` 是形状服务根地址、按钮 `disabled`，
判定为**测具失效、不出产品结论**。本轮把输入注入从 CDP 直接写 React 受控 `<input type="url">`
换成**系统输入通道**（`adb shell input tap` + `input text`），同一台设备、同一份 APK、同三档归档重跑：

| 档位 | `verdict` | `timedOut` | `requestCount` | `requestBytes` | PSS 峰值 | 终态文案（页面原文） |
| --- | --- | --- | --- | --- | --- | --- |
| `bomb-1000x` | `TERMINAL_TEXT` | `false` | 4 | 66,112 | 101,810 KB | `This ZIP is damaged: its file directory cannot be read, so the file may be truncated or repacked by another tool.` |
| `corrupt-branch` | `TERMINAL_TEXT` | `false` | 1 | 2,164 | 104,762 KB | `Imported 2 chats, skipped 2 damaged items` |
| `edge-200mb` | `TERMINAL_TEXT` | `false` | 54 | 209,715,200（正好 200 MiB） | 179,494 KB | `Import from link failed: The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.` |

取证条件：`compat-api33`（Android 13，WebView `109.0.5414.123`），APK 6,319,781 B（sha256 `b765bf7e4fee…`，与本轮 34/35/36 同一份），安装 `Success`（6025 ms），`am start -W` 4347 ms，
形状服务监听 `0.0.0.0:5411`，每个归档一段 Range 响应；`pidSeen` 全程一个 pid（3996 / 4350 / 4557），
`timedOut=false`，说明三档都是**自然走到终态**、不是测具超时收场。

### 三档各自说明了什么

- **`bomb-1000x`（ZIP 目录炸弹）**：只取了前两个 Range（`bytes=0-4095` → 206/4096 B，`bytes=4096-8296` → 206/4201 B）
  就停下并给出「目录读不出来」的明确文案，`requestBytes` 停在 66 KB，**没有把炸弹整体拉下来**。内存峰值 101,810 KB，进程存活。
- **`corrupt-branch`（坏分支）**：1 次请求 2,164 B 走完，UI 落到「导入 2 条、跳过 2 个损坏项」，
  侧栏出现 `30 Days` / `好会话` / `坏会话` 三条真实会话 —— **部分成功路径在 109 上是通的**。
- **`edge-200mb`（200MB 上限档）**：Range 服务被完整拉满 **209,715,200 B（整整 200 MiB）**，耗时 42.7 s，
  然后**报错**：`Import from link failed: The requested file could not be read …`。
  PSS 峰值 179,494 KB（约 175 MB），进程没死、UI 没白屏，但**下载完了却读不出来**。

### 产品问题（另开单跟踪，本档只留证据）

`edge-200mb` 这条是**真实产品缺陷**，不是测具问题：服务端字节数与 Range 序列证明 200 MiB 全部传到设备（`requestBytes=209715200`），
之后链路在「把已下载的 blob 交给解压」这一步失败，用户看到的是把内部读文件失败直接抛出来的英文文案。
复现：`bash scripts/compat/run-p2.sh 33 edge-200mb`，判据 = `requestBytes` 等于 200 MiB 且终态出现 `Import from link failed`。
（该问题另开 Issue，不在本 PR 改产品代码。）

### 上一版结论为什么错

不是产品在 109 上「导入坏了」，而是**测具写不进受控输入框**：`typed.state.value` 是形状服务根地址、`importDisabled=true`、
`requestCount=0` —— 链路根本没启动。改成系统输入通道后 `typed.state.value` 与归档 URL 一致、`importDisabled=false`，
`requestCount>0`，门禁通过（本轮起点就是「服务端请求数必须 > 0，否则只记测具失效」）。

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
export PATH="<android-sdk>/platform-tools:$PATH"
export ANDROID_AVD_HOME=<android-avd> ANDROID_HOME=<android-sdk> ANDROID_SDK_ROOT=<android-sdk>
node scripts/compat/boot.mjs --avd deepseek-api33
bash scripts/compat/run-p2.sh 33        # 三档；已改用系统输入通道（adb shell input tap/text）
node scripts/compat/p4-layout.mjs --api 33
```

## 证据文件

- `result-p2-{bomb-1000x,corrupt-branch,edge-200mb}.json` + `logcat-p2-*.txt`
- `result-p4.json` + `shots/p4-{390,360}css-{main,settings-general,settings-data,import-form}.png`

## 未测边界

- 真机：未测（模拟器）
- P0 兜底页三出口：未单独跑（主包正常启动）
- P2：三档已跑到终态（见上表）；`bomb-1000x` 只跑到「拒收炸弹」这一层，**更深的嵌套炸弹档未测**
- P3：未跑（109 的弱网结论引用 #150 / #154 既有取证）
- P4 的 `session` / `import-confirm` 两屏：未测
