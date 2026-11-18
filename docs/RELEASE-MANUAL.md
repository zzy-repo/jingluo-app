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
代价是没有自动门禁与自动校验 —— 所以下面第 4 节那四项**人工核对必须逐项做**，这是发布前唯一的硬关卡。

`.github/workflows/release.yml` 的逻辑没有改：它仍然只在 tag 推送后**镜像**已上传的 APK 到 GitHub Release，
不在 CI 里构建、不接触 keystore。

---

## 1. 前置条件（一次性 / 每台构建机）

| 项目 | 做法 | 校验 |
| --- | --- | --- |
| 签名材料 | 发布用 `assembleDebug`（见 §3）：AGP 默认读 `/root/.android/debug.keystore`，口令 `android`、别名 `androiddebugkey` | `keytool -list -v -keystore /root/.android/debug.keystore -storepass android -alias androiddebugkey \| grep SHA256`，必须是 `e7c5baee…aa8a1` |
| 发布令牌 | 在 ECS 上取：`ssh aliyun 'cat /etc/dl-release/token' > ~/.config/dl-release/token && chmod 600 ~/.config/dl-release/token` | `ls -l ~/.config/dl-release/token` 应为 `-rw-------`；**不 echo、不贴日志、不进仓库** |
| Android SDK / JDK | 默认 `/root/android-sdk`、JDK 21 | `ls $HOME/android-sdk/build-tools/`、`java -version` |
| gh（只用于观察） | 可选 | `gh auth status`；Release 由 workflow 的内置 `GITHUB_TOKEN` 创建 |
| 工作分支 | 从 `origin/main` 开 `release/<ver>` 分支发版，不直接改 `main` | `git status -sb`、`git log --oneline -1` |

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

1. **发布包用 `assembleDebug`（AGP 默认 debug 签名）出的才是现网同一证书**。本条是历史事实，不是推荐做法。
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
cd android && ./gradlew assembleDebug -PartifactVariant=internal
```

对外构建（`standard`）：

```bash
pnpm build
npx cap sync android
cd android && ./gradlew assembleDebug    # 不传 -PartifactVariant，默认 standard
```

要点：

- **web 构建与 `-PartifactVariant` 必须同源**：`build:internal` ↔ `internal`，`build` ↔ `standard`。
  两者不一致时 App 侧变体标记是错的，自动更新会推错包。
- `INTERNAL_BUILD` 环境变量与 `-PartifactVariant` 冲突时 gradle 直接报错（这是有意的）。
- 产物路径：`android/app/build/outputs/apk/debug/app-debug.apk`。
- `assembleRelease` 现在会被签名闸门拒绝（`[签名] 签名证书与已发布版本不一致，已中止`）——
  因为现网证书是 debug key，仓库里 `android/keystore/` 那两个自生成 keystore 都不是它。
  **这不是 bug，别为了绕过它去改 `EXPECTED_CERT_SHA256`。**
- 构建完先确认产物存在再往下做，别急着上传。

---

## 4. 步骤 3 — 四项人工核对（**全部通过才准上传**）

```bash
APK=android/app/build/outputs/apk/debug/app-debug.apk
BT=$HOME/android-sdk/build-tools/35.0.0        # 与实际 build-tools 版本对齐
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

四项全过才继续。任何一项不过都没有「先发后修」这种选项。

---

## 5. 步骤 4 — 上传 dl.rose7.cn

接口细节见 [`docs/dl-release-api.md`](dl-release-api.md)（`POST /api/v1/release`，multipart，Bearer 令牌）。
服务端自己解析 APK 真身、自己算 MD5/sha256、原子更新 `releases.json`：

```bash
APK=android/app/build/outputs/apk/debug/app-debug.apk
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
- [ ] 截图留档（390 / 360 两档）；真机没测就写「未测真机」，不许写成已通过

---

## 9. 回滚

| 对象 | 操作 |
| --- | --- |
| dl 上的 APK / `releases.json` | 发布接口只增不删，需运维 `ssh aliyun` 操作（`/var/www/dl/`）。改回 `latest` 会让已升级用户降级，先想清楚 |
| GitHub Release | `gh release delete v<ver> --repo zzy-repo/deepseek-app --yes`（或先改 draft 下架） |
| tag | 先删 Release 再删 tag：`git push origin :refs/tags/v<ver>` + `git tag -d v<ver>`；**不 force 改已有 tag** |
| 发布 commit | `git revert <commit>`；仓库有并行改动，**禁止 `git reset --hard`** |

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

---

## 11. 门禁没了，最小自检还是要跑

`preflight.sh` 的九项检查里，**测试类项目仍然要做**，只是不再和发版绑死、也不再阻断上传：

```bash
pnpm type                # tsc
pnpm lint                # oxlint
npm run test             # 单元
npm run test:integration # 集成
npm run test:e2e         # e2e（含真实上游用例，需要 E2E_API_KEY）
```

约定：

- 发布分支合并前，上面至少跑到 **unit + integration + 非上游 e2e** 全绿。
- 真实模型上游 e2e 没跑就**在 Issue / CHANGELOG 里写明「上游 e2e 待补测」**，事后补测并记录结果。
- 任何一项失败都如实记录，不许用「先发后修」把测试失败洗成通过。

---

## 12. 本清单不管的事（未覆盖）

- 不自动算 `versionCode`（不读线上 `releases.json` 做 `max(本地,远端)+1`）——手动看一眼线上 latest 再填，§2 有命令。
- 不自动写 `CHANGELOG.md`、不自动生成 Release notes（notes 由 workflow 从 `releases.json` 的 `changes` 生成，所以 `changes` 要写人话）。
- 不自动修 APK 元信息不一致（aapt2 校验靠人做，§4.1）。
- 不处理 `dist/` 缓存导致的旧产物：怀疑时 `rm -rf dist && pnpm build[:internal]` 再 `npx cap sync android`。
- 不在 CI 里构建 APK、不上传 keystore（这条永远不变）。
