# #386 输入框上方「回到底部」按钮 —— 验收截图

**这是浏览器视口截图（Playwright Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
pnpm build:internal                                                    # 先出 dist/
node scripts/shot-mobile.mjs --page=scroll-to-bottom --viewport=390,360
```

会话 fixture 是本地写入 IndexedDB 的 26 轮长对话（`makeLongSession()`，与 #106 回顶场景同一份），
量到的数字在 `390/metrics.json`、`360/metrics.json`。

## 场景与判据

| 步 | 做了什么 | 判据 |
| --- | --- | --- |
| ① | 打开长会话（自动贴底） | `button === null`：**首次进会话不显示按钮** |
| ② | 上翻 1200px | 按钮出现；`clearsComposer === true`（按钮下沿 ≤ 输入框上沿，不遮输入框与发送按钮） |
| ③ | 真的发一条消息，上游被 `page.route` 压 4 秒（`streaming` 这段窗口是真的），期间上翻 900px | 位置**不被拽回底部**；按钮补出圆点，`aria-label = 回到底部（有新内容）` |
| ④ | 点击按钮（本场景浏览器上下文默认 `reducedMotion: reduce`） | `distance === 0`、按钮自己收起来 |
| ⑤ | `emulateMedia({ reducedMotion: 'no-preference' })` 后上翻再点 | 按钮 `animation-name` 是 `ds-scroll-to-bottom-in*`（淡入）；`scrollTop` 逐帧增长＝平滑滚动 |
| ⑥ | `body[data-ds-dark-theme]` 打上（与 App 内主题开关同一属性） | 深色下按钮是 `rgb(67,69,74)` 的浮起圆 + 描边，仍可辨认 |

③ 的「内容长高」是 **DOM 注入 200px 空白**模拟「新 token 到达」，不伪造回复文案；`streaming` 这个状态本身是真的
（`停止生成` 按钮在测，mock 上游只把响应延后 4 秒、正文是一句说明）。这一点在 PR 正文里也写明了。

## 文件

| 文件 | 内容 |
| --- | --- |
| `390/scroll-to-bottom-01-at-bottom-no-button-390.png` | 贴底：没有按钮 |
| `390/scroll-to-bottom-02-scrolled-up-button-390.png` | 上翻 1200px：按钮浮现（无圆点） |
| `390/scroll-to-bottom-03-new-content-dot-in-stream-390.png` | 流式中上翻 + 内容长高：按钮带「有新内容」圆点，位置没被拽走 |
| `390/scroll-to-bottom-04-after-click-bottom-390.png` | 点击后回到底部，按钮消失 |
| `390/scroll-to-bottom-05-button-fade-in-390.png` | 正常动效档：按钮带淡入动画（`animation-name` 已量） |
| `390/scroll-to-bottom-06-after-smooth-bottom-390.png` | 平滑滚动结束后停在最新消息 |
| `390/scroll-to-bottom-07-dark-theme-button-390.png` | 深色主题下的按钮 |
| `360/…-360.png` | 同上七张，360 × 740 档 |

## 量到的数字

| 项 | 390 | 360 |
| --- | --- | --- |
| 按钮视觉直径 | 34 × 34 | 34 × 34 |
| 命中区（`::after` 外扩 5px/边） | 44 × 44 | 44 × 44 |
| 按钮下沿 / 输入框上沿 | 700 / 711（不遮挡） | 596 / 607（不遮挡） |
| 上翻 1200px 后 `distance` | 1155px（> 200 阈值） | 1200px |
| 流式期间内容长高 200px 后 `scrollTop` | 5865 → 5865（**没被拽回**） | 5928 → 5928 |
| reduced-motion 档点击后的 `scrollTop` 采样 | 一步到位（5 个采样同一个值） | 同 |
| 正常动效档点击后的 `scrollTop` 采样 | `5452 → 5454 → 5462 → 5476 → 5499 → 5535 → 5588 → 5668 → 5787 → 5944`（逐帧增长） | `5554 → … → 6200` 同形 |
| 深色主题按钮底色 | `rgb(67,69,74)` | 同 |
| console error | 0 | 0 |

## 观察 / 未测边界

- 阈值 200px（`TO_BOTTOM_THRESHOLD`）比「跟随底部」的 40px（`STICKY_THRESHOLD`）大得多：刚离开一两行时按钮不弹，
  免得挡正文；40~200px 这段用户自己还在看最后几条，也还不需要按钮。
- 点按钮时的平滑滚动**不会被流式追加掐断**：列表在平滑动画进行中不写 `scrollTop`（`jumpRef`），
  内容若在这期间长高就朝新底部再发起一次，落点始终是最新消息。
- 未测：真机触摸（本机无 adb / 模拟器，按规范不虚报）；WebView 83 真机上的 `scrollTo` options 降级
  （代码里是 `'scrollBehavior' in el.style` 特性检测 + `try/catch` 双兜底，静态可查、真机未验证）；
  200 条以上会话（fixture 是 26 轮 52 条，滚动距离 6913px，够翻好几屏但没到 200 条）。
