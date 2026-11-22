/**
 * **推理必须与登录同环境**（Issue #812）。
 *
 * ## 为什么这条规矩必须是代码，而不是一句纪律
 *
 * #812 的现场：Key 是服务端刚下发的、有效，客户端却提示「Key 无效」。根因不在 Key，
 * 而在**地址**——登录走的是 `consume.baseUrl`（staging 环境），
 * 推理（`ours` 渠道）却另外取了一份 `chatBaseUrl`（旧池域 / 生产环境）。
 * staging 发的 Key 打到生产网关，网关当然不认：`/v1/models`、`/v1/chat/completions` 401 一起抬头。
 *
 * 只要「推理地址」和「登录地址」是两份各自配置的东西，这个错就一定会有人再犯一次 ——
 * 它不报错、不报警，只表现为「Key 无效」。所以本模块把两者收敛成**一个来源**：
 * {@link inferenceBaseUrl} 只从登录环境（`consume.baseUrl`）派生，同环境不是约定，是构造。
 *
 * ## 环境怎么判
 *
 * 「同一份部署」= `scheme://host[:port]` + **路径前缀的第一段**。只看域名是错的，
 * 也不该在代码里认域名：同一个 host 上 `/staging` 与 `/prod` 是两个互不相认的环境，
 * 而这两份部署共用同一套域名。所以：
 *
 *   `https://<host>/staging` → `https://<host>` + `/staging`
 *   `https://<host>`         → `https://<host>` + `''`
 *
 * 路径更深的段（`/staging/v1`）不参与判定：那是同一个环境的**接口前缀**，不是另一个环境。
 *
 * 纯逻辑：不读全局、不发请求、不 import 存储层，Node 单测可直接喂两个字符串断言。
 */

/** 一份部署的标识：origin + 路径前缀第一段（`''` 表示部署在根路径上） */
export type EndpointEnvironment = {
  /** `scheme://host[:port]`，小写化后的 origin */
  origin: string
  /** 路径前缀第一段（带前导 `/`；没有就是空串） */
  prefix: string
}

/** 取环境标识；解析不了（空串 / 非法 URL / 非法协议）返回 null —— 调用方按「判不出来」处理 */
export const endpointEnvironment = (url: string): EndpointEnvironment | null => {
  const value = url.trim()
  if (value === '') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  const first = parsed.pathname.split('/').filter((part) => part !== '')[0] ?? ''
  return { origin: `${parsed.protocol}//${parsed.host}`.toLowerCase(), prefix: first === '' ? '' : `/${first}` }
}

/** 环境标识的一行写法（日志 / 断言用）：`<origin><前缀第一段>` */
export const endpointEnvironmentId = (url: string): string => {
  const env = endpointEnvironment(url)
  return env === null ? '' : `${env.origin}${env.prefix}`
}

/**
 * 两个地址是不是**同一个环境**。
 *
 * 判不出来（空串 / 非法 URL）一律 `false`：宁可让「环境一致性」这道判定报警，
 * 也不要因为一个解析不了的值被当成「同环境」放过去。
 */
export const sameEndpointEnvironment = (a: string, b: string): boolean => {
  const left = endpointEnvironment(a)
  const right = endpointEnvironment(b)
  return left !== null && right !== null && left.origin === right.origin && left.prefix === right.prefix
}

/** 构建期注入表的**相关**子集（结构化取子集 → 单测不必造整张注入表） */
export type InferenceEndpointTable = {
  /** 登录环境（消费层 / 推理共用同一份部署，见 `config/README.md` 的 consume 一节） */
  consume?: { baseUrl?: string } | undefined
}

/**
 * `ours` 渠道的推理地址 —— **只从登录环境派生**（#812）。
 *
 * 只有一级：`consume.baseUrl`（统一网关 BASE，真产物一定有：`rspack.config.ts` 注入 + gradle 交叉核对）。
 * #869 删除了 `chatBaseUrl`，所以不再有「退回另一份地址」的兜底；没有注入 `consume` 时返回空串，
 * 由调用方按「没配置」处理（fail-closed，不猜别的地址）。
 *
 * 尾斜杠在这里去掉一次：`joinUrl()` 只负责路径拼接，不该同时兼顾 base 的写法。
 */
export const inferenceBaseUrl = (table: InferenceEndpointTable): string => {
  const consume = typeof table.consume?.baseUrl === 'string' ? table.consume.baseUrl.trim() : ''
  return consume.replace(/\/+$/, '')
}

/**
 * 推理地址与登录环境是否一致（构建期 / 用例里的**断言**，不是运行时分支）。
 *
 * 为什么不返回布尔给运行时分岔：两个环境不一致时客户端没有「正确的」选择可做
 * （打到哪个都是错的），能做的只有「别让这种产物发出去」。所以它出现在门禁与用例里。
 */
export const inferenceMatchesLoginEnvironment = (table: InferenceEndpointTable): boolean =>
  sameEndpointEnvironment(inferenceBaseUrl(table), typeof table.consume?.baseUrl === 'string' ? table.consume.baseUrl : '')
