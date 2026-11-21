# 历史债务盘点（#285）· 可执行清单

本文件是 #285 的**清单**，不是清理动作本身：#651 车道 A 的 DoD 要求「不必全清，但每条要有处置与归属」。
每一条都由本人在 `origin/main@202c55f9` 上用命令重新数过（**没有照抄 issue 里的叙述**），
复现命令见文末「六、复现命令」。核实后判定「不是债务」的条目也留在表里并写明判据 ——
盘点里最贵的一笔账是「以为有问题，其实没有问题」，把它删掉就等于下次还要再查一遍。

- 盘点基线：`origin/main@202c55f9`（2026-11-21）
- 条目数：**22**（第二份真相源 4 / 孤儿资源 7 / 过期文档 4 / 未接线门禁 2 / 死代码 2 / 兼容层残留 3）
- 本批建议（≤5 条、低风险、无行为变更、不碰生产机）：见「四、本批建议做」
- 生产机相关条目一律**只报不动**（#652 刹车线），承接单已开：#661 / #662

## 一、总表

| # | 债务条目 | 位置（`文件:行` / 目录） | 类型 | 证据（量化） | 处置 | 归属 |
| --- | --- | --- | --- | --- | --- | --- |
| D01 | 附件域有两个模块入口：单文件 `attachments.ts` 与同名目录 `attachments/` 并存（#562 明确要求二选一，至今未合） | `src/services/attachments.ts:15` / `src/services/attachments/` | 第二份真相源 | 单文件 **435 行**、被 **8 个文件** import（`src/app/App.tsx:24` 等）；目录 **18 个 .ts / 5866 行**、被 **12 处** import；两者**同名不同物**，`import ... from 'services/attachments.js'` 与 `.../attachments/limits.js` 只差一个斜杠 | 合并到 `src/services/attachments/`（单文件迁为 `attachments/upload.ts`，8 处 import 各改一行） | 车道 B（动 `src/services/attachments/**` 前先在车道单声明与 A/C 无交集） |
| D02 | 废弃域黑名单有两份：Gradle 一份、Node 一份，**没有任何断言钉住它们相等** | `android/app/build.gradle:141` / `scripts/lib/consumeEndpoints.mjs:45` | 第二份真相源 | 两份各 **2 项**（`140.210.13.146`、`:60013`）；`git grep -c CONSUME_DEPRECATED_MARKERS tests/` → **0 个文件**（无一致性断言）；加第三项时漏改一处即可让 build 期拦截失效而 CI 全绿 | 接线（新增一条 L0 断言：两份名单逐项相等，缺一项即红） | 车道 C |
| D03 | ES5 兜底页把主包文案抄了第二份（兜底页必须是 ES5，**无法 import i18n**，所以这是结构性重复） | `src/index.html:163` / `src/i18n/zh.ts:754` | 第二份真相源 | 内联脚本 **510 行**（文件 667 行 / 30KB）；脚本里含中文串 **25 条（去重）**，其中 **8 条**与 `zh.ts` **逐字相同**（如「页面启动失败」「资源加载失败」）；改一处文案要记得改两处 | 合并到（构建期从同一份文案表生成兜底页；不能生成则保留并在文件头写明「改文案要改两处」） | 车道 B |
| D04 | 曾怀疑 `LIMITS` 与 `attachments/limits.ts` 有重复数字 | `src/services/attachments/limits.ts:25` / `src/services/limits.ts:131` | 第二份真相源（**核实为否**） | 该文件 **43 行纯逐字段转出**；`grep -oE "[0-9]{4,}"` → **0 个**；`node scripts/check-limits.mjs` → 「未收敛阈值 0 处」，扫 10 文件 / 豁免 27 处。数字只有 `LIMITS` 一处 | 保留并说明理由（域视图层，非第二份；理由已写在文件头 21 行注释里） | 车道 B |
| D05 | 私有根里躺着 12 个**清单里查不到**的包 | `/opt/dl-private/private/` | 孤儿资源 | **12 项 / 64MB**（9 个 16hex 目录 + 3 个 `1.4.0-beta.10/11/12-internal` APK）；逐个 `grep -c` 进 `releases.internal.json` → **12/12 = 0** | 另开单 **#662**（移入 `archive/`，不 rm） | 车道 A（生产操作，先报后做） |
| D06 | 私有根里的 APK 目录（曾被怀疑是孤儿） | `/opt/dl-private/apk/` | 孤儿资源（**核实为否**） | **8 个文件 / 45MB**，逐个 `grep -c` 进清单 → **8/8 = 1**（都是活资源，删了就 404） | 保留并说明理由（活资源；#662 的边界里写死不碰） | 车道 A |
| D07 | #601 事故取证目录没有到期日 | `/opt/dl-leak-evidence/` | 孤儿资源 | **9 个文件 / 152KB**（含 `releases.json.LEAKED-1795185887`、`releases.json.withdrawn11-1795188331` 等）；无任何文件写明保留期限 | 保留并说明理由（取证；在 `docs/RELEASE-MANUAL.md` 补一段「保留到什么时候、谁能删」） | 车道 A |
| D08 | 分发机回滚物既没到期日、也分不清哪份是唯一副本 | `/root/dl-release-backups/` | 孤儿资源 | **10 个文件 / 184KB**；`server.mjs.20261121-100414` sha256 `bb076a1e…` = **改动前的旧 main**（当前 main `3ffea8cc…`）；`dl-release.service.20261121-100519` `1a7f3eb2…` ≠ 线上 `fe75f984…`（已被取代）；其中 `Caddyfile.*` 2 份是 Caddy 配置**在机器上的唯一留存** | 另开单 **#662**（保留 Caddyfile/variant/apk-manifest，其余归档） | 车道 A（生产操作） |
| D09 | 私有清单的 `.bak` 与线上清单**逐字节相同** | `/opt/dl-private/releases.internal.json.bak-1795225673` | 孤儿资源 | 两份 sha256 同为 `64f39885d94d25e0dd60f540e4d53718dadca4e05291190aee44baf1839a8183`，各 7595 B —— 备份价值为 0 | 删除（并入 **#662**；这是唯一可以真删的一份） | 车道 A（生产操作） |
| D10 | 仓库里 266 张截图没有任何文档指向 | `docs/ui/` | 孤儿资源 | `docs/ui` **737 文件 / 63.0MB**（514 张图片）；把文件名在 `docs/**/*.md` 全文 grep：命中 248 张、**未命中 266 张**，未命中部分合计 **26,601,289 B ≈ 26.6MB**；`docs/` 整体 **81MB / 989 文件** | 另开单 **#661**（删或外迁，需裁决） | 需人类决策（“删”与“留”都改变证据链，且 26.6MB 属体积决策） |
| D11 | 曾怀疑 `android/app/build/` 产物被误提交 | `android/app/build/` | 孤儿资源（**核实为否**） | `git ls-files android/app/build` → **0 个文件**；`git ls-files` 里 `.apk/.aab/.zip/.jar/.so` → **0 个**；`.gitignore:9` 与 `android/.gitignore:24` 都已挡；`dist/`、`node_modules/` 亦 **0** | 保留并说明理由（不入库，无需动作） | 车道 A |
| D12 | `check:doc-refs` 有 7 条 WARN，全是「引用指到了结构行 / 空行」 | `docs/baseurl-config-research.md:94`（另 `:116`/`:254`/`:269`）、`docs/capabilities/css.md:258`、`docs/capabilities/css.md:261`、`docs/capabilities/api.md:35` | 过期文档 | `node scripts/check-doc-refs.mjs` → **FAIL 0 / WARN 7**（其中 5 条「起行是结构行 `}`」、2 条「区间收在空行」）；扫描 88 个文档、带行号引用 454 处；另外 2 条（`capabilities/*`）是**生成器产物**，手改会被下次生成覆盖 | 3 条改生成器（`scripts/gen-capabilities-docs.mjs`）+ 4 条手改为「函数名/常量名」定位 | 车道 A |
| D13 | 两处源码注释声称 `pnpm check:limits` 在守阈值，但该门禁**不在 CI** | `src/services/limits.ts:13` / `src/services/attachments/limits.ts:6` | 过期文档 | 两处注释写「`pnpm check:limits` 会扫 WATCHED 清单并逐条报 `文件:行`」；`grep -c "limits" .github/workflows/ci.yml` → **0**（该步骤不存在）；`tests/unit/domain10-gate-wiring.test.mjs:82` 自己登记的是「无任何调用点」——**注释与登记互相矛盾** | 接线（见 D16，把 `check:limits` 接进 CI；接线前注释属谎话） | 车道 C |
| D14 | 兼容层注释自报「这 5 条一起删」，实际是 8 条 key | `src/i18n/zh.ts:975` | 过期文档 | 注释写「届时这 **5** 条一起删」；`grep -c "^  legacyMigrate"` → `zh.ts` **8**、`en.ts` **8** —— 已经漂了 3 条，照注释删会漏 key | 改文案（并改成由 D21 的断言兜住「删目录时 key 一并清零」） | 车道 B |
| D15 | `docs/repro/**` 是否还该在仓库 | `docs/repro/` | 过期文档（**核实为「保留」**） | **9 个文件 / 2408 行 / 197KB**；但它是**被门禁豁免的历史取证**（`docs/repro/` 在 `EXEMPT_PREFIXES` 里，另计 489 处引用不判定），且被 3 处测试/文档当「这条假红的出处」引用（`tests/integration/motion.test.mjs:72` 等）—— 删了这 3 处引用变悬空 | 保留并说明理由（历史取证只读；`scripts/check-repo-hygiene.mjs` 已按文件名钉死这 8 份） | 车道 A |
| D16 | 11 道门禁脚本**存在但没有任何流水线跑**（另有 2 道只在 release.yml） | `tests/unit/domain10-gate-wiring.test.mjs:71` | 未接线门禁 | `scripts/check-*.mjs` **33 道**；`ci.yml` 里 `run: pnpm run` **27 处**，实际覆盖 **20 道**（+release.yml 2 道 = 22）；**11 道零接线**、合计 **1484 行**：`check:limits`(237) / `check:icon`(166) / `check:guard`(150) / `check:compat-baseline`(289) / `check:hardcoded-ports`(147) / `check:identity`(68) / `check:gap`(47) / `check:gutter`(45) / `check:container`(44) / `check:focus`(30) / 无别名 1 道(261) | 分类处置：**接线** 3 道（`check:limits` / `check:icon` —— 登记表自述「无任何调用点」；`check:identity` 只差一步）；**合并到 `check:legacy`** 1 道（`check:guard` 与它语义重叠）；**保留并说明理由** 7 道（L0 已覆盖或依赖本机密钥） | 车道 C |
| D17 | 一道门禁脚本连 npm 别名都没有 | `scripts/check-issue-close-keywords.mjs:1` | 未接线门禁 | **261 行**；`package.json` 里 **0 处**引用；仅靠 `tests/unit/domain10-gate-wiring.test.mjs:87` 的 `SCRIPT_WITHOUT_ALIAS` 白名单「登记」它，等于永远不会被跑 | 接线（加 `check:issue-close` 别名 + 一条 `pull_request` 步骤）或删除（若判定「合并前人工看」不成立） | 车道 C |
| D18 | `src/services/**` 里大量导出没有任何外部引用 | `src/services/**` | 死代码 | 导出定义 **1653** 个，其中**外部引用为 0** 的 **407** 个；最硬的一批 **11 个只有定义行命中**：`useAuth`(`src/services/auth/store.ts:488`)、`hasAuthTransport`(`src/services/auth/store.ts:191`)、`resetFingerprintSignalForTest`(`src/services/invite/fingerprint.ts:312`)、`getFingerprintSignal`(`src/services/invite/fingerprint.ts:292`)、`isDeviceFp`(`src/services/invite/fingerprint.ts:171`)、`clearServerKeyMark`(`src/services/api/apiConfig.ts:398`)、`getAttachmentTextSource`(`src/services/attachments/contextBuilder.ts:254`)、`PdfTextItem`(`src/services/attachments/parsers/pdfLoader.ts:65`)、`hasStreamNoticeActions`(`src/services/chat/streamNotice.ts:37`)、`setConsumeClient`(`src/services/consumeClient.ts:29`)、`REASON_DOMAIN`(`src/services/diagnostics/reasons.ts:127`) | 删除（先删这 11 条；`resetFingerprintSignalForTest` 注释写着「仅供单测」，实际单测也从没调用过 —— 假接口）**判据须带 `-w`**：不带词边界时 `useAuth` 会顺带命中 `useAuthStore`（`src/components/auth/AccountRow.tsx:4` 等 4 行），看上去像「有人在用」 | 车道 B |
| D19 | `scripts/**` 里同类零引用导出 | `scripts/**` | 死代码 | 导出定义 **428** 个，外部引用为 0 的 **125** 个；只有定义行命中的 **10 条**：`firstExisting`(`scripts/release-common.mjs:67`)、`readJsonFile`(`scripts/release-common.mjs:80`)、`TRI_STATES`(`scripts/flaky-registry.mjs:592`)、`TRI_STATE_TEXT`(`scripts/flaky-registry.mjs:594`)、`flakyCountWithin`(`scripts/flaky-registry.mjs:218`)、`INFRA_SIGNATURE_NOTE`(`scripts/flaky-registry.mjs:130`)、`appendLog`(`scripts/compat/lib/device.mjs:201`)、`requireIdleHost`(`scripts/compat/lib/device.mjs:88`)、`RANDOM_CHARS`(`scripts/publish-private-apk.mjs:122`)、`browserslistTargets`(`scripts/lib/compatBaseline.mjs:114`) | 删除（10 条全删；删完 `node --check` 逐个脚本） | 车道 A |
| D20 | 同一脚本挂了 3 个别名，其中 2 个没人用 | `package.json:78` | 兼容层残留 | `check:docs` / `check:docrefs` / `check:doc-refs` 三行指向同一个 `scripts/check-doc-refs.mjs`；全仓引用次数：`check:doc-refs` **27**、`check:docs` **2**（1 处是脚本自己注释）、`check:docrefs` **0** | 删除（删 `check:docrefs` 与 `check:docs`，同步改 2 处文字；CI 用的是 `check:doc-refs`，不受影响） | 车道 A |
| D21 | 老账号额度迁移是**自带到期日、但没人检查到期日**的临时兼容层 | `src/legacy/migration/`（6 文件）、`src/i18n/zh.ts:974` | 兼容层残留 | 目录 **6 个文件 / 899 行**，`@remove-after 1.6.0`（当前版本 **1.4.3**）；`grep -rln @remove-after scripts tests` → **0 个文件**（没有任何门禁读这个标记）；配套 i18n key **8 条 × 2 语言**；6 处生产 import | 接线（加一条 L0：`version >= 1.6.0` 且目录仍在 → 红，以及「删目录时 8+8 条 key 必须一并清零」） | 车道 C（断言）+ 车道 B（到期删除） |
| D22 | 两道门禁语义重叠（`check:guard` 与 `check:legacy` 都在扫 ES5 语法） | `scripts/check-guard-es5.mjs:18` / `scripts/check-bundle-syntax.mjs:1` | 兼容层残留 | `check:guard` **150 行**未接线、`check:legacy` 已接线且带现场负向对照（`__ciNeg` 注入）；登记表自己写的是「存量与 `check:legacy` 重叠，待定是否合并」——**待定了整整一轮没动** | 合并到 `check:legacy`（把 guard 的守卫顺序检查并入，删 150 行重复脚本） | 车道 C |

