# 1.4.1 正式版发版执行清单（runbook）

> 本文件只存在于 `release/1.4.1` 分支。写于 2026-11-19，状态：**一切就绪，尚未上传 / 未打 tag / 未 push main**。
> 用户说「开始正式发布」后，按 §4 的顺序执行即可；§5 是发布前必须先确认的阻断项。

## 1. 构建身份

| 项 | 值 |
| --- | --- |
| 分支 | `release/1.4.1`（从 `origin/main` 开出） |
| 构建 base sha | `f18274816dae6599c7d6b1d59fd858335c0739a7`（`f182748`，`origin/main`） |
| 前端变体 | `standard`（`pnpm build`，`dist/build-info.json` 里 `variant=standard`、`version=1.4.1`） |
| artifactVariant | `standard`（APK 内 `<meta-data android:name="com.example.deepseekchat.ARTIFACT_VARIANT">` = `standard`） |
| 包名 | `com.example.deepseekchat` |
| versionName | `1.4.1` |
| versionCode | `20`（线上最新是 `1.4.0` / versionCode `19`，必须严格大于它，否则上传 409 VERSION_CONFLICT） |
| buildType（按版本号判定） | `stable`（`1.4.1` 无 `-beta` 后缀；`buildType` 只有 `stable` 与 `prerelease` 两值，#330） |
| 签名证书 SHA-256 | `E7:C5:BA:EE:51:7C:A2:B2:25:89:50:E9:34:52:1F:2F:AD:44:8D:00:F7:2F:2F:F7:29:7B:DF:4F:A0:0A:A8:A1`（`e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`，与全部历史版本同一张证书） |
| 签名材料 | `D:\all_project\runs\_keys\debug.keystore`（口令 `android`，别名 `androiddebugkey`） |
| debuggable | **否**（`aapt2 dump badging | grep -c application-debuggable` = `0`；仓库门禁 `check:apk` 也判 `debuggable=false (attr_absent)`） |

## 2. 产物

| 项 | 值 |
| --- | --- |
| APK 路径 | `android/app/build/outputs/apk/release/app-release.apk` |
| size | `5431602` 字节（5.18 MiB，服务端上限 52428800） |
| sha256 | `8791550746450e6593045486107291d823fa1539d49df85bcdf3e3652903460c` |
| md5 | `672da557fca62bcee4ddba79313c456d` |

构建口径（三步，缺 `cap sync` 会打出旧 bundle）：

```bash
cd /d/all_project/deepseekapp
export JAVA_HOME=/d/android-tools/jdk-21.0.13+9; export PATH="$JAVA_HOME/bin:$PATH"
rm -rf dist && pnpm build
pnpm exec cap sync android
cd android && ./gradlew assembleRelease -PartifactVariant=standard
```

签名复核：

```bash
export JAVA_HOME=/d/android-tools/jdk-21.0.13+9; export PATH="$JAVA_HOME/bin:$PATH"
BT=/d/android-sdk/build-tools/36.0.0
cd /d/all_project/deepseekapp
"$BT/apksigner.bat" verify --print-certs android/app/build/outputs/apk/release/app-release.apk
"$BT/aapt2.exe" dump badging android/app/build/outputs/apk/release/app-release.apk | grep -c application-debuggable   # 必须 0
```

签名材料指向（本机 `android/keystore/keystore.properties`，gitignore 排除、不入库）：
`storeFileRelease=../../../runs/_keys/debug.keystore`、`storePasswordRelease=android`、`keyAliasRelease=androiddebugkey`，先跑 `pnpm run check:keystore` 确认指纹是 `e7c5baee…a8a1`，否则 `build.gradle` 的 `EXPECTED_CERT_SHA256` 闸门会直接中止构建。

## 3. 发版门禁结论

`node scripts/release-check.mjs --apk android/app/build/outputs/apk/release/app-release.apk --manifest http://62.106.70.167:8888/releases.json`

结论：**PASS，0 FAIL**（原文摘录见 §7）。补 `--tag v1.4.1` 再跑一次同样 PASS（tag 与 version 一致）。

