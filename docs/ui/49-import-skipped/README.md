# #49 导入「跳过条目」界面上可见：验收截图

**这是浏览器视口截图（Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
rm -rf dist && INTERNAL_BUILD=1 NODE_ENV=production ./node_modules/.bin/rspack build -c rspack.config.ts
node scripts/shot-mobile.mjs --page=import-skipped --viewport=390,360 --out=docs/ui/49-import-skipped
```

场景定义：`scripts/shot-mobile.mjs` 的 `PAGES['import-skipped']`。它在临时目录里现造一个
**部分合法 + 部分不可识别**的导出包（`writeBrokenArchive()`，与
`tests/unit/import-skipped-ui.test.mjs` 同构），用真实的 `<input type="file">` 喂给
设置 → 数据管理 → 导入历史对话，等真实 `importArchive` 跑完再截图。

包里的四条损坏：

| 会话 | 损坏形态 | 期望 |
| --- | --- | --- |
| `s1` / `s2` | 完好 | 正常入库 |
| `s3` | 第 2 条消息 `parent_id=99` 悬空（导出被截断） | 只丢这一条 + 一条分支定位 |
| `s4` | 唯一一条消息 `parent_id=7` 悬空，整会话无法构造 | 整会话跳过，连它的图片条目也不许炸 |

## 文件

| 文件 | 内容 |
| --- | --- |
| `390/import-skipped-01-settings-data-before-import-390.png` | 导入前：数据管理页里「导入历史对话」这一项 |
| `390/import-skipped-02-import-confirm-390.png` | 选完文件后的「确认导入历史对话？」弹窗（覆盖式导入的确认） |
| `390/import-skipped-03-import-skipped-details-390.png` | 导入完成后整屏：成功提示带「跳过 4 处损坏数据」，下面摊开 4 条明细 |
| `390/import-skipped-04-import-skipped-closeup-390.png` | 明细块放大（334 × 184） |
| `360/…-360.png` | 同上四张，360 × 740 档（明细块 304 × 198） |

## 量到的内容

成功提示（`metrics.json` → `dialogText`，两档一致）：

```
导入历史对话 已导入 3 个会话，跳过 4 处损坏数据
跳过了 4 处损坏数据 其余会话与消息已正常导入
```

四条明细的逐条文本（`metrics.json` → `skippedUi.texts`，`data-skipped-entry` 依次为
`message:s3#2` / `branch:s3#2` / `message:s4#1` / `session:s4`）：

```
消息 会话「悬空父消息会话」第 #2 条消息 · 消息分支损坏（父消息缺失或角色接不上）（缺失的父消息 #99）
分支 会话「悬空父消息会话」当前指向 #2 · 消息分支损坏（父消息缺失或角色接不上）
消息 会话「整会话损坏」第 #1 条消息 · 消息分支损坏（父消息缺失或角色接不上）（缺失的父消息 #7）
会话 会话「整会话损坏」整段无法读取 · 消息分支损坏（父消息缺失或角色接不上）
```

| 判据 | 390 | 360 |
| --- | --- | --- |
| 明细条数 | 4 | 4 |
| 明细块尺寸 | 334 × 184 | 304 × 198 |
| 横向溢出 | 否（`scrollWidth === clientWidth`） | 否 |
| 超出右边界行数 | 0 | 0 |
| `consoleErrors` | `[]` | `[]` |
| `state.hasPartialStatus` | `true` | `true` |

## 未测边界（不要当成已验证）

- **只测了「上传 ZIP」这条路**：`ImportHistoryUrl`（从链接导入）用的是同一份 `skipped`
  状态与同一个明细组件，但网页版 `canImportFromUrl()` 为 `false`，链接入口在浏览器里**不渲染**，
  这条路径的截图**没有**（需要原生壳 + 真实导出链接）。
- **只测了 `message` / `branch` / `session` 三种 scope 与一种原因**（`backupInvalidBranches`）。
  另一条原因 `backupInvalidFiles`（图片条目坏了）的渲染没截到。
- **桌面宽度没截**：本 Issue 的验收口径只有 390 / 360。
- **真机没测**：没有 adb / 安卓设备，`tests/device/url-import-device.test.mjs` 未运行。
- 极长文件名 / 极长会话标题的换行表现没造样本；明细块本身没有 `overflow` 裁切，
  长到超过一屏时靠对话框整体滚动。
