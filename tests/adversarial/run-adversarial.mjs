// 红队 / 对抗用例的运行器（不进 tests/run-layer.mjs 的 LAYERS，因此默认基线不受影响）。
//
//   node tests/adversarial/run-adversarial.mjs            # 跑全部
//   node tests/adversarial/run-adversarial.mjs --only a3  # 只跑一条（也支持直接 node 单个文件）
//   node tests/adversarial/run-adversarial.mjs --json     # 机器可读
//   node tests/adversarial/run-adversarial.mjs --record   # 按当前实际结果重写 baseline 的 green/known-defect
//
// 语义：用例本身 exit 0 = 符合期望；exit 1 = 期望没被满足。
// 真产品缺陷不会被「修绿」——baseline 里标 known-defect 的用例允许红，但一旦变绿会报 REGRESSION
// （提示缺陷可能被修了，需要人工确认后更新 baseline）；标 green 的用例变红同样报 REGRESSION。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(here, 'baseline.json')
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))

const args = process.argv.slice(2)
const json = args.includes('--json')
const record = args.includes('--record')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex === -1 ? null : args[onlyIndex + 1]

const cases = Object.entries(baseline.cases)
  .filter(([id]) => only === null || id.startsWith(only))
  .map(([id, meta]) => ({ id, ...meta }))

const results = []
for (const item of cases) {
  const startedAt = Date.now()
  let code = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [join(here, 'cases', item.file)], {
      encoding: 'utf8',
      cwd: join(here, '..', '..'),
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    code = error.status ?? 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const ms = Date.now() - startedAt
  const green = code === 0
  const expected = item.verdict
  let status = 'PASS'
  if (green && expected === 'known-defect') {
    status = 'REGRESSION'
  } else if (!green && expected === 'green') {
    status = 'REGRESSION'
  } else if (!green && expected === 'known-defect') {
    status = 'KNOWN-DEFECT'
  }
  const summary = output
    .split('\n')
    .filter((line) => /^\[[a-z]\d\]|^FAIL/.test(line))
    .join('\n')
  results.push({ id: item.id, bucket: item.bucket, title: item.title, status, ms, code, summary })
}

if (record) {
  for (const result of results) {
    const meta = baseline.cases[result.id]
    meta.verdict = result.status === 'PASS' || result.status === 'KNOWN-DEFECT' ? (result.code === 0 ? 'green' : 'known-defect') : meta.verdict
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

if (json) {
  console.log(JSON.stringify({ results }, null, 2))
} else {
  for (const result of results) {
    console.log(`${result.status.padEnd(12)} ${result.id.padEnd(4)} ${result.title}（${result.ms}ms）`)
    if (result.status !== 'PASS') {
      for (const line of result.summary.split('\n').filter(Boolean)) {
        console.log(`             ${line}`)
      }
    }
  }
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1
    return acc
  }, {})
  const regressions = results.filter((result) => result.status === 'REGRESSION')
  console.log('')
  console.log(
    `合计 ${results.length}：PASS ${counts.PASS ?? 0}，KNOWN-DEFECT ${counts['KNOWN-DEFECT'] ?? 0}，REGRESSION ${counts.REGRESSION ?? 0}`
  )
  if (regressions.length > 0) {
    console.log(`REGRESSION 用例：${regressions.map((result) => result.id).join(', ')}（需要人工确认后更新 baseline.json）`)
  }
  process.exit(regressions.length === 0 ? 0 : 1)
}
