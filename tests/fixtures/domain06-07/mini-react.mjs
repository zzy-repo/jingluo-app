/**
 * 域 6+7 组件级用例的最小 React 运行时（**只给测试用，生产代码零感知**）。
 *
 * 为什么需要它：`OursServicesDialog.tsx` / `PaymentRecordsDialog.tsx` 是 `.tsx`，Node 的类型擦除
 * 不处理 JSX，而本域 P0 缺口恰好全在「组件挂载 → 发请求 → 落盘 → 刷新额度」这条编排上
 * （`docs/testing/coverage/domain-06-07.md` §5 的 N1/N2/N3）。为了不改生产代码、不引新依赖、
 * 不启动浏览器，这里用 120 行实现一个**只支持本域组件用到的那几个 hook** 的渲染器：
 *
 *   - `useState` / `useRef` / `useEffect` / `useCallback` / `useMemo` —— 按调用顺序存槽位，
 *     与 React 的「hook 顺序稳定」约束一致（组件不会条件调用 hook）；
 *   - `jsx` / `jsxs` / `createElement` —— 产出纯对象 `{ type, props, key }`，不依赖 react 包；
 *   - `settle()` —— 反复「渲染 → 跑 effect → 等 macrotask」直到连续若干轮没有状态更新，
 *     于是 `void (async () => { ... })()` 这类挂载副作用（真正的请求发起点）会真跑完。
 *
 * 它**不是** React 的实现：不合并更新、不做 key 复用、不处理 portal / context / Suspense。
 * 断言对象是「组件真的调了哪个服务、按什么顺序、状态变成什么文案」，不是渲染器行为本身。
 * 因此用例里刻意只对有 `data-testid` 的节点做断言（这些 id 是组件自己的契约，见各组件源码）。
 */

/** 当前正在渲染的根（渲染期之外为 null） */
let current = null
/** 已挂载的根：任何外部 store 变化都要让它们重渲染 */
const roots = new Set()

/** 外部 store（apiConfig / settingsDialogState）变化后调用：标记所有根为脏 */
export const markDirty = () => {
  for (const root of roots) {
    root.dirty = true
  }
}

const readSlot = (factory) => {
  const owner = current
  if (owner === null) {
    throw new Error('hook 必须在渲染期调用（mini-react 无 dispatcher 上下文）')
  }
  const index = owner.cursor
  owner.cursor += 1
  if (owner.slots.length <= index) {
    owner.slots[index] = factory()
  }
  return owner.slots[index]
}

const sameDeps = (previous, next) =>
  previous !== undefined &&
  next !== undefined &&
  previous.length === next.length &&
  previous.every((value, index) => Object.is(value, next[index]))

export const useState = (initial) => {
  const slot = readSlot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
  const owner = current
  const setState = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next
    if (Object.is(value, slot.value)) {
      return
    }
    slot.value = value
    // 状态变了 → 整个根进入待渲染（本夹具不做局部重渲染，简单但足以覆盖本域断言）
    if (owner.root !== undefined) {
      owner.root.dirty = true
    } else {
      markDirty()
    }
  }
  return [slot.value, setState]
}

/**
 * `useReducer` —— `PaymentTrailDialog`（#189/#326）用 `trailListReducer` 作为列表状态的唯一写入口，
 * 没有它就挂不起这页。语义与 `useState` 一致：状态真的变了才把根标记成待渲染
 * （reducer 返回同一个引用 = 没变化，和 React 的 bail out 一样）。
 */
export const useReducer = (reducer, initial, init) => {
  const slot = readSlot(() => ({
    value: typeof init === 'function' ? init(initial) : initial,
  }))
  const owner = current
  const dispatch = (action) => {
    const value = reducer(slot.value, action)
    if (Object.is(value, slot.value)) {
      return
    }
    slot.value = value
    if (owner.root !== undefined) {
      owner.root.dirty = true
    } else {
      markDirty()
    }
  }
  return [slot.value, dispatch]
}

export const useRef = (initial) => readSlot(() => ({ current: initial }))

