/**
 * hardcodedIpAudit.mjs —— `check:ip` 门禁的判定核心（纯函数，不碰文件系统，可以单测）。
 *
 * 规则书（为什么有这条门禁、扫哪些目录、哪些地址不算违规）在
 * `scripts/check-hardcoded-ip.mjs` 的文件头；这里只放「一行文本怎么判」。
 *
 * 一条地址算不算违规，按这个顺序判：
 *   1. 回环 / 通配 / 私有 / 链路本地 / CGNAT / 保留测试段 —— 不算（本地测试桩要用）；
 *   2. ALLOWED_HOSTS 里的当前线上地址 —— 不算（迁移期豁免）；
 *   3. 行内（或上一行）有 `check-ip-allow` —— 整行放过（必须写明理由）；
 *   4. 版本语境豁免（见下）—— 整行放过。
 *
 * 版本语境豁免为什么存在：四段点分十进制的版本号（模拟器 / WebView / Chrome 的版本号都长这样）
 * 语法上和 IPv4 **无法区分**，段范围校验也救不了（版本号各段天然落在 0–255）。所以只能靠上下文，
 * 而上下文判断必须往「宁可错杀」的方向收：
 *
 *   a. 必须出现**版本语义词**（VERSION_MARKERS：emulator / webview / sdk / version / 模拟器 / 版本 …）。
 *      这类词不会跟主机地址搭配，出现即说明在说号，不是在地说机器。
 *   b. 一旦同处出现**主机/地址语义词**（HOST_MARKERS：host / server / url / http / 服务器 / 生产 /
 *      地址 / 迁移 / 下线 …），豁免立刻作废 —— `// 生产环境 <四段点分>`、
 *      `// 服务器版本 <四段点分>`、`// <四段点分> → <四段点分> 迁移` 这种写法照样要报。
 *      这是把「版本词表」收窄到「明确不会配 IP 的语境」的兜底：词表可以长，但否决规则必须硬。
 *
 * 已知边界（宁可承认也不硬猜）：一行里同时有版本词、却没有上面任何一个地址语义词时，整行豁免。
 * 也就是说「版本号旁边顺手贴一个真地址、整行一个字都不提机器/环境/迁移」的写法会漏。
 * 形似根本分不出来，能分的只有语义：把真地址挪到带地址语义的行里，或者那一行加 `check-ip-allow`。
 * 取舍：漏报比误报贵，所以否决词表往宽了列；词表之外的误报（例如「服务器 + 版本号」这种写法）
 * 用 `check-ip-allow` 一行解决，不需要改词表。
 */

/** 行内豁免标记：同一行或上一行出现它，本行不判 */
const ALLOW_MARK = 'check-ip-allow'

/**
 * 当前**合法**的写死地址：服务端就在这个 IP 上（明文 HTTP，没有域名）。
 * 换域名（或服务端再搬一次）时改这里，并同步 providers.ts / invite/api.ts / diagnostics/config.ts。
 */
const ALLOWED_HOSTS = new Set(['140.210.13.146'])

/** 回环、通配、私有、保留测试段：本地测试桩可以写 */
const isExemptIpv4 = (a, b) => {
  if (a === 0) return true // 0.0.0.0/8：通配
  if (a === 127) return true // 127.0.0.0/8：回环
  if (a === 10) return true // 10/8：私有
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12：私有
  if (a === 192 && b === 168) return true // 192.168/16：私有
  if (a === 169 && b === 254) return true // 169.254/16：链路本地
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10：CGNAT
  if (a === 192 && b === 0) return true // 192.0.0/24、192.0.2/24：文档 / 保留
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true // 198.18/15 基准、198.51.100/24 文档
  if (a === 203 && b === 0) return true // 203.0.113/24：文档
  if (a >= 224) return true // 组播 / 保留 / 广播
  return false
}

/** 前面不能紧贴数字或点（避免把 1.2.3.4.5 这类版本号切一段出来）；后面同理 */
const RE_IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g
const RE_IPV6 = /(?<![\w:])(?:::1|fe80:[0-9a-f:]+|f[cd][0-9a-f]{2}:[0-9a-f:]+)(?![\w:])/gi

