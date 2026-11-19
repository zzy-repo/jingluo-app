# Window memory (prototype)

Ported from the Summaryception prototype. Scope is a single chat window — no
cross-session or global profile, and nothing is shared between windows.

- Runs today as a SillyTavern extension (`manifest.json` + block-scoped JS).
- To run inside this app it still needs: an API layer for the embedding endpoint,
  a user-facing "use cloud embedding" toggle (default off, falls back to local BM25),
  and wiring to per-window storage.
- `pnpm test:memory` 是这套代码的回归基线（离线、无浏览器、无真实请求）；
  只在本地随手验一条时用 `node --test src/services/memory/tests/recall.test.cjs`。

## 回归清单（改哪块代码必须跑哪组用例）

一条命令跑完全部窗口记忆回归，任一用例失败即非零退出。它同时挂在统一入口
`pnpm test`（`test = 单元层 + test:memory`）后面，所以现有的 CI「Unit tests」步骤会跑到它，
红绿直接显示在 PR 页面上：

```bash
pnpm test:memory
```

| 改动了什么 | 必须跑 | 单独跑 |
| --- | --- | --- |
| `recall.js`：BM25 / 预算打包 / 短缝桥接 / 窗口半径 | `tests/memory/recall.test.cjs` + `src/services/memory/tests/recall.test.cjs` | `node --test tests/memory/recall.test.cjs src/services/memory/tests/recall.test.cjs` |
| `recall.js`：混合打分 / RRF 融合 / 向量命中过滤 | `tests/memory/recall.test.cjs` | `node --test tests/memory/recall.test.cjs` |
| 窗口推进规则（`verbatimTurns` + `summarySegmentTurns` 分段滚动） | `tests/memory/recall.test.cjs` 的「分段滚动」两条 | 同上 |
| `embedding.js`：请求构造、重试/退避、超时、返回体与维度 | `tests/memory/embedding.test.cjs` | `node --test tests/memory/embedding.test.cjs` |
| `vectorstore.js`：命名空间隔离、模型切换、检索过滤、清理 | `tests/memory/vectorstore.test.cjs` | `node --test tests/memory/vectorstore.test.cjs` |
| 存储接线（`index.js` 的 `getChatKey` / `ensureVectors` / 会话切换 / 删会话清理） | `tests/memory/storage.test.cjs` | `node --test tests/memory/storage.test.cjs` |
| 设置开关（默认关闭、关闭后零外部请求、召回开关与预算） | `tests/memory/switches.test.cjs` | `node --test tests/memory/switches.test.cjs` |

约定（新增用例照这个来）：

- **不联网**：embedding 一律注入假 fetch（`tests/memory/helpers/fake-net.cjs`），
  用例里出现真实请求即视为 bug。
- **不睡觉**：时间用假时钟（`createTimer` / `fixedDate`），重试退避靠"记录到的延迟序列"断言，
  禁止 `sleep`、禁止依赖机器时间。
- **跑真模块**：`src/services/memory/*.js` 是块级浏览器脚本，仓库根 `package.json` 是
  `"type": "module"`，直接 `require()` 会拿到空导出 —— 统一用
  `tests/memory/helpers/load.cjs` 在 vm 里按浏览器方式加载；`index.js` 用
  `tests/memory/helpers/host.cjs` 起一个假 SillyTavern 宿主。
- **新增用例文件要登记**：`package.json` 的 `test:memory` 是显式文件列表（`node --test` 在
  Node 22 不展开目录），加文件时同步改脚本和本表。

已知缺口（用例已登记，但当前不参与红绿判定）：

- `vectorstore` 没有 per-chat 条数上限与淘汰策略 —— `tests/memory/storage.test.cjs`
  里对应一条 `todo` 用例，接线（#399）落地后改成真实上限断言。
- "关掉云端 embedding" 目前靠"端点留空即只用本地"，还没有独立开关字段（#398）；
  现在测的是默认配置下零外部请求这条真实约束。
