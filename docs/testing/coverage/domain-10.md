# 域 10：发布与更新 —— 功能点盘点与覆盖映射（最小充分集版）

| 项 | 值 |
| --- | --- |
| 母单 | #362（功能点收集与分层测试覆盖盘点） |
| 本文件范围 | **域 10 发布与更新**；只盘点与文档，不写测试、不改源码、不部署 |
| 读码基准 | `/root/worktrees/deepseek-internal-beta10` @ `f182748`（= 该树 `origin/main`，2026-11-19 21:0x）。行号均指此树 |
| 盘点日期 | 2026-11-19 |
| 涉及代码 | 客户端 `src/services/{updateManifest,appUpdate,updateFailure,updateReport}.ts`、`src/components/settings/AppUpdateField.tsx`、`android/…/{AppUpdatePlugin,UpdateEndpoint}.java`；发布侧 `scripts/release-{common,check,upload,verify}.mjs`、`scripts/validate-releases-manifest.mjs`、`scripts/check-manifest-fixtures.mjs`、`deploy/dl-release/{server,variant,apk-manifest}.mjs`、`shared/build-types.{mjs,d.mts}`；CI `.github/workflows/{ci,release}.yml` |

**本域特点**：判断类逻辑（解析 / 校验 / 枚举 / 选择 / 文案）几乎都能 L0 钉死；"真的更新成功"（下载、校验、安装、镜像、上传接口）只能 L1–L3。
**盘点口径（本次修正后）**：目标不是"每条路径一条用例"，而是**用表驱动矩阵把同类分支压成一条**——下面 §3 的落地方案里，**覆盖 22 个功能点只需新增 5 条用例**，同时靠合并现有用例净减 29 条。

## 0. 口径

### 0.1 分层映射（仓库分层 ↔ #362 分层）

| 仓库层 | 依赖 | 本文登记为 | 备注 |
| --- | --- | --- | --- |
| `tests/unit` | 纯 Node，零浏览器 | **L0** | 直接 `import` 源码 `.ts`；也能 `spawnSync` 跑门禁脚本 |
| `tests/integration` | Playwright + 真实 dist + 打桩上游 | **L1** | 按 #362 语义多已具 L2 性质（真实 DOM） |
| `tests/e2e`、`tests/device`、手工 `offline-check.sh` | 真上游 / AVD / 真 APK + aapt2 / 起真服务 | **L3 或手工** | `deploy/dl-release/test/*` 其实是"零 Android SDK 可跑的 L1"，**#415 已接进 `run-layer` 的 `server` 层 + CI 的 `pnpm run test:dl-release`**（取舍见 `docs/TESTING-POLICY.md` §12） |

`✓` 该层有断言；`部分` 只覆盖部分分支；`—` 无；`需真机/手动` 只有 L3 手段；`⁺` = 用例存在但**未接任何执行入口**（"写了但没人跑"）。

### 0.2 覆盖状态取值（照 #362）

`已覆盖` / `部分覆盖（缺异常分支）` / `未覆盖` / `不适用（无自动化）`。

---

