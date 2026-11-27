#!/usr/bin/env bash
# =============================================================================
# build-apk.sh —— 一条命令出 APK（Capacitor 套壳，对 src/ 零侵入）
#
# 用法:
#   ./build-apk.sh            # debug APK（默认，自动使用 android/keystore/debug.keystore 签名）
#   ./build-apk.sh release    # release APK（使用自签 release keystore）
#   ./build-apk.sh release --clean   # 额外执行 gradlew clean
#
# 构建环境（Issue #273）：一律走 build.env 声明，别在脚本里写死盘符。
#   cp build.env.example build.env   # 每台机器一份，已被 .gitignore 排除
#   ANDROID_HOME / JAVA_HOME / BUILD_TOOLS_VERSION / REQUIRED_JAVA_MAJOR / REQUIRED_NODE_MAJOR
#   生效顺序：同名环境变量 > build.env > 脚本内兜底默认值
#
# 可选环境变量:
#   SKIP_WEB_BUILD=1   跳过 pnpm build（复用现有 dist/）
#   ANDROID_HOME=...   覆盖 SDK 路径（其次 $ANDROID_SDK_ROOT，兜底 $HOME/android-sdk）
#   COPY_TO_DESKTOP=1  校验通过后把产物拷到桌面（文件名 jingluo-v<version>-vc<code>-<variant>.apk），
#                      并打印 SHA-256 —— 交付给内测用户的那一份就取这里，别去 build/outputs 里翻。
#   DELIVER_DIR=...    覆盖落盘目录（默认 ~/Desktop）
#   ALLOW_LOOPBACK_CONSUME=1
#                      显式允许「回环地址」出包（只给本地联调，Issue #601）。不设时，只要
#                      consume/pay/migration 的 base 是 127.0.0.1 / localhost / ::1 就构建失败。
#                      设了之后产物会打上 LOOPBACK_CONSUME=true 标记 → 传不上 dl（400 拒收）。
# 发布关卡（release 模式，**本地产的包与 CI 产的包同一套判据**）：
#   · 构建前 `scripts/check-keystore-config.mjs`：证书指纹必须是已发布证书 —— 最便宜的失败点，
#     不通过就别花几分钟做 web 构建 + gradle（换签 = 已装用户无法覆盖升级）；
#   · 构建后 `scripts/verify-release-apk.mjs`：六项（debuggable / 变体跨层同源 / 回环 / 证书 /
#     明文标记 / 包内 consume.baseUrl + 主机白名单）+ 版本号断言（package.json ↔ APK）。
#     红 = 禁止上传 dl / 禁止分发，产物留在原地但打不进发布流程。
#   BUILD_VARIANT=standard|staging|internal
#                      发布变体（默认 standard = 对外）。**internal = 内测包**（当前内测主线的唯一出包方式）：
#                      web 层走 `pnpm run build:internal`（产物自带 variant=internal 自述），
#                      gradle 侧自动带 INTERNAL_BUILD=1（= -PartifactVariant=internal），
#                      verify:apk 按 `--variant internal` 判。**内测包额外多跑一道
#                      `scripts/check-internal-lane.mjs`（覆盖升级硬断言：versionCode 严格递增 +
#                      证书指纹不变），它是用户拍板的规则，不是可选建议。**
#                      一次完整的内测出包命令（见 docs/release/INTERNAL-APK.md）：
#                        BUILD_VARIANT=internal ./build-apk.sh release
#                      staging = 预发布联调包：
#                      web 层走 `pnpm run build:staging`（`--staging --allow-insecure`，产物落 dist/），
#                      gradle 侧自动带 `-PconsumeBase=<config/endpoints.staging.json 的 consume.baseUrl>`
#                      与 `-PallowInsecureConsume=true`（闸 0 交叉核对 + 闸 1b 明文放行）。
#                      产物带 INSECURE_CONSUME=true 自证标记 → staging-only，禁止公开分发（#601）。
#
# 说明: 本脚本不依赖交互式 shell 环境，自行 export ANDROID_HOME / PATH；
#       release 模式**不再**在缺 keystore.properties 时自动生成 release keystore —— 一把新生成的
#       key 永远不等于已发布证书（gradle 的指纹闸门必炸），自动生成只会让人以为「材料齐了」，
#       排错却排到签名上。缺材料就 die，并指到 check:keystore。debug keystore 仍然自动生成。
#       硬闸门：java 主版本 < REQUIRED_JAVA_MAJOR → 失败；BUILD_TOOLS_VERSION 未设置
#       或目录不存在 → 失败（并列出已安装档位）。
# =============================================================================
set -euo pipefail

MODE="${1:-debug}"                 # debug | release
EXTRA_ARG="${2:-}"
case "$MODE" in
  debug|release) ;;
  -h|--help|help) sed -n '2,40p' "$0"; exit 0 ;;   # 行号范围跟着文件头走，改头注释要同步
  *) echo "[build-apk] 未知模式: $MODE （只支持 debug / release）" >&2; exit 2 ;;
esac

