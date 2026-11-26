# 门禁台账（红了先开这一页）

本仓有几十道门禁（源码审计脚本、产物扫描、单元/集成/黄金回归、发布校验）。它们此前只以
「CI 里的一个步骤名」+「脚本头注释」的形式存在，于是三个问题没人能当场回答：

- 这道门禁**为什么存在**？它防的是哪个事故？
- 它红了**该找谁**？是我改坏的，还是既有的债？
- 我想**加一道新门禁**，规矩是什么？

本页就回答这三件事。**一页，不是手册**：理由、归属、处置在下面；判据与实现不在本页，
在脚本头和 `docs/TESTING-POLICY.md` §9（见第 6 节）。

> 引用写法约定：本页只写**路径**和**步骤名**，不钉行号 —— 行号会漂，`check:doc-refs` 会红。

---

## 0. 三条规则（先看这里，30 秒）

| # | 规则 | 不满足时 |
| --- | --- | --- |
| R1 | **一道门禁存在的理由，必须能写成一句话的事故**：「因为曾经有人 X，导致 Y」，Y 是用户能感知的后果 | 写不出来 → 这道门禁不该存在（第 4 节 D1） |
| R2 | **红必须可归因**：红了能三秒内判断「是我的改动 / 既有债 / 环境不具备」 | 做不到 → 台账这一行缺「归属」 |
| R3 | **加 / 删 / 豁免都有入口**，且在**做那件事的时候**生效，不是事后审计 | 没入口 → 新门禁靠口头约定，最后退化成「别超过 N 条红」 |

---

## 1. 红了，先做这一步

**先读退出码，再读报错。** 仓里所有门禁脚本共用这套约定（出处：`scripts/check-bundle-target.mjs`、
`scripts/check-bundle-syntax.mjs`、`tests/helpers/env.mjs`）：

| 现象 | 含义 | 第一件事 |
| --- | --- | --- |
| `exit 2` / 抛异常 / `MODULE_NOT_FOUND` | 门禁**没跑起来**（缺产物、缺参数、缺本机密钥、用法错）。这一格等于零覆盖 | 不是你的改动。按台账「归属」列找入口，或按报错补参数；**别把它当成"既有红"糊过去** |
| `exit 1`，报错点名**你这次碰过的文件** | 你改坏的 | 改代码，不改门禁 |
| `exit 1`，报错点名**你没碰过的文件** | 既有债（main 上的红） | 在 `origin/main` 的干净树上复核一次；确认是既有红就**先修 main**，不要在红的基础上叠 PR（`AGENTS.md` 硬规则 5） |
| `SKIP(env)` / `exit 77` | 环境不满足（缺产物、端口上 serve 的不是这份 dist） | 补产物。**SKIP 不是绿**，也不是 known-red |
| `--baseline` 报 `FIXED?` | 基线条目过时（记着红但这次绿了） | 删条目 —— 条目没删就等于没修好（第 5 节 X1） |
| 同一份代码两次结论不同 | flaky / runner-dependent，不是"真红" | 跑 `node tests/run-layer.mjs --cross-runner-scan`（`docs/TESTING-POLICY.md` §11.5） |

**别在这里发明第 4 种红。** 「红但可以忽略」只允许以**基线条目**的形式存在，且必须带
`reason` + 会被自动发现过期的判据（第 5 节）。

---

## 2. 门禁清单

一行的读法：**事故** = 它为什么存在；**拦 / 不拦** = 判据边界（不知道边界时会误改判据）；
**红了第一件事** = 处置；**归属** = 哪类改动会撞上它、谁负责。

### 2.1 仓库与协作

