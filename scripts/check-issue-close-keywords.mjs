#!/usr/bin/env node
/**
 * PR 正文 closing keyword 门禁（GitHub issue #362 事故）。
 *
 *   node scripts/check-issue-close-keywords.mjs --pr 389            # 按 PR 号取正文（走 gh）
 *   node scripts/check-issue-close-keywords.mjs --body-file pr.md   # 按文件取正文（离线）
 *   node scripts/check-issue-close-keywords.mjs                      # 读 $GITHUB_EVENT_PATH / stdin
 *   node scripts/check-issue-close-keywords.mjs --self-test          # 自检提取器（不联网）
 *
 * 回答一个问题：**PR 正文里那串 closing keyword，会不会把追踪单（母单）顺带关掉？**
 *
 * ## 为什么要这条
 *
 * 2026-11-19 PR #389 正文写了 `Closes #362? 不——域 1+2 只是十域中的两域，母单 #362 保持开启。`
 * 作者本意是**否定**，GitHub 的解析器**只看字符串不看语义**：squash 合并（14:44:51Z）后
 * 一秒（14:44:53Z）就把追踪单 #362 关了，而阶段二实际只完成 2/5、L0 耗时目标没达成。
 * 16:09:06Z 才人工 reopen —— 中间那段「看起来完成、剩余工作没有承接单」的窗口就是损失。
 *
 * GitHub 官方口径（docs：Linking a pull request to an issue）：
 *   - 关键词只有 9 个：close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved
 *   - 可带冒号、可不分大小写（`Closes: #10`、`CLOSES #10` 都算）
 *   - 三种引用形态：`#10` / `owner/repo#100` / 完整 issue URL
 *   - 只看 **PR 描述 + commit message**，且只在 PR 指向**默认分支**时生效 —— 语义、上下文、
 *     "我是在否定它" 一概不看，关键词后面跟一个 `#数字` 就成立（`Closes #362?` 的 `?` 不阻止匹配）。
 *
 * ## 判定口径
 *
 * 从正文里抽出**所有** closing keyword 引用，逐条去问目标 issue 的标题：
 *   - 标题以 `[TRACK]` 或 `[追踪]` 开头（`TRACK_TITLE_RE`）→ **WARN：这是追踪单，退回 `Refs #N`**；
 *   - 其他 issue → 合格（普通 issue 允许由 PR 自动关闭）；
 *   - 查不到标题（离线 / 无 gh / 跨仓库）→ 记为「未判定」，不算违规、但在报告里点名，
 *     由人补一次 `--track` 或联网复跑。
 *
 * 只扫**正文**，不扫 commit message（本门禁够不到）；commit message 里写 closing keyword
 * 同样会触发自动关闭，这条靠人守，见 `AGENTS.md`「Issue 关闭纪律」。
 *
 * ## 会 / 不会跳过什么
 *
 * - 跳过：围栏代码块与行内代码 —— GitHub 不会把代码里的引用做成链接，跟着跳避免自欺；
 * - **不跳过** HTML 注释：注释算不算数取决于 GitHub 内部实现，这里按「算」保守处理。
 *   模板里的提醒写成 `Closes #N`（`N` 不是数字，构不成引用）就是为了在这条保守规则下也安全。
 *
 * ## 退出码
 *
 * 默认只警告（exit 0）；`--strict` 时命中追踪单即 exit 1。
 * 退出码：0 无违规（可能带 WARN）/ 1 --strict 下命中 / 2 用法或环境错误。
 *
 * ## 接线状态（重要）
 *
 * **本脚本目前没有进 CI。** 落地这个 PR 的边界是「只改文档与模板」，`.github/workflows/ci.yml`
 * 不在可改范围；而且接线需要两步都在 `ci.yml` 里：
 *   1. `pull-requests: read` 权限（现在的 workflow 只有 `contents: read`，读不到 PR 正文/
 *      issue 标题，get 会 403）；
 *   2. 一步 `node scripts/check-issue-close-keywords.mjs --strict`（正文用 `$GITHUB_EVENT_PATH`
 *      里的 `pull_request.body` 就够，不必调 API）。
 * 在这两步落地前，它只能手动跑。原因是仓库自己的老毛病：**写了不跑的门禁等于没有** ——
 * 所以别把「脚本存在」当成「规则生效」，接线是独立的一张单。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** 追踪单标题前缀：`[TRACK] xxx` / `[追踪] xxx` */
