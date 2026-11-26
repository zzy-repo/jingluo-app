#!/usr/bin/env node
/**
 * dev-check.mjs —— **「改完那一刻」的本地门禁聚合入口**（一条命令，一个结论）
 *
 * ## 它治的是什么
 *
 * 本仓有 42 个 `check:*` 门禁，其中 32 道接在 `.github/workflows/ci.yml` 的 `checks` job 里
 * （91 个步骤、20 分钟上限）。问题不是「门禁不够」，是**成本压在了最贵的那一端**：
 *
 *   · 一个 CRLF 文件、一个仅大小写不同的模块名、一行写死的 IP、一个写死的 IndexedDB 版本号
 *     —— 这些「本机 0.2~2 秒就能判死」的东西，全都要等 `git push` 之后 CI 跑到第 3~8 分钟
 *     才冒出来；
 *   · 而一旦冒出来，人的反应不是修，是**绕过**（跳过全量、在红的基础上叠 PR）。
 *     绕过不是道德问题，是成本问题：拦截点离改动越远，绕过它的收益就越大。
 *
 * 所以本文件**不新增任何检查**，只做一件事：把**已经有**的那批便宜门禁，搬到「你刚改完」的这一刻，
 * 并用一条命令跑完、给一个结论。判据仍然是各门禁自己的脚本（命令从 `package.json` 的 script
 * **解析**，不在这里抄第二份 —— 抄一份就一定会漂，`tests/gates/README.md` 第 1 条坑就是这个）。
 *
 * ## 三档（摩擦与风险成正比，不要每改一行都跑全量）
 *
 * | 档 | 命令 | 判什么 | 实测 |
 * | --- | --- | --- | --- |
 * | 提交档 | `node scripts/dev-check.mjs --content` | 27 道纯内容门禁（行尾/卫生/撞车/IP/DB 版本/i18n/端点/消费白名单/日志字段…） | 实测 ~3s（两次 3.2s / 2.9s，并发 6） |
 * | 默认档 | `pnpm dev-check` | 提交档 + 6 道慢一点的内容门禁（截图引用/能力文档/能力盘点/测试布局/测试重复/静态审计自检，按 `scope` 条件跑）+ **类型门 + lint** | 12~18s（把 `check:audit-selftest` 挪进来后 +~1.5s 墙钟，见下方注） |
 * | 厚档 | `pnpm test:fast` | 类型 + L0 快速子集 + 黄金套件（另一条命令，别在这里重复实现） | ~40-60s |
 *
 * （`check:audit-selftest` 归 `deep` 是**裁决 F**（原先归 `content`）：它实测 3.9s（本机复测 3.7s），
 * 归 `content` 会把提交档从 ~3s 抬回 ~7s —— 而它证明的是「我们的门禁真的会咬」，这件事该在**推送/合并前**
 * 验，不该在每次 `git commit` 时付 3.9s。**摩擦要与风险成正比，也要与频次成正比。**
 * 单价（4 核本机、并发 6，同一份改动在挪之前 / 挪之后各实测）：提交档 5.9s → 3.1s（两跑 3.2/2.9s）；
 * 默认档 6.1s → 7.6s。两次默认档都是「只碰 `scripts/`」的同一场景（5 道 scope 门禁照旧跳过），可直接比。
 * 也就是说这笔 3.7s 没有消失，只是从「每次提交」挪到了「每次推送」—— 后者一天十来次，前者一天上百次。）
 *
 * 钩子用的是前两档：`.githooks/pre-commit` → `--content`，`.githooks/pre-push` → 默认档。
 * 装钩子：`pnpm hooks:install`（一次性；本文件末尾会提醒你「现在还没装」）。
 *
 * ## 为什么需要第五档 `network`（要网络的检查不进 `content` 档）
 *
 * `check:exemptions --strict` 要 `gh` + token 去查「豁免引用的承接单还在不在」。它**不能**进 `content` 档：
 * 那一档是「本机断网也照样判得动」的那批，把一个要网络的检查塞进去，结果只有一种 ——
 * **一断网，提交档就红**。而人对一条「总会叫」的命令的反应不是修，是关掉它（`--no-verify`），
 * 于是整个本地入口从「它有话说」降级成「它又来了」，**可信度一次性清零**（红不再等于坏，准绳 #1）。
 *
 * 但把它彻底不跑也不对：那等于把它藏起来 —— `check:exemptions` 守的正是「豁免会不会过期」，
 * 被藏起来的豁免就是最会烂的那一批（准绳 #7）。
 *
 * 所以给它单独一档，三条规矩：
 *   1. **默认档与 `--content` 档都不跑它**（提交档那几秒的预算不许被网络占用）；
 *   2. **只在 `--deep` 里跑**（`--deep` 的语义就是「审计仓库现状」，那一刻要的就是这个结论）；
 *   3. 跑不动（无凭据 / 无 `gh`）时它 exit 2 = 它自己声明「环境不具备」→ 这里报
 *      **「判不了（环境）」而不是红**。这不是放水：门禁的红只留给「豁免条目真有问题」，
 *      而「今天这条判据没在工作」是另一件事，混在一起以后谁也说不清该改条目还是该修凭据
 *      （脚本自己的退出码就是这么分的：0 通过 / 1 有非法条目 / 2 环境不具备）。
 *
 * **深档里那 5 道带 `scope`**（共 6 道；只有 `check:audit-selftest` 不带，见裁决 F 那条注释）：只有改动
 * 落在它的输入范围内才跑（截图引用只看 `docs/ui/`，测试布局/重复看 `tests/`，能力盘点/能力文档看
 * `src/`+`android/`）。这样「只改了一个 src 文件」时，默认档不会被截图扫描那 8 秒拖住。被跳过的会**逐条打印原因**（不是静默省掉）；工作区干净时（没有改动集可判）
 * 一律按 scope 跳过（没有改动集就没有可归因的东西），要看仓库现状用 `--deep`。
 *
 * ## 红怎么归因（这条比「跑得全」重要）
 *
 * 一个**在 HEAD 上本来就红**的门禁，如果本地聚合入口照实报红，结果只有一种：所有人每天看到同一条红，
 * 两天后这条命令就没人跑了 —— 这就是本仓「20 多次推送都在红的基础上推进」的机制。所以：
 *
 *   1. 门禁 exit 1 时，从它的输出里**收割文件路径**；
 *   2. 这些路径里**有落在你的改动集**（`git status` 的已跟踪改动 + 新增文件）里 → **RED（你造成的）**；
 *   3. 一个都没有 → **△ HEAD（HEAD 上就有，不是你这次改坏的）**：照样打印，但不阻塞、不给退出码 1；
 *   4. 一个路径都收割不到（输出里没点到文件）→ **按 RED 处理**：判不出归因就不许放行。
 *
 * 归因用的是**现场计算**的改动集，没有任何「基线登记表」—— 所以没有「豁免会过期」这件事：
 * 别人把那条红修好，这里自动变绿；你新引入一条，这里立刻变红。
 * 想按「HEAD 上也不许红」的口径跑：`--strict`（修 main / 发版前自查时用）。
 *
 * ## 退出码
 *
 *   0 = 你这次改动没有把任何门禁弄红（可能仍有 △ HEAD 的既有红，输出里列着）
 *   1 = 有红（RED / 收割不到归因 / 门禁自身崩了）
 *   2 = 判不了（`preflight` 失败：node_modules 缺失、门禁命令指向不存在的脚本、
 *       或某道门禁 exit 2 = 它自己声明「前置缺失所以判不了」，比如缺 `dist/`）
 *
 * 「判不了」一律**不算通过**：CI 上的同类门禁也是这个口径（`check:bundle-target` 头注释：
 * 「没有产物 = 没有检查，所以一律判失败，不存在『跳过』」）。
 * 但「判不了」有两种，文案分开印：前置缺失（`dist` 档，要产物）与环境不具备（`network` 档，
 * 要凭据 / `gh`）。后者绝不是「豁免条目有问题」—— 它的红只留给条目本身坏了那一种情形。
 *
 * ## 用法
 *
 *   pnpm dev-check                      # 默认档：内容门禁 + tsc + lint
 *   pnpm dev-check -- --content         # 提交档：只跑纯内容门禁（pre-commit 用，实测 ~3s）
 *   pnpm dev-check -- --strict          # HEAD 上既有的红也算红（修 main / 发版前自查）
 *   pnpm dev-check -- --list            # 只列会跑哪些门禁（不执行）
 *   pnpm dev-check -- --only eol,ip     # 只跑点名的那几道（调试单条门禁最快的路）
 *   pnpm dev-check -- --json /tmp/r.json
 *   pnpm dev-check -- --brief           # 精简输出（钩子用：绿灯只打一行）
 *   pnpm dev-check -- --concurrency 4
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')
const PER_GATE_TIMEOUT_MS = 180000

/* ──────────────────────────── 门禁表 ────────────────────────────
 *
 * where：
 *   'content'  —— 纯文本 / 仓库扫描：不依赖构建产物、不依赖网络、不依赖本机密钥。
 *                 这就是「提交前就能判死」的那批，是本次要往前提的东西。
 *   'deep'     —— 同样不依赖产物，但单条 ≥1s（截图引用 7.8s / 能力文档 2.5s / 测试布局 2.2s…），
 *                 进默认档、不进 pre-commit（提交一次的等待别超过 ~4s）。
 *   'dist'     —— 判据的输入是构建产物（`dist/`）。本地没产物时它 exit 2 = 判不了，
 *                 **本地不做**，理由写在 reason 里（不是「跳过」）。
 *   'release'  —— 需要发布环境（签名材料 / APK / 分发机 / tag 与 origin 历史）。
 *   'network'  —— 判据要**网络 + 凭据**（`gh` + token）。默认档与 `--content` 档都**不跑**，
 *                 只在 `--deep` 里跑；跑不动时它 exit 2 = 「判不了（环境）」，**不报红**。
 *                 为什么要单独一档（而不是塞进 content）：见文件头「为什么需要第五档」。
 *
 * attribution：
 *   'offender' —— 默认。按「被点名的文件在不在你的改动集里」归因（见文件头第 2 节）。
 *   'strict'   —— 不归因，任何 exit 1 都算红。给那些**跨文件**因果的门禁用：
 *                 例如 i18n —— 你在 `src/` 里加一个 `t('new.key')`，它点名的却是 `locales/*.json`，
 *                 而那个文件你没碰过。这种门禁做「文件归因」会把你的红说成「HEAD 上就有」，
 *                 那是**比不判更坏**的错。
 */