dry-run 上传请求（没有发网络、没有令牌）：`node scripts/release-upload.mjs --apk ... --endpoint http://62.106.70.167:8888/api/v1/release --dry-run` → endpoint / size / sha256 / md5 与上表一致，`meta = {"version":"1.4.1","versionCode":20,"buildType":"stable"}`，`changes` 22 条（全部来自 `CHANGELOG.md` 的 `## 1.4.1` 段）。

## 4. 发布时按顺序执行的命令

> 全部带 GitHub 代理（直连 github 不通）。上传这一步**没有** GitHub 依赖，不要带代理，否则会绕到外面去。

### 4.1 上传 APK 与清单（服务端要已部署，见 §5）

```bash
cd /d/all_project/deepseekapp
export DL_RELEASE_TOKEN=<发布令牌>     # 或 --token-file ~/.config/dl-release/token
node scripts/release-upload.mjs \
  --apk android/app/build/outputs/apk/release/app-release.apk \
  --endpoint http://62.106.70.167:8888/api/v1/release
```

### 4.2 打 tag 并推分支与 tag

```bash
cd /d/all_project/deepseekapp
git tag -a v1.4.1 -m "1.4.1"        # tag 必须是 v<version>，release-check 已校验
export http_proxy=http://127.0.0.1:7897 https_proxy=http://127.0.0.1:7897 NO_PROXY= no_proxy=
git push origin release/1.4.1
git push origin v1.4.1
git ls-remote --tags origin v1.4.1  # 复核（不依赖本地 ref 缓存）
```

### 4.3 复核线上产物（下载回来比对 sha256 / md5 / size / 版本 / 签名）

```bash
cd /d/all_project/deepseekapp
node scripts/release-verify.mjs --version 1.4.1 \
  --expect-sha256 8791550746450e6593045486107291d823fa1539d49df85bcdf3e3652903460c \
  --expect-md5 672da557fca62bcee4ddba79313c456d
```

（`release-verify` 会拉清单、找该版本、下载 APK、重算 hash 并复核包内 versionName/versionCode/签名；具体参数以 `node scripts/release-verify.mjs --help` 为准。）

### 4.4 事后确认

```bash
curl -sS --noproxy '*' http://62.106.70.167:8888/releases.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.latest, j.releases[0].version, j.releases[0].versionCode)})"
# 期望：1.4.1 1.4.1 20
```

## 5. 已知阻断 / 发布前必须先确认

1. **两个上传接口当前都是 404**（2026-11-19 21:35 实测），说明 `dl-release` 服务还没部署或路由没挂上。探测命令（只读，不建单）：

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*' http://62.106.70.167:8888/releases.json      # 期望 200（对照组，清单服务在）
   curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*' http://62.106.70.167:8888/api/v1/release     # 当前 404
   curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*' https://dl.rose7.cn/api/v1/release            # 当前 404
   ```

   两个 404 任何一个不消除，`release-upload` 都会失败（它会在发请求前就报环境错误，不会留下半个状态）。**这一步没解决之前不要打 tag**：tag 打了但包里没发出去，等于对外宣布了一个下载不到的新版本。
2. **发布令牌**：dry-run 不需要令牌，真发必须有 `DL_RELEASE_TOKEN`（或 `~/.config/dl-release/token`）。当前环境未注入，令牌值不入库、不贴聊天。
3. `releases.json` 目前 `latest = 1.4.0`，且 `releases[0]` 是 `1.4.0` / versionCode `19` / `buildType: prerelease`（同版本号重发过一次内测包）。本版 versionCode 20 严格大于 19，符合契约。

## 6. 回滚方式

1. **撤 tag**（本地 + 远端）：

   ```bash
   cd /d/all_project/deepseekapp
   git tag -d v1.4.1
   export http_proxy=http://127.0.0.1:7897 https_proxy=http://127.0.0.1:7897 NO_PROXY= no_proxy=
   git push origin :refs/tags/v1.4.1
   ```

2. **`releases.json` 的 latest 回退**：把 `latest` 改回上一版（`1.4.0`）、并保证它是 `releases[0]`。这一步**必须在 ECS 上做，需要 ECS 权限**（`/var/www/dl/` 目录 + 清单原子替换），本仓库脚本不提供「回退」命令，也不要在本地手改后上传覆盖：

   ```bash
   # 在 ECS 上（仅示意，需运维权限；写操作前先备份）
   # cp /var/www/dl/releases.json /var/www/dl/releases.json.bak-$(date +%Y%m%d%H%M%S)
   # 再把 latest 与 releases[0] 恢复为上一版，最后 node scripts/validate-releases-manifest.mjs 校验结构
   ```

   回退后客户端会重新收到旧版的更新提示；已装上 1.4.1 的用户不会被「降级安装」（Android 不允许 versionCode 变小），只能等下一版。
3. **APK 文件保留策略**：不要删 `apk/deepseek-chat-1.4.1.apk`（删了会让已发出的清单指向 404）；只在确需下架时连同清单一起回退。

## 7. 门禁原文（release-check，2026-11-19 21:33）

```
[1) 版本号唯一来源 package.json]
  ok    version = 1.4.1（→ Android versionName）
  ok    androidVersionCode = 20（→ Android versionCode）

