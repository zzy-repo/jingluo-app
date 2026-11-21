// [layer: unit | 纯 Node（子进程 + 临时 git 仓库），无浏览器无网络 | 耗时: ~2s]
//
// `check:release-traceability`（scripts/check-release-traceability.mjs）的 L0 用例 —— v1.4.5 事故的判据自测。
//
// 事故（2026-11-21）：`v1.4.5` 的 tag 指向 `d5391944`（版本号 PR 分支上的提交），main 上同题提交是
// squash 之后的 `b43d5559`：
//
//     $ git merge-base --is-ancestor v1.4.5 origin/main ; echo $?
//     1
//
// 想「从 tag 复现问题」会 checkout 到一棵不在主线上的树；发布物与 main 的对应关系只能靠人记。
// 而当时 30 多道门禁全绿 —— 它们看的都是「产物」和「工作区」，没有一道问过「这个 tag 在不在 main 上」。
//
// 本文件钉四件事（每件都是「判据会不会悄悄失效」的形状）：
//   1. **annotated tag 必须先 deref**：拿 tag **对象**的 sha 去判祖先，轻则 git 报「不是提交」，
//      重则结论毫无意义。真仓库里 v1.2.3 / v1.3.0 就是 annotated tag，所以这不是理论问题。
//   2. 非 main 祖先 → 红，且**点名** tag / sha / 提交标题（只证明 exit≠0 不够：红在别处也算红）。
//   3. main 祖先 → 绿（没有这一拍，「注入→红」可能只是门禁恒红）。
//   4. gh 不可用 → exit 2（**不是** exit 1）：判不了要如实说「判不了」，不能伪装成「不在 main 上」——
//      两种红的修法完全不同（前者修环境，后者改 tag）。
//
// 另钉**豁免清单**（#651 / #738，`scripts/release-traceability-allowlist.json`）那五件：
//   5. 命中豁免 → 绿，且输出里必须有 `[ALLOW] tag=… reason="…" reviewAfter=…`（**不静默**：红着却 exit 0
//      这件事只能靠这一行解释，谁把它删掉谁就把「有到期日的例外」变回了「偷偷放过」）；
//   6. `reviewAfter` 已过期 → 红（用 `--now` 注入日期，不动系统时间；到期**当天**仍有效）；
//   7. `--strict` 下条目缺 `reason` / `reviewAfter` → 红（CI 里自动等价开启：口径不能只写在 ci.yml 那一行）；
//   8. 清单里的 tag 已不存在于仓库 → `[WARN]` 点名「过期条目该清理」（豁免清单不许变成垃圾桶）；
//   9. 清单文件不存在 → 视为空表正常跑（没有历史遗留时，文件在不在都不该改变判据）。
// 这些用例同样钉住「豁免 ≠ 放宽」：豁免只会让**有到期日的显式例外**通过，判据本身一个字都没软。
//
// 另钉两条**前提**用例（CI 上的真实形态，实测过）：浅克隆 / 缺 `origin/main` 都必须 exit 2 并点明修法。
// `actions/checkout` 默认 `fetch-depth: 1`（浅克隆且不带 tag），这两种缺失在 CI 上是常态而不是意外。
//
// 为什么不拿真仓库当注入对象：判据的输入是**提交图**，最干净的做法是造一棵可控的小仓库
// （`git init` + 两个提交 + 一条分支 + `update-ref refs/remotes/origin/main`）。往真仓库塞 tag 反而不稳：
// 它依赖「真仓库里正好有一个不在 main 上的提交」（浅克隆里根本没有），而且并行跑的单元层会互相看见。
// 真仓库上那一拍（造 tmp tag → 必须红 → 删掉 → `git status` 干净）的原始输出留在 PR 证据里。
//
// 负向对照登记在 tests/unit/gate-negative-controls.test.mjs 的 REGISTRY（`kind: 'ci'`：
// 那四拍在 ci.yml 的「负向对照：不在 main 历史里的 tag …」那一步里真跑）；本文件是同一判据的
// 离线可重复版本，覆盖 annotated deref / gh 不可用 / 浅克隆这些 ci.yml 里造不出来的形态。

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ALLOWLIST,
  classifyTargetCommitish,
  expiryOf,
  isIsoDate,
  loadAllowlist,
  parseArgs,
  resolveStrict,
} from '../../scripts/check-release-traceability.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts/check-release-traceability.mjs')
const CI_FILE = path.join(ROOT, '.github/workflows/ci.yml')

