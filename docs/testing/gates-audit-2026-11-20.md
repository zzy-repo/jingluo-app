# 门禁体检：28 道 `scripts/check-*.mjs` 的三态（2026-11-20，#487）

> 结论先写：**跑不起来的门禁比判红的门禁危险得多** —— 判红至少有人会去看，跑不起来的那道，
> 在 CI 里表现为「一条红」，但在人的印象里表现为「这道门禁一直都在」，实际上它什么都没查。
> 本次体检的起因是一份报告说 `check:dup-impl` 在 main 上崩溃（`MODULE_NOT_FOUND`），
> 实测那是**命令里的文件名写错**（见 §2）；真正的失效项是另外三个（见 §3）。

## 1. 方法与复现

三态定义（本文件全篇只用这三个词）：

| 状态 | 判据 | 含义 |
| --- | --- | --- |
| **OK** | `exit 0` | 门禁跑起来了，且当前仓库判定通过 |
| **FAIL** | `exit 1` | 门禁跑起来了，判定**红**（真缺陷，或设计上就该红的阶段） |
| **BROKEN** | `exit 2` / 抛异常 / `MODULE_NOT_FOUND` | 门禁**没跑起来**：用法错、环境缺、入口不存在 —— 这一格等于零覆盖 |

复现命令（与 CI 同环境：Node 24 / LANG=zh_CN）：

```
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8
for f in scripts/check-*.mjs; do printf "%-42s " "$f"; timeout 120 node "$f" >/dev/null 2>&1 && echo OK || echo "FAIL/BROKEN($?)"; done
```

## 2. `check:dup-impl` 的「崩溃」根因：文件名，不是脚本

报告里的命令是 ~~`node scripts/check-dup-impl.mjs`~~，而仓库里**从来没有过**这个文件：

```
$ git log --all --oneline -- scripts/check-dup-impl.mjs
（空）
$ node scripts/check-dup-impl.mjs
Error: Cannot find module '/…/scripts/check-dup-impl.mjs'   code: 'MODULE_NOT_FOUND', requireStack: []
```

`package.json` 的别名指向的是另一个名字，CI 走的也是别名，所以流水线上这道门禁**一直是好的**：

```
"check:dup-impl": "node scripts/check-duplicate-impl.mjs"
$ pnpm run check:dup-impl
扫描 scripts / tests 下 424 个 .mjs/.js/.cjs 文件，字节重复 0 组（白名单放行 0 组）
OK：没有字节完全相同的两份实现        # exit 0
```

即：这是**一份「命令抄错了」的报告**，不是门禁坏了。但它暴露了两个真问题，本次都修了：

1. **没有任何东西会检查「别名 → 文件」还指得着**。谁把 `check:dup-impl` 写成
   ~~`scripts/check-dup-impl.mjs`~~（少 `duplicate`），CI 那一步就是 `MODULE_NOT_FOUND`，
   而 review 只会看到「门禁脚本还在仓库里」。 → `tests/unit/domain10-gate-wiring.test.mjs` 新增 W4。
2. **门禁口径与它的名字不符**：它叫「重复实现」，却只扫 `scripts/` 与 `tests/`。
   **复制一个 `src/` 文件改个名，全仓没有任何门禁会红** —— 而 #289 的原始事故正是「原样复制」。
   → 扫描范围扩到 `src/`（同时扩 `.ts` / `.tsx`）。

### 2.1 负向对照（证明它真会咬）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 干净仓库 | exit 0 | ✅ exit 0 |
| 复制 `scripts/lib/endpoints.mjs` → `endpoints-copy-nc.mjs` | exit 1 | ✅ exit 1（打印 sha256 + 两个文件名） |
| 复制 `src/services/invite/api.ts` → `api-copy-nc.ts` | exit 1 | ✅ exit 1（扩范围前是 **exit 0** —— 这就是漏洞） |
| 删掉副本 | exit 0 | ✅ exit 0 |

## 3. 真正的失效项（本次修掉 / 记录）

### 3.1 `check:doc-refs` 在 main 上已经红了，而且它把后面 20 步全吞掉了