[2) CHANGELOG.md 的版本段（用户可见变更的唯一来源）]
  ok    有 `## 1.4.1` 段（这段会进 dl 的 meta.changes 与 GitHub Release notes）

[3) 三处一致：package.json / CHANGELOG 段 / 将打的 tag]
  ---- 没给 --tag，跳过 tag 一致性检查（发版时必须给：--tag v1.4.1）
  ---- 本次 buildType（按版本号判定）: stable

[4) 产物 android/app/build/outputs/apk/release/app-release.apk]
  ok    size = 5431602 字节（上限 52428800）
  ok    sha256 = 8791550746450e6593045486107291d823fa1539d49df85bcdf3e3652903460c
  ok    md5    = 672da557fca62bcee4ddba79313c456d
  ok    包名 = com.example.deepseekchat
  ok    APK 内 versionName = 1.4.1
  ok    APK 内 versionCode = 20
  ok    ARTIFACT_VARIANT = standard（必须与本次 web 构建同源：build:internal ↔ internal，build ↔ standard）
  ok    debuggable 标记不存在（release 构建类型）

[6) 与线上 latest 比 versionCode（http://62.106.70.167:8888/releases.json）]
  ok    本地 versionCode 20 > 线上 latest 19（1.4.0）

[结论]
  PASS  发版前自检通过
  下一步（上传）需要这个 sha256: 8791550746450e6593045486107291d823fa1539d49df85bcdf3e3652903460c
```

## 8. 本次未能变绿的门禁（如实记录）

- `pnpm run check:docs`（`scripts/check-doc-refs.mjs`）：本分支 **9 FAIL**，其中 **7 FAIL 在 `origin/main` 上就已存在**（同一份输出逐行 diff 过：`docs/capabilities/api.md` 引用了 #331 删掉的 `orderStore.ts`、`docs/ui/issue157/README.md` 引用了 #331 删掉的 `ours-webpay.test.mjs`，另有 5 处行号漂移到空行）。本分支的 CHANGELOG / 新增文档 **没有新增任何 FAIL**；多出的 2 FAIL 来自这台机器上 `cap sync` 生成的两个同名 `AndroidManifest.xml` 与未纳入版本管理的 `docs/ui/324-ui-emulator/`（本机脏工作树产物，不在提交里）。修这 7 处属于独立性文档整改，另单处理，不在发版分支上顺手改。
- `pnpm test`（unit 121 项）：120 PASS / 1 FAIL，红的 `tests/unit/app-identity.test.mjs` 只因本机存在未纳入版本管理的 `.work-compat/` 目录（里面有一处 `com.example.deepseekchat` 字面量）；在干净 `origin/main` worktree 上同一用例 49 项全过。提交内容与该用例无关。