| 门禁 | 一句话事故 | 拦 / 不拦 | 红了第一件事 | 归属 |
| --- | --- | --- | --- | --- |
| `check:hygiene`<br>`scripts/check-repo-hygiene.mjs` | #291：有人把 745 个取证产物（71.3 MiB）和 69 个写着 `<盘符>:\all_project\…` 本机绝对路径的文本提交进 `docs/`，导致 `git grep` 被截图路径刷屏、别人照那个路径复现只得到「文件不存在」 | 拦：仓库内文本里的本机绝对路径（Windows 盘符 / `/home/<user>` / MSYS 形态）、单文件超 512 KiB 的文本。不拦：二进制截图本身（那是 `check:ui-shots` 与 `.gitattributes` 的活） | 看命中的是不是你这次加的文件；历史文件先确认是否在脚本的豁免前缀里，**不要调阈值** | 任何提交；最常撞的是「拷了日志/截图进文档」 |
| `check:eol`<br>`scripts/check-eol.mjs` | #323：30 个改动文件里 27 个只有行尾不同，`+8126/−7757` 大半是 CRLF 噪音，导致「17 个真实冲突」被放大成 19 文件 21 hunk，review 看不清改了什么、`git blame` 失效 | 拦：git 跟踪的文本文件里的 CRLF（豁免口径来自 `.gitattributes`：`*.bat` / `*.cmd` / 二进制）。不拦：文件内容 | `node scripts/check-eol.mjs --fix`，并且**单独一次提交**（只改行尾，以后能 `git blame --ignore-rev`） | Windows / `core.autocrlf=true` 环境下的任何提交 |
| `check:dup-impl`<br>`scripts/check-duplicate-impl.mjs` | #289：有人把 ~~scripts/compat/lib/zip.mjs~~ 原样复制成 `tests/adversarial/lib/zip.mjs`（副本已随 #289 的收敛提交删除，此处只作事故记录），导致同一条结论在红队用例与导入取证两边得出**相反**结果，而排查的人先怀疑产品代码 | 拦：`scripts/`、`tests/`、`src/` 下字节完全相同（sha256 相同）的两份文件。不拦：同名但内容不同的工具 | 删副本，或把二者抽成一份共享实现。**别改文件名过闸**（脚本头已经把这条写死了） | 「为了参考旧实现」而复制粘贴的改动 |
| `check:case-collision`<br>`scripts/check-case-collision.mjs` | #557：有人在 `src/components/consume/` 并存 4 对只差大小写的模块，导致 Linux CI 全绿、macOS/Windows 上 `tsc` 报 TS1261 且 rspack 报「导出找不到」，产物一路漂到 main | 拦：仅大小写不同的文件/目录名与模块 stem。不拦：真正的重名 | 改其中一个的名字（不是改扫描范围） | 新增文件时的命名（尤其在 macOS 上提交） |
| `check:test-layout`<br>`scripts/check-test-layout.mjs` | #362/#366：`tests/regression` 12 个文件写了却不在 `run-layer.mjs` 的 `LAYERS` 里，导致「写了、没人跑、不会红」 | 拦：枚举不到的孤儿用例、层级目录里建子目录、命名不合 `domain-NN-*`。不拦：`tests/gates/` 里的夹具（非 `*.test.mjs`） | 把文件挪进能被枚举的层；确实需要新层就改 `run-layer.mjs` 的 `LAYERS`，**不是加基线** | 新增测试文件 |
| `check:test-duplication`<br>`scripts/check-test-duplication.mjs` | #362 阶段二：L1 反复断言 L0 已覆盖的纯逻辑、90 个文件各抄一份装配，导致一处零边际，而这类重复只能靠人读 diff 才发现 | 拦：R1 连续 20 行逐字相同 / R2 同主题关键词跨层 / R3 用例标题跨层同名。不拦：看着像但语义不同的用例 | 先判断该削哪一层（上层重复下层 → 删上层的断言）；确实要留就进 `tests/test-duplication-baseline.json` 并写 reason + issue | 新增/复制用例 |
| `check:doc-refs`<br>`scripts/check-doc-refs.mjs` | #290/#240：手修过一轮 docs 行号漂移，没有门禁又漂一遍，导致 33 处引用指到空行或孤立的 `}`、10 处指向根本不存在的文件，照文档去查的人扑空 | 拦：`路径[:行]` 指不到（不存在 / 越界 / 落在空行或结构行）。不拦：`~~删除线~~` 的已删除路径（计数但不判红）、`EXEMPT_PREFIXES` 里的历史取证 | 先 `node scripts/check-doc-refs.mjs --audit-skipped` 看全貌；改引用时**优先用函数名/常量名定位**，别钉行号 | 任何文档改动（含生成的表格） |
| `check:ui-shots`<br>`scripts/check-ui-shots.mjs` | #661：`docs/ui` 只进不出，553 张截图里 155 张（17.4 MiB）在仓库任何文本里都查不到一处引用，导致 `git grep` 被路径刷屏、而谁的结论都不依赖它们 | 拦：孤儿截图（无人引用）、悬空引用（文档写了但文件不在）。不拦：`docs/ui/README.md` 里声明的目录级 / 通配引用 | 确认这张图是不是某次验收的证据：是就补进对应 README 的结论表，不是就删 | 加/删截图 |
| `check:issue-close-keywords`<br>`scripts/check-issue-close-keywords.mjs`<br>**无别名、未接线，手动跑** | #362 事故（PR #389）：正文写「Closes #362? 不——」本意是否定，而 GitHub 只看字符串，导致 squash 合并后 1 秒自动关掉追踪母单，之后 1 小时 24 分里所有人都以为阶段二完成了，剩余 3/5 没人承接 | 拦：PR 正文的 closing keyword 指向 `[TRACK]` / `[追踪]` 单。不拦：指向普通 issue（允许自动关闭） | 把正文里那串字改成 `Refs #N`，连否定句一起删 | 任何写 PR 正文的人 |

### 2.2 源码契约

