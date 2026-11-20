# #480 文档链路回归基线：`pnpm test:doc`

> 关闭条件来源：#575「文档链路回归基线：一条命令跑全套」。
> 母单：#480；实现随 PR #555（`feat/480-doc-attachments`）合入 `main`。
> 本文只写**可复核的事实**：命令、跑出来的数、改坏了会怎样。

---

## 1 一条命令

```bash
pnpm test:doc
```

- 实现在 `package.json` 的 `test:doc`：`node --test --import ./tests/helpers/injected.mjs <10 个用例文件>`。
- `--import ./tests/helpers/injected.mjs` 不能省：`__ENDPOINTS__` 是 rspack `DefinePlugin` 在构建期
  替换的标识符，纯 Node 直接跑用例会 `ReferenceError: __ENDPOINTS__ is not defined`（见该文件头注释）。
- 失败**非零退出**（`node --test` 的退出码）：下面 §4 是实测的变红输出与 `EXIT=1`。

当前实测（2026-11-21，`main` = `20a33b5e`）：

```
1..76
# tests 76
# suites 0
# pass 76
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## 2 这条命令覆盖了什么

| 层                | 用例文件                                                                 | 钉住的关闭条件                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 解析 · TXT        | `tests/unit/txt-parser-480.test.mjs`                                     | 六种编码各一例（UTF-8 / UTF-8 BOM / UTF-16LE·BE / UTF-16 无 BOM / GBK / GB18030，另含 UTF-32 拒收）、换行归一、二进制与空文件拒收、`too-large` 带上限、取消 |
| 解析 · DOCX       | `tests/unit/docx-parser-480.test.mjs`                                    | 标题 / 段落 / **列表** / **表格**按文档顺序转 Markdown、合并单元格、图片只计数、XXE 与路径穿越、ZIP 体积闸                                                  |
| 解析 · PDF        | `tests/unit/pdf-parser-480.test.mjs` + `pdf-parser-partial-480.test.mjs` | **正常**逐页、`pageChars` 与正文同口径、**无文本层**、**超页数**、**取消**、超时、部分页失败落 `partial`、页数/阈值全部来自 `limits.ts`                     |
| 存储 · 去重与清理 | `tests/unit/attachment-store-572.test.mjs`                               | `sha256+parserVersion` **去重命中**（同内容只解析一次、一份原件一份全文）、**未命中**（内容变 / 版本变）、**引用计数删除不误删**、**坏数据容错**            |
| 存储 · 导入保留   | `tests/unit/attachment-preserve-import-531.test.mjs`                     | 整包导入替换后原件仍在、全文仍可读、`sweepOrphans()` 不误删仍被引用的原件                                                                                   |
| 上下文            | `tests/unit/attachment-context-builder-480.test.mjs`                     | 单请求**不重复注入**、预算耗尽进 `skipped`+`warnings`、**显式截断标注**（禁止静默截断）、裁剪协同、**前缀逐字节稳定**（#345）                               |
| 接线              | `tests/unit/attachment-doc-wiring-480.test.mjs`                          | 三渠道注入落地、DeepSeek 零影响、`attachments` 键剥净、降级不阻断                                                                                           |
| 字数口径          | `tests/unit/attachment-character-count-480.test.mjs`                     | 同一段文字走 txt 与 pdf 两个解析器 `characterCount` 必须相等（#544）                                                                                        |
| 导出              | `tests/unit/export-selected-native-536.test.mjs`                         | 选中导出走原生分享（#536）                                                                                                                                  |

不放进来的相邻用例，附理由（免得以后有人以为漏了）：

- `tests/unit/attachment-endpoint-303.test.mjs` / `attachment-endpoint-360.test.mjs`：Files API 端点清理
  与渠道矩阵（#303 / #360），不属于文档链路；且它们依赖 run-layer 注入的 locale 环境，独立 `node --test`
  跑会红（实测：`期望 '当前渠道不支持文件上传，附件入口已不可用'，实际 'This channel does not support file uploads'`）。
- `tests/unit/imported-attachment-379.test.mjs` / `log-313-attachment-import.test.mjs`：历史导入与日志字段，
  各自归 #379 / #313。
- 图片附件（`imageSource.ts`、`vision-*`）不在本命令：那是视觉渠道的链路。

## 3 回归清单：改哪一块，跑哪组

| 改了什么                                                                                                   | 必跑                                                                                             | 另外                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/services/attachments/parsers/{txt,docx,pdf}.ts`                                                       | `pnpm test:doc`                                                                                  | 改了输出文本形状必须**递增** `manager.ts` 的 `PARSER_VERSIONS`（否则老用户命中旧缓存） |
| `src/services/attachments/store.ts` / `manager.ts` / `chat/db.ts`（`attachments`/`attachmentTexts` store） | `pnpm test:doc`                                                                                  | 动了 store 数量或索引要同步 `scripts/check-db-version.mjs`（`DB_VERSION`）             |
| `src/services/attachments/contextBuilder.ts` / `limits.ts`                                                 | `pnpm test:doc`                                                                                  | 阈值只改 `src/services/limits.ts` 的 `LIMITS.attachments.doc`，`pnpm check:limits`     |
| `src/services/attachments/{inject,requestDocs,providerCapability}.ts`                                      | `pnpm test:doc`                                                                                  | 渠道能力改动同时看 `tests/unit/capabilities*.test.mjs`                                 |
| `src/components/attachments/**`、`src/components/chatInput/ChatInput.tsx`（附件入口）                      | `pnpm test:doc` + 两档截图 `node scripts/shot-mobile.mjs --page=480-attach-* --viewport=390,360` | 截图与 `docs/ui/480-attachments/{390,360}/metrics.json` 的 `overflowCount` 必须仍是 0  |
| `src/i18n/{zh,en}.ts` 的 `attach*` 键                                                                      | `pnpm type`（`en.ts` 是 `satisfies Record<keyof typeof zh, string>`，缺键即类型错误）            | 文案改动要重拍两档截图                                                                 |
| 整层兜底                                                                                                   | `pnpm test`（unit 全层 195 个文件）                                                              | 跨域改动再跑 `pnpm test:affected -- $(git diff --name-only origin/main...HEAD)`        |