# 发布变体（Issue #601 / #651）：standard = 对外发布（默认，与加这个变量之前逐字一致）；
# staging = 预发布联调包（明文后端，staging-only）。一个变量贯通 web 层与原生层，
# 不复制两份构建逻辑 —— 变体只决定「web 用哪条 pnpm 脚本」与「gradle 多带哪几个 -P」。
BUILD_VARIANT="${BUILD_VARIANT:-standard}"
case "$BUILD_VARIANT" in
  standard|staging|internal) ;;
  *) echo "[build-apk][ERROR] 未知 BUILD_VARIANT: $BUILD_VARIANT （只支持 standard / staging / internal）" >&2; exit 2 ;;
esac

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
ANDROID_DIR="$PROJECT_ROOT/android"

log() { printf '\n\033[1;36m[build-apk] %s\033[0m\n' "$*"; }

die() { printf '\n\033[1;31m[build-apk][ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------- 0. 环境隔离：发布构建**不许**带登录接缝
#
# `TEST_AUTH_SEAM=1` 是**测试专用**开关（L1 / 黄金回归需要「启动即已登录」）：打开后
# `AuthGate` 直接进已登录态、不读盘、不续期、不调 `me()`。这个变量一旦漏进发布构建，
# 打出来的包等于把「绕过登录」的开关发给用户 —— 比任何功能缺陷都严重，所以：
#   · 这里**直接拒跑**（不是警告、不是自动 unset）：带着它构建说明环境的来源有问题，
#     静默清掉会让人以为「刚才那次是干净的」；
#   · 打印它的实际取值，让「我当时到底带没带」有据可查；
#   · 另有第 7 项产物校验（`scripts/check-apk-seam.mjs`）兜底扫包内标记。
if [ -n "${TEST_AUTH_SEAM:-}" ]; then
  if [ "$MODE" = "release" ]; then
    die "环境里有 TEST_AUTH_SEAM='${TEST_AUTH_SEAM}' —— 发布构建禁止带登录接缝。
  这个开关会让 AuthGate 直接进已登录态（不读盘、不续期、不调 me()），出了这个包 = 鉴权绕过。
  L1 / 黄金回归用的测试产物请单独构建：
    TEST_AUTH_SEAM=1 pnpm run build:internal   （或 DIST_OUT=dist-standard / dist-scroll）
  跑本脚本前先把它清掉（新开一个 shell / unset TEST_AUTH_SEAM），再重跑。"
  fi
  printf '\033[1;33m[build-apk][警告] 环境里有 TEST_AUTH_SEAM=%s：这是 debug 产物，只许本地/模拟器烟测，禁止当发布包分发\033[0m\n' "$TEST_AUTH_SEAM" >&2
else
  log "环境隔离检查：TEST_AUTH_SEAM 未设置（发布构建一律不带接缝）"
fi

# ------------------------------------------------- 0. 读构建环境声明（build.env）
# 生效顺序：同名环境变量 > build.env > 脚本内兜底默认值。
# 也就是说 build.env 不会覆盖你已经 export 的值（临时换机器/换 JDK 直接 export 就行）。
BUILD_ENV_FILE="$PROJECT_ROOT/build.env"
if [ -f "$BUILD_ENV_FILE" ]; then
  PRESET_KEYS=(ANDROID_HOME ANDROID_SDK_ROOT JAVA_HOME BUILD_TOOLS_VERSION REQUIRED_JAVA_MAJOR REQUIRED_NODE_MAJOR)
  declare -A PRESET=()
  for _k in "${PRESET_KEYS[@]}"; do
    if [ -n "${!_k:-}" ]; then PRESET[$_k]="${!_k}"; fi
  done
  set -a
  # shellcheck disable=SC1090
  . "$BUILD_ENV_FILE"
  set +a
  for _k in "${!PRESET[@]}"; do export "$_k=${PRESET[$_k]}"; done
  unset _k
  log "已读取构建环境声明: $BUILD_ENV_FILE"
fi

REQUIRED_JAVA_MAJOR="${REQUIRED_JAVA_MAJOR:-21}"
REQUIRED_NODE_MAJOR="${REQUIRED_NODE_MAJOR:-22}"

# ---------------------------------------------------------------- 1. 环境准备
# SDK 定位：export > build.env > 兜底探测（只在本机常见位置命中时才用，并打日志说明取自哪里）。
# 加这一层是因为「build.env 没建」的表现是 `找不到 Android SDK: /home/...` —— 在 Windows/MSYS 上
# 那条兜底路径根本不存在，人看到的第一反应是自己先 export 一遍，于是每次出包都靠记忆。
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for _probe in "$HOME/android-sdk" "/d/android-sdk" "$HOME/AppData/Local/Android/Sdk" "$HOME/Android/Sdk" /usr/local/android-sdk; do
    if [ -d "$_probe" ] && [ -d "$_probe/build-tools" ]; then
      ANDROID_HOME="$_probe"
      printf '\033[1;33m[build-apk] 未声明 ANDROID_HOME，自动探测命中 %s（建议写进 build.env 固定下来）\033[0m\n' "$_probe" >&2
      break
    fi
  done
  unset _probe
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
[ -d "$ANDROID_HOME" ] || die "找不到 Android SDK: $ANDROID_HOME （把路径写进 build.env 的 ANDROID_HOME，或 export ANDROID_HOME；见 build.env.example）"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# JDK：gradle 需要 JAVA_HOME（没有就按 PATH 里的 java 反推）
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_BIN="$(command -v java || true)"
  [ -n "$JAVA_BIN" ] || die "找不到 java，需要 JDK ${REQUIRED_JAVA_MAJOR}（把 JDK 根目录写进 build.env 的 JAVA_HOME，或 export JAVA_HOME）"
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
[ -x "$JAVA_HOME/bin/java" ] || die "JAVA_HOME=$JAVA_HOME 下没有 bin/java（路径写错了？）"

# JDK 版本闸门（Issue #273）：以前只有「需要 JDK 21」这句文案，代码不校验，
# 版本不对时得到的是看不懂的 gradle 报错。
JAVA_VER_RAW="$("$JAVA_HOME/bin/java" -version 2>&1 | head -n 1 || true)"
JAVA_MAJOR="$(printf '%s' "$JAVA_VER_RAW" | sed -n 's/.*version "\([0-9][0-9._]*\)".*/\1/p' | cut -d. -f1)"
if [ "$JAVA_MAJOR" = "1" ]; then   # 1.8.0_392 这种老式版本号
  JAVA_MAJOR="$(printf '%s' "$JAVA_VER_RAW" | sed -n 's/.*version "1\.\([0-9][0-9._]*\)".*/\1/p' | cut -d. -f1)"
fi
case "$JAVA_MAJOR" in
  '' | *[!0-9]*) die "读不出 java 主版本：${JAVA_VER_RAW:-<空>}（需要 ${REQUIRED_JAVA_MAJOR}）" ;;