/**
 * 版本语义词表（窄）：只列「跟版本号走、不会跟主机地址走」的词。
 * 拉丁词左右都不能紧贴字母（`(?<![a-z])…(?![a-z])`，配 /i 即大小写都不贴）：
 * 这样 `EMULATOR_VERSION`、`CHROME_VERSION` 这类常量名能命中，
 * 而 `pip`、`shipment`、`androidx` 之类词中间/边上的字母不会误命中。
 */
const VERSION_MARKERS =
  /(?:(?<![a-z])(?:emulator|simulator|avd|sdk|android|webview|chromium|chrome|build|buildtools|version|revision|release|node|npm|pnpm|yarn|gradle|agp|jdk|java|kotlin|typescript|oxlint|rspack|vitest|playwright|capacitor)(?![a-z])|模拟器|版本|固件|内核)/i

/**
 * 主机 / 地址语义词表（否决）：出现任意一个，本行的版本语境豁免立即作废。
 * 前一半直接指机器（host/server/地址），后一半指环境或迁移动作（生产/线上/迁移/下线）——
 * 这些词配上四段点分十进制，说的就是「一个会被连过去的地址」，不是号。
 */
const HOST_MARKERS =
  /(?:(?<![a-z])(?:ip|ips|host|hosts|hostname|server|servers|url|urls|uri|http|https|ws|wss|endpoint|endpoints|dns|domain|origin|gateway|proxy|backend|production|prod|staging|addr|address|port)(?![a-z])|服务器|服务端|主机|地址|域名|生产|线上|正式服|后端|端口|迁移|下线|旧机|老机|换机)/i

/**
 * 这一行（或上一行）是不是「在说版本号」的语境。
 * 主机语义词一票否决，所以词表再长也漏不到真地址上去。
 */
export const isVersionContext = (line, prevLine = '') => {
  if (HOST_MARKERS.test(line) || HOST_MARKERS.test(prevLine)) return false
  return VERSION_MARKERS.test(line) || VERSION_MARKERS.test(prevLine)
}

/**
 * 一行里「本来就要报」的地址候选（已排除允许段与 ALLOWED_HOSTS，保留出现顺序）。
 */
const collectOffending = (line) => {
  const found = []

  RE_IPV4.lastIndex = 0
  let match
  while ((match = RE_IPV4.exec(line)) !== null) {
    const parts = match.slice(1, 5).map(Number)
    if (parts.some((n) => n > 255)) continue
    const ip = parts.join('.')
    if (ALLOWED_HOSTS.has(ip)) continue
    if (isExemptIpv4(parts[0], parts[1])) continue
    found.push({ ip })
  }

  RE_IPV6.lastIndex = 0
  while ((match = RE_IPV6.exec(line)) !== null) {
    const ip = match[0]
    if (ip === '::1') continue
    if (/^fe80:/i.test(ip) || /^f[cd]/i.test(ip)) continue
    found.push({ ip })
  }

  return found
}

/**
 * 扫一段文本，返回 [{ line, ip }]（行号从 1 起）。
 * 二进制（含 NUL）直接当无命中处理。
 */
export const scanText = (text) => {
  const hits = []
  if (typeof text !== 'string' || text.includes('\u0000')) return hits

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes('.')) continue

    const prevLine = i > 0 ? lines[i - 1] : ''
    // 行内豁免：确需保留地址字面量的地方（已下线主机名单、规范条款号）写 check-ip-allow 并注明理由
    if (line.includes(ALLOW_MARK) || prevLine.includes(ALLOW_MARK)) continue

    const offending = collectOffending(line)
    if (offending.length === 0) continue
    if (isVersionContext(line, prevLine)) continue

    for (const item of offending) hits.push({ line: i + 1, ip: item.ip })
  }
  return hits
}

export { ALLOWED_HOSTS, ALLOW_MARK }
