#!/usr/bin/env bash
# 串行跑一组归档：每档前重启 App、清 logcat，跑完落 evidence。用法：run-p2.sh 30 [archives...]
set -u
export PATH="/d/android-sdk/platform-tools:$PATH"
API="$1"; shift
ARCHIVES=("$@")
if [ ${#ARCHIVES[@]} -eq 0 ]; then
  ARCHIVES=(ctrl-1mb ctrl-10mb ctrl-50mb edge-200mb bomb-1000x corrupt-branch truncated)
fi
# 包名不写死：与 android/app/build.gradle 同源（config/appIdentity.json，Issue #271）。
# 必须从仓库根执行（下面的 node 用相对路径读配置，本脚本本来也按仓库根相对路径跑 p2-import.mjs）。
PKG="$(node -p "require('./config/appIdentity.json').applicationId")"
if [ -z "${PKG}" ]; then
  echo "[run-p2] 读不到 config/appIdentity.json 的 applicationId，中止" >&2
  exit 2
fi
for a in "${ARCHIVES[@]}"; do
  echo "======== $a ========"
  adb shell am force-stop $PKG
  adb logcat -c
  sleep 1
  adb shell am start -W -n $PKG/.MainActivity >/dev/null 2>&1
  sleep 6
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    node scripts/compat/p2-import.mjs --api "$API" --archive "$a" --timeout 150 2>&1 | grep -v UNDICI | tail -30
done
echo "======== ALL DONE ========"