/** 子进程里统一扣掉「CI 身份」与 gh：CI 变量会让 `--offline-skip` 走禁用分支，gh 会去碰网络 */
const childEnv = (extra = {}) => {
  const env = { ...process.env, GH_BIN: path.join(tmpdir(), '__no_such_gh_binary__'), ...extra }
  delete env.GITHUB_ACTIONS
  delete env.GITHUB_REPOSITORY
  delete env.CI
  for (const [key, value] of Object.entries(extra)) env[key] = value
  if (extra.GITHUB_ACTIONS === undefined) delete env.GITHUB_ACTIONS
  if (extra.CI === undefined) delete env.CI
  return env
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * 造一棵可控的小仓库：
 *
 *   A ── B            main（B 就是「origin/main」，用 update-ref 造，不需要真 remote）
 *    └── C            feat/probe（C 不在 main 历史里 —— squash 合并前 PR 头提交的形状）
 *
 * 没有 origin remote 是**有意的**：这样脚本无法确定 gh 仓库，`targetCommitish` 交叉核对会自动跳过
 * （打印跳过原因），用例因此不碰网络 —— 本地 gh 装没装、登没登录都不影响结果。
 */
const makeRepo = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-trace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q')
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(dir, 'config', 'user.email', 'gate@example.invalid')
  git(dir, 'config', 'user.name', 'gate')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-q', '-m', 'main: 第一个提交')
  const base = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', 'b.txt')
  git(dir, 'commit', '-q', '-m', 'main: 第二个提交（origin/main 指这里）')
  const mainSha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', '-b', 'feat/probe', base)
  writeFileSync(path.join(dir, 'c.txt'), 'c\n')
  git(dir, 'add', 'c.txt')
  git(dir, 'commit', '-q', '-m', 'feat: 分支上的提交（不在 main 历史里）')
  const offMain = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'update-ref', 'refs/remotes/origin/main', mainSha)
  return { dir, base, mainSha, offMain }
}

/** 写一份临时豁免清单（`--allowlist` 指向它：用例永远不碰入库的那份，免得互相影响） */
const writeAllowlist = (repo, entries) => {
  const file = path.join(repo.dir, 'allowlist.json')
  writeFileSync(file, `${JSON.stringify({ _meta: { version: 1, policy: '用例桩' }, ...entries }, null, 2)}\n`)
  return file
}

const runGate = (cwd, args, env = {}) => {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: childEnv(env) })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

// ---------------------------------------------------------------- 判据的两块纯逻辑

test('参数：没有「放宽」开关 —— 未知参数一律 exit 2（--allow-missing-main 之类从这里就被拦住）', () => {
  // 「今天先放过」的开关一旦存在，第二次事故时它就是默认值（v1.4.5 的成因正是没人拦）。
  assert.throws(() => parseArgs(['--allow-missing-main']), /未知参数/)
  assert.throws(() => parseArgs(['--allow-off-main']), /未知参数/)
  assert.throws(() => parseArgs(['--warn']), /未知参数/)
  // 值缺失 / 值非法都要当场拒（不许把 `--tag` 后面那个 flag 当成 tag 名）
  assert.throws(() => parseArgs(['--tag']), /需要一个值/)
  assert.throws(() => parseArgs(['--tag', '--limit', '3']), /需要一个值/)
  assert.throws(() => parseArgs(['--limit', '0']), /≥1 的整数/)
  assert.throws(() => parseArgs(['--limit', 'abc']), /≥1 的整数/)

  const options = parseArgs(['--tag', 'v1.4.5', '--tag', 'v1.4.3', '--include-prerelease', '--limit', '3'])
  assert.deepEqual(options.tags, ['v1.4.5', 'v1.4.3'])
  assert.equal(options.includePrerelease, true)
  assert.equal(options.limit, 3)
  assert.equal(options.offlineSkip, false)
})

