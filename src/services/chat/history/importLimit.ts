/**
 * 导入包大小上限（issue #34）：**一个数字，两条导入链路共用**。
 *
 * 之前这个上限只存在于 urlImport.ts 里（`200 * 1024 * 1024`），
 * 本地文件导入（backup.ts）完全没有 —— 同一个导出包换个入口进来，
 * 就会先流式写入暂存、再在里面把内存/磁盘吃穿，最后才失败。
 * 所以这里单独成一处：从链接导入、本地文件导入都按它拒绝。
 *
 * 默认值刻意保持 200MB 不变（官方导出包约 20MB，十倍余量是原设计）：
 * 改默认值属于行为变更，要有人明确拍板，不许在测试或调试里顺手改。
 * 测试/诊断要小上限，请通过调用方的 `maxBytes` 传入，不要动这个常量。
 */
export const DEFAULT_MAX_IMPORT_BYTES = 200 * 1024 * 1024

/**
 * 导出包大小上限（issue #336）：**就是导入上限本身**，不再另设一个数字。
 *
 * 死区是这么出现的：导出侧原生出口曾单独写 220MB（「为导出物能被本 App 导回」），
 * 而导入侧只认 200MB —— 于是 (200MB, 220MB] 这一段「导出提示成功、导入报文件过大」。
 * 只要两边不是同一个数，这个窗口就一定存在；把导出侧定义成导入侧的转出（而不是再写一遍 200MB），
 * 以后改导入上限，导出侧自动跟着走，没有第二个数字可以忘掉。
 *
 * 判定点：`history/zipWriter.ts` 算出成品字节数（expectedSize）之后、写出任何字节之前；
 * 原生 SAF 是在那之后才打开的，所以超限时一个原生调用都不会发生。
 */
export const MAX_EXPORT_BYTES = DEFAULT_MAX_IMPORT_BYTES

/**
 * 导出物是否还能被导入：比较口径与导入侧**逐字对齐**（导入是 `file.size > maxBytes` 才拒，
 * 所以正好等于上限的包是能导的）。判等号写在这一个函数里，导出与导入各写一遍 `<=` / `<`
 * 就是下一个死区的出生地（#336）。
 */
export const isWithinExportLimit = (bytes: number): boolean => bytes <= MAX_EXPORT_BYTES

/** 上限对应的 MB 数，用于提示文案里的 {size}（向下取整：宁可提示小一点，也不要报未达的余量）。 */
export const maxImportMegabytes = (bytes: number = DEFAULT_MAX_IMPORT_BYTES): number =>
  Math.floor(bytes / 1024 / 1024)

/** 解析调用方传入的上限：没传或不合法（非有限数 / <=0）一律退回默认值，不接受「无上限」。 */
export const resolveMaxImportBytes = (value?: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_IMPORT_BYTES

/**
 * 字节 → 人话（与界面 formatBytes 同档：KB 之前不换算成小数）。
 * 超限提示要把「实测体积」说出来（#195），本地文件与直链两条链路必须用同一把尺子。
 */
export const formatImportBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
