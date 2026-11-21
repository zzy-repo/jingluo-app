# `docs/ui/**` —— 界面取证产物索引与留存判据

本目录是**已关闭 issue 的界面取证产物**：截图、一次性测量脚本、`result-*.json` / `metrics.json`、
logcat 摘录。**口径**：除各子目录 README 另注明的，全部是 **Playwright Chromium（headless）浏览器视口截图
（deviceScaleFactor = 2）或 Android Emulator（x86_64，`swiftshader_indirect`）截图**，**不是真机**；
「未测」= 没跑过，不是通过。

`#302` 只做两件事：**同 blob 去重**、**大文件外置/摘录**。任何一张图承载的结论都没有被删掉 ——
被删的 4 张全部是「同一屏的别名副本」，逐条列在下面的表里，且删之前 `git grep` 证明零引用。

## 门禁

```bash
pnpm check:hygiene     # scripts/check-repo-hygiene.mjs：本机绝对路径 + 单文本文件 > 512 KiB
pnpm check:ui-shots    # scripts/check-ui-shots.mjs：每张截图必须有出处 + 每处引用必须指得着（#661）
```

`#302` 起本目录**没有目录级豁免**（`EXEMPT_ABS_DIRS` 已删）：一次性 `measure/cdp/weaknet` 脚本里的
adb 默认值改成走 `PATH` 的 `adb`，`result-180.json` / `firstscreen-results.json` 的 provenance 字段改成
仓库相对路径或 `<worktree>` 占位。

## 硬约定：**提交截图必须被某份文档引用**

`docs/ui/**` 的图片只进不出过一次（#661：553 张里 155 张、17.4 MiB 在仓库任何 tracked 文本里零命中），
所以这条不靠自觉，靠门禁：

> **一张截图要么出现在某份文档 / 测试 / 脚本的正文里（写全文件名或能被通配指到），要么不许进仓库。**
> 新增取证产物时，同一次提交里必须带上指向它的那份 `README.md`（子目录 README 的表格里写全文件名即可）。

验证命令（CI 里是同一步 `pnpm check:ui-shots`，`scripts/check-ui-shots.mjs`）：

```bash
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8
pnpm check:ui-shots                    # 孤儿截图 + 悬空引用，双向判；红即拦
node scripts/check-ui-shots.mjs --list # 逐条看是哪张图没人要 / 哪处引用指空

# 手判单张（= #661 用的双判据；两条都无命中才算未引用）
git grep -l -F "<文件名>.png" -- docs tests scripts '*.md'
git grep -l -F "<文件名>.png"
```

「没人引用」的图**不要直接 `rm`**：按 #661 的流程先在仓库外归档（保留目录结构 + `MANIFEST.txt`
记 sha256 / 字节 / 路径），再一个 commit `git rm`，这样要还原时 `cp` 回去就行。
归档位置与前后体积见 `docs/debt-inventory.md` 的 D10。

## 留存判据（谁必须留、谁可以删）

| 类别 | 判定 | 处置 |
| --- | --- | --- |
| **关单证据** | 被子目录 `README.md` / `result-*.json` / `metrics.json` / `tests/**` 引用，或在 README 的结论表里被点名 | **必须留**，路径不许动 |
| **过程帧 / 别名副本** | 与另一张图**同 blob**，且文件名互为别名（同一屏、同一场景），且 `git grep` 零引用 | 可删；删前在本表登记 |
| **跨场景同字节** | 同 blob 但文件名描述的是**不同**场景/视口 | **保留**：像素相同本身就是该单的观察结果（如「修前页面根本滚不动，top 与 bottom 两帧一致」），删了等于毁证 |
| **全量 logcat / 原始大图** | 单文本文件 > 512 KiB、或数 MB 的原始渲染图 | 仓库只留**摘录**与结论；全文按 json 里的字段重新采集 |

## `#302` 去重（删除 4 张，共 175 154 B）