## 1. 功能点表（22 项）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F10-01 | 点「检查更新」即自动检查并给结论 | 设置 → 应用更新 → 检查更新 | 弹窗打开即检查：先「正在检查更新…」，之后是新版本（版本号 / 大小 / 更新说明）或「已是最新」 | 见 F10-10；诊断区显示版本/渠道/更新服务/最近检查 | — | 部分 | — | — | **部分覆盖（缺异常分支）** | #310 #172 |
| F10-02 | 首选分发机挂了自动回退，下载地址跟着回退走 | 同上（内部） | 先打 `http://62.106.70.167:8888`，失败/清单脏再打 `https://dl.rose7.cn`；相对 `file` 拼在**真正回了清单**的 base 上 | 两台都挂 → 归类文案 | ✓ | — | — | — | **已覆盖** | #268 #330 |
| F10-03 | 清单不合法就整份拒收（不静默跳坏条目） | 同上（内部） | 任一记录 `buildType`/字段/路径非法 → `INVALID_RELEASE`；非 JSON、>2MB、>2000 条同样拒 | 「版本信息无法解析」——明说不是设备问题 | ✓ | — | — | — | **已覆盖** | #330 #310 |
| F10-04 | 首台回 200 但清单脏，也要试下一台 | 同上（内部） | 解析失败继续下一台并沿用该台 base；两台都脏抛**首个解析错误** | 归 `manifest` 类，不冒充「连不上」 | ✓（web） | — | — | 需真机（原生） | **部分覆盖（缺异常分支）** | #330 |
| F10-05 | 内测包只装内测包；变体不明就不下载 | 同上（内部） | 只取 `artifactVariant` 相同的记录；标记缺失 → `VARIANT_MISSING`，绝不默认 standard | 「当前安装包信息缺失」 | ✓ | — | — | 需真机（`verify()`） | **部分覆盖（缺异常分支）** | #268 #310 |
| F10-06 | 只升不降；同 versionCode 歧义必须报错 | 同上（内部） | 仅取 `versionCode > current`；同 code 两条 → `AMBIGUOUS_RELEASE`；旧 WebView 无 `toSorted` 也能跑 | 归 `manifest` 类 | ✓ | — | — | — | **已覆盖** | #330 |
| F10-07 | 切换「稳定版 / 稳定版+预发布」后自动重查 | 弹窗内下拉 | 切换即重查；渠道只影响**筛选**，不影响请求地址 | 文案写明是哪个渠道 | 部分 | — | — | — | **部分覆盖（缺异常分支）** | #310 |
| F10-08 | 下载 APK：进度、缓存复用、可取消 | 弹窗 → 确认下载 | 进度实时；命中**已校验**缓存 → 「已复用并校验缓存」 | 取消 →「已取消下载」；校验失败附已下载量 | ✓ | — | — | 需真机 | **部分覆盖（缺异常分支）** | #310 #311 |
| F10-09 | 安装：系统安装器 / 未知来源授权 / 返回后需再点一次 | 下载完成 → 安装更新 | 打开系统安装界面；无权限先跳设置，回来仍需再点 | `permission-required` / 「安装包校验失败」 | — | — | — | 手动 | **不适用（无自动化）** | #60 |
| F10-10 | 失败时一眼看出哪一类、要不要重试 | 任意失败 | 9 类：network/service/manifest/integrity/download/no-version/env/cancelled/unknown；5xx 可重试、4xx 与数据类不可 | 文案不含 URL/IP/堆栈/`Error` 前缀 | ✓ | — | — | — | **已覆盖** | #310 |
| F10-11 | 没新版也说清渠道、当前版本、为什么没得装 | 检查后无新版 | 含版本 + 渠道；有缺 `sha256`/渠道的记录时报「另有 N 条不可用」 | — | ✓ | — | — | — | **已覆盖** | #310 |
| F10-12 | 一键复制诊断信息 | 弹窗诊断区 | 字段顺序固定；地址只到 `host[:port]`；整段过 `scrubReportText` | 复制失败 →「请长按选择」 | ✓ | — | — | — | **已覆盖** | #310 |
| F10-13 | 非 Android（网页预览）降级为「下载 APK」链接 | 同上 | 渲染 `releaseUrl(file, base)` 的 `<a>` | 非法路径/第三方 base → `INVALID_APK_URL` | 部分 | — | — | — | **部分覆盖（缺异常分支）** | #268 |
| F10-14 | 更新说明很长时弹窗内容区可独立滚动 | 弹窗 | 内容区滚动、最后一条可达、底部按钮不被挤出（390/360） | — | — | ✓ | — | — | **部分覆盖（缺异常分支）** | #172 |
| F10-15 | 发布渠道枚举只有一份定义，四处都认同一份 | 客户端 / 脚本 / 校验器 / 服务端 | 只允许 `stable`/`prerelease`；`release`/`debug` 是 Gradle 构建类型 | 客户端 `INVALID_RELEASE`、脚本 `exit 2`、校验器 FAIL、服务端 400 `BAD_BUILD_TYPE` | ✓ | — | — | — | **已覆盖** ⁺ | #330 |
| F10-16 | 清单校验器真的还活着（11 条事故逐条报出） | `check:manifest` | 2 份合法必过、7 份 invalid 必拦、事故 11 条逐条 | 任一不符 `exit 1` | ✓ | — | — | — | **已覆盖**（已接 CI） | #330 |
| F10-17 | 上传接口契约：multipart / 鉴权 / 体积 / 限流 | `release-upload.mjs` | 200 + 回包 `sha256` 一致；401/400/409/413/429 各有短码与处置建议 | 按状态码给出重试/别重试/先 bump | — | — | — | 部分（手工） | **部分覆盖（缺异常分支）** | #107 #60 |
| F10-18 | 防降级：versionCode 必须超过线上 latest | 脚本 + 服务端 | `release-check --manifest` 提前拦；服务端 409 `VERSION_CONFLICT` | 明确提示先 bump | — | — | — | 部分（手工） | **部分覆盖（缺异常分支）** | #107 |
| F10-19 | debuggable 包四道门都拦（构建/上传/服务端/镜像） | 全链路 | 任一处命中即禁止；判不出来也算不通过 | 400 `APK_DEBUGGABLE` / FAIL / CI 红 | ✓ ⁺ | — | — | 部分（手工） | **部分覆盖（缺异常分支）** | #60 #84 |
| F10-20 | 变体由 APK 真相决定，`meta` 说了不算 | 上传 | 标记优先 > sha256 白名单；矛盾 409 `VARIANT_CONFLICT`；判不出**不写**字段 | 记录无 `artifactVariant` → App 不自动更新 | ✓ ⁺ | — | — | 部分（手工） | **部分覆盖（缺异常分支）** | #268 |
| F10-21 | 版本号只有一个来源（package.json → 清单 → APK → tag） | 发版全链路 | Gradle 读 `package.json`；`release-check` 复核 APK 内 versionName/Code；tag 必须 `v<version>` | 缺字段/格式错/对不上 → FAIL，不猜 | — | — | — | — | **未覆盖** | #107 |
| F10-22 | 打 tag 即镜像发布到 GitHub Release | `push tag v*` | 版本必须在 `releases.json`、MD5 一致、复检 debuggable、幂等覆盖 | 任一步 `exit 1`，绝不带 404 静默放出 | — | — | — | — | **未覆盖** | #107 #84 |