test('targetCommitish：分支名跳过（但不是静默）、sha 一致才通过、sha 不一致必须判红', () => {
  const commit = 'd5391944268f8cae550c4e8ba378b0a67826d58f'

  // gh release view 的 targetCommitish 通常只是分支名 —— 分支名发布后会移动，不能当 commit 判据
  const branch = classifyTargetCommitish('main', commit)
  assert.equal(branch.verdict, 'branch')
  assert.match(branch.detail, /是分支名/)
  assert.match(branch.detail, /跳过这一条/)

  // 完整 sha / 短 sha（≥7 位）都算一致（v1.4.5 / v1.4.3 的 release 里就是完整 sha）
  assert.equal(classifyTargetCommitish(commit, commit).verdict, 'match')
  assert.equal(classifyTargetCommitish(commit.slice(0, 8), commit).verdict, 'match')

  // 不一致 = 断言不成立（exit 1），必须把两个值都点出来
  const mismatch = classifyTargetCommitish('b43d555900000000000000000000000000000000', commit)
  assert.equal(mismatch.verdict, 'mismatch')
  assert.match(mismatch.detail, /不一致/)

  // 空值不是「通过」：说不清就说不清
  assert.equal(classifyTargetCommitish('', commit).verdict, 'absent')
  assert.equal(classifyTargetCommitish(undefined, commit).verdict, 'absent')
})

// ---------------------------------------------------------------- 四拍（临时仓库）

test('非 main 祖先（squash 合并前 PR 头提交的形状）→ exit 1，且点名 tag / sha / 提交标题', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-test', repo.offMain)

  const result = runGate(repo.dir, ['--tag', 'tmp-trace-test'])
  assert.equal(result.status, 1, `必须 exit 1（红），实际 ${result.status}：\n${result.out}`)
  assert.match(result.out, /tag `tmp-trace-test` 指向 `[0-9a-f]{8}`/)
  assert.match(result.out, /不在 origin\/main 历史里/)
  // 修法必须写在报错里（「红了但不知道该干什么」= 下一个人会去关掉门禁）
  assert.match(result.out, /请把 tag 重指到 main 上的提交后重建/)
  assert.match(result.out, /feat: 分支上的提交/)
  // 红要红在「祖先判定」上，不是红在别的环境问题上
  assert.doesNotMatch(result.out, /\[ENV\]/)
})

test('main 祖先（origin/main 本身 / 更早的祖先提交）→ exit 0，且报出它在历史里', (t) => {
  const repo = makeRepo(t)
  // 两个都验：指向 origin/main 提交本身、指向它更早的祖先 —— 祖先判定不是「等于」判定
  git(repo.dir, 'tag', 'tmp-trace-ok', repo.mainSha)
  git(repo.dir, 'tag', 'tmp-trace-ok-old', repo.base)

  for (const tag of ['tmp-trace-ok', 'tmp-trace-ok-old']) {
    const result = runGate(repo.dir, ['--tag', tag])
    assert.equal(result.status, 0, `tag ${tag} 在 main 历史里，必须 exit 0，实际 ${result.status}：\n${result.out}`)
    assert.match(result.out, new RegExp(`tag \`${tag}\` → [0-9a-f]{8}`))
    assert.match(result.out, /在 origin\/main 历史里/)
    assert.match(result.out, /✓ 1 绿 \/ 0 红/)
  }
})

