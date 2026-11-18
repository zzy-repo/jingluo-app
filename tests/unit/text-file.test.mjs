import assert from 'node:assert/strict'
import { test } from 'node:test'
const { readTextFile, MAX_TEXT_IMPORT_BYTES, TextImportError } = await import('../../src/utils/textFile.ts')

test('TXT import preserves UTF8 Chinese/emoji and yields exact text', async () => {
  const text = '开头😀\n' + '内容'.repeat(10000)
  assert.equal(await readTextFile(new Blob([text])), text)
})
test('TXT import rejects declared and streamed over-limit files', async () => {
  await assert.rejects(readTextFile({ size: MAX_TEXT_IMPORT_BYTES + 1, stream: () => new Blob(['x']).stream() }), (e) => e.code === 'too-large')
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(MAX_TEXT_IMPORT_BYTES + 1))); c.close() } })
  await assert.rejects(readTextFile({ size: 1, stream: () => stream }), (e) => e.code === 'too-large')
})
test('TXT import cancellation and broken stream are explicit', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readTextFile(new Blob(['x']), { signal: controller.signal }), (e) => e instanceof TextImportError && e.code === 'cancelled')
  const broken = new ReadableStream({ pull() { throw new Error('broken') } })
  await assert.rejects(readTextFile({ size: 1, stream: () => broken }), (e) => e.code === 'read-failed')
})