| 门禁 | 一句话事故 | 拦 / 不拦 | 红了第一件事 | 归属 |
| --- | --- | --- | --- | --- |
| `check:ip`<br>`scripts/check-hardcoded-ip.mjs` | #181：三代写死 IP（`123.207.199.196` → `62.106.70.167` → `140.210.13.146`）全靠 `grep` 自觉迁移，导致漏一处就是线上故障 —— 用户升级后打到一台不存在的机器，界面只会转圈 | 拦：`src/`、`scripts/` 里写死的上游 IP。不拦：版本号（`1.2.3.4` 形状）与域名，判据见脚本 `--selftest` | 从 `config/endpoints.json` 取地址。别把 IP 藏进一个新常量了事 | 改网络地址 / 加诊断请求 |
| `check:endpoints`<br>`scripts/check-endpoints.mjs` | #274：`feedback.rose7.cn` 这个占位常量从未被替换，导致谁 import 谁打到已下线的主机；而「只改地址、不改白名单」意味着地址有了两份真相 | 拦：配置与 `allowedHosts` / `allowedPorts` 不自洽、废弃域、明文 http、三端点不在同一台机器。不拦：脚本里的本地环回 | 改 `config/endpoints.json` **一处**，并把白名单一起改 | 换域名 / 加端点 |
| `check:consume-api`<br>`scripts/check-consume-api.mjs` | #484 §6.5/#487：有人又一次绕过调用白名单、把 base 写死、把 `device_id` 当凭据，导致审计口径（#484 §三）与实际调用各说各话 | 拦 R1–R8：配置齐全性、base 零字面量、路径白名单、废弃域、明文 http、凭据进 query、原生 BuildConfig 注入。不拦：白名单内路径的重构 | 报错里有 R 编号 + 键名 + 行号；新增路径要先进 `scripts/lib/consumeApiAudit.mjs` 的 `PATH_WHITELIST` 并写清为什么 | 改 `src/services/**` 的请求层 |
| `check:i18n`<br>`scripts/check-i18n.mjs` | #314/#421：`en.ts` 的 `satisfies` 只挡住「zh 有、en 没」，`{count}`/`{total}` 错位不会报错 —— 界面直接把「共 {total} 笔」端给用户；而接线前它不存在于 CI，17 个孤立 key 一路绿着漂到 #421 验收才被发现 | 拦 R1–R5：key 双向齐平、占位符对齐、`t('…')` 引用存在、无新增孤立 key、无空值。不拦：动态拼出来的 key（类型系统与脚本都看不见） | `.ts` 里补/删 key。`ORPHAN_BASELINE` 只减不增 | 加/改文案 |
| `check:redact`<br>`scripts/check-redact.mjs` | #387：脱敏规则里设备码/卡密/卡号/订单号/手机号**一个都没有**，而删掉一条规则既不会让编译失败、也不会让任何别的用例变红，导致自由文本里的敏感值三个边界全漏 | 拦：5 类必填规则存在、不被改宽，含「不许误伤」负例。不拦：某个新字段该不该脱敏（那是 review 的判断） | `node scripts/check-redact.mjs --selftest` 先分清是「规则被删」还是「被改宽」 | 改 `src/services/diagnostics/**` 的脱敏 |
| `check:log-coverage`<br>`scripts/check-log-coverage.mjs` | #301 维度 9：`EventKind` 里躺着从没有调用点的 kind、更新/支付/i18n 关键链路一条日志都没有，导致只有在用户反馈「日志太笼统」时才暴露 —— 那时已经付过一次排查成本 | 拦 R1 死枚举 / R2 关键链路 / meta 空。不拦：日志写得好不好 | 补埋点；确实做不完就进 `scripts/log-coverage-baseline.json`（只减不增，跑绿要删） | 加功能 / 改诊断 |
| `check:db-version`<br>`scripts/check-db-version.mjs` | #547：两个 L1 用例各自硬编码 `indexedDB.open('chat-demo', 12)`，`db.ts` 升到 v13 后报 `VersionError`，导致 CI 真红且报错看上去像用例坏了 —— 其实是版本漂了 | 拦：`tests/`、`src/` 里写死的 DB 版本数字字面量。不拦：`db.ts` 的 `DB_VERSION` 本身 | 改成 import `DB_VERSION` | 升库结构（图片线可能还要升 v14） |
| `check:limits`<br>`scripts/check-limits.mjs`<br>**未接线** | #275：超时/限量阈值散在 9 个文件、20 余个裸字面量里，导致没有人能回答「当前线上生效的停滞阈值是多少秒」，而下一次顺手写一个 `45000` 在 review 里看不出来 | 拦：`WATCHED` 文件里的裸 4 位以上数字。不拦：`src/services/limits.ts` 本身（那是唯一允许写数字的地方） | 把数字搬进 `LIMITS`，或把新阈值来源加进 `WATCHED` | 改超时/限量 |
| `check:icon`<br>`scripts/check-icon-edges.mjs`<br>**未接线（无任何调用点）** | #266：应用图标四边各 2px 的白边没人看，导致图标在启动器/商店里被裁成「东西贴边」，而仓里没有任何一处会因此变红 | 拦：每张应用图标四边各 2px 的纯白像素必须为 0（`strict` 与 `rendered` 两套口径都要过）。不拦：图标好不好看 | 让设计改图；别调 245 这个阈值 | 换图标 / 改 `res/` 素材 |
| `check:identity`<br>`scripts/check-identity.mjs`<br>**未接线** | #271：身份四件事（包名/应用名/证书指纹/是否允许明文更新）分别写死在五处，而包名一换就静默换掉全网老设备的账号身份（设备指纹 = `sha256(androidId + getPackageName())`），导致额度、邀请关系、卡密绑定全对不上 | 拦：身份字面量出现在 `config/appIdentity.json` 之外。不拦：文档、测试样本、Java 包结构、`deploy/` | 把字面量收回 `config/appIdentity.json` | 改包名 / 应用名 / 证书指纹 |
| `check:ios-version`<br>`scripts/check-ios-version.mjs` | #873：`cap add ios` 带进来的是 Xcode 模板写死的 `MARKETING_VERSION = 1.0` / `CURRENT_PROJECT_VERSION = 1`，而仓库版本号的唯一来源是 `package.json`（`version` / `androidVersionCode`，Android 由 `build.gradle` 自己去读；`xcodebuild` 不读 JSON，所以 iOS 这条链从来没人接）。实测漂成「package.json `2.0.1`/`41` vs iOS `1.0`/`1`」时 `type` / `lint` / 全部 L0–L1 / APK 出包**全绿**，直到出 iOS 包才变成 App Store 拒收重复 build 号、两端版本号对不上（用户报的版本查不清） | 拦：`ios/App/App.xcodeproj/project.pbxproj` 里每一处 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` 必须等于 `package.json` 的 `version` / `androidVersionCode`。不拦：版本号该取什么值（那是发版决策），也不拦 `Info.plist` 里的 `$(MARKETING_VERSION)` 引用（本来就是变量） | `pnpm run ios:version`（改 `package.json` 后跑；**别手改 pbxproj**，下一次生成会再分叉一次）。非数字版本（`1.4.0-beta.8`）会 exit 2 让人判 —— iOS 上架版本必须是 1~3 段点分数字 | 改版本号 / 重建 iOS 工程 |
| `check:capabilities`<br>`scripts/check-capabilities.mjs`<br>（已接线，**warn 档**：有缺陷也 `exit 0`）<br>`check:capabilities-docs`<br>（`scripts/gen-capabilities-docs.mjs --check`，**未接线**） | #209/#240/#542：有人照着「Chrome 支持」写了 API/CSS 却没写兜底 → 低内核上静默失效；而 `docs/capabilities/*.md` 的数字靠人抄，抄一半 → `host.md` 55 条引用指不到实时命中 | 拦：JS API / CSS / 宿主能力 / 行为假设的盘点；生成表格与实时复算一致。不拦：哪些命中算缺陷（登记在案，`--strict` 未开） | 用 `pnpm run gen:capabilities-docs` 重算，**不要手改生成的表格** | 用新 API / 写 CSS / 改盘点 |
| `check:refactor-direction`<br>`scripts/check-refactor-direction.mjs` | #484 §九 + #590：重构期 A1–A7 本来就该红，导致「还是重构中」和「真退回去了」分不清，于是没人看；它是等 A1/A4/A6 降到 0 命中之后才接线的（**先全绿再接线**） | 拦：旧体系回流 / 额度搬回本地 / base 写死 / 身份不是 JWT。不拦：具体实现方式（A7 恒为 MANUAL，不计 FAIL） | 看是 A 几，报错里有该项的「该改哪里」 | 改消费 / 额度 / 端点来源 |

