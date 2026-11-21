# v1.4.4-staging 发布 runbook（车道 A｜只发 GitHub Release）

> **状态：未解锁，现在不能发。**

> 本文件的跨文件引用**刻意用「函数名 / 章节标题」锚点而不是行号**：今天实测 #691 合入后 1 小时内就把 `build.gradle` 的 3 处行号挪走、`consumeEndpoints` 2 处也漂，行号锚点在并行开发时必然失效。
> 本文件是「解锁之后照抄执行」的机械清单，**不是**「已经能发了」的结论。当前唯一阻塞点是
> staging 后端是**明文 HTTP**，被三道守卫拦着（§3），而解锁方式（A / B）**尚未决定**（§4）。
> 谁要发布：先按 §5 的前置门逐条跑通、把输出贴到 #652；任一门不绿就停在这里，不要往下走。

| 项 | 值 |
| --- | --- |
| tag | `v1.4.4-staging`（**必须 prerelease**） |
| 资产名 | `deepseek-chat-1.4.4-staging.apk`（名字里必须带 `-staging`） |
| 渠道 | **只发 GitHub Release** |
| dl 侧 | **零写入**（不写 `releases.json`、不上 `/apk/`、不动 `latest`、不动 `download.primaryBase`） |
| 版本源 | `package.json` 的 `version` / `androidVersionCode`（唯一来源） |
| staging 后端 | `http://140.210.13.146:16000`（明文，**当前被拦**） |

---

## 1. 铁律（先读完再动手）

### 1.1 只发 GitHub Release

发布渠道只有一个：GitHub 的 Release 页面。`docs/RELEASE-MANUAL.md` 的 §6.1「发 GitHub Release（正式渠道）」
那一节是正式渠道的写法（锚点用章节名，不用行号：上方每加一行它就会指到别处）；
`v1.4.3` 之后 dl 分发机不再是发布渠道（#614 决定 2）。

### 1.2 dl 侧零写入

本单**不产出**任何 dl 侧变更。逐条钉死：

| 禁止动作 | 为什么 |
| --- | --- |
| 不跑 `pnpm release:upload` | 它就是往 dl 写的那一步（`scripts/release-upload.mjs:3`） |
| 不跑 `pnpm release:private` | 私有包发布器，同样落到 dl 侧（`scripts/publish-private-apk.mjs:3`） |
| 不写 `releases.json` / 不上 `/apk/` / 不动 `latest` | staging 包不进任何公网清单 |
| 不改 `config/endpoints.json` 的 `download` 段 | `download.primaryBase` 在 `config/endpoints.json:18`，本次一个字都不动 |

staging 包只活在 GitHub Release 上。**任何情况下都不写 dl** —— 包括回滚（§8）。

### 1.3 本次必须 prerelease

- `prerelease=true`，且资产名带 `-staging`；
- 不允许「反正内容一样，就直接发成正式版」——正式版是 `v1.4.4`，本次不是它。

---

## 2. 为什么不能用 `release.yml`（必须手工 `gh release create`）

`.github/workflows/release.yml` 是正式发布用的，它对我们这次 tag 有**两个硬冲突**，任一条都会红：

1. **tag 版本必须等于 `package.json` 的 `version`**：工作流把 tag 去掉 `v` 前缀后逐字比较
   （`.github/workflows/release.yml:95`）。`v1.4.4-staging` → `1.4.4-staging`，而
   `package.json` 的 `version` 只能是 `1.4.4`（gradle 用它当 `versionName`，
   见 `android/app/build.gradle:646`）→ 必然 `::error::` 退出。
   把 `version` 改成 `1.4.4-staging` 也救不了：`versionName` 会变成 `1.4.4-staging`，
   包内版本与正式版对不上，属于「为了过闸改产物」。
2. **prerelease 由 `version` 里有没有 `-` 推断**（`.github/workflows/release.yml:103`），
   而上面那条已经把「`version` 里带 `-`」排除掉了 —— 所以这个工作流即使能跑，
   也只会把我们发成 **正式版**，正好是本次要避免的。

结论：**本次手工执行 `gh release create`**，`--prerelease` 显式给。
工作流里那套 draft → 上传 → 回读 → publish 的顺序照抄（`§6.5`），只是不经过 CI。

---

## 3. 三道守卫：只放宽构建期 = 装上去白屏

staging 地址是 `http://140.210.13.146:16000`（明文）。它今天撞三道墙，**三道都要处理**：

