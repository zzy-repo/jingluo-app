/**
 * #480 文档附件：内容指纹（sha256）。
 *
 * 指纹是附件缓存的去重键的一半（另一半是解析器版本），必须**稳定且与浏览器实现无关** ——
 * 同一份文件在不同内核、不同版本上算出来的值要一致，否则缓存永远命不中。
 *
 * 两条路径：
 *  1. `crypto.subtle.digest('SHA-256', …)`：基线 Chromium 83 就有（WebCrypto 是 Chrome 37+
 *     的能力，非安全上下文也可用），是首选；
 *  2. 纯 JS 兜底：`crypto.subtle` 缺失（老 WebView 的裁剪内核、某些嵌入式壳把它裁掉）或
 *     调用抛错（例如非预期的不支持算法实现）时使用。**两条路径的输出必须逐字节一致**，
 *     否则同一个文件在两种内核上会算成两个指纹、缓存和去重同时失效。
 *
 * 只处理内存里的 Blob：调用方（AttachmentManager）已经做过体积校验，最大一档是 50 MiB 的 PDF，
 * 一次性读进 `ArrayBuffer` 是可接受的；不引入流式实现，避免为了省内存把代码复杂度抬到
 * 无法被 review 的程度。
 */

/** 每 32 bit 字（word）用大端序写进输出 */
const hexOfWords = (words: Uint32Array): string => {
  let out = ''
  for (let i = 0; i < words.length; i += 1) {
    out += (words[i] ?? 0).toString(16).padStart(8, '0')
  }
  return out
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const hexOfWordsFromBuffer = (buffer: ArrayBuffer): string => hexOfWords(new Uint32Array(buffer))

const rotateRight = (value: number, bits: number): number =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0

/**
 * 纯 JS SHA-256（FIPS 180-4）。按 512 bit 分块处理，只保留一块的工作区，
 * 不在循环里创建大对象 —— 50 MiB 的文件会有 80 万个分块，分配次数必须是常数级。
 */
export const sha256HexFallback = (bytes: Uint8Array): string => {
  const blocks = ((bytes.length + 8) >>> 6) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  // 末尾 8 字节是 bit 长度，大端序；50 MiB 远小于 2^32，高 4 字节必然为 0，但仍按规范写全
  const bitLength = bytes.length * 8
  const high = Math.floor(bitLength / 0x100000000)
  const tail = padded.length
  padded[tail - 8] = (high >>> 24) & 0xff
  padded[tail - 7] = (high >>> 16) & 0xff
  padded[tail - 6] = (high >>> 8) & 0xff
  padded[tail - 5] = high & 0xff
  padded[tail - 4] = (bitLength >>> 24) & 0xff
  padded[tail - 3] = (bitLength >>> 16) & 0xff
  padded[tail - 2] = (bitLength >>> 8) & 0xff
  padded[tail - 1] = bitLength & 0xff

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4
      w[i] =
        (((padded[at] ?? 0) << 24) |
          ((padded[at + 1] ?? 0) << 16) |
          ((padded[at + 2] ?? 0) << 8) |
          (padded[at + 3] ?? 0)) >>>
        0
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotateRight(w[i - 15] ?? 0, 7) ^ rotateRight(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3)
      const s1 =
        rotateRight(w[i - 2] ?? 0, 17) ^ rotateRight(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10)
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0
    }

    let a = state[0] ?? 0
    let b = state[1] ?? 0
    let c = state[2] ?? 0
    let d = state[3] ?? 0
    let e = state[4] ?? 0
    let f = state[5] ?? 0
    let g = state[6] ?? 0
    let h = state[7] ?? 0

    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const t1 = (h + sum1 + choose + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (sum0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0
    state[1] = ((state[1] ?? 0) + b) >>> 0
    state[2] = ((state[2] ?? 0) + c) >>> 0
    state[3] = ((state[3] ?? 0) + d) >>> 0
    state[4] = ((state[4] ?? 0) + e) >>> 0
    state[5] = ((state[5] ?? 0) + f) >>> 0
    state[6] = ((state[6] ?? 0) + g) >>> 0
    state[7] = ((state[7] ?? 0) + h) >>> 0
  }

  return hexOfWords(state)
}

/**
 * 计算 Blob 的 sha256（64 位小写十六进制）。
 * WebCrypto 可用时用它；缺失或抛错时降级到纯 JS —— 降级是**静默成功**，两条路径结果一致，
 * 不需要调用方区分来源。
 */
export const sha256Hex = async (blob: Blob): Promise<string> => {
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', await blob.arrayBuffer())
      return hexOfWordsFromBuffer(digest)
    } catch {
      // 老内核可能把 digest 挂在原型上但实现缺失（如不支持 SHA-256）：直接落兜底路径
    }
  }
  return sha256HexFallback(new Uint8Array(await blob.arrayBuffer()))
}