test('annotated tag 必须 deref 到提交：报的是提交 sha，不是 tag 对象的 sha', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', '-a', 'tmp-trace-ann', '-m', 'annotated probe', repo.offMain)
  const tagObject = git(repo.dir, 'rev-parse', 'refs/tags/tmp-trace-ann')
  const commit = git(repo.dir, 'rev-parse', 'refs/tags/tmp-trace-ann^{commit}')
  // 先证明这真的是 annotated tag（两者不同），否则这条用例什么都没验
  assert.notEqual(tagObject, commit, '这没造出 annotated tag —— 用例前提不成立')

  const result = runGate(repo.dir, ['--tag', 'tmp-trace-ann'])
  assert.equal(result.status, 1, `annotated tag 指向非 main 提交也必须红：\n${result.out}`)
  assert.match(result.out, /tag 形态：annotated tag（对象 [0-9a-f]{8} → deref 到提交 [0-9a-f]{8}）/)
  // 关键：判据用的是**提交** sha。用 tag 对象 sha 去判，git 会报「不是有效提交」，红的原因就换了
  assert.match(result.out, new RegExp(`完整 sha：${commit}`))
  assert.doesNotMatch(result.out, new RegExp(`完整 sha：${tagObject}`))
})

// ---------------------------------------------------------------- 前提缺失（CI 上的真实形态）

test('gh 不可用 → exit 2（不是 exit 1）且点明「要装 gh / 登录」，不许伪装成「不在 main 上」', (t) => {
  const repo = makeRepo(t)
  // 默认模式（不带 --tag）必须靠 gh 列 releases：gh 不在 = 环境红，不是断言红
  const result = runGate(repo.dir, ['--repo', 'owner/name'])
  assert.equal(result.status, 2, `gh 不可用必须 exit 2，实际 ${result.status}：\n${result.out}`)
  assert.match(result.out, /\[ENV\] 找不到可执行的 gh/)
  assert.match(result.out, /gh auth login/)
  assert.doesNotMatch(result.out, /不在 origin\/main 历史里/)
})

test('缺 origin/main → exit 2，并把「怎么补」写进报错（CI 上这就是 fetch 那一步的坑）', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'update-ref', '-d', 'refs/remotes/origin/main')
  git(repo.dir, 'tag', 'tmp-trace-x', repo.offMain)

  const result = runGate(repo.dir, ['--tag', 'tmp-trace-x'])
  assert.equal(result.status, 2, `缺 origin/main 必须 exit 2，实际 ${result.status}：\n${result.out}`)
  assert.match(result.out, /本地没有 `origin\/main`/)
  assert.match(result.out, /git fetch --no-tags origin main/)
})

test('浅克隆 → exit 2：历史不在本地时不许把「判不了」说成「不在 main 上」（假红比不测更糟）', (t) => {
  const source = makeRepo(t)
  const cloneRoot = mkdtempSync(path.join(tmpdir(), 'release-trace-shallow-'))
  t.after(() => rmSync(cloneRoot, { recursive: true, force: true }))
  const cloneDir = path.join(cloneRoot, 'clone')
  // file:// 才会真的走传输、--depth 才生效（本地路径克隆会退化成硬链接，忽略 --depth）
  git(cloneRoot, 'clone', '-q', '--depth', '1', '--no-tags', `file://${source.dir}`, cloneDir)
  assert.equal(git(cloneDir, 'rev-parse', '--is-shallow-repository'), 'true', '克隆没变浅，用例前提不成立')

  const result = runGate(cloneDir, ['--tag', 'whatever'])
  assert.equal(result.status, 2, `浅克隆必须 exit 2，实际 ${result.status}：\n${result.out}`)
  assert.match(result.out, /浅克隆/)
  assert.match(result.out, /unshallow|fetch-depth: 0/)
})

