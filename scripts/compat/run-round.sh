#!/usr/bin/env bash
# 串行跑两档老内核：API31（WebView 91）做 P2 关键档 + P3 弱网 + P4；API33（WebView 109）做 P2 关键档 + P4。
# 一次只跑一台模拟器：每档结束 adb emu kill，等设备列表清空再起下一台。
set -u
export PATH="/d/android-sdk/platform-tools:$PATH"
cd "$(dirname "$0")/../.." || exit 1

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
node scripts/compat/boot.mjs --avd compat-api31 || { echo "[round] API31 启动失败"; exit 1; }
bash scripts/compat/run-p2.sh 31 edge-200mb bomb-1000x corrupt-branch
echo "----- API31 P4 -----"
node scripts/compat/p4-layout.mjs --api 31
echo "----- API31 P3 弱网 -----"
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  node scripts/compat/p3-net.mjs --api 31
kill_emu

echo "===== API33（WebView 109）====="
node scripts/compat/boot.mjs --avd deepseek-api33 || { echo "[round] API33 启动失败"; exit 1; }
bash scripts/compat/run-p2.sh 33 edge-200mb bomb-1000x corrupt-branch
echo "----- API33 P4 -----"
node scripts/compat/p4-layout.mjs --api 33
kill_emu
echo "===== ROUND DONE ====="
