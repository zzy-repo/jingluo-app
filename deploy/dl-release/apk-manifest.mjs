/**
 * 零依赖 APK 清单读取 —— 直接从 APK（zip）里取出 `AndroidManifest.xml`（二进制 XML / AXML）
 * 并解析出编译进去的真实取值：`android:debuggable`（发布完整性，#60）与
 * `<meta-data android:value>` 标记（回环 consume 闸 2 读 `LOOPBACK_CONSUME`，#601）。
 *
 * 为什么不用 aapt2：
 *   - 发布关卡要在任何机器上都能跑（CI、构建机、dl 服务端、本地 Windows），不能强依赖 Android SDK；
 *   - aapt2 的 badging 输出要 `grep application-debuggable`，是「文本里找子串」，
 *     而这里读的是二进制属性本身（属性名 / 资源 id 0x0101000f / typed value），判据更硬。
 *   aapt2 仍然可以用作交叉验证（docs/RELEASE-MANUAL.md §4.5 两条命令互为佐证）。
 *
 * 关于可信边界（写文档时别夸大）：
 *   `AndroidManifest.xml` 在 APK 签名覆盖范围内，所以这里读到的是「APK 二进制里真实编译进去的值」，
 *   不是客户端声明；但本模块**不核验证书指纹**，签名身份仍需 apksigner 另行核验。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/** android 命名空间 */
export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/** android:debuggable 的属性资源 id */
export const ATTR_DEBUGGABLE_RES_ID = 0x0101000f;
/** `<meta-data android:name="…">` 的 android:name 属性资源 id */
export const ATTR_NAME_RES_ID = 0x01010003;
/** `<meta-data android:value="…">` 的 android:value 属性资源 id */
export const ATTR_VALUE_RES_ID = 0x01010024;

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_ELEMENT = 0x0102;

// ------------------------------------------------------------------ ZIP 读取