test('--offline-skip：本机打印「已跳过（离线）」并 exit 0；CI 里被硬禁（exit 2）', (t) => {
  const repo = makeRepo(t)

  const local = runGate(repo.dir, ['--offline-skip'])
  assert.equal(local.status, 0, `本机离线跳过应 exit 0：\n${local.out}`)
  assert.match(local.out, /已跳过（离线）/)

  // CI 里禁用：判据落在脚本里（ci.yml 那行怎么写都会变，脚本里的禁令不会）
  const ci = runGate(repo.dir, ['--offline-skip'], { GITHUB_ACTIONS: 'true' })
  assert.equal(ci.status, 2, `CI 里 --offline-skip 必须 exit 2：\n${ci.out}`)
  assert.match(ci.out, /CI 里禁用 --offline-skip/)

  // 未知的「放宽」开关在端到端这一层同样被拒（不是只在 parseArgs 单测里被拒）
  const relaxed = runGate(repo.dir, ['--allow-missing-main'])
  assert.equal(relaxed.status, 2, `未知参数必须 exit 2：\n${relaxed.out}`)
  assert.match(relaxed.out, /未知参数/)
})

// ---------------------------------------------------------------- 豁免清单（有到期日的显式例外，#651 / #738）

test('豁免清单：命中的 tag → exit 0，且 `[ALLOW] tag=… reason="…" reviewAfter=…` 一行不少（不静默）', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-legacy', repo.offMain)
  const allowlist = writeAllowlist(repo, {
    'tmp-trace-legacy': {
      reason: '版本提交从未并入 main（用例桩），重指等于伪造祖先关系',
      addedAt: '2026-11-21',
      reviewAfter: '2027-01-31',
    },
  })

  // 未过期：2026-12-01 < 2027-01-31
  const result = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', allowlist, '--now', '2026-12-01'])
  assert.equal(result.status, 0, `命中未过期豁免应 exit 0，实际 ${result.status}：\n${result.out}`)
  assert.match(
    result.out,
    /\[ALLOW\] tag=tmp-trace-legacy reason="版本提交从未并入 main（用例桩），重指等于伪造祖先关系" reviewAfter=2027-01-31/
  )
  // 豁免 ≠ 静默：不计入失败，但 sha / 复核命令 / 到期日必须一起摊在输出里（否则「红着但 exit 0」没人看得懂）
  assert.doesNotMatch(result.out, /\[FAIL\]/)
  assert.match(result.out, new RegExp(`完整 sha：${repo.offMain}`))
  assert.match(result.out, /复核命令：git merge-base --is-ancestor/)
  assert.match(result.out, /未过期；到期后必须复审/)
  assert.match(result.out, /✓ 1 绿 \/ 0 红/)
  assert.match(result.out, /其中 1 个走豁免/)
})

test('豁免到期 → exit 1：报「豁免已过期，请重指或删除该 tag」并点名 reason（到期日是这套机制的全部意义）', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-legacy', repo.offMain)
  const allowlist = writeAllowlist(repo, {
    'tmp-trace-legacy': { reason: 'c504ee51 从未并入 main（用例桩）', reviewAfter: '2027-01-31' },
  })

  // 到期**当天**仍有效：reviewAfter 是「最晚复审到哪一天」，不是「从哪天起作废」
  const boundary = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', allowlist, '--now', '2027-01-31'])
  assert.equal(boundary.status, 0, `到期当天仍应绿，实际 ${boundary.status}：\n${boundary.out}`)

  const expired = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', allowlist, '--now', '2027-02-01'])
  assert.equal(expired.status, 1, `豁免过期必须 exit 1，实际 ${expired.status}：\n${expired.out}`)
  assert.match(expired.out, /豁免已过期（reviewAfter=2027-01-31 < 今天 2027-02-01）/)
  assert.match(expired.out, /请重指或删除该 tag/)
  // 过期了就不能再打 [ALLOW]：否则「到期」只是输出里一句没人看的文本
  assert.doesNotMatch(expired.out, /\[ALLOW\] tag=tmp-trace-legacy/)
  // 该条 reason 必须点出来（「红了但不知道该找谁问」= 下一个人把门禁关掉）
  assert.match(expired.out, /c504ee51 从未并入 main（用例桩）/)
})

