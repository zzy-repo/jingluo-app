import { Capacitor } from '@capacitor/core'
import { useSearchPanel } from '../search/searchPanelState.js'
import { closeMobileSider, openMobileSider, useMobileSider } from './mobileSiderState.js'

const MIN_SWIPE = 56
const DIRECTION_RATIO = 1.5
const controls =
  'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"]'

function hasForegroundInteraction() {
  return (
    useSearchPanel.getState().entry !== null ||
    document.querySelector('[role="dialog"], [role="menu"]') !== null ||
    window.getSelection()?.isCollapsed === false
  )
}

function canStart(target: Element, open: boolean) {
  const surface = target.closest('main, [data-sider-swipe="close"]')
  if (!surface || surface.hasAttribute('data-sider-swipe') !== open || target.closest(controls))
    return false
  for (let el: Element | null = target; el && el !== surface; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX))
      return false
  }
  return !hasForegroundInteraction()
}

/** Touch events let vertical scroll and pinch keep their native behaviour, even in nested scrollers. */
export function bindAndroidSiderSwipe(frame: HTMLElement) {
  if (Capacitor.getPlatform() !== 'android') return
  let start: { id: number; x: number; y: number; open: boolean } | null = null
  const cancel = () => {
    start = null
  }
  const down = (event: TouchEvent) => {
    cancel()
    const open = useMobileSider.getState().open
    if (
      event.touches.length !== 1 ||
      !(event.target instanceof Element) ||
      !frame.contains(event.target) ||
      !canStart(event.target, open)
    )
      return
    const touch = event.touches[0]
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, open }
  }
  const move = (event: TouchEvent) => {
    if (!start) return
    const touch = event.touches[0]
    if (event.touches.length !== 1 || touch.identifier !== start.id) return cancel()
    const dx = Math.abs(touch.clientX - start.x)
    const dy = Math.abs(touch.clientY - start.y)
    if (dy >= 10 && dy >= dx) cancel()
  }
  const up = (event: TouchEvent) => {
    const origin = start
    cancel()
    if (
      !origin ||
      event.touches.length ||
      origin.open !== useMobileSider.getState().open ||
      hasForegroundInteraction()
    )
      return
    const touch = event.changedTouches[0]
    if (!touch || touch.identifier !== origin.id) return
    const distance = (touch.clientX - origin.x) * (origin.open ? -1 : 1)
    if (distance < MIN_SWIPE || distance < Math.abs(touch.clientY - origin.y) * DIRECTION_RATIO)
      return
    // A swipe starting on a history row must not also select that conversation.
    // Chromium may already have consumed the sequence in a scroll container.
    if (event.cancelable) event.preventDefault()
    if (origin.open) closeMobileSider()
    else openMobileSider()
  }
  // Watch all starts so a second finger outside the frame cancels the pending swipe.
  document.addEventListener('touchstart', down, { capture: true, passive: true })
  frame.addEventListener('touchmove', move, { passive: true })
  frame.addEventListener('touchend', up, { passive: false })
  frame.addEventListener('touchcancel', cancel)
  const unsubscribe = useMobileSider.subscribe(cancel)
  return () => {
    unsubscribe()
    document.removeEventListener('touchstart', down, true)
    frame.removeEventListener('touchmove', move)
    frame.removeEventListener('touchend', up)
    frame.removeEventListener('touchcancel', cancel)
  }
}
