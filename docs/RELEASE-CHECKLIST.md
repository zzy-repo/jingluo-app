# 发布执行清单（换人也照着做）

> 本文件回答一个问题：**「今天换一个只有一枚发布令牌的人，能不能把 1.4.0-beta.10 发出去？」**
> 顺序写死：**阶段 A 定版本（Windows/任意机）→ 阶段 B 构建（那台 Linux 签名机）→ 阶段 C 上传（任意机 + 令牌）
> → 阶段 D 打 tag（任意机）→ 阶段 E 校验（任意机）**。每一步都有「成功判据」和「失败怎么退回去」。
>
> 与 [`docs/RELEASE-MANUAL.md`](RELEASE-MANUAL.md) 的分工：MANUAL 是单机全流程手册 + 为什么这么做（含背景、坑、验收记录）；
> 本文件是**可跨机器交接的执行清单**（顺序 / 命令 / 判据 / 回滚）。两者冲突时以 MANUAL 的原理说明为准、以本文件的命令为准，
> 并请顺手改掉过期的一方。契约细节见 [`docs/dl-release-api.md`](dl-release-api.md) 与 [`docs/releases-manifest.md`](releases-manifest.md)。

## 0. 前提（不成立就别开工）

- **唯一事实来源是 `https://dl.rose7.cn/releases.json`**：App 自动更新读它，`.github/workflows/release.yml` 也从它取
  `file` / `md5` / `size` / `changes` 去镜像 GitHub Release。**它里面没有的版本，tag 打上去 CI 一定 404。**
- **APK 不在 CI 里构建**，只在那台持有签名 keystore 的 Linux 机器上构建。
- **上传要在打 tag 之前完成**（顺序颠倒 = 404，见上面两条）。
- 版本号唯一来源是仓库根 `package.json`：`version` → Android `versionName`，`androidVersionCode` → `versionCode`
  （`android/app/build.gradle` 在构建时读它，缺了直接 `GradleException`）。

一次发布需要两样「凭证类」的东西，都不进仓库：

| 东西 | 谁有 | 本清单哪一步用 |
| --- | --- | --- |
| APK 签名 keystore（`/root/.android/debug.keystore`） | **只有那台 Linux 构建机**（阶段 B） | 阶段 B |
| dl-release 发布令牌（`Authorization: Bearer <release-token>`） | 按人发放，见 §4 | 阶段 C |

除此之外，任何人都应该能凭「自己的 GitHub 账号 + 上面第一样东西产出的 APK」把流程走完。

## 1. 总览

| 阶段 | 在哪台机器 | 需要什么 | 脚本化的部分 | 通过判据（一句话） | 大概耗时 |
| --- | --- | --- | --- | --- | --- |
| **A 定版本** | Windows 开发机或任意有 git+node 的机器 | git、node 22、pnpm | `pnpm run release:check` | PR 合并进 `main`，拿到 merge commit | 10 分钟 |
| **B 构建** | **那台 Linux 签名机**（不可替代） | JDK 21、Android SDK、`/root/.android/debug.keystore` | `pnpm run release:check --apk` | 产物存在、sha256 记下来、证书指纹不变 | 10–20 分钟 |
| **C 上传** | 任意机器（要能拿到 APK 文件） | 发布令牌 | `pnpm run release:upload` | 服务端 `ok:true` 且回包 sha256 == 本地 | 2 分钟 |
| **D 打 tag** | 任意机器 | 自己的 GitHub 账号（能 push tag） | 无（`git` + `gh`） | `release.yml` 跑绿、`gh release view` 能看到资产 | 5 分钟 |
| **E 校验** | 任意机器 | 网络（能下 APK） | `pnpm run release:verify` | 三方 hash 一致（本地 / releases.json / dl 下载件）+ 烟测通过 | 10 分钟 |

失败回滚速查见 §6；哪些步骤必须人工、哪些必须那台机器、为什么，见 §3。

---

## 2. 逐步执行

下面的例子统一用这两个变量，`<...>` 是要你自己填的占位符（**别把真实令牌值粘进任何文件**）：

```bash
V=1.4.0-beta.10            # 本次要发的版本，必须等于 package.json 的 version
APK=android/app/build/outputs/apk/release/app-release.apk
```

### 阶段 A｜定版本（Windows 侧 / 任意机器）

