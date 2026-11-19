#!/usr/bin/env bash
# 串行跑两档老内核：API31（WebView 91）做 P2 关键档 + P3 弱网 + P4；API33（WebView 109）做 P2 关键档 + P4。
# 一次只跑一台模拟器：每档结束 adb emu kill，等设备列表清空再起下一台。
#
# SDK 位置与 AVD 名都不再写死在这里（issue #278）：SDK 由 scripts/compat/lib/matrix-config.mjs
# 按 matrix.config.json / ANDROID_HOME / ANDROID_SDK_ROOT / $HOME/android-sdk 解析；AVD 名按
# matrix.config.json:avdProfiles 里 api 对应的那一条起（boot.mjs --api <NN>）。
set -u
cd "$(dirname "$0")/../.." || exit 1

CONFIG_CLI="node scripts/compat/lib/matrix-config.mjs"
SDK_ROOT="$($CONFIG_CLI --print sdkRoot)" || { echo "[round] 找不到 Android SDK：请设置 ANDROID_HOME 或 matrix.config.json:sdkRoot"; exit 1; }
case "$SDK_ROOT" in /*|[A-Za-z]:[/\]*) ;; *) echo "[round] SDK 路径解析异常：$SDK_ROOT"; exit 1 ;; esac
export PATH="$SDK_ROOT/platform-tools:$PATH"

kill_emu() {
  adb emu kill >/dev/null 2>&1
  for _ in $(seq 1 30); do
    sleep 2
    if [ -z "$(adb devices | sed -n '2,$p' | tr -d '\r' | grep -w device)" ]; then
      echo "[round] 设备已清空"
      return 0
    fi
  done
  echo "[round] 警告：设备没退干净"
}

echo "===== API31（WebView 91）====="
kill_emu
node scripts/compat/boot.mjs --api 31 || { echo "[round] API31 启动失败"; exit 1; }
bash scripts/compat/run-p2.sh 31 edge-200mb bomb-1000x corrupt-branch
echo "----- API31 P4 -----"
node scripts/compat/p4-layout.mjs --api 31
echo "----- API31 P3 弱网 -----"
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  node scripts/compat/p3-net.mjs --api 31
kill_emu

echo "===== API33（WebView 109）====="
node scripts/compat/boot.mjs --api 33 || { echo "[round] API33 启动失败"; exit 1; }
bash scripts/compat/run-p2.sh 33 edge-200mb bomb-1000x corrupt-branch
echo "----- API33 P4 -----"
node scripts/compat/p4-layout.mjs --api 33
kill_emu
echo "===== ROUND DONE ====="
