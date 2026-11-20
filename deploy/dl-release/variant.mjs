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
 * 回环 consume 标记名（Issue #601 闸 2）：`android/app/build.gradle` 在
 * `-PallowLoopbackConsume=true` 且地址真是回环时写 `<meta-data …="true">`。
 * 上传接口读到 true 就 400 LOOPBACK_BUILD_REJECTED —— 打得出来，但传不上去。
 * 与 DEFAULT_MARKER 同样以 applicationId 为前缀（AGP 的 ${applicationId} 占位符生成）。
 */
export const DEFAULT_LOOPBACK_MARKER = 'com.example.deepseekchat.LOOPBACK_CONSUME';

/**
 * 解析 `aapt2 dump xmltree <apk> --file AndroidManifest.xml` 的输出，抽出**全部**
 * `<meta-data android:name=… android:value=…>`。
 *
 * 为什么要有它（Issue #607）：变体（ARTIFACT_VARIANT）与回环标记（LOOPBACK_CONSUME）读的是
 * 同一份 xmltree、同一批节点、同一条「值可能是 quoted string 也可能是 typed value」的坑。
 * 各写一遍的话，第二处迟早漏认一种编码（`android:value="false"` 被 aapt2 编成
 * `TYPE_INT_BOOLEAN` 时就没有 Raw，只剩 `=false`）—— 于是「回环包」被静默判成干净。
 *
 * 取值形状：`Map<name, {value: string|undefined, typed: boolean}>`
 *   · quoted string（`="standard"`，带 Raw）→ `{value:'standard', typed:false}`
 *   · typed value（`=false` / `=0` / `=@0x7f100001`，无 Raw）→ `{value:'false'|'0'|'@0x…', typed:true}`
 *   · 没有 android:value（只有 android:resource）→ `{value:undefined, typed:false}`
 * 同名多条按 aapt2 输出顺序**后者覆盖前者**（与变体判定原有的「最后一条算数」一致）。
 *
 * @param {string} text `aapt2 dump xmltree` 的 stdout
 * @param {string} [nodeName] 只收这种节点名（默认 `meta-data`）
 * @returns {Map<string, {value: string|undefined, typed: boolean}>}
 */
export function parseMetaDataFromXmltree(text, nodeName = 'meta-data') {
  const out = new Map();
  if (typeof text !== 'string') return out;
  let inNode = null;
  /** 当前节点已收集的属性：`name → {value, typed}` */
  let attrs = {};
  const flush = () => {
    if (inNode !== nodeName) return;
    const nameAttr = attrs.name;
    if (!nameAttr || typeof nameAttr.value !== 'string') return;
    const valueAttr = attrs.value;
    out.set(nameAttr.value, valueAttr
      ? { value: valueAttr.value, typed: valueAttr.typed }
      : { value: undefined, typed: false });
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    const node = /^E: ([A-Za-z0-9_.-]+)/.exec(t);
    if (node) {
      flush();
      inNode = node[1];
      attrs = {};
      continue;
    }
    const a = /^A: .*?:([A-Za-z0-9_]+)\(0x[0-9a-f]+\)=(?:"([^"]*)"|([^ ]+))/.exec(t);
    // 属性归属：aapt2 用缩进表达嵌套，这里只按「最近一个 E: 节点」归集 —— 对 meta-data
    // 这种叶子节点足够（它不会再有子节点），也让解析不必依赖缩进宽度。
    if (a && inNode) {
      attrs[a[1]] = a[2] !== undefined
        ? { value: a[2], typed: false }
        : { value: a[3], typed: true };
    }
  }
  flush();
  return out;
}

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
  const entry = parseMetaDataFromXmltree(text).get(markerName);
  if (!entry) return { variant: null, reason: 'marker_absent' };
  if (entry.typed || typeof entry.value !== 'string') {
    // android:resource / 布尔 / 整数等非字符串取值，一律判 unknown
    return { variant: null, reason: 'marker_not_string' };
  }
  const v = entry.value.trim();
  return VARIANTS.includes(v)
    ? { variant: v, reason: 'marker', raw: v }
    : { variant: null, reason: 'marker_out_of_enum', raw: v };
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
