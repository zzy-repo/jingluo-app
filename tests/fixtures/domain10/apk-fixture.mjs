// [fixture | 域10 发布与更新] 最小「真 APK」编码器：真 ZIP + 真二进制 AXML。
//
// 为什么需要它：`deploy/dl-release/server.mjs` 判 debuggable / 包名 / 版本号靠的是
// `deploy/dl-release/apk-manifest.mjs` 从 **zip 里读 AndroidManifest.xml**（二进制 AXML）。
// 真 APK 几十 MB 不方便入库，拿假文件也糊不过去（读不出 AXML 就判「未知」，服务端 fail-closed）。
// 所以这里造「结构合法的最小 APK」：ZIP 容器自己写（stored，无压缩），AXML 自己编（字符串池 +
// 资源映射 + START_NAMESPACE + manifest/application 两个元素）。
//
// 使用方：
//   - `deploy/dl-release/test/domain10-server-contract.test.mjs`（N3，上传契约矩阵）
//   - `tests/unit/domain10-release-gate-matrix.test.mjs`（N2，check:apk 正反例）
//
// 与 `deploy/dl-release/test/server-buildtype.test.mjs` 里的同名编码器**不是**同一份实现：
// 那份是 #330 的服务端用例自带的最小样例，本文件是 F10-19/F10-20 的门禁夹具，刻意保持独立
// （`check:dup-impl` 只拦字节完全相同，这里是「用途不同、形状相似」，不算重复实现）。
//
// 用法：
//   buildApk({ debuggable: true, versionName: '1.4.1', versionCode: 19 })
//   buildApk({ packageName: 'com.other.app' })      // 令服务端的包名白名单拒收

/** AXML 字符串池（UTF-8 变体，UTF16 length + UTF8 length 双长度前缀） */
const stringPool = (strings) => {
  const offsets = []
  const data = []
  for (const text of strings) {
    offsets.push(data.length)
    const utf8 = Buffer.from(text, 'utf8')
    const pushLength = (n) => {
      if (n > 0x7f) data.push(0x80 | ((n >> 8) & 0xff), n & 0xff)
      else data.push(n)
    }
    pushLength(text.length)
    pushLength(utf8.length)
    data.push(...utf8, 0)
  }
  const headerSize = 28
  const stringsStart = headerSize + offsets.length * 4
  const head = Buffer.alloc(headerSize)
  head.writeUInt16LE(0x0001, 0)
  head.writeUInt16LE(headerSize, 2)
  head.writeUInt32LE(stringsStart + data.length, 4)
  head.writeUInt32LE(offsets.length, 8)
  head.writeUInt32LE(0, 12)
  head.writeUInt32LE(0x100, 16)
  head.writeUInt32LE(stringsStart, 20)
  head.writeUInt32LE(0, 24)
  const offsetBuf = Buffer.alloc(offsets.length * 4)
  offsets.forEach((offset, index) => offsetBuf.writeUInt32LE(offset, index * 4))
  return Buffer.concat([head, offsetBuf, Buffer.from(data)])
}

const chunk = (type, headerSize, body) => {
  const head = Buffer.alloc(headerSize)
  head.writeUInt16LE(type, 0)
  head.writeUInt16LE(headerSize, 2)
  head.writeUInt32LE(headerSize + body.length, 4)
  return Buffer.concat([head, body])
}

/** 属性 id（framework 资源）：versionCode / versionName / debuggable */
const ATTR_RES = { 4: 0x0101021b, 5: 0x0101021c, 7: 0x0101000f }
/** meta-data 的 android:name / android:value 属性 id（与 apk-manifest.mjs 同源） */
export const META_NAME_ATTR_RES_ID = 0x01010003
export const META_VALUE_ATTR_RES_ID = 0x01010024
/** application 上 `android:debuggable` 的资源 id（与 apk-manifest.mjs 同源） */
export const DEBUGGABLE_ATTR_RES_ID = 0x0101000f

