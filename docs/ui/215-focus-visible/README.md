# #215 `:focus-visible` 焦点环截图（390 / 360）

## 结论

13 处 `:focus-visible` 全部补成「`:focus` 兜底 + `:focus:not(:focus-visible)` 收回 + `:focus-visible` 键盘态」之后：

1. **键盘走到控件上有环** —— 侧边栏「设置」按钮（`box-shadow` 环，`Sider.module.css` 的 `.settings`）、设置页「数据管理」标签（`Settings.module.css` 里 `box-shadow` 环的规则）；
2. **鼠标点同一个控件不出环** —— 现代内核仍按 `:focus-visible` 判定，`:focus:not(:focus-visible)` 把环收回，`box-shadow: none`、`outline-style: none`，`el.matches(':focus-visible') === false`。

第 2 条就是 issue 里「高内核上鼠标点击按钮不应出现焦点环」的回归项：如果只写「`:focus` + `:focus-visible`」两段复制，鼠标点一下就会出环，本目录就是它的对照证据。

## 截图

| 文件 | 内容 |
| --- | --- |
| `390/focus-215-01-键盘-侧边栏设置按钮-390.png` | 键盘 Tab 到侧边栏「设置」按钮，整屏 |
| `390/focus-215-02-键盘-侧边栏设置按钮-特写-390.png` | 同上，环的特写 |
| `390/focus-215-03-鼠标点击-数据管理标签-无焦点环-390.png` | 鼠标点「数据管理」标签：无环 |
| `390/focus-215-04-键盘-数据管理标签-焦点环-390.png` | Tab/Shift+Tab 回到同一个标签：有环 |
| `390/focus-215-05-键盘-数据管理标签-特写-390.png` | 同上，环的特写 |
| `360/…` | 与 390 同名的 5 张，360×740 |

## 量数（`metrics.json` 原文摘录，390×844 一档）

```json
"sidebarSettings.keyboard": {
  "tag": "button", "text": "设置",
  "outline": "none 3px rgb(0, 0, 0)", "boxShadow": "rgb(57, 100, 254) 0px 0px 0px 2px inset",
  "ringVisible": true, "focusVisible": true, "isActive": true
},
"settingsDataTab.mouse": {
  "tag": "button", "text": "数据管理",
  "outline": "none 3px rgb(15, 17, 21)", "boxShadow": "none",
  "ringVisible": false, "focusVisible": false, "isActive": true
},
"settingsDataTab.keyboard": {
  "tag": "button", "text": "数据管理",
  "outline": "none 3px rgb(15, 17, 21)", "boxShadow": "rgb(57, 100, 254) 0px 0px 0px 2px",
  "ringVisible": true, "focusVisible": true, "isActive": true
},
"consoleErrors": []
```

360×740 一档的三组量数与本档逐字段相同。

## 复现

```bash
pnpm run build:internal
pnpm run shot:mobile -- --page=focus-215 --viewport=390,360 --out=docs/ui/215-focus-visible
```

场景定义在 `scripts/shot-mobile.mjs` 的 `PAGES['focus-215']`：先用 Tab 走焦点（保证是键盘语义），再用鼠标点同一个控件，两次都读 `getComputedStyle` 的 `outline*` / `box-shadow` 与 `el.matches(':focus-visible')`。

## 未测边界

- **不是 WebView 83 实机**。截图内核为 **Chromium 156.0.8078.4（Playwright 桌面 Chromium，非 WebView 实机）**。它只能证明「现代内核渲染没被这次改动影响、鼠标点击不出环」，**不能**证明 Chromium 83 上的兜底环真的出现——那一侧由静态断言（`pnpm run check:focus` + `tests/unit/focus-visible-fallback.test.mjs`）保证规则形态，最终仍需 WebView 83 真机确认。
- 未在 Android 真机 / WebView 83 上跑过，也未做 TalkBack 等读屏实测。
- 只抽了 2 个代表站点（`box-shadow` 环与 `outline` 环各一）。另外 11 处形态相同，静态断言覆盖，逐处截图未做。
- 若系统/浏览器默认焦点环未被项目 CSS 的 `outline` 规则覆盖，83 上焦点可能本就可见；本次修复不依赖这个假设。
