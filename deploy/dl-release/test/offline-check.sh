#!/usr/bin/env bash
# dl-release 离线端到端验证：真服务端 + 真 APK + 临时状态目录。
# 完全不碰线上 /var/www/dl、不联网、不改 systemd。
#
# 用法：
#   AAPT2=/path/to/aapt2 \
#   APK_NO_MARKER=/path/deepseek-chat-1.4.0-beta.4.apk \
#   APK_NO_MARKER_OLD=/path/deepseek-chat-1.4.0-beta.3.apk \
#   APK_WITH_MARKER=/path/marker.apk \
#   APK_DEBUGGABLE=/path/deepseek-chat-1.4.0-beta.8.apk \
#   bash deploy/dl-release/test/offline-check.sh
#
# 缺 AAPT2 或缺其中任一 APK 时跳过对应用例（不会假绿：会明确打印 SKIP 原因）。
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRV_DIR=$(cd "$HERE/.." && pwd)
REPO=$(cd "$SRV_DIR/../.." && pwd)

AAPT2=${AAPT2:-}
APK_NO_MARKER=${APK_NO_MARKER:-}
APK_NO_MARKER_OLD=${APK_NO_MARKER_OLD:-}
APK_WITH_MARKER=${APK_WITH_MARKER:-}
APK_DEBUGGABLE=${APK_DEBUGGABLE:-}