**计数：22 项 —— 已覆盖 8 / 部分覆盖 11 / 未覆盖 2 / 不适用 1。**
层级：**L0 有断言 15 项**（13 项 ✓ + 2 项只覆盖部分分支 F10-07/13；其中 2 项带 `⁺`，属「写了没接线」）、**L1 仅 2 项**、**L2 0 项**、L3 8 项。
**有 5 项功能点（F10-17/18/19/20/22）的断言只存在于手工脚本或根本不存于执行入口** —— 这是"看起来有门禁"的主因。

---

## 2. 门禁有效性矩阵（一张表吃「CI 的 12 道 + 8 道关键未接线」门禁，不按门禁造用例）

现状：`ci.yml` 共 **17 步 = 4 步基础设施 + 12 道门禁 + 1 条负向对照注入**（`grep -c '      - name:'` → 17；`run: pnpm run` → 11 条 + unit 1 条）。负向对照的形态目前有 **4 种并存**（CI 现场注入 / L0 单测注入 / 脚本自带 `--selftest` / fixture 正反矩阵），这正是应该收敛成一套模板的地方——见 §3.2 的 N2。

| # | 门禁 | 守什么 | 接线? | 负向对照形态 | 有效性 | 假绿来源 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | `check:hygiene` | 仓库卫生 | CI:48 | **无**（脚本里的"负向"只是正则负向前瞻，不是负向对照） | ❌ | 新增垃圾文件不会红 |
| G2 | `check:dup-impl` | 重复实现 | CI:51 | **无**（`neg316` 分支上做过一次性注入，已回滚） | ❌ | 第二份实现落地无人拦 |
| G3 | `type` | TS 类型 | CI:54 | **无** | △ | `tsconfig.include` 只有 `["src","rspack.config.ts"]`——`scripts/`、`deploy/` 完全不在类型检查内，无任何断言 |
| G4 | `lint` | oxlint | CI:57 | **无** | △ | 范围写死 `oxlint src rspack.config.ts`，发布脚本/服务端不 lint |
| G5 | `unit` | 逻辑 | CI:64 | 部分（`run-layer` 空选择/层缺失 → 非零；`t.skip` 只打印不判红） | △ | NODE-SKIP 不判红 |
| G6 | `build:internal` | 可构建 | CI:67 | 无 | △ | 构建失败天然红；产物陈旧不拦 |
| G7 | `check:bundle-target` | 产物语法目标 | CI:71 | 部分（`legacy-bundle-target.test.mjs` 7 条，含产物自检 E-1） | △ | 无"注入新语法必须红"的反证 |
| G8 | `check:legacy` | ES 特性下限 | CI:74 | **有（CI 现场注入 `?.`/`??=`，ci.yml:94-105）** | ✅ | — |
| G9 | `check:matrix` | 兼容矩阵 | CI:77 | **有（L0「负向 1/2/3」）** | ✅ | — |
| G10 | `check:ip` | 硬编码 IP | CI:80 | **有（L0 正反对，真 IP 照报）** | ✅ | — |
| G11 | `check:manifest` | 清单校验器 + 11 条事故 | CI:86 | **有（内置「合法必过/非法必拦/事故逐条」+ L0 复刻）** | ✅ | 唯一缺口：脚本与 L0 单测有两份等价断言（重复覆盖） |
| G12 | `check:log-coverage` | 埋点覆盖 | CI:92 | 有工具（`--selftest` 三反例），但 **CI 调用时没带 `--selftest`** | △ | selftest 只在人记得跑时生效；且不带 `--strict`（baseline 缺口） |
| G13 | `check:guard` | 兜底页 ES5 守卫 | **未接线**（只在 `pnpm run check:guard`） | **有（`guard-es5-gate.test.mjs` 正+反）** | ✅但未接线 | — |
| — | `check:identity` | 身份字面量 / 证书 / 明文更新传输 | **未接线** | **无** | ❌ | 与 F10-02 裸 HTTP 决策耦合，改坏了不红 |
| — | `check:apk` | debuggable | 仅 `release.yml` + 人工 | 部分（`apk-manifest.test.mjs` 有真 debuggable 反例，未接线） | △⁺ | 本地门禁无人跑 |
| — | `check:keystore` / `check:icon` / `check:limits` / `check:compat-baseline` | 各自领域 | **未接线** | 无 | ❌ | 只写在文档里 |
| — | `check:endpoints` / `check:docs`（文档引用门禁） | 端点单一真相 / 文档里的 `文件:行` 还指得着吗 | **均已接线**：`check:endpoints` 由 #413 接进 CI；`check:docs` 本轮接进 CI（`checks` job 的 `check:doc-refs` + 一条负向对照） | 两条都有负向对照（CI 现场注入） | ✅ | 接线前 `check:docs` 在 main 上躺着 23 条 FAIL，其中 15 条是脚本按目录名跳过 `docs/testing/coverage/` 造成的假红 |
| — | `deploy/dl-release/test/*.test.mjs`（34 条，全绿） | 变体 / debuggable 解析 / 服务端 buildType + MANIFEST_DIRTY + 上传契约矩阵 | **#415 已接线**：`run-layer` 的 `server` 层（`node tests/run-layer.mjs server`）+ CI `checks` job 的 `pnpm run test:dl-release`（紧跟 `check:manifest`） | 有（自带正反） | ✅ | 本域曾经最大的"写了但没人跑"，已成历史 |
| — | `release:check` / `release:verify` | 版本号单一来源 / tag 一致 / 防降级前置 | 手工 | **无（零单测）** | ❌ | F10-21 / F10-22 的唯一实现，全裸奔 |

