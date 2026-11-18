/** Pure model-list payload parsing shared by web and native transports. */
export const pickModelIds = (body: unknown): string[] => {
  const readIds = (list: unknown): string[] => {
    if (!Array.isArray(list)) return []
    return list.flatMap((item) => {
      if (typeof item === 'string') return [item]
      if (item && typeof item === 'object') {
        const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).model
        return typeof id === 'string' ? [id] : []
      }
      return []
    })
  }
  if (Array.isArray(body)) return readIds(body)
  if (body && typeof body === 'object') {
    for (const key of ['data', 'models', 'model_list', 'result']) {
      const ids = readIds((body as Record<string, unknown>)[key])
      if (ids.length) return ids
    }
  }
  return []
}

export const parseModelPayload = (payload: unknown): string[] => {
  if (typeof payload !== 'string') return pickModelIds(payload)
  try { return pickModelIds(JSON.parse(payload)) } catch { return [] }
}
