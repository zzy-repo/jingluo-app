// [layer: unit | 依赖: 无（纯 Node，零浏览器；acorn 是 @rspack 的传递依赖） | 耗时: <1s]
// issue #156：check:legacy 的字面量遮蔽必须是 **AST 级** 的，不能退回手写状态机。
//
// 背景：词法层要先剥掉字符串/模板/正则/注释才能 grep '||='，但改之前那套手写状态机在压缩 chunk 上
// 会把成片真实代码当成字面量吃掉（实测 88 个 chunk 里 27 个中标，共吞掉 1 025 143 个字符、35 293 段，
// 单段最长 9 338 字符）。于是 `Intl.Segmenter` / `Object.fromEntries` / `structuredClone` 这些**真实调用点**
// 在词法层和运行时 API 层一起消失 —— 闸门假绿（issue 原文：API 层命中数 13 → 应为 17）。
//
// 这个文件锁四件事：
//   [1] 最小复现：正则出现在模板表达式里（`${/x/.test(y)?1:2}`），后面的真实代码必须还在
//       —— 旧实现从这里开始把文件剩余部分全抹成空格，Object.hasOwn 直接消失
//   [2] 成员访问不丢：Intl.Segmenter / .segment( / .at( / Object.fromEntries 剥完仍然可见
//   [3] 遮蔽不越界：字符串/模板/正则/注释里的 '||=' 不报（不假红），真实代码里的 '||=' 照报（不假绿）
//   [4] 形状契约：等长、换行位置不变（positionOf 的行列才能和原文对齐）；acorn 缺失时明确抛错，
//       绝不静默降级
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AcornUnavailableError,
  findForbiddenAst,
  findForbiddenSyntax,
  positionOf,
  stripLiterals,
} from '../../scripts/check-bundle-syntax.mjs'

/** 断言遮蔽不改变长度、也不挪换行（positionOf 依赖这两条） */
const assertMaskShape = (code, stripped) => {
  assert.equal(stripped.length, code.length, '遮蔽后长度必须与原文一致')
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '\n') assert.equal(stripped[index], '\n', `第 ${index} 个字符是换行，必须保留`)
  }
}

test('[1] 模板表达式里的正则不会吞掉它后面的真实代码（issue #156 最小复现）', () => {
  // 旧状态机在这里失手：`${` 之后遇到 '/' 进入正则，回到模板字符串的栈混乱，
  // 结果从这一行往后全被空格吃掉 —— 这份 44 字符的样本旧实现输出里连 Object.hasOwn 都没有
  const code = 'var s=`${/x/.test(y)?1:2}`;Object.hasOwn(o,"k");'
  const stripped = stripLiterals(code)

  assert.ok(stripped.includes('Object.hasOwn'), 'Object.hasOwn 是真实成员访问，必须保留')
  assert.ok(stripped.includes('.test(y)'), '.test(y) 是真实调用，必须保留')
  assertMaskShape(code, stripped)
})

test('[2] Intl.Segmenter 这类成员访问剥完仍然可见（词法层 / 运行时 API 层都靠它）', () => {
  const code = [
    'var g=new Intl.Segmenter("zh",{granularity:"word"}),',
    'it=g.segment("abc"),',
    'last=[...it].at(-1),',
    'm=Object.fromEntries(last),',
    'c=structuredClone(m),',
    'r="a b".replaceAll(" ","\\u00a0");',
  ].join('')
  const stripped = stripLiterals(code)

  for (const visible of [
    'Intl.Segmenter',
    '.segment(',
    '.at(-1)',
    'Object.fromEntries',
    'structuredClone',
    '.replaceAll(',
  ]) {
    assert.ok(stripped.includes(visible), `剥离后必须仍能看到 ${visible}`)
  }
  // 字面量内容本身要抹掉（否则字符串里的同名词会误报）
  for (const blanked of ['"zh"', '"word"', '"abc"', '"a b"', '"\\u00a0"']) {
    assert.ok(!stripped.includes(blanked), `字面量 ${blanked} 的内容不该被 grep 看到`)
  }
  assertMaskShape(code, stripped)
})

test('[3] 遮蔽不越界：字面量里的 ||= 不报，真实代码里的 ||= 照报', () => {
  const code = [
    'var a="p ||= q",', // 字符串里的
    'b=`t ||= u`,', // 模板里的
    'c=/v||=w/g,', // 正则里的
    'd=1;', // 注释里的见下一行
    '/* x ||= y */',
    'd ||= 2,', // ← 唯一的真违规（第 6 行）
    'e=null;e ??= 3;',
  ].join('\n')
  const findings = findForbiddenSyntax(code)

  assert.deepEqual(
    findings.map((item) => `${item.kind}@${item.line}:${item.column}`),
    ['logical-assignment@6:3', 'logical-assignment@7:10'],
    '只应报真实代码里的 2 处，且行列必须是原文里的位置',
  )
  assert.ok(findings.every((item) => item.why === '逻辑赋值（ES2021 / Chrome 85）'))
  assertMaskShape(code, stripLiterals(code))
})

test('[4] 形状契约：等长 + 换行不变 + positionOf 行列与原文一致', () => {
  const code = 'var t=`a${/x/g.test(s)?1:2}b`;var n=Intl.Segmenter;\nvar q=Object.hasOwn(o,"k");\n'
  const stripped = stripLiterals(code)
  assertMaskShape(code, stripped)

  for (const token of ['Intl.Segmenter', 'Object.hasOwn']) {
    const index = code.indexOf(token)
    assert.ok(index >= 0)
    assert.equal(stripped.indexOf(token), index, `${token} 的位置不该被挪动`)
    assert.deepEqual(positionOf(stripped, index), positionOf(code, index))
  }
  assert.deepEqual(positionOf(stripped, code.indexOf('Object.hasOwn')), { line: 2, column: 7 })
})

test('[5] acorn 缺失时的契约：明确失败，不静默降级成手写状态机', () => {
  const error = new AcornUnavailableError()
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'AcornUnavailableError')
  assert.equal(error.code, 'ACORN_UNAVAILABLE')
  assert.match(error.message, /pnpm install/)

  // 本仓库 acorn 一定在（@rspack 的传递依赖）：语法层必须真的跑起来并报出版本号
  const ast = findForbiddenAst('var a=1')
  assert.ok(ast, 'acorn 在的环境里 findForbiddenAst 不许返回 null')
  assert.match(ast.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(ast.findings, [])
})

test('[6] 解析不了的文件整份不遮蔽（宁可假红，绝不假绿）', () => {
  const broken = 'var = ;'
  assert.equal(stripLiterals(broken), broken, '解析失败时不遮蔽，只能多报不能少报')
  assert.equal(findForbiddenAst(broken).findings[0].kind, 'parse-error')
})