**三句话结论**：① 真正"能自证"的门禁只有 5 道（G8–G12、G13）；② 本域最相关的 `check:identity` / `check:apk` / `release:check` 全裸奔；③ ~~`deploy/dl-release/test` 24 条绿测试不在任何执行入口~~ —— **#415 已修**：34 条进了 `run-layer` 的 `server` 层与 CI，且布局门禁（白名单不免检）+ `domain10-gate-wiring` W2 三重钉住入口，删任何一处都会红。

---

## 3. 落地方案：新增 5 条（表驱动）+ 减 29 条

### 3.1 先做减法（现有用例合并/删除）

| 现状 | 条目数 | 处置 | 之后 | 减 |
| --- | --- | --- | --- | --- |
| `tests/unit/app-update.test.mjs`（12）+ `update-failure.test.mjs`（8）+ `update-manifest-compat.test.mjs`（2）+ `releases-manifest-buildtype.test.mjs`（12） | 34 | 合并为 **`tests/unit/update-matrix.test.mjs`**：一张 `parseManifest/selectUpdate/releaseUrl/fetchManifest/classify` 矩阵（12 行），共享构造器；断言不删，只去重 | 12 | −22 |
| `deploy/dl-release/test/{variant,apk-manifest,server-buildtype}.test.mjs` | 24 | 前两个（18 条）保留**不动**（纯函数 + 最小编码器，已被服务端用例复用）；只把它们**接进执行入口**（#415 已落地：`server` 层 + CI 步骤；实测该目录现为 34 条 = 这 24 条 + `domain10-server-contract` 的 10 条） | 34 | 0 |
| `deploy/dl-release/test/offline-check.sh`（8 组手工断言） | 8（手工） | 其中 6 组（401 / 非 APK / 降级 409 / 变体冲突 409 / 幂等覆盖 / debuggable 拒收）**搬进 §3.2 的 N3**；脚本只留 2 条真 APK + 真 aapt2 的 L3 冒烟 | 2 | −6 |
| `tests/integration/update-dialog-scroll.test.mjs` | 1 个自执行文件（无 `test()`，断言内联） | 滚动断言并入 N4，删掉 `DIST_DIR=dist-172` 孤岛（该目录不存在就直接抛错、且不在 `integration-baseline.json`） | 0 文件 | −1 文件 |

