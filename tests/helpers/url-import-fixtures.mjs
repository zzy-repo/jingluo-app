// urlImport 一族的**共用夹具构造器**（Issue #408 收尾批）。
//
// 为什么有它：`zipBytes` 这段 8 行在 6 个 urlImport 用例文件里逐字相同（import-clock-monotonic /
// url-import-content-range / import-budget-vs-stall / url-import-stall /
// log-313-attachment-import / import-network-classification）。单看 8 行不到 `check:test-duplication`
// 的 20 行窗口，所以一直没被点出来；但它和 `rangeOf` / `resetEnv` / `records` 拼在一起就凑成一组，
// 说明「同一份构造器抄 6 遍」这件事本身是真的。
//
// 语义不变：字节内容、填充规则（`index % 251`）逐字沿用原文件 —— 这些用例断言的是
// 「服务端声称的体积 vs 实收体积」，字节只是一个**长度可预期**的假包体，不参与内容校验。

/**
 * 造一个「声称这么大」的 ZIP 字节：前 4 字节是 PK\x03\x04 头，其余按 `index % 251` 填充。
 * 确定性 + 可压缩性差，正好用来做分块 / Range / 上限判定的假数据。
 */
export const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}
