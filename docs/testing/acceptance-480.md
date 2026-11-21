# #480 验收报告（并入 `main` 前）

> 母单：#480 Feature：支持 Word、TXT、PDF 文件上传及通用模型文档理解
> 集成分支：`feat/480-doc-attachments @ e5941437`（本报告与截图都基于这个 sha，**不是** `9852bcb3`：那是 PR #545 本地 merge 的产物，上游并未合入，见 §2 与 §7）
> 本 PR：`chore/480-screenshots`（截图 + 本报告 + 两处修复）
> 结论口径：**只写「有什么证据」，不写「应该没问题」**。证据分两类 —— ① 本 PR 亲手跑过、命令与输出都在下文；② 引用别的单，标明出处与它的前提。

---

## 0 一句话结论

**七条标准里 5 条有可直接复核的证据，2 条（② L0/L1/golden 全绿、③ check:legacy 覆盖 pdfjs）在集成分支上「证据本身不在分支里」** ——验收用例集还挂在 PR #545（open），而 `tests/fixtures/480/`、`tests/golden/g13-*`、`tests/unit/accept-480-*` 这些文件在 `e5941437` 上**都不存在**。所以并入 `main` 之前必须先做两件事：

1. 合 PR #545（并修掉其中 1 条与 #538 冲突的陈旧断言，见 §6-A）；
2. 合本 PR（截图 + 报告 + 两处修复，其中 pdfjs 静态资源路径那条是**真产物里 PDF 解析 100% 失败**，见 §6-B）。

---

## 1 标准①：全部子单已合并

集成分支 `e5941437` 上已合的子单（`git log --merges --oneline e5941437` 可复核）：

| 子单 | 内容 | 落地 PR | 集成分支 merge commit |
| --- | --- | --- | --- |
| #518 [480-0] | 参考实现调研（Chatbox / Cherry Studio 选型结论） | 研究单，无代码 | — |
| #519 [480-A] | TXT 解析器（编码识别 + 规范化 + 异常提示） | PR #522 (`feat/480-txt-parser`) | `be497bf` |
| #523 [480-D] | AttachmentManager + 附件存储（DB v13 / sha256 / 孤儿清理） | PR #529 (`feat/480-attachments-store`) | `9db2291` |
| #520 [480-B] | DOCX 解析器（段落/标题/列表/表格 + 安全限制） | PR #532 (`feat/480-docx-parser`) | `3836696` |
| #521 [480-C] | PDF 文本解析（pdfjs-dist@2.16.105，逐页/进度/取消/无文本层） | PR #534 (`feat/480-pdf-parser`) | `8286c08` |
| #525 [480-F] | ContextBuilder（预算/去重/裁剪协同，前缀稳定） | PR #526 (`feat/480-context-builder`) | `26aabf7` |
| #524 [480-E] | 三渠道文档注入适配（anthropic / openai / ours，DeepSeek 零改动） | PR #530 (`feat/480-provider-adapters`) | `8679b71` |
| #527 [480-G] | 附件 UI（选择 / 卡片 / 五态 / 进度与取消 / 警告与失败原因） | PR #537 (`feat/480-attachments-ui`) | `e6b8bfc` + 接线 `7e42392` |
| #538 [480-bug] | DeepSeek「只传文档不写字 → 空消息」：禁用该渠道文档入口（双向防线） | PR #539 (`feat/480-deepseek-doc-gate`) | `9f62e2c` |
| —— | 附件 UI 复用既有组件（14→9 文件，CSS −42%） | PR #541 (`feat/480-ui-reuse`) | `74b567b` |
| #531 [480-bug] | `commitStaging()` 清原件后的降级 | 随存储层一起落（L1-5 用例覆盖） | `9db2291` 起 |
| #528 [480-H] | **验收测试**（L0/L1/golden + 负向 + 老内核语法） | PR #545 (`feat/480-verify-tests`) | **未合入**（PR open） |

- 集成分支相对 `main` 的体量：`git diff --stat main e5941437` → 见 §8 命令。
- **缺口**：#528（验收测试）仍是 open PR，集成分支上没有 `tests/unit/accept-480-*` / `tests/golden/g13-*` / `tests/fixtures/480/`。这条直接决定标准②③能不能算数。

## 2 标准②：L0 / L1 / golden 全绿 + 负向 ≥8

