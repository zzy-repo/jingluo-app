/** Public download metadata only. Never import diagnostics transport or publisher credentials. */
export const RELEASE_ORIGIN = 'https://dl.rose7.cn'
export const MANIFEST_URL = `${RELEASE_ORIGIN}/releases.json`
export const MAX_APK_BYTES = 50 * 1024 * 1024
export type ArtifactVariant = 'internal' | 'standard'
export type UpdateChannel = 'stable' | 'prerelease'
export interface UpdateRelease {
  version: string
  versionCode: number
  changes: string[]
  size: number
  file: string
  buildType?: UpdateChannel
  artifactVariant?: ArtifactVariant
  sha256?: string
}
export interface UpdateSelection {
  release?: UpdateRelease
  incomplete: number
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only serve APKs from the public download origin; no credentials, query or arbitrary redirects. */
export const releaseUrl = (file: string): string => {
  if (!/^apk\/[a-zA-Z0-9._-]+\.apk$/.test(file)) {
    throw new Error('INVALID_APK_URL')
  }
  const url = new URL(file, `${RELEASE_ORIGIN}/`)
  if (
    url.origin !== RELEASE_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/apk\/[a-zA-Z0-9._-]+\.apk$/.test(url.pathname)
  ) {
    throw new Error('INVALID_APK_URL')
  }
  return url.href
}

/** Legacy rows remain readable, but absent variant/hash must never imply standard or trusted. */
export const parseManifest = (input: unknown): UpdateRelease[] => {
  if (!object(input) || !Array.isArray(input.releases) || input.releases.length > 2000) {
    throw new Error('INVALID_MANIFEST')
  }
  return input.releases.map((value): UpdateRelease => {
    if (
      !object(value) ||
      typeof value.version !== 'string' ||
      !value.version ||
      value.version.length > 100 ||
      !Number.isSafeInteger(value.versionCode) ||
      Number(value.versionCode) <= 0 ||
      !Number.isSafeInteger(value.size) ||
      Number(value.size) <= 0 ||
      Number(value.size) > MAX_APK_BYTES ||
      typeof value.file !== 'string' ||
      !Array.isArray(value.changes) ||
      value.changes.length > 200 ||
      !value.changes.every((line) => typeof line === 'string' && line.length <= 2000) ||
      (value.buildType !== undefined &&
        value.buildType !== 'stable' &&
        value.buildType !== 'prerelease')
    ) {
      throw new Error('INVALID_RELEASE')
    }
    releaseUrl(value.file)
    return {
      version: value.version,
      versionCode: Number(value.versionCode),
      size: Number(value.size),
      file: value.file,
      changes: value.changes as string[],
      buildType: value.buildType as UpdateChannel | undefined,
      artifactVariant:
        value.artifactVariant === 'internal' || value.artifactVariant === 'standard'
          ? value.artifactVariant
          : undefined,
      sha256:
        typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
          ? value.sha256
          : undefined,
    }
  })
}

export const selectUpdate = (
  releases: UpdateRelease[],
  currentCode: number,
  variant: ArtifactVariant,
  channel: UpdateChannel
): UpdateSelection => {
  if (!Number.isSafeInteger(currentCode) || currentCode <= 0) {
    throw new Error('INVALID_CURRENT_VERSION')
  }
  const candidates = releases.filter(
    (row) =>
      row.versionCode > currentCode &&
      (row.buildType === undefined || channel === 'prerelease' || row.buildType === 'stable')
  )
  const eligible = candidates.filter(
    (row) => row.artifactVariant === variant && row.sha256 && row.buildType
  )
  const sorted = eligible.toSorted((a, b) => b.versionCode - a.versionCode)
  // Duplicate code for the same variant/channel is ambiguous; do not pick an arbitrary file.
  if (sorted.length > 1 && sorted[0].versionCode === sorted[1].versionCode) {
    throw new Error('AMBIGUOUS_RELEASE')
  }
  return {
    release: sorted[0],
    incomplete: candidates.filter(
      (row) =>
        row.artifactVariant === undefined ||
        (row.artifactVariant === variant && (!row.sha256 || !row.buildType))
    ).length,
  }
}

export const loadManifest = async (
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<UpdateRelease[]> => {
  const response = await request(MANIFEST_URL, {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error('MANIFEST_NETWORK')
  }
  const body = await response.text()
  if (body.length > 2 * 1024 * 1024) {
    throw new Error('MANIFEST_TOO_LARGE')
  }
  return parseManifest(JSON.parse(body))
}
