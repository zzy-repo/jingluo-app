# 集成层怎么跑（含基线比对）

配套文件：

| 文件 | 作用 |
| --- | --- |
| `tests/run-layer.mjs` | 分层 runner（unit / integration / e2e / device），本文件的主角 |
| `tests/integration-baseline.json` | 集成层**基线清单**：每个文件期望什么状态、为什么 |
| `tests/helpers/env.mjs` | 环境守卫：端口自动发现、产物自述校验、`SKIP(env)` 退出码 |
| `tests/fixtures/domain03-04/ours-upstream.mjs` | 「我们的渠道」上游契约的唯一定义（地址/模型/路径/鉴权/SSE） |
| `docs/TESTING-POLICY.md` | L0 / L1 / L2 分级门禁与该跑什么 |

分层总览见 `tests/README.md`；本文件只讲集成层。

---

## 1. 两条命令

```bash
# 普通跑（失败即非零退出）
npm run test:integration

# 基线比对跑（只判「相对基线没有新增失败」，发版前用这条）
npm run test:integration:baseline
#   等价于 node tests/run-layer.mjs integration --baseline
```

单独一个文件（调试时最常用）：

```bash
node tests/integration/paths.test.mjs                   # 由 runner 注入共享标准产物服务时最省事
node tests/integration/internal-build.test.mjs          # 自己起服务、自己选端口
APP_URL=http://127.0.0.1:5301 node tests/integration/caps.test.mjs   # 也可以自己指一份服务
```

`--only <子串>` 只跑文件名含该子串的用例，`--list` 只列不跑，`--bail` 首个失败即停，
`--timeout-ms <毫秒>` 调单文件超时（默认 180000；`feedback-scroll` 单次要 ~200s，跑全层请用 300000）。

## 2. 前置（标准包 + 内测包）

集成层的 29 个文件分三类，产物要求不同：

| 类别 | 文件 | 产物 | 谁来 serve |
| --- | --- | --- | --- |
| 靠 `APP_URL`（历史遗留写法） | `paths` `caps` `request-body` `upstream-html` `probe-auth` `probe-auth-protocols` `probe-nokey` `legacy-config` `provider-anthropic` `url-import-web` `url-import-native` `url-import-stages` `full-acceptance` | **标准包** | **runner 统一注入**：这 13 个文件跑之前，`run-layer` 起一份共享标准产物服务（端口 0）并把 `APP_URL` 传进去；自己传 `APP_URL` 时以你给的为准 |
| 自建服务（标准包） | `provider-channels` `ours-services` `ours-webpay` `feedback-export` `feedback-draft` `error-boundary` `copy-limit` `auto-title` `mode-switch-plain` `mode-switch-request` `diagnostics-contract` | **预构建**标准包（`dist-standard/`，或各自的 `DIST_*` 变量）；按 main 的约定**不隐式构建**，缺产物 → `SKIP(env)` 并打印构建命令 | 用例自己（`serveDist` / `serveDir`，端口自动分配） |
| 自建服务（内测包） | `internal-build` `motion` `mode-switch` `diagnostics` `feedback-scroll` | **内测包**（`dist-internal/`，或 `DIST_DIR` / `SCROLL_DIST_DIR` 指过去） | 用例自己（端口自动分配） |

准备产物：

```bash
# 标准包 → dist-standard（共享服务与标准包类用例都读它）
NODE_ENV=production DIST_OUT=dist-standard npx rspack build -c rspack.config.ts

# 内测包 → dist-internal（内测类用例吃它；也可以直接产出到 dist/）
INTERNAL_BUILD=1 NODE_ENV=production DIST_OUT=dist-internal npx rspack build -c rspack.config.ts

# 全量跑
STANDARD_DIST_DIR=$PWD/dist-standard DIST_DIR=$PWD/dist-internal pnpm test:integration
```

> 一次全量跑只需要**两份**产物：`dist-standard`（标准）+ 内测包（`dist-internal` 或 `dist`）。
> **不需要手动起静态服务**：要么用例自己起，要么 runner 注入。
> 用例**不做隐式构建**（沿用 `tests/helpers/runtime.mjs` 的约定：调用方提供预构建产物）；
> 缺产物时打印构建命令并 `SKIP(env)`，不会静默编一份。别为单个用例反复重建，也别手工复制目录。

## 3. 端口：不再写死

