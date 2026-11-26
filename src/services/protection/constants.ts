/**
 * Storage Protection（#909）的全部阈值与路径集中在这里：改数字只改这一处。
 */

/** 高水位标记：原生端写应用私有目录，Web 端写 localStorage（见 highwater.ts）。 */
export const HIGHWATER_PATH = 'protection/highwater.json'
export const HIGHWATER_LOCAL_KEY = 'chat-demo:protection:highwater'
export const HIGHWATER_FORMAT_VERSION = 1