| # | 层 | 位置 | 判据 | 现象 |
| --- | --- | --- | --- | --- |
| ① | 构建期（web 产物） | `scripts/lib/consumeEndpoints.mjs:185`，由 `scripts/build.mjs` 在打包前调用（调用点：`build.mjs` 里 `applyBaseOverrides(config, raw)` 那一处） | `consume.baseUrl` 必须 `https://`，唯一例外是本机回环（`scripts/lib/consumeEndpoints.mjs:164`） | `pnpm build` 在打第一个字节前就中止 |
| ② | 构建期（gradle） | `android/app/build.gradle:209`（https）+ `android/app/build.gradle:212`（命中废弃域黑名单） | 黑名单 `android/app/build.gradle:141` 里**就含 `140.210.13.146`** | `assembleRelease` 在配置阶段 `GradleException` |
| ③ | **运行时** | `src/services/consume/http.ts:179` | 同一套判据：非 https 且非回环 → 抛 `ConsumeConfigError` | **App 白屏** |

> **2026-11-21 更新（#693 / #601 守卫的补正面）**：①②③ 三层现在都有**显式放行通道**（staging-only）——
> web 构建期 `ALLOW_INSECURE_CONSUME=true`、原生构建期 `-PallowInsecureConsume=true`，产物带
> `INSECURE_CONSUME=true` 自证标记，`pnpm verify:apk` 不带 `--allow-insecure` 直接 exit 1。
> 也就是说：**不必再为了过①③ 去改配置或拆守卫**；但明文包仍然只许内网 staging 联调，**禁止公开分发**。

### 3.1 为什么②过不去：那个 IP 本身在黑名单里

`android/app/build.gradle:141` 的 `CONSUME_DEPRECATED_MARKERS` 含 `140.210.13.146`（历史旧池域）。
所以**即使**给 staging 挂上 https 证书、写成 `https://140.210.13.146:16000`，也照样被②拦
（黑名单是「命中即拒」，不看协议）。A 分支因此只能用**域名**，不能用这个 IP 起头。

### 3.1b 地址是怎么进产物的（#691 之后，先搞清楚再谈解锁）

改地址有两条通道，**只有一条能改到真正发请求的那一层**（`docs/RELEASE-MANUAL.md` §14「换消费后端地址」是同一结论）：

| 通道 | 改到哪 | 能不能用 |
| --- | --- | --- |
| `CONSUME_BASE_OVERRIDE=<值> pnpm build`（构建期环境变量，`scripts/lib/consumeEndpoints.mjs:67`） | web 产物里的 `__ENDPOINTS__.consume.baseUrl` | ✅ **唯一正确路径**；判据与配置文件同一套（所以照样要过①） |
| `-PconsumeBase=<值>`（gradle 属性） | 只有原生侧 `BuildConfig.CONSUME_BASE`，没有任何 Java/Kotlin 读它 | ❌ 现在会被**闸 0**拦下：gradle 把 `-PconsumeBase` 与 web 产物自述交叉核对，不一致直接 `BUILD FAILED`（`android/app/build.gradle:807`） |

也就是说：**用 `-PconsumeBase` 出包得到的是一份「看起来改了、实际仍打生产」的包**（#651 实测），
这条缝已被 #691 封住。本 runbook 一律走 `CONSUME_BASE_OVERRIDE`。

### 3.2 为什么只放宽构建期会白屏

`src/main.tsx:100` 是**模块级**调用 `getConsumeClient()`；它一路同步走到
`src/services/consume/index.ts:180` →`src/services/consume/http.ts:268` 读配置，
配置非法就在**模块求值阶段**抛异常（`src/services/consume/http.ts:189`）。
入口模块抛异常 = React 一个字节都没渲染 = 白屏，且界面上没有任何提示（用户只看到空白页）。

也就是说：**②放宽了能出包，但包装上去必定白屏**。②和③必须同时处理，见 §4 的「三层同源」。

---

## 4. 解锁分支 A / B（**未定，必须有人拍板**）

> 这一节的两个分支都还没有被选中。选定之前，本 runbook 的执行部分（§6）**不许开始**。
> 选定后把选择与理由记在 #652，并把 **#651 上对应的决策** 链上（跨车道）。

### 4.1 A 分支：staging 挂 https，客户端零改动

