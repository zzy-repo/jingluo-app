#!/usr/bin/env bash
# dl-release 离线端到端验证：真服务端 + 真 APK + 临时状态目录。
# 完全不碰线上 /var/www/dl、不联网、不改 systemd。
#
# 用法：
#   AAPT2=/path/to/aapt2 \
#   APK_STANDARD=/path/deepseek-chat-1.4.0.apk \        # 真 standard 包、**非** debuggable（公网正例）
#   APK_INTERNAL=/path/deepseek-chat-1.4.0-beta.10.apk \# 真 internal 包、**非** debuggable（公网必须拒 / 私有必须收）
#   APK_NO_MARKER=/path/deepseek-chat-1.3.0.apk \       # 无变体标记的**非 debuggable** 历史包（unknown → 必须拒）
#   APK_DEBUGGABLE=/path/deepseek-chat-1.4.0-beta.8.apk \# 真 debuggable 包（必须拒）
#   bash deploy/dl-release/test/offline-check.sh
#
# 缺 AAPT2 或缺某个 APK 时跳过对应用例（不会假绿：会明确打印 SKIP 原因）。
# 注意：debuggable 包会被 Issue #60 的闸**先于**变体闸拒收，所以「变体/白名单」那几条只接受
# 非 debuggable 的样本；给错了样本会打印 SKIP 原因 + 指出等价用例在哪（不静默当通过）。
#
# ## #620 之后这份脚本的形状变了（改动要点）
#
# 原用例 3 是「白名单把历史包登记成 internal → 上传 200 → internal 进了**公网**清单」，
# 也就是 #601 事故的复刻动作本身。裁决 #614 决定 3 之后这条路必须被**接口拒绝**，所以：
#   · 用例 3 改成：同一份登记 → 公网端点 **400 VARIANT_NOT_PUBLIC**、公网清单 sha256 不变；
#   · 紧接着用**私有端点**（POST /api/v1/release/private）把同一个包写进私有清单 → 200，
#     而公网清单 sha256 仍然不变（「私有清单写入成功、公网零影响」这条验收点）；
#   · 「干净 → 注入 internal POST → 4xx + 公网清单 sha256 不变 → 还原」作为独立的一节打印，
#     sha256 前后**当场打出来**（不是「看起来没变」）。
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRV_DIR=$(cd "$HERE/.." && pwd)
REPO=$(cd "$SRV_DIR/../.." && pwd)

AAPT2=${AAPT2:-}
APK_STANDARD=${APK_STANDARD:-}
APK_NO_MARKER=${APK_NO_MARKER:-}
APK_INTERNAL=${APK_INTERNAL:-}
APK_DEBUGGABLE=${APK_DEBUGGABLE:-}

