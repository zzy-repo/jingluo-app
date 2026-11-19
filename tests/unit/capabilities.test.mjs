// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
//
// GitHub issue #209「能力探测替代一切假设」：`src/utils/capabilities.ts` 的验收用例。
//
// 这里要钉的不是「函数能返回布尔」，而是 **#173 那种假阳性**：
// `CSS.supports('gap', ...)` 在 WebView 83 上返回 true，实际渲染出来间距是 0。
// 静态探测（cssSupports）说支持、动态回读（verifyCss）说不支持 —— 后者才可信，
// 用例 ③ 把这条差异单独断言一次，避免以后有人把 verifyCss 改回成 cssSupports 的别名。
//
// 为什么能直接 import 源码 .ts：node 22 的 type stripping（与
// tests/unit/legacy-polyfills.test.mjs 同一套手法）。capabilities.ts 不带相对 import，
// 所以不需要 resolve hook。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cssSupports,
  hasApi,
  hasPlugin,
  resetCapabilityCache,
  verifyCss,
} from '../../src/utils/capabilities.ts'

/** 假元素：只长 verifyCss 用得到的那几根毛（style / setAttribute / remove） */
const createFakeElement = (doc) => {
  const properties = new Map()
  return {
    attributes: new Map(),
    parent: null,
    removed: false,
    style: {
      cssText: '',
      setProperty(name, value) {
        properties.set(name, value)
      },
      getPropertyValue: (name) => properties.get(name) ?? '',
    },
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    remove() {
      this.removed = true
      if (this.parent) {
        const index = this.parent.children.indexOf(this)
        if (index !== -1) this.parent.children.splice(index, 1)
        this.parent = null
      }
    },
  }
}

/** 假 document：body.append + defaultView.getComputedStyle 够 verifyCss 跑完 */
const createFakeDocument = (computed = {}) => {
  const doc = {
    children: [],
    body: {
      children: [],
      append(...nodes) {
        for (const node of nodes) {
          node.parent = doc.body
          doc.body.children.push(node)
        }
      },
    },
    createElement: () => createFakeElement(doc),
    defaultView: {
      getComputedStyle: () => ({
        getPropertyValue: (name) => computed[name] ?? '',
      }),
    },
  }
  return doc
}

const withGlobal = (name, value, run) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name)
  const previous = globalThis[name]
  globalThis[name] = value
  try {
    return run()
  } finally {
    if (had) globalThis[name] = previous
    else delete globalThis[name]
  }
}

test('#209 hasApi：点路径逐段判存在（命中 / 未命中 / 中途断链）', () => {
  resetCapabilityCache()
  withGlobal('__CAP_FIXTURE__', { deep: { leaf: 1 }, list: [1, 2], empty: null }, () => {
    assert.equal(hasApi('__CAP_FIXTURE__.deep.leaf'), true, '命中的点路径要为 true')
    assert.equal(hasApi('__CAP_FIXTURE__.list.length'), true, '原型链上的属性也算存在')
    assert.equal(hasApi('__CAP_FIXTURE__.deep.missing'), false, '末段不存在要为 false')
    assert.equal(hasApi('__CAP_FIXTURE__.nope.leaf'), false, '中途断链要为 false')
    assert.equal(hasApi('__CAP_FIXTURE__.deep.leaf.nested'), false, '断在原始值上要为 false')
    assert.equal(hasApi('__CAP_FIXTURE__.empty'), false, '值为 null 要当作没有')
    assert.equal(hasApi(''), false, '空路径要为 false 且不抛')
  })
  assert.equal(hasApi('Object.hasOwn'), true)
  assert.equal(hasApi('Object.prototype.__not_a_real_method__'), false)
})

