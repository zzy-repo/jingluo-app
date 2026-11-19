import { create } from 'zustand'

import { record } from '../diagnostics/collector.js'
import { getApiKey, getBaseUrl } from './apiConfig.js'

/**
 * 「这把 Key 已经被上游判失效」的状态（#303 的问题 3）。
 *
 * 现场形态：上游回 401 之后，客户端下一次打开设置页、下一次点「测试」照样再去 `GET {paths.models}`，
 * 于是同一把已失效的 Key 反复打上游，界面上却只留一句原始报错。这里只做一件事：
 * 把**已经被 401 判死的那把 Key（+ 那台 host）**记下来，让自动化请求（模型列表探测）停下来，
 * 并把「Key 无效或已过期，请重新登录/重新填写」变成界面上可读的提示。
 *
 * 为什么不加开关、不加定时器：本项目根本没有轮询 `/models` 的代码，重复请求来自
 * 「每次挂载设置页 / 每次点测试」的自动探测。所以停止条件只需要一条——**判死了就不再自动打**。
 *
 * 指纹 = host + Key 的短哈希：用户换 Key、换地址后指纹自然不同，状态自动失效，
 * 不需要谁去「清标记」，也就不会出现「换了 Key 还被拦住」的僵尸状态。
 */
type KeyRejection = {
  /** `host#shortHash` */
  fingerprint: string
  /** 触发判定的 HTTP 状态码（目前只有 401 会走到这里） */
  status: number
  /** 哪条链路先发现的：聊天请求 / 模型探测 / Key 校验 */
  stage: 'chat' | 'probe' | 'verify' | 'request'
  at: number
}

/** 短哈希：Key 不进日志、不进内存快照，只留能区分「换没换」的指纹 */
const shortHash = (value: string): string => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** 当前配置的指纹：Key 或地址一变，它就跟着变 */
export const keyFingerprint = (apiKey: string, baseUrl: string): string =>
  `${hostOf(baseUrl)}#${shortHash(apiKey)}`

const state = create<{ rejection: KeyRejection | null }>(() => ({ rejection: null }))

export const useKeyRejection = state

/** 记一次「上游明确说这把 Key 不行」。只有 401 会调到这里，其它状态码不改变状态 */
export const markKeyRejected = (stage: KeyRejection['stage'], status = 401): void => {
  const apiKey = getApiKey()
  const baseUrl = getBaseUrl()
  if (!apiKey) {
    return
  }
  const fingerprint = keyFingerprint(apiKey, baseUrl)
  const current = state.getState().rejection
  if (current?.fingerprint === fingerprint) {
    return
  }
  state.setState({ rejection: { fingerprint, status, stage, at: Date.now() } })
  // 诊断里必须数得出来：哪条链路、哪台 host、第几次判定（同一次失效只记一条，避免刷日志）
  record('error', 'error', 'api key rejected', {
    'http.status': status,
    stage,
    host: hostOf(baseUrl),
    'key.fingerprint': fingerprint,
  })
}

/** 用户重新填 Key / 换渠道时手动解除（指纹不同时本来就已经失效，这里给「重试」按钮用） */
export const clearKeyRejection = (): void => {
  if (state.getState().rejection !== null) {
    state.setState({ rejection: null })
  }
}

/** 当前配置是否处于「已被判失效」状态 */
export const isKeyRejected = (): boolean => {
  const { rejection } = state.getState()
  if (!rejection) {
    return false
  }
  const apiKey = getApiKey()
  if (!apiKey) {
    return false
  }
  return rejection.fingerprint === keyFingerprint(apiKey, getBaseUrl())
}

/**
 * 自动探测（模型列表）要不要发：Key 被判失效后就不再自动打上游。
 * 用户主动点「刷新 / 测试」不受限——那是明确的用户动作，也是他换 Key 之后验证自己的唯一手段。
 */
export const shouldAutoProbe = (): boolean => !isKeyRejected()
