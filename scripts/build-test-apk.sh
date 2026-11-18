#!/usr/bin/env bash
# 构建「测试专用」APK：两个服务地址在**构建期**指向本地 mock（模拟器侧 http://10.0.2.2:<port>）。
#
# 硬约束（本任务）：
#   - 只用 debug 签名（android/keystore/debug.keystore），不碰 release 证书、不发版
#   - 不改 versionName / versionCode
#   - 产物名带 mock 标记，避免和正式包混淆
#
# 用法：
#   MOCK_PORT=8099 ./scripts/build-test-apk.sh
#
# 前置：在 test/pay-mock-device 分支的 worktree 里执行，且已 node scripts/apply-url-override.mjs。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MOCK_PORT="${MOCK_PORT:-8099}"
BASE="http://10.0.2.2:${MOCK_PORT}"

export ANDROID_HOME="${ANDROID_HOME:-/root/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

log() { printf '\n\033[1;36m[test-apk] %s\033[0m\n' "$*"; }

log "1/4 打 URL 覆盖补丁（幂等）"
node scripts/apply-url-override.mjs

log "2/4 前端构建：INTERNAL_BUILD=1 + 覆盖两个服务地址 → $BASE"
# INTERNAL_BUILD=1：内测包默认渠道 = ours（设置页里就是「我们的渠道」）
TEST_INVITE_API_BASE="$BASE" TEST_OURS_API_BASE="$BASE" INTERNAL_BUILD=1 \
  NODE_ENV=production npx rspack build -c rspack.config.ts

log "3/4 验证覆盖确实进了产物（dist 里必须出现 mock 地址，且不能出现正式地址作为唯一来源）"
if grep -rq "10.0.2.2:${MOCK_PORT}" dist/static/js; then
  echo "     ✓ dist 里找到 $BASE"
else
  echo "     ✗ dist 里没有覆盖地址，构建白做了" >&2
  exit 1
fi

log "4/4 cap sync + Gradle assembleDebug（debug 签名，artifactVariant=internal）"
npx cap sync android
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
cd android
./gradlew assembleDebug -PartifactVariant=internal --console=plain

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || { echo "找不到 APK: $APK" >&2; exit 1; }
OUT="$ROOT/dist-mock-device/app-debug-mock-device.apk"
mkdir -p "$(dirname "$OUT")"
cp "$APK" "$OUT"

printf '\n\033[1;32m================ TEST APK OK ================\033[0m\n'
printf 'APK      : %s\n' "$OUT"
printf 'SHA256   : %s\n' "$(sha256sum "$OUT" | cut -d' ' -f1)"
printf '大小     : %s\n' "$(du -h "$OUT" | cut -f1)"
APKSIGNER="$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
if [ -n "$APKSIGNER" ]; then
  printf '签名     : %s\n' "$("$APKSIGNER" verify --print-certs "$OUT" 2>/dev/null | head -2 | tr '\n' ' ')"
fi
printf '\033[1;32m=============================================\033[0m\n'
