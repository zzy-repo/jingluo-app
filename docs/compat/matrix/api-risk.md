# 裸 API 调用风险清单

数据源：`node scripts/compat/matrix-scan.mjs --json docs/compat/matrix/es-floor.json` 的 `api[]` 字段。
口径：**调用点**（不是定义）+ **AST 代码骨架**（字符串/正则/模板/注释内容已抹除），四档（79 / 83 / 91 / 109）逐档归类。
`polyfilled` 依据 `src/polyfills/legacy.ts` 的白名单 + 入口是否带 `__DEEPSEEK_LEGACY_POLYFILL__`（实测命中 1/1）。

全部为**静态推断，非运行时验证**。

## 分类含义

| 归类 | 含义 | 这一档会不会炸 |
| --- | --- | --- |
| `baseline` | 该版本内核自带 | 不会 |
| `polyfilled` | 有 polyfill 且已打进入口 | 不会（前提：polyfill 先于调用点执行） |
| `polyfill-not-in-entry` | 声明了 polyfill 但入口没打进 | 会（打包配置回归） |
| `naked-guarded` | 裸调用，但紧邻有特性探测（`typeof` / 存在性三元 / `??` / `?.` / `try-catch`） | 不会抛 ReferenceError，但**分支语义差异看不到** |
| `naked-unprotected` | 裸调用、无任何探测 | **会直接抛异常** |

## 最危险的三个

### ① `Intl.DisplayNames` —— 唯一一个真·裸调用（Chromium 81）

```
文件  static/js/main.73ca8f5e.js
位置  5:44107（入口顶层，模块求值期就执行）
处数  2
探测  无
归类  @79 naked-unprotected，@83 起 baseline
```

调用形态（顶层一次性构造，没有任何守卫）：

```js
o = {
  'zh-CN': new Intl.DisplayNames(['zh-CN'], { type: 'region' }),
  'en-US': new Intl.DisplayNames(['en-US'], { type: 'region' }),
}
```

为什么最危险：

- **位置最靠前**：它在入口的模块级初始化里，不是某个懒加载路径。Chromium < 81 上 `Intl.DisplayNames` 是 `undefined`，`new undefined(...)` 立刻 `TypeError`，入口整体求值失败。
- **它把这份产物的真实下限从 80 抬到了 81**：语法层算出 80（`??`），这一条把 API 门槛顶到 81。也就是说 WebView 80 是「语法也不够 + API 也不够」，79 是双重失败。
- **守卫探测不到它**：`src/index.html` 的 `REQUIRED` 清单里没有 `Intl.DisplayNames`，所以用户看到的会是泛泛的「启动任务异常」/「12 秒内没有启动」，指不到真因。
- **`.split(" "))` 那个地区码表**在同一处：说明这是「给地区名做本地化显示」的基建，改动面比一行大。

最小修法（任选）：`typeof Intl.DisplayNames === 'function'` 能力探测 + 退回用地区码字符串；或把这两个实例改成惰性构造（首次渲染地区名时再建）。

### ② `String.prototype.replaceAll` —— 覆盖面最广，靠 polyfill 单点兜（Chromium 85）

```
文件  static/js/async/1864.addc7b85.js, 2036.14b91ac0.js, main.73ca8f5e.js, 及另 1 个
位置  首个 main.73ca8f5e.js（共 37 处 / 4 个文件）
处数  37
探测  —
归类  @79/@83 polyfilled，@91 起 baseline
```

这 37 处全部指向 `replaceAll`，是**整个产物里最大的单一 API 暴露面**。它在 83 上能跑，完全依赖 `src/polyfills/legacy.ts` 把 `String.prototype.replaceAll` 补上、并且 polyfill 先于首个调用点执行。

需要盯的原因：

- **`replaceAll` 接收正则**（`replaceAll(/x/g, ...)`）时，polyfill 若用 `split/join` 实现会**静默改变语义**；字符串路径没问题，正则路径要单独验。
- **四个文件里三个是异步 chunk**：chunk 的加载顺序晚于入口，polyfill 一般没问题；但如果哪天有人把某个 chunk 改成 `<script>` 直接加载、绕过入口，就会有一个「无 polyfill 的运行时」。
- **它是唯一一个「85 才 baseline」的 polyfill 项**，也就是 83 档最关键的那一条。回归成本最低、后果最直接。

### ③ `WeakRef` + `Intl.Segmenter` —— 有探测，但语义未验（Chromium 84 / 87）

```
WeakRef          static/js/main.73ca8f5e.js      1:222492   2 处  探测 nullish-compare
Intl.Segmenter   static/js/async/1864.addc7b85.js 60:6794   2 处  探测 existence-ternary
```

两处都是「有探测的裸调用」，不会抛异常，但都在**行为差异**上留了口子：

