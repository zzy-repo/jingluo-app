import { deleteAppAsset, loadAppAsset, saveAppAsset } from './db.js'

/** 聊天背景图固定使用的素材 key：全局一份，与会话无关。 */
export const CHAT_BACKGROUND_KEY = 'chat-background'

/**
 * 每会话自定义背景图的 key 前缀（本单）：`chat-background:session:<sessionId>`。
 *
 * 为什么不新建 store、也不升 DB 版本：`appAssets` 的 keyPath 就是 `key`（字符串主键），
 * 多一个前缀只是多几条记录，升级回调一个字都不用改 —— 老用户的全局图 `chat-background`
 * 原地不动，两条通路互不覆盖（`check:db-version` 因此也不该红）。
 */
export const SESSION_BACKGROUND_KEY_PREFIX = 'chat-background:session:'

/** 会话 id → 该会话自定义背景图的素材 key */
export const sessionBackgroundKey = (sessionId: string): string =>
  `${SESSION_BACKGROUND_KEY_PREFIX}${sessionId}`

/** 压缩参数：最长边 ≤1600px、JPEG 0.85，避免 4K 原图常驻内存。 */
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void }

/** 解码图片：优先 createImageBitmap，失败时回退 <img>（部分格式/旧内核不支持前者）。 */
const decodeImage = async (file: File): Promise<Decoded> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // 交给 <img> 再试一次
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('image decode failed'))
      element.src = url
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      // <img> 已解码完成，URL 可以立即释放
      release: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

/** 用 canvas 压缩：最长边 ≤1600px，统一转 JPEG 0.85；动图只保留首帧。 */
export const compressChatBackground = async (file: File): Promise<Blob> => {
  const decoded = await decodeImage(file)
  try {
    if (!decoded.width || !decoded.height) {
      throw new Error('image has no intrinsic size')
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(decoded.width * scale))
    canvas.height = Math.max(1, Math.round(decoded.height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('canvas 2d context unavailable')
    }
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    })
    if (!blob) {
      throw new Error('canvas encode failed')
    }
    return blob
  } finally {
    decoded.release()
  }
}

/** 读取已保存的背景图原件；未设置时返回 null。 */
export const readChatBackground = async (): Promise<Blob | null> =>
  (await loadAppAsset(CHAT_BACKGROUND_KEY))?.blob ?? null

/** 压缩后写入 IndexedDB，返回压缩结果供界面立即生效。 */
export const writeChatBackground = async (file: File): Promise<Blob> => {
  const blob = await compressChatBackground(file)
  await saveAppAsset(CHAT_BACKGROUND_KEY, blob)
  return blob
}

export const clearChatBackground = async (): Promise<void> => {
  await deleteAppAsset(CHAT_BACKGROUND_KEY)
}

/**
 * 读取某条会话的自定义背景图原件；没设置过返回 null。
 *
 * 与全局那张（`readChatBackground`）是两条独立的 key，所以「给 A 会话换图」永远不会
 * 动到设置页的「默认背景」，反过来也一样。
 */
export const readSessionBackground = async (sessionId: string): Promise<Blob | null> =>
  (await loadAppAsset(sessionBackgroundKey(sessionId)))?.blob ?? null

/**
 * 写入**已经压缩好**的会话背景图。
 *
 * 为什么入参是 blob 而不是 File：背景设置页的流程是「上传 → 立刻出预览（草稿）→ 点保存才落库」，
 * 压缩必须在**上传那一步**就做完（预览要的是压缩后的同一张图，否则「预览看到的」和「存下来的」
 * 是两个画质）。压缩本身仍复用全局图那份实现 `compressChatBackground`（最长边 ≤1600px、JPEG 0.85），
 * 不给会话图另开一套参数 —— 两套参数意味着「同一张图设成默认背景和设成会话背景，体积差一倍」。
 */
export const saveSessionBackgroundAsset = async (sessionId: string, blob: Blob): Promise<void> => {
  await saveAppAsset(sessionBackgroundKey(sessionId), blob)
}

/** 删除该会话的自定义图（「恢复默认」清掉会话覆盖时一并调用）。 */
export const clearSessionBackground = async (sessionId: string): Promise<void> => {
  await deleteAppAsset(sessionBackgroundKey(sessionId))
}
