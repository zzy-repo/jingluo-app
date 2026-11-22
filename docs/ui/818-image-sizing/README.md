# #818 上传的大图「显示过大、没适配屏幕」—— 定位数据与改后取证

- 被测产物：本分支的 `src/`（`rspack serve` 开发服务器，端口 8105）
- 被测工具：Playwright **headless Chromium**，`deviceScaleFactor: 2` / `isMobile` / `hasTouch` / `locale: zh-CN`
- 被测图：现场生成的**真 PNG**，竖 3000×4000、横 4000×3000（长边 ≥ 4000px）
- 判据（票面口径）：**元素宽度 / 屏宽 > 0.8**，或出现横向溢出（`scrollWidth > clientWidth`）即判「过大」
- 口径声明：这是**浏览器视口**取证，**不是真机**，也没有在 WebView 83 内核上跑过（见第四节）

## 一、定位结论（改之前量出来的）

| 位置 | 390×844 | 360×740 | 判定 |
| --- | --- | --- | --- |
| ① 输入框草稿缩略图 | 64×64，屏宽 **16.4%**，行 `scrollWidth = clientWidth = 358` | 64×64，屏宽 **17.8%**，行 `328 = 328` | **不大**（无溢出、比例远低于 0.8）→ **本单不动** |
| ② 消息气泡里的图片（单图） | 120×120，屏宽 **30.8%** | 120×120，屏宽 **33.3%**，四图整行 **320px = 88.9% 屏宽** | **偏大且不自适应**：尺寸写死，四张图 2+2 两行占掉近九成屏宽 |
| ③ 点开大图 | `<a target="_blank">` → **新开页面**，文档宽 **3000px**、UI 宽 3000px，图 3000×4000 **未缩放** | 同上，文档宽 **3001px** vs 屏 360 → 要横向滚 8 屏才看得全 | **过大（最严重）**：既没有应用内预览层，也没做等比缩放 |

补充事实：

- 三处在两档视口下**都没有**触发 `document.scrollWidth > clientWidth`（页面本身不横滚）；
  判「过大」的是 ② 的整行比例（0.889 > 0.8）与 ③ 的**未缩放原件**。
- ②的 64px 档（图 + 文档混排，`UserMessage.module.css` 的 `.filesWithDocuments`）屏宽占比 16.4% / 17.8%，
  量下来没问题，未改动；#214 的 `--message-file-reason-display: none` 原样保留。
- 压缩侧（`services/attachments/imageSource.ts` 的 `targetSize` / `maxEdge`）**没有动**：长边 4000 → 1568
  一直在生效（`LIMITS.images.maxEdge`），显示尺寸与它无关。

## 二、改后对照（同一脚本、同一批图）

| 位置 | 视口 | 改前 | 改后 |
| --- | --- | --- | --- |
| ② 气泡单图 | 390×844 | 120×120 / 30.8% | **105.3×105.3 / 27.0%** |
| ② 气泡单图 | 360×740 | 120×120 / 33.3% | **97.19×97.19 / 27.0%** |
| ② 气泡四图 | 390×844 | 每行 2+2 张，行宽 350（89.7%） | **每行 3+1 张**，行宽 350（89.7%），单张 27.0% |
| ② 气泡四图 | 360×740 | 每行 2+2 张，行宽 320（88.9%） | **每行 3+1 张**，行宽 320（88.9%），单张 27.0% |
| ② 图 + 文档混排 | 390/360 | 64×64 | 64×64（未改） |
| ① 草稿缩略图 | 390/360 | 64×64 | 64×64（量过没问题，未改） |
| ③ 点开大图 | 390×844 | 新页面 3000px 宽，图未缩放 | **应用内遮罩 390×844 + 图 366×488（contain，完整在屏内）** |
| ③ 点开大图 | 360×740 | 新页面 3001px 宽，图未缩放 | **应用内遮罩 360×740 + 图 336×448（contain，完整在屏内）** |
| ③ 关闭方式 | — | 浏览器新页面（不受控） | **点遮罩关闭 ✓ / `Esc` 关闭 ✓**（两档都验过） |

改后两档视口、三种组合：`document.scrollWidth === clientWidth`（无横向溢出），单张图 ≤ 屏宽 **27%**（要求 ≤ 60%）。

## 三、能力实测（#209：能力靠探测，不靠假设）

改这一处排布/缩放时**没有**用「CSS 里写了就成立」当结论，也没有用 `CSS.supports()` 冒充探测
（#173 的教训：`CSS.supports('gap','1px')` 返回 true 但 flex `gap` 实际不生效）。逐条实测：