esac
[ "$JAVA_MAJOR" -ge "$REQUIRED_JAVA_MAJOR" ] || die "JDK 版本不对：需要 ${REQUIRED_JAVA_MAJOR}，当前 ${JAVA_MAJOR}
  JAVA_HOME=$JAVA_HOME
  修复：把 JAVA_HOME 指到 JDK ${REQUIRED_JAVA_MAJOR} 根目录（build.env 或 export JAVA_HOME=...）"

# node 版本低于声明时只警告：engines 在 pnpm install 也只警告，这里不越权硬失败
NODE_VER_RAW="$(node --version 2>/dev/null || true)"
NODE_MAJOR="$(printf '%s' "$NODE_VER_RAW" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
case "$NODE_MAJOR" in
  '' | *[!0-9]*) die "找不到 node（pnpm build 需要 node >= ${REQUIRED_NODE_MAJOR}）" ;;
esac
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  printf '\033[1;33m[build-apk][警告] node 版本低于声明：需要 >=%s，当前 %s（产物 polyfill 目标可能与声明不同）\033[0m\n' \
    "$REQUIRED_NODE_MAJOR" "$NODE_VER_RAW"
fi

# build-tools 档位闸门（Issue #273）：不再用 build-tools/* 通配取最大版本，
# 否则装了新 build-tools 就静默换 aapt2。
BUILD_TOOLS_ROOT="$ANDROID_HOME/build-tools"
INSTALLED_BUILD_TOOLS="$(ls -1 "$BUILD_TOOLS_ROOT" 2>/dev/null | sort -V | tr '\n' ' ' || true)"
if [ -z "${BUILD_TOOLS_VERSION:-}" ]; then
  die "BUILD_TOOLS_VERSION 未设置（不允许通配取最大版本）
  已安装档位: ${INSTALLED_BUILD_TOOLS:-<无>}
  修复：cp build.env.example build.env，把 BUILD_TOOLS_VERSION 写成上面某一档"
fi
[ -d "$BUILD_TOOLS_ROOT/$BUILD_TOOLS_VERSION" ] || die "build-tools 版本不存在: $BUILD_TOOLS_ROOT/$BUILD_TOOLS_VERSION
  已安装档位: ${INSTALLED_BUILD_TOOLS:-<无>}
  修复：改 build.env 的 BUILD_TOOLS_VERSION（或安装该档位）"
AAPT2_BIN="$BUILD_TOOLS_ROOT/$BUILD_TOOLS_VERSION/aapt2"
if [ ! -x "$AAPT2_BIN" ] && [ -x "$AAPT2_BIN.exe" ]; then AAPT2_BIN="$AAPT2_BIN.exe"; fi

log "模式=$MODE  ANDROID_HOME=$ANDROID_HOME  JAVA_HOME=$JAVA_HOME (java $JAVA_MAJOR)  BUILD_TOOLS_VERSION=$BUILD_TOOLS_VERSION  node=$NODE_VER_RAW"