| 项 | 内容 |
| --- | --- |
| 前提 | staging 有 TLS 反代，前端拿一个**域名**的 https 地址（例：`https://staging-<名字>.<域>`），不能用 IP（见 §3.1） |
| 客户端改动 | **零**：`http.ts` 的运行时判据对 https 天然放行（`src/services/consume/http.ts:189`），不新增 flag、不新增标记 |
| 地址怎么进产物 | `CONSUME_BASE_OVERRIDE=https://<staging-域名> pnpm build`（零仓库改动，§3.1b）；**不要**用 `-PconsumeBase`（闸 0 会拦），也**不必**改 `config/endpoints.json`（`config/endpoints.json:22` 保持生产值） |
| 好处 | 三处判据一行代码都不用动，没有「放宽后忘了收回」的风险 |
| 代价 | 要有人把 staging 的证书 / 域名做出来（运维动作，不在本仓库） |
| 产物自证 | APK 内 bundle 命中 staging 域名 ≥1，命中 `sub2api.rose7.cn` = 0（§5 G5 证据 4） |

### 4.2 B 分支：三层同源放行 flag + APK 内标记 + `verify:apk` 放行参数

B 的本质是「**承认这个包不能分发**」，所以必须三层一起改，缺一层就是白屏或漏网：

| 层 | 要落的改动 | 为什么不能省 |
| --- | --- | --- |
| 构建期（web） | `scripts/lib/consumeEndpoints.mjs:239` 增加「显式放行明文」的通道（flag），仅当该 flag 打开时放行非回环 `http://` | ①不改，`pnpm build` 直接中止 |
| 构建期（gradle） | `android/app/build.gradle:242` / `:212` 同步同一 flag（`140.210.13.146` 在 `:141` 黑名单里） | ②不改，`assembleRelease` 中止 |
| 运行时 | `src/services/consume/http.ts:189` 的同一 flag 必须**编译进产物**并生效 | ③不改，**装上去白屏**（§3.2） |
| APK 内标记 | 新 `<meta-data …INSECURE_CONSUME="true">`，与现有两项同风格（`android/app/src/main/AndroidManifest.xml:31`、`:38`） | 让「这个包是明文后端」成为**产物内的事实**，可被检察；改标记必须重签名 |
| 校验脚本 | `scripts/verify-release-apk.mjs` 增加放行参数（今天**没有**这个参数，见 `scripts/verify-release-apk.mjs:16` 的用法行） | 不加，`verify:apk` 会把任意明文后端包判成 fail，人就会去绕过门禁 |

「**三层同源**」的可机械判定（任一层缺失就是没解锁）：

```bash
# 三层 + 校验脚本 必须同时命中，且指向同一枚 flag 名（下例假定名字为 INSECURE_CONSUME）
grep -c 'INSECURE_CONSUME' src/services/consume/http.ts            # ≥1
grep -c 'INSECURE_CONSUME' android/app/build.gradle               # ≥1
grep -c 'INSECURE_CONSUME' android/app/src/main/AndroidManifest.xml  # ≥1
grep -c 'INSECURE_CONSUME\|allow-insecure' scripts/verify-release-apk.mjs  # ≥1
```

> 今天（`origin/main`）上面四条**全部为 0** —— 这就是「未解锁」的机械化证据。
> B 分支的 flag 名字、默认值、以及「谁来跑放行参数」都还没定，别照抄上面的名字当结论。

---

## 5. 前置门（缺一不发）

每条都给可执行校验。**六条全绿**才允许进 §6；任何一条红就停。

> G3 / G4 / G5 跑的就是 §6.1–§6.3 那同一套命令：先在一个 commit 上把门跑绿（证明「能出包」），
> 再在 §6 里对**要发布的那份产物**重跑并留证。所以 G5 里的 `$APK` 指的是 §6.2 改名后的
> `deepseek-chat-1.4.4-staging.apk`；只跑 G5 而不跑 §6.2 的人，会在第一步（文件不存在）就停住 ——
> 这是有意的。

### G1 #676 契约已完成（记 PR / commit）

```bash
gh issue view 676 --json state,closedAt --jq '"#676 " + .state + " closedAt=" + .closedAt'
# 期望：#676 CLOSED closedAt=2026-11-21T04:39:45Z

gh pr view 688 --json number,state,mergedAt,mergeCommit --jq '"PR #" + (.number|tostring) + " " + .state + " @" + .mergedAt + " merge=" + .mergeCommit.oid'
# 期望：PR #688 MERGED @2026-11-21T04:55:51Z merge=23ec1c5…

git log --oneline -1 23ec1c5   # docs+fix(consume): #676 契约逐节核对表…
test -f docs/consume-676-contract-audit.md && echo "契约核对表在"   # 正文见 docs/consume-676-contract-audit.md:1
```