**分两段说，因为证据在两个分支上。**

### 2.1 集成分支 `e5941437` 上现存的 480 用例（本 PR 亲手跑）

| 文件 | 条 | 结果 |
| --- | --- | --- |
| `tests/unit/attachment-context-builder-480.test.mjs` | 10 | PASS |
| `tests/unit/attachment-doc-wiring-480.test.mjs` | 7 | PASS |
| `tests/unit/docx-parser-480.test.mjs` | 7 | PASS |
| `tests/regression/issue-480-legacy-gate-covers-vendored.test.mjs` | 4 | PASS |

```bash
node tests/run-layer.mjs unit --case tests/unit/attachment-context-builder-480.test.mjs --no-record
node tests/run-layer.mjs unit --case tests/unit/attachment-doc-wiring-480.test.mjs --no-record
node tests/run-layer.mjs unit --case tests/unit/docx-parser-480.test.mjs --no-record
node tests/run-layer.mjs regression --case tests/regression/issue-480-legacy-gate-covers-vendored.test.mjs --no-record
```

### 2.2 PR #545 的验收用例集（在 `origin/feat/480-verify-tests @ 9a0d797`，**未并入**）

PR #545 自称「54 用例 + 负向 13/13」。本 PR **逐文件复跑**（不是汇总跑批，原因见 §6-A）实测：

| 文件 | 条 | 结果 |
| --- | --- | --- |
| `tests/unit/accept-480-l0-txt（PR #545）` | 13 | PASS |
| `tests/unit/accept-480-l0-docx（PR #545）` | 7 | PASS |
| `tests/unit/accept-480-l0-pdf（PR #545）` | 8 | PASS |
| `tests/unit/accept-480-l0-context（PR #545）` | 8 | PASS |
| `tests/unit/accept-480-l0-inject（PR #545）` | 7 | **6 PASS / 1 FAIL**（陈旧断言，见 §6-A；改对后 PASS） |
| `tests/unit/accept-480-l1-chain（PR #545）` | 6 | PASS |
| `tests/regression/accept-480-legacy-artifact（PR #545）` | 4 | PASS |
| `tests/regression/issue-480-legacy-gate-covers-vendored.test.mjs` | 4 | PASS |
| `tests/golden/g13-480-doc-attach（PR #545）` | 1 条 / 6 步 | PASS（1248ms；需 **standard** 产物 `node scripts/build.mjs`） |

负向验证（"改坏必须变红"）：

```bash
node tests/tools/negative-verify-480.mjs
# 修 §6-A 之前：10/13（M10–M12 因基线红被跳过）
# 修 §6-A 之后：13/13 条「改坏 → 变红」成立
```

> 口径提醒：**「54 用例」是 PR #545 自己写的数**。本 PR 数到的是 6 个 L0/L1 文件 49 条 + 2 个回归文件 8 条 + golden G13 一条 6 步。差 5 条可能是 PR #545 把 golden 的 6 步按条计。数字口径要在合 #545 时对齐，别把两个数当成同一个。

## 3 标准③：`check:legacy` 覆盖 pdfjs + 负向

（这块最早由 `b861fbb`「check:legacy 覆盖全部产物 —— 补上 pdfjs 这块免检区」落地，并由 `tests/regression/issue-480-legacy-gate-covers-vendored.test.mjs` 锁住。）

本 PR 在 `e5941437` 上复验：

```bash
node scripts/check-bundle-syntax.mjs
# 扫描范围：全部 *.js 共 92 个（打包产物 90 个含懒加载 chunk + vendored 经典脚本 2 个：
#   static/pdfjs/pdf.min.js, static/pdfjs/pdf.worker.min.js）
# 语法：词法层违规 0；AST 层违规 0；运行时 API 违规 0
# 结论：合格
```

负向（往里塞一个 ES2021 逻辑赋值，低内核解析期必炸）：

```bash
printf '\nvar y ||= 2;\n' >> dist/static/pdfjs/pdf.min.js
node scripts/check-bundle-syntax.mjs; echo $?
# exit=1
# ✗ dist/static/pdfjs/pdf.min.js:4:7 logical-assignment（逻辑赋值（ES2021 / Chrome 85）） ||=
# 结论：不合格 —— 产物里有 Chrome 83 解析不了的语法（issue #13），低内核上会白屏
```