const GATES = [
  // ── 内容档：便宜、纯文本，提交前就能判 ─────────────────────────────────────
  {
    id: 'check:eol',
    where: 'content',
    fix: 'node scripts/check-eol.mjs --fix',
    why: '行尾噪音会把「17 个真实冲突」放大成「19 文件 21 hunk」（#533）',
  },
  { id: 'check:hygiene', where: 'content', why: '本机绝对路径 / 大文件 / 临时产物混进仓库' },
  {
    id: 'check:case-collision',
    where: 'content',
    why: '仅大小写不同的文件名在 macOS 上让 tsc/rspack 全红（#557）',
  },
  {
    id: 'check:db-version',
    where: 'content',
    why: '写死的 IndexedDB 版本号 = 下次升库必 VersionError（#547）',
  },
  { id: 'check:dup-impl', where: 'content', why: '同一份实现存两份，改一处漏一处' },
  {
    id: 'check:ip',
    where: 'content',
    fix: '把地址挪进 config/endpoints.json（主机白名单也在那）',
    why: '写死的服务端地址（#484 §三）',
  },
  {
    id: 'check:endpoints',
    where: 'content',
    fix: '地址/超时只写 config/endpoints.json',
    why: '端点与超时只能有一个来源',
  },
  {
    id: 'check:consume-api',
    where: 'content',
    fix: '路径只能取 #484 §三 的端点表；确需新增先改 #484 评审',
    why: '白名单外的端点禁止调用（#487）',
  },
  {
    id: 'check:log-coverage',
    where: 'content',
    fix: '按门禁提示补 meta 字段，或从 scripts/log-coverage-baseline.json 删掉已失效条目',
    why: '诊断埋点字段不足就无法切片定位（#488）',
  },
  {
    id: 'check:i18n',
    where: 'content',
    attribution: 'strict',
    why: '新增文案键漏了一侧语言（-- 这条做文件归因会误判，见文件头）',
  },
  {
    id: 'check:identity',
    where: 'content',
    why: 'applicationId / 应用名被改散（config/appIdentity.json 是唯一来源）',
  },
  {
    id: 'check:ios-version',
    where: 'content',
    fix: 'pnpm run ios:version（改版本号请改 package.json，别手改 pbxproj）',
    why: 'iOS 工程版本号与 package.json 漂了（App Store 拒收重复 build 号 / 两端版本对不上）',
  },
  {
    id: 'check:artifact-prefix',
    where: 'content',
    why: '产物文件名前缀不一致 → 更新检查与下载对不上',
  },
  {
    id: 'check:redact',
    where: 'content',
    why: '日志脱敏规则被删掉一条（--selftest 在 CI 里另跑）',
  },
  {
    id: 'check:guard',
    where: 'content',
    why: '兜底守卫里冒出 ES6+ 语法 → 低内核 WebView 整包解析失败',
  },
  {
    id: 'check:compat-baseline',
    where: 'content',
    why: 'Chrome 下限出现第二个来源（config/compat.json 是唯一来源）',
  },
  { id: 'check:container', where: 'content', why: '布局决策依赖容器查询 → 老内核上塌掉' },
  { id: 'check:gap', where: 'content', why: 'flex gap 没兜底 → 老内核间距为 0' },
  { id: 'check:focus', where: 'content', why: ':focus-visible 没兜底 → 键盘焦点看不见' },
  { id: 'check:gutter', where: 'content', why: 'scrollbar-gutter 没等价实现 → 换手时布局跳动' },
  { id: 'check:limits', where: 'content', why: '上限常量没有收敛到配置' },
  { id: 'check:icon', where: 'content', why: '图标四边留白不齐 → 桌面图标发虚' },
  { id: 'check:manifest', where: 'content', why: '公网/私有 fixture 清单漂移（含事故清单断言）' },
  {
    id: 'check:hardcoded-ports',
    where: 'content',
    fix: '用 serveDir(dir) 让操作系统分配端口（listen(0)）',
    why: '写死端口 → 连到别人的静态服务 → 整批假红（#406）',
  },
  { id: 'check:webroot-hygiene', where: 'content', why: '静态目录里的残留文件没人管（#609）' },
  {
    id: 'check:private-publish-root',
    where: 'content',
    why: '默认站点根被指到公开目录（私有产物外泄）',
  },
  {
    id: 'check:doc-refs',
    where: 'content',
    fix: '按输出逐条改回真活路径/真行号；别用「换成章节标题」绕过',
    why: '文档里的 `文件:行号` 指不到东西（#290）',
  },
  {
    id: 'check:refactor-direction',
    where: 'content',
    why: '旧体系回流 / 额度搬回本地 / base 写死（#590 A1–A7）',
  },
  // ── 深档：同样不依赖产物，但单条 ≥1s，进默认档不进 pre-commit ──────────────
  {
    id: 'check:audit-selftest',
    where: 'deep',
    // 反方向的那条证据：静态审计族（能力盘点 / 文档引用 / 截图引用 / 上限常量 / 仓库卫生 / 重复实现）
    // 平时「全绿」既可能是「真没问题」，也可能是「它根本没扫到」。--selftest 是各自脚本自带的反例：
    // 故意造一份违规 → 必须被拦。它只读仓库、写临时目录，不依赖产物、网络、本机密钥 —— 判据本身很便宜。
    //
    // **裁决 F：归 `deep` 而不是 `content`。** 便宜的是「判据」，贵的是「它要跑六遍反例」：实测
    // 3.9s（2026-11-26 复测 3.7s）。而本文件对 `deep` 的定义就是「不进 pre-commit（提交一次等待别
    // 超过 ~4s）」—— 归 content 会把提交档从 ~3s 抬到 ~6s（本机实测 3.1s → 5.9s），等于让**每一次**
    // `git commit` 都为一条「门禁自己还咬不咬」的元检查付 3.7s。这件事该在**推送/合并前**验（默认档 / `--deep` 跑的就是
    // 这一刻），不该在每次提交时付：**摩擦要与风险成正比，也要与频次成正比。**
    //
    // 故意不给 `scope`：它自检的是整个仓库的静态审计族，输入不是某一两个目录；给了 scope 只会让它在
    // 大多数提交上被跳过 —— 而它恰恰是用来证明「平时绿不是因为它没扫到」的那条证据，跳过等于自废。
    why: '静态审计的**反向证据**：故意违规必须被判红（否则「绿」可能只是「它没扫到」）',
  },
  {
    id: 'check:test-layout',
    where: 'deep',
    args: ['--strict'],
    scope: ['tests/'],
    why: '用例目录/命名/孤儿/基线失真（#362 阶段二，#408 起 --strict 阻塞）',
  },
  {
    id: 'check:test-duplication',
    where: 'deep',
    scope: ['tests/'],
    fix: '同一断言只留一层：纯逻辑留 L0、装配样板抽 tests/helpers/',
    why: '整段复制的用例，改一处漏一处（#366/#408）',
  },
  {
    id: 'check:capabilities-docs',
    where: 'deep',
    exit2: 'red',
    scope: ['src/', 'android/', 'docs/capabilities/', 'scripts/lib/'],
    fix: 'pnpm gen:capabilities（重算文档并写盘，再 review 差异）',
    why: '能力清单文档与实际代码漂移',
  },
  {
    id: 'check:capabilities',
    where: 'deep',
    scope: ['src/', 'android/'],
    why: '宿主能力假设盘点（当前 warn 档：只报不拦，见 KNOWN_GAPS）',
  },
  {
    id: 'check:ui-shots',
    where: 'deep',
    scope: ['docs/ui/'],
    fix: '要么在 README/结论表里引用它，要么删掉这张图',
    why: '截图只进不出（#661：553 张里 155 张零引用 / 17.4 MiB）',
  },

  // ── 网络档：判据要 `gh` + token。默认档 / 提交档**不跑**，只在 --deep 里跑 ──────────────
  // 跑不动（无凭据 / 无 gh）时脚本自己 exit 2，这里按「判不了（环境）」处理，**不报红** ——
  // 「豁免条目有问题」和「这条判据今天没在工作」是两件事，混在一起就再也分不清该改哪头。
  {
    id: 'check:exemptions',
    where: 'network',
    args: ['--strict'],
    why: '任何豁免都必须会过期：缺理由/证据/承接单/到期日、已过期、已跑绿、拿环境问题顶包 → 红',
  },

  // ── 判据的输入是构建产物：本地不做，理由要写清 ──────────────────────────────
  {
    id: 'check:bundle-target',
    where: 'dist',
    reason:
      '判据是 `dist/` 里的产物语法（E-1/E-2）；本地没有产物时 exit 2 = 判不了，不是通过。CI 在 `build:internal` 之后跑。',
  },
  {
    id: 'check:legacy',
    where: 'dist',
    reason: '同上：扫 `dist/static/js` 里的 ES5 下限。要本地判就先 `pnpm build`。',
  },
  { id: 'check:syntax-floor', where: 'dist', reason: '同上：读 `dist/index.html` 的入口脚本。' },
  { id: 'check:matrix', where: 'dist', reason: '同上：扫产物 × 兼容矩阵。' },
  {
    id: 'check:test-seam',
    where: 'dist',
    reason: '扫 `dist/` 里有没有测试接缝（`__TEST_AUTH_STATE__` / 假 token）；无产物时 exit 2。',
  },

  // ── 需要发布环境（本机没有，也不该假装判过）────────────────────────────────
  {
    id: 'check:keystore',
    where: 'release',
    reason:
      '要签名材料（android/keystore/**）与真证书指纹；CI 只跑 `--config-only` 降级档，全量在发布机。',
  },
  { id: 'check:apk', where: 'release', reason: '要一个已构建的 APK 路径做参数。' },
  {
    id: 'check:public-artifact-redaction',
    where: 'release',
    reason: '要已构建的 APK/产物目录（发布前 B3b）。',
  },
  {
    id: 'check:retention',
    where: 'release',
    reason: '要在分发机上跑（`ssh <分发机> … pnpm check:retention`）。',
  },
  {
    id: 'check:release-traceability',
    where: 'release',
    reason:
      '要 tags + `origin/main` 完整历史 + `gh`（判「已发布 tag 是否在 main 历史上」）。合并前/发版前跑，见 RELEASE-CHECKLIST。',
  },
]