**门禁**：issue 状态 `CLOSED` **且** PR #688 已合并 **且** commit `23ec1c5` 在 `origin/main` 上。
三个值抄进 §7 的回报。

### G2 consume 地址走的是「合法通道」（按 §4 选定分支二选一）

**A 分支（https 域名）**：

```bash
# A 分支要注入的值（§3.1b 的通道：构建期环境变量，零仓库改动）
export CONSUME_BASE_OVERRIDE='https://<staging-域名>'

node -e '
const v = process.env.CONSUME_BASE_OVERRIDE || "";
if (v === "") { console.error("CONSUME_BASE_OVERRIDE 没设：A 分支靠它把地址注进 web 产物"); process.exit(1); }
const u = new URL(v);
if (u.protocol !== "https:") { console.error("A 分支要求 https：", v); process.exit(1); }
if (/140\.210\.13\.146|:60013/.test(v)) {
  console.error("命中 gradle 废弃域黑名单（android/app/build.gradle:141）：", v); process.exit(1);
}
if (/^https:\/\/\d+\.\d+\.\d+\.\d+/.test(v)) { console.error("A 分支要用域名，不用裸 IP：", v); process.exit(1); }
console.log("A OK，将注入:", v);
'
pnpm run check:consume-api          # 源码里不许有明文 http 副本（scripts/check-consume-api.mjs:183 那条判据）
```

**构建日志必须自证「地址被覆盖了」**（`scripts/build.mjs:98` 打的这一行，别跳过）：

```bash
grep -q 'override by CONSUME_BASE_OVERRIDE' /tmp/build.log && echo "覆盖生效" || echo "FAIL：日志里没有 override 那一行，产物仍打配置文件里的地址"
```

**B 分支（三层同源放行）**：先跑 §4.2 的四条 `grep`（必须全部 ≥1），再跑：

```bash
export CONSUME_BASE_OVERRIDE='http://140.210.13.146:16000'      # B 分支要注入的明文地址
node -p 'process.env.CONSUME_BASE_OVERRIDE'                     # 记录本次实际注入的地址
node scripts/check-consume-api.mjs                              # 不动的话仍应绿
```

**门禁**：A 的输出 `A OK: https://…`；B 的四条 `grep` 全部 ≥1 且 `check:consume-api` 绿。
**两者都不成立的，直接停** —— 不要「先把地址写进去试试能不能编过」。

### G3 `main` CI 全绿 + 本地能出包

```bash
git fetch origin main --quiet
SHA_MAIN=$(git rev-parse origin/main)
echo "origin/main = $SHA_MAIN"

gh run list --branch main --limit 5 --json workflowName,status,conclusion,headSha \
  --jq '.[] | select(.headSha=="'"$SHA_MAIN"'") | .workflowName + " " + .status + "/" + (.conclusion // "-")'
# 期望：该 SHA 上的 ci.yml 为 completed/success（release.yml 只在 tag 上跑，这里不该出现）
```

构建三连（在**同一个 SHA** 上）：

```bash
git status --short          # 必须干净：release 从干净 checkout 出包
pnpm install --frozen-lockfile
pnpm run check:keystore     # 签名材料形状门禁（缺了就红，见 docs/RELEASE-MANUAL.md §1）
pnpm build 2>&1 | tee /tmp/build.log   # 构建期守卫①在这里生效；日志要留（G2 要 grep）
npx cap sync android        # dist → android/app/src/main/assets/public
```

**门禁**：CI success、`pnpm build` 绿、`dist/static/js` 有产物。

### G4 `assembleRelease` 能出包（且只有 standard 变体）

```bash
cd android
./gradlew --no-daemon --console=plain --max-workers=1 assembleRelease -PartifactVariant=standard
cd ..
ls -1 android/app/build/outputs/apk/release/*.apk
```

**门禁**：gradle 绿、`…/apk/release/*.apk` **恰好 1 个**。
`-PartifactVariant=standard` 与 `pnpm build`（standard）必须同源（`android/app/build.gradle:529` 读这个属性）。

### G5 产物四证据（缺一不发）

`APK` 指本次产物（`§6.2` 里已重命名成带 `-staging` 的那个文件）。

#### 证据 1：`debuggable=0`，**四判据**（四条都要有输出）