#### A1. bump `package.json`（version + androidVersionCode）

- 做：`version` 改成本次版本，`androidVersionCode` **加 1**（必须严格大于线上 latest 的 versionCode，否则上传 409）。
  Windows 上不要用「复制粘贴一整段 JSON」，逐行改。
- 成功判据：`grep -n '"version"\|androidVersionCode' package.json` 两行都对，且 `androidVersionCode` 是正整数、比上一版大 1。
- 失败回滚：还没提交，`git checkout -- package.json` 即可。

#### A2. 写 `CHANGELOG.md` 的 `## <version> (YYYY-MM-DD) — 一句话标题` 段

- 做：这一段的 `- ` 条目会被脚本抽成 dl 的 `meta.changes`，也会进 GitHub Release notes（`release.yml` 从 `releases.json` 取）。
  **写用户看得懂的话**（「修复低内核机型白屏」），不要写「refactor xxx」。

> **处在服务端迁移窗口期时（现在就是）**：本段 `changes` 里**必须**带一条给运维的提醒——旧机
> `62.106.70.167` 下线前，先在旧 IP 的三个端口返回「请升级」响应并跑满到下一次发版之后
> （对话端口要给可读错误、反馈端口不能回 200 假装成功）。老版本里没有任何版本检查逻辑，
> 旧机一停，用户看到的是网络错误而不是「请升级」。给用户的 `changes` 也提一句「如遇连接失败请更新到最新版本」。
> 详见 [`docs/server-migration.md`](server-migration.md) §2。

- 成功判据：`head -20 CHANGELOG.md` 第一段就是本次版本。
- 失败回滚：同上，未提交就 `git checkout -- CHANGELOG.md`。

#### A3. 跑发版前自检（离线，不联网、不读令牌）

```bash
pnpm run release:check -- --tag v$V
```

- 成功判据：最后打印 `PASS  发版前自检通过`，退出码 0。它校验的就是「三处一致」：
  `package.json.version` ↔ `CHANGELOG.md ## <version>` ↔ 即将打的 `v<version>` tag（再叠 `androidVersionCode` 合法性）。
- 失败回滚：退出码 1 = 上面三处有对不上的，按它逐条打出来的 `FAIL` 改；退出码 2 = 用法/环境问题（node 版本不够等）。
  **这一步不通过就不要往下走**，后面每一步都建立在版本号对得上的前提上。

#### A4. 提交、PR、合并，记下 merge commit

```bash
git checkout -b release/$V          # 若已有分支就复用
git add package.json CHANGELOG.md
git commit -m "chore(release): $V"
git push -u origin release/$V
gh pr create --base main --title "chore(release): $V" --body "发布 $V"
gh pr merge --squash --delete-branch
git checkout main && git pull
git rev-parse HEAD                  # ← 记下来，阶段 B 用这个 sha 构建
```

- 成功判据：`git log --oneline -1` 是 release 提交，`git rev-parse HEAD` 的 sha 记在便签上。
- 失败回滚：**还没合并** → 改分支重来；**已合并但还没上传** → `git revert` 出一个新提交（线上完全没感知）；
  **绝不 `git reset --hard` 已 push 的 `main`**。

### 阶段 B｜构建（必须在那台 Linux 签名机上）

> 这一步不能换机器：`assembleRelease` 要 `/root/.android/debug.keystore`，它的证书指纹
> `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1` 是「已装用户能覆盖升级」的唯一保证，
> `android/app/build.gradle` 的 `EXPECTED_CERT_SHA256` 会在指纹不符时直接中断构建。

#### B1. 拉取阶段 A 的 merge commit

```bash
cd <仓库目录>
git fetch origin --prune
git checkout <A4 记下的 sha>
pnpm install --frozen-lockfile
```

- 成功判据：`git rev-parse HEAD` == A4 的 sha；`pnpm install` 无错。
- 失败回滚：只影响这台机器的工作区，`git checkout <旧 sha>` 就回到原状，线上无感知。

#### B2. 构建 web 产物 + release APK

```bash
pnpm run build            # 内部包用 pnpm run build:internal（必须是 internal 变体，且与 APK 的 -PartifactVariant 一致）
cd android && ./gradlew assembleRelease && cd ..
```

