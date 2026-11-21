# 发版手册（纯手动清单）

适用：从 `1.4.0-beta.8` 起。发布 = 按本清单一步步做，**没有一键脚本**。

> **正式发布 = GitHub Release**（裁决 #614 决定 2）。dl.rose7.cn 只作**历史分发**，
> 不再作为发版前置：不必先让公网 `releases.json` 收录该版本，也不再校验它的 `md5`。
> 发包 → 打 tag → 发 GitHub Release，具体命令见 **§6.1**。

---

## 0. 为什么不再提供一键脚本

`release-apk.sh`（664 行，九步一体）和 `preflight.sh`（470 行，九项门禁）已删除。原因只有两条，都是实操中真的踩到的：

1. **失败后状态半改。** 九步里的第 4～8 步会依次改 `package.json` / `CHANGELOG.md`、`git commit`、构建、上传、push + tag。
   任意一步失败，前面几步的副作用已经落地（文件改了、commit 有了、APK 已经传到 dl）。要接着做只能靠脚本记录的
   状态文件 + 备份还原，而现场的备份/状态与真实仓库经常对不上（别人的并行改动会被一起回滚）。
2. **无法只重试单步。** 想重试「只上传」或「只打 tag」，脚本必须从第 1 步的整体门禁重跑；门禁里任何一项测试
   FAIL（哪怕和本次发版无关）就完全不能发布。测试基线与发版被人为绑死。

手工清单的取舍：**每一步都是独立、可单独重跑的命令**，失败时只重跑那一步，不需要复原别人的工作区。
代价是没有自动门禁与自动校验 —— 所以下面第 4 节那五项**人工核对必须逐项做**，这是发布前唯一的硬关卡。

> **换人交接请直接用 [`docs/RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md)**：它把流程钉成
> 「阶段 A 定版本 → 阶段 B 构建（那台签名机）→ 阶段 C 上传（任意机 + 一枚令牌）→ 阶段 D 打 tag → 阶段 E 校验」，
> 每步给命令 / 成功判据 / 失败回滚，并写清哪些步骤必须人工、哪些必须在签名机上做。
> 脚本化部分见 §5 之前的三条命令（等价于本手册 §4/§5/§7 的自动化版本，不替代 §4 的人工核对）：
> `pnpm run release:check`（版本号三处一致 + 产物自检）、`pnpm run release:upload`（multipart 上传，带 `--dry-run`）、
> `pnpm run release:verify`（复核 `releases.json` 已生效 + 下载件三方 hash 一致）。

> 打 tag **不再触发任何 workflow**：`.github/workflows/release.yml` 已改为**手动 `workflow_dispatch`**，
> 它只做「把已构建、已签名的 APK 挂成 Release 资产 + 校验 debuggable + 写 sha256」，
> 不构建、不碰 keystore、**不读 `releases.json`**（详见 §6.1）。

---

## 1. 前置条件（一次性 / 每台构建机）

| 项目 | 做法 | 校验 |
| --- | --- | --- |
| 签名材料 | 发布用 **release 构建类型**（`assembleRelease`，见 §3），签名指向已发布证书：`android/keystore/keystore.properties` 里 `storeFileRelease=/root/.android/debug.keystore`、`storePasswordRelease=android`、`keyAliasRelease=androiddebugkey` | `keytool -list -v -keystore /root/.android/debug.keystore -storepass android -alias androiddebugkey \| grep SHA256`，必须是 `e7c5baee…aa8a1` |
| 发布令牌 | **按人发放，不是自己去 ECS 上取**：找 dl-release 维护者要一枚（私密渠道给），然后三选一注入 —— `export DL_RELEASE_TOKEN=<release-token>` / 写 `~/.config/dl-release/token` 后 `chmod 600` / 用 `--token-file`。完整流程（含轮换与泄露止损）见 [`docs/RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md) §4 | `ls -l ~/.config/dl-release/token` 应为 `-rw-------`；`node scripts/release-upload.mjs --apk <apk> --dry-run` 只回显令牌**来源与长度**；**不 echo、不贴日志、不进仓库** |
| Android SDK / JDK / build-tools | **声明式，正文里不再写路径**：`cp build.env.example build.env`，填 `ANDROID_HOME` / `JAVA_HOME` / `BUILD_TOOLS_VERSION` / `REQUIRED_JAVA_MAJOR`。`build.env` 已 gitignore（每台机器一份）；同名环境变量优先，未填时代码兜底 `$HOME/android-sdk` + PATH 里的 `java` | `./build-apk.sh` 启动即打印 `ANDROID_HOME` / `JAVA_HOME` / `BUILD_TOOLS_VERSION` / `node`；JDK 主版本不足会直接失败并打印「需要 21，当前 17」；`BUILD_TOOLS_VERSION` 未设置或档位不存在会失败并列出本机已安装档位 |
| gh（只用于观察） | 可选 | `gh auth status`；Release 由 workflow 的内置 `GITHUB_TOKEN` 创建 |
| 工作分支 | 从 `origin/main` 开 `release/<ver>` 分支发版，不直接改 `main` | `git status -sb`、`git log --oneline -1` |

### 新机器出 release 包：三步

凭据只在这台签名机上，**没有它就出不了包**（这是本单 #272 补的交接契约）。一台空机器按这三步走：

1. **放签名材料。** 把已发布证书（`/root/.android/debug.keystore`，SHA-256 `e7c5baee…aa8a1`）拷到本机，
   然后 `cp android/keystore/keystore.properties.example android/keystore/keystore.properties`，
   按注释填四个 `*Release` 键（键名必须带 `Release` 后缀；`storeFileRelease` 用绝对路径最稳，相对路径按 `android/app/` 解析），
   并 `chmod 600 android/keystore/keystore.properties`。
2. **过形状门禁。** `pnpm run check:keystore` —— 它会指名「缺哪个键 / 哪个路径不对 / 口令或别名是不是错了」，
   退出码非要先修完再往下（这一步比等 gradle 报「签名不行」快得多）。
3. **出包。** `cd android && ./gradlew :app:assembleRelease -PartifactVariant=internal`（**不要** `assembleDebug`，那会出 debuggable 包，见 Issue #60）；
   然后按 §4 那五项人工核对，包括 `apksigner verify --print-certs` 指回 `e7c5baee…`。

