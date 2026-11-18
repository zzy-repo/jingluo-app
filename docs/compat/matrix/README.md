# 静态兼容矩阵（WebView 79 / 83 / 91 / 109）

issue #143 的「静态兼容矩阵」分支：**不用模拟器、不用真机**，只用「语法解析 + API 调用点探针 + CSS 特性扫描」把「哪些 WebView 版本会白屏 / 掉功能」穷举出来。

> **全部结论都是静态推断，不是运行时验证。** 没有任何一档在真机或模拟器上跑过。证据是 acorn 的解析行为 + MDN/caniuse 的特性版本表，出处逐条列在下面。

## 0. 跑法

```bash
# 全量矩阵（人读版）
node scripts/compat/matrix-scan.mjs

# 机器可读（chunk → 最低 ES 版本）
node scripts/compat/matrix-scan.mjs dist --json docs/compat/matrix/es-floor.json

# 也可以走 npm script（先 pnpm run build，产物默认在 ./dist）
pnpm run check:matrix
```

零新依赖：acorn 复用 `scripts/check-bundle-syntax.mjs` 里已有的 `loadAcorn()`（它是 `@rspack/*` 的传递依赖，版本 8.19.0）。扫描器是 `scripts/check-bundle-syntax.mjs` 的**扩展**，不是平行系统 —— 词法剥离、AST 断言、CSS 单位、legacy API 那几层仍在原脚本里，这里只补齐「版本矩阵」这个维度。

### 基线产物

| 项 | 值 |
| --- | --- |
| dist | `D:\all_project\deepseekapp\dist`（预构建，mtime 2025-11-18 20:36） |
| 来源 | 主仓库 HEAD `7d2facb` 打成，**不是** `origin/main`(`081ff71`) |
| JS | 88 个（入口 `static/js/main.73ca8f5e.js` 691 889 B + `static/js/async/` 87 个异步 chunk） |
| CSS | 2 个（`main.fcf260ed.css` 103 563 B + 1 个异步） |
| acorn | 8.19.0 |

产物变了结论就会变，重跑即可；下表所有数字都来自这一份 dist。

## 1. 结论表（直接回答「会不会白屏」）

| WebView / Chromium | 入口解析 | 异步 chunk | 启动期裸 API | 判定 |
| --- | --- | --- | --- | --- |
| **79** | **失败**（`??` 需 Chromium 80） | **25 个解析失败** | `Intl.DisplayNames` 需 81 | **白屏**，且守卫能把它变成一句提示（见第 5 节） |
| **83** | 通过 | 0 | 无 | **不白屏**；CSS 有降级（`:has()`、`@container`、flex `gap`、`:focus-visible`、`:is()` 被忽略） |
| **91** | 通过 | 0 | 无 | **不白屏**；只剩 `:has()`(105) / `@container`(105) 被忽略 + `dvh` 落到 `vh` 回退 |
| **109** | 通过 | 0 | 无 | **干净** |

一句话版：

- **79 白屏**，根因是语法而不是 API —— 入口包里有 `??`。
- **83 不白屏**，但会「掉功能」：`:has()` / `@container` 在 105 才有，88 档的 `:is()`、86 档的 `:focus-visible`、84 档的 flex `gap` 在 83 上全部无效。
- **91 不白屏**，仍有 `:has()` / `@container` 失效。
- **109 干净**。

### 有效下限是 81，不是 80

语法层算出入口包要 Chromium **80**，但 API 层发现入口在**顶层**就 `new Intl.DisplayNames(...)`（Chromium **81**，无特性探测）。两者取大：**这份产物的真实下限是 Chromium 81**。也就是说 WebView 80 既过不了语法，也过不了 API —— 但真正的第一道墙是 80 的 `??`，所以 80 档与 79 档表现相同（白屏）。

## 2. 语法层：每个文件的 ES 下限

方法是把每个 `.js` 用 acorn 从 `ecmaVersion: 5` 一路试到 `2022`，记录**第一个能通过的版本**，以及上一档报错的位置（行 + 片段）。

| ES 下限 | 文件数 | 最低 Chromium | 说明 |
| --- | --- | --- | --- |
| 2015 | 59 | Chrome 43+ | 只用到简洁方法/简写属性（`{9642(){…}}` 这类 Prism 语法包） |
| 2017 | 1 | Chrome 49+ | `async/1523.8506ca2b.js` |
| 2018 | 1 | Chrome 60+ | `async/1283.513cd7f7.js`（对象展开） |
| 2020 | 9 | Chrome 80+ | `?.` / `??` |
| 2022 | 18 | Chrome 74+ | 只有类字段 / 私有字段（acorn 要 2022 才认，Chromium 74 就支持） |

