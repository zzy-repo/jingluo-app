# 类别 3 盘点：平台与宿主能力假设（#209）

> 本文件是 **#209「能力探测替代一切假设」** 的类别 3（平台 / 宿主）盘点结果，范围是全仓 `src/**`，扫描器为 `scripts/lib/hostCapabilityAudit.mjs`。
>
> **快照基准：`77720a32`**（`origin/main` tip，2026-11-25 21:57:52 +0800）· 采集时间：2026-11-25 23:54 (+0800)
>
> **扫描范围**：`src/**` 的 **351** 个源文件。
>
> 拆分：`.ts` **265** / `.tsx` 85 / `.html` 1 = 351（#487 W1-A 新增 `src/services/consume/**` 9 个 `.ts`，W1-B 新增 `src/services/auth/**` 5 个 `.ts` 与 `src/components/auth/**` 3 个 `.tsx`，W1-C2 新增 `src/components/consume/**` 的 7 个面板文件，W1-C1 再新增 3 个 `.tsx`，「统一计量」再新增 `src/utils/money.ts` 1 个 `.ts`，「迁移尾巴」再新增 `src/legacy/migration/**` 4 个 `.ts` 与 1 个 `.tsx`，W1-B 后半再新增 `src/services/consumeClient.ts` 与 `src/components/auth/AccountRow.tsx`）。上一版写 190，是缺了 `#237`（`fetch` 通道计数、`readBytesOf`）与 `#243`（设备指纹）新增的 5 个文件。
>
> **本盘点只审计、只出单、只做工具，不修任何代码。** 每条真实漏洞都另开独立 Issue（见「真实漏洞与拆单」），修复在各自单里做，不在 #209 的 PR 里改产品代码。
>
> 全表由扫描器现算生成，没有手写第二份口径；**写盘由 `node scripts/gen-capabilities-docs.mjs` 直接完成**（`pnpm gen:capabilities`，`pnpm check:capabilities-docs` 只比对不写）——数字与 `文件:行` 别手改，改完代码重跑脚本即可。判定规则见下一节，改口径必须同时改 `scripts/lib/hostCapabilityAudit.mjs` 与 `tests/unit/host-capability-audit.test.mjs`。

## 判定口径

兼容性下限是 **Android 11 原厂 WebView：Chromium 83.0.4103.106**（`rspack target=chrome83`，`browserslist: chrome >= 83`）。所以「这个能力支持不支持」只有一个合法问法：

**这一行代码在 Chrome 83 上会不会挂？**

| 结论 | 含义 |
| --- | --- |
| `已有兜底` | 调用点自己探测过（`typeof` / `?.` / `try…catch` / `isPluginAvailable`），或者 `src/index.html` 的启动守卫已把它列进 `REQUIRED`（探不到就画兼容性提示页、不启动应用） |
| `无风险` | 裸调用，但该 API 的引入版本号 ≤ 83，内核必然有，不需要探测 |
| `真实漏洞` | 裸调用，而该 API 在 WebView 83 / 原生宿主上**可能不存在或语义不同** |
| `需动态验证` | API 在，但行为（回调是否触发、采样率是否被采纳、插件是否已注册）静态看不出来，只能上真机 |

「处置」列的四个取值与结论的映射（唯一一份，在扫描器的 `DISPOSITIONS` 里）：

- `已有兜底` ← `已有兜底` / `无风险`（平台或启动守卫本身就是兜底，不需要再写代码）
- `需探测` ← `真实漏洞`（默认当作不存在，必须显式探测或改写法）
- `需动态验证` ← `需动态验证`
- `拆单` ← 已拆出独立 Issue 的真实漏洞（括号里是单号）

探测识别窗口：命中行的**前 15 行到后 4 行**。`typeof X` 里的 `X` 与能力名互为前后缀即算同一目标（`typeof navigator` 能覆盖 `navigator.onLine`）；块注释里的文字不算调用点。

## 盘点表

**总计 161 条命中**（`已有兜底` 85 / `无风险` 59 / `真实漏洞` 5 / `需动态验证` 12）；风险分布：高 4、中 13、低 144。