## 二、量化合计（按类型）

| 类型 | 条目 | 量化合计 |
| --- | --- | --- |
| 第二份真相源 | D01–D04（其中 D04 核实为否） | 2 个模块入口（435 行 vs 5866 行 / 8 vs 12 处 import）+ 2 份黑名单（各 2 项、0 条一致性断言）+ 8 条重复文案 |
| 孤儿资源 | D05–D11（其中 D06/D11 核实为否） | 生产机：12 项 / 64MB（清单引用 0）+ 回滚物 10 文件 184KB + 重复清单备份 7.4KB；仓库：`docs/ui` 未引用图片 266 张 / 26.6MB |
| 过期文档 | D12–D15 | WARN 7 条（5 条结构行 + 2 条空行区间）；2 处注释声称的门禁不存在；1 处注释数字漂移（5 → 8） |
| 未接线门禁 | D16–D17（外加 D22 合并项） | 33 道脚本 / CI 跑 20 道 / 11 道零接线 / **1484 行** + 1 道无别名 261 行 |
| 死代码 | D18–D19 | 2081 个导出定义里 **532 个外部引用为 0**；最硬 **21 条只有定义行命中**（src 11 + scripts 10） |
| 兼容层残留 | D20–D22（D21 含 D14 的数字漂移） | 3 个别名 → 1 个脚本（2 个死别名）；899 行 + 16 条 key 的到期日无人检查；150 行重复门禁 |

