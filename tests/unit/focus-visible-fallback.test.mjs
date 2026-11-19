// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// issue #215：`:focus-visible` 首支持 Chromium 86，本项目运行时下限是 WebView 83（Chromium 83）。
//
// 为什么这条要单独钉住：`:focus-visible` 是**未知伪类**，出现在选择器里时 83 判整条选择器无效、
// **整条规则被丢弃** —— 不是「匹配不到」，而是焦点找不到时的那一圈视觉反馈整块消失。
// 原来 13 处 `:focus-visible` 承载的就是「Tab 走到这里时看得见」，低内核上等于完全没有。
//
// 合格的写法是三段（理由见 scripts/lib/focusVisibleAudit.mjs 顶部注释）：
//   ① `:focus` 兜底（83 只有这一段生效，鼠标点击也出环 —— 可接受降级）
//   ② `:focus:not(:focus-visible)` 在现代内核收回鼠标点击的环（83 上该选择器整条失效，兜底保留）
//   ③ `:focus-visible` 覆盖（键盘态由它接管）
//
// 本文件守三条：
//   ① `src/**` 里每一处 `:focus-visible` 都有配套的 ① / ②；
//   ② #215 点名的 13 处一处不少（防止有人「顺手删掉不合规矩的那条规则」把缺陷藏起来）；
//   ③ 判定器本身不许退化成「全报」或「全放」—— 修复前的写法必须判红、修复后的写法必须判绿。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditCssText, auditFocusVisible } from '../../scripts/lib/focusVisibleAudit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'src')

/** #215 点名的 13 处：文件 → 该文件里的 `:focus-visible` 条数（少一条就是被删了） */
const INVENTORY = {
  'components/base/Button.module.css': 2,
  'components/base/IconButton.module.css': 1,
  'components/base/Select.module.css': 1,
  'components/chatInput/VoiceButton.module.css': 1,
  'components/markdown/markdown.css': 1,
  'components/session/MobileHeader.module.css': 1,
  'components/session/Welcome.module.css': 1,
  'components/settings/OursServices.module.css': 1,
  'components/settings/Settings.module.css': 3,
  'components/sider/Sider.module.css': 1,
}

test('① src/** 每处 :focus-visible 都有 :focus 兜底 + :focus:not(:focus-visible) 收回（#215）', async () => {
  const result = await auditFocusVisible(SRC)
  const detail = result.problems
    .map((item) => `  ${item.file}:${item.line}  ${item.selector}\n      ${item.why}`)
    .join('\n')
  assert.equal(
    result.occurrences.length > 0,
    true,
    'src 里一处 :focus-visible 都没扫到，审计多半坏了',
  )
  assert.deepEqual(
    result.problems.map((item) => `${item.file}:${item.line} ${item.why}`),
    [],
    `还有 ${result.problems.length} 处 :focus-visible 缺兜底（Chromium 83 上整条规则被丢弃）：\n${detail}`,
  )
})

test('② #215 点名的 13 处一处不少：删规则不算修好', async () => {
  const result = await auditFocusVisible(SRC)
  const missing = []
  for (const [file, count] of Object.entries(INVENTORY)) {
    const hits = result.occurrences.filter((item) => item.file === `../src/${file}` || item.file === file)
    if (hits.length < count) missing.push(`${file}：应 ≥ ${count} 处，实际 ${hits.length} 处`)
  }
  assert.deepEqual(missing, [], `#215 的清单少了条目（被删还是会退化成兜底前的写法，都不是修复）：\n  ${missing.join('\n  ')}`)
  assert.ok(result.occurrences.length >= 13, `:focus-visible 只有 ${result.occurrences.length} 处，少于 #215 的 13 处`)
})

test('③ 判定器不许退化：修复前的写法判红、修复后的写法判绿', () => {
  // 修复前（= #215 的红）：只有 :focus-visible，83 上整条被丢
  const before = auditCssText(`
.button {
  outline: none;

  &:focus-visible {
    box-shadow: 0 0 0 2px #4d6bfe;
  }
}
`)
  assert.equal(before.occurrences.length, 1)
  assert.equal(before.problems.length, 2, `修复前应同时报「缺 :focus 兜底」与「缺 :focus:not(:focus-visible)」，实际：${JSON.stringify(before.problems)}`)

  // 有 :focus，但里面 outline: none 了事 —— 等于把环一起关掉，不算兜底
  const hollow = auditCssText(`
.button {
  &:focus {
    outline: none;
  }

  &:focus:not(:focus-visible) {
    box-shadow: none;
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px #4d6bfe;
  }
}
`)
  assert.equal(hollow.problems.length, 1)
  assert.match(hollow.problems[0].why, /没给出可见的焦点环/u)

  // 兜底给了别的选择器（.input:focus 之于 .plan:focus-visible）—— 不构成兜底
  const wrongSelector = auditCssText(`
.plan {
  &:focus-visible {
    box-shadow: 0 0 0 2px #4d6bfe;
  }
}

.input {
  &:focus {
    border-color: #4d6bfe;
  }
}
`)
  assert.equal(wrongSelector.problems.length, 2)

  // 修复后：三段齐全，判绿
  const after = auditCssText(`
.button {
  outline: none;

  &:focus {
    box-shadow: 0 0 0 2px #4d6bfe;
  }

  &:focus:not(:focus-visible) {
    box-shadow: none;
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px #4d6bfe;
  }
}
`)
  assert.deepEqual(after.problems.map((item) => item.why), [])
  assert.equal(after.occurrences.length, 1)
  assert.equal(after.occurrences[0].fallback.selector, '.button:focus')
  assert.equal(after.occurrences[0].reset.selector, '.button:focus:not(:focus-visible)')

  // 顶层选择器 + outline 那一套（Welcome / douyinPill 的写法）也要认
  const outlineShape = auditCssText(`
.modeOption:focus {
  outline: 2px solid #4d6bfe;
  outline-offset: 1px;
}

.modeOption:focus:not(:focus-visible) {
  outline: none;
}

.modeOption:focus-visible {
  outline: 2px solid #4d6bfe;
  outline-offset: 1px;
}
`)
  assert.deepEqual(outlineShape.problems.map((item) => item.why), [])
})
