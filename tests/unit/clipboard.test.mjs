// [layer: unit | clipboard boundaries with browser API fakes]
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'

const state = { writeCalls: 0, execCalls: 0, execResult: true }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { state.writeCalls++ } } } })
globalThis.document = {
  createElement: () => ({ value: '', style: {}, readOnly: false, focus() {}, select() {}, setSelectionRange() {}, remove() {} }),
  body: { appendChild() {} },
  execCommand: () => { state.execCalls++; return state.execResult },
}
const { copyText, MAX_CLIPBOARD_UTF8_BYTES } = await import('../../src/utils/clipboard.ts')

beforeEach(() => { state.writeCalls = 0; state.execCalls = 0; state.execResult = true })

test('UTF8 boundary accepts exact budget and rejects one byte over without system calls', async () => {
  const exact = 'a'.repeat(MAX_CLIPBOARD_UTF8_BYTES)
  assert.notEqual(await copyText(exact), 'too-large')
  assert.equal(state.writeCalls, 1)
  state.writeCalls = 0
  const over = 'a'.repeat(MAX_CLIPBOARD_UTF8_BYTES - 3) + '😀'
  assert.equal(new TextEncoder().encode(over).byteLength, MAX_CLIPBOARD_UTF8_BYTES + 1)
  assert.equal(await copyText(over), 'too-large')
  assert.equal(state.writeCalls, 0)
  assert.equal(state.execCalls, 0)
})

test('Chinese and emoji are measured as UTF8, and false fallback is failed', async () => {
  const text = '中文😀'.repeat(100)
  assert.equal(await copyText(text), 'copied')
  navigator.clipboard.writeText = async () => { throw new Error('NotAllowedError') }
  state.execResult = false
  assert.equal(await copyText(text), 'failed')
  assert.equal(state.execCalls, 1)
})

test('execCommand true is surfaced as requested copy, without read-back claims', async () => {
  state.execResult = true
  navigator.clipboard.writeText = async () => { throw new Error('NotAllowedError') }
  assert.equal(await copyText('short'), 'copied')
  assert.equal(state.execCalls, 1)
})