| 依赖的能力 | 怎么验的 | 390×844 结果 | 360×740 结果 |
| --- | --- | --- | --- |
| 多图排布的间距真的生效（不靠 flex `gap` 的「应该支持」） | `getBoundingClientRect()` 量同一行相邻两张 `right` / `left` 之差 | **10.0 / 10.0 px** | **10.0 / 10.0 px** |
| 草稿缩略图行间距 | 同上（三张草稿卡片两两之间） | **10.0 / 10.0 px** | **10.0 / 10.0 px** |
| 缩略图的 `object-fit: cover` 被内核接受 | 读回 `getComputedStyle(img).objectFit`（不是看 CSS 文本） | `cover` | `cover` |
| 预览图的 `object-fit: contain` | ① 组件内 `detectObjectFit()` 读回声明 → `data-object-fit` 属性；② 读回 `getComputedStyle(img).objectFit`；③ **几何证据**：渲染盒 366×488，源图 3000×4000，两者长宽比都 = `0.75`，且盒完整落在视口内 | 属性 `contain` / 计算值 `contain` / 比例 0.75 = 0.75 | 属性 `contain` / 计算值 `contain` / 比例 0.75 = 0.75 |
| 不依赖全屏 API | 组件完全不调 `requestFullscreen`：遮罩是 `position: fixed; inset: 0`，没有全屏 API 也是同一层 | — | — |
| 不依赖 `:has()` / `aspect-ratio` / `dvh` | 新文件里逐条扫（`tests/unit/image-sizing-818.test.mjs` 用例 F）；`pnpm run check:container` 也是 0 处容器查询 | 0 处 | 0 处 |

关键点：**预览层的正确性不押在 `object-fit` 上** —— 等比缩小是由 `max-width/max-height: 100%` + `width/height: auto`
算出来的（老内核也认这套），`object-fit: contain` 只是双保险；`detectObjectFit()` 探测不到时组件会显式落到
`.imageNoFit`（同样是限宽限高 + auto，只是不写 object-fit）。新增代码里没有 `?.` / `??` / `.at()` /
`replaceAll` / `Object.hasOwn`（用例 F 守着），ES5 兜底脚本由 `pnpm run check:guard` 管。

## 四、截图（每档 6 张，均为 dsf=2 的视口截图）

| 文件 | 内容 |
| --- | --- |
| `390-before-single.png` | 改前 390：单图气泡，120px 方块 |
| `390-after-single.png` | 改后 390：单图气泡 105.3px |
| `390-before-multi.png` | 改前 390：四图 2+2 两行（每张 120px） |
| `390-after-multi.png` | 改后 390：四图 3+1 两行（每张 105.3px） |
| `390-after-preview.png` | 改后 390：点开后的应用内预览（遮罩 + contain + 右上关闭） |
| `390-after-draft.png` | 改后 390：草稿缩略图仍是 64px（未改） |
| `360-before-single.png` | 改前 360：单图气泡，120px = 33.3% 屏宽 |
| `360-after-single.png` | 改后 360：单图气泡 97.19px = 27.0% |
| `360-before-multi.png` | 改前 360：四图 2+2 |
| `360-after-multi.png` | 改后 360：四图 3+1 |
| `360-after-preview.png` | 改后 360：预览层（图 336×448，完整在屏内） |
| `360-after-draft.png` | 改后 360：草稿缩略图 64px（未改） |

逐项数字（含 `tilesPerRow`、`measuredGapPx`、`scrollWidth/clientWidth`、新页面宽度、预览层几何与
`objectFitProbeAttr`）见同目录 `metrics.json`。

这次量测的脚本也一起留档，可重跑（需要 `playwright` + 一个装着本分支 `src` 的开发服务器）：

- `measure-818.mjs`：两档视口 × 三种组合的完整量尺（尺寸 / 间距 / 溢出 / 点开后行为 / 草稿行）
- `png-818.mjs`：现场生成竖 3000×4000、横 4000×3000 的真 PNG（无外部依赖）

```bash
NODE_OPTIONS=--max-old-space-size=1536 npx rspack serve -c rspack.config.ts --port 8105 &
node docs/ui/818-image-sizing/measure-818.mjs --label=after --base=http://127.0.0.1:8105
```

## 五、没测到的边界（不阻塞关单，别当成通过）

- **真机 / WebView 83 未跑**：取证是 Playwright Chromium 视口截图。新样式用到 `min()`
  （首支持 Chromium 79，同仓 `Welcome.module.css` 已有 `min(280px, 68vw)`）与 `@keyframes`（opacity），
  在 83 上按规范应生效，但**没有在 83 内核上实跑过**（第三节的 `data-object-fit` 探测就是为这种情况留的：
  真在 83 上跑时，读这个属性就知道那台机器认不认 `object-fit`，不用猜）。
- 超窄屏（< 320px）只有公式推算（`27vw` → 280 宽时 75.6px），没有实拍。
- 深色主题的预览遮罩只用浅色主题截图；遮罩色是固定 `rgba(0,0,0,.88)`，不随主题变。
- 动图 / EXIF 旋转图只走同一条 `<img>` 渲染路径，未单独截图。
