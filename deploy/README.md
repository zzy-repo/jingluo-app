# deploy/ — 线上组件的代码与配置（随仓库版本化）

这里放的是**线上实际运行的**代码与配置，避免「只存在于 ECS 上、仓库里没有」的情况。
当前只有 dl-release（dl.rose7.cn APK 发布接口）。

```
deploy/dl-release/
├── server.mjs                        # 发布接口（Node 单文件，零依赖）
├── variant.mjs                       # 构建变体判定（纯函数，可单测）
├── dl-release.service                # systemd 单元
├── caddy-dl-api.conf                 # Caddy 反代片段（粘进已有 handle @dl 块）
├── artifact-variants.json.example     # 变体白名单格式（历史包补救通道）
├── fixtures/                         # releases.json 样例（含各反例）
└── test/
    ├── variant.test.mjs              # node --test 单测
    ├── offline-check.sh              # 真 APK 打真服务端的离线端到端
    └── xmltree-fixtures/             # 真实 aapt2 输出样本
```

## 一次性准备（ECS）

```bash
# 1) aapt2（ECS 上没有 Android SDK，从 Google Maven 取预编译二进制）
mkdir -p /opt/dl-release/bin
V=9.5.1-16666295
curl -sS -o /tmp/aapt2.jar \
  "https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/$V/aapt2-$V-linux.jar"
python3 -c 'import zipfile;zipfile.ZipFile("/tmp/aapt2.jar").extract("aapt2","/tmp")'
install -m 755 /tmp/aapt2 /opt/dl-release/bin/aapt2 && /opt/dl-release/bin/aapt2 version

# 2) 两枚令牌（600，root）—— #641：读令牌与发布令牌分开，互不包含
install -d -m 700 /etc/dl-release
#    读令牌：内测包里的那一枚（#622 构建期 DL_PRIVATE_TOKEN 取的就是它），只能读清单/下私有包
head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48 > /etc/dl-release/token
#    发布令牌：写端点专用，只在发布主机/脚本手里，绝不进客户端产物
openssl rand -hex 32 > /etc/dl-release/publish-token
chmod 600 /etc/dl-release/token /etc/dl-release/publish-token
chown root:root /etc/dl-release/token /etc/dl-release/publish-token
#    两枚必须不同值：同值 = 拆了等于没拆，服务会按「发布令牌未配置」处理（写端点全 401）

# 3) 变体白名单（可选，只给没标记的历史包用）
install -m 600 deploy/dl-release/artifact-variants.json.example /etc/dl-release/artifact-variants.json
```

## 部署代码

```bash
# 私有（internal）分发目录：webroot 之外，Caddy 的 file_server 够不着
#   #637 收敛：私有根**唯一** = /opt/dl-private（webroot 外），由 DL_PRIVATE_ROOT 覆盖
#   包在 /opt/dl-private/apk（DL_PRIVATE_APK_DIR）；清单在 /opt/dl-private/releases.internal.json（DL_PRIVATE_RELEASES_JSON）
ssh aliyun 'install -d -m 755 /opt/dl-private /opt/dl-private/apk'
scp deploy/dl-release/server.mjs deploy/dl-release/variant.mjs deploy/dl-release/apk-manifest.mjs \
    deploy/dl-release/release-target.mjs aliyun:/opt/dl-release/
# #836：产物文件名前缀的唯一来源。服务端不写死前缀，启动时按下面的顺序找这份配置：
#   env DL_APP_IDENTITY_FILE → <server.mjs>/../../config/appIdentity.json（整仓布局）→ /etc/dl-release/appIdentity.json
# 这台机器只有 4 个文件的部署布局，所以线上必须把配置放成 /etc/dl-release/appIdentity.json。
# 读不到 → 服务**不启动**（fatal_artifact_prefix），这是有意的：宁可接口缺席，也不要它自己猜个前缀
# 把新包写成老名字（那种错没人发现，直到有人按名字对账）。
scp config/appIdentity.json aliyun:/etc/dl-release/appIdentity.json
ssh aliyun 'chmod 644 /etc/dl-release/appIdentity.json'
scp deploy/dl-release/dl-release.service aliyun:/etc/systemd/system/dl-release.service
ssh aliyun 'node --check /opt/dl-release/server.mjs && systemctl daemon-reload && systemctl restart dl-release'
ssh aliyun 'systemctl is-active dl-release; journalctl -u dl-release -n 5 --no-pager'
```