| 文件:行 | 假设内容 | 类别 | 风险(高/中/低) | 处置(已有兜底/需探测/需动态验证/拆单) |
| --- | --- | --- | --- | --- |
| `src/app/theme.ts:6` | matchMedia 引入于 Chrome 9，83 必有 | 3 | 低 | 已有兜底 |
| `src/app/viewport.ts:4` | matchMedia 引入于 Chrome 9，83 必有 | 3 | 低 | 已有兜底 |
| `src/app/viewport.ts:144` | visualViewport 引入于 Chrome 61，83 必有；键盘弹出后的行为仍需真机确认 | 3 | 低 | 已有兜底 |
| `src/components/attachments/useAttachmentDrafts.ts:229` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/base/Modal.tsx:70` | visualViewport 引入于 Chrome 61，83 必有；键盘弹出后的行为仍需真机确认 | 3 | 低 | 已有兜底 |
| `src/components/base/anchored.ts:188` | ResizeObserver 引入于 Chrome 64，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/chatInput/ChatInput.tsx:200` | ResizeObserver 引入于 Chrome 64，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/chatInput/Spectrum.tsx:34` | ResizeObserver 引入于 Chrome 64，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/chatInput/useVoiceInput.ts:75` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/consume/walletAutoRedeem.ts:239` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/components/consume/walletAutoRedeem.ts:264` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/components/consume/walletAutoRedeem.ts:276` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/components/messages/MessageFile.tsx:22` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/messages/MessageFile.tsx:29` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/messages/MessageList.tsx:369` | ResizeObserver 引入于 Chrome 64，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/messages/MessageList.tsx:409` | ResizeObserver 引入于 Chrome 64，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/messages/MessageList.tsx:504` | CSS.escape 引入于 Chrome 46，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/messages/ReadingBars.tsx:104` | matchMedia 引入于 Chrome 9，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/messages/ReadingBars.tsx:106` | matchMedia 引入于 Chrome 9，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/session/ChatBackgroundPage.tsx:76` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/session/ChatBackgroundPage.tsx:109` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/session/ChatBackgroundPage.tsx:111` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/components/settings/AppUpdateField.tsx:111` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测（#412 手动下载入口用 `registerPlugin('Browser')`，失败走 `catch` 给可读提示） | 3 | 中 | 需动态验证 |
| `src/components/settings/AppUpdateField.tsx:252` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/settings/AppUpdateField.tsx:400` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/settings/FeedbackDialog.tsx:242` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/components/settings/SettingsDialog.tsx:1408` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/components/settings/SettingsDialog.tsx:1440` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/index.html:120` | Intl.DisplayNames 引入于 Chrome 81，勉强在 83 之内，但语言数据（ICU）齐不齐要实测 | 3 | 中 | 需动态验证 |
| `src/index.html:236` | CSS.escape 引入于 Chrome 46，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/index.html:278` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/index.html:378` | `deviceCode()` 读设备码的 `localStorage` 读取同样包在 try 里（#104 自助信息） | 3 | 低 | 已有兜底 |
| `src/index.html:488` | `navigator.clipboard` 非安全上下文下整体为 undefined，复制第 ① 层先探测再回退 execCommand（#104） | 3 | 低 | 已有兜底 |
| `src/legacy/migration/collect.ts:37` | 读老账号本地额度槽位（`localStorage`）：读取包在 try 里，读不到就当「没有历史额度」直接跳过（#498） | 3 | 低 | 已有兜底 |
| `src/legacy/migration/deviceFpSlot.ts:51` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/announcements/remote.ts:70` | @capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web" | 3 | 低 | 已有兜底 |
| `src/services/announcements/remote.ts:211` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/announcements/remote.ts:231` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/api/apiConfig.ts:101` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/api/apiConfig.ts:110` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/api/apiConfig.ts:112` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/api/client.ts:353` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/api/client.ts:800` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/api/client.ts:811` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/api/client.ts:831` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/api/embedding.ts:194` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/api/errorBody.ts:30` | ReadableStream.getReader 引入于 Chrome 43，83 必有；真正要防的是 body 为 null | 3 | 低 | 已有兜底 |
| `src/services/api/protocolDetect.ts:189` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/api/speech.ts:30` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/api/speech.ts:65` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/api/sse.ts:165` | ReadableStream.getReader 引入于 Chrome 43，83 必有；真正要防的是 body 为 null | 3 | 低 | 已有兜底 |
| `src/services/appUpdate.ts:42` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测 | 3 | 中 | 需动态验证 |
| `src/services/appUpdate.ts:43` | @capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web" | 3 | 低 | 已有兜底 |
| `src/services/attachments.ts:255` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:279` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:286` | FileReader 引入于 Chrome 6，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:304` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:307` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:311` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:387` | toBlob 的回调在部分 WebView 上会拿到 null 甚至不触发，静态判不出 | 3 | 中 | 需动态验证 |
| `src/services/attachments/imageSource.ts:399` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/attachments/imageSource.ts:545` | toBlob 的回调在部分 WebView 上会拿到 null 甚至不触发，静态判不出 | 3 | 中 | 需动态验证 |
| `src/services/auth/store.ts:134` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/auth/store.ts:143` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/auth/store.ts:145` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/chat/appAssets.ts:27` | createImageBitmap 引入于 Chrome 50，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/appAssets.ts:29` | createImageBitmap 引入于 Chrome 50，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/appAssets.ts:35` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/appAssets.ts:48` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/appAssets.ts:51` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/appAssets.ts:73` | toBlob 的回调在部分 WebView 上会拿到 null 甚至不触发，静态判不出 | 3 | 中 | 需动态验证 |
| `src/services/chat/autoTitle.ts:295` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/autoTitle.ts:307` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/chat/background.ts:26` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/background.ts:30` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/background.ts:80` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/background.ts:84` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/db.ts:265` | 配额溢出只能靠捕获 QuotaExceededError 区分「满了」和「不可用」 | 3 | 低 | 已有兜底 |
| `src/services/chat/drafts.ts:229` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/drafts.ts:300` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/deepseekShare.ts:296` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/deepseekShare.ts:312` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/importArchive.ts:63` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/importArchive.ts:221` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/importFailure.ts:147` | navigator.onLine 是「有没有网卡」不是「能不能连上」，只能当弱信号用 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/urlImport.ts:217` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/urlImport.ts:1298` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/zipWriter.ts:142` | blob.stream() 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/chat/history/zipWriter.ts:142` | ReadableStream.getReader 引入于 Chrome 43，83 必有；真正要防的是 body 为 null | 3 | 低 | 已有兜底 |
| `src/services/chat/store.ts:2220` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/chat/store.ts:2333` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/consume/http.ts:244` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/consume/http.ts:258` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/consume/http.ts:274` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/consume/http.ts:284` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/capabilityTruth.ts:73` | visualViewport 引入于 Chrome 61，83 必有；键盘弹出后的行为仍需真机确认 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/capabilityTruth.ts:77` | navigator.clipboard 非安全上下文下整体为 undefined（局域网 http 打开就不是安全上下文） | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/capabilityTruth.ts:80` | Intl.DisplayNames 引入于 Chrome 81，勉强在 83 之内，但语言数据（ICU）齐不齐要实测 | 3 | 中 | 需动态验证 |
| `src/services/diagnostics/collector.ts:374` | @capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web" | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:411` | navigator.onLine 是「有没有网卡」不是「能不能连上」，只能当弱信号用 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:412` | navigator.onLine 是「有没有网卡」不是「能不能连上」，只能当弱信号用 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:504` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:564` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:570` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:996` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:996` | fetch 响应体 clone | 3 | 中 | 需探测 |
| `src/services/diagnostics/collector.ts:1065` | 依赖 fetch 是本尊：页面把 window.fetch 换成包装后，任何「原生 fetch」假设（bind、clone、body 流）都不再成立 | 3 | 高 | 需探测 |
| `src/services/diagnostics/collector.ts:1067` | 依赖 fetch 是本尊：页面把 window.fetch 换成包装后，任何「原生 fetch」假设（bind、clone、body 流）都不再成立 | 3 | 高 | 需探测 |
| `src/services/diagnostics/collector.ts:1214` | 依赖 fetch 是本尊：页面把 window.fetch 换成包装后，任何「原生 fetch」假设（bind、clone、body 流）都不再成立 | 3 | 高 | 需探测 |
| `src/services/diagnostics/collector.ts:1547` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:1557` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/collector.ts:1577` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测 | 3 | 中 | 需动态验证 |
| `src/services/diagnostics/transport.http.ts:60` | toDataURL 引入于 Chrome 2，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.http.ts:66` | FileReader 引入于 Chrome 6，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.http.ts:283` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.http.ts:287` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.http.ts:296` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.legacy.ts:410` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.legacy.ts:420` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/diagnostics/transport.legacy.ts:429` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:19` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测 | 3 | 中 | 需动态验证 |
| `src/services/exportText.ts:61` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:113` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:121` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:128` | URL.createObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:140` | URL.revokeObjectURL 引入于 Chrome 8，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:151` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/exportText.ts:162` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/externalImport.ts:113` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测 | 3 | 中 | 需动态验证 |
| `src/services/externalImport.ts:116` | @capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web" | 3 | 低 | 已有兜底 |
| `src/services/externalImport.ts:178` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/externalImport.ts:298` | @capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web" | 3 | 低 | 已有兜底 |
| `src/services/invite/device.ts:90` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/invite/device.ts:97` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/invite/device.ts:176` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/invite/device.ts:183` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/invite/fingerprint.ts:228` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/invite/fingerprint.ts:228` | @capacitor/core 随包发布，函数一定在；native-bridge 没注入时会退化成 "web" | 3 | 低 | 已有兜底 |
| `src/services/invite/fingerprint.ts:232` | registerPlugin 一定返回代理对象，但原生侧没注册时调用只会 reject；插件在不在要探测 | 3 | 中 | 需动态验证 |
| `src/services/location.ts:44` | Intl.DisplayNames 引入于 Chrome 81，勉强在 83 之内，但语言数据（ICU）齐不齐要实测 | 3 | 低 | 已有兜底 |
| `src/services/location.ts:48` | Intl.DisplayNames 引入于 Chrome 81，勉强在 83 之内，但语言数据（ICU）齐不齐要实测 | 3 | 低 | 已有兜底 |
| `src/services/ours/transport.ts:28` | @capacitor/core 随包发布，函数一定在；它回答的是「跑在壳里吗」不是「插件在吗」 | 3 | 低 | 已有兜底 |
| `src/services/ours/transport.ts:65` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/ours/transport.ts:77` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/services/settings.ts:119` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/settings.ts:128` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/settings.ts:130` | localStorage 在无痕 / 配额满 / 分区存储受限时抛错，写入必须自带 try…catch | 3 | 低 | 已有兜底 |
| `src/services/speech/readAloud.ts:91` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/speech/readAloud.ts:92` | AudioContext 的 sampleRate 选项与自动播放策略在不同宿主机型上表现不一致 | 3 | 中 | 需动态验证 |
| `src/services/speech/readAloud.ts:106` | ReadableStream.getReader 引入于 Chrome 43，83 必有；真正要防的是 body 为 null | 3 | 低 | 已有兜底 |
| `src/services/speech/recorder.ts:56` | AudioContext 的 sampleRate 选项与自动播放策略在不同宿主机型上表现不一致 | 3 | 低 | 已有兜底 |
| `src/services/updateGate.ts:326` | AbortController 引入于 Chrome 66，83 必有（启动守卫也把它列进 REQUIRED） | 3 | 低 | 已有兜底 |
| `src/services/updateManifest.ts:395` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/utils/capabilities.ts:218` | isPluginAvailable 是判断「原生侧到底注册没注册这个插件」的唯一手段 | 3 | 低 | 已有兜底 |
| `src/utils/capabilities.ts:223` | isPluginAvailable 是判断「原生侧到底注册没注册这个插件」的唯一手段 | 3 | 低 | 已有兜底 |
| `src/utils/capabilities.ts:256` | 依赖 fetch 是本尊：页面把 window.fetch 换成包装后，任何「原生 fetch」假设（bind、clone、body 流）都不再成立 | 3 | 高 | 需探测 |
| `src/utils/clipboard.ts:7` | navigator.clipboard 非安全上下文下整体为 undefined（局域网 http 打开就不是安全上下文） | 3 | 低 | 已有兜底 |
| `src/utils/clipboard.ts:8` | navigator.clipboard 非安全上下文下整体为 undefined（局域网 http 打开就不是安全上下文） | 3 | 低 | 已有兜底 |
| `src/utils/readBlob.ts:4` | Body.text/arrayBuffer 引入于 Chrome 76，83 必有 | 3 | 低 | 已有兜底 |
| `src/utils/readBlob.ts:7` | FileReader 引入于 Chrome 6，83 必有 | 3 | 低 | 已有兜底 |
| `src/utils/usePresence.ts:19` | matchMedia 引入于 Chrome 9，83 必有 | 3 | 低 | 已有兜底 |

## 高危结论：依赖 fetch 是本尊

本类别唯一一条「引信已装好、还没扣扳机」的高危假设。

**页面上换掉 `window.fetch` 的代码在 `src/services/diagnostics/collector.ts`。** 下面每处都用**两把锚**：先写函数名 / 唯一片段（给人看，行号漂了也找得到），再写 `路径:行 ⇒ 片段`（给门禁咬）。**不再写 `:1234` 这种没文件名的裸行号** —— 它不构成引用 token，`check:doc-refs` 结构性看不见（见 `docs/gates/audit-debt.md`「门禁看不见的写法」），行号漂到空行上也没人知道。

- `let inNativeHttp` —— 注释写的是「CapacitorHttp 内部会走 fetch：用它做重入标记」，即采集层自己知道 fetch 可能不是原生的：`src/services/diagnostics/collector.ts:916 ⇒ let inNativeHttp = 0`；
- `readBytesOf()`（定义 `src/services/diagnostics/collector.ts:987 ⇒ export const readBytesOf = async (response: Response): Promise<number> => {`）—— 体积读取三档：`Content-Length` 声明值 → 流式响应（`text/event-stream`）主动放弃、报 `BYTES_UNMEASURABLE` → 其余才 `response.clone().text()` 实测（见 #211，已修；「没有这个头」不再被当成 0 字节，是 `parseContentLength()` 的事：`src/services/diagnostics/collector.ts:965 ⇒ const parseContentLength = (raw: string | null): number | null => {`）；
- `installFetchHook()` 里的**两句**，今天已不相邻 —— 别再拿「/」并列写成一处（旧写法就是这么失效的）：先只判 fetch 在不在 `src/services/diagnostics/collector.ts:1114 ⇒ if (typeof window === 'undefined' || typeof window.fetch !== 'function') {`；再 `src/services/diagnostics/collector.ts:1128 ⇒ const original = window.fetch.bind(window)` —— 把当时那个函数当作「原生 fetch」；
- `installFetchHook()` 里真正 await 体积的那一行（不是 `bytes:` 字段了，写法已改成先落变量）—— 在把 `response` 交还调用方**之前** await；正因为这一行，`readBytesOf` 里任何会等到流关闭的读法都会卡住 SSE（见 #211）：`src/services/diagnostics/collector.ts:1161 ⇒ const responseBytes = await readBytesOf(response)`；
- 页面级替换：`src/services/diagnostics/collector.ts:1214 ⇒ window.fetch = patched as unknown as typeof window.fetch`；
- `installCapacitorHttpHook()` —— 另外再包一层 `CapacitorHttp.get/post/…`：`src/services/diagnostics/collector.ts:1276 ⇒ const installCapacitorHttpHook = (): void => {`；
- `installHooks()` —— 由 `initCollector()` 在启动时调用，只有显式传 `installHooks: false` 才不装 → 生产包里这层包装**一直是活的**：定义 `src/services/diagnostics/collector.ts:1505 ⇒ const installHooks = (): void => {`，开关 `src/services/diagnostics/collector.ts:1629 ⇒ if (options.installHooks !== false) {`，入口链路 `src/main.tsx:76 ⇒ void initDiagnostics({ facts: readDiagnosticsFacts })` → `initDiagnostics()` → `initCollector()`。

**Capacitor 侧会在什么条件下再换一次：** Capacitor Android 运行时的 `native-bridge`（**不是本仓文件**，在 @capacitor/android 里）先存 `win.CapacitorWebFetch = window.fetch`，再 `window.fetch = async (…) => …`，整段由 `doPatchHttp` 控制；Android 上 `doPatchHttp` 要求 `CapacitorHttp.isEnabled()`，而它读的是 `plugins.CapacitorHttp.enabled`（默认 `false`）。**本仓 `capacitor.config.ts` 没有这个条目，所以今天 fetch 还是原生的。** 风险不在「现在就挂」，而在于：

1. 只要有人为了让 `/buy` 之类的请求绕开 CORS 而打开 `plugins.CapacitorHttp.enabled`，`original` 就变成 `CapacitorWebFetch`，采集层记录的 `net_request` / `net_response` 语义立刻变味，而代码里没有任何一处探测这件事（见 #210）；
2. `inNativeHttp` 重入标记**挡不住**这条路径：原生替换走 `cap.nativePromise`，不经过 JS 侧 `CapacitorHttp` 代理对象，计数器不会加 → 同一条请求双份记录或标错通道；
3. 把 `response.body` 当流用的地方拿到的不再是真流：`src/services/api/client.ts:398-460`、`src/services/api/speech.ts:64-67`、`src/services/api/sse.ts:126-170`、`src/services/speech/readAloud.ts:106`、`src/services/chat/history/zipWriter.ts:86` → SSE 退化成一次性到达；
4. 任何「fetch 恒等 / bind 之后仍是原生」的假设失效，例如 `src/services/updateManifest.ts` 里 `request: typeof fetch = fetch` 这个默认参数。

## 真实漏洞与拆单

本轮复算命中 **5 处 `真实漏洞`**，全部属于同一个家族（「fetch 是本尊」），拆了两单：

| 结论 | 位置 | 风险 | Issue |
| --- | --- | --- | --- |
| 页面级替换 `window.fetch`，并默认它是原生的 | `src/services/diagnostics/collector.ts:1117 ⇒ const channel = detectFetchChannel(window.fetch)`（同族两个通道判定常量：`src/services/diagnostics/collector.ts:1067 ⇒ const BRIDGE_SOURCE_HINT`、`src/services/diagnostics/collector.ts:1063 ⇒ const ENGINE_NATIVE_HINT`；通道识别正则 `src/utils/capabilities.ts:256`） | 高 | #210 |
| `readBytesOf()` 的 `response.clone().text()` 兜底：`bytes` 读不到时**今天**报「不可测」（`BYTES_UNMEASURABLE` = -1），不再拿 0 顶替「量不出来」；流式响应在碰 body 之前就放弃（#211 之前它会等到流关闭、把 SSE 卡住） | `src/services/diagnostics/collector.ts:996 ⇒ const text = await response.clone().text()`（调用点 `src/services/diagnostics/collector.ts:1161`；哨兵值 `src/services/diagnostics/collector.ts:944 ⇒ export const BYTES_UNMEASURABLE = -1`） | 中 | #211（已修） |

两条都按类别 3 的规矩拆成独立 Issue 修复；#209 的 PR 只带扫描器、本文件与单测。

> **为什么 `#211` 修完了扫描器还记 4 处「真实漏洞」**：静态规则只判「这个调用点自己有没有探测」，不判「行为有没有被修好」。
> `#211` 改的是「流式响应不再读副本」，`readBytesOf` 里那行裸 `response.clone()` 仍在，规则照记；`window.fetch = patched` 同理。
> **规则不删**：删了就等于宣布「以后谁再写一遍也不会被抓」，这正是这份文档要防的事。

## 需动态验证（静态判不出来，必须上真机）

- `Intl.DisplayNames`（2 处：`src/index.html:120`、`src/services/diagnostics/capabilityTruth.ts:80`）：Chrome 81 才有，落在 83 之内，但语言数据（ICU）齐不齐要看具体机型；`src/index.html` 启动守卫已把它列进 `REQUIRED`，探不到会画提示页。
  **口径留痕**：`src/index.html:120` 那一行是**注释**（注释里写着「不检查 Intl.DisplayNames」），扫描器只做字面量匹配，注释行也算命中——为保住「0 命中就是真的 0 命中」，这条不一致不改规则，在这里写明。
- `Capacitor.registerPlugin`（6 处：`src/services/appUpdate.ts:42`、`src/services/diagnostics/collector.ts:504`、`src/services/diagnostics/collector.ts:1577 ⇒ Capacitor.registerPlugin`、`src/services/exportText.ts:19`、`src/services/invite/fingerprint.ts:232`、`src/components/settings/AppUpdateField.tsx:111` 的 `registerPlugin('Browser')`）：`registerPlugin` 永远返回代理对象，插件没注册时只会在调用时 reject。`isPluginAvailable` 全仓只有 2 处（`src/utils/capabilities.ts:218` / `:223` 的 `hasPlugin()`，`#212` 的统一探测口），也就是说**没有一处**把 `registerPlugin` 的注册结果做成正面探测——`hasPlugin()` 回答的是「这个插件能不能用」，不是「刚才那次注册成功了没有」。已人工核对：`android/app/src/main/java/com/example/deepseekchat/MainActivity.java:49-52` 注册了 4 个插件，Java 侧 `@PluginMethod` 名字与 JS 调用一一对应，**没有名字对不上的情况**；所有调用点也都有 `try…catch` 降级。但「插件注册失败 / 被裁剪 / 旧版本 APK 没有这个插件」这条路径仍无正面探测。本轮 #243 新增的 `DeviceFingerprint`（`invite/fingerprint.ts` 的 `registerPlugin`）也计入这几处；`CheckoutBrowser`（原 `ours/transport.ts:37`，`/buy` 收银台的原生桥）已随 #331 的旧支付链路停用一起删除，那条 `需动态验证` 命中不再存在。
- `canvas.toBlob`（1 处：`src/services/chat/appAssets.ts:60`）：回调可能拿到 `null`，个别 WebView 上不触发。
- `new AudioContext({ sampleRate })`（1 处：`src/services/speech/readAloud.ts:92`）：采样率选项与自动播放策略在真机上表现不一致。
- `visualViewport`：API 在（Chrome 61），键盘弹出后的 `resize` / `scroll` 时序与去抖仍需真机确认（这一条是人工补记，扫描器的结论本来就在 `已有兜底` 里）。

**未测边界（不许当成已通过）**：以上 9 条**一条都没有**在真机或模拟器上跑过。本次盘点是静态扫描 + 代码阅读，结论只覆盖「代码里有没有探测」这一层。

## 0 命中清单：未使用 → 无假设

以下能力在全仓 `src/**` 里 **0 命中**，当前不存在相关假设（是「没用」，不是「支持」）：

| 能力 | 为什么 0 命中 / 备注 |
| --- | --- |
| `navigator.share` / `canShare`（Web Share） | 未使用，分享走系统剪贴板 |
| `Notification` | 未使用（推送走原生插件） |
| `AbortSignal.timeout` / `AbortSignal.any` | 未使用，超时自己 `setTimeout` + `abort()` |
| `TransformStream` | 未使用 |
| `CompressionStream` | 未使用 |
| `requestIdleCallback` | 未使用 |
| `IntersectionObserver` / `MutationObserver` | 未使用，可见性靠 `ResizeObserver` + 滚动事件 |
| `XMLHttpRequest` / `sendBeacon` | 未使用，全部走 `fetch` |
| `Service Worker` | 未使用 |

**本轮复算推翻了上一版的一条结论**：上一版把 `Capacitor.isPluginAvailable` 记进这张 0 命中清单，写「插件存在性没有任何正面探测」。复算现在有 **2 处命中**（`src/utils/capabilities.ts:218` 的 `typeof capacitor.isPluginAvailable !== 'function'` 记为 `无风险`、`:223` 的调用点记为 `已有兜底`）——`#212` 统一探测口时补上的。所以它从 0 命中清单里挪走了，见「各能力命中数」表。

**本轮复算还把 `QuotaExceededError` 挪出了这张清单**：`src/services/chat/db.ts:265` 的 `classifyStorageFailure` 用 `case 'QuotaExceededError':`（连同 Firefox 的 `NS_ERROR_DOM_QUOTA_REACHED`，`:266`）把写失败分成 `quota` / `clone` / `unavailable` / `unknown` 四档 —— 配额满与存储不可用从此是两条不同的用户文案与处置（配额档会先清孤儿 blob 再重写，见 `reclaimQuotaSpace`）。上一版写的「没有一处区分『配额满了』和『存储不可用』」随存储链路改造失效，本表跟着改。`QuotaExceededError` 是**异常名**而不是 API（Chrome 83 一样会抛），所以扫描器记 `无风险`，见「各能力命中数」表。

## 各能力命中数

| 能力 | 命中 | 已有兜底 | 无风险 | 真实漏洞 | 需动态验证 |
| --- | --- | --- | --- | --- | --- |
| `localStorage` | 24 | 22 | 2 | 0 | 0 |
| `AbortController` | 20 | 20 | 0 | 0 | 0 |
| `Body.text/arrayBuffer` | 19 | 10 | 9 | 0 | 0 |
| `Capacitor.isNativePlatform` | 15 | 2 | 13 | 0 | 0 |
| `URL.revokeObjectURL` | 11 | 2 | 9 | 0 | 0 |
| `URL.createObjectURL` | 9 | 3 | 6 | 0 | 0 |
| `Capacitor.registerPlugin` | 7 | 1 | 0 | 0 | 6 |
| `Capacitor.getPlatform` | 6 | 2 | 4 | 0 | 0 |
| `ResizeObserver` | 5 | 5 | 0 | 0 | 0 |
| `matchMedia` | 5 | 1 | 4 | 0 | 0 |
| `Intl.DisplayNames` | 4 | 2 | 0 | 0 | 2 |
| `ReadableStream.getReader` | 4 | 2 | 2 | 0 | 0 |
| `fetch 页面级拦截` | 4 | 0 | 0 | 4 | 0 |
| `navigator.clipboard` | 4 | 3 | 1 | 0 | 0 |
| `FileReader` | 3 | 0 | 3 | 0 | 0 |
| `canvas.toBlob` | 3 | 0 | 0 | 0 | 3 |
| `navigator.onLine` | 3 | 3 | 0 | 0 | 0 |
| `visualViewport` | 3 | 1 | 2 | 0 | 0 |
| `AudioContext` | 2 | 1 | 0 | 0 | 1 |
| `CSS.escape` | 2 | 2 | 0 | 0 | 0 |
| `Capacitor.isPluginAvailable` | 2 | 1 | 1 | 0 | 0 |
| `createImageBitmap` | 2 | 2 | 0 | 0 | 0 |
| `Blob.prototype.stream` | 1 | 0 | 1 | 0 | 0 |
| `QuotaExceededError` | 1 | 0 | 1 | 0 | 0 |
| `canvas.toDataURL` | 1 | 0 | 1 | 0 | 0 |
| `fetch 响应体 clone` | 1 | 0 | 0 | 1 | 0 |

**总计 161 条命中**（`已有兜底` 85 / `无风险` 59 / `真实漏洞` 5 / `需动态验证` 12）；风险分布：高 4、中 13、低 144。

## 未覆盖的边界

1. **Android 原生侧只读核对，没进扫描器**：`android/app/src/main/java/**` 是 Java，扫描器只读 `.ts/.tsx/.html`。插件注册与方法名已人工核对（见「需动态验证」），未做任何修改。
2. **`src/polyfills/legacy.ts` 的 11 个 polyfill 不在本表**：那是类别 1（JS 语言能力），有独立门禁 `pnpm run check:legacy`。
3. **CSS 能力（flex gap 等）不在本表**：类别 2，有独立门禁 `pnpm run check:gap`。
4. **安全上下文没实测**：`navigator.clipboard` 只在 `http://localhost` / https 下存在，局域网 http 打开时整段为 `undefined`；代码里有 `?.` + `execCommand` 兜底，但 `execCommand` 这条路径没在真机上验过。
5. **存储配额没实测**：`QuotaExceededError` 现在有 1 处命中（`src/services/chat/db.ts:265` 的写失败分级），但「配额真的满了会怎样」没有任何真机 / 模拟器证据；`navigator.storage.estimate()`（`db.ts` 的 `estimateStorage`）在 WebView 上报的真实配额与 `usage` 也没实测。
7. **注释行也算命中**：`src/index.html:17` 是注释里的 `Intl.DisplayNames` 字样，扫描器按字面量匹配，注释行照记（见「需动态验证」）。
6. **没有跑任何设备 / 模拟器**：所有「必然存在」结论都是按 Chromium 版本号推的（`chrome ≤ 83`），不是实测。

## 复核记录
- 复核（2026-11-25，基准 `77720a32`，单元 `gate/last2`）：**整表由生成器重写**（`node scripts/gen-capabilities-docs.mjs`）：扫描范围 337 → **342** 个 `.ts/.tsx/.html`、命中 157 → **152 条**（`已有兜底` 86 / `无风险` 50 / `真实漏洞` 5 / `需动态验证` 11；风险 高 4 / 中 12 / 低 136），明细表 **25 条**旧 `文件:行` 指不到实时命中、已按复算重锚（`attachments/parsers/*`、`history/zipReader.ts` 等条目随文件重排/删除消失，不是漏了）。**`QuotaExceededError` 从「0 命中清单」挪进「各能力命中数」**：`src/services/chat/db.ts:265` 的 `classifyStorageFailure` 用 `case 'QuotaExceededError'`（连同 `NS_ERROR_DOM_QUOTA_REACHED`）把写失败分成 `quota` / `clone` / `unavailable` / `unknown` 四档，上一版「没有一处区分『配额满了』和『存储不可用』」的结论随之失效；「未覆盖的边界」第 5 条改成「配额真的满了会怎样仍然没实测」。

- 复核（2026-11-21 11:56，基准 `171f02f`，本单 #679）：新增 `src/services/consume/confirmEffect.ts` 1 个 `.ts`，扫描范围 277 → **278** 个源文件（`.ts` 206 → **207**）。新文件不碰 `window` / `document` / `navigator` / 原生桥（只做 `Promise` 与纯函数判定），**命中数与风险分布未变**（143 条 / 高 4 / 中 12 / 低 127），明细表未动。
- 复核（2026-11-20 18:55，基准 `ffb305f`，本单 #542）：**第一次由生成器写盘**（`node scripts/gen-capabilities-docs.mjs`），不再手抄数字。命中总数 128 → **130 条**（`无风险` 39 → **41**，`已有兜底` 75 / `真实漏洞` 5 / `需动态验证` 9 不变）；风险分布 低 114 → **116**（高 4 / 中 10 不变）。各能力表：`Body.text/arrayBuffer` 16 → **17**、`Capacitor.isNativePlatform` 11 → **12**。明细表整表重写：127 行 → **130 行**，其中 **42 处旧 `文件:行` 已指不到实时命中**（漂移），另 10 行过去只写文件名 / 函数名、没有行号，现在一律带 `文件:行`；人的现场说明（`#104` / `#412` / `#434` / `#498` 等）按「同文件同能力、行数未变就沿用原文」保留。
- 复核（2026-11-20 18:05，基准 `f8b8125`，本单 #498 分支 `feat/legacy-migration-tail`）：新增 `src/legacy/migration/**` 4 个 `.ts` 与 1 个 `.tsx`，扫描范围 248 → **253** 个源文件。新代码**只新增 1 处宿主能力调用**：`src/legacy/migration/collect.ts:40` 读老账号额度槽位的 `localStorage`（读取包在 `try` 里、读不到当没有 → **已有兜底**，低风险），所以命中总数 127 → **128 条**（`已有兜底` 74 → **75**，其余三类不变），风险分布 低 113 → **114**（高 4 / 中 10 不变），`localStorage` 19 → **20**；其余各能力计数未变。
- 复核（2026-11-20 11:40，本单 #451 分支 `feat/key-identity-451`）：新增 1 个 `.ts` 源文件（`src/services/invite/keyIdentity.ts`，Key 身份时间记录），扫描范围 211 → **212** 个源文件。新文件**不碰任何宿主能力**（纯计算，localStorage 读写仍只发生在 `src/services/api/apiConfig.ts` 的既有 `read` / `write` 两个函数里，没有新增调用点），命中总数与各能力计数、风险分布均未变。
- 复核（2026-11-19 18:32，基准 `452debb`，本单 #303 分支 HEAD `204bd6e`）：新增 1 个 `.ts` 源文件（`src/services/api/keyRejection.ts`），扫描范围 202 → **203** 个源文件（`.ts` 147 → **148**）。新文件不碰 storage / clipboard / fetch / Capacitor（只做 Key 指纹与 401 状态，网络请求仍在 `src/services/api/client.ts`），**命中总数仍是 119 条**，各能力计数与风险分布（高 4 / 中 10 / 低 105）未变；`src/services/api/client.ts` 的 4 处 `文件:行` 按本次实时复算重锚（`:155` / `:260` / `:646` / `:666`）。
- 复核（2026-11-19 18:35，基准 `68c4d9d`，本单 #305）：新增 1 个 `.ts` 源文件（`src/components/settings/logView.ts`），扫描范围 199 → **200** 个源文件。新文件没有任何宿主能力调用（不碰 storage / clipboard / fetch / Capacitor，复制走既有的 `copyText` 工具），**命中总数仍是 119 条**，各能力计数与风险分布未变；`FeedbackDialog.tsx` 因新增日志预览区整体下移，`Capacitor.isNativePlatform` 的行号从 `:202` 修正为 `:241`。
- 复核（2026-11-19 18:50，基准 `7a65f55`，本单 #324 分支 HEAD）：新增 1 个 `.ts` 源文件（`src/services/chat/replyErrorReport.ts`），扫描范围 203 → **204** 个源文件。新文件没有任何宿主能力调用（不碰 storage / clipboard / fetch / Capacitor；复制仍走既有的 `copyText` 工具，脱敏仍走既有的 `scrubReportText`），**命中总数仍是 119 条**，各能力计数与风险分布未变。
- 复核（2026-11-19 19:20，基准 `1577841`，本单 #310 分支）：新增 2 个 `.ts` 源文件（`src/services/updateFailure.ts` / `src/services/updateReport.ts`），扫描范围 204 → **206** 个源文件。两个文件都不碰 storage / clipboard / fetch / Capacitor（复制仍走既有的 `src/utils/clipboard.ts`，诊断文本只做字符串拼接），**命中总数仍是 119 条**，各能力计数与风险分布（高 4 / 中 10 / 低 105）未变。
- 复核（2026-11-19 19:50，基准 `0c89bf5`，本单 #331 分支 `chore/331-retire-buy`）：旧支付链路（`/buy` 收银台、`/api/buy` 建单、`/api/order` 查单、订单存档）整条删除，`transport.ts` 里的 `CheckoutBrowser` 插件（`registerPlugin`，原 `:37`，`需动态验证`）随之消失，因此命中总数 119 → **118**、`需动态验证` 9 → **8**、风险分布「中」10 → **9**；扫描范围 205 → **204** 个源文件（`.ts` 仍是 149：删 `orderStore.ts` / `returnParams.ts`、加 `storage.ts`）。`transport.ts` 其余 3 处命中按实时复算重锚：`Capacitor.isNativePlatform` `:39` → **`:20`**、`AbortController` `:57`、`Body.text/arrayBuffer` `:140` → **`:69`**。
- 复核（2026-11-19 20:05，基准 `42a3a68`，本单 #339 分支 `fix/deepseek-model-residue-339`）：新增 1 个 `.ts` 源文件（`src/services/api/configMigration.ts`，扫描范围 204 → **205** 个源文件）。迁移模块**不直接碰 localStorage**：版本号的读写走 `apiConfig.ts` 新增的 `readConfigValue` / `writeConfigValue`（配置层仍是宿主能力的唯一入口），所以 **命中总数仍是 118 条**，各能力计数与风险分布（高 4 / 中 9 / 低 105）未变。`apiConfig.ts` 顶部注释多了一行，3 处 `localStorage` 命中按实时复算重锚：`:57` → **`:58`**、`:66` → **`:67`**、`:68` → **`:69`**；`src/main.tsx` 的 `initDiagnostics()` 因为前面插入了一行 `migrateConfigOnce()` 从 `:66` 移到 **`:68`**。
- 复核（2026-11-20 01:00，基准 `519a721`，本单 #421 分支 `feat/email-adapt`）：新增 2 个 `.ts` 源文件（`~~src/services/invite/email.ts~~`（#604 已删，现为 `src/services/consume/email.ts`）、`src/services/invite/emailCooldown.ts` 发码倒计时纯函数），扫描范围 208 → **210** 个源文件。新文件不碰 storage / clipboard / fetch / Capacitor（设备码存储走注入的 `storage` 接口，网络走注入的传输层），**命中总数仍是 118 条**，各能力计数与风险分布未变；`OursServicesDialog.tsx` 新增的邮箱区复用既有 `Button` / 输入框写法，未新增宿主能力调用。
- 复核（2026-11-20 08:30，基准 `dfe6db0`，本单 #434 / #374 分支 `fix/error-readability-434-374`）：新增 1 个 `.ts` 源文件（`src/services/api/keyFailure.ts`：Key 失效的细分与尾号，不碰 storage / clipboard / fetch / Capacitor），扫描范围 210 → **211** 个源文件（`.ts` 152 → **153**）。命中总数 121 → **122**：`src/services/api/client.ts` 的 `htmlResponseDetail()` 新增一处 `response.text()`（读上游 HTML 报错页的正文前 200 字，给 #434 的折叠区），所以 `Body.text/arrayBuffer` 15 → **16**（`已有兜底` 9 → **10**），风险分布 低 108 → **109**（高 4 / 中 9 未变）。`src/services/api/client.ts` 的 4 处 `文件:行` 与 `src/services/chat/store.ts` 的 1 处按本次实时复算重锚：`:155` → **`:168`**、`:260` → **`:289`**、`:646` → **`:688`**、`:666` → **`:708`**、store.ts `:1281` → **`:1315`**。
- 复核（2026-11-20 12:20，基准 `e5ee313`，本单 #386 分支 `feat/scroll-to-bottom-386`）：新增 1 个 `.tsx`（`src/components/session/ScrollToBottomButton.tsx`）与 1 个 `.ts`（同名 `.module.css.d.ts` 类型声明），扫描范围 212 → **214** 个源文件。新文件不碰 storage / clipboard / fetch / Capacitor，也不直接调 `matchMedia`（reduced-motion 判定走既有的 `src/utils/usePresence.ts` 的 `prefersReducedMotion()`），**命中总数仍是 122 条**，各能力计数与风险分布（高 4 / 中 9 / 低 109）未变；`src/components/messages/MessageList.tsx` 因新增 import 与一段按钮状态逻辑整体下移，`ResizeObserver` 两处从 `:110` / `:125` → **`:195` / `:212`**、`CSS.escape` 从 `:195` → **`:282`**。

- 复核（2026-11-20 17:35，基准 `54a45f8`，本单 #487 W1-C1 分支 `feat/account-consume-page`，「账户与消费」页）：新增 3 个源文件 —— `src/components/consume/**` 的 `.tsx`（`AccountConsumePage` 页面壳 / `MyCardsTab` 我的卡密 / `BuyTab` 购买），Tab3 / Tab4 直接挂 W1-C2 的 `QuotaPanel` / `AccountPanel`（同一个 `consume` 实例 + `onNeedLogin` 递下去，没有第二套状态机）。三个新文件都**不直接碰宿主能力**：复制卡密走既有的 `src/utils/clipboard.ts`（`copyText`），apia 请求走既有的 `services/ours/transport.ts`（`httpTransport` / `openPayLinkInApp`），sub2api 请求走 `services/consume`，所以 `navigator.clipboard` / `Capacitor.isNativePlatform` 的命中都没有新增。扫描范围 244 → **247** 个源文件（`.tsx` 63 → **66**），命中总数（127）、各能力计数与风险分布均未变；`src/components/settings/SettingsDialog.tsx` 因为删掉三格入口（#482 三弹层合一）少了 45 行，其中两处 `AbortController` 整体上移（明细表里那三条 `:979` / `:1231` / `:1236` 是更早一次 PR 留下的漂移，本单未动）。
- 复核（2026-11-20 18:35，基准 `05d45a4`，本单 #487 W1-B 后半分支 `feat/auth-gate-wiring`，sync 到 main 之后重算）：本轮两件事都不新增宿主能力：① 登录接缝（`__TEST_AUTH_STATE__`）只加一句构建期常量读取 + 一次 `useAuthStore.setState`，不碰 storage / fetch / Capacitor；② `src/legacy/migration/README.md` 的 USD → 元只是文档措辞。命中总数 128 → **130 条**（`无风险` 39 → **41**，风险分布 低 114 → **116**，高 / 中未变），两处增量全部来自 main 上 #307 落到 `src/services/exportText.ts` 的历史归档导出出口（`Body.text/arrayBuffer` 16 → **17**、`Capacitor.isNativePlatform` 11 → **12**，两条都是「裸调用但引入版本 ≤ 83」→ `无风险`）。该文件的 `文件:行` 锚点随重写整体漂移，盘点表已按 `scripts/lib/hostCapabilityAudit.mjs` 的复算结果重锚（`registerPlugin` 明细也由 5 处更正为 6 处）；扫描范围仍是 **255** 个源文件。
- 复核（2026-11-20 16:20，基准 `d198ccc`，本单 #487 W1-A 分支 `feat/consume-layer`）：新增 9 个 `.ts`（`src/services/consume/**`：http / errors / auth / keys / usage / redeem / aff / email / index）。`http.ts` 用 `Capacitor.isNativePlatform()` 判「是不是原生环境」（非原生直接回 `unsupported`，不做 fetch 兜底），因此 `Capacitor.isNativePlatform` 10 → **11**（`无风险` 8 → **9**，Chromium 83 无此 API 但它是 Capacitor 注入的宿主能力，非原生分支即兜底）。命中总数 123 → **124**、`无风险` 38 → **39**、风险分布 低 109 → **110**（高 / 中未变）。扫描范围 217 → **226** 个源文件（`.ts` 169 / `.tsx` 56 / `.html` 1）。其余能力计数与 §「真实漏洞」5 条一处未变；`src/services/consume/http.ts` 新增的 `AbortController` / `fetch` 是**注释里的说明文字**，不进命中。
- 复核（2026-11-20 16:35，基准 `e504986`，本单 #487 W1-B 分支 `feat/auth-layer-skeleton`）：新增 5 个 `.ts`（`src/services/auth/{types,transport,store,flags}.ts`、`src/components/auth/authForm.ts`）与 3 个 `.tsx`（`AuthGate` / `LoginPage` / `RegisterPage`），扫描范围 226 → **234** 个源文件（`.ts` 169 → **174**、`.tsx` 56 → **59**）。命中总数 124 → **127** 条：`src/services/auth/store.ts` 的凭据存储 `read`（`:92`）与 `write`（`removeItem` `:101` / `setItem` `:103`）各 1 处 `localStorage`，三处都自带 `try…catch`（存储不可用只影响「下次要不要重登」），记 `已有兜底`；`localStorage` 16 → **19**（`已有兜底` 15 → **18**）。风险分布 低 110 → **113**（高 4 / 中 10 未变）。
- 复核（2026-11-20 17:00，基准 `3392efa`，本单 #487 W1-C2 分支 `feat/consume-panels`，「账户与消费」四面板）：新增 10 个 `.ts / .tsx`（`src/components/consume/**`），扫描范围 234 → **244** 个源文件。新代码**不新增任何宿主能力调用**：不碰 storage（余额不落本地，#484 §七 第 6 条）、不碰 fetch / Capacitor（网络全走 W1-A 的 `services/consume/**`），复制仍走既有的 `src/utils/clipboard.ts` 的 `copyText`，`navigator.clipboard` 的命中数与判定不变。**命中总数仍是 127 条**，各能力计数与风险分布未变。
- 复核（2026-11-20 17:20，基准 `3392efa`，本单 #487「统一计量单位为元」分支 `chore/unify-currency-cny`）：新增 1 个 `.ts` 源文件（`src/utils/money.ts`，金额格式化纯函数 + 币种符号表），扫描范围 234 → **235** 个源文件。新文件**不碰任何宿主能力**（无 storage / clipboard / fetch / Capacitor / matchMedia），命中总数仍是 **127 条**（`已有兜底` 74 / `无风险` 39 / `真实漏洞` 5 / `需动态验证` 9），风险分布（高 4 / 中 10 / 低 113）与各能力计数未变。
- 合并复核（2026-11-20 17:35，基准 `77cd6e8`，`chore/unify-currency-cny` rebase 到 #505 之后）：重新跑 `scripts/lib/hostCapabilityAudit.mjs`，扫描范围 **248** 个源文件（`.ts` 181 / `.tsx` 66 / `.html` 1），命中总数 **127 条**（`已有兜底` 74 / `无风险` 39 / `真实漏洞` 5 / `需动态验证` 9），风险分布（高 4 / 中 10 / 低 113）未变；上方扫描范围已按复算结果更新。
- 复核（2026-11-21 10:45，基准 `58acbc9`，本单 #490 分支 `feat/send-blocked-config-490`）：新增 1 个 `.ts` 源文件（`src/services/api/sendConfigCheck.ts`：五类必错配置的纯判定，只用 `URL` 解析与字符串处理），扫描范围 276 → **277** 个源文件。新文件**不碰任何宿主能力**（无 storage / clipboard / fetch / Capacitor / matchMedia），命中总数仍是 **143 条**（`已有兜底` 78 / `无风险` 49 / `真实漏洞` 5 / `需动态验证` 11），风险分布（高 4 / 中 12 / 低 127）与各能力计数未变；`src/services/api/apiConfig.ts` 的三条 `localStorage` 锚点因顶部新增 1 行 import 由生成器重锚到 `:91/:100/:102`。