| 删除的文件 | 字节 | 与之同 blob 的**保留**副本 | 为什么不是结论证据 |
| --- | --- | --- | --- |
| `1.4.0-beta.1-settings-apikey.png` | 69 048 | `1.4.0-beta.2-url-import-web.png`（`tests/integration/url-import-web.test.mjs:87` 生成） | 内容其实是 URL 导入页，**不是** beta.1 的「设置 → API Key」屏；文件名与像素对不上，属误存副本。该名字下的真实截图本来就不存在（要就重拍），留着只会误导 |
| `1.4.0-beta.2-url-import-device-done.png` | 66 558 | `1.4.0-beta.2-url-import-device-final.png` | 同一屏同一状态的两次命名（`done` / `final`），两文件互为别名，`final` 是 README 口径里的终点帧 |
| `motion-settings-open.png` | 26 335 | `motion-settings-t250.png`（`tests/integration/motion.test.mjs:822` 必查） | 动效同一帧的两个名字；`-t250` 是被测试点名的那份，`-open` 无任何引用 |
| `motion-sidebar-open.png` | 13 213 | `motion-sidebar-t250.png`（`tests/integration/motion.test.mjs:822` 必查） | 同上 |

删除前证据（每个文件名在整个仓库的 md/json/html/txt/mjs/ts 里零命中）：

```bash
git grep -n -F 1.4.0-beta.1-settings-apikey.png -- '*.md' '*.json' '*.html' '*.txt' '*.mjs' '*.ts'
# 无输出（其余 3 个同理）
```

## 同 blob 但**保留**的 10 组（去重后剩 10 组 20 个文件：冗余副本 740 599 B，整组 1 481 198 B）

这些「重复」是**跨场景/跨视口**或**被文档点名**的，删掉会毁证或断链：

| 保留的文件对 | 字节 | 留下的理由 |
| --- | --- | --- |
| `thinking-collapse/before-390-default.png` = `after-390-expanded.png` | 265 889 | 两份都被 `thinking-collapse/README.md` 引用，且分别代表「改动前」与「展开后」。**像素完全相同是待复核的异常**（见下方「遗留」） |
| `thinking-collapse/before-360-default.png` = `after-360-expanded.png` | 221 218 | 同上（360 视口） |
| `215-focus-visible/360/focus-215-02-…-360.png` = `390/…-390.png` | 5 603 | 被 `215-focus-visible/360/metrics.json` 引用（逐文件列了 5 张 360 图），且 360/390 是两档视口的取证结构 |
| `215-focus-visible/360/focus-215-03-…-360.png` = `49-import-skipped/360/import-skipped-01-…png` | 105 069 | 同上：前者被 `215-focus-visible/360/metrics.json` 引用，后者被 `49-import-skipped/360/metrics.json` 引用，两边都不能断 |
| `1.3.0-openai-caps.png` = `1.3.0-openai-done.png` | 54 757 | 两份都是 `tests/integration/full-acceptance.test.mjs`（`:769` / `:803`）的生成目标，删了跑测试会重写工作树 |
| `feedback-scroll/before-360x640-1-bottom.png` = `before-360x640-1.5-keyboard-bottom.png` | 39 241 | 跨场景同字节（1.0 与 1.5 键盘档）；两帧一致正是「修前滚不动」的观察结果 |
| `feedback-scroll/before-360x640-1.5-no-dvh-bottom.png` = `…-no-dvh-top.png` | 33 288 | 同场景 top/bottom 两帧一致，同上（去掉 `dvh` 后浏览器不支持 → 根本没滚动） |
| `214-container-query/360/{after-fix,before-chromium105plus,before-chromium83-simulated}.html` = `390/*.html` | 15 534 | `214-container-query/README.md` 的「目录内容」表点名了 `390/*.html` 与 `360/*.html` 两套源码；且 `generate.mjs` 会重新生成（删了立刻回来） |

## `#302` 大文件外置（共 957 877 B）

| 文件 | 前 | 后 | 说明 |
| --- | --- | --- | --- |
| `180-guard-i18n/api30/logcat-api30.txt` | 539 949 B / 4 213 行 | 23 844 B / 181 行 | 按 #291「logcat 摘录口径」：头 20 KiB + 全部 `SyntaxError` / `JavaScript Error` / `FATAL EXCEPTION` / `AndroidRuntime` / `E Capacitor` / `boot-guard` 行 + 横幅写明原文大小与省略行数 |
| `180-guard-i18n/api29/logcat-api29.txt` | 316 342 B / 2 385 行 | 24 903 B / 129 行 | 同上 |
| `180-guard-i18n/api26/logcat-api26.txt` | 117 083 B / 831 行 | 24 400 B / 164 行 | 同上；`README.md` 里引用的守卫行走号从原文 505 改成摘录内的 144 |
| `app-icon/source.png` | 1 025 854 B | 968 204 B | 无损重编码（Pillow `optimize=True, compress_level=9`）：**解码后逐像素完全相同**（maxdiff = 0），1254×1254 尺寸与色彩不变，`scripts/gen-app-icon.py` 的输入契约不变 |

