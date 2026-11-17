import { useSyncExternalStore } from 'react'
import { useSettings, type ThemePreference } from '../services/settings.js'

export type Theme = 'light' | 'dark'

const query = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeOsTheme = (listener: () => void) => {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (query.matches ? 'dark' : 'light')

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  return resolveTheme(preference, osTheme)
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

/**
 * 主题切换时给整个壳一次 180ms 的 opacity 淡入（只有 transform/opacity 里的 opacity，
 * 不改布局）。系统开启「减少动态效果」时由 motion.css 直接 animation: none。
 */
let themeFadeTimer: ReturnType<typeof setTimeout> | undefined
const playThemeFade = () => {
  const root = document.documentElement
  root.classList.remove('ds-theme-fade')
  // 读一次布局，保证同名动画能被重新触发（不参与动画的属性，不影响帧率）
  void root.offsetWidth
  root.classList.add('ds-theme-fade')
  clearTimeout(themeFadeTimer)
  themeFadeTimer = setTimeout(() => root.classList.remove('ds-theme-fade'), 240)
}

/** 同步页面主题、根画布背景和支持 theme-color 的浏览器栏。 */
const applyTheme = (theme: Theme, animate = true) => {
  const body = document.body
  // 主题切换帧禁用过渡，使页面颜色同步更新
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  // 首次背景色同步在样式表加载完成后执行，适配 WebKit 的 defer 脚本执行顺序。
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  // 强制本次样式重算立刻落地（颜色切换本就不该有补间），随后同帧摘掉抑制类。
  // 原来用 setTimeout(0) 摘除：主线程忙时这个 0ms 定时器会被拖到抽屉翻到「打开态」的那一帧，
  // 于是 `body.change-theme * { transition: none !important }` 把抽屉的过渡一起打死（一帧 0→100% 瞬跳）。
  void body.offsetHeight
  body.classList.remove('change-theme')
  // 首屏直接铺好，不做淡入；之后每次手动 / 系统切换才轻微淡入
  if (animate) {
    playThemeFade()
  }
}

let appliedTheme: Theme | null = null

const syncTheme = () => {
  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())
  if (theme !== appliedTheme) {
    const first = appliedTheme === null
    appliedTheme = theme
    applyTheme(theme, !first)
  }
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  query.addEventListener('change', syncTheme)
  useSettings.subscribe(syncTheme)
}
