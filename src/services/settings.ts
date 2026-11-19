import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/**
 * 快速 / 专家模式。**不是纯样式**：它是「本轮请求的思考档位」的唯一入口，
 * 由 services/chat/store.ts 的 createReply 读进 AssistantMessage.thinking，
 * 最终落到请求体的 thinking.type（disabled / enabled）—— 见 issue #25。
 */
export type ChatMode = 'fast' | 'expert'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 思考过程（reasoning / think 内容）的显示方式，与「深度思考」开关是两件事：
 * 那个开关决定要不要思考，这里决定思考内容怎么呈现。
 * - collapsed：只留一行「已思考（用时 N 秒）」，点开才渲染正文（默认）
 * - expanded：默认展开（旧的观感）
 * - hidden：思考内容完全不渲染，也不占位
 */
export type ThinkingDisplay = 'collapsed' | 'expanded' | 'hidden'

/**
 * 消息区阅读设置（issue #102）：字号 / 字重 / 行高各三到四档。
 * 档位值只是「选了什么」，具体像素落在 src/styles/reading.css 的 token 上；
 * 默认档（standard / regular / standard）等于仓库改造前的固定字号字重行高。
 */
export type ReadingFontSize = 'small' | 'standard' | 'large' | 'xlarge'
export type ReadingFontWeight = 'regular' | 'medium' | 'bold'
export type ReadingLineHeight = 'compact' | 'standard' | 'relaxed'

/**
 * 回车键行为（issue #108）。默认 enter-send = 改造前写死的行为，老用户升级后手感不变：
 * - enter-send：回车发送，Shift+回车换行
 * - modifier-send：回车换行，Ctrl/Cmd+回车发送
 * - button-only：回车只换行，必须点发送按钮
 * 判定逻辑在 components/chatInput/enterKey.ts（纯函数），这里只负责「选了哪一档」。
 */
export type EnterKeyMode = 'enter-send' | 'modifier-send' | 'button-only'

/**
 * 本机设置，存 localStorage：语言、主题、位置、朗读音色、快速/专家模式（= 深度思考档位）、
 * 思考过程显示方式、智能搜索开关、侧边栏收起状态。
 * API Key 不再单独存放，改由 providers.ts 的模型服务配置管理（旧 chat-demo:api-key 仅用于迁移）。
 */
type Settings = {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  chatMode: ChatMode
  /** 深度思考开关的镜像值，恒等于 chatMode === 'expert'；留着是为了不改读它的旧代码 */
  thinking: boolean
  thinkingDisplay: ThinkingDisplay
  readingFontSize: ReadingFontSize
  readingFontWeight: ReadingFontWeight
  readingLineHeight: ReadingLineHeight
  enterKeyMode: EnterKeyMode
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  chatMode: 'chat-demo:chat-mode',
  thinking: 'chat-demo:thinking',
  thinkingDisplay: 'chat-demo:thinking-display',
  readingFontSize: 'chat-demo:reading-font-size',
  readingFontWeight: 'chat-demo:reading-font-weight',
  readingLineHeight: 'chat-demo:reading-line-height',
  enterKeyMode: 'chat-demo:enter-key-mode',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 思考过程默认折叠；脏值回落折叠，不把非法值渲染出去 */
const initialThinkingDisplay = (): ThinkingDisplay => {
  const saved = read(KEYS.thinkingDisplay)
  return saved === 'expanded' || saved === 'hidden' || saved === 'collapsed' ? saved : 'collapsed'
}

/** 阅读设置默认档 = 改造前的现状（16px / 常规 / 标准行距）；脏值回落默认档 */
const initialReadingFontSize = (): ReadingFontSize => {
  const saved = read(KEYS.readingFontSize)
  return saved === 'small' || saved === 'large' || saved === 'xlarge' || saved === 'standard'
    ? saved
    : 'standard'
}

const initialReadingFontWeight = (): ReadingFontWeight => {
  const saved = read(KEYS.readingFontWeight)
  return saved === 'medium' || saved === 'bold' || saved === 'regular' ? saved : 'regular'
}

const initialReadingLineHeight = (): ReadingLineHeight => {
  const saved = read(KEYS.readingLineHeight)
  return saved === 'compact' || saved === 'relaxed' || saved === 'standard' ? saved : 'standard'
}

/** 回车键行为默认「回车发送」= 改造前的写死行为；脏值回落默认档，不让非法值影响手感 */
const initialEnterKeyMode = (): EnterKeyMode => {
  const saved = read(KEYS.enterKeyMode)
  return saved === 'enter-send' || saved === 'modifier-send' || saved === 'button-only'
    ? saved
    : 'enter-send'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过模式时按旧的「深度思考」键迁移：开着的用户继续算专家模式 */
const initialChatMode = (): ChatMode => {
  const saved = read(KEYS.chatMode)
  if (saved === 'fast' || saved === 'expert') {
    return saved
  }
  return read(KEYS.thinking) === 'true' ? 'expert' : 'fast'
}

export const useSettings = create<Settings>(() => {
  const chatMode = initialChatMode()
  return {
    locale: initialLocale(),
    location: initialLocation(),
    themePreference: initialThemePreference(),
    ttsVoice: initialTtsVoice(),
    chatMode,
    thinking: chatMode === 'expert',
    thinkingDisplay: initialThinkingDisplay(),
    readingFontSize: initialReadingFontSize(),
    readingFontWeight: initialReadingFontWeight(),
    readingLineHeight: initialReadingLineHeight(),
    enterKeyMode: initialEnterKeyMode(),
    search: read(KEYS.search) === 'true',
    siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  }
})

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

/**
 * 切换快速 / 专家模式（唯一写入口）。新模式落 localStorage，刷新、切会话都不丢；
 * 旧键 chat-demo:thinking 一起同步，读 thinking 的旧代码（输入行开关、回复快照）行为不变。
 */
export const setChatMode = (chatMode: ChatMode) => {
  const thinking = chatMode === 'expert'
  write(KEYS.chatMode, chatMode)
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ chatMode, thinking })
}

/** 输入行的「深度思考」开关与模式是同一件事，点它等于切模式 */
export const setThinking = (thinking: boolean) => setChatMode(thinking ? 'expert' : 'fast')

export const setThinkingDisplay = (thinkingDisplay: ThinkingDisplay) => {
  write(KEYS.thinkingDisplay, thinkingDisplay)
  useSettings.setState({ thinkingDisplay })
}

export const setReadingFontSize = (readingFontSize: ReadingFontSize) => {
  write(KEYS.readingFontSize, readingFontSize)
  useSettings.setState({ readingFontSize })
}

export const setReadingFontWeight = (readingFontWeight: ReadingFontWeight) => {
  write(KEYS.readingFontWeight, readingFontWeight)
  useSettings.setState({ readingFontWeight })
}

export const setReadingLineHeight = (readingLineHeight: ReadingLineHeight) => {
  write(KEYS.readingLineHeight, readingLineHeight)
  useSettings.setState({ readingLineHeight })
}

/** 回车键行为的唯一写入口：切换后立即生效（输入框订阅同一个 store），并落 localStorage */
export const setEnterKeyMode = (enterKeyMode: EnterKeyMode) => {
  write(KEYS.enterKeyMode, enterKeyMode)
  useSettings.setState({ enterKeyMode })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