- 成功判据：
  - 产物存在且非空：`ls -l $APK`；
  - APK 内版本号与 `package.json` 一致（B3 会自动查）。
- 失败回滚：产物不对就重跑 `assembleRelease`（**这一步不产生任何线上状态**，随便重跑）。
  构建报 `EXPECTED_CERT_SHA256` 不符 → **不许**去改那个常量「让它过」，那是换了签名证书；停下来另开 Issue。
  构建本身失败 → 另开 Issue 修代码，本次发布作废（阶段 A 的提交留着也没问题，反正线上没变）。

#### B3. 产物自检（在构建机上跑同一份脚本）

```bash
pnpm run release:check -- --apk $APK --tag v$V --manifest https://dl.rose7.cn/releases.json
```

- 成功判据：`PASS  发版前自检通过`，并且输出里这几行都对：
  - `APK 内 versionName = <V>`、`APK 内 versionCode = <N>`（零依赖解二进制 manifest，不需要 aapt2）；
  - `ARTIFACT_VARIANT = internal|standard` 且与 B2 的 web 构建同源；
  - `debuggable 标记不存在（release 构建类型）`；
  - `本地 versionCode <N> > 线上 latest <M>`；
  - 末尾打印 `下一步（上传）需要这个 sha256: ...` ← **抄下来，交给阶段 C**。
- 失败回滚：同 B2，重跑构建；不要为了让脚本过而改脚本里的期望值。

#### B4. 签名指纹人工复核（脚本不替你验这个）

```bash
apksigner verify --print-certs $APK | grep -i 'SHA-256'
```

- 成功判据：输出的 SHA-256 等于 `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`
  （MANUAL §4.3 有完整命令）。这条**必须人眼看**：指纹变了意味着老用户升级装不上。
- 失败回滚：指纹不对 → 这个包不许发；检查 keystore 是不是被换过，另开 Issue。

#### B5. 把产物和 sha256 交给上传方

```bash
sha256sum $APK
scp $APK <上传的机器>:/tmp/$V.apk    # 或者由构建机自己执行阶段 C（更省事，推荐）
```

- 成功判据：上传方手上文件的 `sha256sum` 等于 B3 打印的那个值。
- 失败回滚：传输不准就重传，比对不上就别上传。

### 阶段 C｜上传（任意机器 + 一枚发布令牌）

> 这一步**不需要**那台 Linux 机器，也不需要 GitHub 权限。谁有令牌谁能做。

#### C1. 注入令牌（三选一，详见 §4）

```bash
export DL_RELEASE_TOKEN=<release-token>          # 方式 1：只在当前 shell，不落盘
# 方式 2：printf %s <release-token> > ~/.config/dl-release/token && chmod 600 ~/.config/dl-release/token
# 方式 3：--token-file /path/to/token
```

- 成功判据：下面 C2 的 dry-run 会打印 `令牌  已从 $DL_RELEASE_TOKEN 读取（N 个字符，内容不打印）`。
- 失败回滚：不涉及线上状态；令牌填错就重填（不要在终端历史里留明文，见 §4.3）。

#### C2. 先 dry-run（不发请求，只核对「将要发什么」）

```bash
pnpm run release:check -- --apk $APK --expect-sha256 <B3 的 sha256>
pnpm run release:upload -- --apk $APK --dry-run
```

- 成功判据：dry-run 打印 endpoint / size / sha256 / md5 / `meta` / 每条 changes / 令牌来源，
  并以 `没有发任何网络请求` 结束；`changes` 条数与 CHANGELOG 段一致（空的话脚本会直接拒绝）。
- 失败回滚：什么都不用回滚，一个请求都没发出去。

#### C3. 真正上传

```bash
pnpm run release:upload -- --apk $APK
```

- 成功判据（缺一不可）：
  - 退出码 0；
  - `sha256 一致 <64位hex>`、`md5 一致 <32位hex>`；
  - `latest = <V>`；
  - 末尾提示 `上传成功，服务端回包与本地 sha256/md5 一致`。
- 失败回滚：
  - 退出码 **2** → 缺令牌 / 缺 APK / 版本号对不上 / APK 是 debuggable：**一个字节都没上传**，改完重跑即可。
  - 退出码 **1** → 服务端拒绝或回包不一致：先跑 `pnpm run release:verify -- --version $V` 看线上到底有没有写进去，
    再按 §6 决定重发还是回滚。**不要连续重试**（`429` 每 IP 每分钟 2 次；`409` 说明 versionCode 没涨）。