**入口包 `main.73ca8f5e.js`：ES2022 / Chrome 80+，顶门槛特性 `nullish-coalescing`（`??`）。**

`acorn 的 ES 年份 ≠ Chromium 版本`，这是本矩阵最容易读错的地方：acorn 在 `ecmaVersion: 2022` 才接受类字段与私有字段，但 Chromium 72 就有公有字段、74 有私有字段。所以「下限 ES2022」这 18 个文件必须再按 AST 节点细分，实际门槛是 74，不是 105。

### 抬门槛最狠的文件（全部是 `??` 或 `?.`）

| 文件 | ES 下限 / Chromium | 顶门槛特性 | 首个卡点（行:列，ES 上一档解析时） |
| --- | --- | --- | --- |
| `async/1864.addc7b85.js` | ES2022 / 80+ | optional-chaining + nullish-coalescing | `2:5354` `…return i.state.inLink=!1,s}var tA=class{options;rules;lexer;constructor(t){…` |
| `async/2036.14b91ac0.js` | ES2022 / 80+ | nullish-coalescing | `1:25092` `…iption=this.setAccDescription.bind(this)}static #e=(0,l.K2)(this,"RequirementDB")…` |
| `async/2421.0dc240d9.js` | ES2020 / 80+ | nullish-coalescing | `1:23403` `…="column-setting"),s=(null==i?void 0:i.columns)??-1;…` |
| `async/2785.c0148a9e.js` | ES2020 / 80+ | nullish-coalescing | `1:599` `…let s=\`${t[1]}.${(t[2]??"").padEnd(3,"0").slice(0,3)}Z\`,a=new Dat…` |
| `async/2907.3632d4ad.js` | ES2022 / 80+ | nullish-coalescing | `1:18877` `…Config(),this.data=this.getDefaultData()}static #t=(0,a.K2)(this,"QuadrantBuilder")…` |
| `async/3027.d0f67a85.js` | ES2022 / 80+ | nullish-coalescing | `1:5031` `…static #e=(0,s.K2)(this,"TreeMapDB");getNodes(){…` |
| `async/4458.1ee387ea.js` | ES2022 / 80+ | nullish-coalescing | `1:213` `…static #t=(0,r.K2)(this,"ImperativeState");reset(…` |
| `async/5030.101ff1b2.js` | ES2020 / 80+ | nullish-coalescing | `1:17274` `…(),d=(null==(a=h.timeline)?void 0:a.leftMargin)??50;…` |

这 8 个文件里 `??` 的原始出现次数是 **703** 处，`?.` 是 **49** 处（词法计数），也就是说「把 `??` 降级掉」不是改几行的事，要靠构建期 target 降级。

### 79 档解析失败的 25 个 chunk

`1864, 2036, 2421, 2785, 2907, 3027, 4458, 5030, 5133, 5197, 5380, 5431, 5691, 5751, 5856, 5962, 6314, 640, 6497, 7869, 8475, 8658, 9187, 9471, 9831`（均在 `static/js/async/` 下）。

这 25 个 chunk 覆盖 mermaid / 图表 / 代码高亮这类重功能页；**它们不会让首屏白屏，但会让对应路由在 79 上「点进去一块空白」** —— 而且这段失败发生在守卫退出之后（详见第 5 节）。

### ES 版本 → Chromium 的对应依据

