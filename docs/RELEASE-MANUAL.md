# 发版手册（纯手动清单）

适用：从 `1.4.0-beta.8` 起。发布 = 按本清单一步步做，**没有一键脚本**。

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

`.github/workflows/release.yml` 的逻辑没有改：它仍然只在 tag 推送后**镜像**已上传的 APK 到 GitHub Release，
不在 CI 里构建、不接触 keystore。

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

- [ ] `androidVersionCode` 比线上 `latest` 大（`curl -fsS https://dl.rose7.cn/releases.json | head -c 400` 看最新一条）
- [ ] `version` 与即将打的 tag 一致（tag 是 `v<version>`）
- [ ] 没改 `android/app/build.gradle` 里的版本（那里已没有硬编码版本号；缺字段会让构建直接报错）
- [ ] `CHANGELOG.md` 加了 `## <version> (<日期>) — <标题>` 段，写用户能看懂的话（会进 dl 的 `changes` 与 Release notes）

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

---

## 4. 步骤 3 — 五项人工核对（**全部通过才准上传**）

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
  | `.github/workflows/release.yml` | 下载 APK、校验 MD5 之后、创建 Release 之前拦一道 |
  | `POST /api/v1/release`（dl 服务端） | 拒收 debuggable 包，返回 `400 APK_DEBUGGABLE` |


五项全过才继续。任何一项不过都没有「先发后修」这种选项。

---

## 5. 步骤 4 — 上传 dl.rose7.cn

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

- tag 必须是 `v<version>`（workflow 用它解析版本号，格式不符会 `::error::` 退出）。
- tag 一旦推错 commit：**不要 force 改已有 tag**。删 Release 后删 tag 再重打，或换新版本号。
- push tag 会触发 `.github/workflows/release.yml`：它从 `https://dl.rose7.cn/releases.json` 查该版本、
  校验 MD5、把 APK 镜像成 GitHub Release（prerelease 自动判定）。**所以 tag 必须在 §5 上传成功之后再推。**
- 观察：`gh run list --workflow=release.yml --limit 3`；workflow 失败最常见原因是 dl 上查不到该版本。

---

## 7. 步骤 6 — 两端下载比 hash

```bash
V=1.4.0-beta.9
curl -fsSL -o /tmp/dl-$V.apk https://dl.rose7.cn/apk/deepseek-chat-$V.apk
sha256sum /tmp/dl-$V.apk                 # 必须 == §4.4 的 sha256
curl -fsSL https://dl.rose7.cn/releases.json | python3 -c 'import json,sys; d=json.load(sys.stdin); r=[x for x in d["releases"] if x["version"]=="'$V'"][0]; print(r["version"], r["versionCode"], r["size"], r["sha256"][:16], r["artifactVariant"])'
gh release download v$V --pattern "*.apk" --dir /tmp/gh-$V --clobber
sha256sum /tmp/gh-$V/*.apk               # 与 dl、与本地三者一致
```

- [ ] dl 下载的 sha256 == 本地构建产物 sha256
- [ ] GitHub Release 资产的 sha256 == 同上

**等价脚本（自动做上面第 1、2 条，并顺带校验记录字段与 `package.json` 口径）：**

```bash
pnpm run release:verify -- --version $V --apk android/app/build/outputs/apk/release/app-release.apk
```

它会把本地构建产物 / 线上记录 / dl 下载件三者算一遍 sha256 做对比，并把「还没打 tag」之后的下一步提示出来。
GitHub Release 资产那一条仍需 `gh release download` 人工确认（脚本不碰 GitHub）。
- [ ] `releases.json` 的 `versionCode` / `size` / `artifactVariant` 与本次一致

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
`variant.mjs` / `apk-manifest.mjs`）才走这一节：它不在 CI 产物里、没有版本号、靠人手 `scp` 上去，
所以「部署成功」必须有它自己的证据，而不是看服务是不是 active。

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
  "buildTypes": ["stable", "prerelease"] }
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

