# Window memory (prototype)

Ported from the Summaryception prototype. Scope is a single chat window — no
cross-session or global profile, and nothing is shared between windows.

- Runs today as a SillyTavern extension (`manifest.json` + block-scoped JS).
- `embedding.js` 已改为 ES module 并走 app 的 API 层（#397）：地址 / 鉴权头 / 超时 / 错误分类都来自
  `src/services/api/`（`embedding.ts` + `client.ts` + `providers.ts` 的 `paths.embedding`）。
  模型、本地推理仍不在 app 内。因此 `embedding.js` 不再能作为 SillyTavern 的 classic script 单独加载。
- 设置页里的 `embUrl` / `embKey` 两个输入**已不参与请求**（渠道配置接管）。
- **开关已就位（#398）**：设置 →「记忆」分组里的 `记忆向量化（embedding）`，**默认关闭**。
  判定与实际发请求的门在**自研**的 `embeddingGate.ts`（`isEmbeddingEnabled()` / `embed()`）：
  关闭态任何人调 `embed()` 都在 `fetch` 之前抛 `EmbeddingDisabledError`，一个外部请求都不发。
  那一个文件不属于 vendored 上游代码（它是我们写在这目录里的门面）。
- **按会话隔离的存储已就位（#399）**：`sessionMemory.ts`（**自研**，与 `embeddingGate.ts` 同一档）
  把记忆写进 app 既有的 `chat-demo` 库（`chat/db.ts` 的 v14 新 store `sessionMemory`），
  **主键里带会话 ID**（`sessionId + ':' + key`），所以两个窗口永不共享条目；容量双限在
  `src/services/limits.ts` 的 `memory` 组，超限按 oldest-first **只在会话内**淘汰并给提示 + 日志；
  删会话时与 `sessions` / 摘要 / 原件在**同一个事务**里清掉（`db.deleteSession()`）。
  写入需要向量化时**只**走 `embeddingGate.embed()`；开关关闭时**只存文本、不写向量**、零请求
  （召回退到本地 BM25）。
- **仍未接线**：`index.js` / `recall.js` / `embedding.js` 那三份上游调用点还在自己的文件里直接调
  `embedTexts()`，**没有**进 app 运行时（`src/` 里没有模块 import 它们）。等它们真接进运行时的
  那次，必须改走 `embeddingGate.embed()`（否则会出现「一套代码两种判断」），并把本目录从
  `scripts/lib/vendoredPaths.mjs` 的排除名单里拿出来（那才是「整块变成自研代码」的时刻；
  #399 只新增了同目录下的自研 TS 文件，`.js` 那几个仍是 vendored）。
- `node --test tests/recall.test.cjs` covers recall, budget packing and cache reuse
  （需在**没有 `type: module` 的 package.json** 的目录下跑，见该文件头）。

## 来源、许可证与门禁（vendored —— 别当自研代码改）

**本目录是 vendored 第三方参考实现，不是本仓库自研代码。**

- **来源**：SillyTavern 扩展 *Summaryception*（上游 <https://github.com/Lodactio/Extension-Summaryception>，
  作者 Lodactio）的原型代码，核心标注 `Summaryception v5.5.4`（见 `index.js` 头部）；
  本目录 `manifest.json` 的版本号是本仓库 fork 后的 `6.0.0-rc.1`。由 #396 / #397 搬进本仓库。
- **许可证**：**AGPL-3.0**，不是本仓库的 MIT（每个 js 文件头部的 `AGPL-3.0` 声明可查）。
  对本项目的影响：
  - 本目录**当前不参与构建产物**：`rspack.config.ts` 的入口是 `src/main.tsx`，`src/` 下没有任何模块
    import 本目录；唯一的引用是 `tests/unit/memory-embedding-api.test.mjs` 直接 import `embedding.js`。
  - 一旦有人把这里的代码接进 app 正常运行链路并对外分发，AGPL-3.0 的传染性就会覆盖到对应部分
    ——需要先做许可评估（重写实现或调整许可证），**不要默认它跟随仓库的 MIT**。
- **本目录代码不参与 lint 与格式化**：`.oxlintrc.json` 用 `ignorePatterns` 排除了
  `src/services/memory/**`（背景见 #417：目录内 324 条报错全部是上游写法与本仓库规则的冲突，
  而这份代码要整体同步上游，就地重写会让下次同步上游冲突）。因此这里没有 `oxfmt` 风格保证，
  也不要为了过 lint 改这些文件。
- **本目录同时不参与 flex-gap 兜底守卫 / `gen:gap` 生成 / 能力盘点快照（`docs/capabilities/*.md`）
  等风格与统计口径**：名单在 `scripts/lib/vendoredPaths.mjs`（只列目录，不用宽泛模式）。
  上游 CSS 的 21 处 flex `gap` 不该由我们补 `@supports` 兜底、上游 JS 的 `Object.hasOwn`
  之类也不该被算进我们的能力盘点——否则每次同步上游都要连带改一堆与产品无关的门禁数字。
- **改动请同步上游**：要修 bug 先看上游是否已修，优先整块重新同步上游版本，而不是在此就地重写。
  真正把它变成自研代码时（#398 开关 + #399 接线），应当重写，并把本目录从这个排除里拿出来。