```bash
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:?先设 ANDROID_HOME 或 ANDROID_SDK_ROOT}}"
BT="$(ls -d "$ANDROID_HOME"/build-tools/36.* 2>/dev/null | sort -V | tail -1)"
AAPT2="$BT/aapt2"; AAPT="$BT/aapt"; APKSIGNER="$BT/apksigner"; AKZ="$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer"

# 判据 1/4：apkanalyzer
"$AKZ" manifest print "$APK" | grep -c 'android:debuggable' || true      # 期望 0

# 判据 2/4：aapt2
"$AAPT2" dump badging "$APK" | grep -ci 'application-debuggable' || true # 期望 0

# 判据 3/4：aapt（老工具，独立实现）
"$AAPT" dump badging "$APK" | grep -ci 'application-debuggable' || true  # 期望 0

# 判据 4/4：仓库自带判定器（零依赖，不读 SDK）
node scripts/check-apk-debuggable.mjs "$APK"; echo "exit=$?"             # 期望 exit=0
```

> 第 4 条是**唯一判定入口**（`scripts/check-apk-debuggable.mjs:46` 的 `evaluateApkDebuggable`），
> `verify:apk` 复用的就是它。前三条是**独立实现**的交叉验证：一台机器上 aapt2 版本不对、
> 或者 zip 解析被绕过，另外三条里总有一条会红。

#### 证据 2：证书指纹

```bash
"$APKSIGNER" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: *//p' | head -1
# 期望：e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1
"$APKSIGNER" verify "$APK" > /dev/null && echo "apksigner verify: OK"
```

#### 证据 3：sha256 **三处一致**

```bash
sha256sum "$APK" | awk '{print $1}'
node -e 'const{createHash}=require("crypto");const fs=require("fs");console.log(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$APK"
openssl dgst -sha256 "$APK" | awk '{print $NF}'
# 三行必须逐字相同；任何不同都说明你比的不是同一个文件
```

#### 证据 4：APK 内 consume 地址断言（按分支二选一）

```bash
# 把包里的 web 产物取出来（bundle 是真正发请求的那份）
unzip -p "$APK" 'assets/public/static/js/main.*.js' > /tmp/apk-bundle.js
wc -c < /tmp/apk-bundle.js      # 必须是正数：取不到文件说明路径变了，先修这条命令

# —— A 分支（https 域名）——
grep -o 'https://<staging-域名>' /tmp/apk-bundle.js | wc -l     # 期望 ≥1
grep -o 'sub2api\.rose7\.cn' /tmp/apk-bundle.js | wc -l         # 期望 0（生产域名不许出现）

# —— B 分支（明文 staging）——
grep -o ':16000' /tmp/apk-bundle.js | wc -l                     # 期望 ≥1
grep -o 'sub2api\.rose7\.cn' /tmp/apk-bundle.js | wc -l         # 期望 0
"$AAPT2" dump xmltree --file AndroidManifest.xml "$APK" | grep -c 'INSECURE_CONSUME'   # 期望 ≥1
```

**门禁**：四证据全部按上面「期望」出现，逐条贴进 §7。

### G6 已选定解锁分支，且 #651 有对应记录

```bash
gh issue view 651 --json state,title --jq '.state + " " + .title'
gh issue view 652 --json state,title --jq '.state + " " + .title'
```

**门禁**：#652 上有一条明确写着「走 A」或「走 B」的记录（含理由）。**没拍板 = 不发**。

---

## 6. 执行步骤（解锁后照抄）

> 前提：§5 六门全绿。**任何一条红了就回到 §5，不要用「先发出去再说」绕过。**

### 6.1 版本 bump（唯一版本源 = `package.json`）

`package.json:3`（`version`）与 `package.json:4`（`androidVersionCode`）是**唯一版本源**：
gradle 从它读 `versionName` / `versionCode`（`android/app/build.gradle:646` 与 `android/app/build.gradle:645`），
`android/` 里再没有第二处版本号。

```bash
git fetch origin main --quiet
git switch -c chore/release-1.4.4-staging origin/main    # 不许直接推 main（AGENTS.md「禁止」）

# 只改这两个字段（1.4.3/22 → 1.4.4/23）
sed -i 's/"version": "1\.4\.3"/"version": "1.4.4"/; s/"androidVersionCode": 22/"androidVersionCode": 23/' package.json

git diff --unified=0 package.json
git diff --numstat package.json      # 期望：2	2	package.json（只有两行动过；多一行就说明手滑改了别处）
```

清单：

- [ ] `version` = `1.4.4`（tag 是 `v1.4.4-staging`，去掉 `v` 和 `-staging` 才是它）
- [ ] `androidVersionCode` = `23` > 上一个已发布 tag 的 22：
      `git show v1.4.3:package.json | grep androidVersionCode`