### 2.3 产物与兼容

| 门禁 | 一句话事故 | 拦 / 不拦 | 红了第一件事 | 归属 |
| --- | --- | --- | --- | --- |
| `check:bundle-target`<br>`scripts/check-bundle-target.mjs` | #298/#287：单测层那两条同名判据在 `dist/` 不存在时只能声明期 SKIP，导致 CI 报告里长期挂着 `NODE-SKIP 2` —— 产物违规也不会红 | 拦：产物未构建（**红，不是跳过**）、低内核解析不了的语法、裸 `dvh`、缺 polyfill 的内置 API。不拦：产物内容对不对 | `pnpm run build` 后重跑；真红就改 target，不改门禁 | 改构建 target / 升依赖 |
| `check:legacy`<br>`scripts/check-bundle-syntax.mjs` | #13/#104：构建 target 被改回、或第三方依赖带进新语法，导致 Android 11 出厂镜像（Chromium 83）整包解析失败 = 静默白屏，而这类问题在 Chrome / Playwright 上永远测不出来 | 拦：产物里的 ES2021+ 语法与超下限 DOM API。**不拦 `?.` / `??`**（Chrome 80，本来就在 83 能力集里） | 改 `browserslist` / rspack target。`?.` 的白屏要走 `check:syntax-floor` | 升依赖 / 改 target |
| `check:syntax-floor`<br>`scripts/compat/check-syntax-floor.mjs` | #104：产物真实语法下限被抬到 80、而我们对外声明 83，`check:legacy` 因此永远绿 —— 表现就是「OPPO 上白屏 + 抱怨 `Unexpected token '?'`，而门禁全绿」 | 拦：声明值（`config/compat.json`）与产物实测最低内核不一致。不拦：单个 API 的能力 | 看是哪个产物、哪条语法把下限拉下去 | 升依赖 / 改 target |
| `check:guard`<br>`scripts/check-guard-es5.mjs`<br>**未接线**（#285 记为待并入 `check:legacy`） | #104：兜底页内联守卫混进可选链 / 箭头函数，导致 WebView < 80 上「守卫自己也白屏」—— 而那正是最需要它的时候；旧守门员是三条正则，只拦得住写法眼熟的那几类 | 拦：`src/index.html` 的每个内联 `<script>` 必须能被 ES5 解析器解析。不拦：外链脚本 | 改兜底页；别把判据换成「再加一条正则」 | 改兜底页 / 启动守卫 |
| `check:test-seam`<br>`scripts/check-test-seam.mjs` | #487/#510：有人在发版流水线上顺手带上 `TEST_AUTH_SEAM=1`（或 DefinePlugin 注入被改名/删掉，让标识符原样落进产物），导致线上多出一条不用登录的路，且没有任何编译错误 | 拦：**不带**开关构建的产物里出现接缝标识符或假 token。不拦：测试构建（那是 `--expect-seam` 正向对照） | 查构建命令里那串环境变量；判据的唯一来源是 `scripts/lib/testAuthSeam.mjs` | 改构建开关 / 发版流水线 |
| `check:artifact-prefix`<br>`scripts/check-artifact-prefix.mjs` | #836：产物改名改一半（CI 产新名、私有脚本还产老名、接口又一套，三者各自能跑绿），导致直到有人按名字对账才发现下载 404 | 拦 P1–P5：配置合法且不退回历史前缀、生产者零字面量、发布脚本与 CI 同串、`file` 字段两条实现同串、孤儿检测仍认得历史老包。不拦：包内的东西 | 改 `config/appIdentity.json` 的 `artifactPrefix`（唯一来源），别改脚本 | 改产物命名 / 发布脚本 |
| `check:gap`（`scripts/check-css-gap-fallback.mjs`）<br>`check:focus`（`scripts/check-focus-visible-fallback.mjs`）<br>`check:gutter`（`scripts/check-scrollbar-gutter-fallback.mjs`）<br>`check:container`（`scripts/check-container-query-fallback.mjs`）<br>**四道均未接线**（语义由 L0 用例覆盖） | #173/#215/#216/#214：低内核上 `CSS.supports('gap')` 与 `@supports` 都返回 true（假支持）→ 兜底分支不命中、间距依旧 0；`:focus-visible`（Chromium 86）、`scrollbar-gutter`（94）、`@container`（105）在 83 上整条被丢弃 → 键盘用户看不到焦点、滚动条出现/消失时内容横跳、按容器宽度改布局静默失效 | 拦：这四类写法有没有「不依赖它的等价兜底」。不拦：观感与具体数值 | 补兜底（或明确记进脚本的 SKIP 并写明原因）；不要靠 `@supports` 兜底 | 改 CSS |
| `check:compat-baseline`<br>`scripts/check-compat-baseline.mjs`<br>**未接线** | #276：`config/compat.json` 的数字被抄到探针、矩阵、兜底页文案各一份，导致改一处、另外两处永远绿 | 拦：唯一来源自身自洽 + 每个派生点真的 import 它（行为级）。不拦：数值选得对不对 | 让派生点从配置读，别抄数字 | 改兼容下限 |
| `check:matrix`<br>`scripts/compat/check-matrix-config.mjs` + `scripts/compat/matrix-scan.mjs` | #278/#159/#190：出现过「某些档位根本没截，但报告里写着两档已覆盖」，导致兼容性结论是假的 | 拦：档位是否覆盖 `docs/RELEASE-MANUAL.md` 第 8 节要求的档位、能否换算 density、AVD/`webviewTier` 有没有重复或写错、路径能否解析（默认 warning）。不拦：兼容性好不好 | 改矩阵配置；CI 上没有 Android SDK，路径缺失默认不判红 | 改截图档位 / AVD 表 |
| `check:public-artifact-redaction`<br>`scripts/check-public-artifact-redaction.mjs`<br>**不在 ci.yml，发布前手动跑**（见 `docs/RELEASE-CHECKLIST.md`） | #745：已发布的 `1.4.5` / `1.4.6` APK 的 bundle 里都能 grep 出「内网 IP + 高位端口」的 base 地址与分发地址，导致公开分发的包里带着内网入口 | 拦：公开产物里的内网地址与端口（端口表从配置动态派生）。不拦：`redacted.local` 这类占位 | 改 `config/endpoints.json` 的公开口径，或确认这个包本来就不该公开 | 打公开包 / 改端点配置 |