| 语法点 | acorn 起始接受 | Chromium 实际 | 证据 |
| --- | --- | --- | --- |
| 模板字面量 | 2015 (6) | 41 | MDN Template literals |
| 箭头函数 / `let` `const` / `class` | 2015 (6) | 45 / 49 / 49 | MDN Arrow functions、Classes |
| 简洁方法 / 简写属性 | 2015 (6) | 43 | MDN Object initializer |
| `for-of` | 2015 (6) | 51 | MDN for…of |
| 求幂 `**` | 2016 (7) | 52 | MDN Exponentiation |
| `async` 函数 | 2017 (8) | 55 | MDN async function |
| 对象 rest/spread | 2018 (9) | 60 | MDN Object spread |
| 可选 catch 绑定 | 2019 (10) | 66 | MDN try…catch |
| `?.` / `??` | 2020 (11) | **80** | MDN Optional chaining、Nullish coalescing |
| `??=` `||=` `&&=` | 2021 (12) | **85** | MDN Logical assignment（本产物 0 处） |
| 数值分隔符 `1_000` | 2021 (12) | 75 | MDN Numeric separators |
| 类字段 / 私有字段 | 2022 (13) | 72 / 74 | MDN Public class fields、Private class features |
| 私有方法 / 访问器 | 2022 (13) | 84 | MDN Private class features |
| `#x in obj` | 2022 (13) | 91 | MDN Private class features |
| 静态初始化块 `static {}` | 2022 (13) | **94** | MDN Class static initialization blocks（本产物 0 处） |
| 顶层 await | 2022 (13) | 89 | MDN Top-level await |
| 正则命名捕获组 / 反向断言 / dotAll | 2018 (9) | 62 | MDN RegExp named groups、Lookbehind |
| 正则 Unicode 属性转义 `\p{…}` | 2018 (9) | 64 | MDN RegExp unicode property escapes |
| BigInt | 2020 (11) | 67 | MDN BigInt |
| 动态 `import()` | 2020 (11) | 63 | MDN import() |

`FEATURE_EVIDENCE` 里每条都带 `doc` 字段（MDN 链接），扫描器输出里可以直接看到；`es-floor.json` 的 `files[].features[]` 是逐文件证据。

## 3. API 层：调用点探针（不是找定义）

「调用点命中」= 在**代码骨架**上用正则找调用形式，声明/定义不算。骨架是用 acorn AST 抹掉字符串、正则、模板字面量、注释内容后得到的（保留长度和换行），所以字符串里的 `"replaceAll"` 不会被误报。

**为什么不用 `scripts/check-bundle-syntax.mjs` 的 `stripLiterals()`**：它是手写状态机，在正则密集的压缩 chunk 上会把成片真实代码当字面量吃掉 —— 实测 `async/1864.addc7b85.js` 一个文件就有 82 段被误吞、最长一段 **53 016 字符**，`Intl.Segmenter` 整个不见了。这不是新 bug（`check:legacy` 的 API 层一直用它），但意味着 **`check:legacy` 的 API 命中数偏少**。本扫描器改用 AST 口径后，同一份产物从 13 个 API/文件组合涨到 17 个。

| API | 最低 Chromium | 调用点 | 文件 | @79 | @83 | @91 | @109 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `structuredClone` | 98 | 9 | 5 | polyfilled | polyfilled | polyfilled | baseline |
| `Object.hasOwn` | 93 | 20 | 2 | polyfilled | polyfilled | polyfilled | baseline |
| `Array/String.prototype.at` | 92 | 28 | 3 | polyfilled | polyfilled | polyfilled | baseline |
| `crypto.randomUUID` | 92 | 4 | 1 | polyfilled | polyfilled | polyfilled | baseline |
| `Intl.Segmenter` | 87 | 2 | 1 | naked-guarded | naked-guarded | baseline | baseline |
| `String.prototype.replaceAll` | 85 | 37 | 4 | polyfilled | polyfilled | baseline | baseline |
| `WeakRef` | 84 | 2 | 1 | naked-guarded | naked-guarded | baseline | baseline |
| `Intl.DisplayNames` | **81** | 2 | 1 | **naked-unprotected** | baseline | baseline | baseline |
| `Promise.allSettled` | 76 | 2 | 2 | baseline | baseline | baseline | baseline |
| `Object.fromEntries` | 73 | 12 | 4 | baseline | baseline | baseline | baseline |
| `AbortController` | 66 | 13 | 1 | baseline | baseline | baseline | baseline |
| `navigator.clipboard` | 66 | 2 | 1 | baseline | baseline | baseline | baseline |
| `ResizeObserver` | 64 | 6 | 2 | baseline | baseline | baseline | baseline |
| `fetch()` | 42 | 7 | 2 | baseline | baseline | baseline | baseline |
| `TextDecoder` | 38 | 8 | 3 | baseline | baseline | baseline | baseline |

- `polyfilled` = `src/polyfills/legacy.ts` 里有对应实现，且 polyfill 标记 `__DEEPSEEK_LEGACY_POLYFILL__` 已打进入口（实测命中 1/1）。
- `naked-guarded` = 裸调用，但调用点附近有特性探测（`typeof X !== 'undefined'`、`X ? … : …`、`?.` / `??` 比较）。
- `naked-unprotected` = 裸调用且没有探测 —— **真正的风险点**，详见 [`api-risk.md`](./api-risk.md)。