# 2) 同步（server.mjs import 同目录的 variant.mjs / apk-manifest.mjs，改了哪个传哪个，两个以上一起传）
scp deploy/dl-release/server.mjs aliyun:/opt/dl-release/

# 3) 语法检查 + 重启（check 不过就不重启）
ssh aliyun 'node --check /opt/dl-release/server.mjs && systemctl restart dl-release && sleep 1 && systemctl is-active dl-release'

# 4) Caddy：只有**新增**了 API 路径才需要动。片段见 deploy/dl-release/caddy-dl-api.conf，
#    @api 必须同时匹配 /api/v1/release 与 /api/v1/version；validate 通过再 reload，禁止 restart。
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
ssh aliyun 'sha256sum /shared/build-types.mjs /opt/dl-release/server.mjs /opt/dl-release/variant.mjs /opt/dl-release/apk-manifest.mjs'
sha256sum shared/build-types.mjs deploy/dl-release/server.mjs deploy/dl-release/variant.mjs deploy/dl-release/apk-manifest.mjs
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

- 不自动算 `versionCode`（不读线上 `releases.json` 做 `max(本地,远端)+1`）——手动看一眼线上 latest 再填，§2 有命令。
- 不自动写 `CHANGELOG.md`、不自动生成 Release notes（notes 由 workflow 从 `releases.json` 的 `changes` 生成，所以 `changes` 要写人话）。
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

## 14. 私有（internal）包发布：一条命令 + 演练 + 回滚（Issue #566 问题 1 → B 方案）

私有包 = `-PartifactVariant=internal` 构建出来的包，**进 `releases.json` 但不改公共 `latest`**：
装了 internal 变体的客户端能自动收到更新（解 #377），公共渠道（standard）仍然停在原来那个版本。
两条路的分工是硬的：

| 发布 | 走哪条 | 谁改 `latest` |
| --- | --- | --- |
| 公共（standard） | `pnpm run release:upload` → `POST /api/v1/release`（要令牌） | **服务端**改成这次发布的版本（`server.mjs` §8） |
| 私有（internal） | `node scripts/publish-private-apk.mjs`（SSH 直写站点根，不要令牌） | **谁都不改**（脚本写回前的自检会挡住任何改动） |

> 私有包**不能**走 `/api/v1/release`：那条路把 `latest` 设成新版本（服务端语义就是"这是最新公共发布"），
> 内测包一发出去，公共渠道的「最新」就被内测包顶掉了。私有包改走 **`ssh <host>` 直写
> `/var/www/dl`**：`scp` 先传 `.tmp` 再 `mv`（原子），清单**先备份再原子替换**。

### 14.1 一条命令

```bash
# 1) 出包（与 §3 同源，变体必须是 internal）
pnpm build:internal && npx cap sync android
cd android && ./gradlew --no-daemon --max-workers=1 assembleRelease -PartifactVariant=internal
APK=android/app/build/outputs/apk/release/app-release.apk

# 2) 先看要做什么（不落地：不上传、不改清单）
node scripts/publish-private-apk.mjs --apk $APK --version 1.4.2 --versionCode 21 --dry-run

# 3) 真发布（**没有** --dry-run 就是真发布）
node scripts/publish-private-apk.mjs --apk $APK --version 1.4.2 --versionCode 21
```

跑完会打印**直链、sha256、size 与五项验证结果**，并在清单里留一条 `artifactVariant: "internal"` 记录。
把直链发给内测同学即可（一定要连 `sha256` 一起给，让他们能自己核对）。