```js
// WeakRef：typeof 存在性 + instanceof 双条件
'u' > typeof WeakRef && e instanceof WeakRef

// Intl.Segmenter：存在性三元，退化路径是逐个字符切
Intl.Segmenter ? [...new Intl.Segmenter().segment(t)] : [...t]
```

- `WeakRef` 在 79/83 上探测为假 → 走弱引用降级路径。降级路径是否等价（会不会因此泄漏缓存 / 命中不了缓存）静态看不出来。
- `Intl.Segmenter` 的退化路径 `[...t]` 是**按码点切**，不是按字素簇切 —— emoji（ZWJ 家族、肤色修饰）与天城文这类组合字符会被切碎。`Glossary` / markdown 分词在 79/83 上会出现「emoji 被拆成两个方块」这类可见问题。这条是**功能差异**，不是崩溃，但它就藏在 87 这条线的下面。

## 完整清单（17 组，按最低 Chromium 降序）

| API | 最低 Chromium | 处 | 文件 | 位置 | 探测 | @79 | @83 | @91 | @109 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `structuredClone` | 98 | 9 | 5 | — | 多文件 | polyfilled | polyfilled | polyfilled | baseline |
| `Object.hasOwn` | 93 | 20 | 2 | — | — | polyfilled | polyfilled | polyfilled | baseline |
| `Array/String.prototype.at` | 92 | 28 | 3 | — | — | polyfilled | polyfilled | polyfilled | baseline |
| `crypto.randomUUID` | 92 | 4 | 1 | — | — | polyfilled | polyfilled | polyfilled | baseline |
| `Intl.Segmenter` | 87 | 2 | 1 | `async/1864`:60:6794 | 存在性三元 | naked-guarded | naked-guarded | baseline | baseline |
| `String.prototype.replaceAll` | 85 | 37 | 4 | `main`:— 等 | — | polyfilled | polyfilled | baseline | baseline |
| `WeakRef` | 84 | 2 | 1 | `main`:1:222492 | `??` 比较 | naked-guarded | naked-guarded | baseline | baseline |
| `Intl.DisplayNames` | **81** | 2 | 1 | `main`:5:44107 | **无** | **naked-unprotected** | baseline | baseline | baseline |
| `Promise.allSettled` | 76 | 2 | 2 | `async/1864`:152:15002、`main`:1:253458 | — | baseline | baseline | baseline | baseline |
| `Object.fromEntries` | 73 | 12 | 4 | `main`:1:235175 等 | — | baseline | baseline | baseline | baseline |
| `AbortController` | 66 | 13 | 1 | `main`:1:235332 | — | baseline | baseline | baseline | baseline |
| `navigator.clipboard` | 66 | 2 | 1 | `main`:2:72254 | `??` + `try-catch` | baseline | baseline | baseline | baseline |
| `ResizeObserver` | 64 | 6 | 2 | `main`:1:309307、`async/3909`:1:282998 | 后者有存在性探测 | baseline | baseline | baseline | baseline |
| `fetch()` | 42 | 7 | 2 | `main`:1:6814、`async/535`:1:250332 | 后者有 `??` 比较 | baseline | baseline | baseline | baseline |
| `TextDecoder` | 38 | 8 | 3 | `main`:1:12735 等 | 其一 `try-catch` | baseline | baseline | baseline | baseline |

## 查了但本产物 0 处

`??=` / `||=` / `&&=`（Chromium 85）、`static {}`（94）、`IntersectionObserver`（51）、`requestIdleCallback`（47）、`showOpenFilePicker`（86）、`Intl.RelativeTimeFormat`（71）、`AbortSignal.timeout`（103）、`Array.prototype.findLast`（97）。

其中 `showOpenFilePicker` / `AbortSignal.timeout` 是「Android WebView 上长期不存在」的典型，将来引入时要当硬门槛处理。

## 与 `check:legacy` 的差异（重要）

`check:legacy` 报「命中 Chrome 83 缺的内置 API 64 处（13 个文件/API 组合）；违规 0 个」——**本清单是 17 组、更多命中**。差别来自口径：

- `check:legacy` 用 `stripLiterals()`（手写状态机）抹字面量，正则密集的压缩 chunk 上会成片误吞真实代码：`async/1864.addc7b85.js` 单文件 82 段、最长 **53 016 字符**被当字面量吃掉，`Intl.Segmenter`、部分 `Object.fromEntries` / `Promise.allSettled` 因此漏报。
- 本扫描器改用 acorn AST 生成代码骨架，同一份产物多出 4 个组合，并首次点名 `Intl.DisplayNames`。
- `check:legacy` 的判定基准是「83 基线 + polyfill 白名单」，`Intl.DisplayNames`（81）**低于** 83、又不在它的探测范围内，所以被它完全跳过；按它的口径产物「合格」，按版本矩阵的口径产物在 80 上炸。

结论：两边都要跑。`check:legacy` 是 83 基线回归闸门，本清单是 79→109 的版本画像。
