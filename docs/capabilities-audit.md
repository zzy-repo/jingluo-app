# 能力假设盘点 · 总索引（#209）

> 基线：Android 11 WebView = **Chromium 83**（`BASELINE_CHROME = 83`，`browserslist: chrome >= 83`）。
> 本文件是 #209「**能力探测替代一切假设**」的入口：四类假设各有一份盘点文档、一个纯判定模块、一条闸门命令；
> 这里只回答四件事 —— **去哪儿看**、**现在多少**、**怎么跑**、**文档与实测差在哪儿**。

## 一、四类盘点 → 四份文档 → 四个判定模块

| # | 类别 | 问的是什么 | 判定模块（纯函数） | 文档 | 实测命中（2026-11-19） |
| --- | --- | --- | --- | --- | --- |
| 1 | JS 内置 API / 语言特性 | 「这个 API 在 Chromium 83 上存在吗？」 | `scripts/lib/apiAssumptionAudit.mjs` | [`docs/capabilities/api.md`](capabilities/api.md) | **51**（31 入口 polyfill / 20 基线内 / 0 裸调用） |
| 2 | CSS 特性 / `@supports` | 「这条 CSS 在 83 上会被整条丢弃吗？丢了还剩什么？」 | `scripts/lib/cssAssumptionAudit.mjs` | [`docs/capabilities/css.md`](capabilities/css.md) | **306**（已有兜底 250 / 无风险 37 / 可接受降级 1 / 真实缺陷 18） |
| 3 | 平台与宿主能力 | 「WebView 里到底有没有这个宿主能力（不是版本问题）？」 | `scripts/lib/hostCapabilityAudit.mjs` | [`docs/capabilities/host.md`](capabilities/host.md) | **114**（已有兜底 68 / 无风险 35 / 真实漏洞 3 / 需动态验证 8） |
| 4 | 行为 / 布局假设 | 「这条布局假设在真机视口上真的成立吗？」 | `scripts/lib/behaviorAssumptionAudit.mjs` | [`docs/capabilities/behavior.md`](capabilities/behavior.md) | **4 条假设**（成立 4 / 不成立 0 / 未测 0） |

三层结构沿用 #198 的约定，四类完全一致：

```
scripts/lib/*AssumptionAudit.mjs   纯判定：吃 [{path, text}]，吐 hits + summary，不碰文件系统、不打印
scripts/check-capabilities.mjs     只做遍历 + 汇总 + 打印（本文件第二节）
tests/unit/*.test.mjs              钉住判定：每条规则至少一个正例、一个反例
```

**「缺陷」的口径只在这里定义一次**（`scripts/check-capabilities.mjs` 的注释里也抄了一份）：

| 类别 | 算缺陷的判定 | 不算缺陷的判定 |
| --- | --- | --- |
| 1 | `uncovered`（裸调用、无入口 polyfill） | `baseline`、`entry-polyfill` |
| 2 | `defect`、`false-positive`（探测说支持、实际不生效） | `covered`、`no-risk`、`degraded` |
| 3 | `真实漏洞` | `已有兜底`、`无风险`；`需动态验证` **单独列出**，不计缺陷 |
| 4 | `不成立`（实测证伪） | `成立`、`未测` |

## 二、怎么跑

```bash
pnpm run check:capabilities              # 默认 warn 级：只登记，有缺陷也 exit 0
pnpm run check:capabilities -- --strict   # 有缺陷就 exit 1（本次不接 CI）
node scripts/check-capabilities.mjs --json   # 机器可读报告（PR 里的数字全从这儿抄）
node scripts/check-capabilities.mjs --help
```

| 退出码 | 含义 |
| --- | --- |
| `0` | 跑完了（warn 级，有缺陷也是 0） |
| `1` | 只有 `--strict` 且确实有缺陷 |
| `2` | 用法 / 环境错误：未知参数、`src/` 下一个文件都没扫到 |

`--root` / `--behavior-dir` 只为测试注入 fixture（默认分别指向仓库根和 `docs/ui/209-behavior`）。