/**
 * 编一份 AndroidManifest.xml 的二进制 AXML。
 * `debuggable` 为 true 时才在 application 元素上写 android:debuggable="true"（典型 debug 包形态）；
 * 为 false 时**不写这个属性**（release 包的真实形态）—— 判定逻辑走「属性缺失 = 非 debuggable」。
 *
 * `metaData`：写 `<meta-data android:name="…" android:value="…">`（#601 的 LOOPBACK_CONSUME、
 * #330 的 ARTIFACT_VARIANT 都走这条）。取值按 JS 类型编成不同的 AXML typed value，
 * 因为**真实 aapt2 会按 android:value 的 format 自己挑类型**，读侧少认一种就静默失效：
 *   · 字符串 → TYPE_STRING + 字符串池下标（`android:value="true"` 也可能是这种）
 *   · 布尔   → TYPE_INT_BOOLEAN（`android:value="true"` 被编成布尔时就是这样，没有 rawValue）
 *   · 数字   → TYPE_INT_DEC
 * 想造「布尔编码的 true」就写 `{ '…LOOPBACK_CONSUME': true }`。
 *
 * 布局说明：本编码器**不写 END_ELEMENT**（最小样例，和既有用法一致），所以 meta-data 与
 * application 是平铺的 START_ELEMENT 序列，嵌套深度不落字节。README 里那句「结构合法的最小 APK」
 * 指的是「ZIP + AXML 头 + 字符串池 + 资源映射都真」，不是「能装到手机上」。
 */
