#!/usr/bin/env bash
# compat31 (Android 12 / WebView 91) 上的 CDP 包装：WebView 进程可能重启导致 socket name 变化，
# 每次先按当前 pid 重新 adb forward，再跑真正的测量脚本。
set -euo pipefail
export PATH="/root/android-sdk/platform-tools:$PATH"
pid="$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1 | sed 's/.*_//')"
[ -n "$pid" ] || { echo "no webview devtools socket" >&2; exit 2; }
adb forward --remove-all >/dev/null
adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid" >/dev/null
echo "[wv91] webview pid=$pid" >&2
exec node "$@"
