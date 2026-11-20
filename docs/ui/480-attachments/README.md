# #527 [480-G] 附件 UI：选择 / 卡片 / 状态与警告 / 进度与取消

规格来源：#480 §3.5（UI 只展示附件卡片、不展示全文）、§10（输入框入口与卡片内容）、
§9（超限必须显式说明、禁止静默截断/静默忽略）；本单： #527。

本轮只新增 `src/components/attachments/`，**不改** `src/components/consume/**` 与 `src/services/**`。
附件状态的权威在 `AttachmentManager`（#523 / PR #529），UI 不自己造状态机。

> **复用优先（第二轮）**：卡片外观不再自研，直接复用 `files/FileCard`；类型图标并入
> `files/FileIcon`；16px 文档入口图标归位到 `base/icons`。附件模块只剩「附件才有的语义」。
> 见下方「复用审计」一节。

## 组件结构

| 文件 | 职责 |
| --- | --- |
| `attachmentService.ts` | 与 manager 的接线缝：声明其公开签名、`setAttachmentService()` 注册点、文件初筛（`classifyAttachmentFiles`）、删除后的 `sweepOrphanAttachments*()` |
| `viewModel.ts` | 记录 → 视图（含 UI 独有的 `cancelled`）、进度百分比、阶段文案、失败原因码、warnings 归并 |
| `useAttachmentDrafts.ts` | 输入区编排：`addFile → parse(onProgress/signal)`、取消、重试、移除、注入结果回填 |
| `AttachmentPicker.tsx` | 入口按钮 + `<input type="file" multiple accept=".txt,.docx,.pdf">` |
| `AttachmentCard.tsx` | **单张卡片 + 卡片列表**（`AttachmentCard` / `AttachmentList`），输入区与消息内复用（`variant: 'draft' \| 'message'`）；外观复用 `files/FileCard` |
| `AttachmentPanel.tsx` | 点卡片弹出的小面板：warnings / 失败原因 / 重新解析 / 移除（复用 `base/anchored.ts`） |
| `MessageAttachments.tsx` | 消息内按附件 id 取元信息后复用同一张卡片（只读，不含取消/移除） |
| `Attachments.module.css` | 唯一一份附件样式：列表排版 / 详情浮层 / 消息内提示（卡片样式在 `files/FileCard.module.css`） |
| `index.ts` | 对外出口 |

### 复用审计（既有资产 → 复用 / 保留）

| 附件 UI 里的东西 | 复用的既有资产 | 结论 |
| --- | --- | --- |
| 卡片布局、图标位、文件名/副标题、圆角尺寸、hover、焦点环 | `files/FileCard.tsx` + `FileCard.module.css` | **复用**：`FileCard` 加 5 个可选槽位（`statusText`/`progress`/`corner`/`actions`/`activator`）与 4 个解析态状态类，布局零复制 |
| PDF / DOCX / TXT 类型图标 | `files/FileIcon.tsx`（已有 `FileIconFrame` 工厂） | **复用**：DOCX/TXT 作为两条新成员加进同一个工厂，删掉自建的 `AttachmentTypeIcon.tsx` |
| 16px 文档入口图标 | `base/icons.tsx` | **复用**：图标归位到既有图标库，`ChatInput` 与回形针同处导入 |
| 取消 / 移除 / 关闭按钮 | `base/IconButton` | **复用**（原本就已复用） |
| 面板动作按钮 | `base/Button`（`outlined` / `dangerOutlined`、`s` 档） | **复用**（原本就已复用） |
| 浮层定位与关闭 | `base/anchored.ts` 的 `useAnchoredPosition` / `useDismiss` | **复用**（原本就已复用） |
| 扩展名 / 大小格式 | `services/attachments` 的 `getExtension` / `formatSize` | **复用**：顺手删掉 `viewModel.metaLine`（与 `FileCard` 副标题同源，原本两套） |
| 关闭按钮文案 | i18n 既有 `close` | **复用**：删掉新增的 `attachCloseDetail` |
| 列表排版、详情浮层、消息内提示 | 无对应既有组件 | **保留自研**（合并为 1 份 CSS） |
| `parsing` 进度条 / `partial` 角标 / warnings 列表 / 失败原因分节 | 无对应既有组件 | **保留自研**（语义确实不同） |
| 图片上传卡片、图片缩略图 | `messages/MessageFile.tsx` | 不改动；它和附件卡片共用 `FileCard`，两条线互不影响 |

## 五态视觉差异

| 状态 | 卡片视觉 | 状态行文案 |
| --- | --- | --- |
| `pending` | 虚线边框、中性色（`FileCard` 的 `.pending`） | 等待解析 |
| `parsing` | 品牌色进度条 + 百分比；无页数信息时走不确定态滑动条；右侧取消按钮 | 解析中 58% / 解析中 · 提取第 3 页 |
| `success` | 常规边框、绿色状态行 | 已就绪 |
| `partial` | 琥珀色边框 + **右上角黄色警告角标**（`16px` 胶囊，图标 + 条数） | 部分内容已就绪 · N 条警告 |
| `failed` | 红色边框 + 红色状态行 | 解析失败，点击查看原因 |
| `cancelled` | 虚线边框、中性色（UI 独有：用户主动取消，不显示成红色失败） | 解析已取消 |

