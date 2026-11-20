# tests/gates —— 门禁负向对照的 fixture 与骨架（#369）

这个目录**不放可执行用例**，只放两类东西：

| 路径 | 是什么 |
| --- | --- |
| `fixtures/` | 各门禁的「必错输入」：`type/type-error.ts`（TS2322）、`lint/lint-violation.ts`（no-debugger）、`rspack/syntax-error.ts.txt`（语法错；`.txt` 是为了别让格式化工具去解析它）、`layout/unreachable-probe/`（跑不到的用例） |
| `lib/gate-negative-harness.mjs` | 四拍模板与命令解析：正例 → 注入 → 红且红对地方 → 还原 → 再绿 |

真用例在 [`tests/unit/gate-negative-controls.test.mjs`](../unit/gate-negative-controls.test.mjs)（一行 = 一道门禁）。

## 为什么用例不放在这个目录

`tests/gates/*.test.mjs` 会同时踩两个坑，都是本仓库自己的规矩：

1. **`check:test-layout` 会判它红。** `scripts/check-test-layout.mjs` 只允许
   `tests/{unit,integration,regression,device,e2e}/` 放 `*.test.mjs`，且层级目录内不许建子目录；
   新开一个 `tests/gates/` 会让它报 `layer-placement` + `orphan`（**硬规则**，不可基线化）。
   给门禁开一个它自己拦不住的口子，以后每个人都能照着开。
2. **没人会跑它。** CI 的单元层只跑 `pnpm test`，也就是 `node tests/run-layer.mjs unit`；
   `tests/run-layer.mjs` 的 `LAYERS` 里没有 `gates`。写在这个目录里的用例就是 #368 那个坑的复刻：
   **写了、没人跑、不会红**——而这正是 #369 要治的病。

所以：**用例进 `tests/unit/`，注入物与 fixture 进这里。**

## 怎么跑

```bash
node --test tests/unit/gate-negative-controls.test.mjs    # 只跑门禁负向对照（~25s）
node tests/run-layer.mjs unit --only gate-negative-controls
# CI 每次都会跑（`pnpm test` = 单元层全量）
```

## 怎么加一道新门禁的负向对照

1. 在 `fixtures/` 放一份**必错输入**（改坏它会让门禁红的那一行，注释里写清「为什么这条会红」）。
2. 在 `tests/unit/gate-negative-controls.test.mjs` 的 `ROWS` 加一行：
   `{ id, gate, script, scriptExpect, what, artifact, inject, red }`
   —— `scriptExpect` 是门禁命令行本身（`"lint": "oxlint src rspack.config.ts"`），
   有人把它改成 `true` / 加 `--warn` / 少传目录时，这里先红。
3. 在同一个文件的 `REGISTRY` 登记 `{ where, kind, what }`。忘了登记，`N6` 用例会红并直接告诉你该做什么。
4. 规矩正文：[`docs/TESTING-POLICY.md`](../../docs/TESTING-POLICY.md) 第 9 节。

## 注入口径

注入物**必须落在门禁真的会扫的位置**（`src/`、`tests/unit/` …），并且用 `try/finally` 还原：
用例失败也不能把仓库留在「有违规文件」的状态，否则下一个人跑 `check:hygiene` /
`check:test-layout` 会看到一条与他无关的红。**构建**是唯一的例外 —— 它在仓库的**临时副本**里注入
（只拷 `src/shared/config/scripts` 与几个配置文件，`node_modules` 软链），因为 rspack 只编译
进图的模块，必须让 entry 真的 `import` 那个语法错文件才会红。
