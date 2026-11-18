import { getSnapshot } from './collector.js'
import type { FeedbackCategory, FeedbackErrorCode, LogSnapshot } from './types.js'

export type SaveFeedbackText = (file: {
  filename: string
  mimeType: string
  text: string
}) => Promise<'saved' | 'cancelled'>

/** Saving and delivery are independent. No upload, clear or logging of file contents. */
export const saveFeedbackExport = async (
  fallback: LogSnapshot,
  context: ExportContext,
  save: SaveFeedbackText,
  read?: () => LogSnapshot
) => {
  try {
    const file = prepareFeedbackExport(fallback, context, read)
    const result = await save(file)
    return {
      status: result,
      filename: file.filename,
      truncated: file.truncated,
      snapshotReadFailed: file.snapshotReadFailed,
    }
  } catch {
    return { status: 'failed' as const }
  }
}

/** Separate from the 180 KiB upload budget: export keeps the collector snapshot. */
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024
const bytes = (text: string): number => {
  // Legacy WebViews without TextEncoder still support the JSON/native path.
  let count = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return count
}
const PRIVATE_KEY =
  /(?:api.?key|token|secret|password|authorization|cookie|signature|contact|description|prompt|content|messages?|body(?!Bytes)|payment|receipt|transaction|order|card|invoice)/i
const SAFE_META =
  /^(?:error\.(?:msg|name|stack)|http\.status|url\.(?:host|path)|req\.bodyBytes|stage|reason|durationMs|requestId|method|bytes|native|onLine|effectiveType|downlink|rtt|saveData|netType|version|versionCode|buildType|platform|device|sessions|files|provider|model|view|configured|storageBytes|action|target|role|trigger|visible|match|delayMs|stale|threshold|transport|logs|logSize|line)$/

/** Export is a second privacy boundary, including older persisted records. */
export const redactExportText = (text: string): string =>
  text
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value)
        return `${url.protocol}//${url.hostname}${url.pathname}`
      } catch {
        return '[URL]'
      }
    })
    .replace(/([?&])[^\s<>"']+/g, '$1[QUERY_REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[API_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[TOKEN]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|signature|accesskeyid|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')

const diagnosticText = (text: string): string => {
  // Arbitrary serialized payloads can contain conversation/payment bodies.
  if (
    /(?:["']?(?:messages|prompt|content|payment|receipt|card_number|transaction)["']?\s*[:=])/i.test(
      text
    )
  ) {
    return '[Private payload omitted]'
  }
  return redactExportText(text)
}

export type ExportContext = {
  category: FeedbackCategory
  failure?: { code: FeedbackErrorCode; at: number }
}

export const buildFeedbackExport = (
  snapshot: LogSnapshot,
  context: ExportContext,
  options: {
    now?: Date
    maxBytes?: number
    snapshotReadFailed?: boolean
  } = {}
) => {
  const now = options.now ?? new Date()
  const maxBytes = Math.min(MAX_EXPORT_BYTES, Math.max(4096, options.maxBytes ?? MAX_EXPORT_BYTES))
  const logs = snapshot.logs.map((entry) => ({
    t: entry.t,
    kind: entry.kind,
    level: entry.level,
    msg:
      entry.meta?.stage === 'console' ? '[Console free text omitted]' : diagnosticText(entry.msg),
    ...(entry.meta
      ? {
          meta: Object.fromEntries(
            Object.entries(entry.meta)
              .filter(
                ([key]) =>
                  SAFE_META.test(key) &&
                  !PRIVATE_KEY.test(key) &&
                  !(entry.meta?.stage === 'console' && key.startsWith('error.'))
              )
              .map(([key, value]) => [
                key,
                typeof value === 'string' ? diagnosticText(value) : value,
              ])
          ),
        }
      : {}),
  }))
  const data = {
    format: 'deepseek-feedback-diagnostics',
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    delivery: 'local-only-not-submitted',
    privacy: 'Description, contact, screenshots, client IDs, chat and payment payloads excluded.',
    app: {
      version: redactExportText(snapshot.app.version),
      versionCode: snapshot.app.versionCode,
      platform: redactExportText(snapshot.app.platform),
      buildType: redactExportText(snapshot.app.buildType),
    },
    device: Object.fromEntries(
      [
        'model',
        'androidVersion',
        'webviewVersion',
        'screen',
        'locale',
        'pixelRatio',
        'hardwareConcurrency',
        'deviceMemory',
        'system',
      ]
        .filter((key) => key in snapshot.device)
        .map((key) => {
          const value = snapshot.device[key as keyof typeof snapshot.device]
          return [key, typeof value === 'string' ? diagnosticText(value) : value]
        })
    ),
    category: context.category,
    lastSubmissionFailure: context.failure ?? null,
    snapshotReadFailed: options.snapshotReadFailed ?? false,
    limits: { maxBytes, originalLogCount: logs.length, omittedLogCount: 0, truncated: false },
    logs,
  }
  let text = JSON.stringify(data, null, 2)
  while (bytes(text) > maxBytes && data.logs.length > 0) {
    data.logs.shift()
    data.limits.omittedLogCount += 1
    data.limits.truncated = true
    text = JSON.stringify(data, null, 2)
  }
  if (bytes(text) > maxBytes) {
    throw new Error('Diagnostic metadata exceeds export limit')
  }
  const version = snapshot.app.version.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  return {
    filename: `deepseek-feedback-${now.toISOString().replace(/[:.]/g, '-')}-v${version}.json`,
    mimeType: 'application/json',
    text,
    truncated: data.limits.truncated,
    snapshotReadFailed: data.snapshotReadFailed,
  }
}

/** Failed snapshot reads preserve the last visible snapshot; never clear the collector. */
export const prepareFeedbackExport = (
  fallback: LogSnapshot,
  context: ExportContext,
  read: () => LogSnapshot = getSnapshot
) => {
  let snapshot = fallback
  let snapshotReadFailed = false
  try {
    snapshot = read()
  } catch {
    snapshotReadFailed = true
  }
  return buildFeedbackExport(snapshot, context, { snapshotReadFailed })
}