> `server.mjs` 依赖同目录的 `variant.mjs` / `apk-manifest.mjs` / `release-target.mjs`，**四个文件一起传**
> （`release-target.mjs` 是 #620 的接口层变体闸），否则服务起不来。另外还依赖 `shared/build-types.mjs`
> 与 `shared/artifact-name.mjs`（线上在 `/shared/`，随首次部署一起放好的那两个文件）——
> 少任何一个都是**启动失败**而不是「跑起来但少个功能」。
> 服务启动时会核「私有根不在 webroot 内」，配错（比如把 `DL_PRIVATE_ROOT` 指到 `/var/www/dl/private`）
> 会直接拒绝启动并打 `fatal_private_root_in_webroot`。
> Caddy 片段见 `caddy-dl-api.conf`（粘进已有 `handle @dl` 内，validate → reload，禁止 restart）；
> 它反代 `/api/v1/release`（公网写）、`/api/v1/version`（#441）与 `/api/v1/releases/*`（#621 私有读）。
> **`/api/v1/release/private`（#620 私有写）不反代**：私有包发布走 `scripts/publish-private-apk.mjs` + `ssh`/`scp`
> 直接落盘，不出公网（线上实测公网发它 = 404）；只有本机 `127.0.0.1:8799` 能发。理由见 `docs/RELEASE-MANUAL.md` §14.1b。

## 本地验证（不碰线上）

```bash
node --check deploy/dl-release/server.mjs
# 54 条用例（变体解析 / APK debuggable / 服务端 buildType / 上传契约矩阵 / 版本端点 #441 /
# 接口层变体闸 #620），两种跑法等价：
node --test deploy/dl-release/test/*.test.mjs     # 或 pnpm run test:dl-release
node tests/run-layer.mjs server                   # 统一 runner（CI 的布局门禁就是实跑它的 --list 判孤儿）

# 清单结构 / 新字段契约
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/live-2026-11-18.json   # 公网口径
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/invalid-*.json          # 期望全 FAIL
# #609：私有清单是另一份文件、另一条口径（webroot 之外）——公网口径下 internal 条目必须 FAIL
node scripts/validate-releases-manifest.mjs --private deploy/dl-release/fixtures/private-valid-internal.json    # 期望 PASS
node scripts/validate-releases-manifest.mjs --private deploy/dl-release/fixtures/private-invalid-*.json         # 期望 FAIL

# webroot 卫生门禁（#609；R4 = 公网清单 internal 条目数必须为 0，#620）
node scripts/check-webroot-hygiene.mjs                       # 本机没有 /var/www/dl 时自动跑内置演练
DL_WEBROOT=/var/www/dl node scripts/check-webroot-hygiene.mjs  # 分发机上扫真 webroot

# 端到端（需要 aapt2 + 真 APK，会在 /tmp 起临时实例，不写线上任何文件）
# 样本要求：APK_STANDARD / APK_INTERNAL 必须**非 debuggable**（debuggable 包会被 Issue #60 的闸先拒，
# 用它验变体闸等于什么都没验）；APK_NO_MARKER 同理，缺合格样本时脚本打印 SKIP 原因而不是假绿。
AAPT2=/path/aapt2 \
APK_STANDARD=/path/jingluo-chat-1.4.0.apk \
APK_INTERNAL=/path/jingluo-chat-1.4.0-beta.10.apk \
APK_NO_MARKER=/path/no-marker-history.apk \
APK_DEBUGGABLE=/path/jingluo-chat-1.4.0-beta.8.apk \
bash deploy/dl-release/test/offline-check.sh
```

## 临时文件托管（fixture，不进清单）

给 App / 测试用的「真实 HTTPS 下载」样本文件，**不要**走发布接口：
`POST /api/v1/release` 每次都会写 `releases.json`（且强制包名、versionCode 递增、变体判定），
用它托管样本会污染用户可见清单。服务端没有「只上传不登记」的接口。

最小做法（已验证）：直接从维护机把文件放到静态目录，纯文件托管：

```bash
RAND=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
NAME="update-fixture-${RAND}.apk"
scp ./some.apk aliyun:/var/www/dl/apk/"$NAME"
ssh aliyun "chmod 644 /var/www/dl/apk/$NAME"          # 644 root:root，Caddy 只读
curl -sSI "https://dl.rose7.cn/apk/$NAME" | head -3    # 期望 200 + application/vnd.android.package-archive
sha256sum ./some.apk                                   # 与下载侧核对
```

约束（照做，别省）：

- **名字必须随机且带 `update-fixture-` 前缀**，避免被猜到；不进 `releases.json`、不在 `index.html` 里引用。
- `/apk/` 没有目录列表（`curl -I https://dl.rose7.cn/apk/` 应 404），所以不进清单=页面不可见；
  但**知道 URL 的人就能下载**（公开 HTTPS、无鉴权），只放不含敏感信息的样本。
- **测完立即删除并确认 404**，这是清理闭环，不依赖任何缓存：
  ```bash
  ssh aliyun 'rm -f /var/www/dl/apk/update-fixture-XXXX.apk'
  curl -sS -o /dev/null -w '%{http_code}\n' https://dl.rose7.cn/apk/update-fixture-XXXX.apk   # 期望 404
  ```
- 托管/删除都不需要重启 systemd 或 Caddy，也不改 `releases.json`、`latest`、tag。

## 契约文档

- 清单字段（App 内更新与发布侧共同遵守）：`docs/releases-manifest.md`
- 发布接口（HTTP 调用方）：`docs/dl-release-api.md`
