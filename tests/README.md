# 测试总览（后来者请从这里开始）

这个目录原来是 27 个平铺的 `test.*.spec.mjs` 脚本，跑法只写在各自文件头的注释里，还依赖一个
`tests/node_modules` 软链（指到某台机器上一个**未提交的绝对路径**，形如 `<别人家目录>/deepseek-web/node_modules`），**别人 clone
下来一条都跑不起来**。现在按「依赖什么」分层，统一入口 `tests/run-layer.mjs`，装依赖即可跑。

```
tests/
├── unit/          1 个：纯逻辑，零浏览器，毫秒级
├── integration/  18 个：浏览器 + mock 上游（或自建静态服务），分钟级
├── e2e/           2 个：真上游 + 真 UI（要 API Key）/ 真实反馈后端
├── device/        1 个：Android 模拟器或真机（adb）
├── fixtures/      mock 服务与样本数据（不是测试，被上面引用）
├── helpers/       共享 Playwright 步骤
├── tools/         手工用的一次性脚本（不是测试，不参与分层执行）
└── run-layer.mjs  分层 runner（本文件是唯一入口）
```

---

## 0. 协作隔离与小步运行（test-runtime）

- 开发各用独立 worktree/分支；先检查目录和分支不存在，再从已确认的 `origin/main` 建立。worktree 隔离文件与索引，**不隔离 CPU、内存、端口、浏览器或 pnpm store**。UI/clipboard 工作期间只跑下面的轻量 fixture，别启动全仓并发。
- 发布使用固定 commit 的独立工作树和私有产物目录，记录 commit、构建类型、构建参数、产物哈希；不要把正在开发的工作树或共享 `dist/` 当发布源。标准/内测产物分开且只读复用，路径本身不证明版本或构建类型。
- 本轮审计定位的重复编译热点：`diagnostics-contract` 原先每次强制 rspack build；`auto-title` 缺标准包时隐式 build，且输出硬编码。仅改这两套：注入 `STANDARD_DIST_DIR`（auto-title 也接受 `DIST_DIR`），contract 的 `DIST_DIR` 指内测包；缺 `index.html` 立即失败，**不自动 rebuild**。需要构建时先向协作者报告，再由产物拥有者单次构建、记录固定 commit；本轮没有构建。
- 两套 suite 改用共享静态服务 helper：`listen(0)` 原子分配 loopback 端口，启动成功后才进入浏览器步骤；关闭自身 server 并等待完成。显式 `PORT` / `STANDARD_PORT` 仍支持，发布服务必须记录并独占所选端口。其他 suite 的固定端口、截图路径和生命周期尚未全面迁移。
- runner 串行，每个文件默认 180 秒 deadline；`--timeout-ms` 可显式调整，超时报 TIMEOUT 和非零退出。
  **`integration/feedback-scroll` 必带 `--timeout-ms 600000`**：它串行跑 5 个触控场景、每个场景几十次 CDP 滑动，
  实测 191~200 秒（2026-11 实测 199.8s，机器空闲），默认 180s 会**假 TIMEOUT** —— 而且报错长得像用例挂了，
  实际是超时杀掉了浏览器：`cdpSession.send: Target page, context or browser has been closed`。实时透传 stdout/stderr、记录墙钟总耗时和 JSON；无匹配（包括 `--list`）返回 1，参数错误返回 2。不自动重试：`--case` 精确指定文件，`--failed-from` 仅选择前份 JSON 的失败文件，可叠加 `--case` 缩小。
- 每个 case 使用 `mkdtemp` 并注入 `TEST_TMP_DIR` / `TMPDIR` / `TMP` / `TEMP`，完成后移除。POSIX 为自身子进程创建独立进程组，正常完成、超时与中断均只清理该组，TERM 后升级 KILL，等待管道关闭；不按名称清理其他服务。Windows 当前仅清理直接子进程，完整后代回收仍待实现；脱离进程组的 daemon 也不在此保证内。

```bash
# 无依赖、无浏览器、无 build 的基础设施回归
node --test tests/unit/test-runtime.test.mjs
node tests/run-layer.mjs unit --case test-runtime.test.mjs --json /tmp/runtime-result.json
node tests/run-layer.mjs integration --case auto-title.test.mjs --timeout-ms 180000 --json /tmp/title-result.json
node tests/run-layer.mjs integration --failed-from /tmp/title-result.json --case auto-title.test.mjs
# 在上面的 integration 命令前注入已有产物；不在测试脚本里编译
# STANDARD_DIST_DIR=/private/artifacts/COMMIT/standard
# DIST_DIR=/private/artifacts/COMMIT/internal（仅 contract 还需要此包）
```

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node | **22+**（实测 22.23.4） | unit 层直接 `import` 源码 `.ts`，依赖 Node 22 的 type stripping |
| pnpm | 12+（实测 12.14.0） | 仓库用 pnpm；`npm install` 也能装，但锁文件是 `pnpm-lock.yaml` |
| Chromium | `npx playwright install chromium` | integration / e2e / device(部分) 都要它 |
| 静态产物 | `pnpm build`（标准包）/ `pnpm build:internal`（内测包） | 见下面第 3 节的表格，不同用例要的产物不同 |
| Android 模拟器 | 只有 `device/` 需要 | 需要 `adb`、一个已启动的 AVD |
| 真 key | 只有 `e2e/` 需要 | `E2E_API_KEY` **只走环境变量**，绝不写进文件 |