export const useEffect = (effect, deps) => {
  const slot = readSlot(() => ({ deps: undefined, effect: null, cleanup: null }))
  slot.effect = effect
  if (deps === undefined || !sameDeps(slot.deps, deps)) {
    slot.deps = deps === undefined ? undefined : [...deps]
    current.pending.push(slot)
  }
}

export const useMemo = (factory, deps) => {
  const slot = readSlot(() => ({ deps: undefined, value: undefined }))
  if (!sameDeps(slot.deps, deps) || slot.deps === undefined) {
    slot.value = factory()
    slot.deps = deps === undefined ? undefined : [...deps]
  }
  return slot.value
}

export const useCallback = (callback, deps) => useMemo(() => callback, deps)

/** 外部 store 读取：真正的「订阅」由 markDirty 完成，这里只声明依赖关系（语义同 useSyncExternalStore） */
export const useStoreValue = (read) => read()

export const Fragment = Symbol.for('domain06-07.fragment')

export const jsx = (type, props, key) => ({
  type,
  key: key ?? null,
  props: props ?? {},
})

export const jsxs = jsx

export const jsxDEV = jsx

export const createElement = (type, props, ...children) => {
  const merged = { ...(props ?? {}) }
  const flat = children.flat()
  if (flat.length > 0) {
    merged.children = flat.length === 1 ? flat[0] : flat
  } else {
    merged.children = undefined
  }
  return { type, key: merged.key ?? null, props: merged }
}

// ------------------------------------------------------------------ 根与渲染

export const createRoot = (Component, props) => {
  const root = {
    Component,
    props,
    /** 组件实例的 hook 槽位：按「从根到该组件的位置路径」保存（见 frameFor 的说明） */
    frames: new Map(),
    cursor: 0,
    dirty: true,
    tree: null,
    renders: 0,
    pendingEffects: [],
    unmounted: false,
  }
  roots.add(root)
  return root
}

/**
 * 取（或建）某个组件实例的 hook 槽位。
 *
 * 键是**位置路径**而不是组件本身：`OursServicesRow` 里渲染 `OursServicesDialog` 这种
 * 「组件套组件、两层都用 hook」的写法，靠位置路径才能把两套槽位分开。
 * 限制（也是本夹具的边界）：路径稳定性依赖「父组件输出结构不变」——本域两个弹层的父级
 * （`OursServicesRow`）输出结构固定，因此路径恒定；不要在会整体重排的组件树上用它。
 */
const frameFor = (root, path, Component) => {
  const key = `${path}|${Component.name || 'anonymous'}`
  let frame = root.frames.get(key)
  if (frame === undefined || frame.Component !== Component) {
    frame = { Component, slots: [], cursor: 0, pending: [] }
    root.frames.set(key, frame)
  }
  return frame
}

const asArray = (children) => (Array.isArray(children) ? children.flat(Infinity) : [children])

const renderNode = (root, node, path) => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return null
  }
  if (Array.isArray(node)) {
    return node.flat(Infinity).map((child, index) => renderNode(root, child, `${path}.${index}`))
  }
  if (typeof node !== 'object' || !('type' in node)) {
    return node
  }
  const { type, props } = node
  if (type === Fragment) {
    return renderNode(root, props.children, path)
  }
  if (typeof type === 'function') {
    const frame = frameFor(root, path, type)
    const previous = current
    current = frame
    frame.cursor = 0
    frame.pending = []
    let output
    try {
      output = type({ ...props })
    } finally {
      current = previous
    }
    root.pendingEffects.push(...frame.pending)
    frame.pending = []
    return renderNode(root, output, `${path}>${type.name || 'anonymous'}`)
  }
  const children = asArray(props.children).map((child, index) =>
    renderNode(root, child, `${path}.${index}`)
  )
  return {
    type,
    key: node.key ?? null,
    props: { ...props, children: children.length === 1 ? children[0] : children },
  }
}

const renderOnce = (root) => {
  root.pendingEffects = []
  root.cursor = 0
  root.tree = renderNode(root, { type: root.Component, props: root.props, key: null }, 'root')
  root.renders += 1
  return root.pendingEffects
}