> **丢失后果：** 这把 key 只存在于签名机上、且不入库。丢了就再也签不出与已发布版本同证书的包，
> 所有已装用户**无法覆盖升级**，只能引导卸载重装。备份/交接方式见 [`docs/RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md)。

### ⚠️ 签名：先读这一段

**已发布的全历史版本（含 1.4.0-beta.8）签名证书都是同一个：**

```
e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1
= /root/.android/debug.keystore（标准 debug key，AGP 默认签名配置用的那个）
```

事实核对（2026-11-18 实测，`keytool -list -v` 读指纹）：

| keystore | 证书 SHA-256 | 是否已发布证书 |
| --- | --- | --- |
| `/root/.android/debug.keystore` | `e7c5baee…aa8a1` | ✅ 就是它（所有已发布包） |
| `android/keystore/release.keystore`（`build-apk.sh` 自动生成的） | `63669393…3255e4` | ❌ 不是 |
| `android/keystore/debug.keystore`（同上） | `6c1ed521…a80420` | ❌ 不是 |

所以：

1. **发布包 = 已发布证书 + release 构建类型（两者都要，缺一不可）**。证书必须是
   `/root/.android/debug.keystore`（历史事实，不是推荐做法）；但构建类型必须是 **release**，
   因为 `assembleDebug` 出的包带 `android:debuggable="true"`。**这一点曾经出过事**：
   `1.0.0`～`1.4.0-beta.8` 共 15 个已发布包全是 debuggable 构建（可被 `adb`/`run-as` 读取私有数据），
   `1.4.0-beta.9` 起才改正。详见 Issue #60，**不要再把 `assembleDebug` 的产物发出去**。
   - 想让 `assembleRelease` 通过下面的指纹闸门，把 `keystore.properties` 的 release 三项指向
     `/root/.android/debug.keystore`（见 §1）即可；闸门判的是**证书指纹**，不是文件路径。
   - 不要为了通过闸门去改 `EXPECTED_CERT_SHA256`，也不要把 release keystore 换成
     `android/keystore/release.keystore`（那是 `63669393…`，换它 = 已装用户无法覆盖升级）。
2. `android/app/build.gradle` 里有指纹闸门 `EXPECTED_CERT_SHA256`：`assembleRelease` 只有在
   `android/keystore/keystore.properties` 指向的证书指纹**等于**上面那一串时才允许，
   否则直接 `GradleException` 中止（缺 keystore.properties / 缺字段 / keystore 不存在同样中止）。
   `signingConfigs.debug` 也只在指纹一致时才定义，避免顺手把 debug 包（= 现网 internal 包）换签名。
3. **签名迁移必须单独规划，禁止顺手切换证书。** 换证书 = 所有已装用户无法覆盖升级（必须卸载重装）。
   真要换正式 release key，得先定方案（新 applicationId / 应用商店渠道 / 站内公告引导重装），
   并同步改 `EXPECTED_CERT_SHA256`、`docs/RELEASE-MANUAL.md`、dl 的 `releases.json` 记录 —— 不属于发版清单里的一步。
4. **绝不要为了「让 release 构建通过」去改指纹常量或用 `build-apk.sh` 生成的 keystore 发版。**

---

## 2. 步骤 1 — bump 版本号（**只改一处**）

版本号唯一来源是仓库根 `package.json`，`android/app/build.gradle` 从它读取：

```json
{
  "version": "1.4.0-beta.9",
  "androidVersionCode": 15,
  "...": "..."
}
```

- `version` → Android `versionName`（也注入 `__APP_VERSION__` 供诊断上报）
- `androidVersionCode` → Android `versionCode`

清单：

- [ ] `androidVersionCode` 比**上一个已发布 tag** 的 `androidVersionCode` 大：`git show $(git describe --tags --abbrev=0 --match 'v*'):package.json | grep androidVersionCode`
      （比的是 tag，不再是 dl 清单：公网 `releases.json` 已冻结，只留历史 standard 条目）
- [ ] `version` 与即将打的 tag 一致（tag 是 `v<version>`）
- [ ] 没改 `android/app/build.gradle` 里的版本（那里已没有硬编码版本号；缺字段会让构建直接报错）
- [ ] `CHANGELOG.md` 加了 `## <version> (<日期>) — <标题>` 段，写用户能看懂的话（会进 **GitHub Release notes**；不再进 dl 的 `changes`）

`package.json` 的 `version` / `androidVersionCode` 缺失或格式非法时，gradle 配置阶段直接 `GradleException` 中止，不会用默认值发版。

---

## 3. 步骤 2 — 构建

内测构建（`internal` 变体，与 `pnpm build:internal` 同源）：

```bash
pnpm build:internal                       # 产物 -> dist/
npx cap sync android                      # dist -> android/app/src/main/assets/public
cd android && ./gradlew assembleRelease -PartifactVariant=internal
```

对外构建（`standard`）：

```bash
pnpm build
npx cap sync android
cd android && ./gradlew assembleRelease   # 不传 -PartifactVariant，默认 standard
```

要点：

- **`pnpm build` / `pnpm build:internal` 现在走 `node scripts/build.mjs`**（Issue #273）：清输出目录用 `fs.rm`，
  `NODE_ENV=production`（内部包另有 `INTERNAL_BUILD=1`）由 node 侧传给 rspack，**与 shell 无关**——
  在 Windows 的 cmd.exe / PowerShell 里同样能跑。不要再手写 `rm -rf dist && NODE_ENV=production rspack build`，
  那行在 cmd 下会报 `'NODE_ENV' 不是内部或外部命令`。
- **一律 `assembleRelease`，不要 `assembleDebug`。** debug 变体编译进 `android:debuggable="true"`，
  发出去就是发布完整性缺陷（Issue #60：1.0.0～1.4.0-beta.8 全部中招）。
- **web 构建与 `-PartifactVariant` 必须同源**：`build:internal` ↔ `internal`，`build` ↔ `standard`。
  两者不一致时 App 侧变体标记是错的，自动更新会推错包。
- `INTERNAL_BUILD` 环境变量与 `-PartifactVariant` 冲突时 gradle 直接报错（这是有意的）。
- 产物路径：`android/app/build/outputs/apk/release/app-release.apk`。
- `assembleRelease` 前必须先有 `android/keystore/keystore.properties`，且 release 三项指向
  `/root/.android/debug.keystore`（§1）。缺文件 / 缺字段 / 指纹不符时构建会按下面的报错中止
  （`[签名] 签名证书与已发布版本不一致，已中止`）——**这不是 bug，别去改 `EXPECTED_CERT_SHA256` 绕，
  也别退回 `assembleDebug`**，按 §1 把 release 三项指向已发布证书即可。
- 构建完先确认产物存在再往下做，别急着上传。
- **`consume.baseUrl` / `pay.baseUrl` / `migration.baseUrl` 是回环地址时，这条命令会直接中止**
  （报错 `[consume] 回环地址只能用于本地联调，不可分发`，Issue #601）。见下面 §3.1。

### 3.1 回环地址闸（Issue #601）：打得出来 ≠ 传得上去

事故：`1.4.2` 的 internal 包带着 `consume.baseUrl = http://127.0.0.1:18000` 进了公网分发清单，
那个包在任何真机上都连不上后端（`127.0.0.1` 指的是手机自己），只能配 `adb reverse` 联调。

两道闸：

| 闸 | 位置 | 行为 |
| --- | --- | --- |
| 1 构建期 | `android/app/build.gradle` | **任何变体**（debug / release / internal / standard）只要 `consume` / `pay` / `migration` 的 base 是回环（`127.0.0.1` / `localhost` / `::1`）→ 配置阶段直接 FAILED，报错带键名 + 配置行号 + 解法 |
| 2 上传期 | `deploy/dl-release/server.mjs`（`POST /api/v1/release`） | APK 内 `<meta-data …LOOPBACK_CONSUME="true">` → `400 LOOPBACK_BUILD_REJECTED`，APK 与 `releases.json` 都不落盘；读不到标记（历史包）→ 放行 |

**逃生舱 `-PallowLoopbackConsume=true`**（只给本地联调）：

```bash
cd android && ./gradlew assembleDebug -PallowLoopbackConsume=true   # 只在「就是连本机 sub2api」时用
```

- 语义是「我知道这是回环地址，这个包只给我自己联调用」：构建放行，但产物会被打上
  `LOOPBACK_CONSUME=true`（`AndroidManifest` 的 meta-data + `BuildConfig.LOOPBACK_CONSUME`）。
- 带这个标记的包**永远传不上去**：`scripts/release-upload.mjs` 在发请求前就停，
  `POST /api/v1/release` 也会 `400 LOOPBACK_BUILD_REJECTED`。
- 只认 `true` / `false` —— 写成 `-PallowLoopbackConsume=yes` 会直接报错，避免「以为开了」。
- **发版不要用这个开关。** 要出可分发的包，只能把 `config/endpoints.json` 的 base 换成 https
  生产地址（生产 host 见 #482；临时覆盖见 §14）。

---

## 4. 步骤 3 — 五项人工核对（**全部通过才准上传**）

> **先跑 §4.6 那一条命令**（`pnpm verify:apk <apk>`）：四项判据一次算完、退出码即结论。
> 下面 4.1～4.5 是同一批判据的**手打版与交叉验证**，留着是因为「换个工具复核一遍」有独立价值
> （aapt2 的文本输出 vs 脚本从二进制 APK 里读出来的值），但**不要再用它当唯一入口**（Issue #607）。

```bash
APK=android/app/build/outputs/apk/release/app-release.apk
BT=${ANDROID_HOME:-$HOME/android-sdk}/build-tools/${BUILD_TOOLS_VERSION:?先 cp build.env.example build.env 填 BUILD_TOOLS_VERSION}
# 与 build.env 钉住的档位一致；不再按 build-tools/* 通配取最大版本
```

- [ ] **4.1 versionCode / versionName**

  ```bash
  $BT/aapt2 dump badging "$APK" | head -1
  # package: name='com.example.deepseekchat' versionCode='15' versionName='1.4.0-beta.9'
  ```

  必须等于 `package.json` 的 `androidVersionCode` / `version`，也等于要打的 tag。不一致 → 回 §3 重构建
  （常见原因：`npx cap sync android` 没刷新、gradle 缓存、改错了另一份 worktree）。

- [ ] **4.2 构建变体标记 `-PartifactVariant=internal`**

  ```bash
  $BT/aapt2 dump xmltree "$APK" --file AndroidManifest.xml | grep -A2 ARTIFACT_VARIANT
  # A: ... android:name="ARTIFACT_VARIANT"
  # A: ... android:value="internal"
  ```

  值必须与本次 web 构建同源（`internal` 或 `standard`）。`aapt2 dump badging` 不输出 meta-data，必须用 `xmltree`。

- [ ] **4.3 签名证书指纹**

  ```bash
  $BT/apksigner verify --print-certs "$APK" | grep 'SHA-256'
  ```

  必须是 `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`
  （= `/root/.android/debug.keystore`；换证书会让已装用户无法覆盖升级）。
  **不符 → 停止，不得发布**：先查这次是谁签的（`ls -l /root/.android/debug.keystore` 有没有被重建、
  有没有人改了 `signingConfigs`），修回同一证书再重构建；不要「反正能装上就发」。

- [ ] **4.4 sha256 / size**

  ```bash
  sha256sum "$APK"          # 记下来，上传后与 dl 服务端返回的 sha256 对比
  stat -c%s "$APK"          # 字节数，与 releases.json 的 size 对比（上限 50 MB）
  ```

- [ ] **4.5 `debuggable` 必须不存在（发布完整性的硬门禁）**

  ```bash
  node scripts/check-apk-debuggable.mjs "$APK"        # 退出码必须是 0
  $BT/aapt2 dump badging "$APK" | grep -c application-debuggable   # 交叉验证，必须是 0
  ```

  第一条是仓库自带的关卡脚本（零依赖，直接解 APK 里的 `AndroidManifest.xml` 读
  `application/android:debuggable`）：退出码 `0` 才算通过，`1` = 这个包是 debuggable 构建，
  `2` = 判不出来（同样按不通过处理，不许「猜着放行」）。第二条用 aapt2 做交叉验证。
  只要有一条命中，这个包就是可调试构建，**绝对不准上传**
  （Issue #60：`1.0.0`～`1.4.0-beta.8` 共 15 个已发包都是这么漏出去的）。
  这条同时也是"有没有误用 `assembleDebug`"的判据：`assembleRelease` 的产物恒为干净，
  `assembleDebug` 的产物恒为 debuggable。

  同一道关卡已经内置在三处，人工核对只是兜底：

  | 位置 | 行为 |
  | --- | --- |
  | `./build-apk.sh release` | 出包后自动跑关卡，判不过直接失败（debug 模式只告警，因为 debug 变体天生 debuggable） |
  | `.github/workflows/release.yml`（手动触发） | 取到 APK 字节之后、创建 Release 之前拦一道（判不出来也拒） |
  | `POST /api/v1/release`（dl 服务端） | 拒收 debuggable 包，返回 `400 APK_DEBUGGABLE` |


- [ ] **4.6 四件套一条命令：`pnpm verify:apk`（Issue #607；发版前与发版后都要跑）**

  ```bash
  pnpm verify:apk android/app/build/outputs/apk/release/app-release.apk
  # 等价写法（脚本本体，任何 lane 都能直接调）：
  node scripts/verify-release-apk.mjs "$APK"
  # 内测包：            pnpm verify:apk "$APK" --variant internal
  # 只给机器读：        pnpm verify:apk "$APK" --json
  # 核另一把证书：      pnpm verify:apk "$APK" --expect-cert <sha256>
  # 钉住 build-tools：  pnpm verify:apk "$APK" --build-tools 35.0.0
  ```

  它做的事就是 4.1～4.5 里那四项判据（外加把 Release 正文要用的 hash/体积一起打出来），
  **一项不过就 exit 1，判不出来 exit 2**（与 `check-apk-debuggable` 同一口径，都不许「先发后修」）：

  | # | 检查 | 判据 / 实现 |
  | --- | --- | --- |
  | 1 | `debuggable` 不存在或 false | 复用 `scripts/check-apk-debuggable.mjs` 的 `evaluateApkDebuggable()`（判定只有一份，不复制） |
  | 2 | `ARTIFACT_VARIANT == --variant`（默认 `standard`） | `aapt2 dump xmltree --file AndroidManifest.xml` 读 meta-data |
  | 3 | `LOOPBACK_CONSUME` 不存在或 false | 同上；**标记缺失视为通过**（与 #601 闸 2 同口径：老包没有这个标记，不误伤历史包） |
  | 4 | 签名证书 SHA-256 == `--expect-cert` | `apksigner verify --print-certs`；默认值 = §4.3 那个已发布证书 |
  | 5 | 附加输出（不算失败项） | `versionName` / `versionCode` / `sha256` / `md5` / `size`，直接抄进 Release 正文 |

  `aapt2` / `apksigner` 从 `$ANDROID_HOME/build-tools/<版本>/` 取：**钉住的 `BUILD_TOOLS_VERSION`
  优先，没钉才取已装最高档**（输出里会标 `auto-max`，提醒你核对工具可能不是出包那一个）。
  找不到 SDK / 工具 → **exit 2**，并打印 `sdkmanager` 安装提示。全程不联网、不改 APK。

  **预期输出（1.4.3 实包的真实输出，四项全绿；APK 路径行按你手上的产物位置显示）**：

  ```
  APK   : android/app/build/outputs/apk/release/app-release.apk
  工具  : build-tools 36.0.0 · auto-max（$ANDROID_HOME；未钉住 BUILD_TOOLS_VERSION，取已装最高档 36.0.0）
  期望  : variant=standard  cert=e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1

  #  检查                             结果     实际
  -  -------------------------------  --------  ------------------------
  1  debuggable 不存在或 false        PASS     attr_absent
  2  ARTIFACT_VARIANT 与期望一致      PASS     standard
  3  LOOPBACK_CONSUME 不存在或 false  PASS     false
  4  签名证书 SHA-256 与期望一致      PASS     e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1

  附加输出（Release 正文可直接用，不算失败项）
    packageName : com.example.deepseekchat
    versionName : 1.4.3
    versionCode : 22
    sha256      : 98cecce05f6549fe8023f4c0b2f6c62c7662050fa7f0cdf44395147ada9a51e2
    md5         : d6660c0168465e1196c03abe8bafaf06
    size        : 6.56 MiB（6875727 字节）

  结论：PASS（4/4 项通过）—— 可以发布。
  ```

  红的时候长这样（历史 debug 包 `deepseek-chat-1.2.0.apk`，退出码 `1`）：

  ```
  1  debuggable 不存在或 false        FAIL     android:debuggable="true"
  2  ARTIFACT_VARIANT 与期望一致      FAIL     标记缺失
  3  LOOPBACK_CONSUME 不存在或 false  PASS     标记缺失（视为 false）
  4  签名证书 SHA-256 与期望一致      PASS     e7c5baee…aa8a1
  结论：FAIL（debuggable / variant 不通过）—— 禁止发布。
  ```

  「结论」那行会**点名**是哪几项挂了（`FAIL（debuggable 不通过）`），不看表格也能 grep。

  | 红了 | 含义 | 怎么办 |
  | --- | --- | --- |
  | `FAIL（debuggable 不通过）` | 这是 `assembleDebug` 的产物（Issue #60） | 回 §3 用 `assembleRelease` 重新出包，别上传 |
  | `FAIL（variant 不通过）` | 变体标记与 web 构建不同源，或标记缺失（历史包） | `build:internal` ↔ `-PartifactVariant=internal`、`build` ↔ 默认 standard，同源重打 |
  | `FAIL（loopback 不通过）` | 带 `-PallowLoopbackConsume=true` 的回环包（#601）：真机连不上后端 | 把 `config/endpoints.json` 的 base 换成生产 https 地址后重打 |
  | `FAIL（cert 不通过）` | 换了签名证书 → 已装用户无法覆盖升级 | 按 §1 把 release 三项指回 `/root/.android/debug.keystore`；**不许**改指纹常量 |
  | `UNKNOWN`（exit 2） | 判不出来：缺 SDK 工具 / 不是 APK / 清单读不出 | 按提示装 build-tools 或拿对文件——**判不出来等于不通过** |

  **这条判据自己会红吗？** 会，有负向对照：`node --test tests/unit/verify-release-apk.test.mjs`
  现场造四种坏包（debuggable / 变体不对 / 回环标记 / 换签证书），逐个断言 `exit 1` 且点名对应检查项；
  另外两条断言「缺 aapt2 → exit 2」「不是 APK → exit 2」。

  同一套判据在 `.github/workflows/release.yml` 里是内联的另一份（#630 的写法，尚未合并）——
  接线到 workflow 的裁决不在这条命令的范围里；**只要 workflow 没接，人就必须自己跑这一条**。

五项全过才继续。任何一项不过都没有「先发后修」这种选项。

---

## 5. 步骤 4 — 上传 dl.rose7.cn（**仅 internal/私有包与历史版本**）

> **裁决 #614 决定 2：dl 不再是正式（standard）渠道。** 正式发布走 §6.1 的 GitHub Release，
> **不需要**先上传 dl —— 公网 `releases.json` 已冻结（只留历史 standard 条目），也不会再有新条目。
> 本节只用于：① internal/私有包的发布（实际命令见 §14.2 的 `publish-private-apk.mjs`）；
> ② 万一要补一个历史 standard 版本的分发记录。**standard 正式版不要走这里。**

接口细节见 [`docs/dl-release-api.md`](dl-release-api.md)（`POST /api/v1/release`，multipart，Bearer 令牌）。
服务端自己解析 APK 真身、自己算 MD5/sha256、原子更新 `releases.json`。

**推荐用脚本（等价于下面这条 curl，额外替你对回包 sha256/md5/latest，令牌只回显来源与长度）：**

```bash
pnpm run release:upload -- --apk $APK --dry-run   # 先看要发什么，不发请求
pnpm run release:upload -- --apk $APK             # 真上传
```

想自己拼请求就照下面这条 curl：

```bash
APK=android/app/build/outputs/apk/release/app-release.apk
curl -sS -X POST https://dl.rose7.cn/api/v1/release \
  -H "Authorization: Bearer $(cat ~/.config/dl-release/token)" \
  -F "apk=@$APK" \
  -F 'meta={
        "version":"1.4.0-beta.9",
        "versionCode":15,
        "buildType":"prerelease",
        "changes":["新增：xxx","修复：yyy"]
      }'
```

核对响应（这是第 5 项人工核对）：

- [ ] `ok: true`
- [ ] 响应 `sha256` == 本地 §4.4 的 sha256（不一致 → 服务端已写入，需人工核对后同版本重发）
- [ ] 响应 `artifactVariant` == 本次构建变体
- [ ] 响应 `latest` == 本次版本

失败码：`401` 令牌错/过期；`409 VERSION_CONFLICT` versionCode 没超过线上 latest；`413` APK 超 50 MB；
`429` 每 IP 每分钟 2 次（等 `Retry-After` 再试）。**上传这一步本身可以单独重试**，服务端允许同版本覆盖。

### ⚠️ `buildType` 只能写 `stable` / `prerelease`（Issue #330）

`buildType` 描述的是**发布渠道**，不是 Gradle 构建类型，也不是构建变体：

| Gradle 构建类型 | → | manifest `buildType` |
| --- | --- | --- |
| `release`（`assembleRelease`） | → | `stable`（正式发布） |
| —（预发布 / 内测渠道） | → | `prerelease` |
| `debug`（`assembleDebug`） | → | **禁止发布**（debuggable，见 Issue #60） |

构建变体走 `artifactVariant: internal|standard`，与 `buildType` 是两个维度 —— 内测包也可以是 `stable`。

写错成 `"release"` 的后果：客户端 `parseManifest()` 抛 `INVALID_RELEASE`，**整份清单被拒**，
所有版本都只显示「检查更新失败」，而服务端日志全是 200（2026-11-19 的 P0 事故）。现在四处一起拦：
发布脚本（`--build-type` 非法 → exit 2，一个字节都不发）/ 校验器（非法值 → FAIL）/
复核脚本（记录非法 → 阻断，不再只 warn）/ 客户端（`isBuildType` 判定，fail-closed）。
枚举的唯一定义在 [`shared/build-types.mjs`](../shared/build-types.mjs)，别处只 import。

发版前 / 改发布脚本的 PR 跑一次 fixture 门禁（合法 fixture 必过、非法 fixture 必拦、事故清单 11 条逐条报出）：

```bash
pnpm run check:manifest
```

---

## 6. 步骤 5 — commit / push / tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore: 发布 1.4.0-beta.9"
git push origin HEAD:refs/heads/release/1.4.0-beta.9      # 走 PR 合并到 main
# 合并后，在 main 的合并 commit 上打 tag：
git checkout main && git pull --ff-only
git tag -a v1.4.0-beta.9 -m "1.4.0-beta.9"
git push origin v1.4.0-beta.9
```

- tag 必须是 `v<version>`（本手册与可选的 workflow 都按这个约定解析版本号，格式不符会 `::error::` 退出）。
- tag 一旦推错 commit：**不要 force 改已有 tag**。删 Release 后删 tag 再重打，或换新版本号。
- **push tag 不会触发任何 workflow**（`.github/workflows/release.yml` 已改成手动触发，见 §6.1）。
  这是刻意的：以前「推 tag → workflow 去 dl 清单里找这个版本 → 找不到就红」把发版绑死在 dl 上，
  1.4.3 按 #614 裁决不进 dl，于是每次发布都必然红。现在 tag 只是 tag。
- 推完 tag 就去做 §6.1 发 GitHub Release。

### 6.1 发 GitHub Release（正式渠道）

**做法 A（推荐，最省事）：手工一条命令发。** 在**签名机**上打包完直接推上去，keystore 不出机器：

```bash
V=1.4.3                                     # 不带 v
APK=deepseek-chat-$V.apk
SHA=$(sha256sum $APK | awk '{print $1}')
CODE=$(python3 -c 'import json;print(json.load(open("package.json"))["androidVersionCode"])')
COMMIT=$(git rev-list -n1 v$V)

cat > /tmp/notes-$V.md <<EOF
## deepseek-chat $V

| 项 | 值 |
| --- | --- |
| version | \`$V\` |
| versionCode | \`$CODE\` |
| 构建 commit | \`$COMMIT\` |
| APK | \`$APK\` |
| size | $(stat -c%s $APK) bytes |
| sha256 | \`$SHA\` |

### 变更

（把 CHANGELOG.md 里 $V 那一节贴进来）

EOF

gh release create v$V $APK \
  --repo zzy-repo/deepseek-app \
  --title v$V \
  --notes-file /tmp/notes-$V.md
```

- Release 正文至少要写：`version` / `versionCode` / 构建 commit / 资产文件名 / size / **sha256**。
- 版本号含 `-beta` / `-rc` 时加 `--prerelease`。
- 已经有 Release 要换包：`gh release upload v$V deepseek-chat-$V.apk --clobber`。

**做法 B（可选）：手动触发 workflow 帮你建/补。** Actions → `Release` → Run workflow：

| 输入 | 填什么 |
| --- | --- |
| `tag` | 已存在的 tag，例 `v1.4.3`（必须与 tag 内 `package.json` 的 `version` 一致） |
| `apk_url` | 要上传的 APK 的 https 直链；**留空**则依次尝试「Release 里已上传的 `.apk` 资产」→「dl 上该版本的存量地址」 |

它做的事（每一步都会在日志里说清）：

1. 校验 tag 存在、格式是 `v<version>`；
2. 校验 **tag 指向的那个 commit** 的 `package.json`：`version` == tag 版本、`androidVersionCode` 是正整数；
3. 取 APK 字节（不查任何清单），算 `sha256` / `md5` / size；
4. `node scripts/check-apk-debuggable.mjs <apk>` —— 是 debuggable 包直接拒（fail-closed，判不出来也拒）；
5. 用 `CHANGELOG.md` 里同版本小节生成 notes，并把 sha256 写进正文；
6. `gh release create`（已存在则 `upload --clobber` + `edit`）。

失败时它给的是**可执行的下一步**，不是「清单里没有这个版本」这种假原因：
tag 不存在 → 提示先 push tag；`package.json` 版本对不上 → 指名两边版本号；
取不到 APK → 列出三条出路（填 `apk_url` / 先手工 `gh release upload` / 走做法 A）。

- 观察：`gh run list --workflow=release.yml --limit 3`（手动触发的那条）。

---

## 7. 步骤 6 — 下载回来比 hash（正式渠道 = GitHub Release）

```bash
V=1.4.3
gh release download v$V --pattern "*.apk" --dir /tmp/gh-$V --clobber
sha256sum /tmp/gh-$V/*.apk               # 必须 == §4.4 本地构建产物的 sha256
```

- [ ] GitHub Release 资产的 sha256 == 本地构建产物 sha256（**这一条是硬关卡**：用户下载的就是这个文件）
- [ ] Release 正文里的 sha256 == 同上

**历史版本（dl 上仍有存量、且还在公网清单里的）**，可以额外做一次 dl 侧比对，
但**它不是发版前置**：1.4.3 起 dl 上不再有新版本，比对不到不是失败。

```bash
curl -fsSL -o /tmp/dl-$V.apk https://dl.rose7.cn/apk/deepseek-chat-$V.apk \
  && sha256sum /tmp/dl-$V.apk             # 与本地一致才算过；404 说明这版没进 dl（1.4.3+ 的正常状态）
```

`pnpm run release:verify` 复核的是 **dl 清单**（现仅用于 internal/私有包与历史版本），
它不校验 GitHub Release 资产 —— 资产那一条始终靠上面的 `gh release download` + `sha256sum` 人工确认。

---

## 8. 步骤 7 — 装模拟器烟测（串行，一次只开一台）

```bash
adb install -r /tmp/dl-$V.apk
adb shell am start -n com.example.deepseekchat/.MainActivity
adb logcat -d | tail -50
```

- [ ] 能覆盖安装（versionCode 递增、签名一致，不出现 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`）
- [ ] 冷启动进设置页，服务地址/模型/API Key 保留，能发出一条消息
- [ ] 内测包的服务地址/模型是钉死的那套（设置页不暴露编辑入口）
- [ ] 截图留档：档位取 `scripts/compat/matrix.config.json` 的 `captureWidths`
      （契约档位是同文件的 `requiredCaptureWidths`，当前 390 / 360 两档；少一档 `pnpm check:matrix` 直接 FAIL）；
      真机没测就写「未测真机」，不许写成已通过

---

## 9. 回滚

| 对象 | 操作 |
| --- | --- |
| dl 上的 APK / `releases.json` | 发布接口只增不删，需运维 `ssh aliyun` 操作（`/var/www/dl/`）。改回 `latest` 会让已升级用户降级，先想清楚 |
| GitHub Release | `gh release delete v<ver> --repo zzy-repo/deepseek-app --yes`（或先改 draft 下架） |
| tag | 先删 Release 再删 tag：`git push origin :refs/tags/v<ver>` + `git tag -d v<ver>`；**不 force 改已有 tag** |
| 发布 commit | `git revert <commit>`；仓库有并行改动，**禁止 `git reset --hard`** |
| 发布服务端（`server.mjs` / `variant.mjs`） | 用 §12.2 第 1 步的备份盖回去再重启，回滚后照样要过 §12.3 的三方 sha256 比对（见 §12.4） |

---

## 10. 分支与 worktree 卫生（发版后必做）

本仓库用 `git worktree` 并行开发，`/root/worktrees` 下曾长期堆到 **34 个** worktree（合计约 4.7 GB，
单个 worktree 的 `node_modules` 约 **320 MB**）。这是磁盘与构建内存压力的主要来源，所以定成过程约定：

1. **发版合并后立刻清掉已合并分支的 worktree：**

   ```bash
   git worktree list                                    # 先看清没在用的
   git -C /root/deepseek-app worktree remove /root/worktrees/<已合并分支目录>
   git -C /root/deepseek-app branch -d <已合并分支>      # 只删已合并的（-d 会拒绝未合并）
   git -C /root/deepseek-app worktree prune             # 清掉手工 rm 过的残留登记
   ```

2. **保留未合并的候选分支**（还在评审 / 等验证的），不要为了腾空间删掉别人的 worktree。
3. 发版验证跑完就删对应的临时 worktree，不要留到「以后再说」。
4. 删之前确认该 worktree 没有未提交改动：`git -C <path> status --porcelain` 为空再删；
   有改动就先 commit 或 `git stash`（`worktree remove` 遇脏目录会拒绝，别加 `--force` 硬删）。
5. 不写自动清理脚本：删除是不可逆操作，谁在用哪个 worktree 只有当下的人知道，必须人看 `git worktree list` 再动手。

6. **清 `node_modules` 而不是删 worktree**（磁盘紧张时首选，比删 worktree 安全得多）：

   先分清哪些 worktree 的 `node_modules` 是**真目录**、哪些只是**软链**——软链只有 31 字节，清它毫无意义：

   ```bash
   for d in /root/worktrees/*/; do
     [ -e "$d/node_modules" ] || continue
     printf '%-40s %s\n' "$d" \
       "$( [ -L "$d/node_modules" ] && echo "symlink -> $(readlink "$d/node_modules")" \
          || du -sh "$d/node_modules" | cut -f1 )"
   done
   ```

   只清同时满足以下三条的 worktree 的 `node_modules`，其余一律不动：

   - 不在保留名单：`deepseek-integration-next`、`deepseek-release-beta8-full`、`deepseek-compat-matrix`、`deepseek-test-baseline`、`deepseek-pr16`、`deepseek-issue-standard`、`deepseek-merge-pr16`、`deepseek-legacy-bundle-v2`，以及任何 `release/*` 分支的 worktree；
   - `node_modules` 是真目录，不是软链；
   - 该 worktree 内**除 `node_modules` 外**的文件最近 90 分钟没有改动：
     ```bash
     find <wt> -path <wt>/node_modules -prune -o -type f -newermt '-90 minutes' -print -quit
     ```

   执行（只删这一个目录；源码、未跟踪证据、`.git` 全留）：

   ```bash
   before=$(du -sb <wt>/node_modules | cut -f1)
   rm -rf <wt>/node_modules
   echo "<wt> freed $before bytes, now $(du -sh <wt> | cut -f1)"
   ```

   要再跑构建 / 测试时，一行还原成共享依赖（仓库里多数 worktree 本来就是这个形态，`/root/deepseek-app/node_modules` 是唯一的真实副本，别删它）：

   ```bash
   ln -s /root/deepseek-app/node_modules <wt>/node_modules
   ```

   **事实基线（2026-11-18 实测）**：`/root/worktrees` 下 29 个 worktree 显示「有 node_modules」，其中只有 **12 个是真目录**（各约 320 MB），另外 **19 个是 31 字节软链**指向 `/root/deepseek-app/node_modules`；按 29 × 320 MB 估占用会误判磁盘。当日按上述三条清掉 10 个真目录，`/root/worktrees` 从 **4.07 GiB 降到 1.40 GiB（−2.68 GiB）**，worktree 数量不变、源码与未跟踪证据零丢失。

7. **连不上 GitHub 时先查代理**：本机直连不通（`github.com` 被解析到 `57.155.223.240`，`git fetch` 报 `RPC failed; curl 28 ... port 443`，`git push` 报 `GnuTLS recv error (-110)`）。所有 fetch / push / ls-remote 必须走代理 `127.0.0.1:7897`（http 与 socks5 均可用）：

   ```bash
   export https_proxy=http://127.0.0.1:7897
   export http_proxy=http://127.0.0.1:7897

   # 一次性写法（不常驻环境变量）
   timeout 120 env https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
     git fetch origin --prune
   timeout 120 env https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
     git push --force-with-lease=<branch>:<old-sha> origin <branch>

   # 不依赖本地 ref 缓存的复核（推完必查）
   timeout 60 env https_proxy=http://127.0.0.1:7897 git ls-remote --heads origin <branch>
   # socks5 亦可：-x socks5h://127.0.0.1:7897，或 ALL_PROXY=socks5h://127.0.0.1:7897
   ```

---

## 11. 门禁没了，最小自检还是要跑

`preflight.sh` 的九项检查里，**测试类项目仍然要做**，只是不再和发版绑死、也不再阻断上传：

```bash
pnpm type                # tsc
pnpm lint                # oxlint
pnpm check:ip            # 源码里不许有写死的上游 IP（#181）
npm run test             # 单元
npm run test:integration:baseline   # 集成：与基线比对，只判「不新增失败」
npm run test:e2e         # e2e（含真实上游用例，需要 E2E_API_KEY）
```

约定：

- `check:ip` 对四段点分十进制的**版本号**（模拟器 / WebView / Chrome）按语境豁免：该行得出现版本语义词，
  且整行没有任何主机/地址语义词（host / server / url / 服务器 / 生产 / 地址 / 迁移 …）——后一条是否决，
  所以「服务器版本 + 四段点分」这种写法照样报。确实必须写出地址字面量，就在该行（或上一行）加
  `check-ip-allow` 并注明理由，别去改词表。
- 跑集成层前先准备两份产物：`DIST_OUT=dist-standard rspack build`（标准包，外部 `APP_URL` 与标准类用例用）
  与 `INTERNAL_BUILD=1 rspack build`（内测包，`dist/`）；再 `APP_URL=http://127.0.0.1:5301 npm run test:integration:baseline`。
  明细见 [`docs/testing.md`](testing.md)。
- **集成层的判定口径是「相对基线没有新增失败」**（`tests/integration-baseline.json`），不是「全绿」；
  `known-red` 条目要保留原因，新增失败必须修或补进基线并写明理由。跑完整层建议加 `--timeout-ms 300000`。
- 发布分支合并前，上面至少跑到 **unit + integration（无新增失败）+ 非上游 e2e** 全绿。
- 真实模型上游 e2e 没跑就**在 Issue / CHANGELOG 里写明「上游 e2e 待补测」**，事后补测并记录结果。
- 任何一项失败都如实记录，不许用「先发后修」把测试失败洗成通过。

---

## 12. 改过发布服务端之后：部署后必须三方 sha256 一致（Issue #441）

只发 APK 不需要这一节。**改的是发布服务端本体**（`deploy/dl-release/server.mjs`，连带同目录的
`variant.mjs` / `apk-manifest.mjs` / `release-target.mjs`，后者是 #620 的接口层变体闸）才走这一节：
它不在 CI 产物里、没有版本号、靠人手 `scp` 上去，所以「部署成功」必须有它自己的证据，
而不是看服务是不是 active。

### 12.1 为什么定成硬要求

2026-11-20 的实况：线上 `/opt/dl-release/server.mjs` **566 行**、仓库 main **585 行**，差了 19 行，
门禁失效一个多月没人发现 —— 期间所有上传都跑在一份没人审过的代码上。当时"部署成功"的判据只有
`systemctl is-active dl-release`：服务活着，但跑的是谁审过的版本，没人能回答。

现在服务端自己回答：`GET /api/v1/version`（**免令牌**，只回非敏感信息）

```json
{ "ok": true,
  "sha256": "<server.mjs 自身内容的 sha256，启动时算一次并缓存>",
  "builtAt": "<进程启动时间，ISO 8601>",
  "nodeVersion": "v24.x",
  "variants": ["internal", "standard"],
  "buildTypes": ["stable", "prerelease"],
  "targets": ["public", "private"] }
```

两个容易看错的点：

- `sha256` 是**启动那一刻**读到的字节，不是每请求重读文件 —— 于是「文件换了但重启没成功」不会被它掩盖
  （进程还在报旧指纹，正对上表第 1 行）。
- `builtAt` 是**进程启动时刻**，不是构建时刻；重启过、回滚过，它就该变。

### 12.2 上线步骤（备份 → 同步 → 语法检查 → 重启 → 验收）

```bash
# 0) 本机先过语法与用例（不碰线上）
node --check deploy/dl-release/server.mjs
pnpm run test:dl-release

# 1) 备份（带时间戳 —— 回滚就靠这个文件）
ssh aliyun 'mkdir -p /root/dl-release-backups && cp -a /opt/dl-release/server.mjs /root/dl-release-backups/server.mjs.$(date +%Y%m%d-%H%M%S)'

# 2) 同步（server.mjs import 同目录的 variant.mjs / apk-manifest.mjs / release-target.mjs，
#    改了哪个传哪个，两个以上一起传；#620 起 release-target.mjs 是必需的第四个文件）
scp deploy/dl-release/server.mjs deploy/dl-release/release-target.mjs aliyun:/opt/dl-release/

# 3) 语法检查 + 重启（check 不过就不重启）
ssh aliyun 'node --check /opt/dl-release/server.mjs && systemctl restart dl-release && sleep 1 && systemctl is-active dl-release'

# 4) Caddy：只有**新增**了 API 路径才需要动。片段见 deploy/dl-release/caddy-dl-api.conf，
#    @api 匹配 /api/v1/release（公网写）、/api/v1/version 与 /api/v1/releases/*（#621 私有读）；
#    /api/v1/release/private（#620 私有写）**刻意不反代**（理由见 §14.1b）；
#    validate 通过再 reload，禁止 restart。
#
# 5) 私有目录（#620/#621/#637）：**私有根唯一 = /opt/dl-private**，整棵在 webroot 之外，
#    服务启动时会核一次（落在 webroot 内就拒绝启动）
#    私有根   = /opt/dl-private                        （DL_PRIVATE_ROOT）
#    私有包   = /opt/dl-private/apk                    （DL_PRIVATE_APK_DIR）
#    私有清单 = /opt/dl-private/releases.internal.json （DL_PRIVATE_RELEASES_JSON；#637 起不再有第二处）
ssh aliyun 'install -d -m 755 /opt/dl-private /opt/dl-private/apk'
```

#### ⚠️ 部署布局是写死的：`/shared/build-types.mjs` 必须存在（#441 第 3 条）

`server.mjs` 里有一句 `import ... from '../../shared/build-types.mjs'`（buildType 枚举的单一真相源，见 #330）。
从 `/opt/dl-release/server.mjs` 解析两个 `..` → **`/shared/build-types.mjs`**（Node 实算，不是
`/opt/shared/`，也不是 `deploy/dl-release/shared/`）。**这一步漏了，服务起来就 `ERR_MODULE_NOT_FOUND` 直接崩**，
而它不会在 `systemctl status` 里说人话，只会在 `journalctl` 里留下一行栈。

所以目标机器上必须有 `/shared/`，且内容与仓库逐字节一致（`variant.mjs` / `apk-manifest.mjs` 则在
`/opt/dl-release/`，同目录）：

```bash
# 首次布置（缺 /shared 时）
ssh aliyun 'install -d -m 755 /shared'
scp shared/build-types.mjs shared/build-types.d.mts aliyun:/shared/

# 两边内容必须逐字节一致（部署验收的一环）
ssh aliyun 'sha256sum /shared/build-types.mjs /opt/dl-release/server.mjs /opt/dl-release/variant.mjs /opt/dl-release/apk-manifest.mjs /opt/dl-release/release-target.mjs'
sha256sum shared/build-types.mjs deploy/dl-release/server.mjs deploy/dl-release/variant.mjs deploy/dl-release/apk-manifest.mjs deploy/dl-release/release-target.mjs
```

### 12.3 验收：三方 sha256 必须一致（缺一不可）

```bash
# ① 线上文件到底是谁
ssh aliyun 'sha256sum /opt/dl-release/server.mjs'
# ② 仓库 main 上应该是什么
git show origin/main:deploy/dl-release/server.mjs | sha256sum
# ③ 正在跑的进程自报是什么（走公网、不带令牌，顺便验反代通了）
curl -s https://dl.rose7.cn/api/v1/version | python3 -m json.tool
```

**三个 sha256 完全相同才算部署成功。** 不一致就按下表分诊，别"看着像好了"就收工：

| 现象 | 含义 | 动作 |
| --- | --- | --- |
| ① == ②，③ 不同 | 文件传对了，但**进程没重启成功**或在跑旧进程 | `systemctl restart dl-release` 后重新验收 |
| ① != ② | 传上去的本来就不是仓库那份 | 重传；先 `git status` 确认本地没夹带未合并改动 |
| ③ 是 404 / 502 | 反代没匹配到新路径，或服务没起来 | 查 `@api path` 是否含 `/api/v1/version`；`journalctl -u dl-release -n 50 --no-pager` |
| ③ 回的不是 JSON | 命中静态文件（`/var/www/dl` 下同名路径）或服务异常 | 同上；必要时回滚 |

同一次验收里再确认两件事（都很便宜，但都能挡住事故）：

```bash
# 免令牌只针对版本端点：上传仍然必须 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dl.rose7.cn/api/v1/release

# 部署服务端不该碰任何数据：releases.json 的 sha256 前后必须不变
ssh aliyun 'sha256sum /var/www/dl/releases.json'     # 部署前记一次，部署后再比一次
```

另外，`/shared/build-types.mjs` 与 `/opt/dl-release/{variant,apk-manifest}.mjs` 也要和仓库逐字节一致
（同一台机器上四个文件的 sha256 一起比，见 §12.2 末尾那条命令）—— 服务能起来只证明文件存在，
不证明它是仓库那份。

事后翻日志也能对上「那段时间跑的是哪一版」：

```bash
ssh aliyun 'journalctl -u dl-release --no-pager | grep version_fingerprint'
```

### 12.4 起不来就立刻回滚（不要在线调试）

```bash
ssh aliyun 'cp -a /root/dl-release-backups/server.mjs.<时间戳> /opt/dl-release/server.mjs \
  && node --check /opt/dl-release/server.mjs && systemctl restart dl-release && systemctl is-active dl-release'
```

回滚完再走一遍 12.3 的三方比对 —— 回滚本身也要有证据，`builtAt` 必须变。

---

## 13. 本清单不管的事（未覆盖）

- 不自动算 `versionCode`（不读线上 `releases.json` 做 `max(本地,远端)+1`）——手动对着上一个已发布 tag 看一眼再填，§2 有命令。
- 不自动写 `CHANGELOG.md`（Release notes 会从它取同版本小节，所以那一节要写人话；手工发 Release 时正文自己写）。
- 不自动修 APK 元信息不一致（aapt2 校验靠人做，§4.1）。
- 不处理 `dist/` 缓存导致的旧产物：怀疑时 `rm -rf dist && pnpm build[:internal]` 再 `npx cap sync android`。
- 不在 CI 里构建 APK、不上传 keystore（这条永远不变）。
- 不负责服务端地址迁移的下线动作：三代地址、过渡策略（C 强制升级）、旧机停之前的「请升级」兜底响应、以及「下次先配域名再搬」的前向建议，都记在 [`docs/server-migration.md`](server-migration.md)。**发版前扫一眼那份文档，确认自己踩在迁移窗口期里没有。**

---

## 13. 换分发地址：只改一处 + 重打包（Issue #269）

切分发机（换机 / 换域名 / 上 TLS）**不需要改任何 `.java` / `.ts` / `.gradle`**：分发地址的唯一来源是
`config/endpoints.json` 的 `download.*`，打包时替换一次。

| 配置项 | 打进哪个常量 | 谁在用 |
| --- | --- | --- |
| `download.primaryBase` | `__ENDPOINTS__.dlPrimaryBase`（Web）/ `BuildConfig.DL_PRIMARY`（原生） | 清单与 `/apk/` 的首选机 |
| `download.fallbackBase` | `__ENDPOINTS__.dlFallbackBase` / `BuildConfig.DL_FALLBACK` | 首选不可达时的回退机（必须 https） |

原生下载白名单由这两个 base 派生（主机 / 端口 / 协议），所以**不需要**另外配一份主机名单 ——
天然不会出现「改了 base 忘了改白名单」那种丢更新的事故。

### ① 只改一行 + 过门禁

```bash
$EDITOR config/endpoints.json     # 换首选机：只改 download.primaryBase；换回退机才动 fallbackBase

pnpm check:endpoints   # 形态 + 互不冲突：必须「协议://主机[:端口]」、回退 https、两个 base 不同；并检查客户端
                       # 可执行代码（src / android/app/src/main/java / android/app/build.gradle）里没有地址副本
pnpm check:ip          # 源码里不许有写死的上游 IP
pnpm check:identity    # 明文更新传输闸门（allowInsecureUpdateTransport=false 时 http:// 会被点名到行）
```

门禁红了就改配置，别改门禁。常见红：

- `download.primaryBase 只能是「协议://主机[:端口]」…` —— 带上了路径（`/apk`）或末尾的 `/`。
- `download.fallbackBase 必须走 https…` —— 回退机是历史版本的最后兜底，不许明文。
- `分发地址字面量 …` —— 有人又把地址写回了 `UpdateEndpoint.java` / `updateManifest.ts` / `build.gradle`。

### ② 重打包（三步，与 §3 同源）

```bash
pnpm build:internal                # 或 pnpm build（standard）；rspack 注入 __ENDPOINTS__ → dist/
npx cap sync android               # dist → android/app/src/main/assets/public
cd android && ./gradlew assembleRelease -PartifactVariant=internal   # build.gradle 读 JSON → BuildConfig.DL_*
```

例外通道（**不推荐**，产物里的地址就不在仓库里了）：`./gradlew assembleRelease -PdlPrimaryBase=https://…`。
用了它必须在 `CHANGELOG.md` 记一笔（gradle 会打警告）。

### ③ 证明包里的地址真的换了

```bash
APK=android/app/build/outputs/apk/release/app-release.apk
NEW=$(node -e 'import("./scripts/lib/endpoints.mjs").then(m=>console.log(m.downloadPrimaryBase))')
grep -lF "$NEW" dist/static/js/*.js                  # 命中 = Web 侧注入生效
unzip -p "$APK" classes.dex | strings | grep -cF "${NEW#*//}"   # ≥1 = 原生侧注入生效
# 旧地址：新包里只应该剩 fallbackBase
unzip -p "$APK" classes.dex | strings | grep -oE 'https?://[a-z0-9.:/-]+' | sort -u
```

再按 §4 的五项人工核对走完才准上传。**`grep -rn` 归零是可自证的**：
`grep -rn "$NEW" src android/app/src/main/java` 必须是 0 行（地址只活在 `config/endpoints.json` 里）。

### ④ 旧地址必须继续可达（这条最容易漏）

已发出去的包（≤ 1.4.0-beta.10）把地址写死在 dex / JS 里，**没有任何热更新通道能改它**
（清单与下载都不跟随重定向：`setInstanceFollowRedirects(false)` / `redirect: 'error'`）。所以换机之后：

- 旧首选机在新包的 `download.fallbackBase` 之外，仍要**为老包继续返回 200 的 `releases.json`**，
  且里面至少要有一条「能让最老版本升上来」的记录（`versionCode` / `sha256` / `buildType` / `artifactVariant` 齐全）。
- 允许「内容降级」，**不允许** 301/302 跳转到新地址：客户端两条链路都不跟随重定向。

### ⑤ 回滚

```bash
git checkout -- config/endpoints.json
pnpm build:internal && npx cap sync android
cd android && ./gradlew assembleRelease -PartifactVariant=internal
```

已发出去的包本身回滚不了 —— 回滚的实质是「让旧地址继续可达」，见 ④。

### 未测边界（如实记录）

- `-PdlPrimaryBase` / `-PdlFallbackBase` 覆盖通道**没有在真实 tag 上跑过**（只在本地 `assembleRelease` 验过配置读取与 `BuildConfig` 生成）。
- 换地址后的「新机可下 / 旧机仍可下」要人工 `curl` 验（见 ④），离线门禁不做网络探测。
- 上 TLS 后再把 `config/appIdentity.json` 的 `allowInsecureUpdateTransport` 置 `false`（顺序不能反，否则 `pnpm check:identity` 会红）。

---

## 14. 换 sub2api host：只改一处 + 重打包 + 灰度验证（Issue #484 / #487）

**适用**：sub2api 的入口地址变了（换机器、换域名、上 TLS）。**不适用**：换分发包地址（那是 §13）、
换 apia（支付侧，同法但改 `pay.baseUrl`）。

> 接口约束前提：客户端**只允许**调 [`docs/sub2api-client-contract.md`](sub2api-client-contract.md) §3 白名单里的路径。
> 换 host 不改变白名单 —— 如果新 host 上跑的不是同一个 sub2api（不同版本/不同 DB），那是**迁移**，不是换地址。

### ⓿ 换之前必须确认的四件事（缺一条就别开始）

| # | 要确认什么 | 谁确认 | 判据 |
| --- | --- | --- | --- |
| 1 | 新 host 是 **https** | 维护者 | `curl -sI https://<new-host>/health` → 200；构建期校验也会拦明文 http |
| 2 | 新 host 与旧 host 是**同一套 sub2api 数据**（同库） | 维护者 | 老账号能在新 host 登录、老 Key 在 `/v1/usage` 仍返回额度；否则老用户的余额与 Key 全部失联 |
| 3 | CORS 放行了客户端 origin | 部署方（**客户端侧无法解决**） | WebView origin 是 `https://localhost`；`cors.allowed_origins` 为空数组时 sub2api 会拒绝所有跨域请求 |
| 4 | 新 host 已加进 `allowedHosts` | 改配置的人 | 否则 `pnpm check:ip` 把新域名判成硬编码地址 |