`pnpm test:affected` 是域级 glob 映射（`tests/domain-map.json`），目前**没有**文档链路这一域，
所以改 `src/services/attachments/**` 它会回落到整层并打印回落原因 —— 这正是需要 `test:doc` 的原因：
一个秒级、边界清楚的入口。

## 4 负向对照：改坏了真的会红（实测）

改坏一处 → `pnpm test:doc` **非零退出**，且红在**对应的那条断言**上，不是红在别处：

| 故意改坏的实现                                                          | 结果                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `store.ts::attachmentTextKey` 去掉 `parserVersion`（`${sha256}:fixed`） | `not ok 2 - [2] 去重未命中：内容变了 / parserVersion 变了都必须落新条目` |
| `store.ts::removeAttachment` 删原件前不数引用（`blobRefs = 0`）         | `not ok 3 - [3] 引用计数删除：删一条不误删仍被引用的原件与全文…`         |
| `store.ts::removeAttachment` 删全文前不数引用（`textRefs = 0`）         | `EXIT=1` / `# pass 75 # fail 1`，同上第 [3] 条                           |

改坏后 `git status` 干净（三处都是临时改动，已还原），红/绿可复现。

## 5 边界（不在本命令里）

- 不做 E2E / 真机（WebView 兼容性由 Spike 覆盖）。
- 不覆盖上游模型的实际回答质量：本命令只钉「喂给上游什么」，不钉「上游答得好不好」。
- UI 布局（390 / 360 两档）靠截图 + `metrics.json`，不是断言。
