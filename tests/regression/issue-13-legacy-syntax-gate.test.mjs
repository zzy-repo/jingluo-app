// [layer: regression | 依赖: 无（纯 Node，无浏览器/网络/模拟器） | Issue #13（关联 #10 / #73）]
//
// 回归对象：低内核 WebView 的**语法门禁**——scripts/check-bundle-syntax.mjs 的词法层与 AST 层。
//
// 修复前症状（#13）：产物里出现 `||=` / `&&=` / `??=` 或 class static block，WebView 83（ColorOS /
//   旧 Android）解析直接 SyntaxError，App 一进就白屏；当时门禁没卡这一层，靠用户反馈才发现。
// 修复后预期：这三类必须被 findForbiddenSyntax 报成 logical-assignment / class-static-block；
//   而 Chrome 80 就支持的 `?.` / `??` 必须**放行**——门禁误杀合法产物同样是事故（#73 那类假红）。
//
// 这条用例只断言"能不能拦住"，不关心门禁内部用正则还是 AST。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { findForbiddenSyntax, findForbiddenAst } = await import('../../scripts/check-bundle-syntax.mjs')

const kindsOf = (code) => findForbiddenSyntax(code).map((finding) => finding.kind)

test('#13 可选链 / 空值合并必须放行（误杀合法产物同样算回归）', () => {
  const code = ['const a = b?.c?.d', 'const e = f ?? g', 'const h = i?.[0] ?? j?.()'].join('\n')
  assert.deepEqual(kindsOf(code), [])
})

test('#13 ||= / &&= / ??= 三种逻辑赋值必须拦下，并指出行列', () => {
  for (const operator of ['||=', '&&=', '??=']) {
    const findings = findForbiddenSyntax(`let a = 1\na ${operator} 2`)
    assert.deepEqual(
      findings.map((finding) => finding.kind),
      ['logical-assignment'],
      `${operator} 在 WebView 83 上必解析失败，门禁漏掉就是白屏回归`
    )
    assert.equal(findings[0].token, operator)
    assert.equal(findings[0].line, 2)
    assert.equal(findings[0].column, 3)
  }
})

test('#13 class static block 必须拦下（Chrome 94+ 才有）', () => {
  const findings = findForbiddenSyntax('class A {\n  static { this.x = 1 }\n}')
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['class-static-block']
  )
})

test('#13 字符串 / 模板 / 注释 / 正则里的同名文本不算违规（否则改一句文案就能把门禁打红）', () => {
  const code = [
    "const s = 'a ||= b'",
    'const t = `x ??= y`',
    '// 说明里写 c ||= d 也不行吗',
    '/* e &&= f */',
    'const re = /(a||=b)/g',
  ].join('\n')
  assert.deepEqual(kindsOf(code), [])
})

test('#13 语法层与词法层看到同一批违规（acorn 缺失时词法层必须仍能兜底）', () => {
  const allowed = findForbiddenAst('const a = b?.c ?? d')
  assert.ok(
    allowed === null || allowed.findings.length === 0,
    `?. / ?? 不该报 AST 违规：${JSON.stringify(allowed)}`
  )
  const forbidden = findForbiddenAst('let a = 1\na ||= 2')
  if (forbidden !== null) {
    assert.deepEqual(
      forbidden.findings.map((finding) => finding.kind),
      ['logical-assignment']
    )
  }
})
