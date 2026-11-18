/**
 * 反馈上传的常量配置。
 *
 * ⚠️ 下面两个常量是**占位值，待后端确认后替换**（客户端 token 与正式域名都由后端/运维给出）。
 * 换地址或换 token 只改这一处，采集层与 UI 都不用动。
 */

/** 反馈服务的 base url（不含 /api/v1/feedback）。占位值，待后端确认后替换。 */
export const FEEDBACK_BASE_URL = 'https://feedback.rose7.cn'

/** 请求头 X-Client-Token 的值。占位值，待后端确认后替换。 */
export const CLIENT_TOKEN = 'REPLACE_ME'

/**
 * 后端实际接口：无鉴权头，接收 content/type/contact/version/log 与可选 images 数组；
 * images 支持 raw base64 或 data URL。服务端请求上限 200KB，客户端整包预算 180 KiB。
 * 对应实现见 transport.legacy.ts。
 */
export const LEGACY_FEEDBACK_URL = 'http://62.106.70.167:60012/feedback'

/**
 * 体积策略（后端确认上限 200KB）：
 * 判定口径是 `JSON.stringify(整个 body)` 之后的 UTF-8 字节数 —— 换行会变 `\n`、
 * 中文一个字 3 字节、引号要转义，实测量级膨胀 10–30%，所以原始文本不能卡到 200KB。
 *
 * - log 原始文本目标：150KB
 * - 整个 body 序列化后必须 < 180KB（留 20KB 余量）
 */
export const LEGACY_LOG_MAX_BYTES = 150 * 1024

/** 整个 body 序列化后的硬上限（UTF-8 字节） */
export const LEGACY_BODY_MAX_BYTES = 180 * 1024

/** 触发 413 / 连接重置后，降级重试用的 log 上限 */
export const LEGACY_LOG_RETRY_BYTES = 50 * 1024

/** 单行日志的截断长度：超过就截断并加 … */
export const LEGACY_LOG_LINE_MAX = 500

/** 单条 meta JSON 的截断长度 */
export const LEGACY_META_MAX = 300

/** 提交接口路径 */
export const FEEDBACK_PATH = '/api/v1/feedback'

/** 单次提交的请求体上限（2MB）：超了先压截图，再裁剪最旧的日志 */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

/** 超时（不重试）：15 秒 */
export const REQUEST_TIMEOUT_MS = 15_000

/** 截图压缩：最长边 1280、JPEG 质量 0.8 */
export const SCREENSHOT_MAX_EDGE = 1280
export const SCREENSHOT_QUALITY = 0.8

/** 日志条数上限与单条正文上限（与 collector.ts 的环形缓冲一致） */
export const MAX_LOG_ENTRIES = 500
export const MAX_LOG_MESSAGE_LENGTH = 2000