# 版本号的唯一来源是 package.json（build.gradle 的 appVersionName / appVersionCode 也读它）：
# 这里读出期望值，构建后用 verify:apk 的 --expect-version-* 断言「包内 versionCode/versionName == 这份」。
# 事故形状：改了 package.json 但 gradle 复用了上一份产物 / 拿错包 / 忘了 bump androidVersionCode ——
# 那几种情况在 dl 上传时才红（409 VERSION_CONFLICT），而出包这一秒就能判。
PKG_VERSION_NAME="$(node -p "require('./package.json').version" 2>/dev/null || true)"
PKG_VERSION_CODE="$(node -p "require('./package.json').androidVersionCode" 2>/dev/null || true)"
case "$PKG_VERSION_CODE" in
  '' | *[!0-9]*) die "package.json 的 androidVersionCode 不是正整数（'${PKG_VERSION_CODE}'）：它是 Android versionCode 的唯一来源，版本号判不出来就不出包" ;;
esac
[ -n "$PKG_VERSION_NAME" ] || die "package.json 的 version 读不出来：它是 versionName 的唯一来源"
log "版本号（package.json）: ${PKG_VERSION_NAME} (versionCode ${PKG_VERSION_CODE})"

# 原生侧的 ARTIFACT_VARIANT 口径与 build.gradle 的 updateVariant 一致（INTERNAL_BUILD=1 → internal，
# 否则 standard）。注意 **staging 不是原生侧变体**：它只是 web 层 profile + 明文放行，产物标记仍是
# standard（见 android/app/build.gradle 的 updateVariant / CI 里 `verify:apk --variant standard`）。
NATIVE_VARIANT=standard
if [ "$BUILD_VARIANT" = "internal" ]; then
  # 一个变量贯通 web / gradle / verify（同 staging 的道理）：出半套包（web 标 internal、原生标 standard）
  # 会在 verify:apk 第 2 项「变体跨层同源」当场红，但那时已经白跑了几分钟构建。
  export INTERNAL_BUILD=1
  NATIVE_VARIANT=internal
fi
# 注意：这里**不能**写成 `[ ... ] && VAR=...` —— 在本机 MSYS bash 下，`set -e` 会让整条 AND 列表
# 的非零返回值直接终止脚本（2026-11-27 实测：条件不成立 → 脚本在第 5 步之前无声退出，exit 1，
# 日志里只留下上一条 log 行，看不出死在哪）。全部改成显式 if。
if [ "${INTERNAL_BUILD:-}" = "1" ]; then NATIVE_VARIANT=internal; fi

# local.properties：把 SDK 路径钉进 Gradle（该文件已 gitignore）。
# 内容不变就不重写，避免和 IDE 里那份来回打架（Issue #273 现状第 3 条）。
SDK_DIR_LINE="sdk.dir=$(printf '%s' "$ANDROID_HOME" | sed 's|\\|/|g')"
LOCAL_PROPS="$ANDROID_DIR/local.properties"
if [ ! -f "$LOCAL_PROPS" ] || [ "$(cat "$LOCAL_PROPS")" != "$SDK_DIR_LINE" ]; then
  printf '%s\n' "$SDK_DIR_LINE" > "$LOCAL_PROPS"
  log "已写入 $LOCAL_PROPS（$SDK_DIR_LINE）"
else
  log "local.properties 已指向同一 SDK，不覆盖"
fi

# --------------------------------------------------- 2. 签名材料（release 缺了就 die）
KS_DIR="$ANDROID_DIR/keystore"
KS_PROPS="$KS_DIR/keystore.properties"
if [ ! -f "$KS_PROPS" ]; then
  if [ "$MODE" = "release" ]; then
    # 以前这里会**顺手生成**一把 release keystore + 一份 props。那把 key 永远不等于已发布证书
    # （gradle 的 EXPECTED_CERT_SHA256 闸门必炸），却让「材料齐了」这个错觉先成立，
    # 于是排错一路排到签名错误上 —— 现在直接说清缺什么、去哪拿。
    die "release 构建缺少签名材料，已中止（不会自动生成一把永远用不上的 key）。
  缺失文件：$KS_PROPS
  为什么不能自动生成：release 包的证书必须是**已发布证书**（换签 = 已装用户无法覆盖升级）。
  修法：
    1) cp android/keystore/keystore.properties.example $KS_PROPS
    2) 按注释填四个 *Release 键，storeFileRelease 指向已发布的那把 keystore
       （本机是 /root/.android/debug.keystore；见 docs/RELEASE-MANUAL.md §1）
    3) chmod 600 $KS_PROPS && pnpm run check:keystore
  只想本地跑 debug 包：./build-apk.sh（debug 会自动生成 debug keystore）。"
  fi
  log "未找到 $KS_PROPS，自动生成 debug keystore（仅本机，不提交；release 材料要手工放）"
  mkdir -p "$KS_DIR"
  command -v keytool >/dev/null || die "找不到 keytool（请安装 JDK 21）"
  rand_pass() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
  DBG_PASS="$(rand_pass)"
  [ -f "$KS_DIR/debug.keystore" ] || keytool -genkeypair -v -keystore "$KS_DIR/debug.keystore" \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 \
    -storepass "$DBG_PASS" -keypass "$DBG_PASS" \
    -dname "CN=Android Debug, O=Android, C=US" >/dev/null
  umask 077
  cat > "$KS_PROPS" <<EOF
