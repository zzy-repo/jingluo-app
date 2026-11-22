# 发布流程手册：从构建、签名、验证到发布到 GitHub 与公网

> 本文同时是 GitHub issue「[发布流程] 从构建、签名、验证到发布到 GitHub 与公网（发布控制台 ra.rose7.cn）完整手册」的正文，仓库副本：[docs/release/HOWTO-RELEASE.md](https://github.com/zzy-repo/deepseek-app/blob/main/docs/release/HOWTO-RELEASE.md)。**发布控制台入口：https://ra.rose7.cn** 。凭据与解密口令在该 issue 的「凭据」评论里，不在本文。

## 我只想发布一个版本，最短路径

1. 从 issue「凭据」评论拿口令：`export RELEASE_SECRETS_PASSPHRASE='<口令>'`（不要写进任何文件）。
2. 定版本：`package.json` 的 `version` 与 `androidVersionCode` 必须**严格大于**已发布最大值（截至 2026-11-22 是 1.4.19 / versionCode 38），并在 `CHANGELOG.md` 写 `## <version>` 段。
3. 在构建机 `/root/wt-release`（Node 24、JDK 21、`ANDROID_HOME=/root/android-sdk`）跑：`node scripts/release-howto.mjs --last-code 38`。它依次做：核对环境、解密签名材料、构建、六件套校验、打印产物名与 sha256。它**不上传、不发布**。
4. 把 APK 与 meta 传到控制台「待发布」（对 dl / 62 零影响）：见 §9 的 `curl`。
5. 浏览器打开 **https://ra.rose7.cn**，点「发布」，输入确认串 `PROD ok <version>-<sha前8位>`，再输入操作员口令。一次点击同时写 dl 与 62（62 约 15 秒内自己跟上）。
6. 按 §12 核对公网清单；GitHub Release 另走 §8（draft → 上传 → 下载回来比 sha256 → 转正式）。

> 🔴 **铁律：签名证书 SHA-256 必须是 `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`（= `config/appIdentity.json` 的 `expectedCertSha256`）。证书不一致的包一律不装上去、不上传、不发布，Android 不允许覆盖升级。**
> 🔴 **versionCode 必须严格递增，不得与任何已发布包重复。**
> 🔴 **只走控制台发布。不手工改 `/var/www/dl`，不用 `release:upload`（旧的直传公网路径）。**

---

## 1. 真实签名事实（2026-11-22 在本机实测）

| 项 | 值 |
| --- | --- |
| 发布实际使用的 keystore | `/root/.android/debug.keystore`（PKCS12，别名 `androiddebugkey`） |
| 它是不是 debug keystore | **是**。就是 AGP 默认的 debug key（证书 DN：`C=US, O=Android, CN=Android Debug`）。历史上所有已发布包都是它签的 |
| 证书 SHA-256 | `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1` |
| 是否等于 `expectedCertSha256` | **是**，逐字相同 |
| 现在 release 的 `keystore.properties` | `/root/wt-release/android/keystore/keystore.properties`，四个 `*Release` 键齐全，`storeFileRelease=/root/.android/debug.keystore` |
| 用它签出的 1.4.19 APK | `apksigner verify --print-certs` 的 `Signer #1 certificate SHA-256 digest` 为上面那串；`verify-release-apk` 第 4 项 PASS |

历史包袱（`android/app/build.gradle` 的注释里也写了）：gradle 里 `signingConfig` 的路径过去写成 `rootProject.file("../keystore/...")`，指向一个从不存在的目录，所以配置文件从没生效，已发布包全由 AGP 的默认 debug key 签。现在路径已改对（`android/keystore/keystore.properties`），并加了指纹闸门：证书与 `expectedCertSha256` 不符时 `assembleRelease` 直接失败。**不要改 `expectedCertSha256` 去迁就某个 keystore，要换 keystore。**

本机所有 keystore 文件（按内容 sha256 前 8 位归类）：

| 文件 | 内容 sha256 前 8 位 | 用途 |
| --- | --- | --- |
| `/root/.android/debug.keystore` | `ba42ced8` | **发布用**（证书 `e7c5baee…`） |
| `/root/keystore-backup/debug-default-e7c5baee/debug.keystore`、`/root/handoff/debug.keystore`、`/root/handoff/keystore/debug.keystore`、`/root/wt-import-followup/android/keystore/debug.keystore` | `ba42ced8` | 上面那把的字节级副本，同证书，可用 |
| `/root/deepseek-app/android/keystore/release.keystore` 及 `wt-146`、`wt-consumebase`、`wt-rebuild-145`、`client-repo-backup-20261120` 里的同名文件 | `6080c568` | `build-apk.sh` 自动生成的自签 keystore，**证书不是 `e7c5baee…`，禁止用于发布**（口令与发布 keystore 不同，本手册的口令打不开它） |
| 上述各目录里的 `debug.keystore`（`587dfe29`）、`/root/wt-536/android/keystore/*`（`6c1c5640`、`e2f433f7`） | 同左 | 同上：`build-apk.sh` 生成的另一批，非发布证书 |

怎么自己再核一遍：

```bash
export PATH=/opt/node24/bin:$PATH
keytool -list -v -keystore /root/.android/debug.keystore -storepass '<storePasswordRelease>' | grep SHA256
/root/android-sdk/build-tools/36.0.0/apksigner verify --print-certs <APK> | grep 'SHA-256 digest'
node scripts/check-keystore-config.mjs        # 形状 + 指纹，读 android/keystore/keystore.properties
```

---

## 2. 构建环境

| 项 | 取值 |
| --- | --- |
| 构建目录 | `/root/wt-release`（一台机器、一个目录，不要并行建） |
| Node | `export PATH=/opt/node24/bin:$PATH`（v24.22.0；系统自带 `/usr/bin/node` 是 v22.23.4，也满足 ≥ 22） |
| pnpm | `/usr/local/bin/pnpm` |
| JDK | 21（`/usr/bin/java`，`openjdk 21.0.13.1`），`build-apk.sh` 的 `REQUIRED_JAVA_MAJOR` 默认也是 21 |
| Android SDK | `export ANDROID_HOME=/root/android-sdk`；build-tools 有 `35.0.0` 与 `36.0.0`，`build.env.example` 钉的是 `35.0.0` |
| 内存 | `export NODE_OPTIONS=--max-old-space-size=1536` |
| 并发 | 一次只跑一个重任务；构建完 `cd android && ./gradlew --stop` |

构建三步（本机 1.4.19 就是这样出的，产物 2026-11-22 15:51）：

```bash
cd /root/wt-release
export PATH=/opt/node24/bin:$PATH ANDROID_HOME=/root/android-sdk NODE_OPTIONS=--max-old-space-size=1536
pnpm build
npx cap sync android
cd android && ./gradlew assembleRelease --no-daemon --max-workers=1
./gradlew --stop
```

- APK 输出：`/root/wt-release/android/app/build/outputs/apk/release/app-release.apk`。
- **`cap sync` 会改 `android/capacitor.settings.gradle`**（把 `node_modules` 路径写成本机形态，实测 `/root/wt-release` 里现在就带着一处 `../../wt-697/...` 的改动）。发完要还原：`git checkout -- android/capacitor.settings.gradle`，不要提交。
- 必须 `assembleRelease`，不要 `assembleDebug`（debug 包带 `android:debuggable="true"`，见 Issue #60）。
- `android/keystore/keystore.properties.example` 是 `keystore.properties` 的样例，四个键名必须带 `Release` 后缀；相对路径按 `android/app/` 解析，用绝对路径最稳。`check-keystore-config.mjs` 就是它的形状门禁。
- `build-apk.sh`（仓库根）是另一条出包路径：缺 `keystore.properties` 时会**自动生成**自签 keystore，证书不对。**发布不要用它**，用上面的三步。
- 以上构建命令本次交接我没有重跑（不构建、不发布），依据是 `/root/wt-release` 里已有的 1.4.19 产物与其校验结果（见 §7）。

---

## 3. 版本号规则

- `package.json` 的 `version`（→ versionName）与 `androidVersionCode`（→ versionCode）是唯一来源。
- **versionCode 必须严格递增，且不与任何已发布包相同**。服务端不查重，设备会把同码的新包当成旧包。事故：2.0.0、1.4.15、1.4.16 三个包曾用同一个 versionCode。
- 查已发布最大值（只读，下面是 2026-11-22 的实测输出）：

```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
gh api "repos/zzy-repo/deepseek-app/releases?per_page=30" \
  --jq '.[]|select(.draft==false)|"\(.tag_name)\t\(.prerelease)\t\(.body|capture("versionCode[^0-9]{0,8}(?<c>[0-9]+)")?.c // "?")"' | head -8
# v1.4.19  true   38
# v1.4.18  true   37
# v1.4.17  true   36
# v1.4.16  false  35
# v1.4.15  false  34
# v1.4.14  false  33
```

  也要看公网清单（目前冻结在 1.4.1 / versionCode 20，见 §11）和控制台「待发布」「已发布」两栏。取三处最大值，新包的 versionCode 必须比它大。
- 产物名：`node scripts/artifact-name.mjs --version 1.4.19` 输出 `jingluo-chat-1.4.19.apk`（前缀来自 `config/appIdentity.json` 的 `artifactPrefix`，别手抄）。
- 应用显示名「鲸落」、包名 `com.example.deepseekchat` 不能改。
- 版本号规划先定，再动手。2.0.0 的教训：它在 versionCode 和内容上都与 1.4.x 冲突，发出去后被撤销。dl 服务器上还留着当时的备份 `/var/www/dl/releases.json.bak-live2.0-20261122T024044Z`（只读核实到文件存在；这段事故经过本仓库的文档与 CHANGELOG 里没有记录，细节**未核实**）。
- ⚠️ **实测发现**：仓库 main（以及 `v1.4.14`～`v1.4.19` 六个 tag 指向的 commit）里 `package.json` 都还是 `1.4.14 / 33`。1.4.19 是在 `/root/wt-release` 里**未提交**地改成 `1.4.19 / 38` 后构建的，`CHANGELOG.md` 也没有 `## 1.4.19` 段，所以对它跑 `release-check --tag v1.4.19` 会在第 2 项 FAIL（见 §7）。以后先 bump 并合入 main，再构建、再打 tag。

---

## 4. 版本号之外的发布前检查清单（脚本替你做的那部分）

`scripts/release-howto.mjs` 的前置检查（任何一步失败就停，exit 1）：

1. Node ≥ 22、JDK 21、`keytool`、`ANDROID_HOME` 下有带 `apksigner` 的 build-tools、没有另一个发布构建在跑。
2. `package.json` 版本格式合法、`androidVersionCode` > `--last-code`、`CHANGELOG.md` 有对应段。
3. 签名材料：没有 `android/keystore/keystore.properties` 时，用 `RELEASE_SECRETS_PASSPHRASE`（或终端提示）解密 `release-secrets/release-secrets.tar.enc`；之后跑 `check-keystore-config.mjs`，证书指纹必须等于 `expectedCertSha256`。
4. 构建（见 §2）。
5. 六项校验 + debuggable + release-check（见 §7）。
6. 打印产物名、sha256、大小，提示下一步。

---

## 5. 取凭据（解密包）

```bash
cd /root/wt-release                     # 或任何干净的 clone
git pull --ff-only
export RELEASE_SECRETS_PASSPHRASE='<issue「凭据」评论里的口令>'
mkdir -p /tmp/rs && chmod 700 /tmp/rs
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:RELEASE_SECRETS_PASSPHRASE \
  -in release-secrets/release-secrets.tar.enc | tar -x -C /tmp/rs
ls -R /tmp/rs
```

解出：

```
release-secrets/
  README.txt
  android-keystore/published.keystore     发布证书（= /root/.android/debug.keystore，证书 e7c5baee…）
  android-keystore/keystore.properties    四个 *Release 键；storeFileRelease 是占位，需改成 published.keystore 的绝对路径
  dl-console.env                          UPLOAD_TOKEN / OPERATOR_PIN / DOWNLOAD_SECRET / PROD_MODE / ARTIFACT_PREFIX
```

用完删：`rm -rf /tmp/rs`。`release-howto.mjs` 会自己解到 `build/release-secrets/`（`build/` 已被 `.gitignore` 忽略）。

---

## 6. 构建（见 §2）与 CHANGELOG

`CHANGELOG.md` 的 `## <version>` 段既是 Release 正文的来源，也是控制台 `meta.changes` 的来源。写用户能看懂的变化，不要写内部术语。

---

## 7. 发布前校验

```bash
export PATH=/opt/node24/bin:$PATH
APK=/root/wt-release/android/app/build/outputs/apk/release/app-release.apk
node scripts/verify-release-apk.mjs "$APK"          # 六项，退出码 0 才算过
node scripts/check-apk-debuggable.mjs "$APK"
node scripts/release-check.mjs --apk "$APK" --tag v<version>
/root/android-sdk/build-tools/36.0.0/aapt2 dump badging "$APK" | grep '^package'   # 包内 versionName / versionCode
sha256sum "$APK"
```

`verify-release-apk` 六项及失败含义（1.4.19 实测 6/6 PASS）：

| # | 项 | 失败意味着 |
| --- | --- | --- |
| 1 | `debuggable` 不存在或 false | 出了 debug 包，任何开了 adb 的机器都能读私有数据。重新 `assembleRelease` |
| 2 | `ARTIFACT_VARIANT` 与期望一致（默认 `standard`） | web 构建与 gradle 变体不同源（`pnpm build` ↔ standard，`build:internal` ↔ internal）。自动更新会推错包 |
| 3 | `LOOPBACK_CONSUME` 不存在或 false | 包里 consume/pay/migration 的地址是回环，只能本地联调 |
| 4 | 签名证书 SHA-256 与期望一致 | **用错 keystore**。换 keystore，不许改期望值 |
| 5 | `INSECURE_CONSUME` 不存在或 false | 这是 staging 明文联调包；真要发联调包要显式 `--allow-insecure` 并按测试版处理 |
| 6 | 包内 `consume.baseUrl` 与 `config/endpoints.json` 逐字一致 | 地址配置与包不同步，重新构建 |

任何一项不过，不许上传。`check-apk-debuggable.mjs` 判不出来也是 exit 2，同样禁止发布。

---

## 8. GitHub Release 流程

仓库是私有的。下面每一步的原因都来自真实事故。

```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
V=1.4.20; APK=jingluo-chat-$V.apk
# 1) 先建 draft（REST，布尔值必须用 -F，-f 会把 true 当字符串 → 422）
gh api -X POST repos/zzy-repo/deepseek-app/releases \
  -f tag_name=v$V -f name="jingluo-chat $V" -F body=@/tmp/notes-$V.md \
  -F draft=true -F prerelease=false --jq '.id'
# 2) 上传资产
gh release upload v$V "$APK" --repo zzy-repo/deepseek-app
# 3) 下载回来重算 sha256：curl 直取私有仓库资产只会得到 9 字节 "Not Found"
gh release download v$V --repo zzy-repo/deepseek-app --pattern '*.apk' --dir /tmp/gh-$V --clobber
sha256sum /tmp/gh-$V/*.apk          # 必须等于本地 APK 的 sha256
# 4) 转正式（也可以直接用 REST PATCH draft=false）
gh release edit v$V --repo zzy-repo/deepseek-app --draft=false
# 5) 核对
gh api repos/zzy-repo/deepseek-app/releases/latest --jq .tag_name
```

- 本次我实际跑过的只有只读的第 3 步和第 5 步（对 v1.4.19：下载回来 sha256 为 `af648ea6…a5e4`，与构建产物一致；`curl -L` 直取资产 URL 返回 9 字节 `Not Found`）。建 draft、上传、转正式是写操作，**未核实**。
- 开 PR 与合并一律走 REST：`gh pr create` 在本仓库报权限错。`gh api -X POST repos/zzy-repo/deepseek-app/pulls -f title=… -f head=… -f base=main -F body=@file`，等 `mergeable` 为 true 后 `gh api -X PUT repos/zzy-repo/deepseek-app/pulls/<n>/merge -f merge_method=squash --jq .sha`。
- **`prerelease=true` 的 Release 不会成为 `releases/latest`**。核对：现在 `releases/latest` 是 `v1.4.16`（正式版），而 v1.4.17、v1.4.18、v1.4.19 都是 prerelease。
- **带「后端新错误码生产未上线」依赖的版本必须设为 prerelease**，并在正文最前面写「仅供测试，不要推给用户」（v1.4.19 正是这样做的）。
- 正文模板（参照 v1.4.19）：元信息表（versionName / versionCode / 文件名 / 大小 / SHA-256 / MD5）、「本版相对上一版的变化」（带 issue 链接，**诚实标注「已完成」「部分完成」「只有单测、未真实验证」**）、「沿用」「仍在等后端」、「运行配置（公开部分）」、验收（verify 结果）。
- **正文禁止出现**内网 IP、端口、`/var/www`、`releases.json`、`primaryBase`、token。发布前自检：

```bash
grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|:[0-9]{4,5}|/var/www|releases\.json|primaryBase|[Tt]oken|X-Upload' /tmp/notes-$V.md && echo "有违规，别发" || echo "干净"
```

---

## 9. 公网分发：通过发布控制台 https://ra.rose7.cn

控制台是 aliyun 上的 `dl-console`（`/opt/dl-console/server.mjs`，systemd 单元 `dl-console`，环境文件 `/etc/default/dl-console`，权限 600）。服务绑 aliyun 的 Tailscale 地址，公网经 Caddy 的 `ra.rose7.cn` 反代。

### 9.1 它是什么、不是什么

- 上传只进「待发布」(staging)，**对 dl / 62 零影响**。
- 发布是**人工一次点击**，一次写入全部目标：`prod-dl` = aliyun 的 `/var/www/dl`（对外 https://dl.rose7.cn ）；`prod-62` = 62.106.70.167，**控制台不推送**，由 62 上的 `dl-mirror.timer` 每 15 秒自己拉取 dl（只同步 `releases.json` 与 `apk/`），跨境抖动时最坏约 1 分钟。结果里 `prod-62` 记为 `pending-mirror`。
- 任一目标失败自动回滚；同一个 id 再发布返回 409；**没有「重发」**；已发布归档只读。
- **控制台不检查 APK 内容**（不验签名、不验 debuggable）。它只算 sha256。所以 §7 的校验必须在上传前自己做。

### 9.2 实测：控制台可用（2026-11-22 16:25 实测）

```
$ curl -x http://127.0.0.1:7890 --max-time 15 https://ra.rose7.cn/healthz
{"ok":true,"ts":"2026-11-22T08:25:31.612Z","pid":3024510,"prodMode":"live","targets":{"prod-dl":"/var/www/dl","prod-62":"62.106.70.167:/var/www/dl (pull-mirror ≤15s)"},"gate":{"uploadToken":true,"operatorPin":true}}
$ curl -x http://127.0.0.1:7890 --max-time 15 https://ra.rose7.cn/api/releases
{"pending":[],"published":[]}
```

`prodMode:"live"`：点发布真的会写 `/var/www/dl`。

### 9.3 上传：`POST /api/releases`

multipart，字段 `apk`（文件）、`meta`（JSON 文件，可选，也可以直接用普通表单字段），请求头 `X-Upload-Token`。**本次交接没有上传任何包，下面的 curl 是按 `server.mjs` 的代码写的，未实测。**

```bash
export UPLOAD_TOKEN='<解密包 dl-console.env 里的值>'
cat > /tmp/meta.json <<'EOF'
{
  "version": "1.4.20",
  "versionCode": 39,
  "buildType": "stable",
  "artifactVariant": "standard",
  "changes": ["一句话用户可见变化", "…"],
  "issues": [839, 842],
  "breaking": false
}
EOF
curl -x http://127.0.0.1:7890 --max-time 300 -sS \
  -H "X-Upload-Token: $UPLOAD_TOKEN" \
  -F apk=@/root/wt-release/build/release/jingluo-chat-1.4.20.apk \
  -F meta=@/tmp/meta.json \
  https://ra.rose7.cn/api/releases
# 201: {"id":"<时间戳>-<sha前8>","sha256":"…","size":…,"version":"1.4.20","versionCode":39,"state":"pending"}
```

字段取值（以 `server.mjs` 为准）：

| 字段 | 规则 |
| --- | --- |
| `version` | 必填，`^[0-9A-Za-z.\-]{1,40}$` |
| `versionCode` | 必填，正整数。**服务端不查重**，自己保证递增 |
| `buildType` | 只能是 `stable` 或 `prerelease`，别的值返回 400；**缺省为 `prerelease`**。写 `release` / `debug` 若进了清单，客户端 `parseManifest` 会把**整份清单**当作不可信而拒收（fail-closed） |
| `artifactVariant` | 服务端**只校验格式**（`^[a-z0-9][a-z0-9._-]{0,31}$`，忽略大小写），格式不对或缺省就改成 `standard`，**没有白名单**，写 `internal` / `seam` 都会被原样写进公网清单。公网清单口径只允许 `standard`：`internal` 会被校验器判 FAIL，还会泄露内测包直链（#601）。所以公网发布只传 `standard`，内测包不要走控制台 |
| `releasedAt` | **你传了也没用**：服务端把它设为上传时刻，发布时换算成 `YYYY-MM-DDTHH:mm:ss+08:00` 再写入清单。不需要自己拼 |
| `changes` | 字符串数组（也接受换行分隔的字符串） |
| `issues` | 数组（也接受逗号分隔的字符串） |
| `breaking` | 服务端写入清单时固定为 `false`，传值无效 |
| `sha256` | 可不传；传了必须等于服务端实算值，否则 400。服务端自己算 sha256 |

### 9.4 发布：人点一次

1. 打开 **https://ra.rose7.cn**，在「待发布」里找到你的 id。可以先用测试下载链接发给同事试装（§9.6）。
2. 点「发布」。确认串：`PROD_MODE=live` 时是 **`PROD ok <version>-<sha前8位>`**（现在就是 live）；`shadow` 时是 `<version>-<sha前8位>`。确认串只防误点。
3. 输入操作员口令（`OPERATOR_PIN`，是真正的闸）。同一来源 IP 在 5 分钟内口令错满 10 次就会被临时锁定（429）。
4. 成功后条目移入只读归档。同 id 再发布 409。

等价的 API（人用，不要放进自动化）：`POST /api/publish/<id>`，JSON `{"confirm":"PROD ok <version>-<sha8>","pin":"<口令>"}`；**带 `site` 字段会 400**（已废弃）。

### 9.5 删除待发布项

`DELETE /api/releases/<id>`，JSON body `{"pin":"<口令>"}`。只能删「待发布」，已发布的不能删。

### 9.6 测试下载链接

`https://ra.rose7.cn/d/<id>/apk?t=<token>`，`token` = `sha256(DOWNLOAD_SECRET + ':' + id)` 的**前 16 位十六进制**（`server.mjs` 的 `dlTokenOk`）。

```bash
printf %s "$DOWNLOAD_SECRET:$ID" | sha256sum | cut -c1-16
```

实测：用这个公式算出的 token 访问一个不存在的 id 得 404（token 通过、文件不存在），随便写的 token 得 403。

---

## 10. 回滚

发布时控制台先备份、再原子写入、再回读校验，失败自动回滚。发布**成功之后**才发现不对，要人手回滚。

- 备份位置（aliyun）：`/opt/dl-console/backups/<UTC时间戳>/prod-dl/{manifest.bak,apk.bak}`；另在 `/var/www/dl/` 里留一份 `releases.json.bak-<UTC时间戳>`。`apk.bak` 只在被覆盖了同名 APK 时才有。`audit.log`（`/opt/dl-console/audit.log`）里 `publish` 记录能查到时间戳。
- 回滚命令（**以下是读代码得出的做法，未实测，我没有碰线上**）：

```bash
ssh -i ~/.ssh/aliyun_macos.pem aliyun
TS=<备份时间戳>
cp -a /var/www/dl/releases.json /var/www/dl/releases.json.before-rollback-$(date +%Y%m%dT%H%M%S)
cp /opt/dl-console/backups/$TS/prod-dl/manifest.bak /var/www/dl/releases.json
rm /var/www/dl/apk/jingluo-chat-<错误版本>.apk       # 先确认这个文件是本次新增的，不是历史包
curl -s https://dl.rose7.cn/releases.json | head -c 200     # 核对 latest 回到上一版
```

- 62 会在约 15 秒内自动跟回，不需要动它。
- 回滚后，同一个 id 仍是「已发布」，不能重发。修好之后要**重新上传一份**（得到新 id）再发布。
- Caddy：aliyun 上是 `caddy-alidns.service`，**只能 `reload`，不能 `restart`**（restart 会断所有站点）。改 Caddyfile 前先备份并校验：

```bash
cp -a /opt/caddy/Caddyfile /opt/caddy/Caddyfile.bak-$(date +%Y%m%dT%H%M%S)
set -a; . /opt/caddy/caddy.env; set +a
/opt/caddy/caddy-alidns validate --config /opt/caddy/Caddyfile --adapter caddyfile   # 实测输出 "Valid configuration"
systemctl reload caddy-alidns
```

- 改 `server.mjs` 前备份，改完先 `node --check /opt/dl-console/server.mjs`，通过再 `systemctl restart dl-console`（曾因此弄挂过服务）。

---

## 11. 客户端契约（改清单字段前必读）

- 清单位置：`https://dl.rose7.cn/releases.json`（aliyun `/var/www/dl/releases.json`）与 62 镜像站（`http://62.106.70.167:8888/`，路径同样是 `/releases.json`）。2026-11-22 实测两处都是 `latest = 1.4.1`、共 11 条，versionCode 最大 20。
- ⚠️ **与仓库现有文档的冲突，需要维护者确认**：`docs/RELEASE-MANUAL.md` 写的是「正式发布 = GitHub Release，dl 公网清单冻结」（裁决 #614）。而这次交接要求公网分发走控制台。**一旦在控制台点发布，公网 `releases.json` 就不再冻结**，已装客户端按清单做自动更新，所以只发布你确实想推给用户的版本；带「后端未上线依赖」的测试版不要发布到 `stable`。
- 客户端解析：`src/services/updateManifest.ts` 的 `parseManifest` 是 fail-closed：一条不合法的条目（如非法 `buildType`）会让整份清单被拒收。条目字段：`version / versionCode / releasedAt / file / size / md5 / sha256 / changes / issues / buildType / artifactVariant / artifactVariantSource / breaking`。
- 离线校验器：`node scripts/validate-releases-manifest.mjs <清单>`。对线上现网清单实测：`FAIL=0`，另有 20 条 warning（老条目缺 `artifactVariant`，客户端不会自动更新到它们）。
- 控制台写入的条目：`file = apk/jingluo-chat-<version>.apk`，`artifactVariantSource = apk-manifest`，清单最多保留 50 条。

---

## 12. 发布后核对

```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
# dl 清单已更新
curl -sS https://dl.rose7.cn/releases.json -o /tmp/dl.json
node scripts/validate-releases-manifest.mjs /tmp/dl.json
python3 -c "import json;m=json.load(open('/tmp/dl.json'));print(m['latest'],m['releases'][0]['sha256'])"
# 62 在 ≤15 秒（最坏约 1 分钟）内跟上
curl -sS --max-time 15 "http://62.106.70.167:8888/releases.json" | python3 -c "import json,sys;m=json.load(sys.stdin);print(m['latest'])"
# 公网下载件 sha256 与本地一致
curl -sS -o /tmp/dl.apk https://dl.rose7.cn/apk/jingluo-chat-<version>.apk && sha256sum /tmp/dl.apk
# GitHub Release 资产（§8 第 3 步）
```

控制台页面「已发布」栏应出现该版本，目标列里有 `prod-dl` 与 `prod-62`。

---

## 13. 通知

用各自的渠道通知。**不要把维护者个人的 Bark key 写进仓库、issue 或本文。** Bark 经本机代理会超时，需要直连（来自交接说明，未复测）。

---

## 14. 踩坑清单（都是真实发生过的）

| 坑 | 一句话 | 怎么避免 |
| --- | --- | --- |
| versionCode 重复 | 2.0.0 / 1.4.15 / 1.4.16 同 versionCode，设备把新包当旧包 | 上传前查 GitHub、dl、控制台三处最大值；脚本 `--last-code` 强制比较 |
| `buildType` 非法值 | 写成 `release` / `debug` 会让整份清单被客户端拒收 | 只写 `stable` / `prerelease`；控制台会 400，但直传路径不会 |
| keystore 路径写错 | 历史上 gradle 路径指向不存在的目录，已发布包全由默认 debug key 签 | 路径已修正；`check-keystore-config.mjs` + gradle 指纹闸门；不要改 `expectedCertSha256` |
| `gh pr create` 权限错 | 本仓库此命令报权限错 | 一律 REST：`gh api -X POST …/pulls`，`-X PUT …/merge` |
| `gh api -f/-F` 变 POST | 只读调用带了 `-f`/`-F`，自动变成 POST，误发了一次创建（上个子代理的亲身教训） | 只读调用不带 `-f`/`-F`，参数拼进 URL；写调用明写 `-X POST`。我接手时核对过 PR 列表，没有垃圾 PR（最新的 #862 是别人的正常 PR） |
| 布尔值 `-f` vs `-F` | `-f draft=true` 发的是字符串，422 | 布尔和数字用 `-F`，字符串用 `-f` |
| curl 取私有 release 资产 | 得到 9 字节 `Not Found` | `gh release download`（本次实测 9 字节复现） |
| 改 `server.mjs` | 语法错重启后服务起不来 | 先 `node --check`，再 `systemctl restart dl-console` |
| `pkill -f` | 匹配到自己的 shell 命令行，把自己杀了 | 用 `pgrep` 取 pid 再 `kill <pid>`，或 `pkill -x` |
| `cap sync` 改文件 | 改 `android/capacitor.settings.gradle`，不还原会被提交 | 发完 `git checkout -- android/capacitor.settings.gradle`；`release-howto.mjs` 在它原本干净时会自动还原 |
| 并行重构建 | 机器内存小，两个构建互相拖死 | 一次只跑一个；`NODE_OPTIONS=--max-old-space-size=1536`；构建后 `./gradlew --stop`；脚本有锁 |
| Release 正文泄露内网地址 | 正文被用户看到 | §8 的自检 grep |
| 后端未上线却发 stable | #840 / #839 依赖的新错误码生产没上 | 必须 prerelease，正文最前写「仅供测试」 |
| Bark 经代理超时 | 通知发不出 | 直连，别走 7890 代理 |
| `git stash` | 共享 clone 里 stash 栈共享，会取走别人的改动 | 禁用；备份用 `cp -a` 或 `git diff > /tmp/x.patch` |
| 2.0.0 | 与 1.4.x 在 versionCode 和内容上都冲突，被撤销 | 版本号规划先定，再开发、再发布 |
| 控制台不做 `artifactVariant` 白名单 | `internal` 这类值会原样进公网清单 | 只传 `standard`；内测包不走控制台 |
| `CHANGELOG` 缺段 | 1.4.19 没有对应段，`release-check` 判 FAIL | 先写 CHANGELOG 再出包 |

---

## 15. 一键脚本：`scripts/release-howto.mjs`

```bash
node scripts/release-howto.mjs --help
node scripts/release-howto.mjs --dry-run                      # 只读，打印将做什么
node scripts/release-howto.mjs --last-code 38                 # 真跑：环境→凭据→构建→校验→产物名
node scripts/release-howto.mjs --last-code 38 --skip-build --apk <path>   # 只校验现成 APK
```

- **不执行发布、不上传、不写线上、不建 GitHub Release、不打 tag。** 最后一步只打印下一步该做什么。
- 口令不写在脚本里：环境变量 `RELEASE_SECRETS_PASSPHRASE`，或在终端提示输入（openssl 自己读）。
- 退出码：0 通过 / 1 某步失败 / 2 用法错误。
- 单测（不碰网络）：`node --test tests/unit/release-howto-preflight.test.mjs`。每条正向用例都有负向对照（versionCode 相等必须红、证书不一致必须红、缺键必须红等）。
- 真跑一次完整构建我没有做；`--dry-run` 与单测实测通过，输出见 PR 描述。

---

## 16. 接手清单：第一次发布按顺序做

```bash
# 0) 工具与代理
export PATH=/opt/node24/bin:$PATH ANDROID_HOME=/root/android-sdk NODE_OPTIONS=--max-old-space-size=1536
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
gh auth status                                          # 应显示 zzy-repo，仓库权限 admin
# 1) 控制台活着
curl -x http://127.0.0.1:7890 --max-time 15 -sS https://ra.rose7.cn/healthz
# 2) 拿最新 main，确认没有别人的构建在跑
cd /root/wt-release && git status --short && git pull --ff-only
# 3) 定版本（改 package.json 的 version 与 androidVersionCode，写 CHANGELOG 段，走 PR 合入）
# 4) 只读预演
node scripts/release-howto.mjs --dry-run
# 5) 真跑（口令来自 issue「凭据」评论）
export RELEASE_SECRETS_PASSPHRASE='<口令>'
node scripts/release-howto.mjs --last-code <已发布最大 versionCode>
# 6) 上传到控制台待发布（§9.3），打开 https://ra.rose7.cn 点发布（§9.4）
# 7) 发完核对（§12），GitHub Release（§8），还原 capacitor.settings.gradle
git checkout -- android/capacitor.settings.gradle
```

谁有什么权限：

| 对象 | 凭什么访问 | 能做什么 |
| --- | --- | --- |
| GitHub 仓库 `zzy-repo/deepseek-app`（私有） | 本机 `gh` 已登录 `zzy-repo`（admin / push） | 读写代码、issue、PR、Release。开 PR 与合并走 REST |
| aliyun（发布控制台、Caddy、dl） | `ssh -i ~/.ssh/aliyun_macos.pem root@aliyun`（`/root/.ssh/config` 里 `Host aliyun`） | root。控制台目录 `/opt/dl-console`，凭据文件 `/etc/default/dl-console`，Caddy `/opt/caddy` |
| 发布控制台 `https://ra.rose7.cn` | `UPLOAD_TOKEN`（上传）、`OPERATOR_PIN`（发布 / 删除）、`DOWNLOAD_SECRET`（测试下载链接） | 上传只进待发布；发布与删除要口令。三者都在加密包里与 issue「凭据」评论里 |
| 62 节点 `62.106.70.167` | `ssh -i ~/.ssh/shiro.pem -o IdentitiesOnly=yes root@62.106.70.167`（**`/root/.ssh/config` 里的 `Host shiro` 指向 150.158.54.163，是另一台机器，别混**） | root。上面跑 `dl-mirror.timer`（每 15 秒拉取 dl）。**只读查看即可，不要手改 `/var/www/dl`** |
| Caddy（aliyun） | 同 aliyun SSH | 只能 `reload`，不能 `restart`；改前备份并 `validate` |
| 签名 keystore | 加密包 `release-secrets/release-secrets.tar.enc` + 口令 | 签发布包。口令来自 issue「凭据」评论 |

私钥内容不在本文，也不要贴进任何地方。

---

## 17. 本次交接我没核实的、以及与交接说明不一致的

不一致：

- 交接说明说发布 keystore 是「某个 release keystore」。实测是 `/root/.android/debug.keystore`，即 debug keystore，但它**就是**已发布证书（见 §1）。
- 交接说明说 `meta` 里 `releasedAt` 必须带 `+08:00`。实测控制台忽略传入的 `releasedAt`，服务端自己生成并换算成 `+08:00`。`breaking` 同样被固定为 `false`。
- 交接说明说 `artifactVariant` ∈ {standard, internal, seam}。实测服务端不做白名单，只校验格式，格式合法的值（含 `internal`）会原样写入公网清单，而公网口径只允许 `standard`。
- 交接说明说控制台写「全部目标」。实测只有 `prod-dl` 是直接写入，`prod-62` 是 62 自己拉取（`pending-mirror`）。
- `/var/www/dl/releases.json` 现在只有 1.4.1（versionCode 20）。1.4.16 之后的版本都只在 GitHub Release，没有发到 dl（见 §11 的冲突）。
- 仓库 main 与六个 tag 的 `package.json` 都是 `1.4.14 / 33`，见 §3。

未核实：

- 构建命令本次没重跑；`gh release create/upload/edit`、控制台 `POST /api/releases`、`POST /api/publish/<id>`、回滚命令均未执行（不允许写线上）。
- 2.0.0 事故的细节与撤销经过。
- Bark 经代理超时。
- `docs/RELEASE-MANUAL.md` 与 `RELEASE-CHECKLIST.md` 中仍有「dl 冻结」「release:upload」的旧描述，本文没有改它们，只在 `RELEASE-MANUAL.md` 顶部加了指向本文的一行。
