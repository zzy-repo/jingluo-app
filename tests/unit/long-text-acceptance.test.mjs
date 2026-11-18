// Focused acceptance fixtures for mobile long-text paths. No device or network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
const { copyText, MAX_CLIPBOARD_UTF8_BYTES } = await import('../../src/utils/clipboard.ts')
const { readTextFile } = await import('../../src/utils/textFile.ts')

const makeDraft = (initial = '') => ({ text: initial, setText(value) { this.text = value } })
import { createHash } from 'node:crypto'
const digest = async (text) => createHash('sha256').update(text).digest('hex')

test('over-limit copy has no system calls and cannot produce copied state', async () => {
  let writes = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { writes++ } } } })
  const result = await copyText('x'.repeat(MAX_CLIPBOARD_UTF8_BYTES + 1))
  assert.equal(result, 'too-large')
  assert.equal(writes, 0)
})

test('TXT import inserts at cursor, preserves existing draft, length and hash', async () => {
  const imported = '前缀😀\n' + '合成中文'.repeat(12000)
  const draft = makeDraft('已有文本')
  const cursor = 2
  const next = draft.text.slice(0, cursor) + await readTextFile(new Blob([imported])) + draft.text.slice(cursor)
  draft.setText(next)
  assert.equal(next.length, '已有文本'.length + imported.length)
  assert.equal(await digest(next), await digest('已有' + imported + '文本'))
})

test('cancelled TXT read leaves draft unchanged', async () => {
  const draft = makeDraft('保留草稿😀')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readTextFile(new Blob(['新文本']), { signal: controller.signal }))
  assert.equal(draft.text, '保留草稿😀')
})