**为什么是 warn 级**：#209 拆出去的修复 lane（#210 #211 #214 #215 …）在并行改 `src/**`，此刻做硬拦截会让每条
lane 的 PR 都替别人还没修完的缺陷变红、互相卡死；而缺陷清单本身就是它们的工作输入，「红」不传递新信息。
所有 lane 落地后再把 `--strict` 接进 CI（届时只改 `.github/workflows/**` 一行，判定逻辑不动）。

### 本期原文输出（2026-11-19，`4870b33`）

```
扫描范围：src/** 共 238 个文件（.ts 138 / .tsx 54 / .css 44 / .html 1 / .md 1）
  类别 1 / 2 口径：全部 238 个（CSS、Markdown 对 API 判定整篇抹空）
  类别 3 口径：.ts/.tsx/.js/.mjs/.cjs/.jsx/.html 共 193 个（与 docs/capabilities/host.md 同源）
  类别 4 口径：docs/ui/209-behavior/*.json 的 3 份测量快照（宽度 360 / 390 / 412）

类别 1  JS 内置 API / 语言特性  命中 51   缺陷 0（uncovered 裸调用无兜底）       → docs/capabilities/api.md
类别 2  CSS 特性 / @supports    命中 306  缺陷 18（真实缺陷 18 + 探测假阳性 0）  → docs/capabilities/css.md
类别 3  平台与宿主能力          命中 114  缺陷 3（真实漏洞；另有需动态验证 8）   → docs/capabilities/host.md
类别 4  行为 / 布局假设         命中 4    缺陷 0（成立 4 / 不成立 0 / 未测 0）   → docs/capabilities/behavior.md

总命中 475（静态 471 + 行为 4 条假设结论）
各类缺陷数：api 0 / css 18 / host 3 / behavior 0 —— 合计 21
```

`⚠ 21 处能力假设缺陷（warn 级：不拦截。6 条修复 lane 在飞，硬拦截会互相卡死；接 CI 时改用 --strict）。`

21 处缺陷的去向：

| 类别 | 数量 | 内容 | 归属 |
| --- | --- | --- | --- |
| css | 13 | `:focus-visible` 无 `:focus` 回退（Button / IconButton / Select / VoiceButton / markdown.css / MobileHeader / Welcome / OursServices / Settings ×3 / Sider） | #215（进行中） |
| css | 1 + 1 | `@container` + `container-type`（`MessageFile.module.css`） | #214（进行中） |
| css | 3 | `scrollbar-gutter`（`MessageList.module.css:13,18,33`）—— **疑似假阳性**，见第七节 | #216（已关闭），判定待补 |
| host | 3 | `fetch` 页面级拦截 ×2（`collector.ts:981`、`capabilities.ts:256`）、`fetch` 响应体 clone ×1（`collector.ts:851`） | #210 / #211（进行中） |

## 三、拆单与状态

状态每次用 `gh issue view <n> --json state,title` 现读，**不要抄这张表**（下表是 2026-11-19 的快照）。

