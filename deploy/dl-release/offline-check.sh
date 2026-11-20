#!/usr/bin/env bash
# 兼容入口：#620 的单里把路径写成了 deploy/dl-release/offline-check.sh，
# 真实实现一直在 test/ 下（与被服务端用例同目录）。这里只做转发，避免「按单里写的命令跑 → 找不到文件」。
#
#   AAPT2=… APK_STANDARD=… APK_INTERNAL=… bash deploy/dl-release/offline-check.sh
#
# 参数/环境变量与真实脚本完全一致，见 test/offline-check.sh 头部。
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec bash "$HERE/test/offline-check.sh" "$@"
