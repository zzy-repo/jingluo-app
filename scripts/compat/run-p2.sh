#!/usr/bin/env bash
# 串行跑一组归档：每档前重启 App、清 logcat，跑完落 evidence。用法：run-p2.sh 30 [archives...]
set -u
export PATH="/d/android-sdk/platform-tools:$PATH"
API="$1"; shift
ARCHIVES=("$@")
if [ ${#ARCHIVES[@]} -eq 0 ]; then
  ARCHIVES=(ctrl-1mb ctrl-10mb ctrl-50mb edge-200mb bomb-1000x corrupt-branch truncated)
fi
PKG=com.example.deepseekchat
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