卡片只显示「类型 + 大小 + 状态 + 警告条数」，**不显示正文**（§3.5）。

## warnings 怎么展示

1. **来源**：`DocumentAttachment.warnings`（parser / manager 给的中文可读句子，例如
   「已忽略 3 张图片（本阶段不做图像识别）」「第 3、7 页提取失败」）原样展示，不二次翻译 ——
   这些句子由解析器按格式细节产出，UI 侧再翻一遍反而会丢信息。
2. **注入侧**：`useAttachmentDrafts().annotateInjection()` 接受 ContextBuilder 的
   `BuildResult.warnings` 与 `truncatedCharacters`，截断说明按「剩余 N 字符未发送」补一条；
   若已有告警里出现过同一个数字则不重复（同一条信息说两遍会让人以为丢了两次内容）。
3. **兜底**：状态是 `partial` 但一条告警都没有时，用页数差补「共 12 页，仅成功提取 10 页」，
   避免「状态降级了却什么都不说」。
4. **呈现**：卡片角标只给条数，点开面板看逐条列表；`failed` 面板给「人话原因」（按
   manager 的 `reason` 码）+「技术信息」原文（如 `no-parser: no parser registered for .pdf`）。

## 非法类型 / 超限：明确拒绝，不静默过滤

`classifyAttachmentFiles()` 逐条判定并把不合格项原样返回（`unsupported-format` /
`empty-file` / `too-large` / `too-many`），`useAttachmentDrafts().addFiles()` 逐条 toast：

- 「「报表.xls」不是支持的文档类型，当前仅支持 TXT、DOCX、PDF」
- 「「a.pdf」为 60 MB，超过该类型的上限 50 MB」
- 「「空.docx」是空文件，没有可解析的内容」
- 「一条消息最多 N 个文档，已拒绝多出的 M 个」

`accept` 属性只是文件对话框的过滤建议（用户可以切到「所有文件」），所以真正的类型判定必须在
选择之后做；manager 侧还会做扩展名 + MIME 双判并抛 `AttachmentError`，那条路径的提示也在同一个
hook 里（`addFailureToast`）。

## 接线点（等 #480-D / #480-F 合入）

1. **manager → UI**：`setAttachmentService({ addFile, parse, remove, getMeta, sweepOrphans,
   collectReferencedAttachmentIds })`，见 `attachmentService.ts` 头部 TODO 块（`src/main.tsx` 一行）。
2. **输入框**：`useAttachmentDrafts()` + `<AttachmentPicker onFiles={addFiles} />` +
   `<AttachmentList attachments={attachments} onCancel onRetry onRemove />`；拖入 / 粘贴走同一个
   `addFiles`（`ChatInput` 的 `DragMask` 已经能拿到 `File[]`）；`busy` 为真时不允许发送。
3. **消息内**：`<MessageAttachments ids={message.files.filter(f => isAttachmentRefId(f.id)).map(f => f.id)} />`。
4. **删除消息 / 会话**：事务提交后 `void sweepOrphanAttachmentsAfterDelete()`（内部先
   `collectReferencedAttachmentIds()` 再 `sweepOrphans(referenced)`）。

## 本轮未做

- ~~截图~~：已拍（`chore/480-screenshots`），见下节。
- **搜索框 / 拖拽区**之外的入口（如粘贴板图片）不在本单范围。

## 截图（390 / 360 两档，`chore/480-screenshots`）

卡片宽度 240px（与既有上传卡片同宽，因为就是同一张卡）+ 换行列表，角标用 `-6px` 负偏移并由列表
`padding` 收进可视区 —— 两档 `metrics.json` 的 `overflowCount` 实测都是 `0`。

```bash
node scripts/build.mjs --internal
node scripts/shot-mobile.mjs \
  --page=480-attach-entry,480-attach-parsing,480-attach-partial,480-attach-failed,480-attach-in-message \
  --viewport=390,360
```

| 场景 | 拍的是 | 张数 |
| --- | --- | --- |
| `480-attach-entry` | 输入区文档入口：anthropic / openai / ours 可用态；DeepSeek 禁用态 + 点下去的整句原因 | 5 |
| `480-attach-parsing` | `parsing`：逐页进度 + 取消按钮；取消后「解析已取消」 | 2 |
| `480-attach-partial` | `partial`：黄描边 + 橙色警告角标；点开详情看 warnings | 2 |
| `480-attach-failed` | `failed`：红描边 + 失败原因 + 重新解析（点一次真的再跑一遍） | 3 |
| `480-attach-in-message` | 消息内卡片（只元信息、无正文）+ 详情面板仍只有元信息 | 3 |

产物：`docs/ui/480-attachments/{390,360}/480-attach-*.png`（每档 15 张，两档共 30 张）；量数在同目录
`metrics-480-attach-*.json`（每场景一份），**每档目录各有一份汇总** `390/metrics.json` / `360/metrics.json`
（顶层 `overflowCount`，两档实测都是 0；本目录（两档的上一层）**没有**汇总文件，别去找它）。验收结论与未覆盖项见
[`docs/testing/acceptance-480.md`](../../testing/acceptance-480.md)。