### ① 只改一处 + 过门禁

```bash
$EDITOR config/endpoints.json      # 只改 consume.baseUrl 这一行，其余不动
pnpm check:endpoints               # 配置自洽（https / consume≠pay / 字段齐全）
pnpm check:ip                      # 主机白名单（新 host 必须在 allowedHosts 里）
pnpm check:consume-api             # 白名单路径门禁（随 #484 交付物 2 上线后才有）
```

**提交信息里写清新的 host 与验证日期**。这一步之后不要顺手改 `src/**` —— 地址只活在配置里。

### ② 重打包（三步，与 §3 同源）

```bash
pnpm build:internal                        # 构建期把 consume.baseUrl 注入 __ENDPOINTS__
npx cap sync android                       # 同步 web 产物进 android 工程
cd android && ./gradlew assembleRelease -PartifactVariant=internal
```

原生侧地址来自 `BuildConfig.CONSUME_BASE`（`android/app/build.gradle` 读同一份 JSON 生成
`buildConfigField`；**AGP 8 默认关闭 `buildConfig` 特性，必须显式 `buildFeatures { buildConfig true }`**，
否则这个常量根本不存在，表现为编译期 `cannot find symbol`）。

### ③ 灰度验证：`-PconsumeBase` 临时覆盖，不动配置文件