查了但**本产物 0 处**：`??=` / `||=` / `&&=`、`static {}`、`IntersectionObserver`、`requestIdleCallback`、`showOpenFilePicker`、`Intl.RelativeTimeFormat`、`AbortSignal.timeout`、`Array.prototype.findLast`。

## 4. CSS 层

`dist/static/css/main.fcf260ed.css`（103 563 B）：

| 特性 | 最低 Chromium | 处 | 回退 |
| --- | --- | --- | --- |
| `dvh` / `svh` / `lvh` | **108** | 14 | **有** vh 回退（1 种写法，覆盖 14 处） |
| `:has()` | **105** | 15 | 无 |
| `@container` | **105** | 1 | 无 |
| flex 容器里的 `gap` | **84** | 71 | 无 |
| `:focus-visible` | 86 | 11 | 无 |
| `:is()` / `:where()` | 88 | 3 | 无 |

- `color-mix()`（111）与 `inset`（87）**0 处**。
- 区分两种「没有回退」：`:has()` / `@container` 是**整条规则被丢弃**（选择器不认识、at-rule 不认识），布局会明显塌；`:focus-visible` / `:is()` 被丢弃只影响焦点样式与少量合并选择器，属**可接受的降级**。两者在 `es-floor.json` 里分别标 `no-fallback` 与 `degraded-with-fallback`。
- `dvh` 有 vh 回退，所以 79/83/91 上是「地址栏收起时高度不跟手」，不是布局崩。

## 5. ES5 守卫链对「语法错误」到底有效吗

`src/index.html:12-60` 那段内联 ES5 守卫，实测机制如下。

**装载顺序**：产物 HTML 里 `<script defer src="static/js/main.…js">` 在 `<script>`（守卫）之前。`defer` 的经典脚本要等文档解析完才执行，而内联守卫在解析到它时就执行了 —— 所以**守卫的监听器先注册，业务包后执行**。这是整条链能成立的前提，顺序反了就全废。

**语法错误能不能被捕获**：`try/catch` 抓不到解析期 `SyntaxError`（它发生在脚本求值之前，作用域外），所以只能靠事件。按 HTML 规范，**经典脚本**的编译/语法错误报给**全局对象**：在 `window` 上派发 `error` 事件，`event.message` 带错误信息。守卫用的是 `window.addEventListener('error', fn, true)`（capture，`event.message`）—— 口径正确，能收到。

对照另一种写法：`<script onerror>` / `script.onerror` 是**元素**事件，只在**加载失败**（网络 404/断流）时触发，语法错误不触发。守卫没有依赖它，是对的。

**兜底**：注释里写明「脚本解析失败时部分内核不触发 error 事件」，所以还有一个 1 秒心跳，12 秒没等到 `window.__DEEPSEEK_BOOTED__ === true` 就报「脚本 12 秒内没有启动（内核过旧或资源加载失败）」。这条路不依赖任何新语法。

**判定（79 / 83）**：
- **79**：入口 `??` 解析失败 → 要么 `error` 事件直达（提示里带 SyntaxError 原文），要么 12 秒心跳兜底。**用户看到的是「页面启动失败。请更新 Android System WebView…」，不是静默白屏。** 守卫链**有效**。
- **83**：入口能解析，守卫正常退出，链无关紧要。

**但守卫有三个覆盖不到的洞（#104 类问题的真正残余）**：

1. **它只管「首屏启不启动」**。79 上那 25 个异步 chunk 是懒加载的，解析失败发生在 `__DEEPSEEK_BOOTED__` 之后，心跳早已 `clearInterval` —— 用户进得去首屏，点进对应功能页才是一块空白，守卫**不会**再报任何提示。
2. **它探测的 API 清单不覆盖真实门槛**。`REQUIRED` 只到 Chromium 64 级别的 API，故意不含 `Object.hasOwn` / `.at` / `structuredClone`（避免 83 误报）。代价是：`Intl.DisplayNames`（81）这种「语法过了但 API 炸」的情况不会被点名，用户只会看到泛泛的「启动任务异常」或 12 秒超时。
3. **提示与 UI 可能同时出现**。守卫用 `hidden === false` 去重，但不判断「业务是否已经正常渲染」，极端情况下可能在可用界面上叠一条失败提示。静态上看不出概率，这条只能真机确认。

## 6. 和现有 `check:legacy` 的差别

`pnpm run check:legacy`（`scripts/check-bundle-syntax.mjs`）在同一份 dist 上的输出：