> 任务里引用的历史证据是「注入 `||=` → exit 1 点名 `pdf.min.js` 第 4 行第 30 列」；本 PR 的注入点在第 4 行第 7 列，所以输出是第 4 行第 7 列。**行号会漂、结论不变**：门禁确实咬得到 vendored 的那份 pdfjs。

## 4 标准④：前缀稳定性（整轮请求 = 下一轮逐字节前缀）

- 集成分支上的断言：`tests/unit/attachment-context-builder-480.test.mjs`（「A 轮的**整段**请求（含附件注入）是 B 轮请求的逐字节前缀」）。
- PR #545 里更狠的一条：`tests/unit/accept-480-l0-context（PR #545）` → `[L0-CTX] 前缀稳定：本轮请求的消息 JSON 是下一轮请求的逐字节前缀`（`secondJson.startsWith(prefix)` 失败时会把两轮 JSON 一起打出来）。
- 两条都在 §2 的跑批里 PASS。

## 5 标准⑤：DeepSeek 请求体零改动

三份证据，缺一不可：

1. **`src/services/chat/requestBody.ts` 的实现零改动**：`git diff main..e5941437 -- src/services/chat/requestBody.ts` 只有 **+7 行注释**（说明「注入刻意不放在这里」），**0 行实现变更**。
2. **三态 `JSON.stringify` 全等**：`tests/unit/attachment-doc-wiring-480.test.mjs` 的 `[绿 1] DeepSeek：attachmentRefs 不传 / false 与改动前逐字节相同，且没有任何 attachments 键`（PASS，见 §2.1）。PR #545 的 `accept-480-l0-inject` 里还有一份等价断言。
3. **截图侧的旁证**：`480-attach-in-message` 场景真的发出了请求，抓到的请求体里**有**文档正文（`requestBody.hasDocumentText: true`，696 字符），而**消息气泡/卡片/面板上都没有**（`bodyHasDocumentText: false`）—— 注入确实只发生在请求组装处。

> 这条只覆盖「DeepSeek 路径不被 #480 改到」。「三渠道真实上游接不接受这份请求体」不在这条里，见 §7 第 4 项。

## 6 标准⑥：390 / 360 两档截图

脚本：既有 `scripts/shot-mobile.mjs`（没有新写工具，只加了 5 个场景）。产物：`docs/ui/480-attachments/{390,360}/`，**15 张/档、共 30 张**。

```bash
node scripts/build.mjs --internal        # 被测产物
node scripts/shot-mobile.mjs \
  --page=480-attach-entry,480-attach-parsing,480-attach-partial,480-attach-failed,480-attach-in-message \
  --viewport=390,360
```

| 场景 | 覆盖的标准项 | 截图 |
| --- | --- | --- |
| `480-attach-entry` | 输入区附件按钮：anthropic / openai / ours 三渠道**可用态**（隐藏 `input[accept=".txt,.docx,.pdf"]` 都在）+ DeepSeek **禁用态带原因**（`aria-disabled=true`、`opacity .4`、`docInputs=0`、点下去 toast 给整句原因） | 5 张 |
| `480-attach-parsing` | 卡片 `parsing` 态：逐页进度条 + 「取消解析」；点取消 → 中性色「解析已取消」 | 2 张 |
| `480-attach-partial` | 卡片 `partial` 态：黄色描边 + 橙色角标「1」+ 点开详情看 warnings（`第 2 页提取失败`、`第 2/3 页`） | 2 张 |
| `480-attach-failed` | 卡片 `failed` 态：红色描边 + 失败原因 + 「重新解析」（点了会真的再跑一遍，仍旧失败） | 3 张 |
| `480-attach-in-message` | 用户消息里的附件卡片：只有 `文件名 / 类型 大小 / 状态`，无正文；开详情仍只有元信息 | 3 张 |

**横向溢出断言**（`metrics.json` 的 `overflowCount`）：

| 档 | `docs/ui/480-attachments/<档>/metrics.json` | overflowCount |
| --- | --- | --- |
| 390×844 | 5 个场景汇总 | **0** |
| 360×740 | 5 个场景汇总 | **0** |

逐场景明细在同目录 `metrics-480-attach-*.json` 里（`metrics.json` 是汇总：顶层 `overflowCount` 取各场景最大值，`pages` 逐场景列出）。两档都是 0，`notes` 全空（没有一条降级警告）。

