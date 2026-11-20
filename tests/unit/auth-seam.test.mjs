// [layer: unit | 依赖: 无（纯 Node + 源码/产物扫描） | Issue #487 W1-B 后半（#510）]
//
// **登录接缝的安全底线**：`AuthGate` 里那句 `__TEST_AUTH_STATE__` 构建期常量，只能出现在
// 测试构建的产物里。这条用例钉四件事：
//
//   1. **没有运行期开关**：`src/**` 不许出现 `globalThis.__TEST_AUTH_STATE__` /
//      `window.__TEST_AUTH_STATE__` 这类「运行期兜底」写法 —— 那种写法会把「读到某个值就放行」
//      的分支原样留在线上 bundle 里，等于给出一条可绕开的登录墙（#510 决策里明确禁止）。
//   2. **默认关闭**：`seamEnabled()` 不认空值 / `0` / 随机字符串，只认 `1` / `true`；
//      DefinePlugin 注入的是 `'undefined'`（→ 内联成 `undefined` → 守卫被死代码消除），不是假会话。
//   3. **短路位置**：AuthGate 的接缝放行必须排在「等恢复跑完」（`if (!restored)`）**之前** ——
//      排在后面的话未登录冷启动仍会先画登录页，等于接缝没生效。
//   4. **产物扫描器真的会红**：往临时目录里写一份带假 token 的产物，`scanForSeam()` 必须扫到；
//      干净目录必须扫不到（否则门禁恒绿，`scripts/check-test-seam.mjs` 就成了装饰品）。
//
// 为什么这层的断言是「源码 + 小函数」而不是渲染 AuthGate：`.tsx` 裸 Node import 不了（JSX 不在
// 类型擦除范围内），能真跑的只有扫描器与开关；渲染路径由黄金回归 / L1 在**真产物**上验证。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installTestAuthState, uninstallTestAuthState } from '../helpers/injected.mjs'
import {
  SEAM_ACCESS_TOKEN,
  SEAM_FLAG,
  SEAM_MARKERS,
  SEAM_SESSION,
  scanForSeam,
  seamEnabled,
} from '../../scripts/lib/testAuthSeam.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const readSource = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

/** `src/**` 下所有「装得下代码」的源文件（与 docs/capabilities 的扫描口径一致） */
const sourceFiles = () => {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(tsx?|jsx?|mjs|cjs)$/u.test(entry.name)) {
        out.push(full)
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return out
}