## 2. 一次性安装

```bash
cd /root/deepseek-app
pnpm install                      # 会装上 playwright 1.64.1（根 package.json 的 devDependencies）
npx playwright install chromium   # 下载浏览器（~150MB，只需一次）
```

> 历史坑：以前 `tests/node_modules` 是指向本机路径的软链，`pnpm install` 也会跳过它。
> **软链已删除**，依赖统一由根 `package.json` 管；如果你在哪里又看到这个软链，直接删掉，别再建。

## 3. 各层怎么跑

```bash
npm test                # = node tests/run-layer.mjs unit
npm run test:integration
npm run test:e2e
npm run test:device
npm run test:all        # unit → integration（日常/CI 就这一条）
```

`run-layer.mjs` 的用法：

```bash
node tests/run-layer.mjs <unit|integration|e2e|device|all>
node tests/run-layer.mjs integration --only motion   # 只跑文件名含 motion 的
node tests/run-layer.mjs integration --list          # 只列出要跑哪些
node tests/run-layer.mjs integration --bail          # 第一个失败就停
```

它在仓库根目录用子进程逐个执行用例（历史用例都是「自执行 + `process.exit()`」，同进程 `import()`
会被第一个 `exit` 带走），汇总 PASS/FAIL 与耗时，任一失败退出码非 0。用例如果改写成 `node:test`
风格（文件里 `import 'node:test'`），runner 会自动改用 `node --test <file>`。
`tests/integration/` 里「自己起静态服务」的用例（internal-build / motion / diagnostics /
diagnostics-contract / auto-title）**不吃外部 `APP_URL`**，runner 会把 `APP_URL` 清空；其中 auto-title / diagnostics-contract 已使用随机临时端口，其余仍沿用历史默认端口。

| 层 | 命令 | 预计耗时 | 前置条件 |
| --- | --- | --- | --- |
| unit | `npm test` | < 5s | 无（不启浏览器，不需要产物） |
| integration | `npm run test:integration` | 8~15 分钟（18 个文件） | `npx playwright install chromium`；**标准构建**（`pnpm build` 后把 `dist/` 挂在 `APP_URL`，默认 `http://127.0.0.1:5181`）；内测类用例还要一份**内测构建**在 `dist/`（或 `DIST_DIR` 指定） |
| e2e | `npm run test:e2e` | 1~2 分钟 | `E2E_API_KEY`、真上游可达、`dist/` 已部署在 `E2E_APP_URL`；`diagnostics-upload` 还要能访问反馈后端 |
| device | `npm run test:device` | 3~8 分钟 | 已启动的 AVD（`-memory 1280`）+ `adb` + 一份装好的 APK |

### 单个文件单独跑（调试时最常用）

每个文件都能单独执行，cwd 必须是**仓库根目录**：

```bash
node tests/unit/openai-adapter.test.mjs
APP_URL=http://127.0.0.1:5181 node tests/integration/request-body.test.mjs
pnpm build:internal && DIST_DIR=$PWD/dist PORT=5291 node tests/integration/internal-build.test.mjs
E2E_API_KEY=sk-xxx node tests/e2e/real-upstream.test.mjs
```

### 各文件的前置条件（重要，别一视同仁）