## 三、被核实为「不是债务」的三条（省下次再查一遍的成本）

1. **`LIMITS` 没有第二份数字**（D04）：`attachments/limits.ts` 43 行纯转出，4 位以上数字 0 个，`check-limits` 通过。
2. **`android/app/build/` 没有误入库**（D11）：`git ls-files` 0 个文件，`.gitignore` 两道都挡住了。
3. **`docs/repro/**` 不该删**（D15）：它是被门禁豁免的历史取证，且被 3 处测试当「假红出处」引用。
   顺带：`/opt/dl-private/apk/` 8 个 APK 全部在清单里（引用 8/8 = 1），删了就 404 —— 也是活资源（D06）。

## 四、本批建议做（5 条，低风险：无行为变更、不碰生产机、不动 `ci.yml`）

| 批次 | 条目 | 为什么低风险 | 谁做 |
| --- | --- | --- | --- |
| B1-1 | **D19** 删 `scripts/**` 10 条零引用导出（4 个文件） | 只有定义行命中；删完逐个 `node --check`；不进任何构建产物 | 车道 A |
| B1-2 | **D18** 删 `src/services/**` 11 条零引用导出 | 同上，但过 `npx tsc` + `oxlint`；不动行为（没有任何调用点） | 车道 B |
| B1-3 | **D20** 删 `check:docrefs` / `check:docs` 两个死别名 + 改 2 处文字 | CI 用的是 `check:doc-refs`，删的是没人调用的键 | 车道 A |
| B1-4 | **D12** 修 4 条非生成器 WARN（`docs/baseurl-config-research.md` 4 处） | 只改文档定位方式（结构行 → 函数名），不动判定口径 | 车道 A |
| B1-5 | **D02** 加一致性断言：两份废弃域黑名单逐项相等 | 纯新增断言，不改名单本身；**负向对照**：给任一份加一项 → 必须红 | 车道 C |