PORT=${PORT:-8788}
BASE="http://127.0.0.1:${PORT}/api/v1/release"
BASE_PRIV="http://127.0.0.1:${PORT}/api/v1/release/private"
PASS=0; FAIL=0; SKIP=0
ok()  { echo "  [PASS] $*"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
skp() { echo "  [SKIP] $*"; SKIP=$((SKIP+1)); }
hdr() { echo; echo "=== $* ==="; }

command -v node >/dev/null || { echo "需要 node"; exit 2; }
command -v curl >/dev/null || { echo "需要 curl"; exit 2; }
[ -n "$AAPT2" ] && [ -x "$AAPT2" ] || { echo "需要 AAPT2=<可执行 aapt2 路径>"; exit 2; }

WORK=$(mktemp -d /tmp/dl-offline.XXXXXX)
trap 'rm -rf "$WORK"; [ -n "${SRV_PID:-}" ] && kill "${SRV_PID}" 2>/dev/null' EXIT

# 目录形状 = 线上形状：webroot 是公网站点根，私有根在 webroot **之外**（#609 的核心）
WEB="$WORK/webroot"
PRIV="$WORK/private"
mkdir -p "$WEB/apk"

TOKEN="offline-test-token-$(date +%s)"
printf '%s\n' "$TOKEN" > "$WORK/token"; chmod 600 "$WORK/token"
printf '{"latest":"0.0.0","releases":[]}\n' > "$WEB/releases.json"
printf '{"apks":{}}\n' > "$WORK/variant-allowlist.json"

DL_TOKEN_FILE="$WORK/token" \
DL_WEBROOT="$WEB" \
DL_APK_DIR="$WEB/apk" \
DL_RELEASES_JSON="$WEB/releases.json" \
DL_PRIVATE_ROOT="$PRIV" \
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
echo "  webroot=$WEB（公网清单 $WEB/releases.json）"
echo "  私有根=$PRIV（私有清单 $PRIV/releases.internal.json，**在 webroot 之外**）"

sha_of() { sha256sum "$1" | cut -d' ' -f1; }
# 公网清单的“当前指纹”（不存在时打印 MISSING，用例里据此断言“一个字节都没动”）
pub_sha() { [ -f "$WEB/releases.json" ] && sha_of "$WEB/releases.json" || echo MISSING; }
manifest() { python3 -c "
import json;d=json.load(open('$WEB/releases.json'));
print(json.dumps({k:v for k,v in d.items() if k!='releases'}));
print('records=',len(d['releases']),'internal=',len([r for r in d['releases'] if r.get('artifactVariant') not in (None,'standard')]));
[print(json.dumps({k:r.get(k) for k in ('version','versionCode','buildType','artifactVariant','artifactVariantSource')},ensure_ascii=False)) for r in d['releases']]"; }
priv_manifest() { python3 -c "
import json,os,sys
p='$PRIV/releases.internal.json'
if not os.path.exists(p): print('MISSING'); sys.exit(0)
d=json.load(open(p));print(json.dumps({k:v for k,v in d.items() if k!='releases'}));
print('records=',len(d['releases']));
[print(json.dumps({k:r.get(k) for k in ('version','versionCode','buildType','artifactVariant')},ensure_ascii=False)) for r in d['releases']]"; }
post() { # post <url> <apk> <meta> [token]
  local url=$1 apk=$2 meta=$3 tok=${4:-$TOKEN}
  curl -sS -X POST "$url" -H "Authorization: Bearer $tok" \
    -F "apk=@$apk" -F "meta=$meta" -w '\n__HTTP__%{http_code}'
}
code_of() { printf '%s' "$1" | sed -n 's/.*__HTTP__//p'; }
body_of() { printf '%s' "$1" | sed 's/__HTTP__.*//'; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d$1,ensure_ascii=False))"; }
# 短码：新错误码（#330/#620）同时给顶层 code，老错误码只写 error.code —— 统一取
ecode() { printf '%s' "$1" | python3 -c "import json,sys
d=json.load(sys.stdin)
print(d.get('code') or (d.get('error') or {}).get('code') or '')"; }
apk_count() { ls "$WEB/apk" 2>/dev/null | wc -l; }
vc_of() { "$AAPT2" dump badging "$1" 2>/dev/null | head -1 | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p"; }
vc_max() { python3 -c "
import json
d=json.load(open('$WEB/releases.json'))
print(max([int(r.get('versionCode') or 0) for r in d['releases']] or [0]))"; }
allowlist_set() { # allowlist_set <apk> <variant>
  local sha; sha=$(sha_of "$1")
  python3 - "$WORK/variant-allowlist.json" "$sha" "$2" <<'PY'
import json,sys
p,sha,variant=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p)); d.setdefault("apks",{})[sha]={"variant":variant,"note":"offline test"}
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PY
}

# ---------------------------------------------------------------- 1) 公网正例：真 standard 包
hdr "1) 真 standard 包 → 200，写进公网清单（artifactVariant=standard / source=apk-manifest）"
if [ -n "$APK_STANDARD" ] && [ -f "$APK_STANDARD" ]; then
  LOCAL_SHA=$(sha_of "$APK_STANDARD")
  OUT=$(post "$BASE" "$APK_STANDARD" '{"buildType":"stable","changes":["offline case1"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C"; echo "  body=$B"
  [ "$C" = "200" ] && ok "上传 200" || bad "standard 包应 200，实际 $C"
  [ "$(printf '%s' "$B" | jget '["sha256"]' | tr -d '"')" = "$LOCAL_SHA" ] \
    && ok "服务端 sha256 == 本地 sha256sum" || bad "sha256 不一致"
  [ "$(printf '%s' "$B" | jget '["artifactVariant"]')" = '"standard"' ] && ok "变体=standard" || bad "变体不是 standard"
  [ "$(printf '%s' "$B" | jget '["artifactVariantSource"]')" = '"apk-manifest"' ] && ok "source=apk-manifest" || bad "source 不对"
  python3 - "$WEB/releases.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); r=d["releases"][0]
assert r["artifactVariant"]=="standard", r
assert r["buildType"]=="stable", r
assert len(r.get("sha256",""))==64, "记录必须带 sha256"
assert r.get("file","").startswith("apk/"), r
print("  [PASS] 记录：standard + stable + sha256 齐全")
PY
  [ $? -eq 0 ] && PASS=$((PASS+1)) || bad "记录断言失败"
else
  skp "未提供 APK_STANDARD（公网正例跳过）"
fi

# --- 样本可用性判定（debuggable 包会被 Issue #60 的闸先拦下，用它验变体闸等于什么都没验）
not_debuggable() { node "$REPO/scripts/check-apk-debuggable.mjs" "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- 2) 原用例 1：无标记包 → unknown
hdr "2) 无标记的历史包 → 公网端点 400 VARIANT_NOT_PUBLIC（unknown **不默认 standard**）"
if [ -n "$APK_NO_MARKER" ] && [ -f "$APK_NO_MARKER" ]; then
  if not_debuggable "$APK_NO_MARKER"; then
    BEFORE_SHA=$(pub_sha); BEFORE_N=$(apk_count)
    echo "  注入前 公网清单 sha256=$BEFORE_SHA"
    OUT=$(post "$BASE" "$APK_NO_MARKER" '{"buildType":"stable","changes":["offline case2"]}')
    C=$(code_of "$OUT"); B=$(body_of "$OUT")
    echo "  http=$C body=$B"
    [ "$C" = "400" ] && ok "unknown 变体 400" || bad "unknown 变体应 400，实际 $C"
    [ "$(ecode "$B")" = "VARIANT_NOT_PUBLIC" ] && ok "code=VARIANT_NOT_PUBLIC" || bad "code 不是 VARIANT_NOT_PUBLIC（$(ecode "$B")）"
    [ "$(pub_sha)" = "$BEFORE_SHA" ] && ok "公网清单 sha256 不变（$BEFORE_SHA）" || bad "被拒的上传改动了公网清单"
    [ "$(apk_count)" = "$BEFORE_N" ] && ok "APK 未落盘（含无 .upload-* 残留）" || bad "被拒的 APK 落盘了"
    grep -q reject_variant_target "$WORK/server.log" && ok "日志有 reject_variant_target" || bad "日志缺 reject_variant_target"
  else
    skp "APK_NO_MARKER 是 debuggable 包 → 会被 Issue #60 的闸先拒，验不到变体闸（换一个非 debuggable 的无标记历史包）"
  fi
else
  skp "未提供 APK_NO_MARKER"
fi

# ---------------------------------------------------------------- 3) 白名单登记 standard（历史包补救）
hdr "3) 白名单把无标记的历史包登记为 standard → 公网 200（服务器侧信任来源，source=sha256-allowlist）"
if [ -n "$APK_NO_MARKER" ] && [ -f "$APK_NO_MARKER" ] && not_debuggable "$APK_NO_MARKER"; then
  allowlist_set "$APK_NO_MARKER" standard
  OUT=$(post "$BASE" "$APK_NO_MARKER" '{"buildType":"stable","changes":["offline case3"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "200" ] && ok "登记 standard 后 200" || bad "应 200，实际 $C"
  [ "$(printf '%s' "$B" | jget '["artifactVariant"]')" = '"standard"' ] && ok "白名单生效 → standard" || bad "白名单未生效"
  [ "$(printf '%s' "$B" | jget '["artifactVariantSource"]')" = '"sha256-allowlist"' ] \
    && ok "source=sha256-allowlist（来源留痕）" || bad "source 不对"
else
  skp "未提供可用的 APK_NO_MARKER（非 debuggable 的无标记历史包）"
fi

# ---------------------------------------------------------------- 4) 防降级仍然有效
hdr "4) 防降级：清单里已有 versionCode 更大的记录 → 409 VERSION_CONFLICT（变体闸没有放松它）"
if [ -n "$APK_STANDARD" ] && [ -f "$APK_STANDARD" ]; then
  # 造一个 versionCode 更大的标准记录（真实历史包都在 18 以下，不造就没法在原地验降级）
  cp "$WEB/releases.json" "$WORK/releases.before-downgrade.json"
  python3 - "$WEB/releases.json" <<'PYJSON'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d["releases"].insert(0, {
    "version":"2.0.0","versionCode":99,"releasedAt":"2026-11-21T10:00:00+08:00",
    "file":"apk/deepseek-chat-2.0.0.apk","size":4096,"md5":"0"*32,"sha256":"b"*64,
    "changes":["离线用例：造一个更高的 versionCode 来验防降级"],"buildType":"stable","breaking":False,
    "artifactVariant":"standard","artifactVariantSource":"apk-manifest",
})
d["latest"]="2.0.0"
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PYJSON
  BEFORE_SHA=$(pub_sha); BEFORE_N=$(apk_count)
  OUT=$(post "$BASE" "$APK_STANDARD" '{"buildType":"stable","changes":["offline case4"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "409" ] && ok "降级 409" || bad "降级应 409，实际 $C"
  [ "$(ecode "$B")" = "VERSION_CONFLICT" ] && ok "code=VERSION_CONFLICT" || bad "code 不是 VERSION_CONFLICT（$(ecode "$B")）"
  [ "$(pub_sha)" = "$BEFORE_SHA" ] && ok "公网清单 sha256 不变" || bad "被拒的上传改动了公网清单"
  [ "$(apk_count)" = "$BEFORE_N" ] && ok "APK 未落盘" || bad "被拒的 APK 落盘了"
  cp "$WORK/releases.before-downgrade.json" "$WEB/releases.json"
else
  skp "未提供 APK_STANDARD（跳过防降级用例）"
fi

# ------------------------------------------- 5) 【本单核心】负向对照：internal 必须进不了公网清单
hdr "5) 【负向对照】internal 真包 → 公网 4xx 且公网清单 **sha256 不变**；私有端点 200 写私有清单（公网零影响）"
if [ -n "$APK_INTERNAL" ] && [ -f "$APK_INTERNAL" ]; then
  if not_debuggable "$APK_INTERNAL"; then
    BEFORE_SHA=$(pub_sha); BEFORE_N=$(apk_count)
    echo "  注入前  公网清单 sha256=$BEFORE_SHA  apk/ 文件数=$BEFORE_N"

    # ① 注入：真 internal 包 POST 到公网端点 → 必须 4xx，公网清单**字节级**不动
    OUT=$(post "$BASE" "$APK_INTERNAL" '{"buildType":"stable","changes":["must-be-rejected"]}')
    C=$(code_of "$OUT"); B=$(body_of "$OUT")
    echo "  ① 公网端点 http=$C body=$B"
    [ "$C" = "400" ] && ok "internal 包公网 400" || bad "internal 包公网应 400，实际 $C"
    [ "$(ecode "$B")" = "VARIANT_NOT_PUBLIC" ] && ok "code=VARIANT_NOT_PUBLIC" || bad "code 不是 VARIANT_NOT_PUBLIC（$(ecode "$B")）"
    AFTER_SHA=$(pub_sha)
    echo "  注入后  公网清单 sha256=$AFTER_SHA"
    [ "$AFTER_SHA" = "$BEFORE_SHA" ] && ok "公网清单 sha256 不变（$BEFORE_SHA）" \
      || bad "公网清单被改动了：$BEFORE_SHA → $AFTER_SHA"
    [ "$(apk_count)" = "$BEFORE_N" ] && ok "公网 apk/ 文件数不变（$BEFORE_N）" || bad "公网 apk/ 目录变了"
    ls "$WEB/apk" | grep -q "$(basename "$APK_INTERNAL")" && bad "internal 包漏进了 webroot 的 apk/" || ok "webroot 的 apk/ 里没有这个 internal 包"
    grep -q reject_variant_target "$WORK/server.log" && ok "日志有 reject_variant_target" || bad "日志缺 reject_variant_target"

    # ② 同一个包走私有端点 → 200，写进 webroot 之外的私有清单
    OUT=$(post "$BASE_PRIV" "$APK_INTERNAL" '{"buildType":"stable","changes":["私有清单"]}')
    C=$(code_of "$OUT"); B=$(body_of "$OUT")
    echo "  ② 私有端点 http=$C body=$B"
    [ "$C" = "200" ] && ok "私有端点 200（internal 包有地方去）" || bad "私有端点应 200，实际 $C"
    [ "$(printf '%s' "$B" | jget '["target"]')" = '"private"' ] && ok "回包 target=private" || bad "回包 target 不对"
    [ "$(printf '%s' "$B" | jget '.get("url")')" = "null" ] && ok "私有包没有公网直链（回包不给 url）" || bad "私有包回包给了 url"
    [ -f "$PRIV/releases.internal.json" ] && ok "私有清单已创建：$PRIV/releases.internal.json" || bad "私有清单没写出来"
    PRIV_FILE=$(printf '%s' "$B" | jget '["file"]' | tr -d '"' | sed 's|^apk/||')
    [ -n "$PRIV_FILE" ] && [ -f "$PRIV/apk/$PRIV_FILE" ] && ok "私有包落在私有 apk/ 目录（$PRIV_FILE）" \
      || bad "私有包没落在私有 apk/ 目录"
    grep -q release_private_ok "$WORK/server.log" && ok "日志有 release_private_ok" || bad "日志缺 release_private_ok"
    echo "  私有清单："; priv_manifest | sed 's/^/    /'
    node "$REPO/scripts/validate-releases-manifest.mjs" "$PRIV/releases.internal.json" --private \
      && ok "私有清单过 --private 口径" || bad "私有清单没过 --private 口径"

    # ③ 私有发布对公网零影响
    AFTER2_SHA=$(pub_sha)
    echo "  ③ 私有发布后 公网清单 sha256=$AFTER2_SHA"
    [ "$AFTER2_SHA" = "$BEFORE_SHA" ] && ok "私有发布后公网清单 sha256 仍不变（公网零影响）" \
      || bad "私有发布改动了公网清单：$BEFORE_SHA → $AFTER2_SHA"

    # ④ 还原：公网发布路径必须仍然可用（闸不是一刀切把正常发布也关死）
    if [ -n "$APK_STANDARD" ] && [ -f "$APK_STANDARD" ]; then
      OUT=$(post "$BASE" "$APK_STANDARD" '{"buildType":"stable","changes":["还原后重发"]}')
      C=$(code_of "$OUT"); echo "  ④ 还原（重发 standard 包）http=$C"
      [ "$C" = "200" ] && ok "还原后公网端点 200" || bad "还原后应 200，实际 $C"
    else
      skp "未提供 APK_STANDARD（还原段跳过）"
    fi
    python3 -c "
import json
d=json.load(open('$WEB/releases.json'))
bad=[r for r in d['releases'] if r.get('artifactVariant') not in (None,'standard')]
assert not bad, f'公网清单里出现 internal 条目：{bad}'
print('  [PASS] 公网清单 internal 条目数 = 0（#620 常驻断言）')" && PASS=$((PASS+1)) || bad "公网清单里仍有 internal 条目"
  else
    skp "APK_INTERNAL 是 debuggable 包 → 会被 Issue #60 的闸先拒（它是另一条闸的用例，见 9b）"
  fi
else
  skp "未提供 APK_INTERNAL（跳过 #620 的核心负向对照）"
fi

# ------------------------------------------- 6) 原用例 3 的改法：白名单登记 internal → 必须被拒
hdr "6) 白名单把历史包登记成 internal（原用例 3 的动作）→ 公网端点必须 4xx，公网清单 sha256 不变"
if [ -n "$APK_NO_MARKER" ] && [ -f "$APK_NO_MARKER" ] && not_debuggable "$APK_NO_MARKER"; then
  BEFORE_SHA=$(pub_sha); BEFORE_N=$(apk_count)
  allowlist_set "$APK_NO_MARKER" internal
  OUT=$(post "$BASE" "$APK_NO_MARKER" '{"buildType":"stable","changes":["offline case6"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  公网端点 http=$C body=$B"
  [ "$C" = "400" ] && ok "登记 internal 后公网 400（旧行为「200 且写进公网清单」已被替换）" || bad "应 400，实际 $C"
  [ "$(ecode "$B")" = "VARIANT_NOT_PUBLIC" ] && ok "code=VARIANT_NOT_PUBLIC" || bad "code 不对（$(ecode "$B")）"
  [ "$(pub_sha)" = "$BEFORE_SHA" ] && ok "公网清单 sha256 不变（$BEFORE_SHA）" || bad "公网清单被改动"
  [ "$(apk_count)" = "$BEFORE_N" ] && ok "公网 apk/ 目录不变" || bad "公网 apk/ 目录变了"
  # 还原白名单，别把状态留给后面的用例
  allowlist_set "$APK_NO_MARKER" standard
else
  skp "未提供可用的 APK_NO_MARKER（非 debuggable 的无标记历史包）—— 等价断言见 server-variant-gate-620.test.mjs V2"
fi

# ---------------------------------------------------------------- 7) 变体冲突
hdr "7) APK 内标记 internal 但白名单写 standard → 409 VARIANT_CONFLICT（不静默取一个）"
if [ -n "$APK_INTERNAL" ] && [ -f "$APK_INTERNAL" ] && not_debuggable "$APK_INTERNAL"; then
  MSHA=$(sha_of "$APK_INTERNAL")
  python3 - "$WORK/variant-allowlist.json" "$MSHA" <<'PY'
import json,sys
p,sha=sys.argv[1],sys.argv[2]
d=json.load(open(p)); d.setdefault("apks",{})[sha]={"variant":"standard","note":"offline test: 故意矛盾"}
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PY
  BEFORE_SHA=$(pub_sha)
  OUT=$(post "$BASE" "$APK_INTERNAL" '{"buildType":"stable","changes":["offline case7"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "409" ] && ok "矛盾 → 409" || bad "应 409，实际 $C"
  [ "$(ecode "$B")" = "VARIANT_CONFLICT" ] && ok "code=VARIANT_CONFLICT" || bad "code 不是 VARIANT_CONFLICT（$(ecode "$B")）"
  [ "$(pub_sha)" = "$BEFORE_SHA" ] && ok "公网清单 sha256 不变" || bad "公网清单被改动"
  python3 - "$WORK/variant-allowlist.json" "$MSHA" <<'PY'
import json,sys
p,sha=sys.argv[1],sys.argv[2]
d=json.load(open(p)); d.get("apks",{}).pop(sha,None)
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PY
else
  skp "未提供可用的 APK_INTERNAL（跳过变体冲突用例）"
fi

# ------------------------------------------------- 8) 认证与非法包 / debuggable
hdr "8) 错令牌 → 401；非 APK → 400"
printf 'x\n' > "$WORK/tok.txt"
OUT=$(post "$BASE" "$WORK/tok.txt" '{"changes":[]}' "wrong-token")
C=$(code_of "$OUT"); [ "$C" = "401" ] && ok "错令牌 401" || bad "错令牌应 401，实际 $C"
printf 'not an apk\n' > "$WORK/x.txt"
OUT=$(post "$BASE" "$WORK/x.txt" '{"changes":[]}')
C=$(code_of "$OUT"); [ "$C" = "400" ] && ok "非 APK 400" || bad "非 APK 应 400，实际 $C"

hdr "9) debuggable 的真 APK → 400 APK_DEBUGGABLE（Issue #60 硬门禁，排在变体闸之前）"
if [ -n "$APK_DEBUGGABLE" ] && [ -f "$APK_DEBUGGABLE" ]; then
  if node "$REPO/scripts/check-apk-debuggable.mjs" "$APK_DEBUGGABLE" >/dev/null 2>&1; then
    bad "样例 $APK_DEBUGGABLE 不是 debuggable 包，用例无效（换一个真 debuggable 的历史包）"
  else
    ok "样例判定为 debuggable（本地关卡退出码非 0）"
  fi
  BEFORE=$(pub_sha); BEFORE_N=$(apk_count)
  OUT=$(post "$BASE" "$APK_DEBUGGABLE" '{"buildType":"stable","changes":["should-be-rejected"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "400" ] && ok "上传被拒 400" || bad "debuggable 包应 400，实际 $C"
  [ "$(ecode "$B")" = "APK_DEBUGGABLE" ] && ok "错误码 APK_DEBUGGABLE" || bad "错误码不是 APK_DEBUGGABLE（$(ecode "$B")）"
  [ "$(pub_sha)" = "$BEFORE" ] && ok "公网清单未被改动" || bad "被拒的包改动了清单"
  [ "$(apk_count)" = "$BEFORE_N" ] && ok "被拒的 APK 未落盘" || bad "被拒的 APK 残留在发布目录"
  grep -q reject_debuggable "$WORK/server.log" && ok "日志有 reject_debuggable" || bad "日志缺 reject_debuggable"
else
  skp "未提供 APK_DEBUGGABLE（拿 1.4.0-beta.8 这类历史 debuggable 包，用例会真实跑一遍拒收）"
fi

# ------------------------------------------- 10) buildType 门禁（Issue #330 + #620 渠道闸）
hdr "10) 非法 buildType → 400 BAD_BUILD_TYPE；prerelease → 400 BUILD_TYPE_NOT_PUBLIC（公网只收 stable）"
APK_FOR_BUILDTYPE=${APK_STANDARD:-}
if [ -n "$APK_FOR_BUILDTYPE" ] && [ -f "$APK_FOR_BUILDTYPE" ]; then
  # 这个包必须是 standard（否则下面的断言会被变体闸先拦下，验不到渠道闸）
  allowlist_set "$APK_FOR_BUILDTYPE" standard

  BEFORE_SHA=$(pub_sha); BEFORE_N=$(apk_count)
  OUT=$(post "$BASE" "$APK_FOR_BUILDTYPE" '{"buildType":"release","changes":["should-be-rejected"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  非法枚举 http=$C body=$B"
  [ "$C" = "400" ] && ok "非法 buildType 400" || bad "非法 buildType 应 400，实际 $C"
  [ "$(ecode "$B")" = "BAD_BUILD_TYPE" ] && ok "顶层 code=BAD_BUILD_TYPE" || bad "顶层 code 不是 BAD_BUILD_TYPE"
  [ "$(pub_sha)" = "$BEFORE_SHA" ] && ok "公网清单字节不变（sha256 相同）" || bad "被拒的上传改动了清单"
  [ "$(apk_count)" = "$BEFORE_N" ] && ok "APK 未落盘（含无 .upload-* 残留）" || bad "被拒的 APK 落盘了"
  grep -q reject_build_type "$WORK/server.log" && ok "日志有 reject_build_type" || bad "日志缺 reject_build_type"

  OUT=$(post "$BASE" "$APK_FOR_BUILDTYPE" '{"buildType":"prerelease","changes":["should-be-rejected"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  prerelease http=$C body=$B"
  [ "$C" = "400" ] && ok "prerelease 400（公网清单只收 stable）" || bad "prerelease 应 400，实际 $C"
  [ "$(ecode "$B")" = "BUILD_TYPE_NOT_PUBLIC" ] && ok "code=BUILD_TYPE_NOT_PUBLIC" || bad "code 不是 BUILD_TYPE_NOT_PUBLIC"
  [ "$(pub_sha)" = "$BEFORE_SHA" ] && ok "公网清单字节不变" || bad "被拒的上传改动了清单"
  grep -q reject_build_type_target "$WORK/server.log" && ok "日志有 reject_build_type_target" || bad "日志缺 reject_build_type_target"

  # 11) 历史清单脏（旧条目 buildType="release"）→ 409 MANIFEST_DIRTY
  hdr "11) 历史清单脏（旧条目 buildType=\"release\"）→ 409 MANIFEST_DIRTY，APK 与清单都不落盘"
  cp "$WEB/releases.json" "$WORK/releases.clean.json"
  python3 - "$WEB/releases.json" <<'PYJSON'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d["releases"].append({
    "version":"0.9.9","versionCode":0,"releasedAt":"2026-11-01T10:00:00+08:00",
    "file":"apk/deepseek-chat-0.9.9.apk","size":1,"md5":"0"*32,
    "changes":["历史脏条目：buildType 写成了 Gradle 构建类型"],"buildType":"release","breaking":False,
    "artifactVariant":"standard","artifactVariantSource":"apk-manifest",
})
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PYJSON
  DIRTY_SHA=$(pub_sha); DIRTY_N=$(apk_count)
  OUT=$(post "$BASE" "$APK_FOR_BUILDTYPE" '{"buildType":"stable","changes":["should-be-rejected-too"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$B"
  [ "$C" = "409" ] && ok "脏清单 409" || bad "脏清单应 409，实际 $C"
  [ "$(ecode "$B")" = "MANIFEST_DIRTY" ] && ok "顶层 code=MANIFEST_DIRTY" || bad "顶层 code 不是 MANIFEST_DIRTY"
  [ "$(pub_sha)" = "$DIRTY_SHA" ] && ok "公网清单字节不变（没把脏清单写得更脏）" || bad "409 之后清单被改动了"
  [ "$(apk_count)" = "$DIRTY_N" ] && ok "APK 未落盘（校验在 rename 之前）" || bad "409 之后 APK 落盘了"
  cp "$WORK/releases.clean.json" "$WEB/releases.json"

  # 12) 公网清单里已有 internal 条目 → 合并后整份校验 409 MANIFEST_INTERNAL_ENTRY（#620）
  hdr "12) 公网清单里已有 internal 条目（#601 形状）→ 409 MANIFEST_INTERNAL_ENTRY，一个字节都不写"
  cp "$WEB/releases.json" "$WORK/releases.clean2.json"
  python3 - "$WEB/releases.json" <<'PYJSON2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
# 故意用**另一个版本**的条目：上传的包与它不同版本，才不会被「同版本覆盖」抹掉，
# 否则合并后的清单里那条 internal 会被同名记录顶掉，用例就白跑了。
d["releases"].append({
    "version":"1.1.1","versionCode":9,"releasedAt":"2026-11-21T10:00:00+08:00",
    "file":"apk/deepseek-chat-1.1.1.apk","size":1,"md5":"0"*32,"sha256":"c"*64,
    "changes":["#601 形状：公网清单里躺着的 internal 条目"],"buildType":"stable","breaking":False,
    "artifactVariant":"internal","artifactVariantSource":"apk-manifest",
})
json.dump(d,open(p,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
PYJSON2
  LEAK_SHA=$(pub_sha); LEAK_N=$(apk_count)
  python3 -c "
import json
d=json.load(open('$WEB/releases.json'))
assert any(r.get('artifactVariant')=='internal' for r in d['releases']), '注入失败：清单里没有 internal 条目'
print('  注入完成：公网清单里有 1 条 internal（1.1.1），注入前 sha256=$LEAK_SHA')" || bad "注入 internal 条目失败（用例无效）"
  OUT=$(post "$BASE" "$APK_FOR_BUILDTYPE" '{"buildType":"stable","changes":["应被整单拒收"]}')
  C=$(code_of "$OUT"); B=$(body_of "$OUT")
  echo "  http=$C body=$(printf '%s' "$B" | head -c 240)"
  [ "$C" = "409" ] && ok "含 internal 条目的公网清单 409" || bad "应 409，实际 $C"
  [ "$(ecode "$B")" = "MANIFEST_INTERNAL_ENTRY" ] && ok "code=MANIFEST_INTERNAL_ENTRY" || bad "code 不对"
  [ "$(pub_sha)" = "$LEAK_SHA" ] && ok "公网清单字节不变" || bad "409 之后清单被改动了"
  [ "$(apk_count)" = "$LEAK_N" ] && ok "APK 未落盘" || bad "409 之后 APK 落盘了"
  grep -q reject_manifest_variant "$WORK/server.log" && ok "日志有 reject_manifest_variant" || bad "日志缺 reject_manifest_variant"
  cp "$WORK/releases.clean2.json" "$WEB/releases.json"
else
  skp "未提供 APK_STANDARD（跳过 #330 的 400/409 与 #620 的清单互斥用例）"
fi

# ---------------------------------------------------------------- 13) 门禁自检（#620 常驻断言）
hdr "14) 产出的公网清单必须通过清单校验器；webroot 卫生门禁必须判绿（R4：internal 条目数 = 0）"
node "$REPO/scripts/validate-releases-manifest.mjs" "$WEB/releases.json" && ok "公网清单校验通过" || bad "公网清单校验失败"
[ -f "$PRIV/releases.internal.json" ] \
  && { node "$REPO/scripts/validate-releases-manifest.mjs" "$PRIV/releases.internal.json" --private \
        && ok "私有清单（--private 口径）校验通过" || bad "私有清单校验失败"; } \
  || skp "私有清单未创建（前面的用例被跳过）"
DL_WEBROOT="$WEB" node "$REPO/scripts/check-webroot-hygiene.mjs" && ok "webroot 卫生门禁判绿（含 R4）" || bad "webroot 卫生门禁判红"

hdr "最终公网清单"; manifest
hdr "最终私有清单"; priv_manifest

hdr "服务端日志（关键字）"
grep -E "variant_resolved|reject_variant_target|reject_build_type_target|reject_manifest_variant|release_ok|release_private_ok|targets" "$WORK/server.log" | tail -12

hdr "结果"
echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