| 文件 | 需要什么 |
| --- | --- |
| `integration/paths` `provider-anthropic` `caps` `request-body` `upstream-html` `probe-auth` `probe-nokey` `legacy-config` `url-import-web` `url-import-native` `url-import-stages` `full-acceptance` | 一份**标准构建**挂在 `APP_URL`（显式传；别指望某个默认端口是干净的）；语音相关用例要求 `127.0.0.1` 这类安全上下文 |
| `integration/internal-build` `motion` `mode-switch` `diagnostics` | 一份**内测构建**（`pnpm build:internal`）在 `dist/`；用例自己起服务、端口自动分配（`PORT` 可注入） |
| `integration/auto-title` `diagnostics-contract` | 预构建标准包 `STANDARD_DIST_DIR`（默认 dist-standard）；contract 另需内测包 `DIST_DIR`。只读复用、不隐式构建；自建服务默认随机 loopback 端口 |
| `integration/feedback-scroll` | 产物默认复用标准包 `dist-standard/`（`DIST_DIR_STANDARD` / `DIST_DIR` 可注入，原写死 `dist-scroll` 但没有任何流程产出它）；端口自动分配（原写死 5418）；单次约 200s，跑全量请带 `--timeout-ms 300000` |
| `integration/provider-channels` `ours-services` `feedback-export` `copy-limit` | 预构建标准包（默认 dist-standard / 各自 `DIST_*` 变量），只读复用、不隐式构建；端口自动分配 |
| `integration/mode-switch-plain` | 只需要当前标准包（默认 dist-standard）；baseline 基准读 `tests/fixtures/input-row-baseline.json`，想比真实旧产物再传 `BASELINE_URL` |
| `e2e/real-upstream` | `E2E_API_KEY` + 真上游；**跑之前确认上游 IP 没被绑在 lo 上**（`ip addr del 123.207.199.196/32 dev lo`） |
| `e2e/diagnostics-upload` | 真实反馈后端可达（会真的提交一条反馈） |
| `device/url-import-device` | AVD + `adb`；脚本自己起 5227 提供 20MB 导入包 |

## 4. 哪些不用跑

- **`device/`**：需要模拟器，CI 和日常开发都不跑，只在改动「从链接导入 / CapacitorHttp」时手动跑。
- **`e2e/`**：要真 key、真上游、真后端，只在**发版前**跑；`diagnostics-upload` 会往真实后端写数据，别在联调时乱跑。
- **`integration/` 里的 `mode-switch-plain`、`auto-title`、`diagnostics-contract`**：要临时构建/占端口，改到相关代码时才跑。
- **`tools/`**：不是测试，是人工排障脚本（例如 `diagnostics-blind-export.mjs` 导出真实反馈 body）。
- CI 只需要：`pnpm install && npx playwright install chromium && npm run test`（再可选 `npm run test:integration`，前提是 CI 里有构建产物）。

> 集成层的完整跑法、产物要求、端口策略与**基线比对**见 [`docs/testing.md`](../docs/testing.md)；
> 分级门禁（L0/L1/L2）与「这次改该跑哪些用例」见 [`docs/TESTING-POLICY.md`](../docs/TESTING-POLICY.md)。

## 5. 写新测试的约定

1. **放哪层**：纯函数/协议翻译 → `unit/`；要浏览器或 HTTP mock → `integration/`；要真上游/真后端 → `e2e/`；要模拟器/真机 → `device/`。
2. **命名**：`<被测对象>.test.mjs`，不用 `.spec`。
3. **必须能单独跑**：cwd 一律假设仓库根；跨文件的公共逻辑放 `helpers/`，样本/ mock 放 `fixtures/`，**不要**用相对路径跨层硬拼。
4. **文件头模板**（新文件请照抄，第一行就是 runner 用的层标记）：

```js
// [layer: integration | 依赖: playwright + chromium + 5181 标准构建 | 耗时: ~40s]
// 被测对象：设置页「测试」按钮发出的探测请求
// 前置：APP_URL 上的标准构建；上游用 page.route 打桩，不连外网
// 断言：……
```

5. **单文件不超过 500 行**。超了就拆文件（按场景拆），不要学 `integration/full-acceptance.test.mjs`。
6. **自己起服务就自己收拾**：`spawn` 出来的静态服务/mock 务必在 `finally` 里 kill，端口用 `process.env.PORT || 默认值` 便于并发。
7. **不要引入 jest/vitest/mocha**：`unit` 层用自建 `ok()` 或 `node:test` 都行，runner 两种都支持。

## 6. 常见坑