## `#661` 孤儿截图外迁（删除 155 张，共 18 205 597 B）

`docs/ui` 只进不出攒下的那批「谁的结论都不依赖」的图，在 #661 里**先归档、再删**：

| 项 | 值 |
| --- | --- |
| 归档位置（**仓库外**） | `/root/archived-ui-shots-661/`（保留 `docs/ui/…` 目录结构） |
| 清单 | `MANIFEST.txt`（155 行：`sha256  size_bytes  path`）+ `MANIFEST.paths`（155 行，可 `cp` 还原） |
| 归档体积 | 18 231 036 B（155 张 PNG 合计 18 205 597 B） |
| 判定口径 | 双判据（`grep -rl "<文件名>" docs/ tests/ scripts/ *.md` + `git grep -l "<文件名>"`）**都零命中**；`360/*.png`、`quota-{390,360}.png` 这类通配、祖先裸名、`metrics.json` 的 stem key（`390/01-失败-有缓存兜底`）、`.md` 目录级连带**都算引用**，先扣掉再判 |
| 按 basename 字面判 | 261 张 / 25.8 MiB（含被通配/前缀/目录连带指着的 106 张，故不是删除口径） |
| 最终删除 | **155 张 / 17.4 MiB**，一个 commit `git rm`（`git revert` 可整体还原） |
| 体积 | `63 447 574 B → 45 242 283 B`（−18.2 MB / −28.7%）；图片 `553 → 398` 张 |
| 保留 | 每张「只被目录/README 连带引用」的图都留了；2 张人工豁免见 `scripts/check-ui-shots.mjs` 的 `EXEMPT`（#213） |

## 前后对比

| 指标 | `#302` 前（`origin/main` @ 7a65f55） | `#302` 后 | 差 |
| --- | --- | --- | --- |
| 文件数 | 499 | 496（删 4 张重复图 + 新增本索引） | −3 |
| 体积 | 41 412 040 B / 39.4936 MiB | 40 287 085 B / 38.4208 MiB | −1 124 955 B / −1.0728 MiB（−2.7%） |
| `check:hygiene` 本目录豁免 | 整目录 `docs/ui/` 前缀豁免（本机路径命中 38 处 / 13 文件） | 零豁免、零命中 | 目录级豁免整条删除 |

> 未达 #302 正文写的「≤ 300 文件 / ≤ 20 MiB」：那需要删掉**成百张关单结论截图**（`docs/ui` 的主体），
> 与本单「不删任何被引用证据」的边界冲突。本单交付的是「零证据损失的 1.08 MiB」，
> 剩下的体积压缩要么走 issue 附件 / release 资产外置（需要先定哪张图不再是证据），要么另开单处理。

## 遗留（本次未处理，需另开单）

1. **`thinking-collapse` 的 before/after 同字节**：`before-{360,390}-default.png` 与 `after-{360,390}-expanded.png`
   逐字节相同，但 README 把前者写成「改动前：思考正文整段铺在消息里」、后者写成「展开后：正文出现」。
   两者不可能同像素 —— 极可能是其中一张存错。**未在此单重拍**（要起 `rspack serve` + 注入 IndexedDB）。
2. 索引不全：398 张 PNG 里只有 33 个子目录有 `README.md`，根目录另有 **32 个散图**靠文件名
   （`1.4.0-beta.8-ours-pay-…`）标识出处。要做「同一屏多帧只留首末帧」那一步，得先把这些散图标进索引。
   （#661 之前是 363 张 + 根目录 131 个散图；那 99 个散图在 #661 里因为**零引用**被归档外迁了，
   剩下的 32 个是「文件名字面出现在某份文档/测试里」的。）
