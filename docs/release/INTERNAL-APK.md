# 内测 APK 出包手册（一条命令 + 硬断言）

> 面向：给内测用户发**内部测试包**（variant = `internal`，连生产后端 `https://apia.ecsafe.cn`，
> `NATIVE_SQLITE_MIGRATION_ENABLED = true`）。
> 对外发布（standard / staging、上传 dl、写 releases.json）走 [`HOWTO-RELEASE.md`](./HOWTO-RELEASE.md)，**不是这份**。

## 0. 一条命令

```bash
# 在仓库根（worktree 也行）执行。构建串行：同一时间只跑一个 gradle，别和别人抢 CPU。
BUILD_VARIANT=internal COPY_TO_DESKTOP=1 ./build-apk.sh release
```

成功时最后几行长这样（真实输出见 PR / Issue 评论）：

```
============ RELEASE 产物校验通过 ============
APK 绝对路径 : …/android/app/build/outputs/apk/release/app-release.apk
APK 大小     : 12M (12027616 bytes)
SHA-256      : 0c27550f…
交付副本     : <桌面>/jingluo-v2.0.1-vc45-internal-<短hash>.apk
```

## 1. 它按顺序做了什么（每一步都是硬闸，红就停）

| 步 | 动作 | 红了意味着 |
| --- | --- | --- |
| 1 | 读 `build.env` → 定 SDK / JDK / build-tools 档位，版本闸门 | 环境不对（JDK < 21、build-tools 档位不存在） |
| 1b | 从 `package.json` 读 `version` / `androidVersionCode`（versionName / versionCode 的**唯一来源**） | 版本号读不出来就不出包 |
| 2 | 写 `android/local.properties`（`sdk.dir`） | — |
| 2b | `scripts/check-keystore-config.mjs`：签名材料形状 + 指纹必须等于已发布证书 | 换签 = 已装用户无法覆盖升级 |
| **2b-2** | **`scripts/check-internal-lane.mjs`：覆盖升级硬断言**（见 §2） | **versionCode 没递增 / 证书前缀变了 → 不许分发** |
| 3 | `pnpm run build:internal` → `dist/`（产物自述 `variant=internal`） | 前端构建失败 |
| 4 | `pnpm exec cap sync android` → 把 `dist/` 同步进原生工程 | 见 §3 坑 ① |
| 5 | gradle `assembleRelease`（`INTERNAL_BUILD=1`，见 §3 坑 ③ 的启动方式） | 原生编译 / 签名 / 变体闸门 |
| 6 | `scripts/verify-release-apk.mjs` 六项 + 版本号断言（`--variant internal`，带 `--expect-version-code/--expect-version-name`） | 见 §4 |
| **6b** | **`scripts/check-apk-seam.mjs`：包内登录接缝标记必须 0 命中（第 7 项）** | **命中 = 鉴权绕过，禁止分发** |
| 7 | 打分横幅 + SHA-256 +（`COPY_TO_DESKTOP=1` 时）落桌面副本 | — |

## 2. 覆盖升级硬断言（用户拍板，2026-11-27）

用户原话：**「已安装 vc42 或 vc43 的内测用户均可直接覆盖升级，无须卸载重装，保留全部历史数据」**。
所以每次对外分发新内测包：

1. **`versionCode` 必须递增**（… 43 → 44 → 45 …）。`versionName` 可以一直是 `2.0.1`。
   同号 / 降号的包装不上（Android 会报「应用未安装」），等于逼用户卸载重装 —— 那会丢历史数据。
2. **签名证书必须不变**（`e7c5baee…aa8a1`）。换签的包也装不上。

这两条不是文档约定，是脚本判据：

```bash
node scripts/check-internal-lane.mjs              # 出包前单独跑（build-apk.sh 步骤 2b-2 自动跑）
node scripts/check-internal-lane.mjs --version-code 45   # 预演「如果要打 45」
```

数据源是 **[`internal-lane.json`](./internal-lane.json)（内测分发台账）**：`lastDistributedVersionCode`
是上一次**真的交到内测用户手上**的号。**分发完记得改台账**（把刚发出去的号写进 `lastDistributedVersionCode`
并往 `history` 追一行）—— 台账不自动改写，因为它记的是「发没发出去」这件事，只有人知道。

为什么不从线上清单自动取上一个 versionCode：内测包**不进公网 `releases.json`**
（[`../releases-manifest.md`](../releases-manifest.md) §1 明确废止了 internal 条目），本机没有可信来源。

## 3. 四个必踩的坑（都已在脚本里处理，改动脚本时别退回去）

① **`git reset --hard` 会冲掉 `android/capacitor.settings.gradle`**，之后直接跑 gradle 会得到
`No matching variant`。原因：这个文件是 `cap sync` 按本机 `node_modules` 路径生成的。
→ **凡是 reset / rebase / 切 commit，之后必须重跑 sync**；本脚本步骤 4 每次都会 sync，所以走脚本就不会踩。
（另一条相关的：`cap sync` 会把本机绝对路径写进这个文件，它**不能提交** —— `release-howto.mjs` 会在
它本来干净时还原，本脚本不碰 git，出包前后自己看 `git status`。）