1. **别再建 `tests/node_modules` 软链**。它曾指向某台机器的绝对路径（`<别人家目录>/deepseek-web/node_modules`），别人那边根本不存在，导致「本机能跑、clone 下来全挂」。依赖统一从根 `package.json` 装。
2. **真上游测试要 `E2E_API_KEY`**，只走环境变量：`E2E_API_KEY=sk-xxx npm run test:e2e`。没有这个变量脚本会直接告诉你缺什么。
3. **模拟器要 `-memory 1280`**：`-memory 2048` 会把这台 4G slice 打满后卡死。
4. **断网测试用 `ip link set eth0 down`**：`svc wifi disable` 在 AVD 上无效（模拟器没有 wifi service 状态）。
5. **内测包和标准包别混**：内测包 `pnpm build:internal`（上游/模型/服务类型钉死，设置页只剩 API Key），标准包 `pnpm build`（可自填地址）。内测类用例必须配内测包，标准类用例必须配标准包，否则断言会从「UI 没入口」开始一路失败。
6. **上游 IP 绑回环只影响 e2e**：集成层用 `page.route` 打桩，不需要绑 IP；跑 `e2e/real-upstream` 前要 `ip addr del 123.207.199.196/32 dev lo`（脚本会自检并给提示）。
7. **`dist-standard/` 是测试用的标准产物**：由你自己 `DIST_OUT=dist-standard` 构建（用例不再隐式构建，缺就 `SKIP(env)` 并打印构建命令），已 gitignore；别把它当部署产物。
8. **默认 180s 单文件超时会伪装成用例失败**：`feedback-scroll` 单次约 190~200s，跑全量带 `--timeout-ms 300000`（或单跑它时带 `--timeout-ms 600000`）。
9. **端口冲突会伪装成断言失败**：静态服务端口被占时脚本会连到别人那份产物，看起来像产品坏了。自建服务的用例统一走
   `tests/helpers/env.mjs` 的 `serveDir()`（内部复用 `runtime.serveDist` 的 0 号端口原子分配），开跑前还会校验端口上那份产物的
   `build-info.json`；不匹配就打印 `SKIP(env)` 而不是失败。跑之前也可以 `ss -ltnp | grep 5181` 看一眼。

## 7. 发版前必须跑哪几条

```bash
pnpm install && npx playwright install chromium   # 一次性
pnpm build:internal && npm run test:integration -- --only internal-build
npm test                                          # unit
pnpm build                                        # 标准包
npm run test:all                                  # unit + integration
E2E_API_KEY=sk-xxx npm run test:e2e               # 真上游握手（发版前必跑）
```

清单（按顺序勾）：

- [ ] `npm test`（unit）通过
- [ ] `npm run test:integration` 通过（含 internal-build / motion / diagnostics）
- [ ] `E2E_API_KEY=sk-xxx npm run test:e2e` 通过（真 key + 真 UI + 真上游）
- [ ] 改动涉及「从链接导入」时：`npm run test:device` 通过
- [ ] 产物用的是发版对应的那一种（标准包 / 内测包），没有拿错 `dist/`

## 8. 旧名字对照表（供老文档、老 CHANGELOG 参照）

| 以前 | 现在 |
| --- | --- |
| `tests/test.openai-adapter.spec.mjs` | `tests/unit/openai-adapter.test.mjs` |
| `tests/test.paths-deepseek.spec.mjs` | `tests/integration/paths.test.mjs` |
| `tests/test.provider-anthropic.spec.mjs` | `tests/integration/provider-anthropic.test.mjs` |
| `tests/test.caps-anthropic.spec.mjs` | `tests/integration/caps.test.mjs` |
| `tests/test.request-body.spec.mjs` | `tests/integration/request-body.test.mjs` |
| `tests/test.upstream-html.spec.mjs` | `tests/integration/upstream-html.test.mjs` |
| `tests/test.probe-auth.spec.mjs` / `test.probe-nokey.spec.mjs` | `tests/integration/probe-auth.test.mjs` / `probe-nokey.test.mjs` |
| `tests/test.legacy-config.spec.mjs` | `tests/integration/legacy-config.test.mjs` |
| `tests/test.internal-build.spec.mjs` | `tests/integration/internal-build.test.mjs` |
| `tests/test.motion.spec.mjs` | `tests/integration/motion.test.mjs` |
| `tests/test.auto-title.spec.mjs` | `tests/integration/auto-title.test.mjs` |
| `tests/mode-switch-acceptance.mjs` | `tests/integration/mode-switch.test.mjs` |
| `tests/mode-switch-plain-regression.mjs` | `tests/integration/mode-switch-plain.test.mjs` |
| `tests/test.url-import-web.spec.mjs` / `-native` / `-device` | `tests/integration/url-import-web.test.mjs` / `url-import-native.test.mjs` / `tests/device/url-import-device.test.mjs` |
| `tests/test.diagnostics.spec.mjs` | `tests/integration/diagnostics.test.mjs` |
| `tests/test.diagnostics-contract.spec.mjs` | `tests/integration/diagnostics-contract.test.mjs` |
| `tests/test.diagnostics-e2e.spec.mjs` | `tests/e2e/diagnostics-upload.test.mjs` |
| `tests/e2e-real-upstream.spec.mjs` | `tests/e2e/real-upstream.test.mjs` |
| `tests/run-acceptance.mjs`（36KB 巨型套件） | `tests/integration/full-acceptance.test.mjs` |
| `tests/helpers.mjs` / `archive-fixture.mjs` / `mock-anthropic.mjs` | `tests/helpers/helpers.mjs` / `tests/fixtures/archive-fixture.mjs` / `tests/fixtures/mock-anthropic.mjs` |
| `tests/package.json`（自带 playwright 依赖） | 删除，依赖统一由根 `package.json` 提供 |