const runEffect = (slot) => {
  if (typeof slot.cleanup === 'function') {
    try {
      slot.cleanup()
    } catch {
      // effect 的清理函数抛错不该影响断言：React 也只是报错继续
    }
    slot.cleanup = null
  }
  if (typeof slot.effect !== 'function') {
    return
  }
  const output = slot.effect()
  if (typeof output === 'function') {
    slot.cleanup = output
  }
}

/**
 * 反复渲染直到连续 `idleTicks` 轮没有新的状态更新。
 *
 * 每次循环都让出一次 macrotask（`setTimeout 0`），所以 `await transport(...)` 之后才
 * `setState` 的那条链路（本域几乎全部逻辑都是这个形状）会在这里被推到稳定态。
 */
export const settle = async (root, options = {}) => {
  const maxTicks = options.maxTicks ?? 400
  const idleTicks = options.idleTicks ?? 4
  let idle = 0
  for (let tick = 0; tick < maxTicks && idle < idleTicks; tick += 1) {
    if (root.dirty) {
      root.dirty = false
      idle = 0
      const pending = renderOnce(root)
      for (const slot of pending) {
        runEffect(slot)
      }
    } else {
      idle += 1
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return root
}

export const unmount = (root) => {
  for (const frame of root.frames.values()) {
    for (const slot of frame.slots) {
      if (slot !== null && typeof slot === 'object' && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup()
        } catch {
          // 同上
        }
        slot.cleanup = null
      }
    }
  }
  root.unmounted = true
  roots.delete(root)
}

// ------------------------------------------------------------------ 树的遍历 / 序列化

const isNode = (value) => value !== null && typeof value === 'object' && 'type' in value

const childArray = (children) => (Array.isArray(children) ? children.flat(Infinity) : [children])

/** 展开函数组件（本域的替身组件都是无 hook 的纯函数），逐节点访问 */
export const walk = (tree, visit) => {
  const stack = [tree]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined || node === false || node === true) {
      continue
    }
    if (Array.isArray(node)) {
      stack.push(...node.flat(Infinity).reverse())
      continue
    }
    if (!isNode(node)) {
      continue
    }
    visit(node)
    const { type, props } = node
    if (typeof type === 'function') {
      stack.push(type({ ...props }))
    } else {
      stack.push(...childArray(props.children).reverse())
    }
  }
}

const SKIP_PROPS = new Set(['children', 'key', 'ref', 'style'])

const attributeText = (name, value) => {
  if (typeof value === 'function' || value === null || value === undefined || value === false) {
    return ''
  }
  if (value === true) {
    return ` ${name}`
  }
  return ` ${name}="${String(value).replaceAll('"', '&quot;')}"`
}

/** 把树序列化成 HTML 字符串（用于「整段文案都在 / 某段文案不在」这类断言） */
export const toHtml = (tree) => {
  const renderNode = (node) => {
    if (node === null || node === undefined || node === false || node === true) {
      return ''
    }
    if (Array.isArray(node)) {
      return node.map(renderNode).join('')
    }
    if (!isNode(node)) {
      return String(node)
    }
    const { type, props } = node
    if (type === Fragment) {
      return renderNode(props.children)
    }
    if (typeof type === 'function') {
      return renderNode(type({ ...props }))
    }
    const attributes = Object.entries(props)
      .filter(([name]) => !SKIP_PROPS.has(name) && !name.startsWith('on'))
      .map(([name, value]) => attributeText(name, value))
      .join('')
    return `<${type}${attributes}>${renderNode(props.children)}</${type}>`
  }
  return renderNode(tree)
}

/** 纯文本（去标签），用于断言「界面上有没有这句话」 */
export const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) {
    return ''
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }
  if (!isNode(node)) {
    return String(node)
  }
  const { type, props } = node
  if (type === Fragment || typeof type === 'function') {
    return textOf(typeof type === 'function' ? type({ ...props }) : props.children)
  }
  return textOf(props.children)
}

/** 找到所有满足条件的节点（返回节点本身，含 props） */
export const findAll = (tree, predicate) => {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) {
      found.push(node)
    }
  })
  return found
}

export const byTestId = (tree, testId) =>
  findAll(tree, (node) => node.props['data-testid'] === testId)[0] ?? null