# 本地签名凭据 —— 已被 .gitignore 排除，切勿提交
# 只有 debug 那一组是自动生成的。**release 四个键必须手工填**（指向已发布证书那把 key），
# 别在这里凭空生成 release keystore：新 key 永远不等于已发布证书，gradle 的指纹闸门会中止构建。

storeFileDebug=../keystore/debug.keystore
storePasswordDebug=$DBG_PASS
keyAliasDebug=androiddebugkey
keyPasswordDebug=$DBG_PASS
EOF
  chmod 600 "$KS_PROPS"
  log "debug keystore 生成完成: $KS_DIR（release 四个键仍缺，见 docs/RELEASE-MANUAL.md §1）"
fi

# ------------------------------------- 2b. 发布前签名门禁（最便宜的失败点）
# 为什么放在 pnpm build / gradle 之前（Issue #697 的接法，本脚本此前**只有 CI 有这一步**）：
# 本地产 release 包的人从来没跑过 check:keystore —— 于是「本地产出一个用户装不上的包」这条路是通的：
# 指纹不对 → gradle 那道闸（build.gradle 的 EXPECTED_CERT_SHA256）到 assembleRelease 才炸，
# 而那时 web 构建 + cap sync 已经白跑几分钟；更糟的是有人为让它过而改期望值。
if [ "$MODE" = "release" ]; then
  log "步骤 2b：签名凭据自检（证书指纹必须等于已发布证书）"
  if ! node "$PROJECT_ROOT/scripts/check-keystore-config.mjs"; then
    die "签名凭据不合格，已中止（还没开始 web 构建）。
  证书指纹 ≠ config/appIdentity.json 的 expectedCertSha256 = 换签 = **已安装用户无法覆盖升级**，禁止发布。
  修法见上面 check:keystore 的输出（把 keystore.properties 的 storeFileRelease / 口令 / 别名指到已发布证书）；
  不要改 expectedCertSha256 让闸门变绿 —— 那是签名迁移，必须单独规划。"
  fi
fi

# ----------------------------------- 2b-2. 内测包的覆盖升级硬断言（用户规则）
# 用户拍板（2026-11-27）：每次对外分发新内测 APK，versionCode 必须递增（44 → 45 → 46 …），
# versionName 可以维持 2.0.1；签名证书必须不变 —— 否则已装用户无法覆盖升级（Android 只允许同证书
# 且 versionCode 不降的更新包覆盖安装），用户明确要求「已装 vc42 / vc43 都能直接覆盖，无须卸载重装」。
# 数据源是 docs/release/internal-lane.json（内测分发台账）。放在这里的原因与 2b 相同：
# 这是最便宜的失败点，不该等 web 构建 + gradle 跑完几分钟才红。
if [ "$BUILD_VARIANT" = "internal" ] && [ "$MODE" = "release" ]; then
  log "步骤 2b-2：内测覆盖升级硬断言（versionCode 必须递增 + 证书指纹不变）"
  if ! node "$PROJECT_ROOT/scripts/check-internal-lane.mjs"; then
    die "内测覆盖升级判据不通过，已中止（还没开始 web 构建）。
  两条硬规则（用户拍板，不许绕过）：
    · versionCode 必须严格大于 docs/release/internal-lane.json 的 lastDistributedVersionCode
      —— 同号或降号的包装不上，已装用户会得到「应用未安装」；
    · 签名证书必须是已发布的那把 —— 换签等于让所有已装用户无法覆盖升级。
  修法：改 package.json 的 androidVersionCode（versionName 可不变）；证书问题去修签名材料，
  不要改台账里的 certSha256Prefix。"
  fi
fi

# ------------------------------------- 2c. staging 变体的期望 consume base（唯一解析点）
# gradle 的 -PconsumeBase 与构建后 verify:apk 的 --expect-consume-base **必须同一个值**：
# 它是「这次出包应该连哪台后端」的唯一期望。各读一次就会出现「gradle 按 A 打、校验按 B 比」。
STAGING_CONSUME_BASE=""
if [ "$BUILD_VARIANT" = "staging" ]; then
  STAGING_CONSUME_JSON="$PROJECT_ROOT/config/endpoints.staging.json"
  [ -f "$STAGING_CONSUME_JSON" ] || die "找不到 $STAGING_CONSUME_JSON（staging 变体必须有这份端点配置）"
  if ! STAGING_CONSUME_BASE="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).consume.baseUrl" -- "$STAGING_CONSUME_JSON")"; then
    die "读不出 $STAGING_CONSUME_JSON 的 consume.baseUrl（见上方 node 报错）"
  fi
  case "$STAGING_CONSUME_BASE" in
    http://*|https://*) ;;
    *) die "$STAGING_CONSUME_JSON 的 consume.baseUrl 不是协议://主机 形式：'$STAGING_CONSUME_BASE'" ;;
  esac
  log "staging 期望 consume base: $STAGING_CONSUME_BASE（来源 $STAGING_CONSUME_JSON）"