```bash
cd android && ./gradlew assembleRelease -PartifactVariant=internal \
  -PconsumeBase=https://<new-host>
```

覆盖只在这次打包生效，**不落盘、不进仓库**。装这台内测包，按下面五条链路验（顺序即依赖顺序）：

1. `GET /api/v1/settings/public` —— 启动就有结果（注册/邀请/邮箱入口按开关显隐）。
2. `POST /api/v1/auth/login` → `GET /api/v1/auth/me`；把 access token 手动过期，验 `POST /api/v1/auth/refresh` 能续上。
3. `GET /api/v1/keys` —— 列表出来（空数组也算通过，空列表不是错误）。
4. `GET /v1/usage`（用 sk- Key）—— 三种形态至少命中一种（`quota_limited` / 订阅 / 钱包余额）。
5. `POST /api/v1/redeem` + `GET /api/v1/redeem/history` —— **用测试卡密**；
   顺便验 §5 的补偿路径：把超时调到 1ms 制造失败，确认客户端去查 history/usage 而不是盲重试。

红线的判据：出现 CORS 报错（⓿ 第 3 条没做）、出现 400 `api_key_in_query_deprecated`（key 被写进 query）、
或兑换失败后立刻重发（违反「绝不可盲重试」）—— 任何一条都算灰度不通过，回 ①。