- [ ] `CHANGELOG.md` 有 `## 1.4.4 (2026-11-21) — …` 段（staging 也写，方便回头对照）
- [ ] `git diff --numstat package.json` 是 `2 2`

提交 → PR（base `main`）→ CI 全绿 → 合并，然后记下合并 commit：

```bash
MERGE_SHA=$(git rev-parse origin/main); echo "MERGE_SHA=$MERGE_SHA"
git show "$MERGE_SHA:package.json" | grep -E '"version"|androidVersionCode'   # 确认 1.4.4 / 23
```

> **不要在合并前手推 tag**：tag 由 §6.5 的 `gh release create --target` 创建（指到 `$MERGE_SHA`）。
> 提前手推 tag 会让 `--target` 失效，tag 指到错的 commit 上。

### 6.2 构建四步（在 `$MERGE_SHA` 上，干净 checkout）

```bash
git switch --detach "$MERGE_SHA"
git status --short                    # 必须空

pnpm install --frozen-lockfile        # ①
pnpm build 2>&1 | tee /tmp/build.log  # ② standard 产物 → dist/（守卫①在这里生效）
                                     #    地址用 CONSUME_BASE_OVERRIDE 注入（§3.1b）：
                                     #    A → CONSUME_BASE_OVERRIDE=https://<staging-域名> pnpm build
                                     #    B → CONSUME_BASE_OVERRIDE=http://140.210.13.146:16000 pnpm build
                                     #    日志必须出现 (override by CONSUME_BASE_OVERRIDE)
npx cap sync android                  # ③ dist → android/app/src/main/assets/public
( cd android && ./gradlew --no-daemon --console=plain --max-workers=1 \
    assembleRelease -PartifactVariant=standard )   # ④
```

产物**必须恰好 1 个 APK**，然后改名成带 `-staging` 的发布名：

```bash
mapfile -t APKS < <(ls -1 android/app/build/outputs/apk/release/*.apk 2>/dev/null)
if [ "${#APKS[@]}" -ne 1 ]; then
  echo "FAIL: release 输出目录里有 ${#APKS[@]} 个 APK，无法确定发哪个"; printf '%s\n' "${APKS[@]}"; exit 1
fi
APK="deepseek-chat-1.4.4-staging.apk"
cp "${APKS[0]}" "$APK"
ls -l "$APK"
```

### 6.3 证据采集

把 §G5 的四段命令原样跑一遍，输出存文件（回报要贴）。下面的 `$APK` / `$AKZ` / `$AAPT2` /
`$AAPT` / `$APKSIGNER` 都来自 §6.2 与 G5 那两块，**同一个 shell 里连着跑**：

```bash
{
  echo "== debuggable 四判据 =="
  "$AKZ" manifest print "$APK" | grep -c 'android:debuggable' || true
  "$AAPT2" dump badging "$APK" | grep -ci 'application-debuggable' || true
  "$AAPT" dump badging "$APK" | grep -ci 'application-debuggable' || true
  node scripts/check-apk-debuggable.mjs "$APK"; echo "check-apk exit=$?"
  echo "== 证书 =="
  "$APKSIGNER" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: *//p' | head -1
  echo "== sha256 三处 =="
  sha256sum "$APK" | awk '{print $1}'
  node -e 'const{createHash}=require("crypto");const fs=require("fs");console.log(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$APK"
  openssl dgst -sha256 "$APK" | awk '{print $NF}'
  echo "== size =="
  stat -c%s "$APK"
} | tee /tmp/staging-evidence.txt
```

### 6.4 生成 Release 正文（必含 staging 警告 + 公开部分自证）

```bash
SHA256=$(sha256sum "$APK" | awk '{print $1}')
SIZE=$(stat -c%s "$APK")

cat > notes.md <<'EOF'
## deepseek-chat 1.4.4-staging

> ⚠️ **这是 staging（预发布）构建，禁止当作正式版分发**
>
> - 后端指向 **staging 环境**：账号 / 数据 / 额度与生产**不互通**，可能随时清库
> - 资产名带 `-staging`，本 Release 标为 **prerelease**，不进「Latest」
> - 用途只有一个：#676 契约联调验收。正式版请等 `v1.4.4`
> - 装过正式版的机器：本包**不是**升级路径，请先卸载

- versionName: `1.4.4`
- versionCode: `23`
- 资产: `deepseek-chat-1.4.4-staging.apk`
- 大小: <SIZE> bytes
- SHA-256: `<SHA256>`
- 包内 ARTIFACT_VARIANT: `standard`；`application-debuggable` 计数为 0
- 签名证书 SHA-256: `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`

### 校验方法

下载后先核对指纹，再安装（下面两行是终端命令，逐行跑）：

    sha256sum deepseek-chat-1.4.4-staging.apk                       # 应等于上面的 SHA-256
    apksigner verify --print-certs deepseek-chat-1.4.4-staging.apk  # digest 应等于上面的证书指纹
EOF

sed -i "s/<SHA256>/$SHA256/; s/<SIZE>/$SIZE/" notes.md
```