main 最新的 push run（`44700028925`）实测：

```
✔ 仓库卫生（check:hygiene）   ✔ 重复实现（check:dup-impl）
✔ 测试布局（check:test-layout） ✔ 测试重复检测（check:test-duplication）
✖ 文档引用门禁（check:doc-refs）
- 负向对照 / Type check / Lint / Unit tests / Build / bundle-target / legacy / matrix /
  ip / manifest / dl-release / i18n / endpoints / capabilities / log-coverage / redact …
  → 全部 skipped（20 步）
```

根因是**两个 PR 的交叉**，不是谁写坏了脚本：

- #491 新增 `docs/testing/rebuild-plan.md`，里面有一张「删除清单」，逐条写着**要删的测试文件路径**；
  合并那一刻这些文件还在，所以它的 CI 绿。
- #492 真把那些测试删了，但它的 PR CI 跑在 #491 合并**之前**的树上（08:01 vs 08:06），
  于是「文档引用一个刚被删掉的文件」这件事没有在任何一次 CI 里被同时看到。
- 两个 PR 先后落 main，`check:doc-refs` 立刻红了 —— 而它排在紧前面，后面 20 步一个都没跑。

修法（`scripts/check-doc-refs.mjs` + `docs/testing/rebuild-plan.md`）：给门禁加一条**显式的
「已删除」标记** —— 文档里写成 `~~路径~~`（删除线）即表示「曾有、现已删除」，门禁计数但不判红：

```
  已删除（删除线 ~~…~~ 标记，视为「曾存在、现已删除」）8 处，不判定；改引用为真活路径时请去掉删除线
  合格（有 WARN）：没有硬错误
```

为什么不是「把清单里的路径删掉」：删除清单的价值就在于**写清删了什么**（`docs/testing/rebuild-plan.md`
是 #487 阶段③重建回归基准的输入，删了清单，重建时没人知道哪些已经不存在）。

顺带修掉的一个**隐形后门**：删除线里的路径此前被「`~` 开头的路径是家目录」那条规则**静默丢掉**，
也就是说任何文档只要给死引用套一层 `~~` 就能过门禁，而且没人知道发生过（`docs/capabilities/api.md`
的 V1 行早就在用这个写法，只是没人察觉）。现在这类引用**单独计数并打印**，放行是可见的。

### 3.2 13 道门禁没接线，其中 10 道连交代都没有

`scripts/check-*.mjs` 共 **28** 道，`ci.yml` / `release.yml` 实际跑到 **15** 道。剩下 13 道里，
`tests/unit/domain10-gate-wiring.test.mjs` 原来只登记了 3 道（`check:identity` / `check:apk` / `check:guard`），
另外 10 道**完全没人提**（`check:limits` / `check:icon` / `check:gap` / `check:focus` / `check:gutter` /
`check:container` / `check:compat-baseline` / `check:hardcoded-ports` / `check:keystore` / `check:refactor-direction`）。
这正是 #362 说的病：**脚本能判红 ≠ 有人在跑**。本次把这张账**补全并写清理由**（W4 + `KNOWN_UNWIRED`），
并把「纯文本、<1.1s、当前全绿」的那批的接线 diff 放在 PR 正文里（按约束不改 `ci.yml`）。

### 3.3 `check:keystore` 从未在任何流水线上跑过

它裸跑必然 `exit 2`（缺本机 `android/keystore/keystore.properties`，该文件不入库），
`ci.yml` / `release.yml` 都没有它的步骤 —— 也就是说「签名凭据形状」这道门禁**只存在于文档里**。
本次只登记（不接 CI：CI 无密钥，硬接就是恒红），接法建议写进 PR 正文。

## 4. 三态总表（28 道）

「裸跑」= 直接 `node scripts/check-*.mjs`，无 dist、无 apk、无 keystore；「有产物」= `pnpm run build:internal` 之后。