### ④ 证明包里的地址真的换了

```bash
APK=android/app/build/outputs/apk/release/app-release.apk
NEW=$(node -e 'process.stdout.write(require("./config/endpoints.json").consume.baseUrl)')
grep -lF "$NEW" dist/static/js/*.js                              # 命中 = Web 侧注入生效
unzip -p "$APK" classes.dex | strings | grep -cF "${NEW#*//}"    # ≥1 = 原生侧注入生效
grep -rn "$NEW" src android/app/src/main/java                    # 必须 0 行（地址只活在配置里）
```

### ⑤ 回滚

```bash
git checkout -- config/endpoints.json
pnpm build:internal && npx cap sync android
cd android && ./gradlew assembleRelease -PartifactVariant=internal
```

已发出去的包回滚不了 —— 回滚的实质是「让**旧 host 继续可达**」：sub2api 只要还在旧地址上服务，
老包的登录/额度/兑换就都还能用。**换 host 不要先拆旧入口**，等新版本覆盖率够了再下线。

### 未测边界（如实记录）

- `-PconsumeBase` 覆盖通道**没有在真实 tag 上跑过**（只在本地 `assembleRelease` 验配置读取与 `BuildConfig` 生成）。
- sub2api 的真实 host 至今**未定**（#484 待维护者提供）：本节在新 host 落地前只能验「地址换了」，
  不能验「链路通了」。别把前者写成后者。
- CORS 是否放行 `https://localhost` 属**部署侧动作**，客户端只能通过「灰度第 3 条」间接观察。
- 本节不涉及分发链路（§13）与签名（§1），两者互不影响。

---

## 14. 私有（internal）包发布：独立私有清单 + 四条硬闸（Issue #609 / 裁决 #614 决定 3）

> **本节在 #595 时写错过一次，这里留更正**：那时私有包被**写进公网** `releases.json`，理由是
> 「装了 internal 变体的客户端能收到自动更新」，保护手段是「文件名不可猜测」。#601 事故当场否证：
> **清单本身是公开的**（`GET /releases.json` → 200），文件名直接躺在里面 —— 一点都不可猜。
> 1.4.2 那次泄漏就是「进了公网清单 + 文件在 `/apk/`」两件凑齐。
>
> 现在的口径（裁决 #614 决定 2/3）：
> **清单是公开的 → 文件名等于公开 → 私有包必须靠独立私有清单，而不是靠「别人猜不到名字」。**

三条发布路径的分工是硬的：

| 发布 | 走哪条 | 清单 |
| --- | --- | --- |
| **正式发布（standard）** | **只走 GitHub Release**（裁决 #614 决定 2：dl 不再是正式渠道；操作见 §6.1：手工 `gh release create`，或手动触发 `release.yml`） | 公网 `releases.json` **冻结**，只保留历史 standard 条目；发版**不再要求**清单里有这一条 |
| **私有（internal）** | `node scripts/publish-private-apk.mjs`（默认 `--target private`，`ssh`/`scp` 直连分发主机，**不出公网**） | **独立私有清单**（`DL_PRIVATE_RELEASES_JSON`，线上 `/opt/dl-private/releases.internal.json`，**在私有根下**、webroot 之外） |
| 公网 `releases.json` | 冻结：只允许 `artifactVariant === 'standard'` 且 `buildType === 'stable'` | 出现 `internal` 条目 = 硬 FAIL（**接口 + 校验器 + 发布脚本 + 卫生门禁四道**，见 14.4b / 14.8） |