/* ──────────────────────────── 参数 ──────────────────────────── */

const usage = (message) => {
  if (message) console.error(`${message}\n`)
  console.error(
    [
      '用法：node scripts/dev-check.mjs [--content] [--strict] [--list] [--brief] [--only a,b] [--json r.json] [--concurrency N]',
      '',
      '  （默认）     内容门禁 + 类型门 + lint',
      '  --content    只跑纯内容门禁（pre-commit 用，实测 ~3s）',
      '  --strict     HEAD 上本来就红的门禁也算红（修 main / 发版前自查）',
      '  --deep       深档那 6 道不看 scope，一律跑；**网络档（check:exemptions）只在这里跑**（审计仓库现状时用，常配 --strict）',
      '  --list       只列会跑什么，不执行',
      '  --brief      精简输出（钩子用）',
      '  --only x,y   只跑这几道（id 见 --list）',
    ].join('\n')
  )
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    contentOnly: false,
    strict: false,
    deep: false,
    list: false,
    brief: false,
    only: null,
    json: '',
    concurrency: 0,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // `pnpm dev-check -- --strict` 会把 `--` 原样传下来
    if (arg === '--content' || arg === '--content-only') {
      opts.contentOnly = true
      continue
    }
    if (arg === '--strict') {
      opts.strict = true
      continue
    }
    if (arg === '--deep') {
      opts.deep = true
      continue
    }
    if (arg === '--list') {
      opts.list = true
      continue
    }
    if (arg === '--brief') {
      opts.brief = true
      continue
    }
    if (!['--only', '--json', '--concurrency'].includes(arg)) usage(`未知参数：${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) usage(`${arg} 需要一个值`)
    if (arg === '--only')
      opts.only = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    if (arg === '--json') opts.json = value
    if (arg === '--concurrency') opts.concurrency = Number(value)
  }
  if (opts.concurrency && (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1))
    usage('--concurrency 必须是正整数')
  return opts
}

/* ──────────────────────────── 收割文件路径 ────────────────────────────
 * 门禁的输出格式各写各的，这里不解析它们的语义，只收割「看起来是本仓库里真存在的文件路径」
 * 的 token（去掉 `:行号`）。收割不到时由调用方按 RED 处理，绝不静默放过。
 */
const PATH_TOKEN =
  /(?:^|[\s`'"(（、：:→↪])((?:[A-Za-z0-9_@.][A-Za-z0-9_@./-]*\.(?:mjs|ts|tsx|jsx|js|css|json|json5|md|mdx|yml|yaml|gradle|html|png|jpe?g|svg|webp|txt|py|sh|bat|kts|xml))(:\d+)?)/g

function harvestPaths(output) {
  const found = new Set()
  for (const match of output.matchAll(PATH_TOKEN)) {
    let token = match[1].replace(/:\d+$/, '')
    if (token.includes('node_modules/')) continue
    if (token.startsWith('/')) {
      if (!token.startsWith(`${ROOT}/`)) continue
      token = token.slice(ROOT.length + 1)
    }
    token = token.replace(/^\.\//, '')
    if (!/[./]/.test(token)) continue
    if (!existsSync(path.join(ROOT, token))) continue
    found.add(token)
  }
  return [...found].sort()
}

/* ──────────────────────────── 改动集 ──────────────────────────── */

/** 子进程环境：补上 `node_modules/.bin` —— 我们的命令是从 package.json 原样取出来的
 * （`tsc -p tsconfig.json` / `oxlint src …`），这些 bin 只有经 `pnpm run` 才在 PATH 上。
 * 不补的话表现是 `sh: line 1: tsc: command not found` —— 一条**假红**：门禁没跑，却看着像坏了。 */
const CHILD_ENV = {
  ...process.env,
  PATH: `${path.join(ROOT, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
}

function runSync(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: CHILD_ENV })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** 你的改动集：已跟踪的改动（含暂存/未暂存/重命名两端）+ 新增未跟踪文件。判不出来 → 空集（== 全部按 RED 处理） */
async function changedFiles() {
  const status = await runSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.code !== 0)
    return {
      files: new Set(),
      note: `git status 失败（${status.stderr.trim() || status.code}）→ 改动集未知，任何红都按「你造成的」处理`,
    }
  const parts = status.stdout.split('\0')
  const files = new Set()
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    if (file) files.add(file)
    // 重命名/复制：`-z` 下第二个路径单独一段
    if (code[0] === 'R' || code[0] === 'C') {
      const next = parts[i + 1]
      if (next) {
        files.add(next)
        i += 1
      }
    }
  }
  return { files, note: '' }
}

/* ──────────────────────────── preflight ──────────────────────────── */

/**
 * 三道自检（都是「跑不起来比判红更危险」那一类，任何一条都 exit 2）：
 *   1. 依赖装了吗（没有 `node_modules` 就不是「门禁红」，是环境没准备好）；
 *   2. 表里的每个 id 在 package.json 里都得有同名 script（改名的第一时间发现，而不是 MODULE_NOT_FOUND）；
 *   3. **反向**：`package.json` 里每个 `check:*` 都必须在表里出现 —— 新加一道门禁却忘了归类，
 *      它会静默地永远不进本地入口，正是本文件要治的病。加一行 `{ id, where }` 就好。
 */
function preflight(pkg) {
  const problems = []
  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    problems.push('没有 node_modules —— 先 `pnpm install`（这是环境没准备好，不是门禁红）')
  }
  for (const gate of GATES) {
    if (!Object.hasOwn(pkg.scripts, gate.id))
      problems.push(`门禁表里的 \`${gate.id}\` 在 package.json 里没有同名 script（改名了？）`)
    if (gate.where !== 'dist' && gate.where !== 'release') {
      const command = String(pkg.scripts[gate.id] ?? '')
      const scripts = [...command.matchAll(/([A-Za-z0-9_./-]+\.mjs)/g)].map((m) => m[1])
      if (scripts.length === 0)
        problems.push(
          `\`${gate.id}\` 的 script 里没有可识别的 scripts/*.mjs（\`${command}\`）—— 这条门禁可能已经被改软成空跑`
        )
      for (const file of scripts) {
        if (!existsSync(path.join(ROOT, file)))
          problems.push(`\`${gate.id}\` 指向的 ${file} 不存在（点开就是 MODULE_NOT_FOUND）`)
      }
    }
  }
  const classified = new Set(GATES.map((gate) => gate.id))
  const unclassified = Object.keys(pkg.scripts).filter(
    (name) => name.startsWith('check:') && !classified.has(name)
  )
  if (unclassified.length > 0) {
    problems.push(
      `这些门禁没有在 scripts/dev-check.mjs 的门禁表里归类，本地永远不会跑到：${unclassified.join(', ')}\n` +
        "    修法：在 GATES 里加一行（`where: 'content' | 'deep' | 'network' | 'dist' | 'release'`，dist/release 要写 reason；\n" +
        "    要网络/凭据的必须归 network —— 塞进 content 会让断网的本地入口变红，那等于让整个入口失去可信度）。\n" +
        '    为什么这算错：新门禁只活在 CI 里，就是「拦截点在最贵的那一端」（本文件头第 1 节）。'
    )
  }
  return problems
}

/* ──────────────────────────── 执行 ──────────────────────────── */

function execGate(gate, command) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn('sh', ['-c', command], { cwd: ROOT, env: CHILD_ENV })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PER_GATE_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        id: gate.id,
        code: -1,
        ms: Math.round(performance.now() - started),
        output: `${output}${error.message}`,
        timedOut,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ id: gate.id, code, ms: Math.round(performance.now() - started), output, timedOut })
    })
  })
}