test('--strict：条目缺 reason / 缺 reviewAfter / reviewAfter 不是日期 → exit 1（非 strict 下也 WARN 点名，不静默）', (t) => {
  const cases = [
    { name: '缺 reason', entry: { reviewAfter: '2027-01-31' }, pattern: /缺 `reason`/ },
    { name: '缺 reviewAfter', entry: { reason: 'c504ee51 从未并入 main（用例桩）' }, pattern: /缺 `reviewAfter`/ },
    { name: 'reviewAfter 不是合法日期', entry: { reason: '用例桩', reviewAfter: '2027-02-30' }, pattern: /不是合法的 YYYY-MM-DD 日期/ },
  ]

  for (const item of cases) {
    const repo = makeRepo(t)
    git(repo.dir, 'tag', 'tmp-trace-legacy', repo.offMain)
    const allowlist = writeAllowlist(repo, { 'tmp-trace-legacy': item.entry })

    const strict = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', allowlist, '--now', '2026-12-01', '--strict'])
    assert.equal(strict.status, 1, `--strict 下「${item.name}」必须 exit 1，实际 ${strict.status}：\n${strict.out}`)
    assert.match(strict.out, item.pattern)
    assert.match(strict.out, /豁免清单 `tmp-trace-legacy`/)

    // 非 strict：不红，但必须 WARN 点名（把问题藏起来才是最坏的那种「绿」）
    const loose = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', allowlist, '--now', '2026-12-01'])
    assert.equal(loose.status, 0, `非 strict 下「${item.name}」不该变成红（该红的是 strict 那一拍）：\n${loose.out}`)
    assert.match(loose.out, /\[WARN\] 豁免清单 `tmp-trace-legacy`/)
    assert.match(loose.out, item.pattern)
    assert.match(loose.out, /--strict` \/ CI 里这就是红/)
  }
})

test('CI 环境自动等价 --strict（口径不交给 ci.yml 那一行怎么写），且合法条目在 CI 里照样绿', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-legacy', repo.offMain)

  const legal = writeAllowlist(repo, {
    'tmp-trace-legacy': { reason: '用例桩：无法重指', addedAt: '2026-11-21', reviewAfter: '2027-01-31' },
  })
  const okCi = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', legal, '--now', '2026-12-01'], { GITHUB_ACTIONS: 'true' })
  assert.equal(okCi.status, 0, `合法条目在 CI 里必须绿（严格口径不能把合规豁免判红）：\n${okCi.out}`)
  assert.match(okCi.out, /严格口径：开（CI 环境自动开/)
  assert.match(okCi.out, /\[ALLOW\] tag=tmp-trace-legacy/)

  const illegal = writeAllowlist(repo, { 'tmp-trace-legacy': { reason: '用例桩：缺到期日' } })
  const badCi = runGate(repo.dir, ['--tag', 'tmp-trace-legacy', '--allowlist', illegal, '--now', '2026-12-01'], { GITHUB_ACTIONS: 'true' })
  assert.equal(badCi.status, 1, `CI 里缺 reviewAfter 必须红（否则「CI 严格」只是文档上的一句话）：\n${badCi.out}`)
  assert.match(badCi.out, /缺 `reviewAfter`/)
})

test('豁免清单里的 tag 已不存在于仓库 → [WARN] 点名「过期条目该清理」，不静默，也不影响别的 tag 的绿', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-ok', repo.mainSha)
  // 只登记一个**根本不存在**的 tag：tag 被删 / release 撤下之后，条目就该被清理
  const allowlist = writeAllowlist(repo, {
    'tmp-trace-gone': { reason: '曾豁免过（用例桩）', addedAt: '2026-11-21', reviewAfter: '2027-01-31' },
  })

  const result = runGate(repo.dir, ['--tag', 'tmp-trace-ok', '--allowlist', allowlist, '--now', '2026-12-01'])
  assert.equal(result.status, 0, `清单里有失效条目不该把这一跑判红（红的是「不该留在清单里」，不是「tag 不在 main 上」）：\n${result.out}`)
  assert.match(result.out, /\[WARN\] 豁免清单里的 `tmp-trace-gone` \*\*已不存在于仓库\*\*/)
  assert.match(result.out, /过期条目该清理/)
  // 同一次输出里 tmp-trace-ok 必须真的被查过（否则这只是一次「什么都没验的绿」）
  assert.match(result.out, /\[OK\]   tag `tmp-trace-ok`/)
})

test('豁免了「其实已经是 main 祖先」的 tag → 仍绿，但 WARN 点名「用不上了，请删掉」（豁免清单不许变成垃圾桶）', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-ok', repo.mainSha)
  const allowlist = writeAllowlist(repo, {
    'tmp-trace-ok': { reason: '曾经无法重指（用例桩，现已可溯源）', addedAt: '2026-11-21', reviewAfter: '2027-01-31' },
  })

  const result = runGate(repo.dir, ['--tag', 'tmp-trace-ok', '--allowlist', allowlist, '--now', '2026-12-01'])
  assert.equal(result.status, 0, `已经在 main 历史里的 tag 本来就绿：\n${result.out}`)
  assert.match(result.out, /\[WARN\] tag `tmp-trace-ok` 其实\*\*已经是 origin\/main 的祖先\*\*/)
  assert.match(result.out, /请从豁免清单里删除/)
})

test('豁免清单不存在 → 视为空表正常跑（不报错、不改变判据）；清单 JSON 坏掉 → exit 2（解析不了就不许当空表）', (t) => {
  const repo = makeRepo(t)
  git(repo.dir, 'tag', 'tmp-trace-ok', repo.mainSha)

  const missing = runGate(repo.dir, ['--tag', 'tmp-trace-ok', '--allowlist', path.join(repo.dir, 'nope-allowlist.json')])
  assert.equal(missing.status, 0, `缺清单文件必须正常跑：\n${missing.out}`)
  assert.match(missing.out, /不存在 → 视为空表/)
  assert.match(missing.out, /\[OK\]   tag `tmp-trace-ok`/)
  assert.doesNotMatch(missing.out, /\[ENV\]/)

  // 坏 JSON 不能静默当空表 —— 那等于把清单里所有例外悄悄丢掉（红会出现在别处，比红在这里难查得多）
  const brokenPath = path.join(repo.dir, 'broken-allowlist.json')
  writeFileSync(brokenPath, '{ "v9.9.9": { "reason": "x", }\n')
  const broken = runGate(repo.dir, ['--tag', 'tmp-trace-ok', '--allowlist', brokenPath])
  assert.equal(broken.status, 2, `坏 JSON 必须 exit 2（环境问题），实际 ${broken.status}：\n${broken.out}`)
  assert.match(broken.out, /豁免清单不是合法 JSON/)
})

test('入库的豁免清单自检：每条 reason / reviewAfter 合法，且 v1.4.5 **不许**在里面（它有 main 提交，正确修法是重指）', () => {
  assert.match(DEFAULT_ALLOWLIST, /scripts\/release-traceability-allowlist\.json$/)

  const allowlist = loadAllowlist({ file: DEFAULT_ALLOWLIST })
  assert.equal(allowlist.present, true, '入库的豁免清单不见了（政策在 docs/RELEASE-MANUAL.md §6.2）')
  const entries = allowlist.entries
  assert.ok(entries.length >= 1, '清单里一条豁免都没有？那 v1.4.1 会红 —— 要么补条目，要么把这条用例一起删掉')

  for (const entry of entries) {
    assert.deepEqual(entry.problems, [], `豁免条目 \`${entry.tag}\` 不合规：${entry.problems.join('；')}`)
    assert.ok(isIsoDate(entry.reviewAfter), `\`${entry.tag}\` 的 reviewAfter 不是合法日期`)
    assert.ok(isIsoDate(entry.addedAt), `\`${entry.tag}\` 的 addedAt 不是合法日期（可审计性）`)
    // 到期判据必须算得出来：拿「登记那天」和「到期后一天」各拍一次
    assert.equal(expiryOf(entry, entry.addedAt).expired, false, `\`${entry.tag}\` 在登记当天就过期了？`)
  }

  // v1.4.1：版本提交 c504ee51 从未并入 main（main 从 1.4.0 直接到 1.4.3）→ 只能豁免
  assert.ok(entries.some((entry) => entry.tag === 'v1.4.1'), 'v1.4.1 必须留在豁免清单里（重指等于伪造祖先关系）')
  // v1.4.5：有对应 main 提交 b43d5559 → **必须重指**。一旦被塞进豁免，豁免就变成了「放宽」。
  assert.ok(
    !entries.some((entry) => entry.tag === 'v1.4.5'),
    'v1.4.5 有对应 main 提交（b43d5559），正确修法是重指 tag，不是进豁免清单'
  )
})

