import { LIMITS } from '../limits.js'

export type ErrorBodyReadReason = 'complete' | 'timeout' | 'size_limit' | 'read_error'

export type ErrorBodyReadResult = {
  text: string
  reason: ErrorBodyReadReason
  receivedBytes: number
  retainedBytes: number
}

const abortReason = (signal?: AbortSignal | null): unknown =>
  signal?.reason ?? new DOMException('Aborted', 'AbortError')

/** Error responses have a total deadline, independent of how often bytes arrive. */
export const readErrorBody = async (
  response: Response,
  {
    signal,
    maxBytes = LIMITS.errorBody.maxBytes,
  }: { signal?: AbortSignal | null; maxBytes?: number } = {}
): Promise<ErrorBodyReadResult> => {
  if (signal?.aborted) {
    throw abortReason(signal)
  }
  if (!response.body) {
    return { text: '', reason: 'complete', receivedBytes: 0, retainedBytes: 0 }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const timeoutMs = LIMITS.requestTimeouts.errorBodyMs
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort?.(abortReason(signal))
  signal?.addEventListener('abort', onAbort, { once: true })

  let text = ''
  let receivedBytes = 0
  let retainedBytes = 0
  let reason: ErrorBodyReadReason = 'read_error'
  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortReason(signal)
      }
      if (Date.now() >= deadline) {
        reason = 'timeout'
        break
      }
      const result = await Promise.race([reader.read(), expired, aborted])
      if (signal?.aborted) {
        throw abortReason(signal)
      }
      if (result === null) {
        reason = 'timeout'
        break
      }
      if (result.done) {
        reason = 'complete'
        text += decoder.decode()
        break
      }
      receivedBytes += result.value.byteLength
      const remaining = maxBytes - retainedBytes
      const part = result.value.subarray(0, remaining)
      retainedBytes += part.byteLength
      text += decoder.decode(part, { stream: true })
      if (retainedBytes >= maxBytes) {
        reason = 'size_limit'
        break
      }
    }
  } catch {
    if (signal?.aborted) {
      throw abortReason(signal)
    }
    reason = 'read_error'
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // Cancellation must not hold up error reporting, even if the source never settles it.
    if (reason !== 'complete') {
      void reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
  // At a byte boundary the decoder may hold an incomplete UTF-8 character. Discard it.
  return { text, reason, receivedBytes, retainedBytes }
}