### 2.4 发布与分发

| 门禁 | 一句话事故 | 拦 / 不拦 | 红了第一件事 | 归属 |
| --- | --- | --- | --- | --- |
| `check:manifest`<br>`scripts/check-manifest-fixtures.mjs` | #330：`scripts/validate-releases-manifest.mjs` 早就对非法 `buildType` 判 FAIL，但**没有任何 CI 步骤跑它**，导致 2026-11-19 有 11 条 `buildType:"release"` 一路发到线上，客户端整份清单拒收、更新全挂 | 拦：校验器本身还活着（合法 fixture 必 PASS、每个 `invalid-*.json` 必 FAIL、公网/私有口径分得开）。不拦：线上清单的内容（那是 `check:webroot-hygiene` 的 R4） | 先分清是「fixture 坏了」还是「校验器被改软了」 | 改发布脚本 / 清单 |
| `check:webroot-hygiene`<br>`scripts/check-webroot-hygiene.mjs` | #609/#620（#601 事故）：处置时「从清单里删掉那条 internal 条目」并不够 —— 文件还躺在 `/var/www/dl/apk/` 下，而那是 Caddy 直接 `file_server` 的静态目录，猜到 URL 就能下载（被 6 个外部 IP 下载过） | 拦 R1 取证/备份残留、R2 webroot 内出现非 `apk/` 目录、R3 `apk/` 下出现 internal 包、R4 公网清单出现 internal 条目（清单读不出来也红）。不拦：字段校验（那是 `check:manifest`） | runner 上跑的是内置演练；真 webroot 的扫描在分发机上做（`docs/RELEASE-MANUAL.md` 的部署验收一节） | 分发机操作 / 改清单 |
| `check:private-publish-root`<br>`scripts/check-private-publish-root.mjs`<br>（被守对象：`release:private` = `scripts/publish-private-apk.mjs`） | #601：私有发布脚本的默认站点根是 `/var/www/dl`，导致「按默认参数跑」就等于把内部包写进公网 webroot（事故当晚那条命令一个根参数都没带） | 拦 R1–R5 静态 + B1–B5 行为：默认根、授权行、清单落点。不拦：真的发布动作（不连 ssh、不碰 `/var/www`） | 默认根必须是 `/opt/dl-private`；写公网必须显式 `--site-root` **且** `--allow-public-webroot` | 改发布脚本 / 默认参数 |
| `check:release-traceability`<br>`scripts/check-release-traceability.mjs` | v1.4.5：tag 打在版本号分支的提交上（main 上是 squash 之后的另一个 sha），导致溯源链断裂 —— 「从 tag 复现」checkout 出一棵不在主线上的树，而当时 30 多道门禁全绿，因为没有一道问过「这个 tag 在不在 main 上」 | 拦：tag 是否为 `origin/main` 祖先（判据是**祖先关系**，不是 `git diff tag main`）。不拦：tag 上那棵树与 main 的内容差异 | 重打 tag 到 main 的提交上；确实无法重指才进 `scripts/release-traceability-allowlist.json`（必须 `reason` + `reviewAfter`） | 打 tag（发版收尾） |
| `check:keystore`<br>`scripts/check-keystore-config.mjs` | #272/#697：签名四个键名靠口传，写错一个字母、路径按 `android/app/` 解析、口令/别名错在 gradle 里全都只报「签名不行」，导致新机器接手时无法定位；更贵的是「签名换了一把 key」= 已装用户无法覆盖升级，而这条比对在 #697 之前是**死代码**（期望值还去 `build.gradle` 找，而 #271 之后那里已经没有） | 拦：四键齐全、路径、口令、别名、以及「期望指纹 vs 真实证书」。CI 跑 `--config-only` 降级档，真签名比对在发布机 | 报错会点名「期望 X 实际 Y（来源 `config/appIdentity.json`）」；别去改 `appIdentity.json` 迁就 | 换证书 / 改 gradle / 新机器搭环境 |
| `check:apk`<br>`scripts/check-apk-debuggable.mjs`<br>**无流水线调用点**（debuggable 判据已由 `build-apk.yml` 里的 `verify:apk` 覆盖 → 第 4 节 D4 的合并候选） | #60：`1.0.0`～`1.4.0-beta.8` 共 15 个已发布包全是 debug 变体，导致任何已授权 adb 的机器都能 `run-as` 读私有目录（服务地址 / 会话缓存）或挂 JDWP | 拦：`android:debuggable="true"`；挂在「产物 → 发布」之间。不拦：变体标记 / 证书 / 回环标记（那是 `verify:apk`） | 改发布路径（`assembleRelease`），别指望人记得手敲 `aapt2` | 改出包路径 |
| `check:retention`<br>`scripts/check-retention.mjs`<br>**未接线**（需分发机） | #662：孤儿资源没有到期日 = 永远不会过期，导致没人分得清「哪份能删、哪份是唯一副本」（取证物、回滚备份年复一年堆着） | 拦：`<目录>/.retention.json` 里到期未复审。不拦：过期之后的删除动作（过期 ≠ 立刻 `rm`，只是「该有人做判断了」） | 在分发机上 `ssh aliyun 'cd <repo> && pnpm check:retention'`；`--now` 可注入日期做演练 | 分发机运维 |
| `release:check`（`scripts/release-check.mjs`）<br>`release:upload`（`scripts/release-upload.mjs`）<br>`verify:apk`（`scripts/verify-release-apk.mjs`）<br>`release:verify`（`scripts/release-verify.mjs`）<br>`audit:release`（`scripts/audit-release.mjs`） | #107/#607/#630：发版判据原来散在手工清单里（版本号三处一致、产物存在且 hash 对得上、五件套、线上清单真生效），导致「少做了一项」与「这一项通过了」在输出里长得一模一样；`v1.4.3`、`v1.4.7`、`v1.4.8` 都是靠人手打命令确认的 | 拦：版本/`versionCode`/CHANGELOG/期望证书/hash/包内变体与 debuggable/线上清单三处一致/十项判据。不拦：真人装包能不能用 | 一条命令重算，别手抄 —— 见 `docs/RELEASE-MANUAL.md` 与 `docs/RELEASE-CHECKLIST.md` | 发版 |