fi

# ------------------------------------------------------------ 3. 前端构建产物
if [ "${SKIP_WEB_BUILD:-0}" = "1" ] && [ -f "$PROJECT_ROOT/dist/index.html" ]; then
  log "SKIP_WEB_BUILD=1，复用现有 dist/（请自行确认这份 dist/ 就是 $BUILD_VARIANT 变体的产物）"
elif [ "$BUILD_VARIANT" = "internal" ]; then
  # internal：`pnpm run build:internal` = `node scripts/build.mjs --internal`
  #   · 产物落 dist/（build.mjs 只有 staging 默认落 dist-pre），带 build-info.json 的 variant=internal
  #   · INTERNAL_BUILD=1 同时注入 web 层与（上面的）gradle 侧，跨层同源才过得了 verify:apk 第 2 项
  log "步骤 3：pnpm run build:internal（internal 变体 → dist/）"
  INTERNAL_BUILD=1 pnpm run build:internal
elif [ "$BUILD_VARIANT" = "staging" ]; then
  # staging：`pnpm run build:staging` = `node scripts/build.mjs --staging --allow-insecure`
  #   · --staging        读 config/endpoints.staging.json（预发布明文 consume 地址）
  #   · --allow-insecure 等价于 ALLOW_INSECURE_CONSUME=true（web 层注入 insecureConsume=true，
  #                      否则 src/services/consume/http.ts 在模块级就抛错 → 装上白屏，#601）
  #   · DIST_OUT=dist **必须显式给**：build.mjs 对 staging 默认落 dist-pre（避免顶掉发版用的 dist/），
  #     而 capacitor 的 webDir 是 dist/、本脚本也只认 dist/ —— 不给就会把上一份 standard 产物 sync 进 APK。
  log "步骤 3：pnpm run build:staging（staging 变体 → dist/）"
  ALLOW_INSECURE_CONSUME=true DIST_OUT=dist pnpm run build:staging
else
  log "步骤 3：pnpm build（产物 -> dist/）"
  pnpm build
fi
[ -f "$PROJECT_ROOT/dist/index.html" ] || die "dist/index.html 不存在，前端构建失败"

# ------------------------------------------------------ 4. 同步 web 产物到原生工程
log "步骤 4：pnpm exec cap sync android（dist -> android/app/src/main/assets/public）"
# 用 pnpm exec：走本地 @capacitor/cli，版本锚在 pnpm-lock.yaml 里；
# 原来的 npx 会按需向网络拉包，版本不锚定（Issue #273 现状表）
pnpm exec cap sync android

# ------------------------------------------------------------ 5. Gradle 出包
if [ "$MODE" = "release" ]; then
  GRADLE_TASK="assembleRelease"; APK_DIR="$ANDROID_DIR/app/build/outputs/apk/release"; APK_NAME="app-release.apk"
else
  GRADLE_TASK="assembleDebug";   APK_DIR="$ANDROID_DIR/app/build/outputs/apk/debug";   APK_NAME="app-debug.apk"
fi

cd "$ANDROID_DIR"
# gradle 启动方式（踩过的坑）：在 Windows/MSYS 下 `./gradlew` 会报
#   `Error: Unable to access jarfile D;/jingluo-worktrees/.../gradle-wrapper.jar`
# —— 那只 shell 脚本把路径按 POSIX 形态塞给 java，java 把 `D:/` 的冒号当盘符分隔符读坏。
# 直接用 java 跑 wrapper 的主类就绕开这层转换，两个平台同一条路：
#   java -classpath <wrapper jar> org.gradle.wrapper.GradleWrapperMain <args...>
# 找不到 wrapper jar 才退回 ./gradlew（Linux/CI 那条路行为不变）。
GRADLE_WRAPPER_JAR="$ANDROID_DIR/gradle/wrapper/gradle-wrapper.jar"
if [ -f "$GRADLE_WRAPPER_JAR" ]; then
  GRADLE_CMD=("$JAVA_HOME/bin/java" -classpath "$GRADLE_WRAPPER_JAR" org.gradle.wrapper.GradleWrapperMain)
  log "gradle 启动：java -classpath gradle-wrapper.jar GradleWrapperMain（避开 Windows 下 ./gradlew 的 jar 路径转换问题）"
else
  chmod +x ./gradlew
  GRADLE_CMD=("./gradlew")
  log "gradle 启动：./gradlew（未找到 $GRADLE_WRAPPER_JAR）"