/** 并发跑一批（输出按表顺序打印，不交错 —— 交错的日志没人读得下去） */
async function runGates(gates, pkg, concurrency) {
  const results = new Array(gates.length)
  let next = 0
  const worker = async () => {
    while (next < gates.length) {
      const index = next++
      const gate = gates[index]
      const base = String(pkg.scripts[gate.id])
      const command = gate.args ? `${base} ${gate.args.join(' ')}` : base
      results[index] = await execGate(gate, command)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, gates.length) }, worker))
  return results
}

/* ──────────────────────────── 输出 ──────────────────────────── */

const RED = '\u001b[31m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const RESET = '\u001b[0m'
const paint = (color, text, enabled) => (enabled ? `${color}${text}${RESET}` : text)

const tail = (output, lines = 8) => {
  const kept = output
    .trimEnd()
    .split('\n')
    .filter((line) => line.trim() !== '')
  return kept.slice(-lines)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const color = process.stdout.isTTY && !process.env.NO_COLOR
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))

  const problems = preflight(pkg)
  if (problems.length > 0) {
    console.error(
      paint(RED, '✗ dev-check 自身跑不起来（exit 2）—— 这不是门禁红，是入口配错了：', color)
    )
    for (const problem of problems) console.error(`  · ${problem}`)
    return 2
  }

  const wanted = opts.only
    ? new Set(opts.only.map((name) => (name.startsWith('check:') ? name : `check:${name}`)))
    : null
  const { files: changed, note } = await changedFiles()

  /**
   * scope：深档门禁只有「改动落在它的输入范围内」才跑。
   *   工作区干净（changed 为空）时**同样按 scope 跳过** —— 没有改动集就没有可归因的东西，
   *   这时候跑截图扫描/测试布局只是在看「仓库现状」，那是 `--deep`（或 --strict）的活。
   *   不这样分的话，「提交完再跑一次」会变成 40 秒的等待，而那一刻你最不需要的就是等待。
   */
  const outOfScope = []
  const inScope = (gate) => {
    if (!gate.scope || opts.deep || opts.only) return true
    const touched = [...changed].some((file) =>
      gate.scope.some((prefix) => file.startsWith(prefix))
    )
    if (!touched) outOfScope.push(gate)
    return touched
  }

  const selected = GATES.filter((gate) => {
    if (wanted) return wanted.has(gate.id)
    if (gate.where === 'dist' || gate.where === 'release') return false
    // 网络档：默认档与 --content 档都不跑（断网就红 = 整个本地入口失去可信度，见文件头）；
    // 只在 --deep（「审计仓库现状」那一刻）里跑。--only 显式点名时照跑（调试单条门禁要用）。
    if (gate.where === 'network') return opts.deep
    if (opts.contentOnly) return gate.where === 'content'
    return inScope(gate)
  })

  if (selected.length === 0) usage('没有选中任何门禁（--only 写错了吧？用 --list 看 id）')

  if (opts.list) {
    for (const gate of selected) {
      console.log(
        `${gate.where.padEnd(8)} ${gate.id.padEnd(24)} ${pkg.scripts[gate.id]}${gate.args ? ` ${gate.args.join(' ')}` : ''}${gate.scope ? `  （只在你改 ${gate.scope.join('/')} 时跑）` : ''}`
      )
    }
    const skipped = GATES.filter((gate) => gate.where === 'dist' || gate.where === 'release')
    if (skipped.length > 0 && !opts.contentOnly) {
      console.log('\n本地不跑（判据要产物 / 要发布环境）：')
      for (const gate of skipped) console.log(`  ${gate.id.padEnd(26)} ${gate.reason}`)
    }
    // 网络档单独列：它**不是**「本地不跑」，是「只在 --deep 里跑」—— 不能混进上面那两档，
    // 否则读的人会以为这道门禁永远没人跑（那正是「写了没人跑」的另一种说法）。
    const network = GATES.filter((gate) => gate.where === 'network')
    if (network.length > 0 && !opts.deep) {
      console.log('\n只在 --deep 里跑（判据要网络 + 凭据；跑不动时报「判不了（环境）」，不报红）：')
      for (const gate of network)
        console.log(
          `  ${gate.id.padEnd(26)} ${pkg.scripts[gate.id]}${gate.args ? ` ${gate.args.join(' ')}` : ''}`
        )
    }
    return 0
  }

  const withTypeGates = !opts.contentOnly && !opts.only
  if (!opts.brief) {
    console.log(
      `dev-check —— 本地门禁（${opts.contentOnly ? '提交档：纯内容' : '默认档：内容 + 类型/lint'}${opts.strict ? ' + strict' : ''}）`
    )
    console.log(`仓库：${ROOT}`)
    console.log(
      `你改了 ${changed.size} 个文件${changed.size > 0 ? `：${[...changed].slice(0, 6).join('、')}${changed.size > 6 ? ` …(+${changed.size - 6})` : ''}` : '（工作区没有改动：下面任何红都不可能是你造成的）'}`
    )
    if (note) console.log(paint(YELLOW, `⚠ ${note}`, color))
    console.log(
      `门禁 ${selected.length} 道${withTypeGates ? ' + tsc + lint' : ''}；并发 ${opts.concurrency || 6}`
    )
    if (outOfScope.length > 0) {
      console.log(`跳过的 ${outOfScope.length} 道（你的改动没碰到它们的输入，不是「通过」）：`)
      for (const gate of outOfScope) console.log(`  · ${gate.id}（只看 ${gate.scope.join('/')}）`)
      console.log('  想全跑：pnpm dev-check -- --deep')
    }
    console.log('')
  }

  const startedAll = performance.now()
  const concurrency = opts.concurrency || 6
  const gateResults = await runGates(selected, pkg, concurrency)

  // tsc / lint 与门禁同批并发跑：它们读的是同一份工作区，没有共享写入
  let typeResult = null
  let lintResult = null
  if (withTypeGates) {
    const extra = [
      { id: 'type', command: String(pkg.scripts.type) },
      { id: 'lint', command: String(pkg.scripts.lint) },
    ]
    const [typeOut, lintOut] = await Promise.all(
      extra.map(async (item) => {
        const started = performance.now()
        const result = await new Promise((resolve) => {
          const child = spawn('sh', ['-c', item.command], { cwd: ROOT, env: CHILD_ENV })
          let output = ''
          child.stdout.on('data', (chunk) => {
            output += chunk
          })
          child.stderr.on('data', (chunk) => {
            output += chunk
          })
          child.on('error', (error) => resolve({ code: -1, output: `${output}${error.message}` }))
          child.on('close', (code) => resolve({ code, output }))
        })
        return { ...result, id: item.id, ms: Math.round(performance.now() - started) }
      })
    )
    typeResult = typeOut
    lintResult = lintOut
  }
  const wallMs = Math.round(performance.now() - startedAll)
  const serialMs =
    gateResults.reduce((sum, item) => sum + item.ms, 0) +
    (typeResult?.ms ?? 0) +
    (lintResult?.ms ?? 0)

  const red = []
  const unjudged = []
  const preexisting = []
  const passed = []

  for (let i = 0; i < gateResults.length; i++) {
    const result = gateResults[i]
    const gate = selected[i]
    const offenders = harvestPaths(result.output)
    const mine = offenders.filter((file) => changed.has(file))
    const entry = { ...result, gate, offenders, mine }

    if (result.timedOut) {
      red.push({ ...entry, verdict: 'broken', detail: `超时 ${PER_GATE_TIMEOUT_MS}ms 被强杀` })
      continue
    }
    if (result.code === 0) {
      passed.push(entry)
      continue
    }
    if (result.code === 2 && gate.exit2 !== 'red') {
      unjudged.push(entry)
      continue
    }
    // 有违规：exit 1；个别门禁把「锚点/判据对不上」也记成 2（`exit2: 'red'`），同样是违规不是崩溃
    const violation = result.code === 1 || (result.code === 2 && gate.exit2 === 'red')
    if (!violation) {
      red.push({
        ...entry,
        verdict: 'broken',
        detail: `退出码 ${result.code}（既不是 0 也不是 1/2）—— 门禁自己崩了`,
      })
      continue
    }
    if (gate.attribution === 'strict' || opts.strict || offenders.length === 0) {
      red.push({ ...entry, verdict: 'mine' })
      continue
    }
    if (mine.length > 0) {
      red.push({ ...entry, verdict: 'mine' })
      continue
    }
    preexisting.push(entry)
  }

  for (const item of red) {
    const where =
      item.verdict === 'mine' ? paint(RED, '✗ 红  ', color) : paint(RED, '✗ 红？', color)
    console.log(
      `${where} ${item.gate.id.padEnd(20)} ${String(item.ms).padStart(5)}ms  ${item.mine.length > 0 ? `你改的文件被点名：${item.mine.join('、')}` : item.verdict === 'broken' ? item.detail : '输出里没有点到任何文件 → 判不出归因，按红处理'}`
    )
    for (const line of tail(item.output)) console.log(`         ${paint(DIM, '│', color)} ${line}`)
    if (item.gate.fix) console.log(`         ${paint(GREEN, '→ 修：', color)}${item.gate.fix}`)
    console.log(
      `         ${paint(GREEN, '→ 单跑：', color)}${pkg.scripts[item.gate.id]}${item.gate.args ? ` ${item.gate.args.join(' ')}` : ''}`
    )
    if (item.gate.why)
      console.log(`         ${paint(DIM, `为什么有这道：${item.gate.why}`, color)}`)
    console.log('')
  }

  /**
   * 「判不了」有两种，文案必须分开（否则人会被引去改错的地方）：
   *   · `dist` 等 —— 前置缺失（本地没有产物）；
   *   · `network` —— **环境不具备**（无凭据 / 无 `gh`）。这一条尤其要说清：它跑不动不等于
   *     「豁免条目有问题」，跑去改条目只会把真问题改成假豁免。
   */
  const unjudgedLabel = (item) => (item.gate.where === 'network' ? '判不了（环境）' : '判不了')
  const unjudgedHint = (item) =>
    item.gate.where === 'network'
      ? 'exit 2 = 环境不具备（无凭据 / 无 `gh`）—— 不是条目有问题，也不算通过；带上 GH_TOKEN 或 `gh auth login` 再跑'
      : 'exit 2 = 该门禁自己声明「前置缺失，无法判定」（不算通过）'

  if (opts.brief && unjudged.length > 0) {
    console.log(
      paint(
        YELLOW,
        `△ 判不了 ${unjudged.length} 道：${unjudged
          .map((item) => `${item.gate.id.replace('check:', '')}${item.gate.where === 'network' ? '（环境）' : ''}`)
          .join('、')}（exit 2 = 它自己说前置缺失 / 环境不具备；不算通过）`,
        color
      )
    )
  }
  for (const item of unjudged) {
    if (opts.brief) break
    console.log(
      `${paint(YELLOW, `△ ${unjudgedLabel(item)}`, color)} ${item.gate.id.padEnd(16)} ${String(item.ms).padStart(5)}ms  ${unjudgedHint(item)}`
    )
    for (const line of tail(item.output, 3))
      console.log(`         ${paint(DIM, '│', color)} ${line}`)
    console.log('')
  }

  if (opts.brief && preexisting.length > 0) {
    // 钩子里每条提交都刷 8 行「HEAD 上就有」= 噪音，噪音会训练人跳过整段输出。压成一行，要看细节去掉 --brief。
    console.log(
      paint(YELLOW, `△ HEAD 上既有红 ${preexisting.length} 道：`, color) +
        `${preexisting.map((item) => item.gate.id.replace('check:', '')).join('、')}` +
        `${paint(DIM, '（不是你这次改坏的；看细节：node scripts/dev-check.mjs）', color)}`
    )
  }
  for (const item of preexisting) {
    if (opts.brief) break
    const head = item.offenders.slice(0, 3).join('、')
    console.log(
      `${paint(YELLOW, '△ HEAD ', color)} ${item.gate.id.padEnd(16)} ${String(item.ms).padStart(5)}ms  ` +
        `红，但点名的 ${item.offenders.length} 处里 0 处在你改的文件里 → HEAD 上就有，不是你这次改坏的` +
        `${head ? `（${head}${item.offenders.length > 3 ? ' …' : ''}）` : ''}`
    )
  }

  for (const item of [typeResult, lintResult]) {
    if (!item) continue
    const label = item.code === 0 ? paint(GREEN, '✓ PASS', color) : paint(RED, '✗ FAIL', color)
    console.log(`${label} ${item.id.padEnd(20)} ${String(item.ms).padStart(5)}ms`)
    if (item.code !== 0) {
      for (const line of tail(item.output, 12))
        console.log(`         ${paint(DIM, '│', color)} ${line}`)
      const hint =
        item.id === 'type'
          ? '按 `文件(行,列)` 改；只重跑类型门：pnpm type（~3s）'
          : '按报错文件改（no-debugger 之类多半是调试残留）；只重跑 lint：pnpm lint（~1s）'
      console.log(`         ${paint(GREEN, '→ 修：', color)}${hint}`)
    }
  }

  if (!opts.brief) {
    for (const item of passed)
      console.log(
        `${paint(GREEN, '✓ 绿    ', color)} ${item.gate.id.padEnd(20)} ${String(item.ms).padStart(5)}ms`
      )
  }

  const total = red.length + (typeResult?.code ? 1 : 0) + (lintResult?.code ? 1 : 0)
  console.log(`\n${'─'.repeat(72)}`)
  console.log(
    `判了 ${selected.length + (withTypeGates ? 2 : 0)} 条：` +
      `${paint(GREEN, `绿 ${passed.length + (withTypeGates ? [typeResult, lintResult].filter((item) => item?.code === 0).length : 0)}`, color)}` +
      `${total > 0 ? `，${paint(RED, `红 ${total}`, color)}` : ''}` +
      `${unjudged.length > 0 ? `，${paint(YELLOW, `判不了 ${unjudged.length}`, color)}` : ''}` +
      `${preexisting.length > 0 ? `，${paint(YELLOW, `HEAD 上既有红 ${preexisting.length}`, color)}` : ''}` +
      `　｜　耗时 ${(wallMs / 1000).toFixed(1)}s（串行要 ${(serialMs / 1000).toFixed(1)}s）`
  )

  if (total > 0) {
    console.log(
      `\n${paint(RED, '结论：这次改动有红。')} 每一条上面都给了「怎么修 / 怎么单跑」——先修再提交，别推到 CI 去等 5 分钟。`
    )
    if (opts.strict && preexisting.length > 0)
      console.log('（--strict：HEAD 上本来就红的那几条也算进来了）')
  } else if (preexisting.length > 0 || unjudged.length > 0) {
    // 一句结论说清两件事（红 0，但「没给出结论的门禁」也要点名）：
    //   · HEAD 上既有红 —— 不阻塞你，修好后自动变绿（没有基线登记表，不存在「豁免过期」）；
    //   · 判不了 —— **不算通过**（见文件头）。所以只要 unjudged > 0，就不能印「全绿」那一句：
    //     那是本条命令最容易骗自己的地方（跑不动被读成通过）。退出码仍是 0（它确实没红）。
    const parts = []
    if (preexisting.length > 0)
      parts.push(`${preexisting.length} 条是 HEAD 上就有的（不阻塞你，修好即自动变绿）`)
    if (unjudged.length > 0)
      parts.push(
        paint(
          YELLOW,
          `${unjudged.length} 道判不了（不算通过）：${unjudged.map((item) => item.gate.id).join('、')}`,
          color
        )
      )
    console.log(`\n${paint(GREEN, '结论：你的改动没有新增红。')} 其中 ${parts.join('；')}。`)
  } else {
    console.log(`\n${paint(GREEN, '结论：全绿。')}`)
  }

  if (!opts.brief) {
    console.log('\n下一步（按风险递增，别每次都跑最后一条）：')
    console.log(
      `   · 只想知道「我这一处该跑什么」：${pkg.scripts['test:affected']} -- <你改的路径>（秒级）`
    )
    console.log(
      '   · 提交前/推送前跑够用的一层：pnpm test:fast（类型 + L0 快速子集 + 黄金套件，≤60s，超预算自己判红）'
    )
    console.log(
      '   · 合并前/发版前才跑全量：pnpm test:full（分钟级，集成层按基线只判「不新增失败」）'
    )
  }

  // 钩子状态：装了没有，是「有没有人真在用」的唯一硬指标 —— 没装就等于本文件只在你记得的时候才跑
  const hooks = await runSync('git', ['config', '--get', 'core.hooksPath'])
  const hooksPath = hooks.stdout.trim()
  if (hooksPath !== '.githooks') {
    console.log(
      paint(
        YELLOW,
        `\n⚠ 本地钩子没装（core.hooksPath=${hooksPath || '未设置'}）—— 现在这套门禁只在你记得手动跑时才存在。`,
        color
      ) +
        '\n  一次性装好：pnpm hooks:install（之后 commit 跑提交档 ~3s、push 跑默认档 ~8s；`--no-verify` 仍然可以跳过，但那是你自己的选择，不是「没人拦」）'
    )
  } else if (!opts.brief) {
    console.log(
      paint(
        DIM,
        '本地钩子：core.hooksPath=.githooks（pre-commit → 提交档，pre-push → 默认档）',
        color
      )
    )
  }

  if (opts.json) {
    await writeFile(
      path.resolve(opts.json),
      `${JSON.stringify(
        {
          version: 1,
          wallMs,
          serialMs,
          changedFiles: [...changed].sort(),
          passed: passed.map((item) => ({ id: item.gate.id, ms: item.ms })),
          red: red.map((item) => ({
            id: item.gate.id,
            verdict: item.verdict,
            mine: item.mine,
            ms: item.ms,
          })),
          preexisting: preexisting.map((item) => ({
            id: item.gate.id,
            offenders: item.offenders.length,
            ms: item.ms,
          })),
          unjudged: unjudged.map((item) => ({ id: item.gate.id, ms: item.ms })),
          type: typeResult ? { code: typeResult.code, ms: typeResult.ms } : null,
          lint: lintResult ? { code: lintResult.code, ms: lintResult.ms } : null,
        },
        null,
        2
      )}\n`
    )
    console.log(`报告：${opts.json}`)
  }

  return total > 0 ? 1 : 0
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`dev-check 崩了：${error.stack || error.message}`)
  process.exitCode = 2
}