/** 从尾部找 EOCD（0x06054b50），注释最长 65535 字节 */
function findEocd(buf) {
  if (buf.length < 22) return -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 读 zip 里一个具名条目；不存在返回 null。
 * 只支持 store(0) 与 deflate(8) —— Android 打包只用这两种。
 */
export function readZipEntry(buf, entryName) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是 ZIP（找不到 EOCD，可能不是 APK）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const plainSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === entryName) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('ZIP 本地头损坏');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(plainSize, 1) + 1024 });
      throw new Error(`不支持的 zip 压缩方式: ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// -------------------------------------------------------------- AXML 解析

function parseStringPool(buf, start) {
  const headerSize = buf.readUInt16LE(start + 2);
  const chunkSize = buf.readUInt32LE(start + 4);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings = [];
  const end = Math.min(start + chunkSize, buf.length);
  for (let i = 0; i < count; i++) {
    const rel = buf.readUInt32LE(start + headerSize + i * 4);
    let p = start + stringsStart + rel;
    if (p >= end) {
      strings.push('');
      continue;
    }
    if (utf8) {
      // UTF-8 池：先「字符数」再「字节数」，各自 1~2 字节变长
      let chars = buf[p++];
      if (chars & 0x80) { chars = ((chars & 0x7f) << 8) | buf[p++]; }
      let bytes = buf[p++];
      if (bytes & 0x80) { bytes = ((bytes & 0x7f) << 8) | buf[p++]; }
      strings.push(buf.toString('utf8', p, Math.min(p + bytes, end)));
    } else {
      let len = buf.readUInt16LE(p);
      p += 2;
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      strings.push(buf.toString('utf16le', p, Math.min(p + len * 2, end)));
    }
  }
  return strings;
}

/**
 * 解析二进制 XML，返回
 *   { strings, resourceMap, elements: [{ name, attrs: [{ ns, name, resId, rawValue, dataType, data }] }] }
 */
export function parseBinaryXml(buf) {
  if (buf.length < 8) throw new Error('AXML 长度不足');
  const xmlType = buf.readUInt16LE(0);
  if (xmlType !== 0x0003) throw new Error(`不是 AXML（首 chunk type=0x${xmlType.toString(16)}）`);
  const total = Math.min(buf.readUInt32LE(4) || buf.length, buf.length);
  let strings = [];
  let resourceMap = [];
  const elements = [];
  let off = 8;
  while (off + 8 <= total) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size <= 0 || off + size > total) break;
    if (type === CHUNK_STRING_POOL) {
      strings = parseStringPool(buf, off);
    } else if (type === CHUNK_RESOURCE_MAP) {
      const n = Math.floor((size - headerSize) / 4);
      resourceMap = [];
      for (let i = 0; i < n; i++) resourceMap.push(buf.readUInt32LE(off + headerSize + i * 4));
    } else if (type === CHUNK_START_ELEMENT) {
      const bodyOff = off + headerSize;
      const nameIdx = buf.readUInt32LE(bodyOff + 4);
      const attrStart = buf.readUInt16LE(bodyOff + 8);
      const attrCount = buf.readUInt16LE(bodyOff + 12);
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const a = off + headerSize + attrStart + i * 20;
        if (a + 20 > off + size) break;
        const nsIdx = buf.readInt32LE(a);
        const attrNameIdx = buf.readUInt32LE(a + 4);
        const rawIdx = buf.readInt32LE(a + 8);
        const dataType = buf.readUInt8(a + 15);
        const data = buf.readUInt32LE(a + 16);
        attrs.push({
          ns: nsIdx >= 0 ? strings[nsIdx] ?? '' : null,
          name: strings[attrNameIdx] ?? '',
          resId: resourceMap[attrNameIdx] ?? 0,
          rawValue: rawIdx >= 0 ? strings[rawIdx] ?? null : null,
          dataType,
          data,
        });
      }
      elements.push({ name: strings[nameIdx] ?? '', attrs, strings });
    }
    off += size;
  }
  return { strings, resourceMap, elements };
}

/** typed value → boolean；判不出来返回 null */
function decodeBool(attr) {
  if (!attr) return null;
  if (typeof attr.rawValue === 'string') {
    const v = attr.rawValue.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (attr.dataType === 0x12) return attr.data !== 0; // TYPE_INT_BOOLEAN（true = 0xffffffff）
  if (attr.dataType === 0x10 || attr.dataType === 0x11) return attr.data !== 0; // INT_DEC / INT_HEX
  if (attr.dataType === 0x03 && typeof attr.rawValue === 'string') {
    return attr.rawValue.trim().toLowerCase() === 'true';
  }
  return null;
}

/**
 * 判断一份 AXML（AndroidManifest.xml 的字节）里 application 元素的 android:debuggable。
 *
 * @returns {{state: true|false|null, reason: string, attr?: object}}
 *   state=true  → 编译进了 android:debuggable="true"（可调试包，禁止发布）
 *   state=false → 显式 false 或属性缺失（正常发布包）
 *   state=null  → 判不出来（调用方必须按「不准发布」处理，别默认放行）
 */
export function debuggableFromManifest(axmlBuf) {
  let doc;
  try {
    doc = parseBinaryXml(axmlBuf);
  } catch (e) {
    return { state: null, reason: `axml_parse_failed: ${e.message}` };
  }
  const app = doc.elements.find((el) => el.name === 'application');
  if (!app) return { state: null, reason: 'application_element_absent' };
  const attr = app.attrs.find(
    (a) => a.name === 'debuggable' || a.resId === ATTR_DEBUGGABLE_RES_ID,
  );
  if (!attr) return { state: false, reason: 'attr_absent' };
  const value = decodeBool(attr);
  if (value === null) return { state: null, reason: 'attr_value_undecodable', attr };
  return { state: value, reason: value ? 'debuggable_true' : 'debuggable_false', attr };
}

/**
 * 解出 `<meta-data android:value>` 的取值文本（`android:name` 也走这条）。
 *
 * **四种编码都要认**，少认一种的后果是「真实的回环包被判成认不出 → 放行」，也就是闸 2 静默失效：
 *   1. TYPE_STRING(0x03) + 字符串池下标（data）—— 手写/最小夹具常见；
 *   2. 原始值（rawValue）本身就是字符串 —— aapt2 对字符串占位符的常见编法；
 *   3. TYPE_INT_BOOLEAN(0x12) —— `android:value="true"` 在 `android:value` 这个属性上
 *      （format 含 boolean）**完全可能被 aapt2 直接编成布尔**，此时没有 rawValue，只有 data≠0；
 *   4. TYPE_INT_DEC(0x10) / TYPE_INT_HEX(0x11) —— `android:value="1"`。
 * 判不出来返回 null（调用方按「认不出」处理，不猜）。
 */
function decodeString(attr, strings) {
  if (!attr) return null;
  if (typeof attr.rawValue === 'string') return attr.rawValue;
  if (attr.dataType === 0x03) {
    const text = Array.isArray(strings) ? strings[attr.data] : undefined;
    return typeof text === 'string' ? text : null;
  }
  if (attr.dataType === 0x12) return attr.data !== 0 ? 'true' : 'false';
  if (attr.dataType === 0x10 || attr.dataType === 0x11) return String(attr.data);
  return null;
}

/**
 * 读 `<application>` 下所有 `<meta-data android:name="…" android:value="…">` 的字符串取值。
 *
 * 与 `debuggableFromManifest` 同源：读的是 APK 二进制里真实编译进去的 AXML，
 * 不是客户端声明；但同样**不核验证书指纹**（meta-data 在签名覆盖范围内，改它要重签名）。
 *
 * @returns {Map<string,string>} name → value（同一个 name 出现多次以最后一个为准，与 Android 行为一致）
 */
export function metaDataFromManifest(axmlBuf) {
  const doc = parseBinaryXml(axmlBuf);
  const out = new Map();
  for (const el of doc.elements) {
    if (el.name !== 'meta-data') continue;
    const nameAttr = el.attrs.find((a) => a.name === 'name' || a.resId === ATTR_NAME_RES_ID);
    const valueAttr = el.attrs.find((a) => a.name === 'value' || a.resId === ATTR_VALUE_RES_ID);
    const name = decodeString(nameAttr, el.strings);
    if (!name) continue;
    const value = decodeString(valueAttr, el.strings);
    out.set(name, value === null ? '' : value);
  }
  return out;
}

/**
 * 判定 APK 是否为「回环 consume」构建（Issue #601 闸 2）。
 *
 * 判据：构建期写入的 `<meta-data android:name="<marker>" android:value="true">`
 * （`android/app/build.gradle` 只有显式 `-PallowLoopbackConsume=true` 且地址真是回环时才写）。
 *
 * **只认显式 true**：标记缺失（老包）/ 值为 false / 认不出 → `loopback: false`，按历史行为放行。
 * 这一条是有意的：闸 2 管的是「以后打的回环包」，不能因为读不到标记就把历史包、或者别人
 * 手工改过 manifest 的包一律拒收（误伤一次，发布流程就会被绕过）。
 *
 * @returns {{loopback: true|false, reason: string, value: string|null}}
 *   reason: marker_true | marker_false | marker_undecodable | marker_absent | axml_parse_failed | manifest_absent
 */
export function loopbackFromManifest(axmlBuf, markerName) {
  let map;
  try {
    map = metaDataFromManifest(axmlBuf);
  } catch {
    return { loopback: false, reason: 'axml_parse_failed', value: null };
  }
  if (!map.has(markerName)) return { loopback: false, reason: 'marker_absent', value: null };
  const raw = map.get(markerName);
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1') return { loopback: true, reason: 'marker_true', value: raw };
  if (value === 'false' || value === '0') return { loopback: false, reason: 'marker_false', value: raw };
  return { loopback: false, reason: 'marker_undecodable', value: raw };
}

/** manifest 元素上的基础元信息（用于报告，不参与判定） */
function manifestInfo(doc) {
  const el = doc.elements.find((e) => e.name === 'manifest');
  if (!el) return {};
  const get = (n) => {
    const a = el.attrs.find((x) => x.name === n);
    if (!a) return undefined;
    if (typeof a.rawValue === 'string') return a.rawValue;
    if (a.dataType === 0x03) return a.strings ? a.strings[a.data] : undefined;
    return a.data;
  };
  const versionCode = get('versionCode');
  return {
    packageName: typeof get('package') === 'string' ? get('package') : undefined,
    versionName: typeof get('versionName') === 'string' ? get('versionName') : undefined,
    versionCode: typeof versionCode === 'number' && Number.isFinite(versionCode) ? versionCode : undefined,
  };
}

/**
 * 对 APK 文件（路径）或内存 Buffer 做「回环 consume」判定。
 *
 * 读不到（文件 / zip / manifest / 标记）一律 `loopback: false` —— 见 `loopbackFromManifest`
 * 的说明：闸 2 不追溯历史包，读不到就按历史行为放行，但 `reason` 会原样进日志。
 *
 * @returns {{loopback: true|false, reason: string, value: string|null, info: object, file?: string}}
 */
export function inspectApkLoopback(input, markerName) {
  const isBuffer = Buffer.isBuffer(input);
  const file = isBuffer ? undefined : String(input);
  let buf;
  try {
    buf = isBuffer ? input : fs.readFileSync(file);
  } catch {
    return { loopback: false, reason: 'read_failed', value: null, info: {}, file };
  }
  let manifest;
  try {
    manifest = readZipEntry(buf, 'AndroidManifest.xml');
  } catch {
    return { loopback: false, reason: 'zip_failed', value: null, info: {}, file };
  }
  if (!manifest) return { loopback: false, reason: 'manifest_absent', value: null, info: {}, file };
  const res = loopbackFromManifest(manifest, markerName);
  let info = {};
  try {
    info = manifestInfo(parseBinaryXml(manifest));
  } catch {
    info = {};
  }
  return { ...res, info, file };
}

/**
 * 对 APK 文件（路径）或内存 Buffer 做判定。
 *
 * @returns {{debuggable: true|false|null, reason: string, info: object, file?: string}}
 */
export function inspectApkDebugState(input) {
  const isBuffer = Buffer.isBuffer(input);
  const file = isBuffer ? undefined : String(input);
  let buf;
  try {
    buf = isBuffer ? input : fs.readFileSync(file);
  } catch (e) {
    return { debuggable: null, reason: `read_failed: ${e.message}`, info: {}, file };
  }
  let manifest;
  try {
    manifest = readZipEntry(buf, 'AndroidManifest.xml');
  } catch (e) {
    return { debuggable: null, reason: `zip_failed: ${e.message}`, info: {}, file };
  }
  if (!manifest) return { debuggable: null, reason: 'manifest_absent', info: {}, file };
  const res = debuggableFromManifest(manifest);
  let info = {};
  try {
    info = manifestInfo(parseBinaryXml(manifest));
  } catch {
    info = {};
  }
  return { debuggable: res.state, reason: res.reason, info, file };
}
