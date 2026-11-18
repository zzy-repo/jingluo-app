import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
const guard = html.match(/<script>([\s\S]*?)<\/script>/)[1]
function probe(remove = '') {
  const box = { hidden: true, style: {}, textContent: '' }
  const listeners = {}
  const context = vm.createContext({ document: { getElementById: () => box }, addEventListener: (name, callback) => { listeners[name] = callback } })
  vm.runInContext(`window = globalThis; fetch = function(){}; URL=function(){}; CSS={escape:function(){}}; AbortController=function(){}; TextDecoder=function(){}; ResizeObserver=function(){};`, context)
  if (remove) vm.runInContext(remove, context)
  vm.runInContext(guard, context)
  return { context, box, listeners }
}

test('complete simulated capabilities leave boot to actual app (not a 105 UI PASS)', () => {
  const { context, box } = probe()
  assert.equal(context.__DEEPSEEK_COMPATIBILITY_ERROR__, undefined)
  assert.equal(box.hidden, true)
})

test('simulate WebView 92 missing Object.hasOwn: readable diagnostic instead of blank root', () => {
  const { context, box } = probe('Object.hasOwn = undefined')
  assert.equal(box.hidden, false)
  assert.match(box.textContent, /Android System WebView/)
  assert.match(box.textContent, /Object.hasOwn/)
  assert.equal(context.__DEEPSEEK_COMPATIBILITY_ERROR__.length, 1)
})

test('each independently missing required capability yields named error', () => {
  for (const [remove, name] of [
    ['Promise=undefined', 'Promise'], ['fetch=undefined', 'fetch'], ['URL=undefined', 'URL'],
    ['Array.prototype.at=undefined', 'Array.prototype.at'], ['CSS=undefined', 'CSS.escape'],
    ['AbortController=undefined', 'AbortController'], ['TextDecoder=undefined', 'TextDecoder'], ['ResizeObserver=undefined', 'ResizeObserver'],
  ]) {
    const { box } = probe(remove)
    assert.equal(box.hidden, false, name)
    assert.ok(box.textContent.includes(name), name)
  }
})

test('early script/resource failure stays readable; guard retires once React removes placeholder', () => {
  const { listeners, box } = probe()
  listeners.error({ message: 'Unexpected token <script>' })
  assert.equal(box.hidden, false)
  assert.match(box.textContent, /Unexpected token <script>/)
  assert.equal(box.innerHTML, undefined) // Error content never enters HTML parsing.
  listeners.unhandledrejection({})
  assert.match(box.textContent, /启动任务异常/)
})

test('guard precedes bundle injection and main preserves its failure message', () => {
  assert.ok(html.indexOf('<div id="root">') < html.indexOf('<script>'))
  assert.doesNotMatch(guard, /\b(?:const|let)\s|=>|\?\.|\.at\(/)
  const main = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8')
  assert.ok(main.indexOf("throw new Error('WEBVIEW_CAPABILITY_MISSING')") < main.indexOf('ensureKatex()'))
})