### 2.5 测试层（为什么这样分层见 `docs/TESTING-POLICY.md` §1–§8）

| 门禁 | 一句话事故 | 拦 / 不拦 | 红了第一件事 | 归属 |
| --- | --- | --- | --- | --- |
| `test`（L0，`tests/run-layer.mjs unit`） | #362 域 10：一批用例写了却**不在任何执行入口**（`deploy/dl-release/test` 24 条、`tests/regression` 12 个文件），而 CI 只跑 `pnpm test` 这一层，导致不在 `LAYERS` 里的目录写多少用例都等于零 | 拦：单元层全量（纯 Node，零浏览器，每次提交都跑）。不拦：真浏览器行为 | `node tests/which.mjs --git` 定位受影响用例 | 任何 `src/` 改动 |
| `test:regression`（`tests/run-layer.mjs regression`；ci.yml 的 checks job 直接调，不经 npm 别名） | #368/#362：`tests/regression` 12 个文件写了但**没有 runner**，导致不报错、不变红、也没人发现 | 拦：回归层（纯 Node，秒级）。不拦：需要真 dist 的 | 按 `check:test-layout` 的定位把文件放进某层 | 改回归用例 |
| `test:integration`（L1；本地 `node tests/run-layer.mjs integration`，ci.yml 用 6 个分片 `--shard i/6` 跑） | #365：接线前 `tests/integration/` 49 个文件 / 1.68 万行**零触发点**，只有人记得手跑，导致「写好的集成用例」和「真的会被执行的用例」是两件事 | 拦：真实 DOM + 真实产物。不拦：既有红 —— 那些走 `tests/integration-baseline.json`，`--baseline` 只判「相对基线没有新增失败」，**不许改用 `continue-on-error`** | 先看三态（`docs/TESTING-POLICY.md` §11.5）：真红修、flaky 登记、runner-dependent 改成等终态 | 改 UI / 改集成用例 |
| `test:golden`（`tests/run-golden.mjs`） | #404：功能开发把用户主路径打断，却要等到有人手动点才发现，导致「这道闸」根本不存在 | 拦：每域 1 条主路径 + 预算（单条 ≤60s / 整层 ≤5min 由脚本自己判）；**缺产物直接红、不 SKIP**。不拦：细节分支 | 看 job summary 的「首个失败断言」；预算超了先看是不是构建开销 | 改用户可见路径 |
| `test:dl-release`（`deploy/dl-release/test`，`server` 层） | #415/#441：同一批用例（variant / apk-manifest / server-buildtype / version-endpoint / 域契约）全绿但**零触发点** —— 这是 #368/#365 同一形状的第四处 | 拦：发布服务端与清单变体（纯 Node、无浏览器）。不拦：真分发机行为 | 用例与被测实现同目录，改实现先跑这条 | 改 `deploy/dl-release/**` |
| `test:device` / `test:e2e` | 真机 / AVD 与真实上游才能暴露的路径（安装、链接导入、原生插件），自动化在 CI 上跑不了，导致「模拟通过」最容易被写成「真机通过」（`AGENTS.md` 硬规则 3） | 拦：需要真环境的那一层。不拦：能在 L0/L1 覆盖的逻辑 | 人工执行并在单里写清未测边界 | 发版前 / 原生改动 |
| `check:hardcoded-ports`<br>`scripts/check-hardcoded-ports.mjs`<br>**未接线，只警告** | #406：用例里写死 `127.0.0.1:5181` 时，本机只要**任何一个**服务占着这个端口，用例就会对着**别人的产物**跑绿或跑红 —— 假绿比红更坏 | 拦：测试里的裸端口且没有 env 出口（警告级）。不拦：注释里的跑法示例 | 改成 `serveDist(dir, { port: 0 })` 或从 `process.env` 读 | 写集成用例 |
| `test:fast` / `test:full` / `test:affected` / `test:report`<br>**这四个不是门禁，是入口** | 没有单命令入口时，人凭记忆挑命令，导致「跑了哪些、还差哪些」每次都不同（#409） | 不判任何东西，只按层/受影响集合调起下面的门禁与测试层。`test:doc` / `test:integration:baseline` / `test:all` 同理，是别名不单列 | 红了看它调起了哪条（`docs/TESTING-POLICY.md` §10） | 本地跑之前 |

