# 发版入口

> **发版操作看 [`docs/RELEASE-MANUAL.md`](docs/RELEASE-MANUAL.md)（纯手动清单）。**
> 本文件只保留「为什么这么改」的历史说明，不再写操作步骤 —— 两处写步骤必然有一处先过期。

相关文档：

| 文档 | 内容 |
| --- | --- |
| [`docs/RELEASE-MANUAL.md`](docs/RELEASE-MANUAL.md) | 发版手动清单：bump 版本号 → 构建 → 四项人工核对 → 上传 dl → push/tag → 下载比 hash → 模拟器烟测；含分支/worktree 卫生 |
| [`docs/dl-release-api.md`](docs/dl-release-api.md) | `POST /api/v1/release` 上传接口（multipart、Bearer 令牌、服务端自校验 md5/sha256/变体） |
| [`docs/releases-manifest.md`](docs/releases-manifest.md) | `releases.json` 契约与校验器 `scripts/validate-releases-manifest.mjs` |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | tag `v*` 触发：从 dl 拉已发布 APK、校验 MD5、镜像成 GitHub Release（**不构建、不碰 keystore**） |
| [`CHANGELOG.md`](CHANGELOG.md) | 各版本变更；`## <version>` 段落会被抄进 dl 的 `changes` 与 Release notes |

---

## 2026-11-18 变更：删除一键发版脚本，改纯手动清单

**删掉的**：

| 文件 | 原职责 | 为什么删 |
| --- | --- | --- |
| `release-apk.sh`（664 行） | 九步一体：门禁 → 改版本号 → 写 CHANGELOG → commit → 构建 → 上传 → push + tag | 失败后状态半改（文件/commit/已上传产物都已落地），只能整体重跑；无法只重试单步 |
| `preflight.sh`（470 行） | 九项门禁，任一 FAIL 即中止 | 把发版与测试强绑定：一项测试失败就完全不能发布，而失败点常常与本次发版无关 |
| `release-tests/run-mock-tests.sh` | 上面两个脚本的 mock 隔离验收（62 条断言） | 被测脚本不存在后它就是死代码，留着只会给出误导性的「全部通过/失败」 |

**保留**：`build-apk.sh`（调试/发布两种模式的构建脚本，行为未改；首次运行仍会自动生成 keystore 与
`keystore.properties`）。是否需要继续保留由维护者决定，本次不动。

**不动的**：`.github/workflows/release.yml` 的发布逻辑一行未改 —— 它本来就不构建 APK，只做镜像。

**同时收紧的两处**：

1. **签名 fail-fast + 证书指纹闸门**（`android/app/build.gradle`）：release 构建缺
   `android/keystore/keystore.properties`、缺 release 字段、keystore 文件不存在，**或证书指纹与已发布证书不一致**时，
   直接 `GradleException` 中止；`signingConfigs.debug` 也只在指纹一致时才定义。debug 构建默认行为不变
   （仍用 AGP 默认的 `/root/.android/debug.keystore`）。

   **重要事实（2026-11-18 实测）**：本工程原来的凭据路径 `rootProject.file("../keystore/…")` 指向从未存在的
   仓库根 `keystore/`，所以 signingConfig 从来没有生效过 —— 所有已发布包（含 1.4.0-beta.8）都是 AGP 默认的
   `/root/.android/debug.keystore` 签的，即 `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`；
   而 `build-apk.sh` 生成的 `android/keystore/release.keystore`（`63669393…`）、`android/keystore/debug.keystore`
   （`6c1ed521…`）都不是这个证书。因此「把路径修对」本身就会换签名 → 所以加了 `EXPECTED_CERT_SHA256` 闸门：
   路径生效但证书不符时构建失败，而不是悄悄换签。
   **签名迁移必须单独规划，禁止顺手切换证书**（换证书 = 已装用户无法覆盖升级）。
2. **版本号单一来源**：`package.json` 的 `version`（versionName）与 `androidVersionCode`（versionCode）
   成为唯一来源，`android/app/build.gradle` 从中读取（`rspack.config.ts` 也读同一处注入 `__APP_VERSION__`）。
   发版只改 `package.json` 一处；字段缺失或格式非法时 gradle 配置阶段直接报错。

历史脚本（`release-apk.sh`、`preflight.sh`）的实现细节与参数说明请查 git 历史
（`git log --diff-filter=D --oneline -- release-apk.sh preflight.sh`），本文不再复述。
