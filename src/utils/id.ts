import { hasApi } from './capabilities.js'

export const createId = () =>
  hasApi('crypto.randomUUID')
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