以前每个用例写死一个端口（5291 / 5292 / …, 5191 / 5192 …）。固定端口的后果很贵：
本机同时有别的任务在跑测试时，**端口被占 → 你起服务失败但用例照跑**，于是它连到别人那份产物，
一整批用例假红，而且看日志完全像「产品坏了」。Issue #19 的「13 个红」里就有一批是这么来的
（实测：`5181` 上是一个 `python3 -m http.server` 在 serve 另一条分支的 `1.4.0-beta.3` 产物）。

现在的做法：

- 自建服务的用例统一用 `serveDir(dir, { port })`：它是 `tests/helpers/runtime.mjs` 的 `serveDist()`
  的薄封装——`PORT` 没给就用 0 号端口由操作系统**原子分配**（连竞态都没有），进程内 HTTP 服务，退出即释放。
- 想固定端口也可以：`PORT=5291 node tests/integration/internal-build.test.mjs`。
- 靠 `APP_URL` 的 13 个历史用例由 `run-layer` 注入一份共享标准产物服务（端口 0），
  所以「忘了手起 5181」不再等于整批假红；想指着别的服务跑，显式给 `APP_URL` 即可。

**静态检查（#406）**：写死的端口是假绿的源头，所以有门禁盯着：

```bash
node scripts/check-hardcoded-ports.mjs            # 警告模式（CI 友好，退出码 0）
node scripts/check-hardcoded-ports.mjs --strict   # 有警告即退出 1（接线后用）
```

它只认「真的会被连的端口」：跑法注释、`process.env.X || 5181` 这类有 env 出口的兜底、
栈帧/产物路径夹具里的端口都不算违规；裸端口（`http://127.0.0.1:5181`、`server.listen(5294)`、
`const PORT = 5418`）才会被点名。规则与方法见 `docs/TESTING-POLICY.md` §10.3。

## 4. 产物守卫与 `SKIP(env)`

每个用例开跑前都会自检环境，不满足就打印原因并 `exit 77`（runner 汇总成 `SKIP(env)`，**不算失败**）。
四种情况会被拦下：

| 情况 | 打印示例 |
| --- | --- |
| 地址不可达 | `SKIP(env) http://127.0.0.1:5301 不可达（fetch failed）` |
| 端口上不是这份产物（撞车） | `SKIP(env) … serve 的不是本地 dist：远端 main.8c410c64.js ≠ 本地 main.4e287f6b.js` |
| 产物种类不对 | `SKIP(env) 产物种类不对：用例需要 internal 包，… 上是 standard 包；端口产物 main.2f1950e8.js（variant=standard）` |
| 产物比源码旧 | `SKIP(env) 产物陈旧：src/services/api/providers.ts（…T08:13:16Z）比端口上的产物（…T08:08:47Z）新` |

判断依据是构建时写进产物目录的 `build-info.json`：

```json
{ "variant": "internal", "main": "main.4e287f6b.js", "hash": "4e287f6b", "version": "1.4.0-beta.7", "builtAt": "2026-11-18T07:53:03.618Z" }
```

它由 `rspack.config.ts` 的 `buildInfoPlugin` 生成，静态服务本身就能取到（`/build-info.json`），
所以「端口上那份产物是谁」有事实依据，不靠猜。

> `SKIP(env)` 只表示「这次没法验证」，**不是通过**。要发版就必须让这些用例在正确产物上真跑一遍。

## 5. 基线比对（`--baseline`）

`tests/integration-baseline.json` 记录每个文件的期望状态：

```json
{
  "files": {
    "internal-build.test.mjs": { "expected": "pass", "artifact": "internal", "reason": "ours 契约已对齐…" }
  }
}
```

`expected` 只允许两种：`pass` / `known-red`（`known-red` 必须写 `reason` 与关联 Issue）。

`npm run test:integration:baseline` 的输出分四类：

| 输出 | 含义 | 退出码 |
| --- | --- | --- |
| `PASS` / `SKIP(ENV)` | 期望通过且通过 / 环境不满足没法验证 | 0（SKIP 不影响） |
| `KNOWN-RED` | 基线里就登记为红，且这次仍然红 | 0 |
| `NEW FAIL` | 基线期望通过但失败了 → 新引入的问题 | 1 |
| `FIXED?` | 基线记着红但这次通过 → 去更新基线清单 | 1 |

末尾固定打印一行计数（可直接贴进 Issue/CHANGELOG）：

```
本次失败 0 / 基线登记红 0 / 新增失败 0 / 已转绿 0 / 跳过(环境) 0（共 24 个文件）
相对基线没有新增失败 ✅
```

判定原则：**只用「相对基线没有新增失败」做门禁**，不要求基线本身全绿；
但 `known-red` 必须带原因与 Issue，修好后从清单里删掉（否则 `FIXED?` 会一直提醒）。

