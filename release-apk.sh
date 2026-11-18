#!/usr/bin/env bash
# =============================================================================
# release-apk.sh —— 一条命令发布 APK（dl HTTP 接口 + tag 触发 GitHub Release）
#
# 用法: ./release-apk.sh <x.y.z[-suffix]> (--internal|--standard) "变更1" ... [选项]
#
# 九步：门禁 → 版本号 → 改 gradle → 写 CHANGELOG → commit → 构建+校验 → HTTP 上传 dl
#        → push commit + tag（GitHub Release 由 tag 触发的 workflow 创建）→ 汇总/状态
#
# 关键设计（2026-11-18 改版）：
#   * 上传只走 HTTPS 接口 POST /api/v1/release（multipart: apk + meta），**不再依赖 ssh/scp**。
#     令牌：$DL_RELEASE_TOKEN，或 $DL_RELEASE_TOKEN_FILE（默认 ~/.config/dl-release/token，权限应 600）。
#   * GitHub Release **由 .github/workflows/release.yml 在 tag push 后创建**（它从 dl 取同一个 APK）。
#     本脚本只 push 精确 commit + tag，绝不 gh release create/upload/edit，也绝不 force 改 tag；
#     远端 tag 指向别的 commit 时**停下报错**，交人工决策。
#   * dl 与 GitHub 不是原子事务：脚本记录部分成功状态（~/.local/state/deepseek-app/release/<ver>.json），
#     同 artifact 重跑会跳过已完成步骤（续发），汇总里**不会**宣称“全发布成功”。
#
# 退出码：0 = dl 已发布且 tag 已就位（GitHub Release 仍由 workflow 异步完成）
#         3 = 部分成功（dl 已发布，push/tag/Release 未完成 → 可同 artifact 续发）
#         1 = 失败（未发布）
# =============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRADLE=${GRADLE:-${ROOT_DIR}/android/app/build.gradle}
CHANGELOG=${CHANGELOG:-${ROOT_DIR}/CHANGELOG.md}
PREFLIGHT=${PREFLIGHT:-${ROOT_DIR}/preflight.sh}
APK_SRC=${APK_SRC:-${ROOT_DIR}/android/app/build/outputs/apk/debug/app-debug.apk}
AAPT2=${AAPT2:-/root/android-sdk/build-tools/35.0.0/aapt2}
DL_API_URL=${DL_API_URL:-https://dl.rose7.cn/api/v1/release}
DL_RELEASES_URL=${DL_RELEASES_URL:-https://dl.rose7.cn/releases.json}
DL_SITE=${DL_SITE:-https://dl.rose7.cn}
DL_TOKEN_FILE=${DL_TOKEN_FILE:-${HOME}/.config/dl-release/token}
DL_STATE_DIR=${DL_STATE_DIR:-${HOME}/.local/state/deepseek-app/release}
GH_REPO=${GH_REPO:-zzy-repo/deepseek-app}
GIT_REMOTE=${GIT_REMOTE:-origin}
GH_BRANCH_NAME=${GH_BRANCH_NAME:-main}
TAG_PREFIX=${TAG_PREFIX:-v}
SKIP_WEB_BUILD=${SKIP_WEB_BUILD:-0}
# 测试钩子（生产不要设置）：用外部命令替换构建 / APK 元信息读取
RELEASE_BUILD_CMD=${RELEASE_BUILD_CMD:-}
RELEASE_APK_META_CMD=${RELEASE_APK_META_CMD:-}

GRADLE_REL=${GRADLE#${ROOT_DIR}/}
CHANGELOG_REL=${CHANGELOG#${ROOT_DIR}/}

TOUCHED=0        # 已改动 gradle/CHANGELOG 且尚未 commit
COMMITTED=0      # 发布 commit 已建立
DL_DONE=0        # dl 已确认发布
TAG_DONE=0       # tag 已就位（或远端已存在且指向本 commit）
PARTIAL_REASON=''

info(){ printf '  %s\n' "$*"; }
warn(){ printf '%s\n' "$*" >&2; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die(){
  printf '\nERROR: %s\n' "$*" >&2
  if (( DL_DONE )); then
    warn "  ⚠️ dl.rose7.cn 已经发布成功（md5 已核对），只有后续步骤失败：修好后用同一 artifact 重跑即可续发"
    PARTIAL_REASON=$*
    write_state failed
  fi
  if (( COMMITTED )); then
    warn "  ⚠️ 已创建发布 commit $(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null)；不自动回滚（避免撤销他人改动），人工处置：git revert <sha> 或 git reset --soft HEAD~1"
  elif (( TOUCHED )); then
    restore_own_edits
  fi
  exit 1
}

# 只还原本脚本自己改的两个文件（用写入前的备份，不 git checkout、不碰别人的改动）
BACKUP_DIR=''
restore_own_edits(){
  local f ok=1
  if [[ -z ${BACKUP_DIR} || ! -d ${BACKUP_DIR} ]]; then return 0; fi
  for f in "${GRADLE}" "${CHANGELOG}"; do
    local base; base=$(basename "$f")
    if [[ -f "${BACKUP_DIR}/${base}" ]]; then
      cp -f "${BACKUP_DIR}/${base}" "$f" || ok=0
    fi
  done
  ( cd "${ROOT_DIR}" && git reset -q HEAD -- "${GRADLE_REL}" "${CHANGELOG_REL}" 2>/dev/null || true )
  if (( ok )); then warn "  ↩️  已按备份还原 ${GRADLE_REL} 与 ${CHANGELOG_REL}（未触碰其它改动）"; fi
}

usage(){
  cat <<'USAGE'
用法: ./release-apk.sh <x.y.z[-suffix]> (--internal|--standard) "变更1" "变更2" ... [选项]

  九步：门禁 → 版本号 → 改 gradle → 写 CHANGELOG → commit → 构建+校验 → 上传 dl → push+tag → 汇总

  必需:
    <x.y.z[-suffix]>        版本号，如 1.5.0 / 1.5.0-beta.1
    "变更1" "变更2" ...      至少一条，写进 CHANGELOG / dl releases.json / GitHub Release notes
    --internal | --standard --internal = pnpm build:internal（内测），--standard = pnpm build（对外，缺省）

  选项:
    --skip-upstream-e2e  只跳过门禁第 6 项里的【真实模型上游】e2e（发布后补测）；
                         unit/integration/反馈上传 e2e 照跑；CHANGELOG 与 Release notes 会写明待补测
    --skip-tests     全量跳过门禁 4/5/6（unit/integration/e2e）——正常发版不要用，留痕 [未过门禁]
    --dry-run        只打印九步计划：不改文件、不 commit、不构建、不上传、不 push、不打 tag
    --no-push        只发布到 dl.rose7.cn，不 push commit / 不打 tag（别名 --no-github）
    --wait-release [秒]  tag 推送后最多等待 N 秒（默认 90）看 workflow 是否建好 GitHub Release
    -h, --help       本帮助

  环境:
    DL_RELEASE_TOKEN / DL_RELEASE_TOKEN_FILE(默认 ~/.config/dl-release/token, 应 600)
    DL_API_URL / DL_RELEASES_URL / DL_SITE / GH_REPO / GIT_REMOTE / DL_STATE_DIR

  示例:
    ./release-apk.sh 1.5.0 --internal "新增：会话自动标题" "修复：手动改名被覆盖"
    ./release-apk.sh 1.5.0 --standard --dry-run "预演一次"
    ./release-apk.sh 1.5.0 --internal --skip-tests "紧急修崩溃"     # 留痕跳过测试
USAGE
}

# ---------------------------------------------------------------- 参数
SKIP_TESTS=0; SKIP_UPSTREAM_E2E=0; DRY_RUN=0; NO_PUSH=0; WAIT_RELEASE=0; BUILD_TYPE=''
ARGS=()
set -- "$@"
while (( $# )); do
  case "$1" in
    --internal) BUILD_TYPE=internal ;;
    --standard) BUILD_TYPE=standard ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-upstream-e2e) SKIP_UPSTREAM_E2E=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --no-push|--no-github) NO_PUSH=1 ;;
    --wait-release) WAIT_RELEASE=90
                    if [[ ${2:-} =~ ^[0-9]+$ ]]; then WAIT_RELEASE=$2; shift; fi ;;
    -h|--help) usage; exit 0 ;;
    --*) usage >&2; die "未知选项: $1" ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
set -- ${ARGS[@]+"${ARGS[@]}"}
VER="${1:-}"; shift || true
CHANGES=("$@")
if [[ -z ${VER} ]]; then usage >&2; die '缺少版本号'; fi
if (( ${#CHANGES[@]} == 0 )); then usage >&2; die '至少给一条 changes（写人能看懂这次改了什么）'; fi
for c in "${CHANGES[@]}"; do [[ -n ${c// /} ]] || die 'changes 里有空字符串'; done
if [[ -z ${BUILD_TYPE} ]]; then BUILD_TYPE=standard; warn '  ! 未指定 --internal/--standard，默认 --standard（对外构建）'; fi
[[ -x ${PREFLIGHT} ]] || die "门禁脚本不可执行: ${PREFLIGHT}（chmod +x preflight.sh）"
[[ -f ${GRADLE} ]] || die "找不到 ${GRADLE}"
TAG="${TAG_PREFIX}${VER}"
TITLE_SUFFIX=''
if (( SKIP_TESTS )); then TITLE_SUFFIX=' [未过门禁]'; fi
if (( SKIP_UPSTREAM_E2E )); then TITLE_SUFFIX="${TITLE_SUFFIX} [上游e2e待补测]"; fi
if (( SKIP_TESTS && SKIP_UPSTREAM_E2E )); then die '--skip-tests 与 --skip-upstream-e2e 不能同时用：要发版就用 --skip-upstream-e2e'; fi
UPSTREAM_NOTE='说明：真实模型上游测试待发布后补测（本次未跑真上游 e2e；unit/integration/反馈上传 e2e 均已跑）'
CHANGES_ALL=("${CHANGES[@]}")
if (( SKIP_UPSTREAM_E2E )); then CHANGES_ALL+=("${UPSTREAM_NOTE}"); fi
DATE_STR=$(TZ=Asia/Shanghai date +%F)
STATE_FILE="${DL_STATE_DIR}/${VER}.json"

# ---------------------------------------------------------------- 小工具
gradle_vc(){ sed -n 's/^[[:space:]]*versionCode[[:space:]]\+\([0-9]\+\).*/\1/p' "${GRADLE}" | head -1; }
gradle_vn(){ sed -n 's/^[[:space:]]*versionName[[:space:]]"\([^"]*\)".*/\1/p' "${GRADLE}" | head -1; }
GVN=$(gradle_vn); GVVC=$(gradle_vc)
[[ -n ${GVN} && -n ${GVVC} ]] || die "读不到 ${GRADLE_REL} 的 versionCode/versionName"

short_title(){
  python3 - "$1" <<'PY'
import re,sys
s=re.sub(r'^\s*(新增|修复|优化|变更|调整|移除|删除|文档|重构|测试|性能)[：:]\s*','',sys.argv[1])
print(re.split(r'[。；;，,]',s)[0].strip()[:20])
PY
}
SHORT=$(short_title "${CHANGES[0]}")
[[ -n ${SHORT} ]] || SHORT=${CHANGES[0]:0:20}

apk_meta(){  # <apk> → "vc vn"
  local apk=$1 b vc vn
  if [[ -n ${RELEASE_APK_META_CMD} ]]; then bash -c "${RELEASE_APK_META_CMD}"; return $?; fi
  b=$("${AAPT2}" dump badging "${apk}" 2>/dev/null) || return 1
  vc=$(printf '%s\n' "$b" | sed -n "s/^package:.* versionCode='\([0-9]*\)'.*/\1/p" | head -1)
  vn=$(printf '%s\n' "$b" | sed -n "s/^package:.* versionName='\([^']*\)'.*/\1/p" | head -1)
  [[ -n ${vc} ]] || return 1
  printf '%s %s\n' "${vc}" "${vn}"
}
file_md5(){ if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi; }

# 状态文件（JSON）
write_state(){
  local phase=${1:-}
  mkdir -p "${DL_STATE_DIR}"
  python3 - "${STATE_FILE}" "${VER}" "${NEW_VC:-0}" "${COMMIT_SHA:-}" "${APK_MD5:-}" "${APK_SIZE:-0}" \
           "${DL_STATUS:-none}" "${DL_URL:-}" "${DL_MD5:-}" "${TAG_STATUS:-none}" "${GH_STATUS:-none}" \
           "${phase}" "${SKIP_TESTS}" "${SKIP_UPSTREAM_E2E}" <<'PY'
import json,sys,datetime
(p,ver,vc,sha,md5,size,dl,url,dlmd5,tag,gh,phase,skip,skipup)=sys.argv[1:]
d={"version":ver,"versionCode":int(vc or 0),"commit":sha or "","apk":{"md5":md5 or "","size":int(size or 0)},
   "dl":{"status":dl,"url":url or "","md5":dlmd5 or "","endpoint":"api/v1/release"},
   "tag":{"status":tag},"githubRelease":{"status":gh},"skipTests":bool(int(skip)),
   "skipUpstreamE2E":bool(int(skipup)),
   "phase":phase,"updatedAt":datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY
}
state_get(){  # <python expr over d>
  [[ -r ${STATE_FILE} ]] || return 0
  python3 - "${STATE_FILE}" "$1" <<'PY' 2>/dev/null || true
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
try: print(eval(sys.argv[2],{"d":d}))
except Exception: pass
PY
}

# 令牌：环境变量优先，其次文件；权限过宽只警告（不改权限，避免动别人的安全配置）
resolve_token(){
  if [[ -n ${DL_RELEASE_TOKEN:-} ]]; then TOKEN=${DL_RELEASE_TOKEN}; TOKEN_SRC='env DL_RELEASE_TOKEN'; return 0; fi
  [[ -r ${DL_TOKEN_FILE} ]] || { die "缺少发布令牌：设置 DL_RELEASE_TOKEN，或把令牌放在 ${DL_TOKEN_FILE}（chmod 600）"; }
  local mode; mode=$(stat -c '%a' "${DL_TOKEN_FILE}" 2>/dev/null || echo '?')
  case ${mode} in 600|400) ;; *) warn "  ! ${DL_TOKEN_FILE} 权限为 ${mode}，建议 chmod 600（脚本不会自动改权限）";; esac
  TOKEN=$(tr -d ' \t\r\n' <"${DL_TOKEN_FILE}")
  [[ -n ${TOKEN} ]] || die "令牌文件为空: ${DL_TOKEN_FILE}"
  TOKEN_SRC=${DL_TOKEN_FILE}
}

# 远端 latest（releases.json），失败返回非零
remote_latest(){  # → "versionCode version"
  local json
  json=$(curl -fsS --max-time 15 "${DL_RELEASES_URL}" 2>/dev/null) || return 1
  printf '%s' "${json}" | python3 -c '
import json,sys
d=json.load(sys.stdin); rel=d.get("releases") or []
latest=str(d.get("latest") or "")
hit=[r for r in rel if str(r.get("version"))==latest]
vc=int(hit[0].get("versionCode") or 0) if hit else max([int(r.get("versionCode") or 0) for r in rel] or [0])
print(vc, latest or "-")
' 2>/dev/null || return 1
}

# ---------------------------------------------------------------- 0) 只读预读：远端基线与续发判断
REMOTE_VC=0; REMOTE_VER='-'; REMOTE_OK=1
if RL=$(remote_latest); then REMOTE_VC=${RL%% *}; REMOTE_VER=${RL##* }; else REMOTE_OK=0; fi
STATE_DL_MD5=$(state_get 'd["dl"]["md5"]')
CUR_APK_MD5=''
if [[ -s ${APK_SRC} ]]; then CUR_APK_MD5=$(file_md5 "${APK_SRC}"); fi
SAME_ARTIFACT=0
if [[ -n ${STATE_DL_MD5} && -n ${CUR_APK_MD5} && ${STATE_DL_MD5} == "${CUR_APK_MD5}" ]] \
   && [[ $(state_get 'd["dl"]["status"]') == ok ]]; then SAME_ARTIFACT=1; fi

# versionCode 规划：新版本 = max(本地, 远端)+1；同版本续发不重复递增
NEW_VC=0; RESUME_SAME=0
if [[ -n ${VER} && ${GVN} == "${VER}" ]]; then
  if (( GVVC > REMOTE_VC )); then
    NEW_VC=${GVVC}; RESUME_SAME=1                     # 上次已 bump 且仍领先 → 直接续用，不递增
  elif (( GVVC == REMOTE_VC )) && (( SAME_ARTIFACT )); then
    NEW_VC=${GVVC}; RESUME_SAME=1                     # 同 artifact 已在 dl 上 → 续发，不递增
  else
    NEW_VC=$(( (GVVC > REMOTE_VC ? GVVC : REMOTE_VC) + 1 ))
  fi
else
  NEW_VC=$(( (GVVC > REMOTE_VC ? GVVC : REMOTE_VC) + 1 ))
fi
if [[ ${GVN} == "${VER}" ]]; then NEW_VN_DESC="保持 ${VER}（续发，不递增 versionCode）"; else NEW_VN_DESC="${GVN} → ${VER}"; fi
if (( RESUME_SAME )); then VC_DESC="${GVVC}（续用，不递增）"; else VC_DESC="${GVVC} → ${NEW_VC}"; fi

# ---------------------------------------------------------------- dry-run（零副作用）
if (( DRY_RUN )); then
  if [[ ! ${VER} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then die "版本号必须形如 1.5.0 或 1.5.0-beta.1，收到: ${VER}"; fi
  if [[ ${BUILD_TYPE} == internal ]]; then WEB_CMD='heavy-run pnpm build:internal'; else WEB_CMD='heavy-run pnpm build'; fi
  if (( SKIP_TESTS )); then GATE_DESC='九项中 4/5/6 全跳过（--skip-tests，留痕 [未过门禁]；正常发版别用）'
  elif (( SKIP_UPSTREAM_E2E )); then GATE_DESC='第 6 项只跳过真实模型上游 e2e（--skip-upstream-e2e），反馈上传 e2e 与 4/5 照跑，留痕 [上游e2e待补测]'
  else GATE_DESC='九项全跑（第 6 项需 E2E_API_KEY，否则缺证阻断；可改用 --skip-upstream-e2e 延后补测）'; fi
  printf '\n\033[1;33m[dry-run] 发布演练：不改文件 / 不 commit / 不构建 / 不上传 / 不 push / 不打 tag\033[0m\n'
  printf '  版本          %s\n' "${VER}"
  printf '  构建类型      %s（%s）\n' "${BUILD_TYPE}" "${WEB_CMD}"
  printf '  versionCode   %s\n' "${VC_DESC}"
  printf '  versionName   %s\n' "${NEW_VN_DESC}"
  printf '  门禁          ./preflight.sh --planned-version %s --planned-versioncode %s（%s）\n' "${VER}" "${NEW_VC}" "${GATE_DESC}"
  printf '  远端基线      releases.json latest=%s versionCode=%s%s\n' "${REMOTE_VER}" "${REMOTE_VC}" "$([[ ${REMOTE_OK} == 1 ]] || echo '（读取失败，将降级）')"
  printf '  续发判断      %s\n' "$([[ ${SAME_ARTIFACT} == 1 ]] && echo '同 artifact 已上传 → 会跳过构建与上传，只补 tag/Release' || echo '新 artifact → 走完整流程')"
  printf '  CHANGELOG     将插入: ## %s (%s) — %s%s\n' "${VER}" "${DATE_STR}" "${SHORT}" "${TITLE_SUFFIX}"
  if (( SKIP_UPSTREAM_E2E )); then
    printf '  待补测说明     %s\n' "${UPSTREAM_NOTE}"
    printf '                （会同时写进 CHANGELOG 列表、dl releases.json 的 changes、workflow 生成的 Release notes）\n'
  fi
  printf '  上传          POST %s（Bearer %s，multipart apk+meta）\n' "${DL_API_URL}" \
    "$([[ -n ${DL_RELEASE_TOKEN:-} ]] && echo '来自 $DL_RELEASE_TOKEN' || echo "${DL_TOKEN_FILE}")"
  printf '  令牌          %s\n' "$([[ -n ${DL_RELEASE_TOKEN:-} ]] && echo 'env DL_RELEASE_TOKEN（值不打印）' || echo "${DL_TOKEN_FILE}（值不打印）")"
  printf '\n  将执行：改 gradle → 写 CHANGELOG → commit → 构建 → 上传 → push+tag（Release 交给 workflow）\n'
  printf '  1) ./preflight.sh --planned-version %s --planned-versioncode %s' "${VER}" "${NEW_VC}"
  (( SKIP_TESTS )) && printf ' --skip-tests'; (( RESUME_SAME )) && printf ' --allow-same-version'
  printf '\n     发布门禁九项（失败即中止，不碰任何文件）\n'
  printf '  2) 版本号格式校验          x.y.z / x.y.z-beta.1（收到 %s）\n' "${VER}"
  printf '  3) 改 %s  versionCode %s，versionName %s\n' "${GRADLE_REL}" "${VC_DESC}" "${NEW_VN_DESC}"
  printf '  4) 写 CHANGELOG.md         插入 "## %s (%s) — %s"%s\n' "${VER}" "${DATE_STR}" "${SHORT}" "${TITLE_SUFFIX}"
  printf '  5) commit                  git add %s CHANGELOG.md && git commit -m "chore: 发布 %s"\n' "${GRADLE_REL}" "${VER}"
  printf '  6) 构建+强校验             %s → npx cap sync android → (cd android && heavy-run ./gradlew assembleDebug)\n' "${WEB_CMD}"
  printf '                             构建后 aapt2 校验 versionName/versionCode 必须等于 %s/%s\n' "${VER}" "${NEW_VC}"
  printf '  7) 上传 dl                 POST %s → 核对响应 md5/version 与本地一致\n' "${DL_API_URL}"
  printf '  8) push + tag              git push %s HEAD:refs/heads/%s → tag %s（已存在且指向本 commit 则复用；指错则停下报错，不 force）\n' "${GIT_REMOTE}" "${GH_BRANCH_NAME}" "${TAG}"
  printf '                             GitHub Release 由 workflow 在 tag 触发后创建（本脚本不创建）%s\n' "$([[ ${NO_PUSH} == 1 ]] && echo '；--no-push 已指定 → 跳过本步')"
  printf '  9) 汇总+状态               %s\n' "${STATE_FILE}"
  printf '\n  \033[1;32m✅ dry-run 结束：以上仅为计划，工作区未被改动\033[0m\n'
  exit 0
fi

# ---------------------------------------------------------------- 1) 门禁
step "1/9 门禁 preflight"
PF_ARGS=(--planned-version "${VER}" --planned-versioncode "${NEW_VC}")
if (( SKIP_TESTS )); then PF_ARGS+=(--skip-tests); fi
if (( SKIP_UPSTREAM_E2E )); then PF_ARGS+=(--skip-upstream-e2e); fi
if (( RESUME_SAME )); then PF_ARGS+=(--allow-same-version); fi
info "./preflight.sh ${PF_ARGS[*]}"
if ! "${PREFLIGHT}" "${PF_ARGS[@]}"; then
  die '门禁未通过：发布中止（build.gradle / CHANGELOG / git 都没有被改动）'
fi

# ---------------------------------------------------------------- 2) 版本号
step "2/9 版本号格式校验"
if [[ ! ${VER} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then die "版本号必须形如 1.5.0 或 1.5.0-beta.1，收到: ${VER}"; fi
info "${VER} 合法（tag 将是 ${TAG}）"
if [[ $(state_get 'd["dl"]["status"]') == ok ]]; then
  warn "  ⚠️ 本地状态显示 ${VER} 已发布过 dl（md5 $( [[ -n ${STATE_DL_MD5} ]] && echo "${STATE_DL_MD5:0:8}…" )）：本次按【续发】处理"
fi

# ---------------------------------------------------------------- 3) 改 gradle
step "3/9 改 ${GRADLE_REL}"
BACKUP_DIR=$(mktemp -d /tmp/relbak.XXXXXX)
cp -f "${GRADLE}" "${BACKUP_DIR}/$(basename "${GRADLE}")"
cp -f "${CHANGELOG}" "${BACKUP_DIR}/$(basename "${CHANGELOG}")"
TOUCHED=1
if ! python3 - "${GRADLE}" "${VER}" "${NEW_VC}" <<'PY'
import re,sys
p,ver,newvc=sys.argv[1],sys.argv[2],int(sys.argv[3])
s=open(p,encoding="utf-8").read()
mc=re.search(r"(?m)^([ \t]*)versionCode[ \t]+(\d+)",s)
mn=re.search(r"(?m)^([ \t]*)versionName[ \t]+\"([^\"]*)\"",s)
if not mc or not mn:
    sys.stderr.write("versionCode/versionName 行找不到\n"); sys.exit(1)
if int(mc.group(2))!=newvc:
    s=s[:mc.start()]+"%sversionCode %d"%(mc.group(1),newvc)+s[mc.end():]
mn=re.search(r"(?m)^([ \t]*)versionName[ \t]+\"([^\"]*)\"",s)
if mn.group(2)!=ver:
    s=s[:mn.start()]+'%sversionName "%s"'%(mn.group(1),ver)+s[mn.end():]
open(p,"w",encoding="utf-8").write(s)
PY
then die "改 ${GRADLE_REL} 失败"; fi
CHK_VC=$(gradle_vc); CHK_VN=$(gradle_vn)
if [[ ${CHK_VC} != "${NEW_VC}" || ${CHK_VN} != "${VER}" ]]; then
  die "改完后校验不一致（versionCode=${CHK_VC} versionName=${CHK_VN}，期望 ${NEW_VC}/${VER}）"
fi
info "versionCode ${VC_DESC}；versionName ${NEW_VN_DESC}"

# ---------------------------------------------------------------- 4) CHANGELOG
step "4/9 写 ${CHANGELOG_REL}"
if ! python3 - "${CHANGELOG}" "${VER}" "${DATE_STR}" "${TITLE_SUFFIX}" "${CHANGES_ALL[@]}" <<'PY'
import re,sys
path,ver,date,suffix=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
changes=sys.argv[5:]
text=open(path,encoding="utf-8").read()
if re.search(r"(?m)^##[ \t]+"+re.escape(ver)+r"([ \t(]|$)",text):
    print("EXISTS"); raise SystemExit(0)
short=re.sub(r"^\s*(新增|修复|优化|变更|调整|移除|删除|文档|重构|测试|性能)[：:]\s*","",changes[0])
short=re.split(r"[。；;，,]",short)[0].strip()[:20]
block=["## %s (%s) — %s%s"%(ver,date,short,suffix),""]+["- %s"%c for c in changes]+[""]
lines=text.split("\n"); idx=None
for i,l in enumerate(lines):
    if l.startswith("## "): idx=i; break
new=lines+[""]+block if idx is None else lines[:idx]+block+lines[idx:]
open(path,"w",encoding="utf-8").write("\n".join(new))
print("INSERTED")
PY
then die "写 ${CHANGELOG_REL} 失败"; fi
grep -qE "^##[[:space:]]+${VER}([[:space:](]|$)" "${CHANGELOG}" || die "写完校验失败：${CHANGELOG_REL} 里找不到 '## ${VER}'"
info "CHANGELOG 段落就绪：## ${VER} (${DATE_STR}) — ${SHORT}${TITLE_SUFFIX}"

# ---------------------------------------------------------------- 5) commit
step "5/9 commit"
( cd "${ROOT_DIR}" && git add "${GRADLE_REL}" "${CHANGELOG_REL}" )
if ( cd "${ROOT_DIR}" && git diff --cached --quiet ); then
  info '没有需要提交的改动（续发场景：上次已 commit）'
else
  if ! ( cd "${ROOT_DIR}" && git commit -q -m "chore: 发布 ${VER}" ); then die 'commit 失败（检查 git 身份 / pre-commit hook）'; fi
fi
COMMITTED=1
COMMIT_SHA=$(git -C "${ROOT_DIR}" rev-parse HEAD)
info "commit ${COMMIT_SHA:0:8}  chore: 发布 ${VER}"

# ---------------------------------------------------------------- 6) 构建 + 强校验
step "6/9 构建并校验产物（${BUILD_TYPE}）"
# 工作区/隔离 worktree 通用：补齐 Android SDK 环境与 local.properties（与 build-apk.sh 一致）
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
[[ -d ${ANDROID_HOME} ]] || die "找不到 Android SDK: ${ANDROID_HOME}（export ANDROID_HOME=...）"
if [[ -z ${JAVA_HOME:-} ]]; then
  JB=$(command -v java || true); [[ -n ${JB} ]] || die '找不到 java（需要 JDK 21）'
  JAVA_HOME=$(dirname "$(dirname "$(readlink -f "${JB}")")"); export JAVA_HOME
fi
if ! grep -qs "^sdk.dir=${ANDROID_HOME}$" "${ROOT_DIR}/android/local.properties"; then
  printf 'sdk.dir=%s\n' "${ANDROID_HOME}" > "${ROOT_DIR}/android/local.properties"
  info "写入 android/local.properties: sdk.dir=${ANDROID_HOME}"
fi
if (( SAME_ARTIFACT )) && [[ -s ${APK_SRC} ]]; then
  info "同 artifact 续发：复用现有 APK（md5 ${CUR_APK_MD5:0:8}…），跳过构建"
elif [[ -n ${RELEASE_BUILD_CMD} ]]; then
  info "RELEASE_BUILD_CMD: ${RELEASE_BUILD_CMD}"
  if ! bash -c "${RELEASE_BUILD_CMD}"; then die '构建失败（RELEASE_BUILD_CMD）'; fi
else
  if [[ ${SKIP_WEB_BUILD} == 1 && -f "${ROOT_DIR}/dist/index.html" ]]; then
    info 'SKIP_WEB_BUILD=1：复用现有 dist/'
  elif [[ ${BUILD_TYPE} == internal ]]; then
    info 'heavy-run pnpm build:internal'
    if ! ( cd "${ROOT_DIR}" && heavy-run pnpm build:internal ); then die '前端构建失败'; fi
  else
    info 'heavy-run pnpm build'
    if ! ( cd "${ROOT_DIR}" && heavy-run pnpm build ); then die '前端构建失败'; fi
  fi
  info 'npx cap sync android'
  if ! ( cd "${ROOT_DIR}" && npx cap sync android ); then die 'npx cap sync android 失败'; fi
  info '(cd android && heavy-run ./gradlew assembleDebug)'
  if ! ( cd "${ROOT_DIR}/android" && heavy-run ./gradlew assembleDebug ); then die 'gradlew assembleDebug 失败'; fi
fi
[[ -s ${APK_SRC} ]] || die "APK 不存在或为空: ${APK_SRC}"
# 构建后强校验：旧 APK 绝不允许被当作新版本发布（构建前不阻断，构建后必须一致）
if ! M=$(apk_meta "${APK_SRC}"); then die "读不到 APK 元信息（aapt2 失败？）: ${APK_SRC}"; fi
AVC=${M%% *}; AVN=${M##* }
if [[ ${AVC} != "${NEW_VC}" || ${AVN} != "${VER}" ]]; then
  die "构建产物与目标版本不一致：APK=${AVN}/${AVC}，期望 ${VER}/${NEW_VC}（可能 cap sync 未刷新或 gradle 缓存）"
fi
APK_MD5=$(file_md5 "${APK_SRC}"); APK_SIZE=$(stat -c%s "${APK_SRC}")
info "APK ${AVN}(${AVC})  ${APK_SIZE} B  md5 ${APK_MD5}"

# ---------------------------------------------------------------- 7) 上传 dl
step "7/9 上传 dl.rose7.cn"
resolve_token
DL_STATUS=fail; DL_URL=''; DL_MD5=''
if (( SAME_ARTIFACT )); then
  info "同 artifact 已在 dl 上（md5 ${STATE_DL_MD5:0:8}… 与本地一致），跳过重复上传"
  DL_STATUS=ok; DL_URL=$(state_get 'd["dl"]["url"]'); DL_MD5=${STATE_DL_MD5}; DL_DONE=1
else
  META_JSON=$(python3 - "${VER}" "${NEW_VC}" "${CHANGES_ALL[@]}" <<'PY'
import json,sys
ver,vc=sys.argv[1],int(sys.argv[2]); changes=sys.argv[3:]
bt="prerelease" if any(t in ver for t in ("-alpha","-beta","-rc")) else "stable"
print(json.dumps({"version":ver,"versionCode":vc,"buildType":bt,"changes":changes},ensure_ascii=False))
PY
)
  TMPD=$(mktemp -d /tmp/relhttp.XXXXXX)
  trap 'rm -rf "${TMPD}"' EXIT
  info "POST ${DL_API_URL}（Bearer ${TOKEN_SRC}，不打印令牌）"
  attempt=0
  while :; do
    attempt=$((attempt+1))
    HTTP=$(curl -sS --max-time 1800 -o "${TMPD}/resp.json" -D "${TMPD}/hdr.txt" -w '%{http_code}' \
      -X POST "${DL_API_URL}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -F "apk=@${APK_SRC}" \
      -F "meta=${META_JSON}" 2>"${TMPD}/curl.err") || HTTP=000
    if [[ ${HTTP} == 429 && ${attempt} -lt 3 ]]; then
      RA=$(sed -n 's/^[Rr]etry-[Aa]fter:[[:space:]]*\([0-9]\+\).*/\1/p' "${TMPD}/hdr.txt" | tail -1)
      RA=${RA:-30}; (( RA > 90 )) && RA=90
      warn "  ! 429 限流（每 IP 每分钟 2 次），${RA}s 后重试（第 ${attempt} 次）"; sleep "${RA}"; continue
    fi
    break
  done
  ERRTXT=$(tail -3 "${TMPD}/curl.err" 2>/dev/null | tr '\n' ' ')
  case ${HTTP} in
    200) ;;
    000) die "上传失败：连不上 ${DL_API_URL}（${ERRTXT}）";;
    401) die "上传失败 401 UNAUTHORIZED：令牌错误/过期（来源 ${TOKEN_SRC}）。用 ssh aliyun 取新令牌后更新 ${DL_TOKEN_FILE}（chmod 600）";;
    409) die "上传失败 409 VERSION_CONFLICT：服务端 latest 是 ${REMOTE_VER}(versionCode ${REMOTE_VC})，本次 ${NEW_VC} 未递增。把 versionCode 提到 $(( REMOTE_VC + 1 )) 以上再发";;
    413) die "上传失败 413 PAYLOAD_TOO_LARGE：APK 超过 50 MB";;
    400) die "上传失败 400：$(cat "${TMPD}/resp.json" 2>/dev/null)";;
    *)   die "上传失败 HTTP ${HTTP}：$(cat "${TMPD}/resp.json" 2>/dev/null)";;
  esac
  # 核对服务端回报的 md5 / version（服务端自己算的 md5 才算数）
  if ! read -r OK_FLAG S_MD5 S_LATEST S_URL <<<"$(python3 - "${TMPD}/resp.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
print(int(bool(d.get("ok"))), d.get("md5") or "-", d.get("latest") or "-", d.get("url") or "-")
PY
)"; then die '上传响应不是合法 JSON'; fi
  if [[ ${OK_FLAG} != 1 ]]; then die "上传响应 ok!=true：$(cat "${TMPD}/resp.json" 2>/dev/null)"; fi
  if [[ ${S_MD5} != "${APK_MD5}" ]]; then
    DL_STATUS=mismatch
    die "服务端 md5 ${S_MD5} ≠ 本地 ${APK_MD5}：产物不一致（服务端已写入，需人工核对后重发）"
  fi
  if [[ ${S_LATEST} != "${VER}" ]]; then
    DL_STATUS=mismatch
    die "服务端 latest=${S_LATEST} ≠ 期望 ${VER}：APK 内 versionName 与目标不符"
  fi
  DL_STATUS=ok; DL_URL=${S_URL}; DL_MD5=${S_MD5}; DL_DONE=1
  info "dl OK：${DL_URL}"
  info "服务端 md5 ${S_MD5} == 本地 md5（已核对）"
fi
write_state dl_done

# ---------------------------------------------------------------- 8) push + tag（不创建 Release）
step "8/9 push commit + tag（GitHub Release 交给 workflow）"
TAG_STATUS=none; GH_STATUS=none
if (( NO_PUSH )); then
  info '--no-push：跳过 push/tag（GitHub Release 不会创建）'
  TAG_STATUS=skipped; GH_STATUS=skipped
else
  HEAD_SHA=$(git -C "${ROOT_DIR}" rev-parse HEAD)
  info "git push ${GIT_REMOTE} HEAD:refs/heads/${GH_BRANCH_NAME}（精确 commit ${HEAD_SHA:0:8}）"
  if ! git -C "${ROOT_DIR}" push "${GIT_REMOTE}" "HEAD:refs/heads/${GH_BRANCH_NAME}"; then
    TAG_STATUS=push_failed
    PARTIAL_REASON="push ${GH_BRANCH_NAME} 失败"
    write_state push_failed
    warn '  ⚠️ 部分成功：dl 已发布，push 失败 → tag/Release 未创建。修好网络/权限后同 artifact 重跑续发'
    exit 3
  fi
  RTSHA=$(git -C "${ROOT_DIR}" ls-remote --tags "${GIT_REMOTE}" "refs/tags/${TAG}^{}" 2>/dev/null | cut -f1 | head -1)
  [[ -n ${RTSHA} ]] || RTSHA=$(git -C "${ROOT_DIR}" ls-remote --tags "${GIT_REMOTE}" "refs/tags/${TAG}" 2>/dev/null | cut -f1 | head -1)
  LTSHA=$(git -C "${ROOT_DIR}" rev-parse -q --verify "refs/tags/${TAG}" 2>/dev/null || true)
  if [[ -n ${RTSHA} ]]; then
    if [[ ${RTSHA} == "${HEAD_SHA}" ]]; then
      info "远端已有 tag ${TAG} → ${RTSHA:0:8}（正是本 commit），复用、不重建"
      TAG_STATUS=exists_ok
    else
      TAG_STATUS=conflict
      write_state tag_conflict
      warn ''
      warn "  ❌ 停止：tag ${TAG} 已存在且指向 ${RTSHA:0:8}，而本地发布 commit 是 ${HEAD_SHA:0:8}。"
      warn "     脚本不会自动 force 改 tag（那会悄悄改写已发布的 Release 语义）。可选处置："
      warn "       a) 换一个版本号重发（推荐）；"
      warn "       b) 人工确认后自行执行：git push -f ${GIT_REMOTE} ${HEAD_SHA}:refs/tags/${TAG}"
      warn "     部分成功：dl 已发布（${VER}），GitHub Release 未创建。"
      exit 3
    fi
  else
    if [[ -n ${LTSHA} && ${LTSHA} != "${HEAD_SHA}" ]]; then
      TAG_STATUS=conflict
      write_state tag_conflict
      warn "  ❌ 本地 tag ${TAG} 已存在且指向 ${LTSHA:0:8} ≠ 本 commit ${HEAD_SHA:0:8}：不自动改，人工处置（git tag -d ${TAG} 后重跑）"
      exit 3
    fi
    [[ -n ${LTSHA} ]] || git -C "${ROOT_DIR}" tag "${TAG}" "${HEAD_SHA}"
    info "git push ${GIT_REMOTE} refs/tags/${TAG}"
    if ! git -C "${ROOT_DIR}" push "${GIT_REMOTE}" "refs/tags/${TAG}"; then
      RTSHA=$(git -C "${ROOT_DIR}" ls-remote --tags "${GIT_REMOTE}" "refs/tags/${TAG}^{}" 2>/dev/null | cut -f1 | head -1)
      [[ -n ${RTSHA} ]] || RTSHA=$(git -C "${ROOT_DIR}" ls-remote --tags "${GIT_REMOTE}" "refs/tags/${TAG}" 2>/dev/null | cut -f1 | head -1)
      if [[ ${RTSHA} == "${HEAD_SHA}" ]]; then
        info "并发推送已被别人建好，且指向本 commit → 复用"
        TAG_STATUS=exists_ok
      else
        TAG_STATUS=push_failed; write_state tag_push_failed
        warn "  ⚠️ tag push 失败（远端 tag sha=${RTSHA:-空}）。部分成功：dl 已发布。修好后同 artifact 重跑续发"
        exit 3
      fi
    else
      TAG_STATUS=pushed
      info "tag ${TAG} → ${HEAD_SHA:0:8} 已推送，workflow 将据此创建 GitHub Release"
    fi
  fi
  # 只做“观察”，绝不创建/上传/编辑 Release
  GH_STATUS=workflow_pending
  if (( WAIT_RELEASE > 0 )); then
    info "等待 workflow 创建 GitHub Release（最多 ${WAIT_RELEASE}s）"
    for ((i=0;i<WAIT_RELEASE;i+=10)); do
      if gh release view "${TAG}" --repo "${GH_REPO}" >/dev/null 2>&1; then GH_STATUS=workflow_created; break; fi
      sleep 10
    done
    if [[ ${GH_STATUS} == workflow_created ]]; then
      info "GitHub Release ${TAG} 已由 workflow 创建"
    else
      warn "  ⏳ 未在 ${WAIT_RELEASE}s 内看到 Release：workflow 可能仍在跑或失败，用 gh run list --workflow=release.yml 查看"
    fi
  else
    info "GitHub Release 由 workflow 异步创建（未等待/未验证）：gh run list --workflow=release.yml"
  fi
fi
TAG_DONE=1
write_state done

# ---------------------------------------------------------------- 9) 汇总
step "9/9 汇总（dl 与 GitHub 非原子，按“部分成功”读）"
printf '\n发布汇总 %s\n' "${VER}"
printf '  构建 %s   versionCode %s   commit %s\n' "${BUILD_TYPE}" "${NEW_VC}" "${COMMIT_SHA:0:8}"
(( SKIP_TESTS )) && printf '⚠️  --skip-tests：门禁 4/5/6 未跑（CHANGELOG 已标 [未过门禁]）\n'
(( SKIP_UPSTREAM_E2E )) && printf '⚠️  真实模型上游 e2e 延后补测（反馈上传 e2e 已跑；CHANGELOG/Release notes 已写明）\n'
printf '✅ dl.rose7.cn   %s（md5 %s 已核对，接口 server-side 校验通过）\n' "${DL_URL:-$DL_SITE/apk/deepseek-chat-${VER}.apk}" "${DL_MD5:0:8}"
case ${TAG_STATUS} in
  pushed)     printf '✅ tag         %s → %s 已推送\n' "${TAG}" "${COMMIT_SHA:0:8}" ;;
  exists_ok)  printf '✅ tag         %s 已存在且指向本 commit（未重建）\n' "${TAG}" ;;
  skipped)    printf '⏭️  tag         已跳过（--no-push）\n' ;;
  *)          printf '❌ tag         %s（%s）\n' "${TAG}" "${TAG_STATUS}" ;;
esac
case ${GH_STATUS} in
  workflow_created) printf '✅ GitHub Release %s 已由 workflow 创建（https://github.com/%s/releases/tag/%s）\n' "${TAG}" "${GH_REPO}" "${TAG}" ;;
  workflow_pending) printf '⏳ GitHub Release 由 workflow 异步创建中 → gh run list --workflow=release.yml\n' ;;
  skipped)          printf '⏭️  GitHub Release 未触发（--no-push）\n' ;;
  *)                printf '❌ GitHub Release %s\n' "${GH_STATUS}" ;;
esac
printf '📄 状态文件 %s\n' "${STATE_FILE}"
printf 'ℹ️  本脚本只保证「dl 已发布 + tag 就位」；GitHub Release 由 workflow 完成，不宣称全链路已完成。\n'
exit 0
