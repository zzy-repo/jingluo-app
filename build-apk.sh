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
#
# 说明: 本脚本不依赖交互式 shell 环境，自行 export ANDROID_HOME / PATH；
#       首次运行会自动生成 keystore（若 android/keystore/keystore.properties 缺失）。
#       硬闸门：java 主版本 < REQUIRED_JAVA_MAJOR → 失败；BUILD_TOOLS_VERSION 未设置
#       或目录不存在 → 失败（并列出已安装档位）。
# =============================================================================
set -euo pipefail

MODE="${1:-debug}"                 # debug | release
EXTRA_ARG="${2:-}"
case "$MODE" in
  debug|release) ;;
  -h|--help|help) sed -n '2,23p' "$0"; exit 0 ;;
  *) echo "[build-apk] 未知模式: $MODE （只支持 debug / release）" >&2; exit 2 ;;
esac

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
ANDROID_DIR="$PROJECT_ROOT/android"

log() { printf '\n\033[1;36m[build-apk] %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[build-apk][ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

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

# --------------------------------------------------- 2. 首次运行自动生成签名材料
KS_DIR="$ANDROID_DIR/keystore"
KS_PROPS="$KS_DIR/keystore.properties"
if [ ! -f "$KS_PROPS" ]; then
  log "未找到 android/keystore/keystore.properties，自动生成 debug + release keystore（仅本机，不提交）"
  mkdir -p "$KS_DIR"
  command -v keytool >/dev/null || die "找不到 keytool（请安装 JDK 21）"
  rand_pass() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
  REL_PASS="$(rand_pass)"; DBG_PASS="$(rand_pass)"
  [ -f "$KS_DIR/release.keystore" ] || keytool -genkeypair -v -keystore "$KS_DIR/release.keystore" \
    -alias deepseekchat -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 \
    -storepass "$REL_PASS" -keypass "$REL_PASS" \
    -dname "CN=DeepSeek Chat, OU=Dev, O=DeepSeek, L=Shanghai, ST=Shanghai, C=CN" >/dev/null
  [ -f "$KS_DIR/debug.keystore" ] || keytool -genkeypair -v -keystore "$KS_DIR/debug.keystore" \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 \
    -storepass "$DBG_PASS" -keypass "$DBG_PASS" \
    -dname "CN=Android Debug, O=Android, C=US" >/dev/null
  umask 077
  cat > "$KS_PROPS" <<EOF
# 本地签名凭据 —— 已被 .gitignore 排除，切勿提交
storeFileRelease=../keystore/release.keystore
storePasswordRelease=$REL_PASS
keyAliasRelease=deepseekchat
keyPasswordRelease=$REL_PASS

storeFileDebug=../keystore/debug.keystore
storePasswordDebug=$DBG_PASS
keyAliasDebug=androiddebugkey
keyPasswordDebug=$DBG_PASS
EOF
  chmod 600 "$KS_PROPS"
  log "keystore 生成完成: $KS_DIR"
fi

# ------------------------------------------------------------ 3. 前端构建产物
if [ "${SKIP_WEB_BUILD:-0}" = "1" ] && [ -f "$PROJECT_ROOT/dist/index.html" ]; then
  log "SKIP_WEB_BUILD=1，复用现有 dist/"
else
  log "步骤 1/3：pnpm build（产物 -> dist/）"
  pnpm build
fi
[ -f "$PROJECT_ROOT/dist/index.html" ] || die "dist/index.html 不存在，前端构建失败"

# ------------------------------------------------------ 4. 同步 web 产物到原生工程
log "步骤 2/3：pnpm exec cap sync android（dist -> android/app/src/main/assets/public）"
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
chmod +x ./gradlew
GRADLE_ARGS=("$GRADLE_TASK" "--console=plain")
[ "$EXTRA_ARG" = "--clean" ] && GRADLE_ARGS=("clean" "${GRADLE_ARGS[@]}")

log "步骤 3/3：./gradlew ${GRADLE_ARGS[*]}"
./gradlew "${GRADLE_ARGS[@]}"

APK_PATH="$APK_DIR/$APK_NAME"
[ -f "$APK_PATH" ] || die "构建结束但未找到 APK: $APK_PATH"
APK_PATH="$(readlink -f "$APK_PATH")"
APK_SIZE="$(du -h "$APK_PATH" | cut -f1)"
APK_BYTES="$(stat -c %s "$APK_PATH")"

printf '\n\033[1;32m================ BUILD OK (%s) ================\033[0m\n' "$MODE"
printf 'APK 绝对路径 : %s\n' "$APK_PATH"
printf 'APK 大小     : %s (%s bytes)\n' "$APK_SIZE" "$APK_BYTES"
printf 'build-tools  : %s（钉住档位，不走通配）\n' "$BUILD_TOOLS_VERSION"
# aapt2 只从钉住档位取：人工核对的工具与出包工具必须是同一个（Issue #273 现状第 4 条）
if [ -x "$AAPT2_BIN" ]; then
  printf '包名/版本    : %s\n' "$("$AAPT2_BIN" dump badging "$APK_PATH" 2>/dev/null | grep -E "^package:" || echo 'n/a')"
fi
printf '安装命令     : adb install -r "%s"\n' "$APK_PATH"
printf '\033[1;32m==============================================\033[0m\n'

# ------------------------------------- 4. 发布完整性关卡：android:debuggable 必须为 false
# Issue #60：1.0.0～1.4.0-beta.8 共 15 个已发布包都是 debug 变体产物，带 android:debuggable="true"，
# 任何已授权 adb 的机器都能 run-as 读私有数据。这道关卡读 APK 内的 AndroidManifest.xml（不依赖 aapt2），
# release 模式判不过就直接失败，产物留在原地但不许上传/分发。
log "步骤 4：发布完整性关卡（android:debuggable 必须为 false）"
if node "$PROJECT_ROOT/scripts/check-apk-debuggable.mjs" "$APK_PATH"; then
  DEBUGBLE_STATE=clean
else
  DEBUGBLE_STATE=dirty
fi
if [ "$MODE" = "release" ]; then
  [ "$DEBUGBLE_STATE" = "clean" ] || die "release 产物带 android:debuggable=true，禁止上传 dl / 禁止分发（Issue #60）。
  APK: $APK_PATH
  重出包：cd android && ./gradlew :app:assembleRelease -PartifactVariant=internal"
else
  printf '\033[1;33m[警告] debug 变体天生就是 debuggable：只许本地联调 / 模拟器烟测，禁止上传 dl.rose7.cn、禁止当发布包分发（Issue #60）\033[0m\n'
fi
