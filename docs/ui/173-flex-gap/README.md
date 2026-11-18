# issue #173：WebView 83 上 flex gap 失效导致间距丢失

## 现象

flex 容器上的 `gap` 是 Chromium **84** 才有的特性；API30 模拟器自带的 WebView 83.0.4103.106 会直接忽略它。
问题在于**任何能力探测都会给出"支持"**：

- `CSS.supports('gap', '12px')` → `true`
- `@supports (gap: 12px)` → 命中
- `getComputedStyle(el).gap` → `'12px'`

因为 grid 的 `gap` 从 Chromium 66 起就存在，83 上确实"认识"这个属性，只是 flex 布局里不生效。
所以按探测结果选分支的写法必然踩空：以为走了现代路径，实际间距是 0。

## 修复

1. `src/utils/flexGap.ts`：运行时**实测**，不做能力查询。离屏建一个 `display:flex; column-gap:8px` 的容器，
   放两个 10px 子元素，量第二个子元素的左边界减去第一个的右边界；量不到 8px 才给 `<html>` 打
   `data-flex-gap-fallback`。
2. 兜底样式全部由 `node scripts/gen-flex-gap-fallback.mjs`（`pnpm run gen:gap`）生成，文件里的
   `/* #173-fallback:start … */` 段不要手改。兜底**只写 margin**、绝不重复声明 gap，并且只在
   `:global(html[data-flex-gap-fallback])` 下生效——支持 gap 的内核上这个属性不会出现，
   所以"现代内核双份间距"在结构上就不可能发生。
3. 防回归（issue #173 第 4 项）：`scripts/lib/flexGapAudit.mjs` + `pnpm run check:gap`（`pnpm test` 里也跑一份），
   扫全仓库 `src/**`：出现 `CSS.supports(…gap…)` 或 `@supports (…gap:…)` 直接失败；
   每条 flex 容器上的非零 gap 必须有对应兜底，否则列出缺少的选择器并失败。

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `cdp.mjs` | adb forward + 页面级 CDP 工具（WebView 不支持 Playwright 的 `connectOverCDP`，只能连页面 DevTools socket） |
| `scan.mjs` | `node scan.mjs <tag> [宽度…]`：逐页先 reload 再量相邻子元素间距、并截图 |
| `*.json` | 每页每宽度的实测结果（容器数、实测为 0 的容器数、逐容器测量值） |
| `*.png` | 对应截图 |

## 实测结论

标签：**Android Emulator API30（x86_64，非真实手机）**，WebView 83.0.4103.106，viewport 390x795 / 360x728。

| 宽度 | 页面 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 390 | 聊天页 | 1 个声明 gap 的容器，1 个实测为 0 | 1 个，0 个为 0（`.functionRow` 0 → 8px） |
| 390 | 设置 → 通用 | 17 个容器，15 个为 0 | 17 个，0 个为 0 |
| 390 | 设置 → 数据 | 30 个容器，24 个为 0 | 30 个，0 个为 0 |
| 360 | 聊天页 | 1 / 1 | 1 / 0 |
| 360 | 设置 → 通用 | 17 / 14 | 17 / 0 |
| 360 | 设置 → 数据 | 30 / 24 | 30 / 0 |

代表性选择器（390）：`.functionRow` 0 → 8px、`.themeOptions` 0 → 12px、`.cellActions` 0 → 8px、
`.navItem` 0 → 8px、`.row` 0 → 8px、`.text` 0 → 4px。

回归（**Android Emulator API31（x86_64，非真实手机）**，WebView 91）：同一批 3 个页面 × 390 宽度共 48 个容器，
修复前后逐容器测量值完全一致（0 处差异），截图字节也完全一致——兜底在支持 gap 的内核上确实不生效。

## 未测边界

- WebView 75–82：手头没有这些版本的镜像，没测（理论上同样是"探测为真、布局为 0"，兜底会命中）。
- 真机：全部结论都来自模拟器，未在真实手机上验证。
- 只在 Android 上验证；iOS WKWebView 版本足够新，未单独跑。
