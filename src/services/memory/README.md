# Window memory (prototype)

Ported from the Summaryception prototype. Scope is a single chat window — no
cross-session or global profile, and nothing is shared between windows.

- Runs today as a SillyTavern extension (`manifest.json` + block-scoped JS).
- `embedding.js` 已改为 ES module 并走 app 的 API 层（#397）：地址 / 鉴权头 / 超时 / 错误分类都来自
  `src/services/api/`（`embedding.ts` + `client.ts` + `providers.ts` 的 `paths.embedding`）。
  模型、本地推理仍不在 app 内。因此 `embedding.js` 不再能作为 SillyTavern 的 classic script 单独加载。
- 设置页里的 `embUrl` / `embKey` 两个输入**已不参与请求**（渠道配置接管），随 #398 的开关一起整理。
- To run inside this app it still needs: a user-facing "use cloud embedding" toggle (#398) and
  wiring to per-window storage (#399).
- `node --test tests/recall.test.cjs` covers recall, budget packing and cache reuse
  （需在**没有 `type: module` 的 package.json** 的目录下跑，见该文件头）。