export const TRACK_TITLE_RE = /^\s*\[(?:TRACK|追踪)\]/i

/**
 * closing keyword 引用。三种形态一次抓完：
 *   `Closes #362` / `Closes: #362` / `fixes owner/repo#12` / `Resolves https://github.com/o/r/issues/9`
 * 数字后面跟什么都不管（`?`、`。`、`)`、`,`）—— GitHub 也是这么截断的，这正是事故成因。
 */
export const CLOSING_REF_RE =
  /(?<![\w-])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![\w-])\s*:?\s*(?:(?:([\w.-]+)\/([\w.-]+))?#(\d+)|https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+))/gi

/** 代码块 / 行内代码：GitHub 不做链接，跟着跳过 */
const FENCE_RE = /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm
const INLINE_CODE_RE = /`[^`\n]*`/g

/** 抹掉代码但保行号：换行留着，其余压成空格 */
function stripCode(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  return text.replace(FENCE_RE, blank).replace(INLINE_CODE_RE, blank)
}

/**
 * 抽出正文里所有 closing keyword 引用。
 * @param {string} body PR 正文
 * @returns {{line:number, keyword:string, number:number, owner:string|null, repo:string|null, raw:string}[]}
 */
export function extractClosingRefs(body) {
  const text = stripCode(body ?? '')
  const out = []
  for (const m of text.matchAll(CLOSING_REF_RE)) {
    const [raw, keyword, ownerA, repoA, numA, ownerB, repoB, numB] = m
    const number = Number(numA ?? numB)
    const start = m.index ?? 0
    const line = text.slice(0, start).split('\n').length
    out.push({
      line,
      keyword: keyword.toLowerCase(),
      number,
      owner: ownerA ?? ownerB ?? null,
      repo: repoA ?? repoB ?? null,
      raw: raw.replace(/\s+/g, ' ').trim(),
    })
  }
  return out
}

/** 用 gh 查标题；拿不到就返回 null（不猜） */
function titleViaGh(number) {
  try {
    const json = execFileSync('gh', ['issue', 'view', String(number), '--json', 'title'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const title = JSON.parse(json).title
    return typeof title === 'string' ? title : null
  } catch {
    return null
  }
}

/** 正文来源：--body-file > --pr(gh) > $GITHUB_EVENT_PATH > stdin */
function readBody(argv) {
  const bodyFile = argv.includes('--body-file') ? argv[argv.indexOf('--body-file') + 1] : null
  if (bodyFile) {
    if (!bodyFile || !existsSync(bodyFile)) throw new Error(`--body-file 指的文件不存在：${bodyFile}`)
    return { body: readFileSync(bodyFile, 'utf8'), source: bodyFile }
  }

  const prIdx = argv.indexOf('--pr')
  if (prIdx !== -1) {
    const pr = argv[prIdx + 1]
    if (!pr || !/^\d+$/.test(pr)) throw new Error('--pr 需要一个数字')
    const body = execFileSync('gh', ['pr', 'view', pr, '--json', 'body', '-q', '.body'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { body, source: `gh pr view ${pr}` }
  }

  const eventPath = process.env.GITHUB_EVENT_PATH
  if (eventPath && existsSync(eventPath)) {
    const evt = JSON.parse(readFileSync(eventPath, 'utf8'))
    const body = evt?.pull_request?.body ?? ''
    return { body, source: `$GITHUB_EVENT_PATH (${eventPath})` }
  }

  if (!process.stdin.isTTY) {
    return { body: readFileSync(0, 'utf8'), source: 'stdin' }
  }
  throw new Error('没给正文：用 --pr / --body-file，或把正文灌进 stdin')
}

const SELF_TEST_CASES = [
  // 真实事故原文（PR #389 第 49 行）
  { body: 'Closes #362? 不——域 1+2 只是十域中的两域，母单 #362 保持开启。', want: [362] },
  { body: 'Closes #362', want: [362] },
  { body: 'CLOSES: #362', want: [362] },
  { body: 'fixes #362, resolves #362', want: [362, 362] },
  { body: 'Fixes octo-org/octo-repo#100', want: [100] },
  { body: 'Resolves https://github.com/zzy-repo/deepseek-app/issues/362', want: [362] },
  { body: 'Refs #362', want: [] },
  { body: '这个 PR 关闭了 #362 的一部分', want: [] },
  // 模板里的提醒写成 #N（不是数字）→ 不该命中
  { body: '<!-- 追踪单请用 Refs #N；不要写 Closes #N -->', want: [] },
  // 代码块里的不算
  { body: '```\nCloses #362\n```', want: [] },
  { body: '`Closes #362` 是反例', want: [] },
  // 别把 unrelated 词吃进来
  { body: 'closesource #362 / prefix #362', want: [] },
]