// ---------------------------------------------------------------- 接线（登记为 kind: 'ci'，命令口径不许被改软）

test('ci.yml：这一步是单行 `run: pnpm run check:release-traceability`、无 continue-on-error、且先补历史与 tag', () => {
  const ci = readFileSync(CI_FILE, 'utf8')
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  // 命令行口径：package.json 里就是「裸跑脚本」，没有 --tag / --limit / --offline-skip 之类的软化参数
  assert.equal(pkg.scripts['check:release-traceability'], 'node scripts/check-release-traceability.mjs')

  // N6 / C8 两套登记机制都只认**单行** `run: pnpm run <gate>` —— 写成多行块里的 `pnpm run …`
  // 会从两套机制里一起消失（登记表 stale、接线看不见）。这条把那个形态钉死。
  assert.match(ci, /^\s*run: pnpm run check:release-traceability$/m, 'ci.yml 里必须是单行 `run: pnpm run check:release-traceability`')

  // 从「这一步的 name」到「下一条 name」之间的块里不许出现 continue-on-error
  const lines = ci.split('\n')
  const stepIndex = lines.findIndex((line) => /- name: release 溯源（check:release-traceability）/.test(line))
  assert.ok(stepIndex >= 0, 'ci.yml 里找不到这道门禁的步骤（被摘掉了？）')
  const block = []
  // 块的右边界：下一个 step（`      - name:`）或步骤之间的注释行（`      #`）——两者都是 6 空格缩进，
  // 只按 `- name:` 切会把**下一个步骤的注释**算进来（那段注释里就写着 continue-on-error）。
  for (let index = stepIndex; index < lines.length; index++) {
    if (index > stepIndex && /^ {0,6}(?:#|- )/.test(lines[index])) break
    block.push(lines[index])
  }
  assert.doesNotMatch(block.join('\n'), /continue-on-error/, '这道门禁不许带 continue-on-error（那等于把它关掉）')

  // 前提：门禁**之前**必须有那两步 fetch（origin/main + tags + unshallow），否则 CI 上必然假红/报缺 tag
  const before = lines.slice(0, stepIndex).join('\n')
  assert.match(before, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/)
  assert.match(before, /git fetch --force --tags origin/)
  assert.match(before, /git rev-parse --is-shallow-repository/)

  // 负向对照：同一份文件里必须有一条「造非 main tag → 必须红」的四拍步骤，且是真判定
  // （`if …; then … exit 1` + 独立成行的 `exit 1`），不能只 echo。
  const negative = lines
    .slice(stepIndex)
    .join('\n')
    .split(/\n\s*- name: /)
    .find((chunk) => /不在 main 历史里的 tag 必须被 check:release-traceability 拦下/.test(chunk)) ?? ''
  assert.ok(negative, 'ci.yml 里找不到这道门禁的负向对照步骤')
  assert.match(negative, /if node scripts\/check-release-traceability\.mjs[^\n]*;[^\n]*then/)
  assert.match(negative, /^[ \t]*exit 1[ \t]*$/m)
  assert.doesNotMatch(negative, /continue-on-error/)
})
