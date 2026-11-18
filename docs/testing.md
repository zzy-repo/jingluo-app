# 集成层怎么跑（含基线比对）

配套文件：

| 文件 | 作用 |
| --- | --- |
| `tests/run-layer.mjs` | 分层 runner（unit / integration / e2e / device），本文件的主角 |
| `tests/integration-baseline.json` | 集成层**基线清单**：每个文件期望什么状态、为什么 |
| `tests/helpers/env.mjs` | 环境守卫：端口自动发现、产物自述校验、`SKIP(env)` 退出码 |
| `tests/fixtures/ours-upstream.mjs` | 「我们的渠道」上游契约的唯一定义（地址/模型/路径/鉴权/SSE） |
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
APP_URL=http://127.0.0.1:5301 node tests/integration/paths.test.mjs
node tests/integration/internal-build.test.mjs          # 自己起服务、自己选端口
```

`--only <子串>` 只跑文件名含该子串的用例，`--list` 只列不跑，`--bail` 首个失败即停，
`--timeout-ms <毫秒>` 调单文件超时（默认 180000；`feedback-scroll` 单次要 ~200s，跑全层请用 300000）。

## 2. 前置（标准包 + 内测包）

集成层的 24 个文件分三类，产物要求不同：

| 类别 | 文件 | 产物 | 谁来 serve |
| --- | --- | --- | --- |
| 外部 `APP_URL` | `paths` `caps` `request-body` `upstream-html` `probe-auth` `probe-nokey` `legacy-config` `provider-anthropic` `url-import-web` `url-import-native` `url-import-stages` `full-acceptance` | **标准包** | 你自己（显式传 `APP_URL`，别指望默认端口干净） |
| 自建服务（标准包） | `provider-channels` `ours-services` `feedback-export` `copy-limit` `auto-title` `diagnostics-contract` `mode-switch-plain` | **预构建**标准包（`dist-standard/`，或各自的 `DIST_*` 变量）；按 main 的约定**不隐式构建**，缺产物 → `SKIP(env)` 并打印构建命令 | 用例自己（`serveDist` / `serveDir`，端口自动分配） |
| 自建服务（内测包） | `internal-build` `motion` `mode-switch` `diagnostics` | **内测包**（`dist/`） | 用例自己（端口自动分配） |

准备产物：

```bash
# 标准包 → dist-standard（外部 APP_URL 用它，自建服务的标准包类用例也读它）
NODE_ENV=production DIST_OUT=dist-standard rspack build -c rspack.config.ts
python3 -m http.server 5301 --bind 127.0.0.1 --directory dist-standard &
export APP_URL=http://127.0.0.1:5301

# 内测包 → dist（内测类用例直接吃它）
INTERNAL_BUILD=1 NODE_ENV=production rspack build -c rspack.config.ts
```

> 一次全量跑只需要**两份**产物：`dist-standard`（标准）+ `dist`（内测）。
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
- 外部 `APP_URL` 的用例请显式传 `APP_URL`，别指望某个默认端口是干净的。

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

## 6. 当前基线（2026-11-18，origin/main@b7b5750 / 1.4.0-beta.8 线）

- 24 个集成文件：**23 条期望通过 + 1 条 known-red**。
- 实测：

```
APP_URL=http://127.0.0.1:5301 node tests/run-layer.mjs integration --baseline --timeout-ms 300000

Total 24: PASS 23, FAIL 1, SKIP(env) 0; elapsed 666232ms
本次失败 1 / 基线登记红 1 / 新增失败 0 / 已转绿 0 / 跳过(环境) 0（共 24 个文件）
相对基线没有新增失败 ✅
```

- 那条 known-red 是 `full-acceptance`：openai 兼容渠道点「测试」后探测请求未带 `Authorization`
  （期望 `Bearer <key>`，实测 undefined）。在**未改动的 origin/main** 上同样复现，与本轮改动无关，
  按「真实缺陷不进本单」的规则登记在 `integration-baseline.json` 的 `known-red` 段，待单开 Issue。
- 历史遗留的 6 条红已按「契约过期 / 环境依赖」修掉（改断言对齐现状、打桩集中到 fixture、
  端口自动发现、产物自述校验），修复明细见 Issue #19 的评论。

## 7. 排查顺序（红了一个文件时）

1. 看 runner 打印的 `↳` 原因：`SKIP(env)` 说明是环境，先按提示准备产物/端口，别改代码。
2. 真 `FAIL`：先确认 `dist`/`dist-standard` 是**这次**构建的（`cat dist-standard/build-info.json` 看 `builtAt`）。
3. 对着该文件头的注释看断言意图；断言与产品现状不一致 → 属于「契约过期」，改断言或改 fixture，
   **不要**为了绿改产品逻辑。
4. 怀疑产品缺陷 → 保留失败、开 Issue，并在 `integration-baseline.json` 里登记 `known-red` + 原因。
5. 单文件复现：`APP_URL=… node tests/integration/<名字>.test.mjs`；跑完清掉自己起的服务。

## 8. 相关

- 分层与门禁分级：`docs/TESTING-POLICY.md`
- 用例全景与历史命名对照：`tests/README.md`
- Issue 规范（证据、边界、关闭条件）：`docs/ISSUE-STANDARD.md`
