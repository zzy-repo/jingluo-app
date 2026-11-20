import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  DEFAULT_RELEASE_BASE,
  downloadTarget,
  type ArtifactVariant,
  type UpdateRelease,
} from './updateManifest.js'
export interface InstalledApp {
  version: string
  versionCode: number
  artifactVariant?: ArtifactVariant | 'unknown'
}
export interface DownloadProgress {
  id: string
  received: number
  total: number
}
export interface UpdateBridge {
  installed(): Promise<InstalledApp>
  /** base 是原生侧真正拿到清单的分发机（新机 HTTP 优先，失败回退旧机 HTTPS）。 */
  manifest(): Promise<{ body: string; base?: string }>
  download(options: {
    id: string
    url: string
    /** 白名单请求头（#639）：只有内测包带令牌头，公网下载不带任何头（头的名字只在 updateManifest.ts 里出现） */
    headers?: Record<string, string>
    sha256: string
    size: number
    versionCode: number
  }): Promise<{ cached: boolean }>
  cancel(options: { id: string }): Promise<void>
  install(options: {
    sha256: string
    size: number
    versionCode: number
  }): Promise<{ status: 'permission-required' | 'installer-opened' }>
  addListener(
    name: 'downloadProgress',
    listener: (event: DownloadProgress) => void
  ): Promise<PluginListenerHandle>
}
export const nativeUpdate = registerPlugin<UpdateBridge>('AppUpdate')
export const isAndroidUpdate = () => Capacitor.getPlatform() === 'android'
export const currentVariant = (): ArtifactVariant =>
  typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__ ? 'internal' : 'standard'
export const bundledApp = (): InstalledApp => ({
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  versionCode: typeof __APP_VERSION_CODE__ !== 'undefined' ? __APP_VERSION_CODE__ : 0,
})

/** Injectable bridge: cancelled/stale events never update another download's UI. */
export const downloadUpdate = async (
  release: UpdateRelease,
  signal: AbortSignal,
  progress: (event: DownloadProgress) => void,
  bridge: UpdateBridge = nativeUpdate,
  base: string = DEFAULT_RELEASE_BASE
): Promise<{ cached: boolean }> => {
  if (!release.sha256 || !release.artifactVariant) {
    throw new Error('INCOMPLETE_RELEASE')
  }
  if (signal.aborted) {
    throw new DOMException('Cancelled', 'AbortError')
  }
  const id = crypto.randomUUID()
  const listener = await bridge.addListener('downloadProgress', (event) => {
    if (!signal.aborted && event.id === id) {
      progress(event)
    }
  })
  const cancel = () => {
    void bridge.cancel({ id }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError')
    }
    // 目标地址与请求头由 `downloadTarget` 一处决定（#639）：公网条目拼在「清单实际生效」的
    // base 上（回退后不会拿错域名导致 404）；私有条目改走带令牌的私有下载端点。
    const target = downloadTarget(release, base)
    const result = await bridge.download({
      id,
      url: target.url,
      ...(target.headers ? { headers: target.headers } : {}),
      sha256: release.sha256,
      size: release.size,
      versionCode: release.versionCode,
    })
    if (signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError')
    }
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
    await listener.remove()
  }
}