### 14.2 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--apk <path>` | **必填** | APK 路径（环境变量 `DL_PRIVATE_APK`） |
| `--version <x.y.z>` | **必填** | versionName，必须与 APK 内一致（`DL_PRIVATE_VERSION`） |
| `--versionCode <n>` | **必填** | 正整数，必须与 APK 内一致（`DL_PRIVATE_VERSION_CODE`） |
| `--variant <v>` | `internal` | `internal` \| `standard`（`DL_PRIVATE_VARIANT`）。打回 standard 变体别用这条管线，走 §5 |
| `--changes <text>` | 一行默认说明 | 清单里的变更说明，可重复给多条 |
| `--dry-run` | 关 | 只打印动作与清单条目，**一个字节都不发** |
| `--exercise` | 关 | 演练：真上传 + 真加清单条目 + **立刻全量回滚**（只允许 `0.0.0` 开头的假版本号） |
| `--skip-apk-validation` | 关 | **仅供演练**：假文件过不了 `aapt2`，跳过 APK 校验 |
| `--ssh-host` / `--site-root` / `--public-base` | `aliyun` / `/var/www/dl` / `https://dl.rose7.cn/` | 换分发主机时才动 |
| `--aapt2 <path>` | 自动找 | `$AAPT2` → `$ANDROID_HOME/build-tools/<ver>/aapt2` → `~/android-sdk` → PATH |

退出码：**0 成功 / 1 校验或执行失败 / 2 参数或环境问题（一个字节都没发）**。

### 14.3 脚本拦哪五件事（任一不符直接退出，不「先发后修」）

| # | 判据 | 失败时会说 |
| --- | --- | --- |
| 1 | `aapt2 dump badging`：包名 = `com.example.deepseekchat`、`versionCode`/`versionName` = 你给的参数 | 具体哪个字段不一致 |
| 2 | `application-debuggable` **一处都没有** | 「debuggable 构建，绝对不发」（Issue #60） |
| 3 | `aapt2 dump xmltree` 的 `<meta-data …ARTIFACT_VARIANT>` = `--variant` | 标记缺失/取值不符 → 让你按 `-PartifactVariant=` 重出包 |
| 4 | 合并后的清单 schema（`buildType ∈ stable\|prerelease`、`artifactVariant ∈ internal\|standard`、`file`/`sha256`/`md5`/`size`/`releasedAt` 形态） | 逐条报出（复用 `scripts/validate-releases-manifest.mjs`，不另写枚举） |
| 5 | **公共 `latest` 一个字节没变** + 既有记录逐条 JSON 相同 | 「latest 被改了 / 既有条目被改了」 |

### 14.4 为什么文件名要不可猜测

清单是**公开**的（`https://dl.rose7.cn/releases.json` 任何人可读），所以「私有」不能靠"别人不知道清单"。
能守住的只有一件事：**别人不能顺着版本号把包扫下来**。历史上所有公共包都叫
`deepseek-chat-<version>.apk` —— 知道你在发 1.4.2 就能直接猜 `deepseek-chat-1.4.2.apk`。
私有包因此用 `deepseek-chat-<version>-<variant>-<8位随机>.apk`：

- 随机段来自 `crypto.randomBytes(5)` → **40 bit** → 8 个 base32 字符（`A-Z2-7`，无 `0/1` 混淆）；
- **不许用时间戳**：时间戳可枚举，知道大概几点发的，搜索空间能从 36⁸ 压到几百万，扫一遍就出来了；
- 传之前还会查远端有没有同名文件（撞了就重跑，换一个随机串）。

⚠️ 说清边界，别夸大：这条管线**不是访问控制**。清单里写着 `file` 字段，拿到清单的人照样能下载 ——
它挡住的是「猜 URL」，不是「读清单」。真私有（清单里也不出现）是 #566 的 A 方案，本管线没做。

### 14.5 变体不同不能覆盖安装（`VARIANT_MISMATCH`）

同一个包名、同一个签名，但 `artifactVariant` 不同的两个包**装不到一起**：

- 已装 standard 的机器上直接装 internal 包 → 安装器报签名/变体冲突（客户端侧会以 `VARIANT_MISMATCH` 呈现）；
- 反过来同理。**必须先卸载**（卸载会清掉本地聊天记录与 Key，事先提醒用户导出/备份）。

