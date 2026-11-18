/**
 * 构建变体（artifactVariant）判定 —— 纯函数，便于离线单测。
 *
 * 判定优先级（都不盲信客户端 meta）：
 *   1. APK 内 AndroidManifest 的 <meta-data> 标记  → source = "apk-manifest"
 *   2. 服务器侧 sha256 白名单（仅用于没有标记的历史包）→ source = "sha256-allowlist"
 *   3. 都没有 → variant = null（unknown），**绝不默认 standard**
 *
 * 关于「可信」的边界（写文档时不要夸大）：
 *   meta-data 标记受 APK 签名覆盖，改标记就必须重签名，所以它比客户端 meta 强得多；
 *   但 dl-release 目前**不核验签名证书指纹**，因此它仍然是「发布方声明」而非
 *   「已被服务端验证的发布方身份」。签名指纹核验是单独待办。
 */

export const VARIANTS = Object.freeze(['internal', 'standard']);

/** 默认标记名：以 applicationId 为前缀，便于和包名一眼对上 */
export const DEFAULT_MARKER = 'com.example.deepseekchat.ARTIFACT_VARIANT';

/**
 * 解析 `aapt2 dump xmltree <apk> --file AndroidManifest.xml` 的输出，
 * 找出标记名的 meta-data 取值。
 * 注意：`aapt2 dump badging` **不会**输出 meta-data（已实测），只能用 xmltree。
 *
 * @returns {{variant: 'internal'|'standard'|null, reason: string, raw?: string}}
 *   reason: marker | marker_out_of_enum | marker_not_string | marker_absent | xmltree_failed
 */
export function parseVariantFromXmltree(text, markerName = DEFAULT_MARKER) {
  if (typeof text !== 'string') return { variant: null, reason: 'xmltree_failed' };
  const lines = text.split('\n');
  let inNode = null;
  let attrs = {};
  let found = null;

  const flush = () => {
    if (inNode !== 'meta-data') return;
    if (attrs.name !== markerName) return;
    if (typeof attrs.value === 'string') {
      const v = attrs.value.trim();
      found = VARIANTS.includes(v)
        ? { variant: v, reason: 'marker', raw: v }
        : { variant: null, reason: 'marker_out_of_enum', raw: v };
    } else {
      // android:resource / int 等非字符串取值，一律判 unknown
      found = { variant: null, reason: 'marker_not_string' };
    }
  };

  for (const line of lines) {
    const t = line.trim();
    const node = /^E: ([A-Za-z0-9_.-]+)/.exec(t);
    if (node) {
      flush();
      inNode = node[1];
      attrs = {};
      continue;
    }
    const a = /^A: .*?:([A-Za-z0-9_]+)\(0x[0-9a-f]+\)=(?:"([^"]*)"|([^ ]+))/.exec(t);
    if (a && inNode) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
  }
  flush();
  return found || { variant: null, reason: 'marker_absent' };
}

/** 归一化服务器白名单条目：{variant, note, version} 或字符串变体名 */
export function normalizeAllowEntry(entry) {
  if (!entry) return null;
  const variant = typeof entry === 'string' ? entry : entry.variant;
  if (!VARIANTS.includes(variant)) return null;
  return {
    variant,
    note: (entry && entry.note) || '',
    version: (entry && entry.version) || '',
  };
}

/** 按优先级合成最终变体；标记与白名单冲突时返回 conflict（由调用方拒绝写入） */
export function resolveVariant(marker, allowEntry) {
  const markerVariant = (marker && marker.variant) || null;
  const allowVariant = allowEntry ? allowEntry.variant : null;
  if (markerVariant && allowVariant && markerVariant !== allowVariant) {
    return { conflict: true, markerVariant, allowVariant };
  }
  if (markerVariant) return { variant: markerVariant, source: 'apk-manifest' };
  if (allowVariant) return { variant: allowVariant, source: 'sha256-allowlist' };
  return {
    variant: null,
    source: null,
    reason: (marker && marker.reason) || 'marker_absent',
  };
}
