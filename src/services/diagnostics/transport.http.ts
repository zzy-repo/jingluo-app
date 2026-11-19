import { Capacitor, CapacitorHttp } from '@capacitor/core'
import {
  CLIENT_TOKEN,
  FEEDBACK_PATH,
  MAX_PAYLOAD_BYTES,
  REQUEST_TIMEOUT_MS,
  SCREENSHOT_MAX_EDGE,
  SCREENSHOT_QUALITY,
} from './config.js'
import {
  describeFeedbackError,
  payloadBytes,
  statusToErrorCode,
  toFeedbackErrorCode,
} from './shared.js'
import type { FeedbackPayload, FeedbackTransport, FeedbackTransportResult } from './types.js'

// 兼容旧引用：描述 / 收敛错误码的实现在 shared.ts，这里原样转发
export { describeFeedbackError, payloadBytes, toFeedbackErrorCode }

/**
 * 上传层：只负责「怎么发」。
 *
 * 本文件**不 import collector**：进来什么 payload 就发什么，不认识环形缓冲、不读日志。
 * 想换上传方案（换域名 / 换云函数 / 换成原生插件）时，新写一个 transport.xxx.ts 实现
 * FeedbackTransport，再在 index.ts 里换一下默认实例即可，采集层一行都不用改。
 */

/**
 * v1 契约实现（POST {BASE}/api/v1/feedback）：**待后端按 v1 扩展后切回这一套**。
 * 由 index.ts 的默认 transport 决定用谁（当前默认是 transport.legacy.ts）。
 */
const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = src
  })

/** 压缩截图：最长边缩到 1280、JPEG 质量 0.8；本来就是小图时也会重新编码一次 */
export const compressScreenshot = async (
  dataUrl: string,
  maxEdge = SCREENSHOT_MAX_EDGE,
  quality = SCREENSHOT_QUALITY
): Promise<string> => {
  const image = await loadImage(dataUrl)
  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    return dataUrl
  }
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

/** 从相册选到的文件转成 data URL（UI 选图后调用，压缩后再放进表单） */
export const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })

/** UI 用：选图 → data URL → 压缩（失败时退回原图，不阻塞提交流程） */
export const prepareScreenshot = async (file: File): Promise<string> => {
  const dataUrl = await readFileAsDataUrl(file)
  try {
    return await compressScreenshot(dataUrl)
  } catch {
    return dataUrl
  }
}

/** 去掉截图字段（压缩失败 / 体积仍超时的兜底） */
const withoutScreenshot = (payload: FeedbackPayload): FeedbackPayload => ({
  schemaVersion: payload.schemaVersion,
  app: payload.app,
  device: payload.device,
  client: payload.client,
  feedback: payload.feedback,
  logs: payload.logs,
})

/**
 * 体积控制：整体 ≤2MB。超了先压截图（1280 / 0.8），再超就从最旧的日志开始裁剪。
 * 纯函数式的「输入 payload → 输出能发出去的 payload」，方便单测直接断言。
 */
export const fitPayload = async (payload: FeedbackPayload): Promise<FeedbackPayload> => {
  if (payloadBytes(payload) <= MAX_PAYLOAD_BYTES) {
    return payload
  }
  let fitted: FeedbackPayload = payload
  if (fitted.screenshot) {
    try {
      fitted = { ...fitted, screenshot: await compressScreenshot(fitted.screenshot) }
    } catch {
      // 图片解不开就直接丢掉截图，日志比截图重要
      fitted = withoutScreenshot(fitted)
    }
  }
  if (payloadBytes(fitted) <= MAX_PAYLOAD_BYTES) {
    return fitted
  }
  // 逐条从最旧的开始丢：先算出每条日志的字节数，边丢边减，避免反复全量序列化
  const sizes = fitted.logs.map((entry) => payloadBytes(entry) + 1)
  let total = payloadBytes(fitted)
  let drop = 0
  while (drop < fitted.logs.length && total > MAX_PAYLOAD_BYTES) {
    total -= sizes[drop]
    drop += 1
  }
  fitted = { ...fitted, logs: fitted.logs.slice(drop) }
  if (payloadBytes(fitted) <= MAX_PAYLOAD_BYTES) {
    return fitted
  }
  // 日志全丢光仍超：只剩截图了，丢掉它保证能发出去
  return withoutScreenshot(fitted)
}

const baseHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  'X-Client-Token': CLIENT_TOKEN,
})

/** 后端错误体 `{ ok:false, error:{ code, message } }` 里取可读详情 */
const readErrorDetail = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const error = (body as { error?: unknown }).error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) {
      return message
    }
  }
  return undefined
}

/** 200 + `{ ok:true, id }` 才算成功 */
const readSuccess = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const record = body as { ok?: unknown; id?: unknown }
  return record.ok === true && typeof record.id === 'string' && record.id ? record.id : null
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 默认实现：POST {BASE}/api/v1/feedback。
 * - 原生（Capacitor）用 CapacitorHttp.post，网页用 fetch；
 * - 超时 15 秒、不重试；
 * - 失败一律收敛成 FeedbackErrorCode，交给 UI 显示可读提示。
 */
export class HttpTransport implements FeedbackTransport {
  readonly name = 'http'

  /**
   * v1 契约的 base url（`POST {base}/api/v1/feedback`）**由调用方显式给出**。
   *
   * 旧版本这里吃一个 `FEEDBACK_BASE_URL` 常量，值是未替换的占位域名（已下线）。#274 删掉了那个
   * 常量：不留一个「能 import、一用就打空主机」的东西。要切回这条通道，就传真实 base。
   */
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  /** v1 契约的完整地址：base url 去尾斜杠 + FEEDBACK_PATH */
  private url(): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${FEEDBACK_PATH}`
  }

  async send(payload: FeedbackPayload): Promise<FeedbackTransportResult> {
    let body: FeedbackPayload
    try {
      body = await fitPayload(payload)
    } catch {
      body = payload
    }
    if (payloadBytes(body) > MAX_PAYLOAD_BYTES) {
      return { ok: false, error: 'too_large' }
    }
    const json = JSON.stringify(body)
    return Capacitor.isNativePlatform() ? this.sendNative(json) : this.sendWeb(json)
  }

  private async sendWeb(json: string): Promise<FeedbackTransportResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(this.url(), {
        method: 'POST',
        headers: baseHeaders(),
        body: json,
        signal: controller.signal,
      })
      const text = await response.text().catch(() => '')
      const parsed = parseJson(text)
      if (response.ok) {
        const id = readSuccess(parsed)
        return id ? { ok: true, id } : { ok: false, error: 'server', detail: text.slice(0, 200) }
      }
      return {
        ok: false,
        error: statusToErrorCode(response.status),
        detail: readErrorDetail(parsed) ?? text.slice(0, 200),
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      return {
        ok: false,
        error: aborted ? 'timeout' : 'network',
        detail: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async sendNative(json: string): Promise<FeedbackTransportResult> {
    try {
      // CapacitorHttp 不支持 abort：用 connect/read 超时限制总时长（不重试）
      const response = await CapacitorHttp.post({
        url: this.url(),
        headers: baseHeaders(),
        data: JSON.parse(json) as unknown,
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
      })
      const status = typeof response.status === 'number' ? response.status : 0
      const parsed = typeof response.data === 'string' ? parseJson(response.data) : response.data
      if (status >= 200 && status < 300) {
        const id = readSuccess(parsed)
        return id ? { ok: true, id } : { ok: false, error: 'server' }
      }
      return {
        ok: false,
        error: status === 0 ? 'network' : statusToErrorCode(status),
        detail: readErrorDetail(parsed),
      }
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