---

## 3. 新增门禁的准入（**加的时候生效**，不是事后审计）

### 3.1 四问，写不出就别加

| 问 | 合格答案的形状 | 不合格 |
| --- | --- | --- |
| **Q1 事故** | 一句话：「因为曾经有人 X，导致 Y」，Y 是**用户能感知**的后果（白屏 / 下载 404 / 数据对不上 / 已装用户无法升级） | 「代码更整洁」「最佳实践」「别的项目都有」 |
| **Q2 证据** | 事故现场：issue 号 + 提交 / 命令输出 / 线上记录 | 「我觉得可能会」「预防性」 |
| **Q3 为什么现有门禁防不住** | 点名最接近的那一道，并说清它的判据为什么不覆盖（例：`check:legacy` 的判据是 Chromium 83 能力集，而 `?.` 属于 80，所以它永远绿 → 才需要 `check:syntax-floor`） | 「多一层保险」（= 不知道边界在哪） |
| **Q4 它自己怎么被证伪** | 负向对照四拍（正例 / 注入 / 红且点名注入物 / 还原），放在 `tests/unit/gate-negative-controls.test.mjs` 的一行或 `ci.yml` 的现场注入 | 「脚本自带 `--selftest` 就够了」—— 那只证明脚本会红，不证明**接线**没被改软 |

### 3.2 一次提交里必须齐的五样

1. `scripts/check-*.mjs` + `package.json` 别名。**别名指向的文件名必须与真实文件名一致**：`check:dup-impl` 曾被写成 ~~scripts/check-dup-impl.mjs~~（真实文件名是 `scripts/check-duplicate-impl.mjs`，那个名字在仓库里从来没有过），整份体检报告因此判它「崩溃」。
2. 负向对照（Q4）。
3. `ci.yml` 一步 `run: pnpm run <别名>`，且必须是**单行形态** —— 接线断言按这个形状认「接了线」，写成多行 `run: |` 块里的命令不算。**先全绿再接线**：接一道恒红的门禁等于没有门禁（`check:refactor-direction` 等 A1/A4/A6 清零后才接）。
4. 接线断言：`tests/unit/domain10-gate-wiring.test.mjs` 的 `REQUIRED_CI_GATES` 加一行；确实不能接线的，进同文件的 `KNOWN_UNWIRED` 并写理由。
5. **本台账加一行**（事故 / 拦什么 / 红了第一件事 / 归属）。

### 3.3 会被打回的四种形状

- 一道门禁同时判三件事 → 红了说不清是哪件，拆。
- 判据宽到永远不红、或窄到只认眼熟写法 → 用 Q4 反证。
- 只加脚本不接线、也不进 `KNOWN_UNWIRED` → 等于零覆盖，且没人知道。
- 「顺手把基线放宽一点让它过」→ 见第 5 节 X2：新增豁免条目本身就该判红。

---

## 4. 删除 / 合并门禁的路径

该删的四种（每条都有出处，不是口味）：

| # | 判据 | 出处 |
| --- | --- | --- |
| D1 | **不能被证伪**：做不出负向对照，或无论怎么改都恒绿 | `docs/TESTING-POLICY.md` §9（「恒绿」与「空跑」症状相同） |
| D2 | **长期红且无人认领**：红已成 CI 背景色，没人分得清「还在重构」与「真退回去了」 | `check-refactor-direction` 的接线前史（#590） |
| D3 | **与产品口径脱节**：判据守着一条已经废掉的契约 | #651 车道 A/C 的「过期文档」类 |
| D4 | **与另一道语义重叠**：两道都在看同一件事，各自都不完整 | `check:guard` 与 `check:legacy`（#285 D22） |

**怎么删（少删一处就是留下一个假门禁）**：同一次提交里同步删 ——
脚本 → `package.json` 别名 → `ci.yml` 步骤 → 负向对照那一行（`tests/unit/gate-negative-controls.test.mjs`）
→ 接线断言那一行（`tests/unit/domain10-gate-wiring.test.mjs`）→ 基线与豁免条目 → **本台账那一行**。