### 阶段 D｜打 tag（任意机器，需要你自己的 GitHub 账号）

> **正式发布 = GitHub Release**（裁决 #614 决定 2）。**推 tag 不会触发任何 workflow**：
> `release.yml` 已改成手动 `workflow_dispatch`，它只做「把已构建、已签名的 APK 挂成 Release 资产 + 校验 debuggable
> + 算 sha256 写进正文」，**不查 `releases.json`、不校验 dl 的 md5**。它也不构建，keystore 不出签名机。
> 所以阶段 C（上传 dl）只对 internal/私有包还有意义；standard 正式版打完 tag 直接进 D2 发 Release。

#### D1. 在阶段 A 的 merge commit 上打 tag 并推送

```bash
git fetch origin --prune
git tag -a v$V <A4 的 merge sha> -m "v$V"
git push origin v$V
```

- 成功判据：`git ls-remote --tags origin v$V` 能看到这个 tag（不依赖本地缓存）。
- 失败回滚：**只删刚推上去的、没被发布过的 tag**：`git push --delete origin v$V && git tag -d v$V`；
  若 Release 已经建出来了，先 `gh release delete v$V --repo zzy-repo/deepseek-app --yes` 再删 tag。
  **绝不把已存在的 tag 强推到别的 commit**（`-f` 会让已下载过的人拿到不一致的内容）。

#### D2. 发 GitHub Release（正式渠道，二选一）

做法 A —— 签名机上一把推（推荐）：

```bash
sha256sum $APK                              # 记下来，写进 Release 正文
gh release create v$V $APK \
  --repo zzy-repo/deepseek-app --title v$V \
  --notes-file /tmp/notes-$V.md            # 正文含 version / versionCode / commit / sha256
```

做法 B —— 手工触发 workflow（Actions → `Release` → Run workflow，`tag` 填 `v$V`，
`apk_url` 留空则优先取「Release 里已上传的 .apk 资产」，其次取 dl 上该版本的存量地址）：

```bash
gh run list --workflow release.yml --limit 3     # 手动触发的那一条
```

两端都看：

```bash
gh release view v$V --repo zzy-repo/deepseek-app
```

- 成功判据：`release.yml` 这次的 run 是 `success`；`gh release view` 显示 tag `v$V` 且带一个 `.apk` 资产，
  资产大小等于 `releases.json` 里的 `size`。
- 失败回滚：
  - run 失败且日志是「`releases.json` 里没有这个版本」→ 说明 C 阶段没生效，回去做 C，然后删 tag 重打；
  - run 失败是 GH token / 权限问题 → 找仓库管理员，不要改 workflow 文件（本单不动 `.github/workflows/**`）。

### 阶段 E｜校验（任意机器）

#### E1. 复核 releases.json 与下载件（脚本）

```bash
pnpm run release:verify -- --version $V --apk $APK --expect-variant internal
```

- 成功判据：
  - `记录字段完整性` 全绿，`versionCode 与 package.json 一致`；
  - `下载件 sha256 == 记录 sha256`，并打印 `三方一致：本地构建产物 / 线上记录 / dl 下载件`；
  - 最后 `PASS  <V> 已在线上生效，hash 一致`。
- 失败回滚：退出码 1 → **不许对外宣布发布完成**；若 tag 已经打了，按 §6 撤 tag + Release；
  线上文件与记录不一致时要找 ECS 维护者撤下该版本（dl 侧是 append-only，见 §6）。

#### E2. 手动更新一次（真机或模拟器）

```bash
# ANdroid 模拟器烟测步骤见 docs/RELEASE-MANUAL.md §8：装上一版 → 打开 App → 检查更新 → 能升到 $V
```

- 成功判据：旧版本 App 里点「检查更新」能看到 `$V` 和正确的更新说明，能下载并安装成功、启动不白屏。
- 失败回滚：装不上 / 白屏 → 立刻停手，按 §6 撤 tag 与 Release，并把该版本从更新通道撤下（需 ECS 权限）。

#### E3. 收尾