export const buildManifestAxml = ({
  packageName = 'com.example.deepseekchat',
  versionName = '1.4.0',
  versionCode = 18,
  debuggable = false,
  metaData = {},
} = {}) => {
  const strings = [
    'android',
    'http://schemas.android.com/apk/res/android',
    'manifest',
    'package',
    'versionCode',
    'versionName',
    'application',
    'debuggable',
    packageName,
    versionName,
  ]
  // meta-data 的 name / value 属性名要进字符串池（下标接在既有 10 个字符串之后，
  // 这样 0~9 的下标含义不变，既有断言不受影响），资源映射里登记它们的 framework 资源 id。
  // 注意顺序：**先把所有字符串推进池**，再按最终长度分配资源映射 —— 反过来会写下标越界。
  const metaEntries = Object.entries(metaData).map(([name, value]) => ({
    name: String(name),
    value,
    kind: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
  }))
  const resIdByStringIndex = { ...ATTR_RES }
  let metaDataNameIndex = -1
  let metaNameAttrIndex = -1
  let metaValueAttrIndex = -1
  const metaStringIndex = metaEntries.map(() => ({ name: -1, value: -1 }))
  if (metaEntries.length > 0) {
    metaDataNameIndex = strings.push('meta-data') - 1
    metaNameAttrIndex = strings.push('name') - 1
    metaValueAttrIndex = strings.push('value') - 1
    resIdByStringIndex[metaNameAttrIndex] = META_NAME_ATTR_RES_ID
    resIdByStringIndex[metaValueAttrIndex] = META_VALUE_ATTR_RES_ID
    metaEntries.forEach((entry, index) => {
      metaStringIndex[index].name = strings.push(entry.name) - 1
      // 布尔 / 数字不落字符串池：它们是 typed value，没有 rawValue（真实 APK 也是这样）
      if (entry.kind === 'string') metaStringIndex[index].value = strings.push(entry.value) - 1
    })
  }
  const resMap = Buffer.alloc(strings.length * 4)
  for (const [index, id] of Object.entries(resIdByStringIndex)) {
    resMap.writeUInt32LE(id, Number(index) * 4)
  }

  const NS = 1
  const attr = (nameIndex, { rawValue = 0xffffffff, dataType = 0x00, data = 0 }) => {
    const buf = Buffer.alloc(20)
    buf.writeInt32LE(NS, 0)
    buf.writeUInt32LE(nameIndex, 4)
    buf.writeUInt32LE(rawValue >>> 0, 8)
    buf.writeUInt16LE(8, 12)
    buf.writeUInt8(0, 14)
    buf.writeUInt8(dataType, 15)
    buf.writeUInt32LE(data >>> 0, 16)
    return buf
  }
  const element = (nameIndex, attrs) => {
    const body = Buffer.alloc(20 + attrs.length * 20)
    body.writeUInt32LE(0xffffffff, 0)
    body.writeUInt32LE(nameIndex, 4)
    body.writeUInt16LE(20, 8)
    body.writeUInt16LE(20, 10)
    body.writeUInt16LE(attrs.length, 12)
    attrs.forEach((item, index) => item.copy(body, 20 + index * 20))
    return chunk(0x0102, 16, body)
  }

  // package 属性：rawValue 指向字符串池里的包名（索引 8，见字符串表顺序）
  const pkg = Buffer.alloc(20)
  pkg.writeInt32LE(-1, 0)
  pkg.writeUInt32LE(3, 4)
  pkg.writeInt32LE(8, 8)
  pkg.writeUInt16LE(8, 12)
  pkg.writeUInt8(0, 14)
  pkg.writeUInt8(0x03, 15)
  pkg.writeUInt32LE(8, 16)

  const manifestAttrs = [
    pkg,
    attr(4, { dataType: 0x10, data: versionCode }),
    // versionName：rawValue=9（字符串池索引 9）、类型 STRING、data=9
    attr(5, { rawValue: 9, dataType: 0x03, data: 9 }),
  ]
  const applicationAttrs = debuggable
    ? [attr(7, { rawValue: 0xffffffff, dataType: 0x12, data: 1 })] // BOOLEAN true
    : []

  const startNs = Buffer.concat([
    // START_NAMESPACE: header(8: type/size) + lineNumber(4) + prefix/uri 引用(4) + 起止字符串索引(4)
    (() => {
      const head = Buffer.alloc(16)
      head.writeUInt16LE(0x0100, 0)
      head.writeUInt16LE(16, 2)
      head.writeUInt32LE(24, 4)
      return head
    })(),
    (() => {
      const body = Buffer.alloc(8)
      body.writeInt32LE(0, 0)
      body.writeInt32LE(NS, 4)
      return body
    })(),
  ])

  // <meta-data android:name="…" android:value="…">：与 application 平铺（本编码器不写 END_ELEMENT）
  const metaDataElements = metaEntries.map((entry, index) => {
    const ids = metaStringIndex[index]
    const valueAttr =
      entry.kind === 'bool'
        ? attr(metaValueAttrIndex, { rawValue: 0xffffffff, dataType: 0x12, data: entry.value ? 1 : 0 })
        : entry.kind === 'int'
          ? attr(metaValueAttrIndex, { rawValue: 0xffffffff, dataType: 0x10, data: entry.value })
          : attr(metaValueAttrIndex, { rawValue: ids.value, dataType: 0x03, data: ids.value })
    return element(metaDataNameIndex, [
      attr(metaNameAttrIndex, { rawValue: ids.name, dataType: 0x03, data: ids.name }),
      valueAttr,
    ])
  })

  const body = Buffer.concat([
    stringPool(strings),
    chunk(0x0180, 8, resMap),
    startNs,
    element(2, manifestAttrs),
    element(6, applicationAttrs),
    ...metaDataElements,
  ])
  const head = Buffer.alloc(8)
  head.writeUInt16LE(0x0003, 0)
  head.writeUInt16LE(8, 2)
  head.writeUInt32LE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** 最小 ZIP（stored，无压缩）：中央目录 + EOCD，能被 `apk-manifest.mjs` 正常读出 */
export const buildZip = (entries) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

/** 造一个「像真的」APK：AndroidManifest.xml + classes.dex */
export const buildApk = (options = {}) =>
  buildZip([
    { name: 'AndroidManifest.xml', data: buildManifestAxml(options) },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0', 'binary') },
  ])
