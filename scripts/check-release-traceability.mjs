#!/usr/bin/env node
/**
 * check-release-traceability.mjs —— 「已发布的 tag 必须在 `main` 历史里」（v1.4.5 事故）
 *
 * ## 这道门禁治的是什么
 *
 * 2026-11-21，`v1.4.5` 发出去之后才发现：tag 指向 `d5391944` —— 那是**版本号 PR 分支上的提交**，
 * 而 main 上同题提交是 squash 之后的 `b43d5559`：
 *
 *     $ git merge-base --is-ancestor v1.4.5 origin/main ; echo $?
 *     1
 *
 * 后果不是「包里差几行」，而是**溯源链断了**：想「从 tag 复现问题」，checkout 出来是一棵
 * 不在主线上的树；发布物与 main 上哪个提交对应，只能靠人记。当时 30 多道门禁全绿 ——
 * 因为它们检查的都是「产物」和「工作区」，**没有一道问过「这个 tag 在不在 main 上」**。
 *
 * ## 判据（只有一条，而且必须是溯源关系）
 *
 *   对每个已发布的 release：`git merge-base --is-ancestor <tag 指向的提交> origin/main`
 *   的退出码必须为 0（= 该提交是 origin/main 的祖先 = 发布物确实出自这条主线）。
 *
 * ### 一个坑：**不要**拿 `git diff <tag> main` 当判据
 *
 * 事故当晚差点被它带错结论：`git diff v1.4.5 origin/main` 里有 3 个文件差异，但
 *   · `auth.ts` 那 7 行**全是注释**（squash 后措辞/行号不同）；
 *   · 另外两个文件**根本不进包**（不在 rspack 的 entry 图里）。
 * 所以「diff 里有文件」≠「产物里差这些改动」；反过来也成立：「diff 为空」证明不了 tag 在 main 上
 * （两条不同的提交线完全可以有逐字节相同的树）。唯一站得住的判据是**祖先关系** ——
 * 「这棵树是不是由主线产生」是提交图上的事实，不是文本差异能猜的。
 * 同理，本脚本**不**去猜「包里有没有某个改动」：那是产物层门禁（check:bundle-target / check:test-seam）
 * 与 golden 套件的活。
 *
 * ## 为什么用 `git` 判祖先、用 `gh` 只做两件事
 *
 *   · `git` 判祖先：纯本地、无网络、无权限，结论只取决于本地拿到的提交图。
 *   · `gh` 只用来（a）列出「哪些 tag 算已发布」，（b）读 release 的 `targetCommitish` 做交叉核对。
 *
 * **不用 gh 的隐式仓库解析**（踩过）：本仓库同时挂着 `upstream`（deepseek-ai/chat-demo，v0.1.x 的
 * 上游模板），`gh` 在 fork 里**优先取 upstream** —— 裸跑 `gh release list` 列出的是**另一个仓库**的
 * release（v0.1.0…v0.1.3，与我们的 v1.4.x 毫无关系），据此判祖先只会得到一堆莫名其妙的红。
 * 所以仓库一律**显式**确定：`--repo` → `GITHUB_REPOSITORY` → `git remote get-url origin`，三个都拿不到
 * 就 fail-closed（exit 2），绝不回退到 gh 的猜测。
 *
 * ## annotated tag 必须先 deref
 *
 * `git rev-list -n1 <tag>` / `gh api .../git/ref/tags/<tag>` 拿到的是 **tag 对象的 sha**（annotated tag），
 * 不是提交。拿 tag 对象 sha 去 `merge-base --is-ancestor` 会报「not a valid commit」或者给出无意义的结论。
 * 这里统一走 `refs/tags/<t>^{commit}`（lightweight / annotated 两种都正确），并在输出里标明 tag 的类型。
 *
 * ## 用法
 *
 *   node scripts/check-release-traceability.mjs                       # 默认：最近 5 个正式版 release
 *   node scripts/check-release-traceability.mjs --tag v1.4.5          # 只查一个 tag（可重复）
 *   node scripts/check-release-traceability.mjs --include-prerelease  # 连预发布一起查
 *   node scripts/check-release-traceability.mjs --limit 10            # 窗口大小
 *   node scripts/check-release-traceability.mjs --repo owner/name     # 显式指定仓库
 *   node scripts/check-release-traceability.mjs --offline-skip        # 离线跳过（**CI 里禁用**）
 *   node scripts/check-release-traceability.mjs --strict              # 豁免清单按严格口径校验（CI 自动开）
 *   node scripts/check-release-traceability.mjs --now 2027-02-01      # 注入「今天」（验到期必红，不改系统时间）
 *   node scripts/check-release-traceability.mjs --allowlist <path>    # 换一份豁免清单（用例 / 审计用）
 *   pnpm run check:release-traceability
 *
 * 退出码：0 全部在 main 历史里（或命中了没过期的豁免）/ 1 有 tag 不在 origin/main 历史里、targetCommitish 不一致、
 *         **豁免已过期**、或（`--strict`）豁免条目缺 `reason` / `reviewAfter` /
 *         2 环境不成立（gh 缺 / origin/main 缺 / 浅克隆 / tag 没拉到 / 参数错）—— fail-closed，绝不当成绿。
 *
 * ## 逃生舱？没有（只留一个「离线跳过」，且 CI 里是禁用状态）
 *
 * 有人会想要 `--allow-missing-main`、`--allow-off-main`、`--warn` 这类开关。**一个都不加**：
 * v1.4.5 这道事故的成因正是「没人拦」，任何「今天先放过」的开关都会在第二次事故时被当成默认值。
 * 唯一的例外是**离线**跑（拿不到 gh / 没有网络）：`--offline-skip` 打印「已跳过（离线）」并 exit 0，
 * 但它**在 CI 里被硬禁**（`assertOfflineSkipAllowed`：见到 GITHUB_ACTIONS / CI 就 exit 2）——
 * 「离线跳过」是给人本机用的，不是给流水线用的。
 *
 * ## 豁免：**有到期日的显式例外**，不是放宽（#651 / #738）
 *
 * 不是每个红都能靠「重指 tag」修掉。`v1.4.1` → `c504ee51` 的版本提交**从未并入 main**
 * （main 从 1.4.0 直接到 1.4.3），把 tag 挪到 main 上的某个提交等于**伪造祖先关系** ——
 * 那比「红着」更糟：它会让溯源链看起来是通的，实际是拼出来的。这类历史遗留只能**豁免**。
 *
 * 所以豁免这件事落在**入库的清单**里，而不是命令行开关上：
 * `scripts/release-traceability-allowlist.json`（政策见 docs/RELEASE-MANUAL.md §6.2）。判据：
 *
 *   · 命中条目 → 打印 `[ALLOW] tag=<t> reason="…" reviewAfter=<date>`，**不静默**、不计入失败；
 *   · 今天 > `reviewAfter` → exit 1：「豁免已过期，请重指或删除该 tag」，并打印该条 reason ——
 *     到期日是这套机制的全部意义所在（永久豁免 = 永久后门）；
 *   · `--strict`（**CI 里自动等价开启**，见 `resolveStrict`）→ 每条必须同时有 `reason` 与
 *     `reviewAfter`，缺一个 / 日期非法 → exit 1；
 *   · 清单文件不存在 → 视为空表，正常跑（不报错）：没有历史遗留时它为 0 字节存在与否都不该改变判据；
 *   · 清单里的条目**用不上**了（tag 已删除 / 没有 release 记录 / 或它其实已经是 main 祖先）→ `[WARN]`
 *     点名，明确要求清理 —— 豁免清单不许变成垃圾桶。
 *
 * 与「放宽」的区别就一句话：**豁免有到期日、有理由、有人负责复审，并且每次运行都会把名字打在屏幕上。**
 *
 * ## CI 前提（实测过的，不是猜的）
 *
 * `actions/checkout@v4` 默认 `fetch-depth: 1`：**浅克隆**，且只拉一个提交、**不拉 tag**。
 * 在这种仓库上：
 *   · `origin/main` 历史不在本地 → `merge-base --is-ancestor` 会把「历史没拉到」误判成「不在 main 上」（假红）；
 *   · `refs/tags/*` 不在本地 → 连 tag 都解析不出来。
 * 所以 ci.yml 那一步在跑门禁**之前**必须先补历史与 tag（见 `.github/workflows/ci.yml` 的
 * 「release 溯源（check:release-traceability）」）；本脚本对这两种缺失都给出**点明修法**的错误（exit 2），
 * 而不是含糊地红在断言上。`isShallowRepository` 那条检查就是为此存在的：
 * 「判不了」必须说成「判不了」，不能伪装成「判过了」。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 断言的目标引用：**写死 origin/main**，不给「换个 ref 就绿」的口子 */