| Issue | 类别 | 事项 | 状态 |
| --- | --- | --- | --- |
| [#210](https://github.com/zzy-repo/deepseek-app/issues/210) | 3 | 诊断采集层无条件替换 `window.fetch`，CapacitorHttp 接管后采集与流式同时失真 | OPEN |
| [#211](https://github.com/zzy-repo/deepseek-app/issues/211) | 3 | `readBytesOf` 靠 `Number('') === 0` 巧合避开 `clone().text()`，bytes 恒为 0 且兜底分支阻塞流式响应 | OPEN |
| [#213](https://github.com/zzy-repo/deepseek-app/issues/213) | 2 | `:has()` 16 处无兜底（实测已 0 处） | CLOSED |
| [#214](https://github.com/zzy-repo/deepseek-app/issues/214) | 2 | `MessageFile` 用 `@container` + `container-type` 按宽度隐藏失败原因，83 上整块丢弃 | OPEN |
| [#215](https://github.com/zzy-repo/deepseek-app/issues/215) | 2 | `:focus-visible` 13 处没有 `:focus` 回退，键盘焦点环完全不可见 | OPEN |
| [#216](https://github.com/zzy-repo/deepseek-app/issues/216) | 2 | `MessageList` 依赖 `scrollbar-gutter` 稳定滚动条槽，83 不支持导致横向跳动 | CLOSED（`check:gutter` 缺兜底 0） |
| [#217](https://github.com/zzy-repo/deepseek-app/issues/217) | 2 | flex `gap` 兜底守卫有盲区：非 module 的 `markdown.css`、`flex-wrap` 容器不在 `check:gap` 范围 | CLOSED（口径已统一为 44 / 37 / 111 / 3） |
| [#218](https://github.com/zzy-repo/deepseek-app/issues/218) | 2 | `findScrollableAncestor` 把「声明了 `overflow:auto`」当成「能滚」，只读声明值无实测回读 | CLOSED |
| [#219](https://github.com/zzy-repo/deepseek-app/issues/219) | 1 | `src/index.html` 启动守卫假设 `Intl.DisplayNames` 必须存在，缺失时启动被拦死 | CLOSED |
| [#220](https://github.com/zzy-repo/deepseek-app/issues/220) | 1 | 诊断能力探测跑在入口 polyfill 之后，`Object.hasOwn` / `toSorted` / `at` 探针恒为 `true` | CLOSED |
| [#221](https://github.com/zzy-repo/deepseek-app/issues/221) | 1 | `src/polyfills/legacy.ts` 注释假设原生 `String.prototype.at` 按 code point 取值（实测按码元） | CLOSED |

合计 11 条：**7 条 closed、4 条 open**（#210 #211 #214 #215）。

## 四、运行时探针：`src/utils/capabilities.ts`

静态审计只回答「代码里有没有这种假设」；真机 / 运行时才能回答「此刻到底有没有」。两件事互补，不要互相替代。

| 导出 | 用途 |
| --- | --- |
| `hasApi(path)` | 按点路径探 API 存在：`hasApi('Intl.DisplayNames')`；结果按会话缓存 |
| `cssSupports(property, value)` | `CSS.supports` 语义的薄封装（**只判解析**，不判布局生效 —— 见 `css.md` §6 的 flex `gap` 教训） |
| `verifyCss(property, value, options)` | 真生效探测：离屏建元素 + `getComputedStyle` 回读，`options.readback` 自定义判据（`VerifyCssOptions` / `CssReadback`） |
| `hasPlugin(name)` | Capacitor 插件是否注册（`registerPlugin` 一定返回代理对象，只有调用才知道在不在） |
| `isNative()` | 是否跑在 Capacitor 原生壳里（`Capacitor.isNativePlatform()`） |
| `isFetchPatched()` | `window.fetch` 是否已被页面级包装（#210 的判据） |
| `resetCapabilityCache()` | 清探测缓存 —— 只在「入口 polyfill 装完 / 插件热插拔」这类需要重测的时机调 |

```ts
import { hasPlugin, isFetchPatched, resetCapabilityCache, verifyCss } from '@/utils/capabilities'

if (hasPlugin('ExportText')) {
  // 插件在：走原生导出
} else {
  // 插件不在：走 JS 兜底，不要 try/catch 一个一定 reject 的调用
}

// 「支持 flex gap」不能只看 CSS.supports —— 它在 83 上会返回 true 但间距为 0
if (verifyCss('gap', '8px', { readback: (el) => /* 量到真实间距 */ true })) {
  // 真生效
}

// 入口 polyfill 装载之后想重测原生能力
resetCapabilityCache()
```

**规矩**：产品代码里凡是要按能力分支的地方，用这些探针；**不要再写 `typeof x === 'function'` 或 `window.foo !== undefined`**
（那正是 #220 的病根：探针跑在入口 polyfill 之后，问的已经不是内核）。

## 五、怎么新增一条盘点规则

先分类，别一上来就写代码：

1. **静态可判**（源码里出现某个 API / CSS 特性 / 宿主调用）→ 加进第二节对应的 `scripts/lib/*AssumptionAudit.mjs`。
2. **只有运行时能判**（值会变、要量布局）→ 加到 `src/utils/capabilities.ts` 的探针，并在对应文档里登记「需动态验证」。
3. **只有真机 / 模拟器能量**（视口、滚动、键盘）→ 走类别 4：`docs/ui/209-behavior/measure.mjs` 采集 JSON，交给 `behaviorAssumptionAudit.mjs` 判。

### 静态规则（以 API 为例）

```js
// scripts/lib/apiAssumptionAudit.mjs
export const API_RULES = [
  // ... 既有规则
  {
    id: 'structuredClone',
    api: 'structuredClone',
    firstSupported: 98,            // 首支持内核版本，低于 BASELINE_CHROME 才是「假设」
    pattern: /\bstructuredClone\s*\(/u,   // 命中即候选；字面量 / 注释已被 maskLiteralsAndComments 抹掉
  },
]
```

三件事必须一起做，缺一条这条规则就不可信：

1. **加单测**（`tests/unit/*-audit.test.mjs`）：一个正例（真命中）、一个反例（注释 / 字符串里的不算）、一个判定例（有兜底 → `entry-polyfill`，没兜底 → `uncovered`）。
2. **核对首支持版本**：从 MDN / caniuse 抄，别凭印象；版本号错了整条判定的方向就反了。
3. **跑一次 `pnpm run check:capabilities --json`**，看 `byVerdict` 与总命中怎么变，把新数字写进对应文档和本文件第一节的表。

CSS 特性同理（`CSS_FEATURES` 里加一条：`probe` 用真实字符串、`firstSupported`、`fallback` 判据），宿主能力加进 `CAPABILITY_RULES`
（注意 `forceVerdict` 只给「不是版本问题、是宿主不实现」的那类，例如 `fetch` 页面级拦截），行为假设加进 `ASSUMPTIONS` +
一个 `judge*` 函数（输入是测量 JSON，输出 `成立 / 不成立 / 未测`）。

**判定模块不许碰文件系统、不许 `console.log`** —— 一旦它自己去找文件，`--root` 注入的 fixture 就测不动，单测会退化成集成测试。

### 新增一类盘点（第 5 类）

1. 写 `scripts/lib/xxxAssumptionAudit.mjs`（导出 `auditXxx(files)` + `summarize`，形状与既有四份一致）；
2. 在 `scripts/check-capabilities.mjs` 里加一个 `categories.xxx`（含 `label` / `docs` / `hits` / `byVerdict` / `defects`），
   并把它纳入 `totals.staticHits`；
3. 在 `tests/unit/check-capabilities.test.mjs` 的 fixture 里加一处能命中的样本，钉住「三类审计各命中 1」变成「四类各命中 1」；
4. 补一份 `docs/capabilities/xxx.md`，回到本文件第一节的表里加一行。

## 六、未测边界（这套盘点的天花板）

- **静态审计只看得到静态写下的东西**：`Reflect.get(o, 'at')`、动态拼出来的特性名、构建期注入、第三方 chunk 都不在内。
- **首支持版本号来自公开表，不是逐条在 WebView 83 上实测**：真正落在 83 边缘的能力（`Intl.DisplayNames` 81、`inset` 87 …）
  只能标「需动态验证」。
- **类别 4 的测量是模拟器 + WebView 83.0.4103.106 的结果**（API30 x86_64，宽度 360 / 390 / 412），不等于真机，
  键盘弹出、系统字体缩放、折叠屏都不在内。
- **`@supports` 通过 ≠ 生效**：flex `gap`（#173）就是解析通过但间距为 0 的例子，判定层必须区分「解析」与「生效」。

## 七、快照漂移（文档写的 vs 本轮实测）

四份文档是**分头写的**，数字来自各自的采集时刻；`check:capabilities` 是**同一份源码、同一次遍历**算出来的。
下表逐条列出对不上的地方。**本轮只登记，不改别人的文档**（各自 lane 收尾时按此表更新）。

### 7.1 数字漂移

| 位置 | 文档写的 | 实测（`4870b33`） | 原因 |
| --- | --- | --- | --- |
| `api.md` 扫描范围 | 235 个文件（135 `.ts` / 54 `.tsx` / 44 `.css` / 1 `.html` / 1 `.md`） | **238** 个（**138** / 54 / 44 / 1 / 1） | 快照之后 `src/**` 新增 3 个 `.ts`（修复 lane 落地） |
| `api.md` 命中总数 | **52**（31 入口 polyfill + 21 基线内 + 0 uncovered） | **51**（31 + **20** + 0） | 只差 `Intl.DisplayNames`：文档 4 处 / 2 文件 → 实测 **3 处 / 1 文件**（#219 修掉了 `src/index.html` 那处启动守卫） |
| `css.md` 扫描范围 | 235 个文件（`.css` 44，其中 `*.module.css` 37） | **238** 个（`.css` 44 / `*.module.css` **37**） | 同 api.md：多了 3 个 `.ts`；CSS 侧数字一致 |
| `css.md` 命中 / 文件 | **320** 处 / **40** 个文件 | **306** 处 / **39** 个文件 | #218 修掉 1 处假阳性（`getComputedStyle` 回读）、#216 + #217 收掉 gap / gutter 若干处 |
| `css.md` 判定分布 | 320 / 已有兜底 246 / 无风险 37 / 可接受降级 1 / **真实缺陷 35** / 假阳性 1 | 306 / **250** / 37 / 1 / **18** / **0** | 真实缺陷从 35 降到 18；假阳性清零（#218） |
| `host.md` 扫描范围 | 190 个 `.ts/.tsx/.html` | **193** 个 | 同 api.md 的 3 个新增 `.ts` |
| `host.md` 命中总数 | **110**（已有兜底 69 / 无风险 33 / 真实漏洞 2 / 需动态验证 6） | **114**（**68** / **35** / **3** / **8**） | 新增命中来自判定库后来补的 `fetch` 规则（见 7.2） |
| `host.md` 真实漏洞清单 | `index.html:72`（#219）、`capabilityTruth.ts`（#220 已修）、`polyfills/legacy.ts:119-120`（#221） | **`collector.ts:851`、`collector.ts:981`、`capabilities.ts:256`** | 原 3 处已随 #219 #220 #221 修复消失；现存的 3 处是 `fetch` 相关（#210 / #211） |
| `behavior.md` 表 | 25 行（已有兜底 13 / 需动态验证 3 / 需探测 9 / 拆单 0） | 类别 4 只出 **4 条假设结论，全部成立** | 口径不同：文档 25 行是「UI 元素级」清单，CLI 是「4 条假设」的结论层 —— 两者都留着，别互相覆盖 |

`check:gap` 的数字**没有漂移**：`css.md` §2.6 写的「扫描 44 个 CSS 文件（其中 37 个 CSS Module）：已兜底 111 条，跳过 3 条」与实测逐字一致。

### 7.2 文档内部不闭合（同一份文档自己前后不一致）

| 位置 | 问题 |
| --- | --- |
| `css.md` 逐特性表 | **缺 `inset` 行**：实测 `inset` 16 处（全部已有兜底），表里没有，但合计行的 246 已把它算进去 |
| `css.md` 合计行 | 逐特性行相加 = **288**（加 `inset` 16 后 304），合计写 **320**；逐行「真实缺陷」相加 = **17**（13 `:focus-visible` + 2 `@container`/`container-type` + 2 `scrollbar-gutter`），合计写 **35** |
| `behavior.md` 末段 | 正文写「**26 行**里有 **8 行**『需探测』」，与自己的表（**25 行** / 需探测 **9** 行）不一致 |

### 7.3 已知误报（判定库没跟上修复，不是产品缺陷）

- **`scrollbar-gutter` 3 处**（`MessageList.module.css:13,18,33`）：判定库只认「同一条规则里有等价兜底」，而 #216/#232 的兜底是
  「`overflow-y: scroll` 常驻滚动条 + `@supports (scrollbar-gutter: …)` 收回到按需」——语义上等价，形状上不匹配。
  `pnpm run check:gutter` 对同一个文件报「**缺兜底 0 处**」。→ 追给类别 2 判定库的 follow-up，别当产品 bug 修。
- 同理，`:focus-visible` 的 13 处是真缺陷（#215 未落地），不是这类误报 —— 两者在清单里长得一样，靠「有没有对应门禁命令」区分。