内测同学的正确姿势：

```bash
adb uninstall com.example.deepseekchat            # 先卸掉公共渠道那个
adb install deepseek-chat-1.4.2-internal-XXXXXXXX.apk
```

装完**如果这一版打的是本地实例**（`consume.baseUrl` = `http://127.0.0.1:18000`），
还必须先打通回环，否则登录 / 额度 / 兑换全部失败：

```bash
adb reverse tcp:18000 tcp:18000     # 每条 USB 连接断开后都要重做；换机也要重做
```

客户端的更新选择是「同变体 + versionCode 更大 + 有 sha256」才算候选（`src/services/updateManifest.ts`），
所以 internal 包不会把 standard 用户带走 —— 发布后可以自己核一遍：

```bash
node -e 'const d=require("/tmp/live.json");console.log(d.latest, d.releases[0].version, d.releases[0].artifactVariant)'
```

### 14.6 回滚

清单先备份（`releases.json.bak-private-<epoch>`），所以回滚就是「把备份换回去 + 删包」：

```bash
# 1) 恢复清单（原子 mv）
ssh aliyun 'mv -f /var/www/dl/releases.json.bak-private-<epoch> /var/www/dl/releases.json'
# 2) 删掉上传的包
ssh aliyun 'rm -f /var/www/dl/apk/deepseek-chat-<version>-internal-<8位随机>.apk'
# 3) 复核：直链应 404，latest 应回到发布前的值
curl -sS -I https://dl.rose7.cn/apk/deepseek-chat-<version>-internal-<8位随机>.apk | head -1   # 期望 404
curl -sS https://dl.rose7.cn/releases.json | head -2                                           # latest 不变
```

真发布时脚本会把这两条回滚命令**原样打印在最后**（连 epoch 一起），照抄即可。

### 14.7 演练（`--exercise`）—— 上线前先证明「上传 / 清单改动 / 回滚」三件事都对

拿一个假文件把整条链路真跑一遍，跑完**立刻全量回滚**，线上不留任何残留：

```bash
head -c 2000000 /dev/urandom > /tmp/fake.apk       # 2 MB 假包（过不了 aapt2，所以要跳过校验分支）

# ① 先看它会被 APK 门禁挡住（这一步是证明门禁活着）
node scripts/publish-private-apk.mjs --apk /tmp/fake.apk --version 0.0.0 --versionCode 9999 --dry-run
#    → exit 1：aapt2 dump badging 失败（不是合法 APK？）

# ② 正常的 dry-run（跳过校验）：只看计划
node scripts/publish-private-apk.mjs --apk /tmp/fake.apk --version 0.0.0 --versionCode 9999 \
  --skip-apk-validation --dry-run

# ③ 真演练：上传 → 加清单条目 → 验证 → 回滚 → 再验证
node scripts/publish-private-apk.mjs --apk /tmp/fake.apk --version 0.0.0 --versionCode 9999 \
  --skip-apk-validation --exercise
```

演练必须核对的五项（缺一条就不算通过）：

| # | 判据 | 期望 |
| --- | --- | --- |
| 1 | 直链 `curl -I` | `200` + `content-type: application/vnd.android.package-archive` + `content-length` = 文件大小 |
| 2 | 下载回来算 sha256 | = 上传前本地 sha256 |
| 3 | 清单加条目后 | `latest` **与发布前逐字节相同** |
| 4 | 回滚后直链 | `404`（文件真删了） |
| 5 | 回滚后清单 | `sha256` 与演练前**完全一致**、条目数回到 19、无 `bak-private`/`tmp-` 残留 |

脚本会把 1/2/3 在发布后立刻算、4/5 在回滚后立刻算，任何一条不符就 `exit 1` 并打印现场。
**演练数据（`0.0.0` / versionCode 9999）不允许留在线上** —— 演练结束前脚本就把备份也消耗掉了（零残留）。