/** 建一个临时产物目录，测试结束（含失败）一律删掉，别给仓库/磁盘留垃圾 */
const withTempDir = (name, files, run) => {
  const dir = mkdtempSync(path.join(tmpdir(), `seam-${name}-`))
  try {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(dir, relative)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('接缝不许有运行期兜底：src 里不出现 globalThis/window 上的 __TEST_AUTH_STATE__', () => {
  const offenders = sourceFiles()
    .filter((file) => /(globalThis|window|self)\s*(\.|\[)\s*['"`]?__TEST_AUTH_STATE__/u.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))
  assert.deepEqual(offenders, [], '接缝只能是构建期常量；运行期读全局变量等于给线上留一条旁路')
})

test('接缝默认关闭：只有 TEST_AUTH_SEAM=1/true 才算打开', () => {
  assert.equal(seamEnabled({}), false, '没有环境变量时必须关闭')
  assert.equal(seamEnabled({ [SEAM_FLAG]: '' }), false)
  assert.equal(seamEnabled({ [SEAM_FLAG]: '0' }), false)
  assert.equal(seamEnabled({ [SEAM_FLAG]: 'yes' }), false)
  assert.equal(seamEnabled({ [SEAM_FLAG]: '1' }), true)
  assert.equal(seamEnabled({ [SEAM_FLAG]: ' true ' }), true)
})

test('DefinePlugin 的默认注入是 undefined（不是假会话），假会话只在开关打开时内联', () => {
  const config = readSource('rspack.config.ts')
  assert.match(
    config,
    /__TEST_AUTH_STATE__:\s*testAuthSeam \? JSON\.stringify\(SEAM_SESSION\) : 'undefined'/u,
    '正常构建必须注入 undefined，否则守卫不会被死代码消除'
  )
  assert.match(config, /const testAuthSeam = seamEnabled\(\)/u)
  // 假 token 只在 scripts/lib/testAuthSeam.mjs 里写一次（单一来源），构建配置里不许再抄一份
  assert.equal(config.includes(SEAM_ACCESS_TOKEN), false, '假 token 不许在构建配置里写第二份')
})

test('AuthGate 的接缝放行排在「等恢复」之前（排在后面等于没生效）', () => {
  const gate = readSource('src/components/auth/AuthGate.tsx')
  const seamIndex = gate.indexOf('if (TEST_AUTH_STATE !== undefined) {\n    return <>{children}</>')
  const restoredIndex = gate.indexOf('if (!restored)')
  assert.notEqual(seamIndex, -1, 'AuthGate 里必须有接缝短路放行')
  assert.notEqual(restoredIndex, -1, '原有的「恢复没跑完只转圈」分支不许消失')
  assert.ok(seamIndex < restoredIndex, '接缝必须先短路：否则未登录冷启动仍会先画登录页')
  // 接缝生效时不再走 restoreAuth（否则假会话会被盘上 / 网络的恢复结果覆盖）
  assert.match(gate, /if \(TEST_AUTH_STATE === undefined\) \{\s*void restoreAuth\(\)/u)
})

test('产物扫描器：带标记的产物扫得到、干净产物扫不到（门禁不能恒绿）', () => {
  withTempDir('clean', { 'static/js/main.js': 'var a=1;\n' }, (dir) => {
    assert.deepEqual(scanForSeam(dir), [], '干净产物必须扫不到')
  })

  withTempDir('dirty', { 'static/js/main.js': `var t="${SEAM_ACCESS_TOKEN}";\n` }, (dir) => {
    const hits = scanForSeam(dir)
    assert.equal(hits.length, 1, '带假 token 的产物必须被扫到')
    assert.equal(hits[0].marker, SEAM_ACCESS_TOKEN)
  })

  // 标识符本身也算泄漏：DefinePlugin 漏注入时它会原样留在产物里
  withTempDir('leaky', { 'main.js': 'if (typeof __TEST_AUTH_STATE__ !== "undefined") {}\n' }, (dir) => {
    assert.deepEqual(
      scanForSeam(dir).map((hit) => hit.marker),
      ['__TEST_AUTH_STATE__']
    )
  })

  // 二进制 / 字体不扫：它们装不下这段代码，扫了只是浪费门禁时间
  withTempDir('binary', { 'font.woff2': SEAM_ACCESS_TOKEN }, (dir) => {
    assert.deepEqual(scanForSeam(dir), [])
  })
})

test('标记清单与假会话形状自洽（扫描器要拦的就是这些串）', () => {
  assert.deepEqual([...SEAM_MARKERS], ['__TEST_AUTH_STATE__', SEAM_ACCESS_TOKEN])
  assert.equal(SEAM_SESSION.accessToken, SEAM_ACCESS_TOKEN)
  assert.match(SEAM_SESSION.user.email, /\.invalid$/u, '假账号必须落在 .invalid 域（一眼假，也不可能真的收信）')
})

test('未打包环境（node --test）的接缝只走显式安装：installTestAuthState() 之后 typeof 才读得到', () => {
  // AuthGate 里那句是 `typeof __TEST_AUTH_STATE__ !== 'undefined' ? … : undefined`：
  // 没打包时它落到未声明标识符的 typeof 上（不抛错）。断言这个机制真的成立 ——
  // 而不是「装个 global 却读不到」的假接缝。
  uninstallTestAuthState()
  assert.equal(typeof __TEST_AUTH_STATE__, 'undefined', '没装的时候必须读不到（默认关闭）')
  const installed = installTestAuthState()
  try {
    assert.equal(typeof __TEST_AUTH_STATE__, 'object')
    assert.equal(__TEST_AUTH_STATE__.accessToken, SEAM_ACCESS_TOKEN)
    assert.equal(installed, SEAM_SESSION)
  } finally {
    uninstallTestAuthState()
  }
  assert.equal(typeof __TEST_AUTH_STATE__, 'undefined', '卸掉之后必须回到「读不到」')
})

test('门禁脚本认 `--` 分隔符（pnpm run <script> -- --expect-seam 会把 `--` 原样透传）', () => {
  const script = readSource('scripts/check-test-seam.mjs')
  assert.match(script, /if \(arg === '--'\) \{\s*continue/u, 'pnpm 9 会把 `--` 透传给脚本，解析时必须忽略它')
})
