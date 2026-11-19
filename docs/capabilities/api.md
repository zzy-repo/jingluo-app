# 类别 1：JS 内置 API 与语言特性假设盘点

> 快照基准：`acf6826`（`origin/main` tip，2026-11-19 12:28:21 +0800）· 采集时间：2026-11-19 18:55 (+0800)。
> 下面的数字全部由 `scripts/lib/apiAssumptionAudit.mjs` 在基准 commit 上跑出来，不是数的；`tests/unit/capabilities-docs-sync.test.mjs` 会重新跑一遍并逐项比对，文档一旦落后于代码就红。

追踪单：[#209 能力探测替代一切假设](https://github.com/zzy-repo/deepseek-app/issues/209)。本单只做盘点、定规范、建工具；下面「真漏洞」里的三条已各自拆成独立 issue，**不在本单修**。

| 项目 | 值 |
| --- | --- |
| 兼容基线 | Android WebView **83**（Chromium 83.0.4103.106，Android 11 出厂镜像） |
| 扫描范围 | `src/**` 共 **249** 个文件（**149** `.ts` / 54 `.tsx` / 44 `.css` / 1 `.html` / 1 `.md`） |
| 判定方式 | **静态推断**：词法层遮蔽注释、字符串、模板后按调用形状匹配；**非运行时验证** |
| 工具 | [`scripts/lib/apiAssumptionAudit.mjs`](../../scripts/lib/apiAssumptionAudit.mjs)（纯判定模块，无遍历、无打印） |
| 单测 | [`tests/unit/api-assumption-audit.test.mjs`](../../tests/unit/api-assumption-audit.test.mjs)（10 个用例，三个判定桶各钉真例子） |
| 真值来源 | `scripts/check-bundle-syntax.mjs` 的 `LEGACY_RUNTIME_APIS`、`scripts/compat/matrix-scan.mjs` 的 `RUNTIME_APIS` / `LEGACY_POLYFILLED`、`src/polyfills/legacy.ts`；本单**没有**新建第四份清单 |

## 一、按类别的命中总数

| 类别 | 含义 | 命中数 |
| --- | --- | --- |
| **类别 1 / 依赖入口 polyfill**（`entry-polyfill`） | 首次支持 > 83，但 `src/polyfills/legacy.ts` 会补齐（靠 `src/main.tsx` 的第一条 import 生效） | **31** |
| **基线内**（`baseline`） | 首次支持 ≤ 83，WebView 83 原生自带 | **20** |
| **真漏洞**（`uncovered`） | 首次支持 > 83 且没有任何兜底 | **0** |
| 合计 | | **51** |

类别 1 命中总数 **51 处 / 249 个文件**：31 处依赖入口 polyfill、20 处落在基线内、**0 处裸调用无兜底**。

> 文件数 +2 是 #306 新增 `src/services/diagnostics/fields.ts` 与 `timing.ts` 两个源文件；**命中总数仍是 51**（两文件里没有类别 1 命中），§二 的 `文件:行` 已按位移后的行号重算。

入口兜底的覆盖面（`src/polyfills/legacy.ts` 实际安装的 13 项）：`Object.hasOwn`、`Array.prototype.at`、`String.prototype.at`、`Array.prototype.findLast`、`Array.prototype.findLastIndex`、`Array.prototype.toSorted`、`Array.prototype.toReversed`、`Array.prototype.toSpliced`、`Array.prototype.with`、`structuredClone`、`crypto.randomUUID`、`String.prototype.replaceAll`、`Intl.Segmenter`。

### 依赖入口 polyfill 的 31 处是否可接受

可接受，但**约束是隐式的**，这是本类别唯一的结构性风险：

1. 生效方式正确：`src/main.tsx:3` 是文件里的第一条 import（`src/main.tsx:1-2` 有注释锁定），`rspack.config.ts:117` 只有一个入口 `./src/main.tsx`，没有第二条入口能绕过；
2. 兜底本身规矩：幂等（重复 install 方法引用不变）、不覆盖原生实现（新版内核等于什么都没做）、无第三方依赖、只用 ≤ ES2020 语法（自己不能被降级目标反噬）；
3. **缺口**：这条「必须第一个 import」的顺序约束目前只靠注释和单测，没有构建期门禁（产物里若 legacy chunk 被排到调用方之后就会重演 #39 的 beta.8 白屏）。构建期校验归 `scripts/check-capabilities.mjs`（另一条 lane 的工作），本条只记录缺口，不在本单实现。

## 二、逐条命中（51 处）

| 文件:行 | 假设内容 | 类别 | 风险(高/中/低) | 处置(已有兜底/需探测/需动态验证/拆单) |
| --- | --- | --- | --- | --- |
| `src/app/App.tsx:41` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/app/App.tsx:50` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/components/base/Modal.tsx:97` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/components/chatInput/ChatInput.tsx:54` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/components/markdown/MermaidDiagram.tsx:49` | `String.prototype.trimEnd` 存在（Chromium 66，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/components/messages/MessageList.tsx:22` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/components/messages/MessageList.tsx:80` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/components/messages/ReplyArea.tsx:141` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/i18n/index.ts:16` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/api/modelPayload.ts:7` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/api/openaiAdapter.ts:98` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/api/openaiAdapter.ts:354` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/appUpdate.ts:63` | `crypto.randomUUID` 存在（Chromium 92） | 1 | 中 | 已有兜底 |
| `src/services/chat/backup.ts:33` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/chat/db.ts:45` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/history/toArchive.ts:61` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/history/toArchive.ts:258` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/history/toLocal.ts:77` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/history/toLocal.ts:141` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/history/toLocal.ts:214` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/history/toLocal.ts:291` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/history/urlImport.ts:1270` | `crypto.randomUUID` 存在（Chromium 92） | 1 | 中 | 已有兜底 |
| `src/services/chat/reply.ts:33` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/reply.ts:162` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/reply.ts:241` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/reply.ts:261` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/sessionGroups.ts:25` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:143` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:148` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:226` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:246` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:492` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:831` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:926` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:927` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/store.ts:1055` | `Promise.allSettled` 存在（Chromium 76，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/view.ts:166` | `String.prototype.trimEnd` 存在（Chromium 66，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/view.ts:268` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/chat/view.ts:274` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/chat/view.ts:386` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/diagnostics/collector.ts:321` | `Array.prototype.at` 存在（Chromium 92；13 处接收者全是数组，零字符串接收者） | 1 | 中 | 已有兜底 |
| `src/services/diagnostics/collector.ts:547` | `crypto.randomUUID` 存在（Chromium 92） | 1 | 中 | 已有兜底 |
| `src/services/diagnostics/shared.ts:25` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/location.ts:44` | `Intl.DisplayNames` 存在（Chromium 81，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/location.ts:44` | `Intl.DisplayNames` 存在（Chromium 81，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/location.ts:48` | `Intl.DisplayNames` 存在（Chromium 81，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/services/markdown/highlight.ts:100` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/markdown/highlight.ts:101` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/markdown/highlight.ts:105` | `Object.hasOwn` 存在（Chromium 93） | 1 | 中 | 已有兜底 |
| `src/services/markdown/parse.ts:64` | `Array.prototype.flatMap` 存在（Chromium 69，低于基线） | 1 | 低 | —（基线内，无需处置） |
| `src/utils/id.ts:5` | `crypto.randomUUID` 存在（Chromium 92） | 1 | 中 | 已有兜底 |

风险口径：`uncovered` = 高（低内核直接抛异常）；`entry-polyfill` = 中（能用，但正确性依赖入口顺序这一条无门禁的约定）；`baseline` = 低（WebView 83 原生具备）。

## 三、按 API 汇总

| API | 首次支持 | 命中 | 涉及文件 | 判定 | 已兜底 |
| --- | --- | --- | --- | --- | --- |
| `Array.prototype.flatMap` | 69 | 14 | 8 | `baseline` | 否 |
| `Object.hasOwn` | 93 | 14 | 7 | `entry-polyfill` | 是 |
| `Array.prototype.at / String.prototype.at` | 92 | 13 | 9 | `entry-polyfill` | 是 |
| `crypto.randomUUID` | 92 | 4 | 4 | `entry-polyfill` | 是 |
| `Intl.DisplayNames` | 81 | 3 | 1 | `baseline` | 否 |
| `String.prototype.trimEnd` | 66 | 2 | 2 | `baseline` | 否 |
| `Promise.allSettled` | 76 | 1 | 1 | `baseline` | 否 |

## 四、扫过但确认为 0 命中的能力

下面这些是「**扫过且确认 0 处**」，不是「没扫」——判定模块里每条都有一条规则，单测里有正例钉着规则能命中：

- **语言特性**：正则后行断言 `(?<=`（Chromium 62）、`RegExp` 的 `d` 标志（90）、类私有字段 `#x`（74）、类私有方法（84）、私有成员 `in`（91）、类静态块（94）、顶层 `await`（89）、`import.meta`（64）；
- **String**：`String.prototype.replaceAll`（85）、`String.prototype.at` 的字符串接收者（92，0 处接收者是字符串）；
- **Array**：`fromAsync`（121）、`toReversed` / `toSpliced` / `with`（110）、`findLast` / `findLastIndex`（97）、`.flat(`（69）；
- **Object / Promise**：`Object.groupBy`（117）、`Promise.withResolvers`（119）、`Promise.any`（85）、`AggregateError`（85）；
- **其他**：`structuredClone` 裸调用（98，只有 `src/polyfills/` 里的安装处）、`Intl.Segmenter` 裸调用（87，同上）、`Intl.RelativeTimeFormat`（71）、`Intl.PluralRules`（63）、`Intl.ListFormat`（72）、`Intl.Locale`（74）、`Error.cause`（93，`src/components/settings/useApiKeyForm.ts:19,56` 是本地状态对象的字段名，不是 `new Error(msg, {cause})`）。

`toSorted` 只在注释与 `typeof` 探测里出现（`src/services/chat/history/toLocal.ts:275,276`、`src/services/diagnostics/collector.ts:452`、`src/services/updateManifest.ts:106`），不构成裸调用。

## 五、真漏洞（已拆单）

| 编号 | 文件:行 | 假设内容 | 实测结论 | 风险 | 对应 issue |
| --- | --- | --- | --- | --- | --- |
| V1 | ~~`src/index.html:72`~~（已删出 `REQUIRED`） | 启动守卫把 `Intl.DisplayNames`（Chromium 81）列为**硬性必需** | 缺该 API 时守卫写 `__DEEPSEEK_COMPATIBILITY_ERROR__` 并拦死启动，而 `src/services/location.ts:24` 早就有 `regionNameFallback` 兜底（#155）——两处结论互相矛盾，WebView 79/80 用户被误拦。**已修（#219 → #226，`57602b8`）**：`Intl.DisplayNames` 已从 `REQUIRED` 移出，`src/index.html:17` 只留一段解释「为什么不检查它」的注释；本节因此少 1 处命中 | 中（已关闭） | [#219](https://github.com/zzy-repo/deepseek-app/issues/219) ✅ |
| V2 | `src/services/diagnostics/capabilityTruth.ts`（原 `src/services/diagnostics/collector.ts:452-454`） | 诊断能力探测假设 `typeof Object.hasOwn/toSorted/at === 'function'` 能反映内核原生能力 | 探针跑在入口 polyfill **之后**，WebView 83 上三项恒为 `true`（Node 里删原生→装兜底实测：`false,false` → `true,true`）；`legacyPolyfillReport()` 已存在却无人引用。**已修（#220）**：改报 `runtime` / `native` / `polyfilled` 两个维度 + 兜底台账，原生结论取自 `legacyPolyfillReport().installed`（见下节） | 中（已关闭） | [#220](https://github.com/zzy-repo/deepseek-app/issues/220) ✅ |
| V3 | `src/polyfills/legacy.ts` 的 `String.prototype.at` 兜底（上面那段注释块） | 注释假设「原生 `String.prototype.at` 按 code point 取值，与兜底不同」 | 原生同样按 UTF-16 码元；7 字符串 × 8 索引共 56 组对照**零差异**。行为正确，错的是注释——但它会诱导后来者把正确实现「修正」成错的 | 低 | [#221](https://github.com/zzy-repo/deepseek-app/issues/221) |

其余 51 处（31 处入口兜底 + 20 处基线内）经逐行核对，不构成需要拆单的漏洞。

复核（2026-11-19 12:19，基准 `55c4d1e`）：本轮再复算一次，只动了扫描范围与两处行号——`#239`–`#256` 这十条合并把 `src/**` 从 238 个文件带到 **240** 个（新增文件里没有上述任何一条 API，命中总数因此仍是 51）；`src/services/diagnostics/collector.ts` 因 #237 的取数通道重构整体移位，`Array.prototype.at` 从 `:298` → **`:299`**、`crypto.randomUUID` 从 `:524` → **`:525`**。分类分布（31 / 20 / 0）与按 API 汇总（3 / 14 / 14 / 13 / 4 / 2 / 1）全部未变。

复核（2026-11-19 11:35，基准 `4870b33`）：V1 已经消失——#219 修复（#226，`57602b8`）把 `Intl.DisplayNames` 从 `REQUIRED` 移出，`src/index.html` 里现在只剩一段解释性注释，不再有可执行代码声称它是硬性必需，因此那一行命中不复存在（本表 52 → 51、基线内 21 → 20 的全部原因）。

### V2 的修法与口径（#220）

诊断里的能力字段拆成两个维度，并把兜底台账一起上报（`src/services/diagnostics/capabilityTruth.ts`）：

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `system.capabilities` | **运行时可用**（含入口兜底）。语义与 #220 之前完全一致，字段名一个没改 | 判断「这段代码会不会炸」看这份 |
| `system.nativeCapabilities` | **内核原生具备**（扣掉入口兜底装的，字段集合与 `capabilities` 相同） | 判断「这颗 WebView 到底是什么水平」看这份 |
| `system.polyfilled` | 入口兜底**实际装上**的 API 名（`legacyPolyfillReport().installed`，原生缺失时才会装） | 点名 = 这颗内核没有该 API |
| `system.degradedClones` | `structuredClone` 按引用降级透传的次数 | >0 表示有调用方在共享引用 |

原生结论为什么可以「事后」取：`legacy.ts` 每个 installer 都是「原生在就早退、不在才 `define()`」，而 `define()` 只在真的装的时候登记名字，所以 `installed` 记录的是**装之前**那一刻的事实，且是在唯一能记对的时刻记的。因此不依赖 `main.tsx` 里 import 的先后顺序（那件事至今只有注释和单测守着，见 §3），也不需要「先探一份基线再缓存」——后者正是 `src/utils/capabilities.ts` 不能接 `legacy.ts` 的原因（`hasApi()` 按下标缓存，补丁前探到的 `false` 会被永久钉死，#212 的注释里写过）。

## 六、记录为「可接受策略」而非漏洞的两处降级

这两处都是**有意为之且被单测锁定的**降级，因此不进「真漏洞」，只在此备案，供后续判断时查：

| 位置 | 降级 | 为什么可接受 |
| --- | --- | --- |
| `src/polyfills/legacy.ts` 的 `structuredClone` | 函数 / Symbol / Node / Promise / WeakMap / WeakSet / WeakRef **按引用透传**（并累加 `degradedClones`），空的 `transfer` 列表被忽略，非空 `transfer` 明确抛 `DataCloneError` | 低内核上「按引用透传」比「整页崩」好；`src/**` 里没有 `structuredClone` 裸调用，风险敞口只在第三方；且 `degradedClones` 让降级可观测 |
| `src/polyfills/legacy.ts` 的 `Intl.Segmenter` | 只实现 `grapheme` 粒度，`word` / `sentence` 抛 `RangeError` | 应用只用 `grapheme`（#167 的修复路径）；明确抛错好过静默切成码点；单测 `tests/unit/intl-segmenter-fallback.test.mjs` 锁定了抛错行为 |

## 七、工具与复跑

判定逻辑集中在 `scripts/lib/apiAssumptionAudit.mjs`（三层结构的第一层：纯判定，不遍历、不打印、不读盘），CLI 侧遍历与输出由调用方负责。复跑：

```bash
node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path'
import { auditApiAssumptions, summarize } from './scripts/lib/apiAssumptionAudit.mjs'
const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p) } }
walk('src')
const res = auditApiAssumptions(files.map((p) => ({ path: p.split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') })))
console.log(JSON.stringify(summarize(res), null, 2))
"
node --test tests/unit/api-assumption-audit.test.mjs
node --test tests/unit/capabilities-docs-sync.test.mjs   # 文档与复算是否还对得上
```

### 已知边界（静态盘点的固有局限）

- **只认调用形状，不认语义**：`x.at(` 记成 `Array.prototype.at`（`src/**` 里恰好没有字符串接收者，已人工核对）；`Reflect.get(o, 'at')`、`o['at'](` 这类动态取用扫不到。
- **遮蔽器是手写状态机**（不引第三方依赖）：字符串、模板字符串（模板里的插值表达式按花括号深度配对）、行/块注释都抹成等长空白，行号与偏移不变；HTML 只保留 `<script>` 内联脚本，CSS / Markdown 整篇抹空 —— 否则 `src/app/global.css` 的 `#root {` 会被当成类私有字段、`src/index.html` 的注释文本会被当成代码（这两种假阳性本轮真踩到过）。
- **不看运行时**：结论全部是「静态推断」，任何「实测某内核失败」的表述都在对应 issue 里单独给了可复现手段（Node 里删原生 API 装载真实 polyfill），真机/模拟器结论未取得。
- **不覆盖第三方 chunk**：只扫 `src/**`，`node_modules` 里的异步 chunk 不扫。`src/polyfills/legacy.ts` 里 `replaceAll` 一节记录过「第三方 async chunk 带进来 31 处裸调用」（#79），这类风险靠入口兜底整体覆盖，不在这份清单里逐条计数。
- **版本号来自 MDN/caniuse 兼容表**（本机没有 `@mdn/browser-compat-data` / `caniuse-lite` / `core-js-compat` 可离线查），与仓库已有两份清单交叉核对（`scripts/check-bundle-syntax.mjs`、`scripts/compat/matrix-scan.mjs`）无冲突。

## 八、未测边界

- Android 模拟器被其他分支独占，**没有**在真机 / 模拟器 WebView 79 / 83 / 91 / 109 上实测本清单里的任何一条；「首次支持」全部来自兼容表，「实测」全部指 Node 里对真实模块的可执行对照。
- `src/index.html` 内联守卫只在 Node `vm` 里复现过（沿用 `tests/unit/intl-displaynames-fallback.test.mjs` 的手法），没有真机启动页截图。
- 第三方依赖 chunk 的裸调用未在本单盘点（见上节）。
- CSS 单位 / 交互行为 / 平台桥接三类假设分属类别 2 / 4 / 3，不在本文档范围。

## 复核记录

- 复核（2026-11-19 18:32，基准 `452debb`，本单 #303 分支 HEAD `204bd6e`）：新增 1 个 `.ts` 源文件（`src/services/api/keyRejection.ts`，401 判死后的 Key 指纹与停止自动探测的状态）与 `tests/` 侧新增用例，扫描范围 247 → **248** 个文件、`.ts` 147 → **148** 个。新文件只用 `charCodeAt` / `toString(16)` / `URL` 解析与 `zustand` 的 `create`，**没有任何一条本表里的 API**，**命中总数仍是 51 处**，分类分布（31 / 20 / 0）、按 API 分项（3 / 14 / 14 / 13 / 4 / 2 / 1）与 §二 的 `文件:行` 均未变（`src/services/api/client.ts`、`src/services/chat/store.ts` 的改动都在既有命中行之后）。
- 复核（2026-11-19 18:35，基准 `68c4d9d`，本单 #305）：新增 1 个 `.ts` 源文件（`src/components/settings/logView.ts`，日志预览的过滤 / 分组 / 复制纯函数），扫描范围 244 → **245** 个文件、`.ts` 144 → **145** 个。新文件里没有上述任何一条 API（只用 `String#slice` / `padStart` / `Object.entries` / `JSON.stringify` / `Number.isFinite`，全部 ≤ Chromium 83），**命中总数仍是 51 处**，分类分布、按 API 分项、逐条命中表的 `文件:行` 均未变。
- 复核（2026-11-19 18:50，基准 `7a65f55`，本单 #324 分支 HEAD）：新增 1 个 `.ts` 源文件（`src/services/chat/replyErrorReport.ts`，回答失败时「复制诊断信息」的纯文本生成），扫描范围 248 → **249** 个文件、`.ts` 148 → **149** 个。新文件只用 `new Date().toISOString()` / `Number.isFinite` / `String#trim`，**没有任何一条本表里的 API**（`scrubReportText` / `truncate` 是既有模块的导出），**命中总数仍是 51 处**，分类分布（31 / 20 / 0）、按 API 分项（3 / 14 / 14 / 13 / 4 / 2 / 1）与 §二 的 `文件:行` 均未变（`src/services/api/errors.ts`、`client.ts`、`src/services/chat/describe.ts`、`store.ts` 的改动都在既有命中行之后或同处替换）。
- 复核（2026-11-19 19:20，基准 `1577841`，本单 #310 分支）：新增 2 个 `.ts` 源文件（`src/services/updateFailure.ts` 失败分类、`src/services/updateReport.ts` 诊断文本），扫描范围 249 → **251** 个文件、`.ts` 149 → **151** 个。两个文件只用 `padStart` / `Number.isFinite` / `URL` / `Date` 这类基础能力，**没有任何一条本表里的 API**，**命中总数仍是 51 处**，分类分布（31 / 20 / 0）与按 API 分项未变；§二 的 `文件:行` 也未动（`AppUpdateField.tsx` 的改动不在任何命中行上）。
- 复核（2026-11-19 19:50，基准 `0c89bf5`，本单 #331 分支 `chore/331-retire-buy`，支付入口切联动小铺后的旧链路停用）：删 2 个 `.ts`（`src/services/ours/orderStore.ts` 未完成订单存档、`returnParams.ts` 回跳参数解析）、把只剩存储形状的那一段搬进新文件 `src/services/ours/storage.ts`，扫描范围 250 → **249** 个文件、`.ts` 150 → **149** 个。`api.ts` 的 `/buy` 收银台、`/api/buy` 建单、`/api/order` 查单三节与 `transport.ts` 的 `CheckoutBrowser` 通路一并删除，但都是既有命中行**之外**的代码，**命中总数仍是 51 处**，分类分布（31 / 20 / 0）、按 API 分项（3 / 14 / 14 / 13 / 4 / 2 / 1）与 §二 的 `文件:行` 全部未变。
