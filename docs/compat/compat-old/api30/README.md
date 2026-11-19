# API 30（Android 10 / WebView 83）兼容实测

- 设备：Android Emulator API 30（x86_64，非真实手机），AVD `compat-api30`，`hw.ramSize = 1536M`，4 核
- 屏幕：`wm size 1080x1920`，P4 通过 `wm density` 切 443（390css）/ 480（360css），默认 420（412css）
- WebView（原始 `dumpsys` 行）：

```
versionName=83.0.4103.106
```

- App：debug APK `1.4.0-beta.10`（versionCode 17，`minSdk 24 targetSdk 36`），包名 `com.example.deepseekchat`
- 本次全部通过 adb 真输入点击（`input tap` / `input text`），未用 Playwright；页面级断言走 WebView 的 CDP

## P2 · 导入（链接导入 → 归档解析）

做法：本机起 Range 服务（`10.0.2.2:5411`），App 逐段 206 下载归档后自己解析；每档前 `am force-stop` + `logcat -c` + 冷启动，
每 ~1.5s 采样一次界面文案与 `dumpsys meminfo` 的 TOTAL PSS，直到出现终态文案或超时。

| 档位 | 服务端实际送出 | 终态 | 进程 | PSS 峰值 |
| --- | --- | --- | --- | --- |
| `ctrl-1mb` | 1,048,576 B / 8 段 | 导入成功（Imported 1 chat） | 全程同一 pid | 116 MB |
| `ctrl-10mb` | 10,485,760 B / 11 段 | 导入成功 | 同一 pid | 141 MB |
| `ctrl-50mb` | 52,428,764 B / 63 段 | 导入成功（用时 ~84s） | 同一 pid | **486 MB** |
| `edge-200mb` | 209,715,200 B / 110 段 | **失败**：`Import from link failed: The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.` | 同一 pid | 364 MB |
| `bomb-1000x` | 66,112 B（解压后 64 MB 全同一字符） | 导入成功 | 同一 pid | **482 MB** |
| `corrupt-branch` | 2,164 B | 导入 2 条、跳过 2 条损坏项，逐条给出会话名与消息号（#49 降级路径正常） | 同一 pid | 316 MB |
| `truncated` | 2,306,867 B | 错误弹层：`This ZIP is damaged: its file directory cannot be read…` | 同一 pid | 150 MB |

### 结论（本机、本档）

- **7 档全部没有白屏，也没有一次进程被杀**：每档采样到的 pid 恒定，`logcat` 里没有对应包名的 `Killing …(adj …)` 记录，
  大档结束回到主界面（`bodyTextLength` ≈ 1011–1376，DOM 有正文）。「导入白屏 / OOM」这条假设在 API 30 + WebView 83 上**没有复现**。
- 内存确实随归档体积线性上涨：1 MB → 116 MB、10 MB → 141 MB、50 MB → 486 MB；64 MB 全同字符的炸弹包（解压后 64 MB）→ 482 MB，
  与 50 MB 真实包同一量级，说明峰值由「解压后的字符串」决定，不是压缩比。
  在本 AVD 的 1536 MB RAM 下仍未触发 `lowmemorykiller`，但 486 MB PSS 已接近单进程可用堆上限，是真实的边界值。
- 半截包与坏分支都走产品自己的错误/降级路径（可定位到条目序号、会话名、消息号），不是白屏。

### 本轮新增的两条实测问题（详见 `docs/compat` 汇总）

1. **P2-1｜200MB（产品自述上限）导入失败，且把 WebView 原始异常文案直接抛给用户**
   证据：`result-p2-edge-200mb.json`（`requestBytes = 209715200`，`verdict = TERMINAL_TEXT:Import from link failed`），
   `shots/p2-edge-200mb-end.png`。下载阶段 110 段全部成功、字节数完全等于 200MB，失败发生在「读文件」阶段；
   文案是 `File`/`FileReader` 的 DOMException 原文，不是 `historyImportUrl*` 里的任何一条本地化文案。
   影响：用户看到的是技术异常而非「超出上限 / 下载完成但读取失败，请重试」，且 200MB 下载白费。
2. **P4-1｜390css / 360css 下设置页数据分区最后一个分组标题「Chat backup」竖排成一列单字**
   证据：`shots/p4-390css-settings-data.png`、`shots/p4-360css-settings-data.png`（`.tmp-probe/cold.png` 在 412css 同样出现）。
   同一屏的 `Channel` / `API Key` / `Connection test` 都正常横排，只有该行塌成单字一列，右侧操作列同时被挤空。
   横向溢出检测为 0（`scrollWidth == innerWidth`），所以这是「列宽被压到一两个字宽」的塌陷，不是横向溢出。

## P4 · 排版抽查（390 / 360 CSS px）

- 390css（`wm density 443`）：`innerWidth = 391`、`scrollWidth = 391`、越界元素 0；主界面 / 设置-General / 设置-Data / 链接导入表单四屏均无横向溢出。
- 360css（`wm density 480`）：`innerWidth = 360`、`scrollWidth = 360`、越界元素 0；同上四屏无横向溢出。
- 未测边界：会话详情页（侧栏会话条目选择器 `[data-session-id], [class*="sessionItem"]` 在导入后仍未命中，本档标未测，不拿主界面冒充）；
  导入确认弹层（`result-p4.json` 里 `importStart` 点不到，因为链接输入框为空时按钮是 `disabled`，属预期，P2 已用真实链接覆盖该弹层）。

## 复跑方式

```bash
export PATH="<android-sdk>/platform-tools:$PATH"
node scripts/compat/boot.mjs --avd compat-api30          # 装 APK + 打印 WebView 原始行
bash scripts/compat/run-p2.sh 30                          # 7 档串行，每档落 result-p2-<档>.json + logcat
node scripts/compat/p4-layout.mjs --api 30                # 390 / 360 排版
```