删完必须能回答：原来那个事故现在由谁守？答案是「没人守」时，把这条写进 D 类清单并留一行记录
（`docs/debt-inventory.md` 的写法：结论 + 证据 + 归属），不要静默消失。

---

## 5. 已知红与豁免的纪律（从 json 的注释升到规范）

现状：这些规矩**只写在各个基线文件自己的 `note` 字段里**，于是每份基线的口径都不一样，
而且没有人能一次看全「仓里现在挂了哪些豁免」。

### 5.1 五条硬规矩

| # | 规矩 | 为什么 |
| --- | --- | --- |
| X1 | 每条豁免必须写 **`reason`（为什么现在不能修）+ 一条「会被自动发现过期」的判据**。合格判据只有两种形状：① 条目跑绿即报 `FIXED?` 并要求删条目；② `reviewAfter` 到期判红 | 「不会被发现过期」的豁免 = 永久豁免，而永久豁免等于把门禁悄悄关掉 |
| X2 | **只减不增**：给基线新增条目本身就该红 | 否则基线是「让它过」的入口，而不是存量登记簿 |
| X3 | **真实产品缺陷不许进豁免**：保留基线条目 + 开 `[bug]` 单，条目里的 `followUp` 指向它 | 豁免是记账，不是结论。C 类（真缺陷）留在基线里但必须有人修 |
| X4 | **环境问题不许进 known-red**：`SKIP(env)` 既不是绿、也不是 known-red | 把「产物没构建」说成 flaky，是最便宜的自欺 |
| X5 | 豁免必须能被**一次列全并审计**：`--baseline` / `--verbose` / `--audit-skipped` 至少有一种 | 看不见的豁免就是没有到期日的豁免 |

### 5.2 现有豁免载体（新增一个载体 = 必须补一行）

| 载体 | 到期怎么被发现 | 谁删 |
| --- | --- | --- |
| `tests/integration-baseline.json`（L1 已知红） | `--baseline` 跑绿即报 `FIXED?` | 修好的人 |
| `scripts/log-coverage-baseline.json`（埋点缺口） | 修好后条目失效 → 门禁报「基线失效」并 FAIL | 补埋点的人 |
| `tests/test-duplication-baseline.json`（重复块） | 组不存在 → 报基线失效 | 抽重复的人 |
| `tests/test-layout-baseline.json`（布局违规） | 违规消失 → 报基线失效 | 挪文件的人 |
| `tests/flaky-registry.json`（flaky） | 连续跑绿 → 提示移出登记簿（`docs/TESTING-POLICY.md` §11） | 维护套件的人 |
| `check-i18n.mjs` 的 `ORPHAN_BASELINE`（孤立 key） | 只减不增；跑绿/消失要删条目 | 删文案的人 |
| `scripts/release-traceability-allowlist.json`（tag 溯源） | `reviewAfter` 到期判红 | 发版负责人 |
| 分发机 `<目录>/.retention.json`（保留期） | `reviewAfter` 到期判红（`check-retention.mjs`） | 分发机运维 |
| `docs/repro/**`（历史取证，`check:doc-refs` 的 `EXEMPT_PREFIXES`） | 无到期机制 —— **已知缺口**：靠 `check-repo-hygiene.mjs` 按文件名钉死 | 谁动这批文件谁负责 |

最后一行是故意的：**台账里允许出现「无到期机制」的条目，但不允许它不被写出来。**

> **L1 仍红、但不该进上表的那些**：断言对象被产品有意删掉、而「这条还要不要被测」还没人答的用例，
> 走 `docs/testing/product-debt.md`（未完成决定的清单，到期未答按红处理），**不要**塞进
> `tests/integration-baseline.json` 当豁免。

---

## 6. 本页不负责什么（防止再长出一本手册）

| 你要查的 | 去哪 |
| --- | --- |
| 每道门禁**有没有负向对照**、注入物是什么 | `docs/TESTING-POLICY.md` §9.4（机器判定：`tests/unit/gate-negative-controls.test.mjs` 的 N6） |
| 哪道门禁**接了线**、没接线的理由 | `tests/unit/domain10-gate-wiring.test.mjs` 的 `REQUIRED_CI_GATES` / `KNOWN_UNWIRED` |
| 分层、预算、flaky 三态、合并批次、runner 崩溃的判据 | `docs/TESTING-POLICY.md` §1–§13 |
| 集成层怎么跑、基线与产物守卫 | `docs/testing.md` |
| 2026-11-20 那次三态体检（历史快照） | `docs/testing/gates-audit-2026-11-20.md` |
| 发布流程与发布机上的操作 | `docs/RELEASE-MANUAL.md`、`docs/RELEASE-CHECKLIST.md` |
| 哪些门禁脚本存在但**没有任何入口** | `tests/unit/domain10-gate-wiring.test.mjs`（D16/D17 那条债的账） |

**本页刻意不写任何计数**（几道门禁、几处豁免、几处红）。计数写在文档里就会过期 ——
需要数字时现算，例：

```bash
grep -c 'run: pnpm run' .github/workflows/ci.yml          # CI 里接了多少步
grep -o 'run: pnpm run [a-z:-]*' .github/workflows/ci.yml | sort -u   # 接了哪些
node -e 'const p=require("./package.json").scripts;console.log(Object.keys(p).filter(k=>k.startsWith("check:")).length)'
ls scripts/check-*.mjs | wc -l                            # 脚本本体有多少道
```

写完一行台账，问自己一句：**「如果这道门禁明天消失，仓库里谁会先疼？」** 答不出人名/角色，
这一行的「归属」就还没写完。