### 14.1 私有清单放在哪、客户端怎么取（私有根 = `/opt/dl-private`）

> **口径（#637 方案 A 收敛 —— 本仓库此后只认这一组值）**：私有根**唯一** = **`/opt/dl-private`**
> （**webroot 外**，由 `DL_PRIVATE_ROOT` 覆盖），根下三样东西：
> `apk/`（私有包，`DL_PRIVATE_APK_DIR=/opt/dl-private/apk`）、
> `private/`（历史取证归档）、
> `releases.internal.json`（私有清单，`DL_PRIVATE_RELEASES_JSON=/opt/dl-private/releases.internal.json`）。
>
> **历史**：#614 清库时只搬了包、清单留在 `/var/www/dl-private/`，于是同一个概念散在两处（#637 立项的形状）。
> #637 方案 A 已把清单原子挪进私有根、旧目录删空，
> `dl-release.service` 的 `DL_PRIVATE_*` 三个 env 现在都指向这一个根，服务启动期核它们都不在 webroot 内，
> 并额外检查「有没有**第三个**疑似私有根又冒出来」（`warn_stray_private_root`，只 warn 不拦启动）。

```
/opt/dl-private/                                    ← 私有根（唯一）：webroot 之外，file_server 够不着
├── apk/deepseek-chat-<ver>-internal-<8位随机>.apk   ← 私有包（清单里的 file 就是这里的 basename）
├── private/<16hex>/<…>.apk                         ← #601 事故包的取证归档（12 个，不进任何清单，端点不给下载）
└── releases.internal.json                          ← 私有清单（只有 internal 条目，latest = 最新内测版）
```

**铁律：私有根只有这一个。** 再出现 `/var/www/dl-private/`、`/var/www/dl/private/` 这类「第二个私有根」，
清单就会重新分叉 —— 服务启动时会给一条 `event=warn_stray_private_root` 的 warn（**不**拦启动，生产不能因此起不来），
看到就当天并回去：清单 `mv` 进 `/opt/dl-private/`、env 改指私有根、空目录 `rmdir`。

- **为什么不能放 `/var/www/dl/`**：那是 `file_server` 的 root，目录里的每个文件都有一个公网直链 ——
  连「从清单里删掉」都没用（静态目录不看清单）。#601 的处置就是「清单恢复 + 文件删掉」，两件必须一起做。
  发布脚本的 G1 会**直接拒绝**把私有根指进 webroot。
- **鉴权 / 取用方式（#621 已上线）**：`deploy/dl-release` 服务提供带令牌的两个**读**端点
  — `GET /api/v1/releases/internal`（清单，仅 internal 条目 + `apkName`/`downloadUrl`）、
  `GET /api/v1/releases/internal/download?file=<basename>.apk`（私有包流式下载）。
  令牌是**读令牌** `/etc/dl-release/token`（`chmod 600`；#641 起它就是读令牌，发布令牌另有一枚
  `/etc/dl-release/publish-token`，只认写端点），写法 `X-DL-Token: <token>` 或
  `Authorization: Bearer <token>`；无令牌/错令牌一律 401，超 60 次/分钟/IP → 429，清单缺失 → 503，
  `file` 带任何路径成分 → 400。Caddy 只把 `/api/v1/releases/*` 反代到 `127.0.0.1:8799`
  （**不**经过 `file_server`）。装了 internal 变体的客户端在**构建期**带 `DL_PRIVATE_MANIFEST`
  （内置开关，不下发到 standard 包），从私有清单取更新。
  > ⚠️ 历史文档里写的 `GET /api/v1/private/releases.json` / `/api/v1/private/apk/<file>` **从来没实现过**
  > （#621 立项的原因之一），上面的复数 `releases/internal*` 才是线上真路径；契约全文见 `docs/dl-release-api.md`。
- **怎么发到人**：见下一节 §14.1a（正式通道 = 令牌端点；人工交接只是备用）。
  **任何情况下都不要**把包放回 `/var/www/dl/`，也别用符号链接把它挂回去（门禁 R2 会红）。

### 14.1a 内测包分发 SOP（**#623 重写：令牌通道是正式通道，人工交接只是备用**）

> **这一节替换 #623 立项时的那版「内测包只能人工交接」。** 那版的两条前提现在都不成立：
>
> | #623 立项时的前提 | 现在的事实 |
> | --- | --- |
> | 私有包**没有**带令牌端点，只能 `scp` 人工交接 | **有**：`GET /api/v1/releases/internal` 与 `/internal/download`（#621 上线）。实测**无 token 401 / 有 token 200** —— 清单 8 条 internal、0 条 standard；包 5,428,086 B |
> | `/var/www/dl/private/` 里 12 个 internal 包仍公网 200，**要维护者决定撤不撤** | **已撤**：#636 把私有根统一到 `/opt/dl-private`，那 12 个包已移出 webroot（tar 备份 `/opt/dl-evidence/dl-private-webroot-moved-20261121-035522.tar.gz`），旧直链一律 **404** |
>
> 所以「要不要撤」这条不用再决策了；现在要守的是「**不许再回去**」，靠 §14.8 的卫生门禁（#623 起覆盖 `private/`）。

#### ① 正式通道（自动更新）：internal 变体读私有清单 → 失败回退公网

链路四段，都是已上线的代码事实：

| 环节 | 事实 | 出处 |
| --- | --- | --- |
| 私有清单 | `GET /api/v1/releases/internal` + `X-DL-Token`（**读令牌**）：无 token **401**，有 token **200**（只含 internal 条目，附 `apkName` / `downloadUrl`）；带**发布令牌** → **401** | #621 / #641 |
| 私有包 | `GET /api/v1/releases/internal/download?file=<裸名>.apk` + `X-DL-Token`（**读令牌**）：无 token **401**，有 token **200**（实测 5,428,086 B）；带**发布令牌** → **401** | #621 / #641 |
| 客户端 | internal 变体**先读私有清单**，401/429/超时/网络/清单写脏 → **静默回退**公网 `releases.json`（不崩、不弹错） | #622（`17c0733`） |
| 原生下载 | 下载器白名单头放行 `X-DL-Token`，私有下载 URL 进白名单 | #639（`766236e`） |

要让这条通道真的通，**构建期两处必须同源**（缺一处，包里的开关或令牌就是空的）：

1. `config/endpoints.json` 的 `update.privateManifest`：

   ```json
   { "enabled": true,
     "url": "https://dl.rose7.cn/api/v1/releases/internal",
     "tokenEnv": "DL_PRIVATE_TOKEN" }
   ```

2. 构建环境里给出 `tokenEnv` 指名的那枚令牌（只进环境，**不进 JSON、不进仓库、不进 URL**）：

   ```bash
   DL_PRIVATE_TOKEN="$(ssh aliyun cat /etc/dl-release/token)" \
     INTERNAL_BUILD=1 DIST_OUT=dist-internal node scripts/build.mjs --internal
   ```

   > **读令牌，不是发布令牌**（#641）。`DL_PRIVATE_TOKEN` 取 `/etc/dl-release/token`（读令牌）；
   > 取错成 `/etc/dl-release/publish-token` 不会立刻报错，但那等于把**发布权限**塞进内测包 ——
   > 见下面 ④ 的权限矩阵。发布/手工 `curl` 用另一枚，别混。

- `enabled: true` 但构建环境没有令牌 → **构建直接中止**，不会出一个「装了却永远静默走公网」的包。
- 开关只对 internal 变体生效：standard 产物里 `url` 与令牌都是空串（命中数 0），不会把内测端点广播给公网用户。
- 这一步之后按 §14.2 把包发进私有清单（`publish-private-apk.mjs`），**内测用户无需任何操作**就会收到更新。
- 契约全文（字段、限流、回退判据）见 `docs/dl-release-api.md` §5d。

#### ② 手工通道（备用）：只在读端点不可用时用

读端点 503 / 网络不通 / 对方在内网且装不了自动更新时，退回人工交接 —— **原三件套一条都不少**：

1. **包**：`scp` 到对方机器，**走 Tailscale / 内网，不走公网、不给公网直链**：
   `scp /opt/dl-private/apk/<裸名>.apk <user>@<tailscale-ip>:~/`
2. **校验**：把 `sha256sum` 一起给，接收方**自己**再跑一遍 `sha256sum <文件>`，两个值逐字符相同才算收到。
3. **安装说明**：见下面 ⑤（变体不同不能覆盖安装；若包 baseUrl 是回环需 `adb reverse`）。

#### ③ 路径唯一：私有根 = `/opt/dl-private`

| 路径 | 放什么 | 谁能取 |
| --- | --- | --- |
| `/opt/dl-private/apk/` | 私有包（`DL_PRIVATE_APK_DIR`），清单里的 `file` 就是这里的 basename | 只有带令牌的 `/api/v1/releases/internal/download` |
| `/opt/dl-private/private/<16hex>/` | 历史归档（#601 事故包等），**不进任何清单、端点不给下载**、只作取证 | 只能在主机上 `ssh` 看 |
| `/opt/dl-private/releases.internal.json` | 私有清单（`DL_PRIVATE_RELEASES_JSON`）—— **在私有根下**（#637 收敛前它在 `/var/www/dl-private/`） | 只有带令牌的 `/api/v1/releases/internal` |

**铁律：任何 internal 包都不得出现在 `/var/www/dl/` 下 —— 包括 `apk/`、`private/`，也包括用符号链接挂进去。**
那个目录是 Caddy `file_server` 的 root，里面的每个文件都有一个**不需要任何凭据**的公网直链；
连「从清单里删掉」都没用（静态目录不看清单）。判据只有一句：**这个 URL 不带凭据能不能下载？能 = 不行。**

#### ④ 令牌：读令牌与发布令牌是**两枚**（#641 已拆）

| 令牌 | 文件 | 谁持有 | 能做什么 |
| --- | --- | --- | --- |
| **读令牌** | `/etc/dl-release/token`（`chmod 600`，root:root） | **internal 客户端产物**（构建期 `DL_PRIVATE_TOKEN`）、内测设备 | 读清单、下 internal 包。带它打 `POST /api/v1/release` / `/api/v1/release/private` → **401** |
| **发布令牌** | `/etc/dl-release/publish-token`（`chmod 600`，root:root） | 发布主机、发布脚本、手工 `curl` | 两个写端点。带它读清单/下载 → **401**（两枚互不包含） |

- 写法：读端点 `X-DL-Token: <token>` 或 `Authorization: Bearer <token>` 都认；
  **写端点只认 `Authorization: Bearer`**（#619 起的既有契约）。
- **为什么拆**：内测包一定会把令牌带到设备上（#622 的设计）。拆之前那枚令牌连发布能力一起带出去，
  于是一个内测包泄漏 = 有人能 `POST /api/v1/release` 覆盖**正式分发包**。拆之后泄漏的能力上限只有「读」。
- **顺序（关键）**：`/etc/dl-release/token` **原地留作读令牌**（已发出的内测包里就是它，不立刻轮换），
  新建 `/etc/dl-release/publish-token` 当写令牌。这样写能力当场被切断，读不受影响。
- **fail-closed**：`publish-token` 缺失/为空/与读令牌同值 → 写端点**一律 401**（日志
  `event=publish_token_missing`），绝不回落成「写也认读令牌」。读令牌缺失 → 服务不启动。
- **轮换代价**（完整命令见 `docs/dl-release-api.md` §5d/§7）：

| 轮换哪一枚 | 代价 |
| --- | --- |
| **读令牌** `/etc/dl-release/token` | **重出 internal 包**：老包立刻读不到私有清单，静默回退公网（standard 包不受影响） |
| **发布令牌** `/etc/dl-release/publish-token` | **对客户端零影响**：没有任何客户端产物带这枚令牌 |

- **发布走哪条路**：日常私有包发布用 `scripts/publish-private-apk.mjs`，它走 **ssh/scp**
  （远端 root 直接落盘 + 原子改清单），**本身不需要任何 HTTP 令牌**；只有手工 `curl` 或改走 HTTP 时才用
  `Authorization: Bearer $(ssh aliyun cat /etc/dl-release/publish-token)`。

#### ⑤ 安装注意（两条，缺一条就会「装不上」或「连不上」）

