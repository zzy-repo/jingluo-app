/**
 * 触发浏览器下载：Blob → Object URL → 临时 `<a download>`。
 *
 * 导出 ZIP 的两个入口（设置页「导出所有历史对话」与会话列表「导出选中」，#390）共用这一处，
 * 保证文件名 / 释放时机一致；URL 用完延时释放，避免下载还没开始就被回收。
 */
export const downloadBlob = (blob: Blob, name: string, revokeDelayMs = 10_000): void => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs)
}