const MAIN_REF = 'origin/main'

/** 默认窗口：最近 5 个正式版（预发布要 --include-prerelease 才查） */
const DEFAULT_LIMIT = 5

/** 离线跳过开关（CI 禁用） */
const OFFLINE_SKIP_FLAG = '--offline-skip'

/** gh 可执行文件。`GH_BIN` 只用来指路径（受限环境 / L0 里证明「gh 不可用」这条错），
 *  **不能放宽任何断言**：指错了只会让门禁 fail-closed（exit 2）。 */
const GH_BIN = process.env.GH_BIN || 'gh'

/**
 * 豁免清单默认位置（**入库文件**）：`scripts/release-traceability-allowlist.json`。
 * `--allowlist` 只换「读哪一份」，不换判据 —— 用例与审计要能指向临时文件，真跑时永远是这个路径。
 */
const DEFAULT_ALLOWLIST = path.resolve(ROOT, 'scripts/release-traceability-allowlist.json')

/** 日期的唯一合法形态（豁免的 `addedAt` / `reviewAfter`、`--now` 都是它） */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const EXIT_OK = 0
/** 断言不成立：tag 不在 origin/main 历史里 / targetCommitish 与实际提交不一致 */
const EXIT_FAIL = 1
/** 环境不成立：gh 缺、origin/main 缺、浅克隆、tag 没拉到、参数错 —— fail-closed */
const EXIT_ENV = 2

/** 提交哈希形态（`targetCommitish` 是 sha 还是分支名，靠这个分） */
const SHA_LIKE = /^[0-9a-f]{7,40}$/i

/** 环境/前提不成立（区别于「断言不成立」：这两种红的修法完全不同） */
class EnvError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EnvError'
  }
}

/** 参数错误（同样走 exit 2，但顺带打用法） */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

// ---------------------------------------------------------------- 进程与 git