| # | 门禁脚本 | npm 别名 | CI 接线 | 裸跑 | 有产物 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | check-apk-debuggable | check:apk | release.yml（按产物逐个跑） | BROKEN(2) | BROKEN(2) | 需 apk 参数；L0 里 G7 用合成 APK 做过正负对照，脚本本体没问题 |
| 2 | check-bundle-syntax | check:legacy | ci.yml | BROKEN(2) | **OK** | 无 dist 时按环境错退出（不是跳过） |
| 3 | check-bundle-target | check:bundle-target | ci.yml | FAIL(1) | **OK** | 无 dist 时**判红**（#298 的设计：没产物=没检查） |
| 4 | check-capabilities | check:capabilities | ci.yml（warn 档） | OK | OK | 10 处已知缺陷在案，故 warn |
| 5 | check-compat-baseline | check:compat-baseline | ✗ | OK | OK | 语义由 L0 用例覆盖；建议接线 |
| 6 | check-container-query-fallback | check:container | ✗ | OK | OK | 语义由 L0 用例覆盖；建议接线 |
| 7 | check-css-gap-fallback | check:gap | ✗ | OK | OK | 建议接线（<210ms） |
| 8 | check-doc-refs | check:doc-refs | ci.yml | **FAIL(1) → OK** | **OK** | **本次修复**（§3.1） |
| 9 | check-duplicate-impl | check:dup-impl | ci.yml | OK | OK | 本次扩范围到 `src/`（§2） |
| 10 | check-endpoints | check:endpoints | ci.yml | OK | OK | |
| 11 | check-focus-visible-fallback | check:focus | ✗ | OK | OK | 建议接线（<150ms） |
| 12 | check-guard-es5 | check:guard | ✗ | OK | OK | 已登记未接线 |
| 13 | check-hardcoded-ip | check:ip | ci.yml | OK | OK | |
| 14 | check-hardcoded-ports | check:hardcoded-ports | ✗ | OK | OK | 语义由 L0 用例覆盖 |
| 15 | check-i18n | check:i18n | ci.yml | OK | OK | 带现场负向对照 |
| 16 | check-icon-edges | check:icon | ✗ | OK | OK | 本次新增登记 |
| 17 | check-identity | check:identity | ✗ | OK | OK | 已登记未接线 |
| 18 | check-issue-close-keywords | （无别名） | ✗ | OK | OK | 手工跑；本次登记 |
| 19 | check-keystore-config | check:keystore | ✗ | BROKEN(2) | BROKEN(2) | 需本机密钥文件（§3.3） |
| 20 | check-limits | check:limits | ✗ | OK | OK | 本次新增登记 |
| 21 | check-log-coverage | check:log-coverage | ci.yml | OK | OK | 缺口在基线里 |
| 22 | check-manifest-fixtures | check:manifest | ci.yml | OK | OK | |
| 23 | check-redact | check:redact | ci.yml（含 `--selftest` 负向对照） | OK | OK | |
| 24 | check-refactor-direction | check:refactor-direction | ✗（#487 明确推迟） | FAIL(1) | FAIL(1) | **设计性红**：A1/A3 未收口前就该红，接了 CI 等于天天红 |
| 25 | check-repo-hygiene | check:hygiene | ci.yml | OK | OK | |
| 26 | check-scrollbar-gutter-fallback | check:gutter | ✗ | OK | OK | 建议接线（<90ms） |
| 27 | check-test-duplication | check:test-duplication | ci.yml | OK | OK | |
| 28 | check-test-layout | check:test-layout | ci.yml（`-- --strict`） | OK | OK | |

合计（有产物口径）：**OK 25 / FAIL 1（设计性）/ BROKEN 2（需参数或本机密钥，均非脚本缺陷）**。

## 5. 已知仍未覆盖的（写下来，别当成已验）

1. `check:keystore` 没有任何自动入口 —— 谁改坏 `keystore.properties` 的形状，只有发版当天才会知道。
2. 10 道未接线门禁仍是「手跑才有效」；PR 正文给了接线 diff，需要一次 `ci.yml` 改动（本单按约束不改）。
3. 本次体检只验「脚本能不能跑、判得对不对」，**不验**每道门禁的判据是否还覆盖真实风险 —— 那是各门禁自己的 issue。
