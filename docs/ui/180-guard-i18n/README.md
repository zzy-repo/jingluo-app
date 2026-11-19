# #180 兜底页本地化 + 兼容性诊断变量 · 实测证据

口径说明：本文所有截图与日志都来自 **Android Emulator**（x86_64 系统镜像，GPU `swiftshader_indirect`），
**不是真实手机**。每张图下面的标注就是这个口径。

| 设备 | AVD | WebView 原文行 | 系统 | 期望 | 实测 |
| --- | --- | --- | --- | --- | --- |
| Android Emulator API26（x86_64，非真实手机） | `compat-api26` | `versionName=69.0.3497.100` | Android 8.0.0 | 兜底页出可读文案，不出现原始 JS 异常 | 命中出口 ①，文案可读，诊断变量完整 |
| Android Emulator API29（x86_64，非真实手机） | `compat-api29` | `versionName=74.0.3729.185` | Android 10 | 同上 | 命中出口 ①，文案可读，诊断变量完整 |
| Android Emulator API30（x86_64，非真实手机） | `compat-api30` | `versionName=83.0.4103.106` | Android 11 | 正常启动，不弹兜底卡（回归红线） | `__DEEPSEEK_BOOTED__ === true`，页面里没有 `#compatibility-error` |

原始数据：`api26/result-180.json`、`api29/result-180.json`、`api30/result-180.json`、
`api26/result-zh-26.json`（四个采样点的页内状态都在里面）；冷启动日志**摘录** `api<NN>/logcat-api<NN>.txt`；
截图 `api<NN>/shots/t02s.png`（卡片刚出现时）、`t-final.png`（26 秒后，确认文案不再变化）。

> **logcat 摘录口径（Issue #291 口径，#302 沿用）**：`api<NN>/logcat-api<NN>.txt` 是**摘录** —— 保留原文头 20 KiB
> 加上所有 `SyntaxError` / `JavaScript Error` / `FATAL EXCEPTION` / `AndroidRuntime` / `E Capacitor` / `boot-guard`
> 行，中间省略的行数与原文总字节写在文件里的横幅上（原文 117083 / 316342 / 539949 B）。**数字一律以同目录
> `result-180.json` 为准**（其中 `logcat.bootGuardLines` / `syntaxErrorLines` 就是本单引用的那几行原文）；
> json 里的本机绝对路径已改成仓库相对路径与 `<worktree>` 占位。全文请按 `result-180.json` 的字段重新采集。

## 1. 修复前（佐证，不是本次实测）

`docs/compat/compat-old/api26/README.md` 记录的 11-18 测量里，用户可见文案原文是：

```
页面启动失败。请更新 Android System WebView 或浏览器后重试；仍失败请反馈组件版本与以下信息：Uncaught SyntaxError: Unexpected token ?
```

同一份记录里 `window.__DEEPSEEK_COMPATIBILITY_ERROR__` = `null` —— 出口 ② 只渲染文字、不写诊断变量。

## 2. 修复后 · 出口 ①（缺 API）在 WebView 69 / 74 上先命中

`api26/result-180.json` 的 `verdict`：

```
boxText          : "This page could not start / This page needs a newer Android System WebView (or browser)
                    to open properly. / Missing runtime features: Intl.DisplayNames / Component version:
                    69.0.3497.100 / To update: … / If it still fails after updating, …"
rawExceptionOnScreen : false
booted           : false
compatibilityError  : { branch: "①", code: "missing-api", message: "", missing: ["Intl.DisplayNames"],
                        url: null, line: null, col: null, ua: "Mozilla/5.0 (Linux; Android 8.0.0; … wv) …",
                        webviewVersion: "69.0.3497.100", at: 1795051337093, text: "…" }
```

`api29/result-180.json` 同形状，`webviewVersion: "74.0.3729.185"`、`missing: ["Intl.DisplayNames"]`。

这两台机器的系统语言是 `en-US`，所以卡片出英文（守卫读 `navigator.language`）——这是预期行为。
把应用内语言切成中文（`localStorage['chat-demo:locale'] = 'zh-CN'` 后重载）再测一次，
`api26/shots/zh-CN.png` + `api26/result-zh-26.json`：

```
页面启动失败
这个页面需要更新版本的 Android System WebView（或浏览器）才能正常打开。
缺少的运行环境能力：Intl.DisplayNames
组件版本：69.0.3497.100
更新方法：在应用商店里搜索「Android System WebView」并更新，然后重新打开本应用。
若更新后仍然失败，请反馈上面的组件版本与本页截图。
```

与 `src/i18n/zh.ts` 里 `compatBoot*` 九个键逐行一致（单元测试 `compat-guard-diagnostics.test.mjs` 断言同源）。

> 为什么 69/74 上是 ① 而不是 ②：#155 把 `Intl.DisplayNames`（Chromium 81+）加进了探针表，
> WebView 69/74 一定缺它，而守卫的「先出现的原因先说话」规则让 ① 抢先占位。
> 11-18 那次测量发生在 #155 落地之前，探针全过，所以落到了 ②。
> ② 的用户可见文案因此改由单元测试覆盖（见 `tests/unit/compat-guard-diagnostics.test.mjs` 的
> `runtime-error` 用例），设备侧只能证明「同样的旧内核场景里，屏幕上不再出现原始异常」。

## 3. logcat：诊断链路仍然完整

`api26/logcat-api26.txt:144`（摘录文件里守卫自己打的那一行，含全字段；原文第 505 行）：

```
11-19 01:22:17.120  3792  3792 E Capacitor/Console: File: https://localhost/ - Line 1295 - Msg:
[boot-guard] missing-api {"branch":"①","code":"missing-api","message":"","missing":["Intl.DisplayNames"],
"url":null,"line":null,"col":null,"ua":"Mozilla/5.0 (Linux; Android 8.0.0; …; wv) … Chrome/69.0.3497.100 …",
"webviewVersion":"69.0.3497.100","at":…,"text":"…"}
```

同一次冷启动里主包依旧解析失败（内核过旧，属 #180 之外的老问题），原始文本**只**进日志，不进页面：

```
11-19 01:22:17.371  E Capacitor: JavaScript Error: {"type":"js.error","error":{"message":"Uncaught SyntaxError:
  Unexpected token ?","url":"https://localhost/static/js/main.7a2e9ece.js","line":1,"col":253966, …}}
```

## 4. 回归红线 · WebView 83 正常启动

`api30/result-180.json` 四个采样点（2 / 7 / 13 / 20 秒）全部：

```
booted: true     boxPresent: false     rootChildren: 1     rootHtmlLength: 15042     hasTextarea: true
uiTexts: ["鲸落", "Open sidebar", "How can I help you?", "Chat mode"]
```

`#compatibility-error` 元素根本没被创建（`boxPresent: false`），`__DEEPSEEK_COMPATIBILITY_ERROR__` = `null`，
12 秒看门狗没有提前开火（13 秒采样仍是 `booted: true`、无卡片）。

## 5. 截图

- `api26/shots/t02s.png`、`t-final.png`、`zh-CN.png` —— Android Emulator API26（x86_64，非真实手机）
- `api29/shots/t02s.png`、`t-final.png` —— Android Emulator API29（x86_64，非真实手机）
- `api30/shots/t02s.png`、`t-final.png` —— Android Emulator API30（x86_64，非真实手机）

截图右侧那块黑色矩形是模拟器 `swiftshader_indirect` 渲染卡片的产物，与本改动无关，
本单不把它当缺陷、也不断言它消失（历史上其它单据的截图同样有）。