**公开部分自证（机械化门禁，fail-closed）** —— 正文里**不许**出现任何内网信息：

```bash
# 注意：这条规则用「类别」而不是把具体私有路径写进本文件（本文件自己也不留那串路径）
# 七类：URL / baseUrl 字样 / 回环 / IPv4 / staging 端口 / 生产域名 / 清单与令牌 / 私有绝对路径
forbid='(https?|ftp)://|base_?url|127\.0\.0\.1|localhost|[0-9]{1,3}(\.[0-9]{1,3}){3}|:16000|rose7\.cn|ecsafe\.cn|sub2api|releases\.json|primaryBase|fallbackBase|token|/(var|opt|root|home|etc|srv)/|内网|私有清单'

if grep -nEi "$forbid" notes.md; then
  echo "FAIL：正文命中上面的禁区（逐条见上），改掉再发"; exit 1
else
  echo "OK：正文 0 命中 —— 私有绝对路径 / IPv4 / :16000 / rose7.cn / releases.json / primaryBase / token 全部为 0"
fi
```

期望输出：`OK：正文 0 命中 …`。**只要有一行命中就不许往下走。**

> 正文里出现 staging 的地址、IP、端口、生产域名、清单文件名、令牌字样，都算事故：
> Release 资产与正文对全世界可见。

### 6.5 先 draft → 上传 → 下载回读 → 再 publish

顺序照抄 `release.yml` 那套（`.github/workflows/release.yml:455` 是它的 draft 分支）：
**核对没过就永远不会出现「看起来还能下」的包。**

```bash
TAG=v1.4.4-staging

# ① 建 draft（tag 由这一步创建，指到合并 commit）
gh release create "$TAG" \
  --draft \
  --prerelease \
  --target "$MERGE_SHA" \
  --title "v1.4.4-staging" \
  --notes-file notes.md

# ② 只挂那一个 APK
gh release upload "$TAG" "$APK" --clobber

# ③ 资产必须恰好 1 个，且名字正确
gh release view "$TAG" --json assets --jq '.assets[].name'
gh release view "$TAG" --json assets --jq '.assets | length'      # 期望 1

# ④ 下载回来逐字节核对
rm -rf /tmp/verify && mkdir -p /tmp/verify
gh release download "$TAG" --pattern "$APK" --dir /tmp/verify
sha256sum /tmp/verify/"$APK" | awk '{print $1}'                   # 必须等于 $SHA256
stat -c%s /tmp/verify/"$APK"                                      # 必须等于 $SIZE

# ⑤ 前三步全绿才 publish（draft=false），prerelease 再写一次
gh release edit "$TAG" --draft=false --prerelease --title "$TAG" --notes-file notes.md

# ⑥ 终态自证
gh release view "$TAG" --json tagName,isDraft,isPrerelease,targetCommitish \
  --jq '.tagName + " draft=" + (.isDraft|tostring) + " prerelease=" + (.isPrerelease|tostring) + " target=" + (.targetCommitish|tostring)'
# 期望：v1.4.4-staging draft=false prerelease=true target=<MERGE_SHA>
```

### 6.6 发布后核对（公网侧）

```bash
REPO=zzy-repo/deepseek-app
curl -fL -o /tmp/pub.apk "https://github.com/$REPO/releases/download/v1.4.4-staging/deepseek-chat-1.4.4-staging.apk"
sha256sum /tmp/pub.apk | awk '{print $1}'      # 必须等于 $SHA256
stat -c%s /tmp/pub.apk                          # 必须等于 $SIZE

# 正文再查一遍（发布后的真实正文，不是本地 notes.md）；$forbid 沿用 §6.4 那一条
gh release view v1.4.4-staging --json body --jq '.body' > /tmp/pub-body.md
grep -cEi "$forbid" /tmp/pub-body.md || true    # 期望 0
grep -c 'staging（预发布）构建，禁止当作正式版分发' /tmp/pub-body.md   # 期望 1（警告原文在）
```

