// L1「身份层 + 四个面板」的**公共装配**（Issue #487 阶段③，本单：identity / consume panels）。
//
// 为什么单独一份：本单 6 个 L1 文件都做同一件事 —— 把 `.ts` 源码用裸 Node import 进来
// （`.js → .ts` 解析 hook + 浏览器全局 + 注入值），注入**假 transport / 假存储**，再
// `renderToStaticMarkup` 真视图。这 20 行装配逐字相同，抄 6 份就是 6 处会各自漂移的 loader 约定。
//
// 与 `helpers/dom-env.mjs` 的分工：那边是通用的 unit 装配（只管解析 hook / 全局 / 端点注入），
// 这里只补「面板与身份层一起用」的那几样：
//   · `translate()`  —— 用**真 zh 文案表**渲染，断言才能落在「用户看到的话」而不是 key 上；
//   · `ButtonStub`   —— 设计系统按钮的等价替身（`testId` → `data-testid`，其余透传）；
//   · `classNames`   —— CSS Module 的类名表替身（真机是 `panels.module.css`，单测不加载 CSS）；
//   · `markupOf()` / `textOf()` —— 渲染 + 取证（失败信息里给一句话，不灌整页 DOM）。
//
// **不新增目录、不碰 src/**：本文件只装配，不含任何产品逻辑。

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { installEndpointsGlobals, installTsResolve, setupDom } from './dom-env.mjs'

/**
 * 装好 L1 需要的一切（进程级，装一次即可）。
 *
 * 顺序有讲究：hook 必须在 `await import('../../src/…')` **之前**装好（静态 import 会被提升到
 * hook 之前求值），所以调用方一律写成 `await setupAuthPanels()`，再动态 import 被测源码。
 */
export const setupAuthPanels = async () => {
  installTsResolve()
  const dom = setupDom()
  // 面板与身份层都不在顶层读 `__ENDPOINTS__`（consume/http.ts 是懒读、可注入），
  // 这里仍然装一份 —— 万一有人顺手加了顶层读取，用例应当照常跑，而不是炸在 import 阶段。
  installEndpointsGlobals()
  const { zh } = await import('../../src/i18n/zh.ts')
  return { dom, zh, ...renderKit(zh) }
}

/** 与 `src/i18n/index.ts` 同一套占位符规则（`{seconds}` / `{amount}` / `{count}`…） */
const translateWith = (zh) => (key, params) => {
  const text = zh[key]
  if (typeof text !== 'string') {
    throw new Error(`文案表里没有键 ${String(key)}`)
  }
  return text.replace(/\{(\w+)\}/gu, (whole, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole
  })
}

const renderKit = (zh) => {
  /** 真文案：`t('sub2authCredentialInvalid')` → `账号或密码错误` */
  const translate = translateWith(zh)

  /** 设计系统 Button 的替身：只多认一个 `testId`（真机忽略它） */
  const ButtonStub = ({ testId, children, onClick, ...rest }) =>
    createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

  /** CSS Module 类名表：取什么给什么（断言不依赖类名，只为让真视图能渲染） */
  const classNames = new Proxy({}, { get: (_target, name) => String(name) })

  /** 渲染任意视图（视图函数直接返回 React 元素；`null` 也是合法输出 —— 邀请面板 `hidden` 就返回 null） */
  const markupOf = (element) => (element === null || element === undefined ? '' : renderToStaticMarkup(element))

  /** `data-testid` 是否存在（视图层的「这个块渲染没渲染」判据） */
  const hasTestId = (markup, testId) => markup.includes(`data-testid="${testId}"`)

  /**
   * 取某个 `data-testid` 块的纯文本（取证用：失败信息要一句话，不灌整页 DOM）。
   *
   * 截到**下一个 `data-testid`** 为止（同级区块的分界），所以嵌套结构
   * （`statRow` 里包着两个 `<span>`）也能拿到「标签 + 值」整行文本。
   */
  const textOf = (markup, testId) => {
    const marker = `data-testid="${testId}"`
    const at = markup.indexOf(marker)
    if (at < 0) {
      return ''
    }
    const rest = markup.slice(at + marker.length)
    const next = rest.indexOf('data-testid=')
    const chunk = next >= 0 ? rest.slice(0, next) : rest.slice(0, 400)
    return chunk.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
  }

  return { translate, ButtonStub, classNames, markupOf, hasTestId, textOf }
}

/**
 * 身份层三个口子的**内存替身**：凭据存储（安全存储）、transport（假后端）、以及 store 的重置。
 *
 * 为什么用替身而不是真 localStorage：`store.ts` 的硬约束就是「凭据存储可替换」（接原生 Keystore
 * 时只换这一个对象），所以单测直接注入一个内存实现 —— 既断言了「写进去了什么」，又证明
 * 「换存储不用改上层」这条接线是真的。
 */
export const createTokenStorage = () => {
  const state = { value: null, writes: [] }
  return {
    /** 最后一次落盘的原值（`null` = 被清掉） */
    get value() {
      return state.value
    },
    /** 全部写入序列：断言「清态」时要看最后一条是不是 null */
    get writes() {
      return state.writes
    },
    /** 解析后的落盘载荷（`{v, token, user}`），没写过就是 null */
    get parsed() {
      return state.value === null ? null : JSON.parse(state.value)
    },
    storage: {
      read: () => state.value,
      write: (value) => {
        state.writes.push(value)
        state.value = value
      },
    },
    /** 预置一份「上次启动留下的」凭据（模拟冷启动） */
    seed: (token, user = null) => {
      state.writes.length = 0
      state.value = JSON.stringify({ v: 1, token, user })
    },
    reset: () => {
      state.value = null
      state.writes.length = 0
    },
  }
}

/**
 * 假 transport：只记调用 + 按表应答。
 *
 * `replies.login` / `replies.refreshToken` / `replies.me` … 可以是 Promise / 值 / 函数（末态可编程），
 * 没给的通道返回「成功但没有意义的数据」，避免用例里为不关心的通道写样板。
 */
export const createFakeTransport = (replies = {}) => {
  const calls = { login: [], register: [], sendCode: [], refresh: [], refreshToken: [], me: 0, logout: 0 }
  const answer = async (name, input) => {
    const reply = replies[name]
    const value = typeof reply === 'function' ? await reply(input) : await reply
    return value === undefined ? { ok: true, data: undefined } : value
  }
  const transport = {
    login: async (input) => {
      calls.login.push(input)
      return answer('login', input)
    },
    register: async (input) => {
      calls.register.push(input)
      return answer('register', input)
    },
    sendCode: async (input) => {
      calls.sendCode.push(input)
      return answer('sendCode', input)
    },
    refresh: async (input) => {
      calls.refresh.push(input)
      return answer('refresh', input)
    },
    refreshToken: async (input) => {
      calls.refreshToken.push(input)
      return answer('refreshToken', input)
    },
    me: async () => {
      calls.me += 1
      return answer('me')
    },
    logout: async () => {
      calls.logout += 1
      return answer('logout')
    },
  }
  return { transport, calls }
}

/** 身份层 store 的重置（同一进程里多个文件/多行表格之间必须互不串味） */
export const resetAuthStore = (store) => {
  store.setState({
    state: 'unauthenticated',
    user: null,
    token: null,
    error: null,
    restored: false,
    submitting: false,
    sendingCode: false,
  })
}