function selfTest() {
  let bad = 0
  for (const { body, want } of SELF_TEST_CASES) {
    const got = extractClosingRefs(body).map((r) => r.number)
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) bad++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(body)} → [${got}]${ok ? '' : `（期望 [${want}]）`}`)
  }
  console.log(bad === 0 ? `\n自检通过：${SELF_TEST_CASES.length} 条` : `\n自检失败：${bad} 条`)
  process.exit(bad === 0 ? 0 : 1)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) selfTest()

  const strict = argv.includes('--strict')
  const json = argv.includes('--json')
  const trackIdx = argv.indexOf('--track')
  const trackList = trackIdx !== -1 ? new Set((argv[trackIdx + 1] ?? '').split(',').filter(Boolean).map(Number)) : null

  let body
  let source
  try {
    ;({ body, source } = readBody(argv))
  } catch (err) {
    console.error(`[env] ${err.message}`)
    process.exit(2)
  }

  const refs = extractClosingRefs(body)
  const violations = []
  const unknown = []

  for (const ref of refs) {
    let isTrack
    let title = null
    if (trackList) {
      isTrack = trackList.has(ref.number)
    } else {
      title = titleViaGh(ref.number)
      if (title === null) {
        unknown.push(ref)
        continue
      }
      isTrack = TRACK_TITLE_RE.test(title)
    }
    if (isTrack) violations.push({ ...ref, title })
  }

  if (json) {
    console.log(JSON.stringify({ source, refs, violations, unknown }, null, 2))
    process.exit(strict && violations.length > 0 ? 1 : 0)
  }

  console.log('PR 正文 closing keyword 门禁（#362 事故）')
  console.log(`  正文来源：${source}`)
  console.log(`  检出 closing keyword 引用 ${refs.length} 处`)
  if (trackList) console.log(`  追踪单清单：${[...trackList].join(', ')}（--track 指定）`)
  console.log('')

  for (const v of violations) {
    console.log(`WARN 第 ${v.line} 行  ${v.raw}`)
    console.log(`     → #${v.number} 是追踪单：${(v.title ?? '').slice(0, 60)}`)
    console.log('     改用 `Refs #' + v.number + '`。追踪单只允许人工关闭，且必须 checklist 全 ✅。')
  }
  for (const u of unknown) {
    console.log(`未判定 第 ${u.line} 行  ${u.raw}`)
    console.log(`     → 查不到 #${u.number} 的标题：联网复跑，或用 --track ${u.number} 显式声明`)
  }

  if (violations.length === 0 && unknown.length === 0) {
    console.log(refs.length === 0 ? '合格：正文没有 closing keyword 引用。' : '合格：closing keyword 都没指到追踪单。')
    process.exit(0)
  }
  if (violations.length === 0) {
    console.log('合格（有未判定）：没有确认违规，但别把「查不到」当「没问题」。')
    process.exit(0)
  }
  if (strict) {
    console.log(`不合格：${violations.length} 处 closing keyword 指向追踪单（--strict）。改成 Refs 重推。`)
    process.exit(1)
  }
  console.log(`提醒：${violations.length} 处 closing keyword 指向追踪单。合并会真的关掉它 —— 改 Refs 或人工确认。`)
  process.exit(0)
}

main()