- **变体不同不能覆盖安装**：已装 standard 的机器直接装 internal 包会被安装器拒（客户端呈现 `VARIANT_MISMATCH`）。
  **必须先卸载**再装（卸载会清本地聊天记录与 Key —— 事先提醒对方导出/备份）：

  ```bash
  adb uninstall com.example.deepseekchat
  adb install <裸名>.apk
  ```

- **包 baseUrl 是回环时要 `adb reverse`**：`127.0.0.1:18000` 指向手机自己，必须先打通隧道，
  且**每条 USB 连接断开后都要重做**：`adb reverse tcp:18000 tcp:18000`。
  （⚠️ 这类回环包按 §14.4 的 G2 **不许走分发**，只用于本地联调 —— 真要发人，得先改成非回环地址重打包。）

#### ⑥ 留档：发出去就要能对上账

在对应 issue / 交付群里按这张表记一行，**六个字段一个不少**：

| 版本 | versionCode | sha256 | 接收人 | 时间 | 变体 |
| --- | --- | --- | --- | --- | --- |
| `1.4.3` | `22` | `a5f3…`（全 64 位） | `@xyz` | `2026-11-21 05:10 +08` | `internal` |

没这张表，事后没人能回答「这台机器上装的到底是哪一次构建」——#601 复盘时就卡在这里。

### 14.1b 私有包发布要不要反代？（#621 收尾裁决：**不需要**）

**私有包发布走哪条路（代码事实，不是猜的）**

| 环节 | 实际实现 | 出不出公网 |
| --- | --- | --- |
| 真发布 | `scripts/publish-private-apk.mjs`，默认 `--transport ssh`：`scp` 把包传到主机私有根 → `ssh` 原子 `mv` 到 `/opt/dl-private/apk/`、备份并原子替换私有清单（回滚命令脚本会原样打印） | **不出**（Tailscale 内 `ssh aliyun`，公网 22 打不通） |
| 接口层闸（#620） | `POST /api/v1/release/private`，与 `/api/v1/release` 同一套变体口径（`release-target.mjs`） | **不反代**：Caddy `@api` 只有 `/api/v1/release`、`/api/v1/version`、`/api/v1/releases/*`；线上实测公网 `POST https://dl.rose7.cn/api/v1/release/private` → **404**（落到 `file_server`）。只有本机 `127.0.0.1:8799` 或 `ssh -L` 隧道内可达 |
| 读端点（#621） | `GET /api/v1/releases/internal*` | 出公网，但**只读**、带令牌、限流 60/min/IP |

**结论：`POST /api/v1/release/private` 不需要反代。** 三条理由：

1. **发布工具链根本不走 HTTP**：脚本是 `ssh`/`scp` 直连宿主，接口层那条闸只是「同一份判据的第二个入口」，
   不是发布主路径。反代它不会让发布更顺，只会多开一个写入口。
2. **写入口越少越好**：#601 的形状就是「换个入口发就绕过去」。公网能打的写端点只保留 `/api/v1/release`
   （公网清单，只收 standard+stable），私有清单的写入口留在本机。
3. **放开就得重新验一遍**：401 / 限流桶 / 50MB 上传 / 清单原子写，收益为零、风险为正。

**若将来确实要从公网（或公网 CI）发私有包**，改一处 + 三步验收：

```bash
# 1) 把 /api/v1/release/private 加进 deploy/dl-release/caddy-dl-api.conf 的 @api（并同步线上 Caddyfile，先备份）
# 2) validate → reload（禁止 restart，会掉 cert 管理进程）
cd /opt/caddy && set -a; . /opt/caddy/caddy.env; set +a
./caddy-alidns validate --config /opt/caddy/Caddyfile --adapter caddyfile
./caddy-alidns reload   --config /opt/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
# 3) 复验（缺一条都不算过）
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://dl.rose7.cn/api/v1/release/private -d '{}'   # 期望 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://dl.rose7.cn/api/v1/release -d '{}'           # 仍 401
curl -sS https://dl.rose7.cn/releases.json | sha256sum    # 与改动前逐字节相同
curl -sS -o /dev/null -w '%{http_code}\n' https://dl.rose7.cn/                                        # 200
```

回滚 = 把 `@api` 那行还原成 `path /api/v1/release /api/v1/version /api/v1/releases/*` → validate → reload。

### 14.2 一条命令

```bash
# 1) 出包（与 §3 同源，变体必须是 internal）
pnpm build:internal && npx cap sync android
cd android && ./gradlew --no-daemon --max-workers=1 assembleRelease -PartifactVariant=internal
APK=android/app/build/outputs/apk/release/app-release.apk

# 2) 先看要做什么（不落地：不上传、不改清单，但四条硬闸会真跑）
#    #637 起私有清单就在私有根下，--private-manifest 与缺省同值 —— 不必再带（留着写全也无害）。
#    （等价 env：DL_PRIVATE_ROOT / DL_PRIVATE_RELEASES_JSON）
PRIV="--private-root /opt/dl-private"
node scripts/publish-private-apk.mjs --apk $APK --version 1.4.3 --versionCode 22 $PRIV --dry-run

# 3) 真发布（**没有** --dry-run 就是真发布；默认 --target private）
node scripts/publish-private-apk.mjs --apk $APK --version 1.4.3 --versionCode 22 $PRIV
```

跑完会打印文件名、sha256、size、远端字节核对结果，并把条目写进**私有清单**。
**发到人这一步见 §14.1a**：默认走正式通道（装了 internal 变体的客户端自己从私有清单自动更新，
不需要你发文件）；只有读端点不可用时才退回 `scp` + `sha256` 复核的人工交接。公网清单里没有这一条。

### 14.3 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--apk <path>` | **必填** | APK 路径（环境变量 `DL_PRIVATE_APK`） |
| `--version <x.y.z>` | **必填** | versionName，必须与 APK 内一致（`DL_PRIVATE_VERSION`） |
| `--versionCode <n>` | **必填** | 正整数，必须与 APK 内一致（`DL_PRIVATE_VERSION_CODE`） |
| `--variant <v>` | `internal` | `internal` \| `standard`；与 `--target` 的匹配由 G1 强制 |
| `--target <t>` | `private` | `private`（私有清单）\| `public`（公网清单，只收 standard+stable） |
| `--private-root <dir>` | `/opt/dl-private` | 私有根（`DL_PRIVATE_ROOT`），**必须在 webroot 之外**（G1 会核） |
| `--private-manifest <path>` | `<private-root>/releases.internal.json` | 私有清单路径（`DL_PRIVATE_RELEASES_JSON`）；**线上就是缺省值 `/opt/dl-private/releases.internal.json`**（#637 起清单在私有根下），一般不用带 |
| `--webroot <dir>` | `/var/www/dl` | 公网站点根（`--site-root` 是旧名） |
| `--transport <t>` | `ssh` | `ssh`（真发布）\| `local`（只读本机目录，**只允许 `--dry-run`**，演练用） |
| `--changes <text>` | 一行默认说明 | 清单 `changes` 条目，可重复给多条 |
| `--dry-run` | 关 | 只打印动作与清单条目，**一个字节都不发**（四条硬闸照样跑） |
| `--exercise` | 关 | 演练：真上传 + 真加清单条目 + **立刻全量回滚**（只允许 `0.0.0` 开头的假版本号） |
| `--skip-apk-validation` | 关 | **只能**配 `--exercise` 或 `--transport local --dry-run`：假文件过不了 aapt2 |
| `--ssh-host` / `--public-base` / `--aapt2` | `aliyun` / `https://dl.rose7.cn/` / 自动找 | 换分发主机 / aapt2 路径时才动 |

退出码：**0 成功 / 1 校验或执行失败（含四条硬闸）/ 2 参数或环境问题（一个字节都没发）**。

### 14.4 四条硬闸（写之前就拒，判据都来自产物/磁盘实况，不来自命令行声明）

| 闸 | 判据 | 为什么必须机械化 |
| --- | --- | --- |
| **G1** 目标 × 变体 | 公网清单 + `artifactVariant !== 'standard'`（或 `buildType !== 'stable'`）；私有清单 + 非 `internal`；私有根落进 webroot | 这是 #601 的直接成因：internal 包一旦进公网清单，`file` 字段就是公开直链 |
| **G2** 回环 `baseUrl` | **从 APK 字节里**读 `consume:{baseUrl:"…"}`（`deploy/dl-release/apk-consume.mjs`），命中 `127.0.0.1` / `127/8` / `localhost` / `::1` → 拒；**读不出来也拒** | 1.4.2 那个包在**任何真机上**都连不上后端（`127.0.0.1` 指向手机自己），只能配 `adb reverse` 联调。当时的构建期校验只拦「release 变体用回环」，`-PartifactVariant=internal` 正好绕过 |
| **G3** 清单自洽 | 合入后清单登记的每个 `file` 必须在目标 `apk/` 下真的有这个文件（本次待上传那条豁免，上传后由验证补上） | 「清单指向不存在的文件」是 #601 的另一半症状：客户端拿到清单 → 下载 404 → 用户以为是网络问题 |
| **G4** 孤儿文件 | 目标 `apk/` 下有 `deepseek-chat-*.apk` 却没登记在清单里 → 拒（**不是警告**） | 只要文件还在目录里，猜到 URL 就能下载；「有文件、没条目」= 已经泄漏了一半 |

四条都可以用本地临时目录演练，不需要任何机器（`--transport local --dry-run`），
对照用例见 `tests/unit/release-safety-gates.test.mjs`，CI 里也各有一条现场注入的对照。

### 14.4b 接口层同口径（Issue #620）：脚本闸挡不住一次 HTTP 上传

四条硬闸守的是**脚本路径**。只要有人（或某个模型）改用 `POST /api/v1/release` 发，闸就被绕过去了 ——
「能不能发」取决于调用方自觉，而不是接口拒绝。**#601 事故就是这个形状**，所以接口层必须有同一套判据：

| 端点 | 写哪份清单 | 只收 | 不合口径时 |
| --- | --- | --- | --- |
| `POST /api/v1/release` | `/var/www/dl/releases.json`（webroot 内，公开） | `artifactVariant="standard"` **且** `buildType="stable"` | `400 VARIANT_NOT_PUBLIC` / `400 BUILD_TYPE_NOT_PUBLIC` |
| `POST /api/v1/release/private`（**不反代**，仅本机 8799/隧道，见 14.1b） | `/opt/dl-private/releases.internal.json`（私有根下，webroot 之外） | `artifactVariant="internal"` | `400 VARIANT_NOT_PRIVATE` |

- **变体判不出来（unknown）也拒**：`unknown !== 'standard'`，不默认 standard（fail-closed）。
- 拒绝发生在**任何落盘之前**：临时 APK 删掉，目标清单一个字节不改（用例用 sha256 逐字节比对）。
- 合并后的整份清单也要查：公网清单里历史上漏进过 internal 条目 → `409 MANIFEST_INTERNAL_ENTRY`，
  整单拒收（和 #330 的 `MANIFEST_DIRTY` 同一手法）。
- 判据只有一份：`deploy/dl-release/release-target.mjs`（纯函数），与发布脚本的 G1、
  `scripts/validate-releases-manifest.mjs` 的 public/private 双口径**同值**，
  由 `tests/unit/release-api-variant-gate.test.mjs` 钉住。
- 私有根落在 webroot 内 → 服务**拒绝启动**（`fatal_private_root_in_webroot`），不做「跑起来再说」。
- 私有根**只许有一个**（#637）：启动时若发现 `<webroot>-private`（线上 `/var/www/dl-private`）或
  `<webroot>/private`（线上 `/var/www/dl/private`）又存在、且不是配置里的私有根，则记一条
  `warn_stray_private_root`（**只 warn 不 exit** —— 报警不该变成新的「生产起不来」）。

对照用例（真 HTTP handler，不是打桩）：`deploy/dl-release/test/server-variant-gate-620.test.mjs`。

### 14.5 清单是公开的 → 文件名等于公开（**原来那句「不可猜测就安全」是错的，已删除**）

历史写法是：私有包用 `deepseek-chat-<version>-<variant>-<8位随机>.apk`，随机段 40 bit，
「别人顺着版本号猜不到」。**这条推理在公网清单存在的前提下完全不成立** ——
清单里就写着 `file` 字段，拿到清单的人直接读文件名。
#601 之后随机段仍然保留，但只为了两件小事：同一版本重发不撞名、历史文件名继续可用。
**它不是访问控制，别把它当安全边界。**

真正的边界只有一条：**私有包不进任何公网可读的文件树**。
判断标准很朴素 —— 问一句「这个 URL 不带任何凭据能不能下载？」能 = 不行。

### 14.6 变体不同不能覆盖安装（`VARIANT_MISMATCH`）

同一个包名、同一个签名，但 `artifactVariant` 不同的两个包**装不到一起**：

