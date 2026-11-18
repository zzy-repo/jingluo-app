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

# 2) 令牌（600，root）
install -d -m 700 /etc/dl-release
head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48 > /etc/dl-release/token
chmod 600 /etc/dl-release/token

# 3) 变体白名单（可选，只给没标记的历史包用）
install -m 600 deploy/dl-release/artifact-variants.json.example /etc/dl-release/artifact-variants.json
```

## 部署代码

```bash
scp deploy/dl-release/server.mjs deploy/dl-release/variant.mjs aliyun:/opt/dl-release/
scp deploy/dl-release/dl-release.service aliyun:/etc/systemd/system/dl-release.service
ssh aliyun 'node --check /opt/dl-release/server.mjs && systemctl daemon-reload && systemctl restart dl-release'
ssh aliyun 'systemctl is-active dl-release; journalctl -u dl-release -n 5 --no-pager'
```

> `server.mjs` 依赖同目录的 `variant.mjs`，**两个文件一起传**，否则服务起不来。
> Caddy 片段见 `caddy-dl-api.conf`（粘进已有 `handle @dl` 内，validate → reload，禁止 restart）。

## 本地验证（不碰线上）

```bash
node --check deploy/dl-release/server.mjs
node --test deploy/dl-release/test/*.test.mjs

# 清单结构 / 新字段契约
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/live-2026-11-18.json
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/proposed-beta4-internal.json
node scripts/validate-releases-manifest.mjs deploy/dl-release/fixtures/invalid-*.json   # 期望全 FAIL

# 端到端（需要 aapt2 + 真 APK，会在 /tmp 起临时实例，不写线上任何文件）
AAPT2=/path/aapt2 \
APK_NO_MARKER=/path/deepseek-chat-1.4.0-beta.4.apk \
APK_NO_MARKER_OLD=/path/deepseek-chat-1.4.0-beta.3.apk \
APK_WITH_MARKER=/path/marker.apk \
bash deploy/dl-release/test/offline-check.sh
```

## 契约文档

- 清单字段（App 内更新与发布侧共同遵守）：`docs/releases-manifest.md`
- 发布接口（HTTP 调用方）：`docs/dl-release-api.md`