**收敛结果：削减 28 个执行单元（−22 条测试 + −6 组手工断言 + −1 个文件），新增 5 条 → 净 −23；同时 24 条 `deploy/dl-release/test` 由"无人跑"变为"每次提交都跑"。**

### 3.2 新增用例（5 条，全部表驱动）

原则：**一条用例 = 一个矩阵 = 一组同构分支**；断言用行表驱动，不复制 `test()`。

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点 ID | 覆盖分支数 | 不可合并原因 |
| --- | --- | --- | --- | --- | --- |
| **N1** `tests/unit/update-matrix.test.mjs` 的矩阵（由上述 4 文件合并而来，见 3.1） | L0 | ✅ 12 行 | F10-02 03 04 05 06 07 11 13 15 | 24 | 与 N4 不可合并：一个是纯函数（无 DOM），一个是真实 DOM；混在一个文件会让 L0 起浏览器 |
| **N2** `tests/unit/release-gate-matrix.test.mjs`：一个 harness 依次跑**全部门禁脚本**，每脚本喂 1 正例 + 1 缺陷注入，断言 `exit 0 / ≠0` 并还原 | L0 | ✅ 9 行（validate / check-manifest-fixtures / check-identity / check-apk-debuggable / check-bundle-target / check-dup-impl / check-hygiene / release-check(`--tag` 对错) / check-guard） | F10-15 16 19 21 | 18 | 与 N3 不可合并：N2 只碰"仓库内静态脚本"，N3 要 spawn 真服务端 + 临时目录 |
| **N3** `deploy/dl-release/test/server-contract.test.mjs`：复用 `server-buildtype.test.mjs` 的**假 aapt2 + 真 ZIP/AXML** harness，扩成上传契约矩阵 | L3(零 SDK 可跑，建议按 L1 计时) | ✅ 8 行（401 错令牌 / 400 非 APK / 413 超限 / 405 方法 / 429 限流 / 409 降级 / 409 变体冲突 / 同版本幂等覆盖） | F10-17 18 19 20 | 16 | 与 N2 不可合并：需起进程 + 端口 + 临时 `releases.json`，成本量级不同 |
| **N4** `tests/integration/update-check-flow.test.mjs`：真实 DOM，route 掉 `releases.json`，弹窗交互 + 文案 + 滚动 | L1 | ✅ 4 行（有新版本 / 无新版本+incomplete / 503 / 切渠道自动重查）× 1 视口（滚动断言沿用 390；360 只在此行加断点） | F10-01 07 10 11 13 14 | 12 | 与 N5 不可合并：N5 要打桩 `nativeUpdate` 桥，N4 只走 web 通道；桥打桩会污染 N4 的"网页预览降级"断言 |
| **N5** `tests/integration/update-install-flow.test.mjs`：打桩 `nativeUpdate`，下载/安装交互 | L1 | ✅ 5 行（进度更新 / 取消 / 缓存复用文案 / `permission-required` / 安装失败可再点） | F10-08 09 | 10 | 同上 |
| **N6** `tests/unit/gate-wiring.test.mjs`：只断言**配置**、不跑业务脚本——`ci.yml` 必须含 11 条门禁命令、`deploy/dl-release/test` 必须出现在 `run-layer` 或 npm script、`which.mjs` 对 `shared/build-types.mjs` 不得映射 0 案例 | L0 | ✅ 3 行 | F10-15 16（防脱钩） | 6 | 不与 N2 合并：N2 红 = 门禁脚本坏了，N6 红 = 门禁被人摘掉了；混一条会分不清该修脚本还是补接线 |

