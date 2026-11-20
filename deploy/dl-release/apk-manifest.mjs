/**
 * 零依赖 APK 清单读取 —— 直接从 APK（zip）里取出 `AndroidManifest.xml`（二进制 XML / AXML）
 * 并解析出 `android:debuggable` 的真实取值。
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
 * 扫一遍 zip 中央目录，列出全部条目（`{ name, method, compSize, plainSize, localOff }`）。
 *
 * 为什么要把「枚举」和「读一个条目」分开（Issue #609）：发布硬闸除了
 * `AndroidManifest.xml`（`readZipEntry`）还要去 `assets/` 下的 bundle（`*.js`）里找构建期注入的
 * `consume.baseUrl`（`apk-consume.mjs`）。枚举逻辑只应该有一份 —— 两处各写一遍的话，
 * 其中一处迟早会漏掉 zip64 / 空条目之类的边角。
 */
export function listZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是 ZIP（找不到 EOCD，可能不是 APK）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      plainSize: buf.readUInt32LE(off + 24),
      localOff: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 读 `listZipEntries` 给出的一个条目；只支持 store(0) 与 deflate(8)。
 * `maxBytes` 用来兜住「一个 40MB 的 dex 被整个读进内存」这种事（超上限直接报错，不猜）。
 */
export function readZipEntryRecord(buf, entry, maxBytes = 64 * 1024 * 1024) {
  if (entry.plainSize > maxBytes) {
    throw new Error(`zip 条目 ${entry.name} 太大（${entry.plainSize} 字节 > 上限 ${maxBytes}）`);
  }
  if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) throw new Error('ZIP 本地头损坏');
  const lNameLen = buf.readUInt16LE(entry.localOff + 26);
  const lExtraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.plainSize, 1) + 1024 });
  }
  throw new Error(`不支持的 zip 压缩方式: ${entry.method}`);
}

/**
 * 读 zip 里一个具名条目；不存在返回 null。
 * 只支持 store(0) 与 deflate(8) —— Android 打包只用这两种。
 */
export function readZipEntry(buf, entryName) {
  const entry = listZipEntries(buf).find((e) => e.name === entryName);
  return entry ? readZipEntryRecord(buf, entry) : null;
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
