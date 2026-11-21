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

## P3 · 弱网（六态重跑：六态全部有可判定行为）

**本节是重跑结果，覆盖上一版「六态跑了但没有有效观测」。**
上一版六态 `firstTextMs=null`、`rows=0`、`finalBody=""`，是测具问题，产品侧无结论。
修了两处后才拿到数据：

1. 渠道没落在请求路径上 —— 只写了 `chat-demo:base-url:openai`，但本构建默认渠道是 `deepseek`，
   消息根本没打到形状服务；现在 `prepare()` 显式写 `chat-demo:provider-kind=openai` + 模型 + key，再关掉首启设置弹层。
2. `firstTextMs` 被占位文案污染 —— 每条消息都有 `Waiting for the response` 占位行，旧采样把它当成「首字」，
   于是六态首字全都「≈5 s」。现在只认去掉占位/状态行之后还剩下的正文。

形状服务 `10.0.2.2:5419`，死端口 `10.0.2.2:5418` 作不可达对照；**每态记服务端实际收到的请求行数**，请求数为 0 的档不算产品观测。

| 态 | 服务端收到 | 首字（去掉占位后） | 行数 | 终态文案（页面原文） | 自动重试 | 卡死不可恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| `s0-ok` | 4 | 102 ms | 2 | `这是对照组：正常 200 + SSE 分片，回答完整收尾。` | 0 | 否 |
| `s1-hold` | 6（原请求 + 2 次重试） | 15036 ms | 2 | `Request timed out (15s with no response). Check your network and try again.` | 2 | 否（有解释、可再发） |
| `s2-cut` | 2 | 71 ms | 2 | 先收到两段正文，随后追加 `The connection was interrupted and the reply is incomplete. What was received is kept — you can regenerate.` | 0 | 否 |
| `s3-trickle` | 4 | 48 ms | 2 | 8 段全部到达、21.1 s 自然收尾，无错误文案 | 0 | 否 |
| `s4-unreachable` | **0**（连接被拒） | 49 ms（重试文案） | 2 | `Network Error. Please check your network status.` | 2 | 否 |
| `s5-offline` | **0**（飞行模式） | 50 ms（重试文案） | 2 | `Network Error. Please check your network status.` | 2 | 否 |

### 逐态结论

- **`s0-ok` 对照组通过**：102 ms 出首字、1.07 s 收尾、零重试 —— 说明后面五态的异常都是形状服务造的，不是链路先天坏。
- **`s1-hold`（半死连接 / 一个字节都不回）**：15 s 无响应 → 自动重试 2 次（服务端确实收到 3 组 `POST`），
  48 s 落到 `Request timed out (15s with no response).`，**文案明确、可重发、进程存活**。与 WebView 109 的既有结论同向（#133 记录的行为），无新增缺陷。
- **`s2-cut`（回两段后 socket 被 destroy）**：已收正文**保留**并追加「连接中断、回复不完整、可重新生成」的说明，
  没有把半截回答伪装成完整回答。这是本档最干净的一条降级路径。
- **`s3-trickle`（每 3 s 一段、共 8 段）**：8 段全部落到界面、21.1 s 自然收尾、无超时误杀、无重试。
  即「有内容持续到达时不会误判网络故障」。
- **`s4-unreachable`（端口没人监听）**：重试 2 次后 3.1 s 结束，文案 `Network Error. Please check your network status.`；服务端 0 请求，符合预期。
- **`s5-offline`（飞行模式，形态服务就是 `s0-ok` 那个地址）**：3.07 s 结束，文案与 `s4` **逐字相同**：
  `Network Error. Please check your network status.` —— **设备离线与「服务端拒绝连接」拿到同一条提示**，
  这与 #154（断网被归为普通网络异常、不能让用户区分「我没网」还是「服务坏了」）**同向复现**，属继承问题，不是本档新增。

### 与 WebView 109 基线的对照

| 行为 | 109（#133 / #150 / #154 既有取证） | 本档 91 |
| --- | --- | --- |
| hold：无字节 → 重试 2 次后给明确超时文案 | 一致 | **一致** |
| cut：断流保留半截 + 提示可重生成 | 一致 | **一致** |
| trickle：慢速滴流不误判、跑完收尾 | 109 上曾记「滴流无限 streaming」（#150） | 本档 **8 段跑完 21 s 自然收尾**，未见无限 streaming |
| offline：与不可达共用一条 `Network Error` | 一致（#154） | **一致** |

trickle 一项与 #150 描述不同，但**不能据此说 #150 不成立**：#150 的复现形态（长时间连接、真实上游、特定间隔）与本档形状服务
（8 段 × 3 s、24 s 内结束）不是同一条件。本档只能记「8 段滴流不误杀」。

> 上一版把「六态无观测」写成结论风险很大 —— 那六张截图当时其实只拍到空会话。现在六态各有一张带真实文案的截图
> `shots/p3-{s0-ok,s1-hold,s2-cut,s3-trickle,s4-unreachable,s5-offline}.png`。

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
export PATH="<android-sdk>/platform-tools:$PATH"
export ANDROID_AVD_HOME=<android-avd> ANDROID_HOME=<android-sdk> ANDROID_SDK_ROOT=<android-sdk>
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
- P3：六态已重跑取得数据；`trickle` 只覆盖「8 段 / 24 s 内结束」这一种形态，长期慢速连接（#150 的复现条件）未测
- P4 的 `session` / `import-confirm` 两屏：未测