> 三张「可用态」的像素是同一张（入口外观与渠道无关），所以每条量数里都带
> `channelKind`（读 `chat-demo:provider-kind`）：`anthropic` / `openai` / `ours` / `deepseek` 各不相同 ——
> 证明这是「切到不同渠道后的同一处渲染」，不是把一张图复制三份。

**「与既有上传卡片同源」的观感**（#541 要求）：截图里附件卡片与消息里的上传文件卡片共用 `files/FileCard` / `files/FileIcon` —— PDF 红图标、`PDF 1.1 KB` 副标题、右侧 × 删除位、圆角与高度全部一致；消息内变体只是去掉了取消/移除动作位。

## 7 标准⑦：未覆盖项（如实列）

1. **openai / ours 没打到真实上游**：所有截图与用例都是本地桩（截图里用 route 拦截 + SSE 假回复）。旁证只有「App 真的发出了请求、请求体里真有正文」，**上游的接受度没有验**。
2. **PDF「部分页失败」用真文件，但「页级崩溃」仍只有故障注入这一种覆盖**：截图用的是现造的、第 2 页内容流损坏的真 PDF（poppler 的 `pdftotext` 也报 `Unknown compression method in flate stream` 并跳过该页）；L0 的 `accept-480-l0-pdf` 里那条仍是 node 侧 loader 的 `__480_PDF_FAULTS__` 注入。真实世界里「只有一页坏」的样本长什么样，没见过。
3. **`commitStaging()` 本体没跑**：整包导入清空 `files` store 的降级只由内存替身模拟（`tests/fixtures/480/memory-attachment-db`（PR #545） + L1-5），真导入路径没有端到端跑过。
4. **三渠道真实上游接受度、真机取证缺失**：截图是**浏览器视口**（`deviceScaleFactor: 2` + `isMobile`），不是真机；Chromium 83 档（Android 11 出厂镜像）上 pdfjs worker 与解码路径没有真机验证。
5. **#543 / #544 / #547 三个新缺口**（本 PR 不处理，按 goal 清单原样登记）：
   - #543、#547：本轮未在分支代码/描述里找到对应痕迹，范围以 issue 为准（#547 与「PR #554 修 DB v13 打断的 L1 用例」是同一片区域，`d20a4178` 已合进集成分支）。
   - #544：`ParsedDocument.characterCount` 与 txt/docx 口径不一致（PDF 不含 `[第N页]` 标记）。本 PR 复验仍成立：截图里那份 3 页 PDF 面板显示 `99 字符`，而注入文本更长。
6. **没有跑整套测试**：按分工只跑了 `npx tsc`、`check:legacy`、480 相关的用例文件与截图脚本；`pnpm test` 全量、integration / device 层、以及 `main` 上的其它门禁没跑。

## 8 本轮发现（4 条，前两条**已在本 PR 修掉**）

### A. `accept-480-l0-inject` 有一条与 #538 冲突的陈旧断言，且汇总跑批会把它报成 PASS（未在本 PR 修，属 PR #545）

- 现象：`[L0-INJECT] 能力表：deepseek 只走原生 file_id…` 断言 `docInjectionFor('deepseek') === { textInjection: false, nativeFile: true }`，未知渠道也是 `nativeFile: true`。#538 把 `nativeFile` 的语义收紧成「本仓库确有可用的原生上传实现」后，两处都变成 `false`。
- 影响：这条用例**在集成分支/`feat/480-verify-tests` 上一直是红的**；但 `node tests/run-layer.mjs unit --only 480` 会输出
  `<< PASS tests/unit/accept-480-l0-inject（PR #545） (21ms, 7 用例)`（21ms 还没跑完一个文件），
  换成 `--case tests/unit/accept-480-l0-inject（PR #545）` 才是 `<< FAIL`。**汇总跑批把单文件红判成绿**，所以「54 用例全绿」这个说法不能直接采信。
- 修法（本 PR 已在 `9a0d797b` 上验证过，改动留在 PR #545 侧）：断言改 `{ textInjection: false, nativeFile: false }`，并把判定口径换成唯一入口 `acceptsDocuments()`（`deepseek` / 未知渠道为 `false`，其它三个为 `true`）。改完：该文件 7/7 PASS，负向验证从 10/13 变 13/13（M10–M12 才开始跑得动）。