然后按 `docs/RELEASE-MANUAL.md:502` 那节的姿势再走一遍「下载回来比 hash」（本单只比 GitHub 这一个源，不涉及 dl）。

---

## 7. 回报模板（贴 #652，四项）

> 四项之外不加叙述。**没有证据的那项写「未取证」，不要写「正常」。**

```
【v1.4.4-staging 发布回报】解锁分支：A / B（二选一，写选定）
1) tag：v1.4.4-staging（prerelease=true，draft=false，target=MERGE_SHA=<sha>）
   合并 commit / PR：<PR 号> <sha>
2) 资产名：deepseek-chat-1.4.4-staging.apk（资产数=1）
   size：<SIZE> bytes
3) sha256：<SHA256>
   三处一致：sha256sum=<同> / node crypto=<同> / openssl dgst=<同>
   证书：e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1
4) debuggable 证据（四判据，全 0 / exit=0）
   apkanalyzer=0 / aapt2=0 / aapt=0 / check-apk-debuggable=clean(exit 0)
   APK 内地址断言：<域名 或 :16000> 命中 <n>；生产域名 <sub2api.rose7.cn> 命中 0
   下载回读：公网 sha256=<同>、size=<同>、资产数=1
   dl 侧写入：0（未跑 release:upload / release:private，未改 download 段）
```

---

## 8. 失败即回滚

任何一步红了：**先停手**，Release 保持 draft（对外不可见），按下面处理。

```bash
TAG=v1.4.4-staging

# 情形 1：还没 publish（draft 阶段出问题）—— 删掉重来，或先留 draft
gh release delete "$TAG" --yes          # 彻底删（含 tag）
# 或：保留 draft 不发，等下次核对通过再 --draft=false
gh release view "$TAG" --json isDraft,isPrerelease

# 情形 2：已经 publish 了才发现错（比如正文漏东西 / 资产传错）
gh release edit "$TAG" --draft          # ① 先降回 draft：立刻对外不可见
gh release delete "$TAG" --yes          # ② 再删（会连 tag 一起删）

# 情形 3：tag 被单独创建过（例如手推过），逐个删
git push origin :refs/tags/v1.4.4-staging
git tag -d "$TAG" 2>/dev/null || true
git ls-remote --tags origin "refs/tags/$TAG"   # 期望：空输出
```

回滚清单：

- [ ] Release 已删除（或处于 draft 且明确记录在 #652 上「为什么不发」）
- [ ] 远端无 `refs/tags/v1.4.4-staging`（`git ls-remote --tags origin` 里看不到）
- [ ] 本地无同名 tag
- [ ] **dl 侧零写入**：没跑过 `pnpm release:upload` / `pnpm release:private`，
      `releases.json` / `/apk/` / `latest` / `config/endpoints.json` 的 `download` 段一个字节都没动
- [ ] 失败原因 + 实际输出贴到 #652（不要只写「失败了」）

> 回滚**不动** dl。往 dl 写「撤回记录」「错误版本占位」都是本单明令禁止的动作。

---

## 9. 出这个门禁链条之外不要做的事

- 不要为了过闸改 `EXPECTED_CERT_SHA256`（`android/app/build.gradle` 的签名闸）：换证书 = 已装用户无法覆盖升级。
- 不要退回 `assembleDebug`（`android:debuggable="true"` 禁止发布）。
- **不要为省事去改 `config/endpoints.json` 的 `consume.baseUrl`**：那条路把 staging 地址写进了仓库
  （忘还原 = 正式构建打到 staging）。正路是 `CONSUME_BASE_OVERRIDE`（§3.1b），零仓库改动。
- 不要跳过 §5 的六门「因为 CI 绿了」：CI 不认识 staging，它只回答「正式路径没坏」。

---

## 10. 本文件自己的维护（行号会漂）

本文档引用了 30+ 处 `文件:行`，而**行号会随别人改动漂移**——本文件第一次合并后的下一小时，
#691 就在 `android/app/build.gradle` 里插了 ~70 行（闸 0），把原先指向 458 / 574 / 654 行的三处引用一次全挪走。
所以：**任何改动本文件的人，改完必须跑**

```bash
node scripts/check-doc-refs.mjs   # exit 0 才算数；WARN 也不留（结构行定位换成赋值行/常量）
```

它只能证明「引用还指得着」，**不能**证明「写的内容还对」——内容对不对只能读代码复核。