fi
GRADLE_ARGS=("$GRADLE_TASK" "--console=plain")
if [ "$EXTRA_ARG" = "--clean" ]; then GRADLE_ARGS=("clean" "${GRADLE_ARGS[@]}"); fi
# 回环地址逃生舱（Issue #601）：只给本地联调。显式设为 1 才转发 -PallowLoopbackConsume=true；
# 转发后产物带 LOOPBACK_CONSUME 标记，dl-release 会 400 LOOPBACK_BUILD_REJECTED 拒收。
if [ "${ALLOW_LOOPBACK_CONSUME:-0}" = "1" ]; then
  GRADLE_ARGS+=("-PallowLoopbackConsume=true")
  printf '\033[1;33m[build-apk][警告] ALLOW_LOOPBACK_CONSUME=1：本次产物是「回环地址」本地联调包，禁止上传 dl / 禁止分发（#601）\033[0m\n' >&2
fi

# staging 变体的原生侧（Issue #601 / #651）：这三个开关必须与 web 层同值/同源，否则 gradle 的闸 0
# 会直接 BUILD FAILED（-PconsumeBase 只写原生侧，web 层在 pnpm build 时就注入了地址）。
#   · -PconsumeBase=<staging consume base>：与 dist/build-info.json 的自述值同源（都读 config/endpoints.staging.json）
#   · -PallowInsecureConsume=true         ：闸 1b 放行「明文非回环」+ 写 INSECURE_CONSUME=true 自证标记
#   · ALLOW_INSECURE_CONSUME=true         ：web 侧同一个开关的另一入口（gradle 也认），免得出半套包
#
# 期望的 consume base 在**进入 android/ 之前**就解析出来（步骤 2c）：gradle 与构建后的 verify:apk
# 必须用同一个值 —— 各读一次的话，一处读成功一处读失败就会出现「gradle 按这台的地址打、校验按另一台比」。
if [ "$BUILD_VARIANT" = "staging" ]; then
  export ALLOW_INSECURE_CONSUME=true
  GRADLE_ARGS+=("-PconsumeBase=$STAGING_CONSUME_BASE" "-PallowInsecureConsume=true")
  printf '\033[1;33m[build-apk][警告] BUILD_VARIANT=staging：产物指向预发布后端 %s（明文），带 INSECURE_CONSUME 标记 → 只许内网联调，禁止公开分发\033[0m\n' "$STAGING_CONSUME_BASE" >&2
fi

log "步骤 5：${GRADLE_CMD[*]} ${GRADLE_ARGS[*]}"
"${GRADLE_CMD[@]}" "${GRADLE_ARGS[@]}"

APK_PATH="$APK_DIR/$APK_NAME"
[ -f "$APK_PATH" ] || die "构建结束但未找到 APK: $APK_PATH"
APK_PATH="$(readlink -f "$APK_PATH")"
APK_SIZE="$(du -h "$APK_PATH" | cut -f1)"
APK_BYTES="$(stat -c %s "$APK_PATH")"



# ------------------------------------- 6. 发布产物校验（release = 硬闸；debug = 只警告）
#
# 这一层以前**只有 CI 有**：`.github/workflows/build-apk.yml` 打完包跑 `verify:apk` 六项，
# 而本脚本只在最后跑一次 check-apk-debuggable —— 于是「本地 ./build-apk.sh release 产出一个
# 用户装不上 / 连错后端 / 标记错」的包这条路是通的：同一份源码，CI 产的包红、本地产的不红。
# 现在两条路径跑同一套判据（同一份实现，不另抄判定）：
#   · debuggable（Issue #60：1.0.0～1.4.0-beta.8 共 15 个已发布包都是 debug 变体产物）
#   · 变体标记 + 跨层同源（web 产物自述 variant ↔ 原生 ARTIFACT_VARIANT）
#   · 回环标记 / 明文标记（标记 ∪ 地址事实；明文 + 生产主机是明确禁止的组合）
#   · 签名证书指纹（换签 = 已装用户无法覆盖升级）
#   · 包内 consume.baseUrl（逐字 + 主机白名单；#763）
#   · 版本号（package.json ↔ APK 内的 versionCode / versionName）
log "步骤 6：发布产物校验（六项 + 版本号；红 = 禁止上传 dl / 禁止分发）"
if [ "$MODE" = "release" ]; then
  VERIFY_ARGS=(--variant "$NATIVE_VARIANT")
  VERIFY_ARGS+=(--expect-version-code "$PKG_VERSION_CODE" --expect-version-name "$PKG_VERSION_NAME")
  if [ "$BUILD_VARIANT" = "staging" ]; then
    # staging = 明文联调包：地址是 config/endpoints.staging.json 那台（**不是**生产地址），
    # 所以期望值要显式传 staging 的 base，并显式认可「这是明文包」（结论行会标 INSECURE(staging-only)）。
    VERIFY_ARGS+=(--allow-insecure --expect-consume-base "$STAGING_CONSUME_BASE")
  fi
  if ! node "$PROJECT_ROOT/scripts/verify-release-apk.mjs" "$APK_PATH" "${VERIFY_ARGS[@]}"; then
    die "发布产物校验不通过，禁止上传 dl / 禁止分发。
  APK: $APK_PATH
  上面那张表点名了是哪一项红（debuggable / variant / loopback / cert / insecure / consumeBase / 版本号），
  每一行的 detail 里写了修法。**不要**为了过闸去改判据（期望指纹、变体、地址白名单都是发布级事实）：
     · 证书不对 → 已装用户无法覆盖升级，先修签名材料（pnpm run check:keystore），别改 expectedCertSha256；
     · 变体 / 地址不对 → 改出包参数或 config，重新出包；
     · 版本号不对 → package.json 的 version / androidVersionCode 才是唯一来源，改完重出包。
  产物留在原地供排查（$APK_PATH），但它不是发布包。"
  fi

  # ---- 第 7 项：包内**不许**有登录接缝（#487 W1-B / #510；vc44 起为硬断言）
  #
  # 前六项验的是产物形态，没有任何一项会去看「包里那坨 web 资产是怎么构建的」。
  # 而带接缝的包 = AuthGate 直接进已登录态 = 鉴权绕过，分发给用户是最严重的那类事故。
  # 判据只扫文本条目（web 资产）；扫不到任何文本条目 = 判不出来（exit 2），照样 die。
  log "步骤 7：包内登录接缝检查（第 7 项；命中 = 禁止分发）"
  if ! node "$PROJECT_ROOT/scripts/check-apk-seam.mjs" "$APK_PATH"; then
    die "第 7 项不通过：APK 里带着登录接缝标记（test-token-not-real / __TEST_AUTH_STATE__）。
  APK: $APK_PATH
  这个包启动即已登录、不调 me()、不续期 —— 分发出去等于把「绕过登录」的开关发给用户。
  修法：确认构建环境里没有 TEST_AUTH_SEAM（`env | grep TEST_AUTH_SEAM` 应为空），重新出包。
  **不要**为了过这一项去删标记或改判据。"
  fi