- 在 Issue 里贴：merge sha、APK sha256、`releases.json` 里这条记录、`gh release view` 输出、E2 的截图。
- 提醒下一版的开头：**线上 `latest` 现在等于当前 `version`，下一个人必须在阶段 A 先 bump `version` 和
  `androidVersionCode`**，否则 `pnpm run release:check --manifest` 会直接拦下来。

---

## 3. 哪些必须人工、哪些必须那台机器（不假装全自动）

| 步骤 | 脚本能做吗 | 必须人工 | 必须在 Linux 签名机 | 为什么 |
| --- | --- | --- | --- | --- |
| A1/A2 版本号 + CHANGELOG 文案 | 校验能，**写不能** | ✅ 要人判断「用户看得懂的一句话」 | ❌ | 变更文案是产品判断，不是格式问题 |
| A3 `release:check` | ✅ 全自动 | ❌ | ❌ | 纯离线比对，任何机器一样 |
| B2 `assembleRelease` | 半自动（要 `gradlew` + SDK） | 需人执行 | ✅ **只能是那台** | 签名 keystore 只在那台机器（`/root/.android/debug.keystore`），且本仓库约定 **APK 不在 CI 构建** |
| B4 证书指纹核对 | 可脚本（需 apksigner/JDK），当前留人工 | ✅ 要人眼看指纹 | ✅ 指纹只对这台机器上产出的包有意义 | `EXPECTED_CERT_SHA256` 不符时构建已中断；剩下的确认是「人签字」环节 |
| C 上传 | ✅ `release:upload` | ❌（只需持有令牌） | ❌ 任意机器 | 这就是本单要解耦掉的那一半 |
| D 打 tag / 推 tag | 命令可脚本，但需人执行 | ✅ 推 tag 会触发对外发布 | ❌ | 需要一个人对自己的 GitHub 账号负责；**GitHub Release 本身由 CI 创建，不手工建、也不用 gh token 代劳** |
| E1 `release:verify` | ✅ 全自动 | ❌ | ❌ | 只是读线上 + 下文件算 hash |
| E2 模拟器/真机烟测 | ❌ | ✅ | ❌ | 要看界面、要判断「白屏没有」 |
| 回滚决策 | ❌ | ✅ | 取决于是哪一步坏了 | 撤版本会影响线上用户，要有人负责 |

**结论（明确写死）**：除了「构建 release APK」必须在那台 Linux 签名机上人工执行、以及「推 tag / 烟测 / 回滚决定」必须由人来做，
其余步骤都可以在任何持有发布令牌的机器上由脚本完成。**本清单不承诺一键全自动**，也不打算把签名私钥搬出那台机器
（那才是真正的风险点，且超出本单范围）。

---

## 4. 发布令牌：怎么拿到、怎么注入、泄露了怎么办

### 4.1 从哪拿

- 令牌就是 dl-release 服务用来认「谁有权发版」的那枚 Bearer token（服务端存在 `/etc/dl-release/token`，
  `chmod 600 root:root`，见 `deploy/dl-release/`）。
- **按人发放**：在 Issue 里 @ dl-release 维护者（或在团队约定渠道说一句「我要发 X 版本，请给我一枚 release token」），
  由维护者通过私密渠道给你。**不要在 Issue / 聊天群 / 提交里贴令牌**，维护者也不该在那里发。
- 拿到后**不要**改服务端的 token 文件来「自己造一枚」——那会把别人的令牌一起作废。

### 4.2 注入（三种方式，任选一种；绝不进仓库）

```bash
# 方式 1：环境变量（推荐，只在当前 shell 生效，不落盘）
export DL_RELEASE_TOKEN=<release-token>

# 方式 2：本地不提交的文件（推荐长期使用）
mkdir -p ~/.config/dl-release
printf %s <release-token> > ~/.config/dl-release/token
chmod 600 ~/.config/dl-release/token      # Windows: %USERPROFILE%\.config\dl-release\token

# 方式 3：一次性显式指定
node scripts/release-upload.mjs --apk $APK --token-file /path/to/token
```

脚本的解析优先级（第一个命中即用）：`--token-file` → `$DL_RELEASE_TOKEN_FILE` → `$DL_RELEASE_TOKEN` → `~/.config/dl-release/token`。
**一个都没有时，脚本在发请求之前就退出 2 并告诉你三种注入方式**，不会跑一半。

