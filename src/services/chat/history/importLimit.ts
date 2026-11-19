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