② **`android/keystore/keystore.properties` 必须是四个 `Release` 后缀键**：
`storeFileRelease` / `storePasswordRelease` / `keyAliasRelease` / `keyPasswordRelease`，
模板是同目录的 `keystore.properties.example`。写成 `storeFile`（无后缀）时 gradle 只会说「缺字段」。
该文件已被 gitignore，**不要提交**。自检：`pnpm run check:keystore`。

③ **`./gradlew` 在 Windows/MSYS 下不可用**：报
`Error: Unable to access jarfile D;/…/gradle-wrapper.jar`（冒号被当成盘符分隔符）。
→ 脚本改用 `java -classpath android/gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <args>`
（两个平台同一条路），找不到 wrapper jar 才退回 `./gradlew`。

④ 首次在一台新机器上出包：`cp build.env.example build.env`，填 `ANDROID_HOME` 与 `BUILD_TOOLS_VERSION`
（本机：`<android-sdk>` + `35.0.0`）。`build.env` 已被 gitignore。没建时脚本会自动探测几个常见位置并打警告，
但**别依赖探测**——把它固定下来。

⑤ **两套构建必须物理隔离：交付 APK 禁接缝，L1 测试产物必须带接缝。**
`TEST_AUTH_SEAM=1` 会让 `AuthGate` 直接进已登录态（不读盘、不续期、不调 `me()`）：

| 用途 | 是否带接缝 | 怎么建 |
| --- | --- | --- |
| 交付 APK | **禁止** | `BUILD_VARIANT=internal COPY_TO_DESKTOP=1 ./build-apk.sh release`（环境里**不能**有 `TEST_AUTH_SEAM`） |
| L1 测试产物 | **必须** | `TEST_AUTH_SEAM=1 …` 分别出 `dist` / `dist-standard` / `dist-scroll` |

- 环境里带着 `TEST_AUTH_SEAM` 跑 `build-apk.sh release` → **脚本直接拒跑**（不是警告、不是自动 unset：静默清掉会让人以为「刚才那次是干净的」）。
- 包内兜底断言（**第 7 项**）：`node scripts/check-apk-seam.mjs <apk>` 扫包内文本条目，`test-token-not-real` / `__TEST_AUTH_STATE__` 两个标记**必须 0 命中**；扫不到文本条目算「判不出来」（exit 2），**不是 PASS**。
- 顺序：**先出不带接缝的 APK（干净环境），再出带接缝的测试产物** —— 反过来容易让环境残留污染 APK。
- L1 产物必须在**最终 commit** 上构建：`src` 的 mtime 比产物 `builtAt` 新会触发 `SKIP(env) 构建产物陈旧`（无 bypass），而 `SKIP` **不计为通过**。

## 4. 出包后必须逐条确认（贴给别人时也贴这四条）

1. `verify-release-apk` 表里 **6 项全 PASS**（debuggable / 变体跨层同源 / 回环 / 证书 / 明文标记 / 包内 consume.baseUrl）；
2. **版本号断言不是「未判」**：结论行必须写 `pass`，且 `versionCode` / `versionName` 与 `package.json` 一致
   （`build-apk.sh` 步骤 6 会自动带上 `--expect-version-*`；手跑 `verify-release-apk` 时漏了这两个参数就会「未判」——
   「未判」不算通过，报告里会明写）；
3. `check-internal-lane` 结论 **PASS**，且链是递增的（`42 → 43 → 45`；若中间有「构建过但撤回、从未分发」的号，`withdrawn[]` 里会标注，链上显示成 `44(撤回·未分发)`）；
4. 交付物三件齐：**APK（桌面上那一份）+ commit sha + SHA-256**。

## 5. 已知风险怎么写（别自己发挥）

风险描述沿用 #940 的 35 行矩阵口径，**核心一条**：只有「真源仍是旧库、且这次一次都没往新存储写过」
才敢说数据完好；其余情况按矩阵逐条说清。不要把「校验通过」写成「数据安全」——
那两件事的判据不同（前者判包，后者判数据）。

## 6. 相关

- 内测分发台账：[`internal-lane.json`](./internal-lane.json)
- 覆盖升级判据实现：[`../../scripts/check-internal-lane.mjs`](../../scripts/check-internal-lane.mjs)
- 六项校验实现：[`../../scripts/verify-release-apk.mjs`](../../scripts/verify-release-apk.mjs)
- 第 7 项（包内无登录接缝）实现：[`../../scripts/check-apk-seam.mjs`](../../scripts/check-apk-seam.mjs)（标记唯一出处：`scripts/lib/testAuthSeam.mjs` 的 `SEAM_MARKERS`）
- 签名材料与指纹迁移规划：[`../RELEASE-MANUAL.md`](../RELEASE-MANUAL.md) §1