### 4.3 自检姿势（不许 echo 令牌）

```bash
set +x                                    # 别让 shell 把 set -x 的展开写进日志
node scripts/release-upload.mjs --apk $APK --dry-run
# → 令牌  已从 $DL_RELEASE_TOKEN 读取（48 个字符，内容不打印）
```

脚本只打印**来源**和**长度**，从不打印值；`--dry-run` 也不发网络请求。
把命令贴给别人求助时，先把 `export DL_RELEASE_TOKEN=...` 那一行删掉。

### 4.4 泄露止损（顺序别反）

1. **先轮换**（在 ECS 上，需要 root）：
   `head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48 > /etc/dl-release/token`
   然后重启/重载 dl-release 服务，让新令牌生效、旧令牌立刻失效。
2. **再通知**所有持有人在各自机器上换成新令牌（旧的已经不能用了）。
3. **再查**：`releases.json` 最近有没有陌生版本、dl 访问/上传日志里有没有异常来源 IP。
4. 最后清理把令牌贴出去的那条消息 / 终端历史（`history -d`、CI 里的 masked secret 等）。
5. 如果怀疑有人用泄露令牌发过版本：按 §6 撤下那个版本（append-only，需要 ECS 维护者操作）。

### 4.5 永不入仓

- `.gitignore` 已忽略：`*.token`、`.dl-release-token`、`dl-release-token*`（本单新增）。
- 提交前自查：`git diff --cached | grep -inE 'token|bearer|password'`，有命中就停下来看。
- 本文件、脚本、Issue、PR 描述里**只允许出现 `<release-token>` 这种占位符**。

---

## 5. 自检脚本速查

| 命令 | 干什么 | 是否需要令牌 | 是否需要那台机器 |
| --- | --- | --- | --- |
| `pnpm run release:check -- --tag v$V` | 版本号三处一致（package.json / CHANGELOG / tag） | ❌ | ❌ |
| `pnpm run release:check -- --apk $APK --tag v$V --manifest https://dl.rose7.cn/releases.json` | 上面 + 产物存在 / ≤50 MB / sha256 / APK 内 versionName+versionCode / 变体标记 / debuggable / 不被线上 latest 压制 | ❌ | ❌（零依赖，不需要 Android SDK） |
| `pnpm run release:check -- --apk $APK --expect-sha256 <hex>` | 复核手上这份是不是构建机产出的那一份 | ❌ | ❌ |
| `pnpm run release:upload -- --apk $APK --dry-run` | 打印将要发的请求（令牌只显示来源/长度） | 可选 | ❌ |
| `pnpm run release:upload -- --apk $APK` | 真上传 + 核对回包 sha256/md5/latest | ✅ | ❌ |
| `pnpm run release:verify -- --version $V --apk $APK` | 复核 releases.json 已生效 + 下载件三方 hash 一致 | ❌ | ❌ |
| `node scripts/publish-private-apk.mjs --apk $APK --version $V --versionCode $C --dry-run` | **私有（internal）包**：默认写**私有清单**（webroot 之外，线上 `/opt/dl-private/releases.internal.json`；它就在私有根下，私有根唯一 = `/opt/dl-private`），四条硬闸先跑一遍再打印动作（不上传、不改清单）；去掉 `--dry-run` 即真发布（`ssh`/`scp` 直连主机，不出公网），见手册 §14 | ❌ | ❌（要能 `ssh` 到 DL 主机） |
| `node scripts/validate-releases-manifest.mjs <file> --strict` | 离线校验一份 releases.json 是否满足契约（已有脚本，本单复用） | ❌ | ❌ |
| `DL_WEBROOT=/var/www/dl node scripts/check-webroot-hygiene.mjs` | 真 webroot 巡检：R1–R3 文件残留 + **R4 公网清单 internal 条目数必须为 0**（#620） | ❌ | ✅（分发机） |
| `curl -X POST https://dl.rose7.cn/api/v1/release ...`（公网端点） | 正式包上传：服务端自己再判一次 `standard`+`stable`，否则 `400 VARIANT_NOT_PUBLIC` / `400 BUILD_TYPE_NOT_PUBLIC`（#620：脚本闸挡不住 HTTP 上传，所以接口也拒） | ✅ | ❌ |
| `node scripts/check-apk-debuggable.mjs $APK` | 单独查 debuggable（已有的 Issue #60 闸门） | ❌ | ❌ |
| `pnpm run verify:apk -- $APK` | **发布四件套一条命令**（#607）：debuggable / 变体标记 / 回环标记 / 证书指纹，附 versionName·versionCode·sha256·md5·size；`--variant internal` 验内测包、`--json` 给 workflow | ❌ | ✅（要 `aapt2`/`apksigner`，即 Android SDK build-tools） |