else
  # debug 产物天生 debuggable：不是发布包，只做提示（仍然跑同一份判定，不另抄一份）
  if node "$PROJECT_ROOT/scripts/check-apk-debuggable.mjs" "$APK_PATH"; then
    printf '\033[1;33m[警告] 这是 debug 产物：只许本地联调 / 模拟器烟测，禁止上传 dl.rose7.cn、禁止当发布包分发（Issue #60）\033[0m\n'
  else
    printf '\033[1;33m[警告] debug 产物的 debuggable 状态判不出来（按禁止分发处理，Issue #60）\033[0m\n'
  fi
fi

# ------------------------------- 7. 收尾横幅（**校验通过之后**才说「可以装上」）
# 顺序刻意放在校验后面：先跑完判据再宣布成功 —— 否则「BUILD OK / 安装命令」会出现在红之前，
# 而人只会看到绿的半边（红的 die 在下面才触发）。
if [ "$MODE" = "release" ]; then
  printf '\n\033[1;32m============ RELEASE 产物校验通过 ============\033[0m\n'
else
  printf '\n\033[1;32m================ BUILD OK (%s) ================\033[0m\n' "$MODE"
fi
printf 'APK 绝对路径 : %s\n' "$APK_PATH"
printf 'APK 大小     : %s (%s bytes)\n' "$APK_SIZE" "$APK_BYTES"
APK_SHA256="$(sha256sum "$APK_PATH" | cut -d' ' -f1)"
printf 'SHA-256      : %s\n' "$APK_SHA256"
printf '构建变体     : %s%s\n' "$BUILD_VARIANT" "$([ "$BUILD_VARIANT" = staging ] && echo '（staging-only，禁止公开分发）' || echo '')"
printf 'build-tools  : %s（钉住档位，不走通配）\n' "$BUILD_TOOLS_VERSION"
# aapt2 只从钉住档位取：人工核对的工具与出包工具必须是同一个（Issue #273 现状第 4 条）
if [ -x "$AAPT2_BIN" ]; then
  printf '包名/版本    : %s\n' "$("$AAPT2_BIN" dump badging "$APK_PATH" 2>/dev/null | grep -E "^package:" || echo 'n/a')"
fi
printf '安装命令     : adb install -r "%s"\n' "$APK_PATH"

# 交付落盘（COPY_TO_DESKTOP=1）：内测用户拿到的那一份必须是**校验过的这一份**，别二次拷贝
# build/outputs 里的同名文件（gradle 下次构建会原地覆盖它，人却以为还是原来那个）。
if [ "${COPY_TO_DESKTOP:-0}" = "1" ]; then
  DELIVER_DIR="${DELIVER_DIR:-$HOME/Desktop}"
  mkdir -p "$DELIVER_DIR"
  DELIVER_NAME="jingluo-v${PKG_VERSION_NAME}-vc${PKG_VERSION_CODE}-${BUILD_VARIANT}.apk"
  cp -f "$APK_PATH" "$DELIVER_DIR/$DELIVER_NAME"
  printf '交付副本     : %s\n' "$DELIVER_DIR/$DELIVER_NAME"
  printf '交付副本 SHA : %s\n' "$(sha256sum "$DELIVER_DIR/$DELIVER_NAME" | cut -d' ' -f1)"
fi
printf '\033[1;32m==============================================\033[0m\n'