- 已装 standard 的机器上直接装 internal 包 → 安装器报签名/变体冲突（客户端侧会以 `VARIANT_MISMATCH` 呈现）；
- 反过来同理。**必须先卸载**（卸载会清掉本地聊天记录与 Key，事先提醒用户导出/备份）。

内测同学的正确姿势：

```bash
adb uninstall com.example.deepseekchat            # 先卸掉公共渠道那个
adb install deepseek-chat-1.4.3-internal-XXXXXXXX.apk
```

⚠️ **回环包不许走分发**（G2 会拒）。要真机连本地后端，请自己 `adb install` 本地构建的产物，
并把 `adb reverse tcp:18000 tcp:18000` 打通（每条 USB 连接断开后都要重做）——
这类包只用于联调，**不进任何清单、不发任何人**。

客户端的更新选择是「同变体 + versionCode 更大 + 有 sha256」才算候选（`src/services/updateManifest.ts`），
所以 internal 包不会把 standard 用户带走；公网清单里本来也读不到 internal 条目。

### 14.7 回滚

私有清单先备份（`releases.internal.json.bak-private-<epoch>`），所以回滚就是「把备份换回去 + 删包」：

```bash
# 1) 恢复清单（原子 mv）—— 清单与包现在同在私有根下（#637 收敛）
ssh aliyun 'mv -f /opt/dl-private/releases.internal.json.bak-private-<epoch> /opt/dl-private/releases.internal.json'
# 2) 删掉上传的包
ssh aliyun 'rm -f /opt/dl-private/apk/deepseek-chat-<version>-internal-<8位随机>.apk'
# 3) 复核：文件没了、清单与发布前逐字节一致
ssh aliyun 'sha256sum /opt/dl-private/releases.internal.json'
ssh aliyun 'test -e /opt/dl-private/apk/deepseek-chat-<version>-internal-<8位随机>.apk && echo FILE_LEFT || echo FILE_GONE'
```

真发布时脚本会把这两条回滚命令**原样打印在最后**（连 epoch 一起），照抄即可。

### 14.8 演练 + 部署后卫生检查

**① `--exercise`**：拿假文件把「上传 → 改清单 → 验证 → 全量回滚」真跑一遍，线上不留残留：

```bash
head -c 2000000 /dev/urandom > /tmp/fake.apk

# 真演练：上传 → 加清单条目 → 验证 → 回滚 → 再验证
node scripts/publish-private-apk.mjs --apk /tmp/fake.apk --version 0.0.0 --versionCode 9999 \
  --skip-apk-validation --exercise
```

演练必核的五项：

| # | 判据 | 期望 |
| --- | --- | --- |
| 1 | 远端文件 sha256 | = 本地 sha256（私有包**没有**公网直链，所以不看 `curl`） |
| 2 | 公网侧探针 `curl -I https://dl.rose7.cn/apk/<file>` | **非 200**（私有包不许被公网够到） |
| 3 | 清单里的条目 | sha256 / size / file 与产物一致 |
| 4 | 回滚后文件 | `FILE_GONE`（真删了） |
| 5 | 回滚后清单 | `sha256` 与演练前**完全一致**、无 `bak-private` / `tmp-` 残留 |

**② 部署后卫生检查（`check:webroot-hygiene`）**：R1–R3 扫**文件系统**，R4 扫**公网清单内容**
（#620 的常驻断言：公网清单里的 internal 条目数必须为 0）。

```bash
# 在分发机上（真 webroot）
DL_WEBROOT=/var/www/dl node scripts/check-webroot-hygiene.mjs     # 或 pnpm run check:webroot-hygiene

# 本机演练（不碰任何机器）：15 类脏东西逐个「注入 → 必红 → 还原」
node scripts/check-webroot-hygiene.mjs --selftest
```

命中任一即 `exit 1`：

| 规则 | 命中物 |
| --- | --- |
| R1 | `*.bak*` / `*LEAKED*` / `_withdrawn*` / `releases.json.*`（白名单外）/ `*.tmp-*`（`private/` 子树里也扫） |
| R2 | webroot 内出现非 `apk/` 的目录（`private/` 尤其不许）；**以及任何符号链接** —— symlink 的 `isDirectory()` 是 false，`private -> /opt/dl-private` 能整棵躲过「只看目录名」的检查，而 `file_server` 会顺着它直出（#623 补的口子） |
| R3（#623 扩口径） | 文件名含 `internal` 或 `dev` 的文件出现在 **`apk/` 或 `private/` 子树（向下 3 层）** —— `private/<16hex>/<…>-internal-….apk` 这种 #621 现场的形态要**被点名**，不是只报一句「多了个目录」 |
| R4（#620） | `releases.json` 里 `artifactVariant !== "standard"` 的条目（含 `internal`）；清单读不出来/缺失也判红（fail-closed） |

**#623 的门禁口径（最终定法）**：`private/` **不是「另外要不要扫」的选项，而是必须扫** ——
目录本身由 R2 判红、里面的包由 R3 逐条点名、里面的清单备份由 R1 判红、用符号链接挂回来由 R2 判红。
负向对照（本地临时目录，不碰生产机）见 PR / #623 的收口评论：往模拟的 `/var/www/dl/private/<16hex>/`
放一个 internal APK → 新门禁 `exit 1` 且点到那个文件；同一条符号链接在旧门禁上是 **`exit 0`（干净）**。

处置：R1 的备份/取证文件移到 webroot 之外（例如 `/var/lib/dl-quarantine/`）；R2 的目录整棵搬走、
符号链接删掉（私有包/私有清单的合法位置在 webroot 之外、且**只有一个私有根**：`/opt/dl-private/`）；
R3 的内部包移出 webroot；R4 的 internal 条目从公网清单里
删掉 —— **先确认它已经在私有清单里再删**，顺序反了就等于丢包。

---

## 15. 分发机保留策略（Issue #662）

分发机（`aliyun` / 主机名 `zzy`）上有一批**不在任何清单里**的文件：私有包、发布备份、事故取证物。
它们常年没人清，原因是「没有到期日」——没有到期日的东西永远不会过期，于是 #285 盘点出来的那几条
（私有根里 12 个清单查不到的包 64 MB、#601 的 9 份取证物、`/root/dl-release-backups` 的十几份备份）
一直在原地，谁也说不清「哪份能删、哪份是唯一副本」。

本节把这件事变成**可执行**的：每个目录写清 TTL 与负责人，能写账本的写账本，然后交给一条命令去对账
（`pnpm check:retention`）。**过期 ≠ 立刻 `rm`** —— 过期只是「该有人做判断了」。

### 15.1 四类目录：TTL / 账本 / 负责人

| 目录 | 里面是什么 | 允不允许动 | 到期规则 | 账本 | 负责人 |
| --- | --- | --- | --- | --- | --- |
| `/opt/dl-private/apk/` | **活资源**：私有清单逐条引用的包（#662 时 8 个 / 45 MB，逐条命中清单） | **不动** | **无 TTL** —— 它由「发布 / 下架」流程管，不由保留策略管。删它的唯一合法路径是 §14 的下架流程（先从清单删条目、再删包） | 无（清单本身就是账） | 发布 owner |
| `/opt/dl-private/private/` | **孤儿私有包**：清单引用 0 的包（#662 时 12 个 / 64 MB，9 个 `<16hex>/` 目录 + 3 个 `*-internal*.apk`） | 只按账删 | **`addedAt` + 30 天**（#662 那一批 = 2026-11-21 → **2026-12-21**）；到期后由运维核对 MANIFEST 再删，可能仍需留作 #601 取证对比 | `/opt/dl-private/private/.retention.json`（12 条） | 运维 / 发布 owner |
| `/opt/dl-leak-evidence/` | **#601 事故取证物**：公网清单被篡改前后的快照（9 份，含 `releases.json.LEAKED-*`、`bak-withdraw-*`） | 只按账删，**删前必须人确认** | **条件到期**：事故复盘正式关闭**并人工确认**后 30 天。账本里 `deleteAfter: null` + `deleteAfterRule` + `reviewAfter`（复核日，到点未确认就判红逼人做决定） | `/opt/dl-leak-evidence/.retention.json`（9 条） | 事故复盘 owner（当前由发布 owner 兼任） |
| `/root/dl-release-backups/` | **发布备份**：`server.mjs.*` / `dl-release.service.*` / `Caddyfile.*` / `variant.mjs.*` / `apk-manifest.mjs.*` / `641-*` 备份组 | 按「留最近一份」裁剪 | **每次发布覆盖时裁剪**（§12 步骤 1 备份之前）：只留**最近一份 + 当前线上前一份**；`Caddyfile.*` 例外——机器上**没有** git 留存（仓库只有 `deploy/dl-release/caddy-dl-api.conf` 片段），**不许删** | 无账本（见下方说明） | 发布 owner |

**为什么 `/root/dl-release-backups/` 没有 `.retention.json`**：它的到期由**发布流程自己**触发（每次覆盖前先裁），
不依赖日历。真要纳管，给 `check-retention.mjs` 加一对 `--dir /root/dl-release-backups` 即可（支持多对），
但那份账本得由发布脚本维护，手工维护会漂。

**删除的硬前提（三条同时满足，缺一条就留着）**：

1. 线上已有更新版本，或另有一份**逐字节相同**的文件；
2. 字节**能在 git 历史中完整取回**（`git log --all --find-object=$(git hash-object <file>)` 有命中）；
3. 不是机器级唯一留存（典型反例：整份 Caddyfile、`dl-release.service` 某个只存在于机器上的版本）。

### 15.2 检查命令（不靠记性）

```bash
# 在分发机上跑（本机 / CI 上没有这两个目录 —— 那是 SKIP，不是失败）
ssh aliyun 'cd <repo> && pnpm check:retention'

# 逐条看（默认只打印异常 + 汇总）
node scripts/check-retention.mjs --verbose

# 演练 / 复盘：假定「今天」是某一天，看看会不会报
node scripts/check-retention.mjs --now 2026-12-22

# 对一份账本副本做演练（不改线上账本），把某条改成昨天 → 必须 exit 1
node scripts/check-retention.mjs --dir /opt/dl-private/private --ledger /tmp/neg.json
```

| 退出码 | 含义 | 该做什么 |
| --- | --- | --- |
| 0 | 全部未到期且 sha256/大小与账本一致；或目录不在本机（SKIP） | 什么都不用做 |
| 1 | 有 `EXPIRED`（过期）/ `REVIEW-DUE`（复核日过了没确认）/ `DRIFT`（文件与账本对不上）/ `BAD-LEDGER`（账本缺 `reviewAfter`，等于无限期） | 按 §15.3 处置 |
| 2 | 用法不对或账本不是合法 JSON | 修命令 / 修账本 |

**为什么不接 CI**：账本与文件都在分发机上，CI runner 上不存在这两个目录，接进 CI 只会每天
SKIP 或每天红一次（"红着红着就没人看"正是本合同类门禁的反面）。它由**运维定期在分发机上跑**：
每次发布后必跑一次，另外**每月 1 日**在值班 checklist 里跑一次（`--verbose` 留输出）。

### 15.3 到期了怎么删（顺序不能反）

1. 打开 #662 的 **MANIFEST**（37 条：路径 / 大小 / sha256 / mtime / 清单引用 / 是否已被取代），
   核对这一条的 `sha256` 与 `size` —— 对不上就**别删**，先查谁改的；
2. 按上一节的「三条硬前提」确认不是唯一副本；
3. 删（`rm` 或 `mv` 进隔离目录都行，但**删之前先把 sha256/大小记进 MANIFEST**）；
4. 把该条从 `.retention.json` **划掉** —— 不划掉的话下次会报 `MISSING`（不判红，但会一直是噪音）；
5. 复验（缺一条都不算过）：

   ```bash
   ssh aliyun 'TOK=$(cat /etc/dl-release/token); curl -s -o /dev/null -w "%{http_code}\n" \
     -H "X-DL-Token: $TOK" http://127.0.0.1:8799/api/v1/releases/internal'   # 200
   # 计数必须仍是 8；/api/v1/version 的 sha256 必须等于仓库 deploy/dl-release/server.mjs 的 sha256
   ```

   令牌只在命令里用，**不要打印明文**。

### 15.4 边界（这几样永远不在这套策略里）

- **`/var/www/dl`（webroot）** —— 公网直出目录，卫生另有门禁（`pnpm check:webroot-hygiene`，§14 末段），
  不在本节管辖；
- **`/opt/dl-private/releases.internal.json` 清单本体** —— 清单是唯一真相，只有发布 / 下架流程能改它；
- **被清单引用的任何文件** —— 不许以「保留策略」的名义删（`/opt/dl-private/apk/` 的 8 个包就是这一类）；
- **`/opt/dl-private/private/` 目录本身** —— `www-data` 属主、历史路径仍要被追溯，只删里面的文件。