```
JS 文件 88 个；词法层违规 0 个；AST 层违规 0 个（acorn 8.19.0, ecmaVersion 2022 + 禁用项断言）
dvh 声明 14 处；带 vh 回退 14 处；问题 0 个
运行时 API：命中 Chrome 83 缺的内置 API 64 处（13 个文件/API 组合）；违规 0 个；polyfill 标记 已打进产物，入口脚本命中 1/1
结论：合格
```

两边不矛盾，但**结论粒度差一档**：

| 维度 | `check:legacy` | 本矩阵 |
| --- | --- | --- |
| 解析口径 | 单次 `ecmaVersion: 2022`，只看「能不能解析 + 有没有禁用项」 | 从 ES5 爬到 2022，记录**最低**能过的版本和首个卡点 |
| 门槛结论 | `合格`（对 2022 而言确实合格） | 真实语法门槛 **Chromium 80**，79 直接白屏 |
| API 口径 | 只看「83 缺的 API 有没有 polyfill」 | 15 个 API × 4 档逐档归类（baseline / polyfilled / guarded / **unprotected**） |
| API 命中完整性 | `stripLiterals()` 过度剥离，会漏 | AST 骨架，不漏（13 → 17 个组合） |
| CSS | 只查 `dvh` 有没有 vh 回退 | 11 个特性 × 最低版本 × 回退状态（`:has()`/`@container`/flex `gap`/`:is()`/`:focus-visible`/`color-mix`/`inset`…） |
| 未覆盖项 | `Intl.Segmenter`、`Intl.DisplayNames`、`WeakRef`、`IntersectionObserver`、`requestIdleCallback`、`showOpenFilePicker`、flex `gap`、`:has()`、`@container` | 除 `Intl.*` 的冷门成员外全覆盖 |

一句话：`check:legacy` 回答「按我们声明的 83 基线，产物合不合格」（答：合格），本矩阵回答「从 79 到 109，每一档具体怎么坏」（答：79 白屏、83 掉 CSS、91 掉 `:has`、109 干净）。**两者都要跑**：前者是回归闸门，后者是版本画像。

## 7. 产物

| 文件 | 内容 |
| --- | --- |
| `scripts/compat/matrix-scan.mjs` | 扫描器（语法 / API / CSS / 四档结论，`--json` 出机器可读） |
| `docs/compat/matrix/es-floor.json` | 88 个文件 → 最低 ES 版本 + 首个卡点 + 逐特性证据；API/CSS/四档结论 |
| `docs/compat/matrix/api-risk.md` | 裸调用风险清单（含最危险的三个） |
| `docs/compat/matrix/README.md` | 本文 |

## 8. 未测边界（别把这些当已验证）

- **没有任何一档在真机/模拟器上跑过。** 79/83/91/109 的判定全部来自静态推断；「白屏」= 解析必然失败，「不白屏」= 解析必然成功 + API/ CSS 有降级说明。真实表现还要看内核补丁、厂商魔改（尤其中低端 Android 的 WebView 会被降级/替换）。
- **WebView 版本 ↔ Chromium 版本按 Android 系统镜像推定**（Android 11 = Chromium 83），厂商可自带别的版本，`79 / 91 / 109` 是按 Chromium 号取的档位，不是 Android 版本号。
- **API 探针只看「调用点 + 邻近特征探测」**，是启发式：真实执行路径、条件分支、时序都看不到。`naked-guarded` 不代表逻辑一定对（例如 `Intl.Segmenter` 存在但 `segment()` 行为差异），只是「不会因不存在而抛 ReferenceError / TypeError」。
- **polyfill 覆盖率只按名字对**：`LEGACY_POLYFILLED` 是白名单，命中即认为可覆盖；polyfill 本身的实现质量、加载时序（是否早于首个调用点）没验证。
- **CSS 只扫了主 CSS + 1 个异步 CSS**，组件内联样式、`style` 属性里拼的字符串、CSS-in-JS 运行时产出的规则不在扫描范围。
- **`acorn token/AST` 精度边界**：`ecmaVersion: 2022` 是上限，2023+ 语法（`Array.prototype.toSorted` 之类是 API 不是语法；但 `using`、装饰器这类真语法）会被判解析失败，报错位置会误导。
- **守卫链的结论是读代码 + 读规范得出的**，没在 79 内核上实测「error 事件到底有没有触发、`event.message` 有没有内容」。第 5 节第 3 条那个「提示叠在可用 UI 上」的情形尤其需要真机确认。