### B. pdfjs 静态资源路径错配：**真产物里 PDF 解析 100% 失败**（已修）

- 现象：`rspack.config.ts` 把 `pdf.min.js` / `pdf.worker.min.js` 拷到 `static/pdfjs/<basename>`，但注入的 `__PDFJS_ASSET__.script/worker` 是**包内相对路径** `legacy/build/…`；`pdfLoader.ts` 按 `assetDir/script` 拼地址 → 浏览器取
  `static/pdfjs/` 下再叠一层 `legacy/build/` 的 `pdf.min.js`（404）、`pdf.worker.min.js`（404）→「PDF 解析组件加载失败」/ fake worker → `PDF 打开失败，文件可能已损坏`。
- 为什么一直没人发现：L0 用例把 `pdfLoader.ts` 整个换成了 node 侧加载口，**真产物里那条 `<script src>` 路径从来没被跑过**。是这次的浏览器截图一上手就撞上了。
- 修法：注入时取 `path.basename(...)`（与 CopyRspackPlugin 的目标名同源），`pdfLoader.ts` 的 `FALLBACK_ASSET` 同步改成同形。修后：worker `200`，同一份 PDF 正常出 `第 2/3 页`。
- 建议补一条**产物级**回归（本 PR 未加）：build 后断言 `__PDFJS_ASSET__` 里两个文件名在 `dist/static/pdfjs/` 下真实存在。

### C. 附件详情面板在 390 档被挤出左侧视口（已修）

- 现象：`base/anchored.ts` 在给了 `maxHeight` 的分支里**完全忽略 `align`**，固定贴右边缘（`right: innerWidth - rect.right`）。面板宽 300 > 卡片宽 240 → 390 档实测 `left = -31`，标题与警告文案左侧被裁（修复前截图：面板左缘看不到边）。
- 修法：该分支改用与无 `maxHeight` 分支同一套 `alignLeft()`（含视口收口）。修后 `left = 29 / right = 329 / insideViewport = true`；`align: 'end'` 的调用方（设置页的 `Select`）行为不变（`reading-settings` 场景复跑确认下拉位置正常）。

### D. 卡片副标题与面板标题的文案口径（未修，建议单独开单）

- 解析失败时卡片第二行显示的是 **「上传失败」**（`FileCard` 对 `status: 'error'` 的既有文案），第三行才是「解析失败，点击查看原因」；同一张卡片两句话在说不同的事。
- 面板「失败原因」标题落在 **「解析过程中出现了未知问题」**，真正原因退到「技术信息」里（`PdfParseError` 的 message 不带 `reason:` 前缀，`failureOf()` 因此归到 `unknown`）。用户要先读技术信息才知道是「文件不是有效的 PDF（缺少 %PDF- 文件头）」。
- 两条都不影响状态机与数据，属文案/分层问题，本 PR 只登记。

## 9 复核命令汇总

```bash
# 产物
node scripts/build.mjs --internal        # 截图用
node scripts/build.mjs                   # golden 用（标准包）

# 截图 + 溢出量数
node scripts/shot-mobile.mjs --page=480-attach-entry,480-attach-parsing,480-attach-partial,480-attach-failed,480-attach-in-message --viewport=390,360
node -e "const m=require('./docs/ui/480-attachments/390/metrics.json');console.log(m.overflowCount)"

# 门禁与用例（集成分支上现存的 480 用例）
npx tsc -p tsconfig.json
node scripts/check-bundle-syntax.mjs
node tests/run-layer.mjs unit --case tests/unit/attachment-context-builder-480.test.mjs --no-record
node tests/run-layer.mjs unit --case tests/unit/attachment-doc-wiring-480.test.mjs --no-record
node tests/run-layer.mjs unit --case tests/unit/docx-parser-480.test.mjs --no-record
node tests/run-layer.mjs regression --case tests/regression/issue-480-legacy-gate-covers-vendored.test.mjs --no-record

# PR #545 的验收用例集（在 feat/480-verify-tests 上）
git checkout origin/feat/480-verify-tests
node tests/run-layer.mjs unit --case tests/unit/accept-480-l0-inject（PR #545） --no-record   # §8-A 的现场
node tests/tools/negative-verify-480.mjs
node tests/golden/g13-480-doc-attach（PR #545）
```