**新增合计：5 条用例（N2 / N3 / N4 / N5 / N6），内部分支行合计 ≈ 49 行，覆盖 22/22 个功能点**（N1 是合并产物，不占新增预算；F10-22 仍需 1 次真实 tag 验证，见下）。

**F10-22（tag 镜像）单独说明**：唯一可自动化的部分是"把 `release.yml` 的 4 段 Python/shell 抽成 `scripts/release-mirror.mjs` 并加 `--dry-run`"，之后在 N2 里加 2 行（版本不在清单 → `exit 1`；MD5 不符 → `exit 1`）。**这属于源码改动，本单不做**，登记为 follow-up，不占新增用例预算。

---

## 4. 证据（本树实测）

```
$ grep -c '      - name:' .github/workflows/ci.yml         # 17（4 基础设施 + 12 门禁 + 1 负向对照）
$ grep -n 'run: pnpm run' .github/workflows/ci.yml         # 11 条（hygiene dup-impl type lint build
                                                           #   bundle-target legacy matrix ip manifest log-coverage）
$ node --test deploy/dl-release/test/*.test.mjs            # tests 24  pass 24  fail 0   ← 但无人执行
$ node scripts/check-manifest-fixtures.mjs                 # 9 fixture + 1 事故断言, FAIL=0
$ node --test tests/unit/{app-update,update-failure,update-manifest-compat,
                          releases-manifest-buildtype}.test.mjs   # 12+8+2+12 = 34 pass
$ node tests/which.mjs shared/build-types.mjs deploy/dl-release/server.mjs
  ! shared/build-types.mjs：不在已知范围（既不是 src/ 也不是 tests/）→ 忽略      ← 改枚举不触发任何 L0
  ! deploy/dl-release/server.mjs：… 回落 unit 全量（121 个用例）
$ grep -n "LAYERS" tests/run-layer.mjs                     # ['unit','integration','e2e','device'] ← 不含 deploy/
```

三条代码事实（非推断）：
1. `deploy/dl-release/server.mjs:398-411` 已有 buildType 白名单（400 `BAD_BUILD_TYPE`，零 I/O），`:552-566` 在落盘前对「新条目 + 现有清单」合并后的整份清单再体检（409 `MANIFEST_DIRTY`）——**#330 的服务端半边已补齐**，但只有 `server-buildtype.test.mjs` 6 条守着，且**不进任何执行入口**。
2. `android/…/AppUpdatePlugin.java:65-80` 的 `try/catch` 只包 `fetchManifest(base)`；解析在 JS 侧（`AppUpdateField.tsx:149-157`），所以 **#330 的"解析失败也试下一台"在原生通道上不成立**。
3. `tests/which.mjs:111` 的反向索引只认 `from '../../src/…'`，`shared/`、`scripts/`、`deploy/` 永远映射不到用例。

---

## 5. 与其它域的边界

设置项持久化归域 9；反馈/采集归域 8；分发站点运维（Caddy/TLS #269）不在本域。本域只到"仓库内三个组件：客户端 / 发布脚本 / dl-release 服务端"。