## 6. flaky：失败自动重跑一次 + 登记 + 隔离（#406）

跑集成层时**每个失败用例会自动重跑 1 次**（`--no-retry` 关闭）。三种结局：

| 结局 | 输出 | 含义 |
| --- | --- | --- |
| 重跑通过 | `<< PASS(flaky) <文件>` + 末尾 `FLAKY <文件>` | 当绿放行，但**已登记**（`tests/flaky-registry.json`、`--json` 的 `flaky` 字段、CI job summary） |
| 重跑仍红 | `<< FAIL <文件>` | 真红，照旧失败 |
| 连续 3 次 flaky | 下次起 `QUARANTINED <文件>`（跳过） | 隔离区；每 7 天提醒一次修复，跑绿自动解除 |

**不许用重跑掩盖真红**：重跑通过、但 21 天内已经「修好又坏」累计 ≥2 次 → 直接 `FAIL`
（终端会写 `⚠ … 按真红处理`）。规则与判据见 `docs/TESTING-POLICY.md` §10。

```bash
node tests/run-layer.mjs integration --baseline            # 默认就带重跑
node tests/run-layer.mjs integration --no-retry            # 关掉重跑（排查 flaky 时用）
node tests/run-layer.mjs integration --case quota-exhausted.test.mjs   # --case 不受隔离区拦截
```

> CI 侧不需要改 `.github/workflows/ci.yml`：重跑是 runner 的默认行为，`FLAKY` 名单由 runner 自己写进
> `GITHUB_STEP_SUMMARY`。登记簿在 CI 里是 ephemeral 的（跑完即弃），PR 上能查的是 job summary 与
> `l1-report-*.json` 这两个留痕出口。

## 7. 当前基线（2026-11-20，origin/main@1114607 / 1.4.0-beta.10 线）

- 45 个集成文件：**44 条期望通过 + 1 条 known-red**（`tests/integration-baseline.json` 登记 39 条，
  其余文件没有条目 = 按 `pass` 判）。
- 实测（本机，dist / dist-standard / dist-scroll 均本地构建，#406 复核轮）：

```
node tests/run-layer.mjs integration --baseline --timeout-ms 420000

Total 45: PASS 44, FAIL 1, SKIP(env) 0, NODE-SKIP 0; elapsed 1063887ms
本次失败 1 / 基线登记红 1 / 新增失败 0 / 已转绿 0 / 跳过(环境) 0（共 45 个文件）
  KNOWN-RED  tests/integration/upstream-html.test.mjs（基线已登记，不算新增）
相对基线没有新增失败 ✅
```

- 唯一那条 known-red 是 `upstream-html`：上游返回 `200 + text/html` 时界面给的是「空响应」而不是
  「上游返回网页而非接口数据」。根因在 `describe.ts` → `classifyErrorSignature({status:200})` 把
  `client.ts` 已经分好的 `upstream_returned_html` 盖成 `emptyStream`，是**真实产品缺陷**，
  已开 issue #434 跟踪（基线 `followUp` 指向它）。**不在测试 PR 里改产品。**
- #406 之前那批 known-red（`diagnostics-contract` / `log-viewer` / `mode-switch` /
  `url-import-stages` / `full-acceptance` / `feedback-scroll`）逐条归因为「断言过时」或
  「测试自身 bug」，改测试后转绿并删除条目；归因与证据见 Issue #406 的评论。

## 8. 排查顺序（红了一个文件时）

1. 看 runner 打印的 `↳` 原因：`SKIP(env)` 说明是环境，先按提示准备产物/端口，别改代码。
2. 真 `FAIL`：先确认 `dist`/`dist-standard` 是**这次**构建的（`cat dist-standard/build-info.json` 看 `builtAt`）。
3. 对着该文件头的注释看断言意图；断言与产品现状不一致 → 属于「契约过期」，改断言或改 fixture，
   **不要**为了绿改产品逻辑。
4. 怀疑产品缺陷 → 保留失败、开 Issue，并在 `integration-baseline.json` 里登记 `known-red` + 原因。
5. 单文件复现：`APP_URL=… node tests/integration/<名字>.test.mjs`；跑完清掉自己起的服务。

## 9. 相关

- 分层与门禁分级：`docs/TESTING-POLICY.md`
- 门禁自身的负向对照（新增门禁前必读）：`docs/TESTING-POLICY.md` 第 9 节 + `tests/gates/README.md`
- 用例全景与历史命名对照：`tests/README.md`
- Issue 规范（证据、边界、关闭条件）：`docs/ISSUE-STANDARD.md`