PORT=${PORT:-8788}
BASE="http://127.0.0.1:${PORT}/api/v1/release"
PASS=0; FAIL=0; SKIP=0
ok()  { echo "  [PASS] $*"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
skp() { echo "  [SKIP] $*"; SKIP=$((SKIP+1)); }
hdr() { echo; echo "=== $* ==="; }

command -v node >/dev/null || { echo "需要 node"; exit 2; }
[ -n "$AAPT2" ] && [ -x "$AAPT2" ] || { echo "需要 AAPT2=<可执行 aapt2 路径>"; exit 2; }

WORK=$(mktemp -d /tmp/dl-offline.XXXXXX)
trap 'rm -rf "$WORK"; [ -n "${SRV_PID:-}" ] && kill "${SRV_PID}" 2>/dev/null' EXIT

mkdir -p "$WORK/apk"
TOKEN="offline-test-token-$(date +%s)"
printf '%s\n' "$TOKEN" > "$WORK/token"; chmod 600 "$WORK/token"
printf '{"latest":"0.0.0","releases":[]}\n' > "$WORK/releases.json"
printf '{"apks":{}}\n' > "$WORK/variant-allowlist.json"

DL_TOKEN_FILE="$WORK/token" \
DL_APK_DIR="$WORK/apk" \
DL_RELEASES_JSON="$WORK/releases.json" \
DL_VARIANTS_FILE="$WORK/variant-allowlist.json" \
DL_AAPT2="$AAPT2" \
DL_LISTEN_PORT="$PORT" \
DL_LISTEN_HOST=127.0.0.1 \
DL_RATE_LIMIT_MAX=1000 \
node "$SRV_DIR/server.mjs" > "$WORK/server.log" 2>&1 &
SRV_PID=$!

for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break
  sleep 0.2
done
curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" || { echo "服务没起来"; cat "$WORK/server.log"; exit 2; }
echo "服务已启动 pid=$SRV_PID port=$PORT 工作目录=$WORK"

sha_of() { sha256sum "$1" | cut -d' ' -f1; }
manifest() { python3 -c "
import json,sys;d=json.load(open('$WORK/releases.json'));
print(json.dumps({k:v for k,v in d.items() if k!='releases'}));
print('records=',len(d['releases']));
[print(json.dumps({k:r.get(k) for k in ('version','versionCode','sha256','artifactVariant','artifactVariantSource')},ensure_ascii=False)) for r in d['releases']]"; }
post() { # post <apk> <meta> [token]
  local tok=${3:-$TOKEN}
  curl -sS -X POST "$BASE" -H "Authorization: Bearer $tok" \
    -F "apk=@$1" -F "meta=$2" -w '\n__HTTP__%{http_code}'
}
code_of() { printf '%s' "$1" | sed -n 's/.*__HTTP__//p'; }
body_of() { printf '%s' "$1" | sed 's/__HTTP__.*//'; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d$1,ensure_ascii=False))"; }

# ---------------------------------------------------------------- 1) 无标记包 → unknown
hdr "1) 无标记的真实 APK → sha256 有、artifactVariant 必须缺失（不默认 standard）"
if [ -n "$APK_NO_MARKER" ] && [ -f "$APK_NO_MARKER" ]; then
  LOCAL_SHA=$(sha_of "$APK_NO_MARKER")
  OUT=$(post "$APK_NO_MARKER" '{"changes":["offline case1"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C"; echo "  body=$B"
  [ "$C" = "200" ] && ok "上传 200" || bad "上传应 200，实际 $C"
  RSHA=$(printf '%s' "$B" | jget '["sha256"]' | tr -d '"')
  [ "$RSHA" = "$LOCAL_SHA" ] && ok "服务端 sha256 == 本地 sha256sum" || bad "sha256 不一致 服务端=$RSHA 本地=$LOCAL_SHA"
  [ "$(printf '%s' "$B" | jget '["artifactVariant"]')" = "null" ] && ok "响应 artifactVariant=null（unknown）" || bad "响应 artifactVariant 不该有值"
  python3 - "$WORK/releases.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); r=d["releases"][0]
assert "artifactVariant" not in r, f"记录里不该出现 artifactVariant: {r}"
assert "artifactVariantSource" not in r, "记录里不该出现 artifactVariantSource"
assert len(r.get("sha256",""))==64, "记录必须带 sha256"
assert r["versionCode"]==11, r["versionCode"]
print("  [PASS] 记录：有 sha256、无 artifactVariant（unknown 不写字段）")
PY
  [ $? -eq 0 ] && PASS=$((PASS+1)) || bad "记录断言失败"
else
  skp "未提供 APK_NO_MARKER"
fi

# ---------------------------------------------------------------- 2) 降级仍被拒
hdr "2) 更低 versionCode 的真实 APK → 409（变体改造没有放松防降级）"
CUR_MAX=$(python3 -c "
import json
d=json.load(open('$WORK/releases.json'))
print(max([int(r.get('versionCode') or 0) for r in d['releases']] or [0]))")
if [ -n "$APK_NO_MARKER_OLD" ] && [ -f "$APK_NO_MARKER_OLD" ] && [ "$CUR_MAX" -ge 11 ]; then
  OUT=$(post "$APK_NO_MARKER_OLD" '{"changes":["offline case2"],"artifactVariant":"internal"}')
  C=$(code_of "$OUT"); echo "  http=$C body=$(body_of "$OUT")"
  [ "$C" = "409" ] && ok "降级 409" || bad "降级应 409，实际 $C"
  echo "  注：meta 里谎报 artifactVariant=internal，服务端应忽略（见日志 meta_variant_ignored）"
else
  skp "未提供 APK_NO_MARKER_OLD"
fi

# ---------------------------------------------------------------- 3) sha256 白名单登记旧包
hdr "3) 白名单登记（历史包补救）→ artifactVariant=internal / source=sha256-allowlist"
if [ -n "$APK_NO_MARKER" ] && [ -f "$APK_NO_MARKER" ]; then
  LOCAL_SHA=$(sha_of "$APK_NO_MARKER")
  python3 - "$WORK/variant-allowlist.json" "$LOCAL_SHA" <<'PY'
import json,sys
p,sha=sys.argv[1],sys.argv[2]
json.dump({"apks":{sha:{"variant":"internal","version":"1.4.0-beta.4","note":"offline test: 历史包补救"}}},
          open(p,"w",encoding="utf-8"), indent=2, ensure_ascii=False)
PY
  OUT=$(post "$APK_NO_MARKER" '{"changes":["offline case3"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "200" ] && ok "同版本重传 200（幂等）" || bad "应 200，实际 $C"
  [ "$(printf '%s' "$B" | jget '["artifactVariant"]')" = '"internal"' ] && ok "白名单生效 → internal" || bad "白名单未生效"
  [ "$(printf '%s' "$B" | jget '["artifactVariantSource"]')" = '"sha256-allowlist"' ] && ok "source=sha256-allowlist（来源留痕）" || bad "source 不对"
  N=$(python3 -c "import json;print(len(json.load(open('$WORK/releases.json'))['releases']))")
  [ "$N" = "1" ] && ok "幂等覆盖未产生重复记录" || bad "记录数应 1，实际 $N"
else
  skp "未提供 APK_NO_MARKER"
fi

# ---------------------------------------------------------------- 4) APK 内标记优先
hdr "4) 带构造标记的 APK → artifactVariant=internal / source=apk-manifest（标记优先）"
if [ -n "$APK_WITH_MARKER" ] && [ -f "$APK_WITH_MARKER" ]; then
  OUT=$(post "$APK_WITH_MARKER" '{"changes":["offline case4"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "200" ] && ok "上传 200" || bad "应 200，实际 $C"
  [ "$(printf '%s' "$B" | jget '["artifactVariant"]')" = '"internal"' ] && ok "标记解析 → internal" || bad "标记未被识别"
  [ "$(printf '%s' "$B" | jget '["artifactVariantSource"]')" = '"apk-manifest"' ] && ok "source=apk-manifest" || bad "source 应为 apk-manifest"

  # 5) 标记与白名单矛盾 → 409
  hdr "5) 标记 internal 但白名单写 standard → 409 VARIANT_CONFLICT（不静默取一个）"
  MSHA=$(sha_of "$APK_WITH_MARKER")
  python3 - "$WORK/variant-allowlist.json" "$MSHA" <<'PY'
import json,sys
p,sha=sys.argv[1],sys.argv[2]
d=json.load(open(p)); d.setdefault("apks",{})[sha]={"variant":"standard","note":"offline test: 故意矛盾"}
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PY
  OUT=$(post "$APK_WITH_MARKER" '{"changes":["offline case5"]}')
  C=$(code_of "$OUT"); echo "  http=$C body=$(body_of "$OUT")"
  [ "$C" = "409" ] && ok "矛盾 → 409" || bad "应 409，实际 $C"
  python3 -c "
import json;d=json.load(open('$WORK/releases.json'));r=d['releases'][0]
assert r.get('artifactVariant')=='internal', r
print('  [PASS] 拒绝后原记录未被污染（仍是 internal）')" && PASS=$((PASS+1)) || bad "矛盾请求污染了记录"
else
  skp "未提供 APK_WITH_MARKER（跳过带标记用例 + 冲突用例）"
fi

# ------------------------------------------------- 6) 认证与非法包 / 6b) debuggable 拒收
hdr "6) 错令牌 → 401；7) 非 APK → 400"
printf 'x\n' > "$WORK/tok.txt"
OUT=$(post "$WORK/tok.txt" '{"changes":[]}' "wrong-token")
C=$(code_of "$OUT"); [ "$C" = "401" ] && ok "错令牌 401" || bad "错令牌应 401，实际 $C"
printf 'not an apk\n' > "$WORK/x.txt"
OUT=$(post "$WORK/x.txt" '{"changes":[]}')
C=$(code_of "$OUT"); [ "$C" = "400" ] && ok "非 APK 400" || bad "非 APK 应 400，实际 $C"

hdr "6b) debuggable 的真 APK → 400 APK_DEBUGGABLE（Issue #60 硬门禁）"
if [ -n "$APK_DEBUGGABLE" ] && [ -f "$APK_DEBUGGABLE" ]; then
  # 先本地确认这个样例确实是 debuggable（用例本身不能被"挑错样本"糊过去）
  if node "$REPO/scripts/check-apk-debuggable.mjs" "$APK_DEBUGGABLE" >/dev/null 2>&1; then
    bad "样例 $APK_DEBUGGABLE 不是 debuggable 包，用例无效（换一个真 debuggable 的历史包）"
  else
    ok "样例判定为 debuggable（本地关卡退出码非 0）"
  fi
  BEFORE=$(sha_of "$WORK/releases.json")
  OUT=$(post "$APK_DEBUGGABLE" '{"version":"9.9.9-debuggable-test","versionCode":99,"changes":["should-be-rejected"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "400" ] && ok "上传被拒 400" || bad "debuggable 包应 400，实际 $C"
  [ "$(printf '%s' "$B" | jget '["error"]' | tr -d '"')" = "APK_DEBUGGABLE" ] \
    && ok "错误码 APK_DEBUGGABLE" || bad "错误码不是 APK_DEBUGGABLE"
  [ "$(sha_of "$WORK/releases.json")" = "$BEFORE" ] && ok "releases.json 未被改动" || bad "被拒的包改动了清单"
  ls "$WORK"/apk/*9.9.9* >/dev/null 2>&1 && bad "被拒的 APK 残留在发布目录" || ok "被拒的 APK 未落盘"
  grep -q reject_debuggable "$WORK/server.log" 2>/dev/null && ok "日志有 reject_debuggable" || bad "日志缺 reject_debuggable"
else
  skp "未提供 APK_DEBUGGABLE（拿 1.4.0-beta.8 这类历史 debuggable 包，用例会真实跑一遍拒收）"
fi

# ------------------------------------------- 7b/7c) buildType 门禁（Issue #330）
hdr "7b) 非法 buildType → 400 BAD_BUILD_TYPE，且 releases.json 字节不变、APK 不落盘"
if [ -n "$APK_NO_MARKER" ] && [ -f "$APK_NO_MARKER" ]; then
  BEFORE_SHA=$(sha_of "$WORK/releases.json")
  BEFORE_N=$(ls "$WORK/apk" | wc -l)
  OUT=$(post "$APK_NO_MARKER" '{"buildType":"release","changes":["should-be-rejected"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "400" ] && ok "非法 buildType 400" || bad "非法 buildType 应 400，实际 $C"
  [ "$(printf '%s' "$B" | jget '["code"]' | tr -d '"')" = "BAD_BUILD_TYPE" ] \
    && ok "顶层 code=BAD_BUILD_TYPE" || bad "顶层 code 不是 BAD_BUILD_TYPE"
  [ "$(sha_of "$WORK/releases.json")" = "$BEFORE_SHA" ] && ok "releases.json 字节不变（sha256 相同）" \
    || bad "被拒的上传改动了清单"
  [ "$(ls "$WORK/apk" | wc -l)" = "$BEFORE_N" ] && ok "APK 未落盘（含无 .upload-* 残留）" \
    || bad "被拒的 APK 落盘了"
  grep -q reject_build_type "$WORK/server.log" && ok "日志有 reject_build_type" || bad "日志缺 reject_build_type"

  hdr "7c) 历史清单脏（旧条目 buildType=\"release\"）→ 409 MANIFEST_DIRTY，APK 与清单都不落盘"
  cp "$WORK/releases.json" "$WORK/releases.clean.json"
  python3 - "$WORK/releases.json" <<'PYJSON'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d["releases"].append({
    "version":"0.9.9","versionCode":0,"releasedAt":"2026-11-01T10:00:00+08:00",
    "file":"apk/deepseek-chat-0.9.9.apk","size":1,"md5":"0"*32,
    "changes":["历史脏条目：buildType 写成了 Gradle 构建类型"],"buildType":"release","breaking":False,
})
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PYJSON
  DIRTY_SHA=$(sha_of "$WORK/releases.json")
  DIRTY_N=$(ls "$WORK/apk" | wc -l)
  OUT=$(post "$APK_NO_MARKER" '{"buildType":"stable","changes":["should-be-rejected-too"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "409" ] && ok "脏清单 409" || bad "脏清单应 409，实际 $C"
  [ "$(printf '%s' "$B" | jget '["code"]' | tr -d '"')" = "MANIFEST_DIRTY" ] \
    && ok "顶层 code=MANIFEST_DIRTY" || bad "顶层 code 不是 MANIFEST_DIRTY"
  [ "$(sha_of "$WORK/releases.json")" = "$DIRTY_SHA" ] && ok "releases.json 字节不变（没把脏清单写得更脏）" \
    || bad "409 之后清单被改动了"
  [ "$(ls "$WORK/apk" | wc -l)" = "$DIRTY_N" ] && ok "APK 未落盘（校验在 rename 之前）" \
    || bad "409 之后 APK 落盘了"
  grep -q reject_manifest_dirty "$WORK/server.log" && ok "日志有 reject_manifest_dirty" || bad "日志缺 reject_manifest_dirty"
  # 还原干净清单，后面的「清单校验器自检」才有意义
  cp "$WORK/releases.clean.json" "$WORK/releases.json"
else
  skp "未提供 APK_NO_MARKER（跳过 #330 的 400/409 用例）"
fi

# ---------------------------------------------------------------- 8) 清单校验器自检
hdr "8) 产出的 releases.json 必须通过清单校验器"
node "$REPO/scripts/validate-releases-manifest.mjs" "$WORK/releases.json" && ok "清单校验通过" || bad "清单校验失败"
hdr "最终清单"
manifest

hdr "服务端日志（关键字）"
grep -E "variant_resolved|meta_variant_ignored|reject_variant_conflict|release_ok" "$WORK/server.log" | tail -8

hdr "结果"
echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