三个 `release:*` 脚本的退出码统一为：**0 通过 / 1 不通过 / 2 用法或环境错误（什么都没发生）**。

---

## 6. 失败回滚速查

| 卡在哪 | 现象 | 怎么退 | 注意 |
| --- | --- | --- | --- |
| A 提交错了 | `release:check` FAIL | 改分支重来；已合并就 `git revert` | 绝不 `git reset --hard` 已 push 的 `main` |
| B 构建失败 | gradlew 报错 / `EXPECTED_CERT_SHA256` 不符 | 重跑构建；代码问题另开 Issue | **不许**改 `EXPECTED_CERT_SHA256` 让它过 |
| B 产物不对 | 版本号/变体/debuggable 不对 | 重跑 `assembleRelease`，重新 B3 | 此时线上没有任何变化 |
| C 退出码 2 | 缺令牌、版本对不上、debuggable 包 | 改完重跑 | **一个字节都没上传**，不用回滚 |
| C `409 VERSION_CONFLICT` | versionCode 没涨 | 回阶段 A bump `androidVersionCode`，重新走 A→B→C | 不要靠重试 |
| C `429 RATE_LIMITED` | 每分钟 2 次限制 | 按 `Retry-After` 等，再单独重跑 C3 | 上传这一步可以单独重试 |
| C `401 UNAUTHORIZED` | 令牌错/被撤销 | 按 §4 换令牌 | 不要重复试同一枚 |
| C 成功但包是错的 | 内容不对 / 变体错 | dl 侧是 **append-only**：**不能删**。发一个 `versionCode` 更大的修复版本（走 A→E）覆盖 `latest`，必要时找 ECS 维护者把记录标 `breaking` | 已经下载到的用户只能靠新版本修 |
| D tag 推错 commit（CI 还没建 Release） | `release.yml` 失败 | `git push --delete origin v$V && git tag -d v$V`，改完重打 | tag 还没「出厂」，可以删 |
| D Release 已建但版本有问题 | 用户能下到坏包 | **先** `gh release delete v$V --repo zzy-repo/deepseek-app --yes`，**再**删 tag | 顺序反了会留下指向 404 的 Release |
| E `release:verify` FAIL | 记录缺失 / hash 不一致 | 不许宣布完成；按上一条撤 Release + tag；找 ECS 维护者处理线上文件 | 线上文件与记录不一致时，是服务端要修数据 |
| E 烟测装不上/白屏 | 覆盖安装失败、启动白屏 | 撤 tag + Release，`releases.json` 的 `latest` 需要回退到上一版（需 ECS 权限） | 这是唯一需要动服务端的状态 |

---

## 7. 本清单没覆盖什么 / 已知限制

- **本清单还没有被真实跑过一整遍。** 写这份清单的人手上既没有那台签名机的 keystore，也没有发布令牌，
  所以脚本只用 `--dry-run`、离线 fixture 和「缺令牌报错」这三条路径验证过；「上传成功」「CI 建 Release」
  两个环节来自 `docs/dl-release-api.md` 与 `release.yml` 的约定，未经实际执行。**第一次照着跑的人，请把踩到的坑补回本文件。**
- **签名机仍是单点。** keystore 只在 `/root/.android/debug.keystore`，那台机器没了就得换证书（= 所有已装用户无法覆盖升级）。
  这是本单接受的边界，不试图消除。
- **不覆盖**：iOS / 桌面端发布、`deploy/dl-release/` 的服务端部署与运维、`.github/workflows/**` 的改动
  （本单不动 workflow 文件）、以及「用 gh token 代替人推 tag」。
- 代理与磁盘卫生（Windows 侧 `127.0.0.1:7897`、清 `node_modules` 不删 worktree）见
  [`docs/RELEASE-MANUAL.md`](RELEASE-MANUAL.md) §10。
