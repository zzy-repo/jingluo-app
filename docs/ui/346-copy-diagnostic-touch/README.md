# #346 错误提示条「复制诊断信息」命中区 22px → 44px

关单证据。**不是真机截图**：Playwright Chromium（headless）浏览器视口，
`deviceScaleFactor=2` + `isMobile` + `hasTouch` + `locale=zh-CN`，390×844 与 360×740 两档。

## 结论

| 视口 | 改前命中区 | 改后命中区 | 提示条高度 | 横向溢出（页面 / 提示条） |
| --- | --- | --- | --- | --- |
| 390×844 | **84 × 22** | **92 × 44** | 88 → 110 | 无 / 无 |
| 360×740 | **84 × 22** | **92 × 44** | 88 → 110 | 无 / 无 |

- 命中区 = `button.getBoundingClientRect()`（按钮元素本身就是可点区域，没有外层拦截）。
- 文字位置**没有移动**：改后标签的文本行仍是 `571~590`（390 档），与改前一致 ——
  `min-height: 44px` 撑出来的是**行盒下方**那 22px，标签继续贴在同一行基线上。
- 提示条整体高 22px（88 → 110），换行数不变（4 行文字 + 1 行按钮），两档都不横向溢出。
- 同一行下方 12px 才是「复制 / 重新生成」图标按钮（`626~654`），没有命中区重叠：
  按钮盒子 `570~614`，相邻按钮 `626` 起 —— 不会出现「点复制落到下一个按钮」。
- 改动只落在 `src/components/messages/AssistantMessage.module.css: .noticeAction`
  （同一串动作「改 Key / 去充值 / 复制诊断信息」共用这个类，因此三个动作一起补齐）。

## 复现方式（两档一次跑完）

```bash
# 测法：scripts/shot-mobile.mjs 的 chat-error-324 场景（注入一条 HTTP 451 未识别失败）
INTERNAL_BUILD=1 DIST_OUT=dist node scripts/build.mjs
node scripts/shot-mobile.mjs --page=chat-error-324 --viewport=390,360
```

`before/` 是 `origin/main@` 上同一场景、同一脚本的产物；`after/` 是本次改动后的产物。
两边的 `metrics.json` 里都有 `copyButtonHit` 一行（`width` / `height` / `minHeight` / `touchAction`），
数字就是上表的来源。

## 目录

```
before/390/  改前 390 档截图 + metrics.json（copyButtonHit = 84×22）
before/360/  改前 360 档截图 + metrics.json（copyButtonHit = 84×22）
after/390/   改后 390 档截图 + metrics.json（copyButtonHit = 92×44）
after/360/   改后 360 档截图 + metrics.json（copyButtonHit = 92×44）
```

只留「未识别档（带状态码 + 复制诊断信息按钮）」这一帧：01（模型不可用，本来就没有该按钮）、
03（点击后的 toast，属 #324 的证据）与本单无关，按 `docs/ui/README.md` 的过程帧口径删掉。

## 未测边界

- 真机 / Android WebView：未测，结论只对上述浏览器视口成立。
- 桌面宽度（>420px）：未截图；同一份 CSS，命中区同样是 92×44。