## 五、后续批

| 批次 | 条目 | 前置条件 |
| --- | --- | --- |
| B2（门禁） | **D16** 3 道接线 + **D17** 1 道加别名 + **D22** 合并 guard→legacy | 需改 `ci.yml`（#285「明确不做」里说「除单独讨论」，故本批不动）；#651 裁决后再做 |
| B3（结构） | **D01** `attachments.ts` 并入目录、**D03** 兜底页文案去重、**D14** 注释数字 | D01 动 `src/services/attachments/**`，须先在车道 B 声明与 A/C 无交集 |
| B4（到期） | **D21** `@remove-after` 断言、**D13** 注释与接线对齐 | 与 B2 同一批改 CI 时一起做 |
| B5（生产机，#662） | **D05** 12 包 64MB 归档、**D08** 回滚物归整、**D09** 删重复备份 | 需 #652 放行；验收含 #637 的四条复验重跑 |
| B6（体积决策，#661） | **D10** 266 张 26.6MB 截图 | 需人类裁决「删 / 外迁 / 补索引」 |
| 不动作 | **D04 / D06 / D07 / D11 / D15** | 已核实为否或不该删，理由写在总表「处置」列 |

## 六、复现命令

```bash
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8

# D01 两个模块入口
wc -l src/services/attachments.ts; git ls-files 'src/services/attachments/**/*.ts' | wc -l
grep -rEn "from '[^']*services/attachments\.js'" src | wc -l        # → 8
grep -rEn "from '[^']*services/attachments/[^']*'" src | wc -l      # → 12

# D02 两份黑名单（第二份在 gradle）+ 有没有断言钉住
grep -n CONSUME_DEPRECATED_MARKERS android/app/build.gradle
grep -rn DEPRECATED_MARKERS scripts/lib/consumeEndpoints.mjs
git grep -c CONSUME_DEPRECATED_MARKERS -- tests/ | wc -l            # → 0

# D04 阈值是不是只有一份
node scripts/check-limits.mjs; grep -oE "[0-9]{4,}" src/services/attachments/limits.ts | wc -l   # → 0

# D16/D17 门禁接线面
grep -c "run: pnpm run" .github/workflows/ci.yml                    # → 27
ls scripts/check-*.mjs | wc -l                                      # → 33
grep -c '"check:' package.json

# D18/D19 零引用导出（脚本按「定义行之外 0 命中」判）
#   实现见 PR 说明；单条复核：
git grep -wn useAuth -- src tests scripts | wc -l                   # → 1（只有定义行）
git grep -c useAuth -- src/services/attachments src/components | wc -l   # → 0（见 #285 评论的负向对照）

# D12 文档漂移
node scripts/check-doc-refs.mjs | tail -3                           # → 合格（有 WARN）：FAIL 0 / WARN 7

# D21 到期日有没有人检查
grep -rln "@remove-after" scripts tests | wc -l                     # → 0
```

生产机部分（D05–D09）在自己的机器上复现：

```bash
ls -1 /opt/dl-private/private | wc -l; du -sh /opt/dl-private/private          # → 12 / 64M
for n in $(ls /opt/dl-private/private); do grep -c "$n" /opt/dl-private/releases.internal.json; done   # → 12 个 0
ls -1 /opt/dl-private/apk | wc -l; ls -1 /root/dl-release-backups | wc -l      # → 8 / 10
sha256sum /opt/dl-private/releases.internal.json.bak-1795225673                # → 与线上清单同 sha256
```
