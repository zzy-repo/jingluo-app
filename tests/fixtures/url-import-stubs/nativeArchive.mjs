// 测试替身：原生下载插件（HistoryArchivePlugin）。
//
// 「网络读 + 写盘」全部由用例通过 `globalThis.__download` 提供的模拟器驱动
// （见 `download-simulator.mjs`），urlImport 的真实代码（轮询、停滞判定、心跳、
// 临时文件清理、错误分类）原样运行。这一层断言的是**我们自己的**判定逻辑，
// 而不是 Capacitor 或 Android 的行为。
//
// 同一个对象同时提供两套门面，因为它在两种用法里出现：
//   1. 作为 `registerPlugin('HistoryArchive')` 的返回值 → 原生插件方法名
//      （startDownload / getProgress / abortDownload / readFileRange / statFile / deleteFile）；
//   2. 作为 `./nativeArchive.js` 模块的替身            → 模块的包装方法名
//      （start / progress / release / discard / remove / size / read / reader）。
const call = (name, ...args) => {
  const download = globalThis.__download
  if (!download) {
    throw new Error(`nativeArchive 替身缺少 globalThis.__download（${name}）`)
  }
  const method = download[name]
  if (typeof method !== 'function') {
    throw new Error(`nativeArchive 替身：模拟器没有实现 ${name}`)
  }
  return method.apply(download, args)
}

/** 区间读回来的字节按原生侧的口径转成 base64（`Base64.NO_WRAP`，无换行）。 */
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64')

export const nativeArchive = {
  // ---- ① 原生插件门面（registerPlugin 的返回值）----
  startDownload: (request) => call('start', request),
  getProgress: () => call('progress'),
  abortDownload: ({ keep }) =>
    (keep ? call('release') : call('discard')).then(() => ({ bytes: 0, kept: keep === true })),
  readFileRange: ({ path, offset, length }) =>
    call('read', path, offset, length).then((bytes) => ({ data: toBase64(bytes) })),
  statFile: ({ path }) => call('size', path).then((size) => ({ size })),
  deleteFile: ({ path }) => call('remove', path).then(() => ({ deleted: true })),

  // ---- ② nativeArchive 模块门面（./nativeArchive.js 的替身）----
  start: (request) => call('start', request),
  progress: () => call('progress'),
  release: () => call('release'),
  discard: () => call('discard'),
  remove: (path) => call('remove', path),
  size: (path) => call('size', path),
  read: (path, offset, length) => call('read', path, offset, length),
  reader: (handle) => ({
    size: handle.size,
    read: (start, length) =>
      call('read', handle.path, start, Math.max(0, Math.min(length, handle.size - start))),
  }),
}