/** 跑一个外部命令，**不抛**（退出码与 stderr 都要用） */
const runBinary = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    env: options.env ?? process.env,
  })
  return {
    error: result.error ?? null,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

const git = (args, options = {}) => runBinary('git', args, options)

/** git 必须成功（失败 = 环境问题，不是断言问题） */
const gitOk = (args, options = {}) => {
  const result = git(args, options)
  if (result.error) throw new EnvError(`跑不动 git（${result.error.message}）—— 这道门禁要读本地提交图`)
  if (result.status !== 0) {
    throw new EnvError(`\`git ${args.join(' ')}\` 退出码 ${result.status}：${result.stderr || '(无 stderr)'}`)
  }
  return result.stdout
}

const isCi = () => process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true'

/**
 * 严格口径在 **CI 里自动开启**（等价 `--strict`）。
 *
 * 为什么不只在 ci.yml 里写 `--strict`：ci.yml 那一行被 #738 的用例钉成**裸跑**
 * （`run: pnpm run check:release-traceability`，且不许带 continue-on-error），
 * 把口径交给「某一行怎么写」正是 #369 的病根。判据落在脚本里：见到 CI 环境变量就按严格口径校验，
 * 并**打印为什么**（`[check:release-traceability] 严格口径：开（CI 环境自动开）`），不静默。
 * 本机要同样的口径：显式 `--strict`。
 */
const resolveStrict = (options) => {
  if (options.strict) return { strict: true, reason: '--strict' }
  if (isCi()) return { strict: true, reason: 'CI 环境自动开（GITHUB_ACTIONS / CI）' }
  return { strict: false, reason: '本机未开（加 --strict 用 CI 同一口径）' }
}

/** 校验 `YYYY-MM-DD`（形态 + 真实存在：挡掉 2027-02-30 这种「看起来像日期」的值） */
const isIsoDate = (value) => {
  if (typeof value !== 'string') return false
  const matched = ISO_DATE.exec(value)
  if (!matched) return false
  const [year, month, day] = matched.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** 「今天」= 本地日期（可以用 `--now` 注入；到期判据是 `今天 > reviewAfter`，到期当天仍算有效） */
const resolveToday = (injected) => {
  if (injected) {
    if (!isIsoDate(injected)) throw new UsageError(`--now 需要 YYYY-MM-DD 形式的日期，收到：${injected}`)
    return injected
  }
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// ---------------------------------------------------------------- 参数

const parseArgs = (argv) => {
  const options = {
    tags: [],
    limit: DEFAULT_LIMIT,
    includePrerelease: false,
    offlineSkip: false,
    repo: null,
    strict: false,
    now: null,
    allowlist: DEFAULT_ALLOWLIST,
    help: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const valueOf = (name) => {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} 需要一个值`)
      return value
    }
    if (arg === '--tag') options.tags.push(valueOf('--tag'))
    else if (arg === '--repo') options.repo = valueOf('--repo')
    else if (arg === '--limit') {
      const limit = Number(valueOf('--limit'))
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit 必须是 ≥1 的整数')
      options.limit = limit
    } else if (arg === '--now') {
      const now = valueOf('--now')
      if (!isIsoDate(now)) throw new UsageError(`--now 需要 YYYY-MM-DD 形式的日期，收到：${now}`)
      options.now = now
    } else if (arg === '--allowlist') {
      options.allowlist = path.resolve(valueOf('--allowlist'))
    } else if (arg === '--strict') options.strict = true
    else if (arg === '--include-prerelease') options.includePrerelease = true
    else if (arg === OFFLINE_SKIP_FLAG) options.offlineSkip = true
    else if (arg === '--help' || arg === '-h') options.help = true
    // 未知参数一律拒绝：有人想加 `--allow-missing-main` 时，必须在这里就被拦住，而不是静默忽略后
    // 以为「放宽成功了」。见文件头「逃生舱？没有」。
    else throw new UsageError(`未知参数：${arg}（本门禁没有「放宽」开关；离线跑用 ${OFFLINE_SKIP_FLAG}）`)
  }
  return options
}

const usage = () => `用法：
  node scripts/check-release-traceability.mjs [--tag <t>]... [--limit <n>] [--include-prerelease]
                                             [--repo <owner/name>] [--offline-skip]
                                             [--strict] [--now <YYYY-MM-DD>] [--allowlist <path>]

  --tag <t>              只查这个 tag（可重复；此时不需要 release 记录，gh 只在能确定仓库时用来交叉核对 targetCommitish）
  --limit <n>            默认查最近 n 个正式版 release（默认 ${DEFAULT_LIMIT}）
  --include-prerelease   连预发布一起查（草稿永不查：草稿不算「已发布」）
  --repo <owner/name>    显式指定仓库（默认取 GITHUB_REPOSITORY，再退回 origin remote）
  --strict               豁免清单按严格口径校验：每条必须同时有 reason 与 reviewAfter（**CI 里自动等价开启**）
  --now <YYYY-MM-DD>     注入「今天」，用来验「豁免已过期」那一拍（不改系统时间）
  --allowlist <path>     换一份豁免清单（默认 scripts/release-traceability-allowlist.json；用例 / 审计用）
  ${OFFLINE_SKIP_FLAG}       离线跳过（打印「已跳过（离线）」并 exit 0；**CI 里禁用**，见到即 exit 2）`

/**
 * `--offline-skip` 在 CI 里被硬禁。
 *
 * 为什么不是「CI 里不传这个参数就行」：那样这道门禁的强弱取决于 ci.yml 那一行怎么写，
 * 而 ci.yml 是**会被改的**（#369 的病根就是「命令行被改软」）。所以判据落在脚本里：
 * 只要带着 CI 的环境变量跑 `--offline-skip`，立刻 exit 2 并说明原因。
 */
const assertOfflineSkipAllowed = () => {
  if (!isCi()) return
  throw new EnvError(
    `CI 里禁用 ${OFFLINE_SKIP_FLAG}（检测到 GITHUB_ACTIONS / CI）：这道门禁的价值就在于「发布物是否出自 main」` +
      '这件事必须每次都被真的判一遍。离线跑是给人本机用的。\n' +
      '  · CI 上缺 gh / 缺历史 → 修 CI（补 git fetch、给 GITHUB_TOKEN），不要跳过。'
  )
}

// ---------------------------------------------------------------- 仓库定位（不用 gh 的隐式解析）

const GITHUB_URL = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i

/**
 * 确定要查哪个 GitHub 仓库，**绝不回退到 gh 的猜测**（理由见文件头：本仓库有 upstream，
 * gh 在 fork 里优先取 upstream，裸跑会列出 deepseek-ai/chat-demo 的 v0.1.x release）。
 */
const deriveRepo = (explicit) => {
  if (explicit) return { repo: explicit, source: '--repo' }
  const fromEnv = (process.env.GITHUB_REPOSITORY ?? '').trim()
  if (fromEnv.includes('/')) return { repo: fromEnv, source: 'GITHUB_REPOSITORY' }
  const origin = git(['remote', 'get-url', 'origin'])
  if (origin.status === 0 && origin.stdout) {
    const matched = GITHUB_URL.exec(origin.stdout)
    if (matched) return { repo: `${matched[1]}/${matched[2]}`, source: `git remote get-url origin → ${origin.stdout}` }
    return { repo: null, source: `origin 不是 GitHub 地址（${origin.stdout}）` }
  }
  return { repo: null, source: '仓库里没有 origin remote' }
}

// ---------------------------------------------------------------- gh

/** gh 在不在、能不能起（不能起 = 环境问题；--tag 模式下可以降级成「跳过交叉核对」） */
const ghProbe = () => {
  const result = runBinary(GH_BIN, ['--version'])
  if (result.error) return { ok: false, reason: `找不到可执行的 gh（GH_BIN=${GH_BIN}）：${result.error.message}` }
  if (result.status !== 0) return { ok: false, reason: `\`gh --version\` 退出码 ${result.status}：${result.stderr}` }
  return { ok: true, version: result.stdout.split('\n')[0] }
}

/**
 * 列 releases。草稿不算「已发布」，所以先多拿一些再过滤 —— 否则窗口里塞满草稿时
 * 会静默少查几个正式版（「少查了」比「查错了」更难发现）。
 */
const listReleases = ({ repo, limit, includePrerelease }) => {
  const fetchLimit = Math.max(limit * 5, limit)
  const args = [
    'release', 'list',
    '--repo', repo,
    '--limit', String(fetchLimit),
    '--json', 'tagName,isDraft,isPrerelease,publishedAt',
  ]
  const result = runBinary(GH_BIN, args)
  if (result.error) throw new EnvError(`调不动 gh（${result.error.message}）`)
  if (result.status !== 0) {
    throw new EnvError(`\`gh release list --repo ${repo}\` 退出码 ${result.status}：${result.stderr || '(无 stderr)'}`)
  }
  let raw
  try {
    raw = JSON.parse(result.stdout || '[]')
  } catch (error) {
    throw new EnvError(`gh release list 的输出不是 JSON（${error.message}）：${result.stdout.slice(0, 400)}`)
  }
  const drafts = raw.filter((release) => release.isDraft)
  const prereleases = raw.filter((release) => !release.isDraft && release.isPrerelease)
  const stable = raw.filter((release) => !release.isDraft && (includePrerelease || !release.isPrerelease))
  return {
    releases: stable.slice(0, limit),
    counts: { fetched: raw.length, drafts: drafts.length, prereleases: prereleases.length, selected: Math.min(stable.length, limit) },
  }
}

/**
 * 读某个 tag 的 release 元数据（只为 `targetCommitish` 交叉核对）。
 * 三种结果分开：`release` / `none`（这个 tag 没有 release 记录 —— 正常，不算错）/ `unavailable`（gh 不在）。
 * 其余错误（仓库解析不了、鉴权失败、网络）**一律往上抛**，不当成「没有 release」蒙过去。
 */
const releaseMeta = ({ repo, tag }) => {
  const result = runBinary(GH_BIN, ['release', 'view', tag, '--repo', repo, '--json', 'tagName,targetCommitish,isDraft,isPrerelease'])
  if (result.error) return { kind: 'unavailable', reason: `调不动 gh（${result.error.message}）` }
  if (result.status !== 0) {
    // gh 的 404 文案是 `release not found`；仓库/鉴权问题另有文案，不能混在一起
    if (/release not found/i.test(result.stderr)) return { kind: 'none', reason: `release not found（${repo} 上没有 tag ${tag} 的 release 记录）` }
    throw new EnvError(`\`gh release view ${tag} --repo ${repo}\` 退出码 ${result.status}：${result.stderr || '(无 stderr)'}`)
  }
  try {
    const meta = JSON.parse(result.stdout || '{}')
    return { kind: 'release', targetCommitish: meta.targetCommitish ?? '', isPrerelease: Boolean(meta.isPrerelease), isDraft: Boolean(meta.isDraft) }
  } catch (error) {
    throw new EnvError(`gh release view 的输出不是 JSON（${error.message}）：${result.stdout.slice(0, 400)}`)
  }
}

// ---------------------------------------------------------------- git 侧判据

/**
 * `origin/main` 必须存在，且**不能是浅克隆**。
 *
 * 浅克隆这条不是洁癖：`fetch-depth: 1` 下 `merge-base --is-ancestor` 只有两头各 1 个提交，
 * 中间历史缺失，git 会把「走不到」当成「不是祖先」→ 一道正确的发布被门禁判红（假红），
 * 而假红比不测更糟（下一个人会去把门禁关掉）。所以这里 fail-closed 并点明修法。
 */
const assertMainRef = () => {
  const exists = git(['rev-parse', '--verify', '--quiet', MAIN_REF])
  if (exists.status !== 0) {
    throw new EnvError(
      `本地没有 \`${MAIN_REF}\`，无法判定祖先关系。\n` +
        '  · 本机：`git fetch --no-tags origin main`\n' +
        '  · CI：`actions/checkout` 默认只拉 1 个提交，必须在跑这道门禁前补历史与 tag（见 ci.yml 的\n' +
        '    「release 溯源（check:release-traceability）」那一步）—— 这一步缺了就红，不是门禁判错。'
    )
  }
  const shallow = git(['rev-parse', '--is-shallow-repository'])
  if (shallow.status === 0 && shallow.stdout === 'true') {
    throw new EnvError(
      '这是一个**浅克隆**（`git rev-parse --is-shallow-repository` → true）：tag 与 main 之间的历史不在本地，\n' +
        '`merge-base --is-ancestor` 会把「历史没拉到」误判成「不在 main 上」（假红，比不测更糟）。\n' +
        '  · 本机：`git fetch --unshallow origin`\n' +
        '  · CI：`actions/checkout` 用 `fetch-depth: 0`，或在门禁前 `git fetch --no-tags --unshallow origin`'
    )
  }
  return gitOk(['rev-parse', MAIN_REF])
}

/** 解析 tag → 提交（annotated 先 deref），并报出 tag 的类型（输出里要用） */
const resolveTagCommit = (tag) => {
  const ref = `refs/tags/${tag}`
  const type = git(['cat-file', '-t', ref])
  if (type.status !== 0) {
    throw new EnvError(
      `本地没有 tag \`${tag}\`（${ref}）：\`git fetch --force --tags origin\` 之后再跑。\n` +
        '（浅克隆 / checkout 不带 tag 时就是这个形态 —— 不是「这个 tag 不存在」）'
    )
  }
  const objectType = type.stdout // 'commit'（lightweight）| 'tag'（annotated）
  const commit = gitOk(['rev-parse', '--verify', `${ref}^{commit}`])
  const objectSha = objectType === 'tag' ? git(['rev-parse', '--verify', ref]).stdout : commit
  return { commit, objectType, objectSha }
}

const describeCommit = (commit) => {
  const subject = git(['log', '-1', '--format=%s', commit])
  if (subject.status !== 0) throw new EnvError(`读不到提交 ${commit} 的信息：${subject.stderr || '(无 stderr)'}`)
  return { short: commit.slice(0, 8), full: commit, subject: subject.stdout }
}

/**
 * 祖先判定 —— 本门禁唯一的判据。
 * 红的时候多给一条诊断（有没有共同祖先），因为两种红的修法完全不同：
 *   · 有共同祖先（squash 合并前的 PR 头提交）：把 tag 重指到 main 那条 squash 提交；
 *   · 没有共同祖先（历史被重写 / 另一棵独立的树）：重指之前先确认这条发布线还要不要追。
 */
const ancestry = (commit) => {
  const result = git(['merge-base', '--is-ancestor', commit, MAIN_REF])
  if (result.error) throw new EnvError(`跑不动 git（${result.error.message}）`)
  if (result.status === 0) return { ancestor: true, commonAncestor: commit }
  if (result.status === 1) {
    const mergeBase = git(['merge-base', MAIN_REF, commit])
    return { ancestor: false, commonAncestor: mergeBase.status === 0 ? mergeBase.stdout : null }
  }
  throw new EnvError(`\`git merge-base --is-ancestor ${commit} ${MAIN_REF}\` 退出码 ${result.status}：${result.stderr}`)
}

/**
 * `targetCommitish` 与 tag 实际指向的提交是否一致。
 *
 * `gh release view` 的 `targetCommitish` **通常只是分支名**（发布时点的默认分支），分支名在发布后会移动，
 * 拿它当 commit 判据只会制造假红 —— 所以「分支名」这一档**跳过，但把跳过原因打印出来**（不静默）。
 * 只有当它确实是 sha 形态时才比对。
 */
const classifyTargetCommitish = (targetCommitish, commit) => {
  const value = String(targetCommitish ?? '').trim()
  if (!value) return { verdict: 'absent', detail: 'release 上没有 targetCommitish —— 这条判据无从比对（跳过）' }
  if (!SHA_LIKE.test(value)) {
    return {
      verdict: 'branch',
      detail: `targetCommitish=\`${value}\` 是分支名（不是 commit 哈希）—— 分支名发布后会移动，不能当 commit 判据，跳过这一条`,
    }
  }
  const wanted = value.toLowerCase()
  const actual = commit.toLowerCase()
  if (actual.startsWith(wanted) || wanted.startsWith(actual)) {
    return { verdict: 'match', detail: `targetCommitish=\`${value}\` 与 tag 指向的提交一致` }
  }
  return { verdict: 'mismatch', detail: `targetCommitish=\`${value}\` 与 tag 实际指向的 \`${commit}\` **不一致**` }
}

/** origin/main 可能是过期的远端跟踪 ref（本地很久没 fetch）—— 这种情况下的红要打一句提醒，别让人去改 tag */
const staleMainWarning = (commit) => {
  const mainTime = git(['log', '-1', '--format=%ct', MAIN_REF])
  const commitTime = git(['log', '-1', '--format=%ct', commit])
  if (mainTime.status !== 0 || commitTime.status !== 0) return null
  const mainAt = Number(mainTime.stdout)
  const commitAt = Number(commitTime.stdout)
  if (!Number.isFinite(mainAt) || !Number.isFinite(commitAt) || commitAt <= mainAt) return null
  return (
    `提交时间 ${new Date(commitAt * 1000).toISOString()} 晚于 ${MAIN_REF} 的 ` +
    `${new Date(mainAt * 1000).toISOString()} —— 本地 ${MAIN_REF} 可能过期，先 \`git fetch --no-tags origin main\` 再判`
  )
}

// ---------------------------------------------------------------- 豁免清单（有到期日的显式例外）

/**
 * 读豁免清单。三种形态分开：
 *   · 文件不存在 → `{ present: false, entries: [] }`，**不是错误**：没有历史遗留时它有没有都不改变判据；
 *   · JSON 坏 / 顶层不是对象 → **EnvError（exit 2）**：解析不了就等于「没人知道有哪些例外」，
 *     这种情况静默当空表 = 偷偷把豁免全丢掉，红在别处比红在这里难查得多；
 *   · 正常 → 逐条解析出 `reason` / `addedAt` / `reviewAfter` / `problems`（字段缺失与日期非法都进 problems，
 *     由调用方按 strict 决定是红还是 WARN）。
 *
 * 顶层 `_` 开头的键是元信息（`_meta`），不算条目 —— 否则每加一条元信息都要被当成一个「tag」。
 */
const loadAllowlist = ({ file }) => {
  const label = path.relative(ROOT, file) || file
  const result = { file, label, present: false, entries: [], problems: [] }
  if (!existsSync(file)) return result
  result.present = true
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new EnvError(`豁免清单读不动（${label}）：${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EnvError(
      `豁免清单不是合法 JSON（${label}）：${error.message}\n` +
        '  · 解析不了就没法知道「哪些 tag 被豁免了」—— 当空表处理等于偷偷丢掉全部例外，所以这里 fail-closed。'
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvError(`豁免清单顶层必须是对象（{ "_meta": …, "<tag>": { reason, reviewAfter } }），实际是：${label}`)
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue
    const entry = {
      tag: key,
      label: result.label,
      reason: typeof value?.reason === 'string' ? value.reason.trim() : '',
      addedAt: typeof value?.addedAt === 'string' ? value.addedAt.trim() : '',
      reviewAfter: typeof value?.reviewAfter === 'string' ? value.reviewAfter.trim() : '',
      problems: [],
    }
    if (!entry.reason) entry.problems.push('缺 `reason`（必须写明「为什么这个 tag 不能重指」，否则下一个人无从判断该不该续期）')
    if (!entry.reviewAfter) {
      entry.problems.push('缺 `reviewAfter`（豁免必须有到期日 —— 没有到期日的豁免就是永久后门）')
    } else if (!isIsoDate(entry.reviewAfter)) {
      entry.problems.push(`\`reviewAfter\`=\`${entry.reviewAfter}\` 不是合法的 YYYY-MM-DD 日期（到期判据无从计算）`)
    }
    if (entry.addedAt && !isIsoDate(entry.addedAt)) {
      entry.problems.push(`\`addedAt\`=\`${entry.addedAt}\` 不是合法的 YYYY-MM-DD 日期（只影响可审计性，不影响判据）`)
    }
    result.entries.push(entry)
  }
  return result
}

/**
 * 条目是否已过期。`今天 > reviewAfter` → 过期（到期当天仍有效：`reviewAfter` 是「最晚复审到哪一天」）。
 * `reviewAfter` 缺失 / 非法 → **判不了**，返回 `null`（不假装「没过期」，由 strict 那一拍去红）。
 */
const expiryOf = (entry, today) => {
  if (!isIsoDate(entry.reviewAfter)) return null
  return { expired: today > entry.reviewAfter, today, reviewAfter: entry.reviewAfter }
}

// ---------------------------------------------------------------- 单个 tag 的判定

const checkOneTag = ({ tag, meta, mainSha, allowEntry = null, today }) => {
  const lines = []
  const warnings = []
  const { commit, objectType, objectSha } = resolveTagCommit(tag)
  const info = describeCommit(commit)
  const tagged = objectType === 'tag'
    ? `annotated tag（对象 ${objectSha.slice(0, 8)} → deref 到提交 ${info.short}）`
    : `lightweight tag（直接指向提交 ${info.short}）`
  lines.push(`  · tag 形态：${tagged}`)
  lines.push(`  · 完整 sha：${info.full}`)

  const { ancestor, commonAncestor } = ancestry(commit)
  const targetCheck = meta?.kind === 'release' ? classifyTargetCommitish(meta.targetCommitish, commit) : null
  if (targetCheck) lines.push(`  · targetCommitish：${targetCheck.detail}`)
  else if (meta?.kind === 'none') lines.push(`  · targetCommitish：跳过 —— ${meta.reason}`)
  else if (meta?.kind === 'unavailable') lines.push(`  · targetCommitish：跳过 —— ${meta.reason}`)

  const allow = allowEntry
  const expiry = allow ? expiryOf(allow, today) : null

  const failures = []
  if (!ancestor) {
    if (allow) {
      // 命中豁免：这条红线**不计入失败**，但也不静默 —— `[ALLOW]` 那一行 + 这里的说明必须一起出现，
      // 否则「红着但退出码是 0」会被后来的人当成 bug 去修掉。
      lines.push(
        `  · 豁免：不在 ${MAIN_REF} 历史里，但清单登记为「无法重指」的历史遗留` +
          `（${allow.label ?? ''}：重指等于伪造祖先关系，见下方 [ALLOW] 与 docs/RELEASE-MANUAL.md §6.2）`
      )
    } else {
      failures.push(
        `tag \`${tag}\` 指向 \`${info.short}\`（\`${info.subject}\`），**不在 ${MAIN_REF} 历史里**；` +
          '请把 tag 重指到 main 上的提交后重建'
      )
    }
    lines.push(
      commonAncestor
        ? `  · 诊断：与 ${MAIN_REF} 有共同祖先 \`${commonAncestor.slice(0, 8)}\` —— 该提交在别的分支上（典型：squash 合并前的 PR 头提交）`
        : `  · 诊断：与 ${MAIN_REF} **没有共同祖先** —— 这条提交线根本不在 main 的祖先图里（历史被重写过，或 tag 打在另一棵独立的树上）`
    )
  }
  if (targetCheck?.verdict === 'mismatch') {
    failures.push(`tag \`${tag}\` 的 release targetCommitish 与实际指向不一致：${targetCheck.detail}`)
  }
  if (!ancestor) {
    const warning = staleMainWarning(commit)
    if (warning) lines.push(`  · 提醒：${warning}`)
  }

  if (allow) {
    if (expiry === null) {
      // 到期判据算不出来：不假装「没过期」。strict 口径下这一条在清单层就是红（见 run 里的 problems 拍）。
      lines.push('  · 豁免有效期：`reviewAfter` 缺失或非法 —— 无从判断这份豁免还能用多久（`--strict` 下这是红）')
    } else if (expiry.expired) {
      failures.push(
        `豁免已过期（reviewAfter=${allow.reviewAfter} < 今天 ${today}）：**请重指或删除该 tag** —— ` +
          `豁免是有到期日的显式例外，不是永久放行。清单条目 reason：“${allow.reason || '(缺 reason)'}”`
      )
    } else {
      lines.push(`  · 豁免有效期：reviewAfter=${allow.reviewAfter}（今天 ${today}，未过期；到期后必须复审，否则本门禁红）`)
      if (ancestor) {
        warnings.push(
          `tag \`${tag}\` 其实**已经是 ${MAIN_REF} 的祖先** —— 这条豁免用不上了，请从豁免清单里删除（豁免清单不许变成垃圾桶）`
        )
      }
    }
  }

  lines.push(`  · 复核命令：git merge-base --is-ancestor ${info.full} ${MAIN_REF} ; echo $?`)

  const ok = failures.length === 0
  return {
    tag,
    ok,
    kind: !ok ? 'fail' : allow ? 'allow' : 'ok',
    info,
    failures,
    warnings,
    lines,
    ancestor,
    mainSha,
    allow,
    expiry,
  }
}

// ---------------------------------------------------------------- 主流程

const run = (options) => {
  const { repo, source } = deriveRepo(options.repo)

  // 先把**前提**验干净（本地 git 与 gh 各自 fail-closed），再打横幅、再判每个 tag：
  // 前提不成立时的红必须长成「环境问题」，不能长成「tag 不在 main 上」（两种红的修法完全不同）。
  const mainSha = assertMainRef()

  /** --tag 模式下 targetCommitish 交叉核对降级的原因（打完横幅再逐条说，别混在前提里） */
  const notes = []
  let selection = null
  let tagMetaAvailable = false
  if (options.tags.length > 0) {
    // --tag：只查这些 tag。祖先判定只用 git；gh 只在「仓库能确定」时用来交叉核对 targetCommitish。
    if (!repo) {
      notes.push(`[SKIP] 无法确定 gh 仓库（${source}）—— 跳过 targetCommitish 交叉核对（祖先判定只用 git，不受影响）`)
    } else {
      const gh = ghProbe()
      if (gh.ok) tagMetaAvailable = true
      else notes.push(`[SKIP] ${gh.reason} —— 跳过 targetCommitish 交叉核对（祖先判定只用 git，不受影响）`)
    }
  } else {
    if (!repo) {
      throw new EnvError(
        `无法确定要查哪个 GitHub 仓库（${source}）：用 \`--repo <owner/name>\` 指定，或确保仓库有 origin remote。\n` +
          '（不回退到 gh 的隐式解析：fork 里 gh 会优先取 upstream，列出的是另一个仓库的 release）'
      )
    }
    const gh = ghProbe()
    if (!gh.ok) {
      throw new EnvError(
        `${gh.reason}\n` +
          '这道门禁要靠 gh 读 releases（哪些 tag 算「已发布」）。修法：装 gh 并 `gh auth login`（CI 上给 GITHUB_TOKEN）。\n' +
          `只想本机离线跑一次：${OFFLINE_SKIP_FLAG}（CI 里禁用）。`
      )
    }
    selection = listReleases({ repo, limit: options.limit, includePrerelease: options.includePrerelease })
    if (selection.releases.length === 0) {
      throw new EnvError(
        `\`${repo}\` 上没有可查的 release（gh 返回 ${selection.counts.fetched} 条，其中草稿 ${selection.counts.drafts} 条）—— ` +
          '一条都不查等于什么都没验，fail-closed。'
      )
    }
    tagMetaAvailable = true
  }

  // 豁免清单与「今天」都在打横幅时就定下来：判据要看日期，日期来源必须写在输出里（`--now` 注入过就点名）。
  const { strict, reason: strictReason } = resolveStrict(options)
  const allowlist = loadAllowlist({ file: options.allowlist })
  const today = resolveToday(options.now)
  const allowByTag = new Map(allowlist.entries.map((entry) => [entry.tag, entry]))

  console.log(`[check:release-traceability] 断言：已发布的 tag 必须在 \`${MAIN_REF}\` 历史里（${MAIN_REF} = ${mainSha.slice(0, 8)}）`)
  for (const note of notes) console.log(note)
  console.log(
    allowlist.present
      ? `[check:release-traceability] 豁免清单：${allowlist.label}（${allowlist.entries.length} 条：` +
          `${allowlist.entries.map((entry) => entry.tag).join(', ') || '(空)'}）`
      : `[check:release-traceability] 豁免清单：${allowlist.label} 不存在 → 视为空表（正常跑）`
  )
  console.log(
    `[check:release-traceability] 严格口径：${strict ? '开' : '关'}（${strictReason}）｜今天=${today}` +
      `${options.now ? '（--now 注入）' : ''}`
  )

  const targets = []
  if (options.tags.length > 0) {
    console.log(`[check:release-traceability] 目标：${options.tags.join(', ')}（--tag 指定）`)
    for (const tag of options.tags) targets.push({ tag, meta: tagMetaAvailable ? releaseMeta({ repo, tag }) : null })
  } else {
    console.log(
      `[check:release-traceability] 仓库：${repo}（来自 ${source}）｜窗口：最近 ${options.limit} 个` +
        `${options.includePrerelease ? '（含预发布）' : '正式版'}，实际取到 ${selection.counts.selected} 个` +
        `（gh 返回 ${selection.counts.fetched} 条，剔除草稿 ${selection.counts.drafts} 条` +
        `${options.includePrerelease ? '' : `、预发布 ${selection.counts.prereleases} 条`}）`
    )
    for (const release of selection.releases) {
      targets.push({ tag: release.tagName, meta: releaseMeta({ repo, tag: release.tagName }) })
    }
  }

  const results = []
  for (const target of targets) results.push(checkOneTag({ ...target, mainSha, allowEntry: allowByTag.get(target.tag) ?? null, today }))

  for (const result of results) {
    if (result.kind === 'allow') {
      // 命中豁免：**不静默** —— 一行一个 tag，reason 与到期日都在同一行里，`git log` 里就能对账。
      console.log(
        `[ALLOW] tag=${result.tag} reason="${result.allow.reason || '(缺 reason)'}" ` +
          `reviewAfter=${result.allow.reviewAfter || '(缺 reviewAfter)'}`
      )
      for (const line of result.lines) console.log(line)
      for (const warning of result.warnings) console.log(`[WARN] ${warning}`)
      continue
    }
    if (result.ok) {
      console.log(`[OK]   tag \`${result.tag}\` → ${result.info.short}（\`${result.info.subject}\`）在 ${MAIN_REF} 历史里`)
      for (const line of result.lines) console.log(line)
      for (const warning of result.warnings) console.log(`[WARN] ${warning}`)
      continue
    }
    // 结果统一走 stdout：stdout/stderr 分开写会让「红」与它上面那些「绿」在终端里交错，
    // 证据就没法按顺序读了（本门禁的报告本身就是证据）。
    for (const failure of result.failures) console.log(`[FAIL] ${failure}`)
    for (const line of result.lines) console.log(line)
    for (const warning of result.warnings) console.log(`[WARN] ${warning}`)
  }

  // 清单层的问题（缺字段 / 日期非法 / 条目已无用）：strict 下判红，非 strict 下至少 WARN 点名，绝不静默。
  const listFailures = []
  const listWarnings = []
  for (const entry of allowlist.entries) {
    if (entry.problems.length === 0) continue
    const message = `豁免清单 \`${entry.tag}\`：${entry.problems.join('；')}`
    if (strict) listFailures.push(message)
    else listWarnings.push(`${message}（\`--strict\` / CI 里这就是红）`)
  }
  const targetTags = new Set(targets.map((target) => target.tag))
  const staleWarnings = []
  for (const entry of allowlist.entries) {
    if (targetTags.has(entry.tag)) continue
    const ref = git(['rev-parse', '--verify', '--quiet', `refs/tags/${entry.tag}`])
    if (ref.status !== 0) {
      // 用例里能离线复现的那一拍：清单里点名的 tag 在仓库里已经不存在 → 过期条目该清理
      staleWarnings.push(
        `豁免清单里的 \`${entry.tag}\` **已不存在于仓库**（refs/tags/${entry.tag} 找不到）—— ` +
          `过期条目该清理（reason：“${entry.reason || '(缺 reason)'}”）`
      )
      continue
    }
    if (repo && tagMetaAvailable) {
      const meta = releaseMeta({ repo, tag: entry.tag })
      if (meta.kind === 'none') {
        staleWarnings.push(
          `豁免清单里的 \`${entry.tag}\` 在本仓库**没有 release 记录**（tag 还在，但「已发布」这件事没了）—— ` +
            `过期条目该清理（reason：“${entry.reason || '(缺 reason)'}”）`
        )
      }
    }
  }
  for (const warning of staleWarnings) console.log(`[WARN] ${warning}`)
  for (const warning of listWarnings) console.log(`[WARN] ${warning}`)

  const failed = results.filter((result) => !result.ok)
  const allowed = results.filter((result) => result.kind === 'allow')
  const summary = `${results.length - failed.length} 绿 / ${failed.length} 红`
  const allowNote = allowed.length > 0
    ? `；其中 ${allowed.length} 个走豁免（由豁免清单里的到期日管着）：${allowed.map((result) => result.tag).join(', ')}`
    : ''
  if (failed.length > 0 || listFailures.length > 0) {
    for (const failure of listFailures) console.log(`[FAIL] ${failure}`)
    const failedTags = failed.map((result) => result.tag)
    const headline = [...failedTags, ...(listFailures.length > 0 ? ['豁免清单（缺字段 / 日期非法）'] : [])].join(', ')
    console.log(
      `\n[check:release-traceability] ✗ ${summary}：${headline}\n` +
        '这道门禁判的是**溯源关系**（tag 指向的提交必须是 origin/main 的祖先），不是「包里差几个改动」——\n' +
        '「从 tag 复现问题」必须 checkout 到主线上的树，否则发布物与 main 的对应关系只能靠人记。\n' +
        '修法：把 tag 重指到 main 上对应的提交，然后重建/重发（不改 tag 就只能重发）。\n' +
        '若红的是「豁免已过期」：① 能重指就重指；② 确实无法重指（版本提交从未进过 main）→ 由 owner 复审后' +
        '**重设 reviewAfter 并写清复审结论**（续期是复审，不是免检）；③ 删掉该 tag 与其豁免条目。'
    )
    return EXIT_FAIL
  }
  console.log(`\n[check:release-traceability] ✓ ${summary}（全部在 ${MAIN_REF} 历史里${allowNote}）`)
  return EXIT_OK
}

const main = (argv) => {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[ENV] ${error.message}`)
      console.error(usage())
      return EXIT_ENV
    }
    throw error
  }
  if (options.help) {
    console.log(usage())
    return EXIT_OK
  }
  try {
    if (options.offlineSkip) {
      assertOfflineSkipAllowed()
      console.log('已跳过（离线）')
      return EXIT_OK
    }
    return run(options)
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(`[ENV] ${error.message}`)
      return EXIT_ENV
    }
    throw error
  }
}

export {
  DEFAULT_ALLOWLIST,
  EXIT_ENV,
  EXIT_FAIL,
  EXIT_OK,
  MAIN_REF,
  ancestry,
  assertOfflineSkipAllowed,
  classifyTargetCommitish,
  deriveRepo,
  expiryOf,
  isIsoDate,
  loadAllowlist,
  main,
  parseArgs,
  resolveStrict,
  resolveTagCommit,
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