test('#209 cssSupports：宿主没有 CSS 时安全降级为 false（不抛）', () => {
  resetCapabilityCache()
  withGlobal('CSS', undefined, () => {
    assert.equal(cssSupports('gap', '1px'), false)
  })
  withGlobal('CSS', {}, () => {
    resetCapabilityCache()
    assert.equal(cssSupports('gap', '1px'), false, 'CSS 存在但没 supports 也要为 false')
  })
  withGlobal(
    'CSS',
    {
      supports() {
        throw new Error('boom')
      },
    },
    () => {
      resetCapabilityCache()
      assert.equal(cssSupports('gap', '1px'), false, 'supports 自己抛错要吞掉并给 false')
    }
  )
})

test('#209 verifyCss：CSS.supports 假阳性（回读不一致）必须判成不支持', () => {
  resetCapabilityCache()
  // WebView 83 的真实形状：CSS.supports 承认，渲染出来是 0px
  withGlobal('CSS', { supports: () => true }, () => {
    assert.equal(cssSupports('column-gap', '8px'), true, '静态探测（假阳性那一半）')

    const doc = createFakeDocument({ 'column-gap': '0px' })
    assert.equal(verifyCss('column-gap', '8px', undefined, { doc }), false, '回读是 0px，动态判定必须为 false')

    const body = doc.body
    assert.equal(body.children.length, 0, '探针元素必须从 body 上摘掉')
  })

  resetCapabilityCache()
  const ok = createFakeDocument({ 'column-gap': '8px' })
  assert.equal(verifyCss('column-gap', '8px', undefined, { doc: ok }), true, '回读一致时要为 true')
})

test('#209 缓存：同一 key 只真探一次', () => {
  resetCapabilityCache()
  let reads = 0
  const fixture = {}
  Object.defineProperty(fixture, 'flag', {
    configurable: true,
    get() {
      reads += 1
      return true
    },
  })
  withGlobal('__CAP_CACHE_FIXTURE__', fixture, () => {
    assert.equal(hasApi('__CAP_CACHE_FIXTURE__.flag'), true)
    assert.equal(hasApi('__CAP_CACHE_FIXTURE__.flag'), true)
    assert.equal(hasApi('__CAP_CACHE_FIXTURE__.flag'), true)
    assert.equal(reads, 1, '取三次只该读一次宿主属性')
  })

  let probes = 0
  const doc = createFakeDocument({ 'row-gap': '4px' })
  const readback = () => {
    probes += 1
    return true
  }
  resetCapabilityCache()
  assert.equal(verifyCss('row-gap', '4px', readback, { doc }), true)
  assert.equal(verifyCss('row-gap', '4px', readback, { doc }), true)
  assert.equal(probes, 1, '同一对 prop/value 只该造一次探针')
})

test('#209 resetCapabilityCache：清空缓存后重新探测', () => {
  let probes = 0
  const doc = createFakeDocument({ 'row-gap': '4px' })
  const readback = () => {
    probes += 1
    return true
  }
  resetCapabilityCache()
  verifyCss('row-gap', '4px', readback, { doc })
  assert.equal(probes, 1)
  resetCapabilityCache()
  verifyCss('row-gap', '4px', readback, { doc })
  assert.equal(probes, 2, 'reset 之后要重新真探一次')
})

test('#209 hasPlugin：没有 Capacitor 时返回 false 且不抛', () => {
  resetCapabilityCache()
  withGlobal('Capacitor', undefined, () => {
    assert.equal(hasPlugin('DiagnosticsDevice'), false)
  })
  withGlobal(
    'Capacitor',
    {
      isPluginAvailable() {
        throw new Error('boom')
      },
    },
    () => {
      resetCapabilityCache()
      assert.equal(hasPlugin('DiagnosticsDevice'), false, 'isPluginAvailable 抛错要吞掉并给 false')
    }
  )
  resetCapabilityCache()
  withGlobal(
    'Capacitor',
    {
      isPluginAvailable: (name) => name === 'DiagnosticsDevice',
    },
    () => {
      resetCapabilityCache()
      assert.equal(hasPlugin('DiagnosticsDevice'), true, '宿主说有时要为 true')
      assert.equal(hasPlugin('Whatever'), false, '宿主说没有时要为 false')
    }
  )
})
