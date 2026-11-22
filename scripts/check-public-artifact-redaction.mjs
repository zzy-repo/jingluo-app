#!/usr/bin/env node
/**
 * check-public-artifact-redaction.mjs —— 公开产物脱敏门禁（Issue #745 第 3 步）。
 *
 * ## 为什么要有它
 *
 * #745 的事实（2026-11-21 实测，不是推测）：`deepseek-chat-1.4.5.apk` 与 `1.4.6.apk` 的 bundle 里
 * 都 grep 得到 `chatBaseUrl` / `inviteBaseUrl` / `feedbackUrl` 那三个「内网 IP + 高位端口」的地址（#869 起前两个已从配置删除，只剩 `feedbackUrl`）
 * 与 `download.primaryBase` 那个分发地址（具体值看 `config/endpoints.json`，本脚本不复述 ——
 * 复述一遍就成了 `check:ip` 要抓的第二份字面量）。来源是 `config/endpoints.json`：内网联调用的
 * 裸 IP + 高位端口被 `DefinePlugin` 原样打进了 `assets/public/static/js/main.<hash>.js`，
 * **任何下载了公开包的人 `strings` 一下就知道后端在哪台机器的哪个端口上**。
 *
 * 靠什么守住：`check:ip` / `check:endpoints` 守的是**源码**（「不许再写死地址」），它们看不见
 * 产物 —— 构建期注入、别处拼装、`config` 里本来就这么写，全都能合法地进包。所以缺的这一层是
 * **以产物字节为准**的判据：**正式发布包的 bundle 里不许出现内网 IP / 内网端口**。
 *
 * ## 先按形态扫「可疑地址」，再按处置分三类（指挥台 11:12 裁决，2026-11-21）
 *
 * bundle 里 `http://` 有一百多处，绝大多数是**合法的**：XML 命名空间（`http://www.w3.org/2000/svg`
 * 这类标签名的一部分）、占位域名（`redacted.local`）、公网 https 域名。把它们一律判红，门禁第一次
 * 上线就得关掉。所以这道门禁分两层：**形态层**只负责把「可能是地址的字节」捞出来，
 * **处置层**才决定它是红是绿。
 *
 * ### 形态层（R1 / R1b / R2，只回答「像不像一个要连的地址」）
 *
 *   R1 **内网 / 裸 IP 主机**：`http(s)://<IPv4>` 或 `://<IPv4>:<port>` 形态 —— 主机是 IP 字面量。
 *   R2 **内网端口**：出现 `:<port>` 且 port 落在**内网端口表**里 —— 表从配置**动态派生**
 *      （配置里每个 URL 的显式端口 ∪ `allowedPorts`），不在本脚本里抄第二份。
 *   R1b **裸 IP 主机字面量**（R1 的补充，只认 config 登记过 / 私有段）：引号包着的一串裸四段十进制
 *      （`legacyHosts` 里那些旧主机就是这么被 `apiConfig.ts` 的 `LEGACY_HOSTS` 打进包的）。
 *      只在**登记过或私有段**上判 —— 四段十进制和版本号在语法上无法区分（`"<段>.<段>.<段>.<段>"`
 *      既是版本号也是合法 IP），全判会把产物里任何一个版本字符串变成假红。
 *
 * ### 处置层（这一层是本单 #745 第四步的改动）
 *
 * 口诀：**清的不是「产物里不许出现 IP」，是「产物里不许出现已经没用的旧地址」。**
 *
 * | 类 | 判据（可机械判定） | 输出 | 计入红？ |
 * | --- | --- | --- | --- |
 * | **产品端点** | 命中地址的**来源字段** ∈ `PRODUCT_ENDPOINT_FIELDS`（`consume.baseUrl` / `pay.baseUrl` / `download.fallbackBase`）—— 客户端真要连它，删了功能就废 | `[OK-ENDPOINT]` | **否** |
 * | **旧池地址** | 来源字段 ∈ `LEGACY_FIELDS`（`feedbackUrl` / `legacyHosts[]` / `allowedHosts[]` / `allowedPorts[]`）—— 已下线或没有调用方 | `[FAIL-LEGACY]` | **是** |
 * | **未登记 / 未裁决** | 其它：配置里根本没登记，或登记在一个**既不在产品端点表、也不在旧池表**的字段上 | `[FAIL-UNREGISTERED]` | **是** |
 * | **争议域名** | 主机 ∈ `DISPUTED_HOSTS`（目前只有 `sub2api.rose7.cn`） | `[WARN-DISPUTED]` | **否**（等 #745 的 A/B/C 裁决） |
 *
 * 三条不许踩的线：
 *   1. **只做分类，不许放宽**。旧池与未登记仍然必须红；把它们从红里摘出去不是分类，是拆门禁。
 *   2. **一个地址只许落一类**。先分类再计数（`classifyAddress` 是 `(host, port)` 的纯函数），
 *      `summarize` 里有一条断言：同一个 `(host, port)` 落进两个类就 **exit 2**（自相矛盾的报告
 *      比红更坏 —— 读的人不知道信哪一行）。
 *   3. **同一地址既像产品端点又像旧池时，按产品端点算**（客户端真要连的字段赢），
 *      并在那一行把「为什么归这一类」打印出来（`同时也在 config.endpoints.<旧字段>`）。
 *
 * `sub2api.rose7.cn` **刻意不硬判红也不硬判绿**：`#624` 说它是生产 https 实例，指挥台 11:12 裁决
 * 说它与本项目无关。两边都还在桌上，硬判任何一边都是拿门禁去投票。所以只 WARN + 点名，
 * 等 #745 的 A/B/C 裁决 —— 裁决出来以后，要么把它加进 `PRODUCT_ENDPOINT_FIELDS`，
 * 要么连 `DISPUTED_HOSTS` 这一条一起删掉，都是一行改动。
 *
 * **不判的也要记账**（不静默）：XML 命名空间、占位 / 保留域名、争议域名逐类计数并打印名字与处数。
 * 这条规矩来自 #678：门禁「看起来在守」、底下却有一整类东西从没被看过，是最坏的绿。
 *
 * ## 允许清单从哪来（不写死第二份）
 *
 * 读 `config/endpoints.json`（唯一事实来源，路径来自 `scripts/lib/endpointsSchema.mjs` 的
 * `ENDPOINTS_FILE`）：
 *   · `allowedHosts` / `allowedPorts` / `consume.baseUrl` / `feedbackUrl` /
 *     `legacyHosts` / `download.primaryBase` 全部递归遍历，凡是「字符串里是 http(s) URL」或
 *     「裸四段十进制」的，记进**内网地址表**（带字段名，用于点名）；`allowedPorts` 里的整数记进
 *     内网端口表。换机器只改那份 JSON，这里不用同步。
 *   · **登记 ≠ 允许，登记 = 能点名**：登记只用来（a）生成报错里的「在 config.endpoints.<字段>」，
 *     （b）把命中分到「产品端点 / 旧池 / 未登记」三类 —— 三分靠的是**字段名**（`PRODUCT_ENDPOINT_FIELDS`
 *     / `LEGACY_FIELDS` 两份表，只写字段名不写地址值），不是地址本身。
 *   · 「哪些字段算产品端点」是**裁决**，不是配置：所以那两份表在本脚本里，且只有字段名。
 *     地址值一律现读 `config/endpoints.json` —— 配置改了、表不用改。
 *
 * ## 用法
 *
 *   node scripts/check-public-artifact-redaction.mjs <apk>                 # 已构建的 APK（首选）
 *   node scripts/check-public-artifact-redaction.mjs --dist dist          # 没有 APK 时扫产物目录
 *   node scripts/check-public-artifact-redaction.mjs <apk> --allow-host 10.0.0.5 --allow-port 60010
 *   node scripts/check-public-artifact-redaction.mjs <apk> --json
 *   pnpm run check:public-artifact-redaction -- <apk>
 *
 * 退出码：
 *   0  干净：没有「旧池」也没有「未登记」（产品端点与争议域名不计红）
 *   1  发现旧池地址或未登记 / 未裁决地址（逐条点名，附 config 字段来源）
 *   2  判不了（APK 打不开 / 不是 zip / 包里没有 bundle / 产物目录没有可扫文件 / 配置读不了 / 用法错
 *      / 分类自相矛盾 —— 同一地址落进两个类）
 *      —— 判不了一律当失败：不知道有没有泄漏，不等于没有泄漏。
 *
 * ## 接线边界（别接进 ci.yml）
 *
 * CI 里没有已构建的 APK（APK 只在签名机上出），所以这道门禁**不进 ci.yml**，它属于**发布前**检查
 * （见 `docs/RELEASE-CHECKLIST.md` 的 B3b）。L0 用例在 `tests/unit/public-artifact-redaction.test.mjs`，
 * 用的是临时产物目录与临时配置，不依赖 APK，所以每次 `pnpm test` 都会跑到判定逻辑本身。
 *
 * ## 与 #745 修复的关系
 *
 * 门禁建好时**现有包就是红的**（现状确实不合格）。`config/endpoints.json` 是外部契约（等后端给
 * https 域名），本单不动它（P0 在等裁决）。所以在 #745 收口之前，这道门禁**不是发布阻塞门**：
 * 先在发布前人工跑、把输出记进 issue；#745 收口后再转硬门。
 *
 * bundle 里 `http://` 的四类分布（多少是命名空间、多少是内网地址）实测在
 * `docs/public-artifact-http-audit.md`（#745 第一步），不在这里重复。
 *
 * ## 曾经的 `check:redaction`（#750）已退场
 *
 * #750 曾并存过一条同题门禁，口径是「基线登记存量、只减不增」，且内网主机 / 端口是脚本里
 * **写死的两份清单** —— 那正是本仓库反复要避免的「第二份真相源」（配置改了、清单不改就漏判）。
 * 现在只有本门禁：**按处置三分类，旧池与未登记命中即红**，主机 / 端口表从 `config/endpoints.json`
 * 动态读，判不了就是 exit 2。（退场理由与取舍见 #753。）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listZipEntries, readZipEntryRecord } from '../deploy/dl-release/apk-manifest.mjs'
import { ENDPOINTS_FILE } from './lib/endpointsSchema.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 退出码（CLI 与单测共用，别在测试里另写一遍数字） */
export const EXIT = Object.freeze({ CLEAN: 0, LEAK: 1, UNKNOWN: 2 })

/**
 * 处置分类（命中最终只能落在四类之一 + 一个「显式放行」的横切开关）。
 * 名字即输出标签的语义，别在别处另写字符串。
 */
export const CLASS = Object.freeze({
  /** `[OK-ENDPOINT]` 产品端点：客户端真要连，产物里出现是功能需要，不许"清零" */
  ENDPOINT: 'endpoint',
  /** `[FAIL-LEGACY]` 旧池地址：已下线 / 没有调用方，命中即红 */
  LEGACY: 'legacy',
  /** `[FAIL-UNREGISTERED]` 未登记 / 未裁决：默认红（宁可红，也不替人猜它有用） */
  UNREGISTERED: 'unregistered',
  /** `[WARN-DISPUTED]` 争议域名：关系待裁决，不计入红也不计入绿 */
  DISPUTED: 'disputed',
})

/** 输出标签（一处定义，报告与用例都照它比） */
export const CLASS_TAG = Object.freeze({
  [CLASS.ENDPOINT]: '[OK-ENDPOINT]',
  [CLASS.LEGACY]: '[FAIL-LEGACY]',
  [CLASS.UNREGISTERED]: '[FAIL-UNREGISTERED]',
  [CLASS.DISPUTED]: '[WARN-DISPUTED]',
})

/** 计入红的类（**只有这两个**：分类不许把任何一类悄悄变绿） */
const RED_CLASSES = Object.freeze([CLASS.LEGACY, CLASS.UNREGISTERED])

/**
 * 产品端点字段：客户端真要连的服务，`config/endpoints.json` 里这几个字段的值出现在产物里
 * **是功能需要，不是泄漏**（指挥台 11:12 裁决第 4 条）。只写字段名，地址值仍在配置里。
 *
 * `consume.baseUrl`（#869）：统一网关 BASE，登录 / 推理 / 购买链接都连它，是产品端点。它取代了已删除的
 * `chatBaseUrl`。此前它不在表里，是因为旧域名 `sub2api.rose7.cn` 是**争议域名**（`DISPUTED_HOSTS`）；
 * 现在配置里的 base 是 `apia.ecsafe.cn`，与 `pay.baseUrl` 同主机，同一个地址只落「产品端点」一类。
 */
export const PRODUCT_ENDPOINT_FIELDS = new Map([
  ['consume.baseUrl', '统一网关 BASE：登录 / 推理 / 购买链接（src/services/api/environment.ts，#869）'],
  ['pay.baseUrl', '买卡支付（src/services/ours/api.ts）'],
  ['download.fallbackBase', '分发回退机（src/services/updateManifest.ts）'],
])

/**
 * 旧池字段：已经没用的旧地址，出现在公开产物里就是泄漏，必须清零。
 *
 * `download.primaryBase` **不在这张表里**，也不在产品端点表里 —— 它落在「未裁决」那一类
 * （判红，见 `classifyAddress`）。理由：`docs/public-artifact-http-audit.md` 说它还有调用方
 * （`src/services/updateManifest.ts` 拉 `${base}/releases.json`），而 11:12 裁决的处置表没点名
 * 它。这个矛盾还没裁决，所以**判红而不是猜绿**：猜绿等于替裁决投票，猜红只是保持现状。
 */
export const LEGACY_FIELDS = new Map([
  ['feedbackUrl', '指挥台 11:12 裁决归入旧池（删前先 grep 调用方 0 处）'],
  ['legacyHosts', '已下线主机重写表：这些主机只用来「被拒绝」，没有调用方'],
  ['allowedHosts', '白名单里的旧 IP：给 check:ip 放行源码用，客户端并不连它'],
  ['allowedPorts', '内网端口表：只描述联调机开哪几个端口，客户端不连'],
])

/**
 * 争议域名：与本项目的关系**待裁决**，所以既不硬判红也不硬判绿（`[WARN-DISPUTED]`，不计入红）。
 *
 * 目前只有一条，且是**裁决状态**而不是配置数据 —— 它绝不从 `config/endpoints.json` 派生，
 * 因为「这个域名跟本项目有没有关系」不是配置能回答的问题。裁决落地后二选一：
 * 判定为生产实例 → 把它加进 `PRODUCT_ENDPOINT_FIELDS` 并删掉这一条；
 * 判定为无关 / 该删 → 只删这一条（`config/endpoints.json` 里那一项由 P0 单独改）。
 */
export const DISPUTED_HOSTS = new Map([
  ['sub2api.rose7.cn', '#624 说它是生产 https 实例；指挥台 11:12 裁决说与本项目无关'],
])

/** 争议域名的说明文案（报告与用例共用一份，免得两处措辞漂移） */
const DISPUTED_WHY = (host) =>
  `争议域名：该域名与本项目关系待 #745 裁决（#624 vs 11:12）—— ${DISPUTED_HOSTS.get(host) ?? ''}`.trim()

/** 单个 zip 条目最多解压多少字节（与 deploy/dl-release/apk-consume.mjs 同口径，防畸形包吃光内存） */
const MAX_ENTRY_BYTES = 48 * 1024 * 1024

/** APK 里哪些条目算「bundle」：assets 下的文本类产物（.js 为主，index.html / build-info.json 一起看） */
const APK_BUNDLE_ENTRY_RE = /^assets\/.*\.(?:js|mjs|json|html?|css|txt|xml)$/i

/** `--dist` 模式扫的扩展名：与 APK 内同一套「文本产物」口径 */
const DIST_TEXT_EXT = new Set(['.js', '.mjs', '.json', '.html', '.htm', '.css', '.txt', '.xml'])

/**
 * XML 命名空间主机：这些 URL 不是「服务地址」，是 SVG / XHTML / XLink 标签名的一部分。
 * 命中就计数跳过（打印处数），不算违规 —— 否则门禁第一天就红在自己身上。
 */
const XMLNS_HOSTS = new Set(['www.w3.org', 'w3.org', 'schemas.android.com', 'ns.adobe.com'])

/** 保留 / 占位域名后缀：不是可连地址（文档占位、脱敏样例、本机名），判「占位」跳过并计数 */
const PLACEHOLDER_SUFFIXES = ['.local', '.test', '.example', '.invalid', '.localhost', '.example.invalid']
/** 占位主机名本身（不含后缀匹配） */
const PLACEHOLDER_HOSTS = new Set(['localhost', 'example', 'invalid', 'redacted'])

/** 私有 / 保留 IPv4 段：裸 IP 字面量落在这里就是泄漏（不用查配置也判） */
const PRIVATE_RANGES = [
  [/^10\./, '10/8'],
  [/^127\./, '127/8 回环'],
  [/^169\.254\./, '169.254/16 链路本地'],
  [/^192\.168\./, '192.168/16'],
  [/^172\.(?:1[6-9]|2\d|3[01])\./, '172.16/12'],
  [/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, '100.64/10 CGNAT'],
  [/^192\.0\.2\./, '192.0.2/24 文档段'],
  [/^198\.51\.100\./, '198.51.100/24 文档段'],
  [/^203\.0\.113\./, '203.0.113/24 文档段'],
]

/** 四段十进制的**规范**写法（不许有前导零；产物里那种「三段补零的四段数字表」不会被误判成 IP） */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)

/** `http(s)://<authority><rest>`：只认显式 scheme（协议相对 `//x` 在产物里几乎都是注释/语法，不碰） */
const SCHEME_URL_RE = /\b(https?):\/\/([^\s/?#"'`<>()\\|]+)([^\s"'`<>()\\|]*)/gi

/** 引号包着的裸四段十进制：只认字符串字面量形态，避免把数字表 / 版本号误伤 */
const QUOTED_IPV4_RE = /(['"`])(\d{1,3}(?:\.\d{1,3}){3})\1/g

/** 端口出现：`:60010`；后面不许还跟数字（`:600101` 不是 60010） */
const PORT_RE = /:(\d{2,5})(?!\d)/g

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

// ------------------------------------------------------------------ 配置 → 内网地址表

/** 递归遍历配置，按 key 路径回调（数组用 `[i]`，便于点名 `legacyHosts[0]`） */
const walkConfig = (node, keyPath, visit) => {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walkConfig(value, `${keyPath}[${index}]`, visit))
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      walkConfig(value, keyPath ? `${keyPath}.${key}` : key, visit)
    }
    return
  }
  if (typeof node === 'string' || typeof node === 'number') visit(node, keyPath)
}

const normalizeHost = (host) => String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')

/** 解析成 http(s) URL；不是绝对 http(s) 地址返回 null */
const parseHttpUrl = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * 从配置原文派生「内网地址表」「内网端口表」与「全部登记主机表」（**唯一**来源：不改第二份名单）。
 *
 * 三张表的用途不同，别混：
 *   · `addresses` / `hosts` —— 只装**内网形态**（IP 字面量 / 主机带端口），用来判「形态层」命中；
 *   · `ports` —— 内网端口表；
 *   · `knownHosts` —— **所有**在配置里出现过的 URL 主机（含 `dl.rose7.cn` 这种公网域名）。
 *     只服务两件事：把命中按字段名分类（处置层）、以及发现 `DISPUTED_HOSTS` 里的域名已经不在
 *     配置里了（裁决落地后忘了删 → 打印提示，不静默）。
 *
 * @param {object} raw `config/endpoints.json` 解析后的对象
 * @param {string} [configFile] 仅用于报错文案
 * @returns {{configFile:string, addresses:Array<{key:string,host:string,port:number|null,url:string|null}>,
 *            hosts:Map<string,Array<{key:string,port:number|null,url:string|null}>>,
 *            knownHosts:Map<string,Array<{key:string,port:number|null,url:string|null}>>,
 *            ports:Map<number,string[]>}}
 */
export function buildPolicy(raw, configFile = ENDPOINTS_FILE) {
  const addresses = []
  const known = []
  const ports = new Map()

  const addPort = (port, key) => {
    const list = ports.get(port) ?? []
    if (!list.includes(key)) list.push(key)
    ports.set(port, list)
  }

  walkConfig(raw, '', (value, key) => {
    // `allowedPorts` 里的整数就是「内网端口表」的一部分；其余数字（timeoutMs 之类）不看，
    // 否则 `timeoutMs.read = 10000` 会把 10000 变成内网端口。
    if (typeof value === 'number') {
      if (/allowedPorts\[\d+\]$/.test(key) && Number.isInteger(value) && value > 0 && value < 65536) {
        addPort(value, key)
        addresses.push({ key, host: '', port: value, url: null })
      }
      return
    }
    const text = value.trim()
    if (!text) return

    const url = parseHttpUrl(text)
    if (url) {
      const host = normalizeHost(url.hostname)
      const port = url.port ? Number(url.port) : null
      // 登记主机：**不分公网 / 内网**都记，分类时才不会把产品端点当成「未登记」
      known.push({ key, host, port, url: text })
      if (IPV4_RE.test(host) || host.includes(':')) {
        addresses.push({ key, host, port, url: text })
        if (port) addPort(port, key)
      } else if (port) {
        // 域名 + 显式端口：主机不判，但端口进了内网端口表（例如将来 https 化了还想留 60010）
        addPort(port, key)
        addresses.push({ key, host, port, url: text })
      }
      return
    }
    // 裸主机（`legacyHosts` / `allowedHosts` 就是这种写法）
    if (IPV4_RE.test(text) || text.includes(':')) {
      const host = normalizeHost(text)
      addresses.push({ key, host, port: null, url: null })
      known.push({ key, host, port: null, url: null })
    }
  })

  const group = (entries) => {
    const map = new Map()
    for (const entry of entries) {
      if (!entry.host) continue
      const list = map.get(entry.host) ?? []
      list.push(entry)
      map.set(entry.host, list)
    }
    return map
  }

  return {
    configFile: rel(configFile),
    addresses,
    hosts: group(addresses),
    knownHosts: group(known),
    ports,
    allowHosts: new Set(),
    allowPorts: new Set(),
  }
}

/** 读配置并建表；读不了 / 解析不了 → 抛（CLI 转成 exit 2） */
export function loadPolicy(configFile = ENDPOINTS_FILE) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch (e) {
    throw new Error(`读不了端点配置 ${configFile}：${e.message}`)
  }
  return buildPolicy(raw, configFile)
}

// ------------------------------------------------------------------ 分类

const isPlaceholderHost = (host) => {
  if (PLACEHOLDER_HOSTS.has(host)) return true
  if (PLACEHOLDER_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  // 非 ASCII（例如省略号占位 `https://…/x.zip`）或不是合法主机名 → 当占位，不判
  return !/^[a-z0-9.-]+$/.test(host)
}

const privateRangeOf = (ip) => {
  for (const [re, label] of PRIVATE_RANGES) if (re.test(ip)) return label
  return null
}

/** 从 URL 的 authority 里拆出 host / port（去 userinfo、去 IPv6 方括号） */
const splitAuthority = (authority) => {
  const at = authority.lastIndexOf('@')
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority
  const close = hostPort.lastIndexOf(']')
  if (hostPort.startsWith('[') && close > 0) {
    const host = hostPort.slice(0, close + 1)
    const rest = hostPort.slice(close + 1)
    const m = /^:(\d{1,5})$/.exec(rest)
    return { host, port: m ? Number(m[1]) : null }
  }
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(hostPort)
  if (!m) return { host: hostPort, port: null }
  return { host: m[1], port: m[2] ? Number(m[2]) : null }
}

/** 报错里点名「这个地址出自配置哪个字段」；没有登记就是没有登记 */
const attribution = (keys) =>
  keys?.length ? `在 config.endpoints.${keys.join(' / ')}` : '未在 config.endpoints.json 登记'

const uniq = (list) => [...new Set(list)]

/**
 * 字段**族**：`legacyHosts[0]` → `legacyHosts`。
 * 分类看族（数组下标不改变"这一项属于哪一类"），点名看全键（`legacyHosts[0]` 比 `legacyHosts`
 * 更能让人找到是哪一条）。两张表都按族写。
 */
const fieldFamily = (key) => String(key).replace(/\[\d+\]$/, '')

const keysForPort = (policy, port) => policy.ports.get(port) ?? []

/**
 * 找「这个地址出自配置哪些字段」：**端口优先**，主机次之，端口表兜底。
 *
 * 为什么不能只按主机找：旧池机器上曾有 `chatBaseUrl` / `inviteBaseUrl` / `feedbackUrl` 三个端口（#869 后只剩一个），
 * 只看主机分不开它们；反过来同一台旧机也有**两副面孔** —— `legacyHosts[]` 里的裸主机（要拒的旧机）
 * 与 `download.primaryBase` 的「主机 + 端口」（正在用的分发机），只看主机同样分不开。
 * 所以按这个顺序退让：
 *   1. 带端口且该主机有精确端口登记 → 就是它（这是唯一能区分同机多端口的一步）；
 *   2. 该主机的**裸主机登记**（`legacyHosts` / `allowedHosts` 那种写法，没有端口）；
 *   3. 该主机的全部字段；
 *   4. 主机根本没登记过 → 用**端口表**（`api.somewhere:7002` 这种：主机不判，但端口是内网的）。
 * 退让到越后面，点名越粗；但**永远不静默返回空**，因为「未登记」本身也是一个判定。
 */
const fieldsForAddress = (policy, host, port) => {
  const portKeys = port === null ? [] : keysForPort(policy, port)
  const list = host ? (policy.knownHosts?.get(host) ?? []) : []
  if (!list.length) return uniq(portKeys)
  if (port !== null) {
    const exact = list.filter((entry) => entry.port === port).map((entry) => entry.key)
    if (exact.length) return uniq(exact)
  }
  const bare = list.filter((entry) => entry.port === null).map((entry) => entry.key)
  if (bare.length) return uniq(bare)
  return uniq([...list.map((entry) => entry.key), ...portKeys])
}

/**
 * 判定一个地址（主机 + 端口）属于哪一类 —— **纯函数**，同一个 `(host, port)` 永远落同一类。
 *
 * 判定顺序即优先级（先分类再计数，一条命中只许落一类）：
 *   争议域名 → 产品端点 → 旧池 → 未登记 / 未裁决。
 *
 * 「既在产品端点表又像旧池」的那条命中**按产品端点算**，并把原因打进 `why`：
 * 客户端真要连的字段赢，否则同一个地址会在报告里既"必须清"又"必须留"，读的人只能信一半。
 *
 * @param {ReturnType<typeof buildPolicy>} policy
 * @param {{host?:string, port?:number|null}} address
 * @returns {{className:string, fields:string[], why:string}}
 */
export function classifyAddress(policy, { host = '', port = null } = {}) {
  const target = normalizeHost(host)
  if (target && DISPUTED_HOSTS.has(target)) {
    return { className: CLASS.DISPUTED, fields: [], why: DISPUTED_WHY(target) }
  }

  const fields = fieldsForAddress(policy, target, port ?? null)
  const endpoints = fields.filter((key) => PRODUCT_ENDPOINT_FIELDS.has(fieldFamily(key)))
  const legacy = fields.filter((key) => LEGACY_FIELDS.has(fieldFamily(key)))

  if (endpoints.length) {
    const alsoLegacy = legacy.length
      ? `；同时也在 config.endpoints.${legacy[0]}，按「产品端点优先」归类（客户端真要连的字段赢）`
      : ''
    return {
      className: CLASS.ENDPOINT,
      fields: endpoints,
      why: `产品端点（${attribution(endpoints)}：${PRODUCT_ENDPOINT_FIELDS.get(fieldFamily(endpoints[0]))}）${alsoLegacy}`,
    }
  }
  if (legacy.length) {
    // 理由只归给**第一个**字段（那是这条地址的主要出处）；其余同族字段只点名，
    // 免得把某一个字段的理由误安到另一个字段头上。
    const others = legacy.length > 1 ? `；同一条也登记在 ${legacy.slice(1).map((key) => `config.endpoints.${key}`).join(' / ')}` : ''
    return {
      className: CLASS.LEGACY,
      fields: legacy,
      why: `旧池地址（${attribution([legacy[0]])}：${LEGACY_FIELDS.get(fieldFamily(legacy[0]))}${others}）`,
    }
  }
  if (fields.length) {
    return {
      className: CLASS.UNREGISTERED,
      fields,
      why: `未裁决字段（${attribution(fields)}，该字段既不在产品端点表、也不在旧池表 —— 先判红，等裁决）`,
    }
  }
  return { className: CLASS.UNREGISTERED, fields: [], why: '未在 config.endpoints.json 登记' }
}


/**
 * 扫一段产物文本，返回分类统计 + 逐条命中（**纯函数**，CLI 与单测共用）。
 *
 * @param {string} text 产物文本
 * @param {{file?:string, policy:ReturnType<typeof buildPolicy>, allowHosts?:Set<string>, allowPorts?:Set<number>}} options
 * @returns {{file:string, stats:object, skips:object, hits:Array<object>}}
 */
export function scanText(text, { file = '', policy, allowHosts = new Set(), allowPorts = new Set() } = {}) {
  const stats = {
    urls: 0,
    publicHosts: 0,
    disputedHosts: 0,
    ipHosts: 0,
    ipHostPorts: 0,
    internalPorts: 0,
    bareHosts: 0,
    unjudgedBare: 0,
  }
  const skip = {
    xmlns: 0,
    placeholder: 0,
    template: 0,
    xmlnsNames: new Map(),
    placeholderNames: new Map(),
    templateNames: new Map(),
  }
  /** 记下所有 URL 的字符区间：URL 内部的 `:port` 不再重复算一遍「独立端口」 */
  const spans = []
  const hits = []

  const bump = (map, name) => map.set(name, (map.get(name) ?? 0) + 1)

  /**
   * 记一条命中：顺手按 `(host, port)` 归一次类（`classifyAddress`）。
   * 类别 / 来源字段 / 归类理由在**落下那一刻**就定好 —— 报告不再二次判断，
   * 否则「谁算红」就有两份实现，两份迟早不一致。
   */
  const record = (hit) => {
    const cls = classifyAddress(policy, { host: hit.host ?? '', port: hit.port ?? null })
    hits.push({ ...hit, className: cls.className, fields: cls.fields, why: cls.why })
  }

  /** 拼 detail：空段丢掉，用 ` · ` 连（报告里一眼能读完一行） */
  const detailOf = (...parts) => parts.filter(Boolean).join(' · ')

  for (const match of String(text).matchAll(SCHEME_URL_RE)) {
    const [raw, scheme, authority, rest] = match
    const start = match.index ?? 0
    spans.push([start, start + raw.length])
    stats.urls += 1

    const { host: rawHost, port } = splitAuthority(authority)
    const host = normalizeHost(rawHost)
    const token = `${scheme.toLowerCase()}://${authority}${(rest ?? '').split(/[?#]/)[0].slice(0, 60)}`

    // 争议域名：与本项目的关系待 #745 裁决 → **WARN + 点名**，既不判红也不判绿。
    // 放在 IP / 占位判定之前：它既不是「内网 IP」，也不该被算进「公网域名（不判）」那笔账 ——
    // 那笔账的意思是「看过了、确认无害」，而争议域名是「看过了、还不知道」。
    if (DISPUTED_HOSTS.has(host)) {
      stats.disputedHosts += 1
      record({ kind: 'disputed-host', file, token, host, port, allowed: false, detail: '' })
      continue
    }

    if (IPV4_RE.test(host) || host.includes(':')) {
      stats.ipHosts += 1
      const portInTable = port !== null && policy.ports.has(port)
      if (portInTable) stats.ipHostPorts += 1
      const range = IPV4_RE.test(host) ? privateRangeOf(host) : 'IPv6 字面量'
      // 放行要**两个维度都给**：主机放行了、端口没放行，仍然是红 —— 否则 `--allow-host X`
      // 会顺手把 `X:任意端口` 全放过，而「这台机器的哪个端口」正是 #745 要藏的东西。
      const hostAllowed = allowHosts.has(host)
      const portAllowed = port === null || allowPorts.has(port)
      record({
        kind: 'ip-host',
        file,
        token,
        host,
        port,
        allowed: hostAllowed && portAllowed,
        detail: detailOf(
          `内网 IP${range ? `（${range}）` : ''}`,
          portInTable ? `端口 ${port} 也在内网端口表` : '',
          hostAllowed && !portAllowed ? `主机已放行但端口 ${port} 没放行（缺 --allow-port ${port}）` : ''
        ),
      })
      continue
    }

    if (XMLNS_HOSTS.has(host)) {
      skip.xmlns += 1
      bump(skip.xmlnsNames, host)
      continue
    }
    if (isPlaceholderHost(host)) {
      // 分成两笔账：真正的占位域名（`redacted.local` / `localhost`）与模板 / 无法解析的主机
      // （`https://${t}`、被截断的文案）。都跳过，但各自计数，看输出就知道哪一类变多了。
      const bucket = /^[a-z0-9.-]+$/.test(host) ? 'placeholder' : 'template'
      skip[bucket] += 1
      bump(bucket === 'placeholder' ? skip.placeholderNames : skip.templateNames, host)
      continue
    }

    stats.publicHosts += 1
    // 端口维度只在**真主机**上判：占位 / 模板域名不指向任何机器，`example.test:60012`
    // 除了「某个端口号」什么都没泄漏（这也是 #745 收口后的目标形态：域名 + 端口不算泄漏）。
    if (port !== null && policy.ports.has(port)) {
      stats.internalPorts += 1
      record({
        kind: 'internal-port',
        file,
        token,
        host,
        port,
        allowed: allowPorts.has(port),
        detail: `内网端口 ${port}`,
      })
    }
  }

  // 裸四段十进制字面量：只判「配置里登记过」或「落在私有 / 保留段」的，
  // 其余四段数字（版本号 `"1.2.3.4"`、压缩表里的数字）不判 —— 但计数打印，不做静默丢弃。
  for (const match of String(text).matchAll(QUOTED_IPV4_RE)) {
    const ip = match[2]
    if (!IPV4_RE.test(ip)) continue
    const registered = policy.hosts.has(ip)
    const range = privateRangeOf(ip)
    if (!registered && !range) {
      stats.unjudgedBare += 1
      continue
    }
    stats.bareHosts += 1
    record({
      kind: 'bare-host',
      file,
      token: ip,
      host: ip,
      port: null,
      allowed: allowHosts.has(ip),
      detail: detailOf('裸 IP 主机字面量', range ? `（${range}）` : ''),
    })
  }

  // URL 之外的 `:port`：例如 `"legacy-upstream:60010"` 这种不带 scheme 的 `主机:端口` 字面量。
  // URL 内部的端口已在上面按主机形态判过，不重复算一遍。
  const inUrl = (index) => spans.some(([a, b]) => index >= a && index < b)
  for (const match of String(text).matchAll(PORT_RE)) {
    const port = Number(match[1])
    if (!policy.ports.has(port)) continue
    const index = match.index ?? 0
    if (inUrl(index)) continue
    stats.internalPorts += 1
    record({
      kind: 'internal-port',
      file,
      token: `:${port}`,
      host: '',
      port,
      allowed: allowPorts.has(port),
      detail: `内网端口 ${port}`,
    })
  }

  return { file, stats, skips: skip, hits }
}

// ------------------------------------------------------------------ 输入：APK / 产物目录

/**
 * 扫一份 APK（zip 字节）：取出 assets 下的文本产物，逐份分类。
 *
 * @returns {{sources:string[], results:Array<ReturnType<typeof scanText>>, problems:string[], reason:string|null}}
 */
export function inspectApk(apkBuf, { policy, allowHosts, allowPorts }) {
  let entries
  try {
    entries = listZipEntries(apkBuf)
  } catch (e) {
    return { sources: [], results: [], problems: [], reason: `不是可读的 APK（zip）：${e.message}` }
  }

  const bundleEntries = entries.filter((entry) => APK_BUNDLE_ENTRY_RE.test(entry.name))
  if (bundleEntries.length === 0) {
    return {
      sources: [],
      results: [],
      problems: [],
      reason: `APK 里没有可扫描的 bundle（assets/**/*.js 一条都没有，共 ${entries.length} 个 zip 条目）`,
    }
  }

  const results = []
  const sources = []
  const problems = []
  for (const entry of bundleEntries) {
    if (entry.plainSize > MAX_ENTRY_BYTES) {
      problems.push(`${entry.name} 超过 ${MAX_ENTRY_BYTES} 字节，未扫描`)
      continue
    }
    let text
    try {
      text = readZipEntryRecord(apkBuf, entry, MAX_ENTRY_BYTES).toString('utf8')
    } catch (e) {
      problems.push(`${entry.name} 解压失败：${e.message}`)
      continue
    }
    sources.push(entry.name)
    results.push(scanText(text, { file: entry.name, policy, allowHosts, allowPorts }))
  }

  if (sources.length === 0) {
    return {
      sources,
      results,
      problems,
      reason: `APK 里 ${bundleEntries.length} 个 bundle 条目一个都没能读出来（${problems.join('；')}）`,
    }
  }
  return { sources, results, problems, reason: null }
}

/** 扫一个已构建的产物目录（`--dist`）；没有可扫文件同样判不了 */
export function inspectDist(dir, { policy, allowHosts, allowPorts }) {
  let stat
  try {
    stat = fs.statSync(dir)
  } catch (e) {
    return { sources: [], results: [], problems: [], reason: `产物目录不存在或读不了：${dir}（${e.code ?? e.message}）` }
  }
  if (!stat.isDirectory()) {
    return { sources: [], results: [], problems: [], reason: `--dist 要给目录，不是一个文件：${dir}` }
  }

  const files = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!DIST_TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
      if (entry.name.endsWith('.map')) continue
      files.push(full)
    }
  }
  walk(dir)
  files.sort()

  if (files.length === 0) {
    return { sources: [], results: [], problems: [], reason: `产物目录里没有可扫描的文本产物（.js/.html/.json）：${dir}` }
  }

  const results = files.map((file) =>
    scanText(fs.readFileSync(file, 'utf8'), {
      file: rel(file),
      policy,
      allowHosts,
      allowPorts,
    })
  )
  return { sources: files.map(rel), results, problems: [], reason: null }
}

// ------------------------------------------------------------------ 汇总 / 输出

/**
 * 汇总逐条命中：**同一个地址 + 同一份产物**只占一行（打 `×N`），
 * 因为压缩后的 bundle 是单行，同一个常量出现两次会打两行一模一样的字，谁都不会读完。
 *
 * 汇总只做一件事：**按类别分桶 + 计数**（判定在 `classifyAddress` 已经做完）。
 * 分桶之后立刻跑一次**去重断言**（`assertOneClass`）：同一个地址落进两个类就抛 —— CLI 转成
 * exit 2。理由：分类判据有 bug 时，最坏的后果不是少报一条，而是**报告自相矛盾**
 * （同一行地址既"必须清"又"必须留"），读的人只会不知道信哪一行。宁可判不了。
 */
export function summarize(results) {
  const byKey = new Map()
  for (const result of results) {
    for (const hit of result.hits) {
      const key = `${hit.kind}\u0000${hit.file}\u0000${hit.token}`
      const seen = byKey.get(key)
      if (seen) seen.count += 1
      else byKey.set(key, { ...hit, count: 1 })
    }
  }
  // 输出顺序要稳定（同一份产物跑两次、跨机器跑，报错行要一模一样），否则 diff 里全是噪音
  const all = [...byKey.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.token.localeCompare(b.token) || a.kind.localeCompare(b.kind)
  )
  assertOneClass(all)

  const byClass = {
    [CLASS.ENDPOINT]: [],
    [CLASS.LEGACY]: [],
    [CLASS.UNREGISTERED]: [],
    [CLASS.DISPUTED]: [],
  }
  const allowed = []
  for (const hit of all) {
    if (hit.allowed) {
      allowed.push(hit)
      continue
    }
    ;(byClass[hit.className] ?? byClass[CLASS.UNREGISTERED]).push(hit)
  }
  const counts = {
    [CLASS.ENDPOINT]: byClass[CLASS.ENDPOINT].length,
    [CLASS.LEGACY]: byClass[CLASS.LEGACY].length,
    [CLASS.UNREGISTERED]: byClass[CLASS.UNREGISTERED].length,
    [CLASS.DISPUTED]: byClass[CLASS.DISPUTED].length,
    allowed: allowed.length,
  }
  /** 只有「旧池」与「未登记」计入红 —— 这两类的判定口径一个字都没放宽 */
  const denied = RED_CLASSES.flatMap((name) => byClass[name])

  const totals = {
    urls: 0,
    publicHosts: 0,
    disputedHosts: 0,
    ipHosts: 0,
    ipHostPorts: 0,
    internalPorts: 0,
    bareHosts: 0,
    unjudgedBare: 0,
  }
  const skip = {
    xmlns: 0,
    placeholder: 0,
    template: 0,
    xmlnsNames: new Map(),
    placeholderNames: new Map(),
    templateNames: new Map(),
  }
  for (const result of results) {
    for (const key of Object.keys(totals)) totals[key] += result.stats[key] ?? 0
    for (const key of ['xmlns', 'placeholder', 'template']) {
      skip[key] += result.skips[key] ?? 0
      for (const [name, count] of result.skips[`${key}Names`] ?? []) {
        skip[`${key}Names`].set(name, (skip[`${key}Names`].get(name) ?? 0) + count)
      }
    }
  }
  return { totals, skips: skip, byClass, counts, denied, allowed, hits: all }
}

/**
 * 去重断言：**同一个地址（host+port）只许落一类**，同一个 token 也只许落一类。
 * 违反就抛（CLI → exit 2）。这不是防御性编程，是判据的契约：`classifyAddress` 是纯函数，
 * 一旦这里抛了，说明分类被改坏了（例如有人又加了一条「按 IP 判」的分支）。
 */
function assertOneClass(hits) {
  const byAddress = new Map()
  const byToken = new Map()
  for (const hit of hits) {
    const address = `${hit.host ?? ''}\u0000${hit.port ?? ''}\u0000${hit.allowed ? 'allow' : hit.className}`
    const key = `${hit.host ?? ''}\u0000${hit.port ?? ''}`
    const previous = byAddress.get(key)
    if (previous && previous !== address) {
      throw new Error(
        `分类自相矛盾：${hit.host || hit.token}${hit.port ? `:${hit.port}` : ''} 同时落进两类 ` +
          `（${previous.split('\u0000').pop()} / ${address.split('\u0000').pop()}）`
      )
    }
    byAddress.set(key, address)

    const seen = byToken.get(hit.token)
    if (seen && seen !== hit.className) {
      throw new Error(`分类自相矛盾：地址 ${hit.token} 同时落进两类（${seen} / ${hit.className}）`)
    }
    byToken.set(hit.token, hit.className)
  }
}

const KIND_LABEL = { 'ip-host': '内网 IP', 'bare-host': '裸 IP 主机', 'internal-port': '内网端口', 'disputed-host': '争议域名' }

const formatNames = (map, limit = 80) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name.length > 24 ? `${name.slice(0, 24)}…` : name}×${count}`)
    .join('、')
    .slice(0, limit)

const usage = () =>
  [
    '用法：',
    '  node scripts/check-public-artifact-redaction.mjs <apk> [--allow-host <ip>]... [--allow-port <port>]... [--json] [--quiet]',
    '  node scripts/check-public-artifact-redaction.mjs --dist <dir> [...]',
    '',
    '退出码：0 干净（无旧池 / 无未登记）/ 1 有旧池或未登记地址 / 2 判不了（打不开 APK、包里没有 bundle、' +
      '配置读不了、用法错、分类自相矛盾）',
  ].join('\n')

/** 解析参数（导出给单测用：参数口径必须是同一份，不能在测试里抄第二套） */
export function parseArgs(argv) {
  const opts = {
    apk: '',
    dist: '',
    config: ENDPOINTS_FILE,
    allowHosts: new Set(),
    allowPorts: new Set(),
    json: false,
    quiet: false,
    help: false,
    problem: '',
  }
  const addHosts = (value) => {
    for (const part of String(value).split(',')) {
      const host = normalizeHost(part)
      if (!host) continue
      if (!IPV4_RE.test(host) && !host.includes(':')) {
        opts.problem = opts.problem || `--allow-host 只接受 IP 字面量（收到 ${part}）：域名本来就不判，不需要放行`
        continue
      }
      opts.allowHosts.add(host)
    }
  }
  const addPorts = (value) => {
    for (const part of String(value).split(',')) {
      const port = Number(String(part).trim())
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        opts.problem = opts.problem || `--allow-port 只接受 1..65535 的整数（收到 ${part}）`
        continue
      }
      opts.allowPorts.add(port)
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (name) => {
      const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null
      if (inline !== null) return inline
      i += 1
      return argv[i] ?? ''
    }
    if (arg === '--') continue
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true
    else if (arg === '--dist' || arg.startsWith('--dist=')) opts.dist = take('--dist')
    else if (arg === '--config' || arg.startsWith('--config=')) opts.config = take('--config')
    else if (arg === '--allow-host' || arg.startsWith('--allow-host=')) addHosts(take('--allow-host'))
    else if (arg === '--allow-port' || arg.startsWith('--allow-port=')) addPorts(take('--allow-port'))
    else if (arg.startsWith('-')) opts.problem = opts.problem || `未知参数：${arg}`
    else if (opts.apk) opts.problem = opts.problem || `只能给一个 APK（已经拿到 ${opts.apk}，又收到 ${arg}）`
    else opts.apk = arg
  }
  if (opts.apk && opts.dist) opts.problem = opts.problem || 'APK 与 --dist 二选一，不要同时给'
  return opts
}

function reportConsole({ opts, policy, inspection, summary }) {
  const mode = opts.dist ? `产物目录 ${rel(opts.dist) || opts.dist}` : `APK ${opts.apk}`
  const internalHosts = [...policy.hosts.keys()]
  console.log(`check:public-artifact-redaction —— 公开产物脱敏（#745）`)
  console.log(`  输入   ${mode}（扫了 ${inspection.sources.length} 个产物文件）`)
  console.log(
    `  配置   ${policy.configFile}：内网主机 ${internalHosts.length} 个 / 内网端口 ${policy.ports.size} 个（动态读取，未写死第二份）`
  )
  if (policy.ports.size === 0) {
    console.log('  注意   配置里没有源出任何内网端口 → R2 端口维度本次不判（不是漏了，是表为空）')
  }
  // 争议域名是**裁决状态**，不是配置数据：裁决落地后忘了删这一条，会让一个配置里已经不存在的
  // 域名永久挂在 WARN 里（谁也不会注意到）。对不上就当场说一句，不静默。
  for (const host of DISPUTED_HOSTS.keys()) {
    if (!policy.knownHosts.has(host)) {
      console.log(
        `  提示   争议域名 ${host} 已不在 ${policy.configFile} 里 —— 若它是被删掉的旧地址（裁决结论），` +
          '请同时删掉 DISPUTED_HOSTS 里那一条'
      )
    }
  }
  for (const problem of inspection.problems) console.log(`  提示   ${problem}`)

  const { totals, skips } = summary
  console.log('')
  console.log('分类统计（形态层：捞出了哪些"像地址的字节"）：')
  console.log(`  http(s):// 出现          ${totals.urls} 处`)
  console.log(`  · 公网 / 普通域名（不判） ${totals.publicHosts} 处`)
  console.log(
    `  · 已跳过 ${skips.xmlns} 处 XML 命名空间（${formatNames(skips.xmlnsNames) || '无'}）、` +
      `${skips.placeholder} 处占位（${formatNames(skips.placeholderNames) || '无'}）、` +
      `${skips.template} 处模板主机（${formatNames(skips.templateNames) || '无'}），不判`
  )
  console.log(
    `  · 判：内网 / 裸 IP 主机    ${totals.ipHosts} 处（其中 ${totals.ipHostPorts} 处的端口也在内网端口表）`
  )
  console.log(
    `  · 判：独立的 :端口        ${totals.internalPorts} 处（内网端口表：${[...policy.ports.keys()].join(' / ') || '空'}）`
  )
  console.log(`  · 判：裸 IP 主机字面量     ${totals.bareHosts} 处`)
  console.log(`  · 争议域名（不算红，待裁决） ${totals.disputedHosts} 处`)
  if (totals.unjudgedBare > 0) {
    console.log(
      `  · 未判的四段数字          ${totals.unjudgedBare} 处（既没在配置里登记、也不在私有段 —— 多为版本号，不判）`
    )
  }

  const allowedNote = () => {
    const granted = []
    if (opts.allowHosts.size) granted.push(`host ${[...opts.allowHosts].join(' / ')}`)
    if (opts.allowPorts.size) granted.push(`port ${[...opts.allowPorts].join(' / ')}`)
    return granted.length ? granted.join('；') : ''
  }

  const line = (tag, hit, suffix = '') => {
    const where = hit.file ? `${hit.file}  ` : ''
    const parts = [hit.why, hit.detail].filter(Boolean).join(' · ')
    return `${tag} ${where}${hit.token} → ${parts}${hit.count > 1 ? ` ×${hit.count}` : ''}${suffix}`
  }

  // 争议域名先打：它既不是红也不是绿，放在两类红中间最容易被误读成"红里的一种"
  if (summary.byClass[CLASS.DISPUTED].length) {
    console.log('')
    for (const hit of summary.byClass[CLASS.DISPUTED]) console.log(line(CLASS_TAG[CLASS.DISPUTED], hit))
  }
  if (summary.byClass[CLASS.ENDPOINT].length) {
    console.log('')
    for (const hit of summary.byClass[CLASS.ENDPOINT]) {
      console.log(line(CLASS_TAG[CLASS.ENDPOINT], hit, '（客户端真要连，删了功能就废 —— 保留，不许"清零"）'))
    }
  }
  for (const name of RED_CLASSES) {
    if (!summary.byClass[name].length) continue
    console.log('')
    for (const hit of summary.byClass[name]) console.log(line(CLASS_TAG[name], hit))
    if (name === CLASS.LEGACY) {
      console.log(
        '  旧池处置：先 grep 调用方，确认 **0 处** 再删 —— 例：grep -rn "<地址>" src/ ；' +
          '删完重出包再跑本门禁。重写表（legacyHosts[]）要连引用它的重写逻辑一起看。'
      )
    }
  }
  if (summary.allowed.length) {
    console.log('')
    console.log(`放行清单（--allow-host / --allow-port 显式给出，仅供联调 / staging 包，正式包不许带）： ${allowedNote()}`)
    for (const hit of summary.allowed) {
      console.log(line('[ALLOW]', hit, '（显式放行）'))
    }
    // 给了但从没命中的白名单：打印出来，避免「以为放行了、其实清单给错了」和「悄悄多放行了一条」
    const usedHosts = new Set(summary.allowed.filter((hit) => hit.host).map((hit) => hit.host))
    const usedPorts = new Set(summary.allowed.filter((hit) => hit.port).map((hit) => hit.port))
    const unused = [
      ...[...opts.allowHosts].filter((host) => !usedHosts.has(host)).map((host) => `host ${host}`),
      ...[...opts.allowPorts].filter((port) => !usedPorts.has(port)).map((port) => `port ${port}`),
    ]
    if (unused.length) console.log(`  本次没命中（清单给错了？）：${unused.join(' / ')}`)
  }

  // 结论行：**四类计数**一行读完（口径见文件头「处置层」那张表）
  const { counts } = summary
  console.log('')
  console.log(
    `结论：产品端点 ${counts[CLASS.ENDPOINT]} 条（允许）/ 旧池地址 ${counts[CLASS.LEGACY]} 条（必须清）/ ` +
      `未登记 ${counts[CLASS.UNREGISTERED]} 条（必须清）/ 争议 ${counts[CLASS.DISPUTED]} 条（待裁决）`
  )
  const red = counts[CLASS.LEGACY] + counts[CLASS.UNREGISTERED]
  console.log(
    red > 0
      ? `exit 1  ← 只要「旧池」或「未登记」> 0（本次 ${red} 条）`
      : 'exit 0  ← 「旧池」与「未登记」都是 0 条（产品端点 / 争议域名不计红）'
  )
}

/**
 * 主流程（导出：单测可以直接跑判定，不必每次起子进程）。
 * @returns {Promise<{code:number, summary?:object, reason?:string}>}
 */
export function run(argv, { stdout = console, cwd = ROOT } = {}) {
  const opts = parseArgs(argv)
  if (opts.help) {
    stdout.log(usage())
    return { code: EXIT.CLEAN }
  }
  if (opts.problem) {
    stdout.error(`${opts.problem}\n${usage()}`)
    return { code: EXIT.UNKNOWN, reason: opts.problem }
  }
  if (!opts.apk && !opts.dist) {
    stdout.error(`没有输入：给一个已构建的 APK，或 --dist <产物目录>\n${usage()}`)
    return { code: EXIT.UNKNOWN, reason: 'no-input' }
  }

  let policy
  try {
    policy = loadPolicy(path.resolve(cwd, opts.config))
  } catch (e) {
    stdout.error(`判不了：${e.message}`)
    return { code: EXIT.UNKNOWN, reason: 'config' }
  }

  const scanOptions = { policy, allowHosts: opts.allowHosts, allowPorts: opts.allowPorts }
  let inspection
  if (opts.apk) {
    let buf
    try {
      buf = fs.readFileSync(path.resolve(cwd, opts.apk))
    } catch (e) {
      stdout.error(`判不了：读不出 ${opts.apk}（${e.code ?? e.message}）`)
      return { code: EXIT.UNKNOWN, reason: 'apk-read' }
    }
    inspection = inspectApk(buf, scanOptions)
  } else {
    inspection = inspectDist(path.resolve(cwd, opts.dist), scanOptions)
  }

  if (inspection.reason) {
    stdout.error(`判不了：${inspection.reason}`)
    return { code: EXIT.UNKNOWN, reason: inspection.reason }
  }

  let summary
  try {
    summary = summarize(inspection.results)
  } catch (e) {
    // 分类自相矛盾（同一地址落进两个类）→ 判不了，不许当干净放过
    stdout.error(`判不了：门禁自检失败 —— ${e.message}`)
    return { code: EXIT.UNKNOWN, reason: 'class-conflict' }
  }

  if (opts.json) {
    stdout.log(
      JSON.stringify(
        {
          mode: opts.dist ? 'dist' : 'apk',
          input: opts.dist ?? opts.apk,
          config: policy.configFile,
          internalHosts: [...policy.hosts.keys()],
          internalPorts: [...policy.ports.keys()],
          disputedHosts: [...DISPUTED_HOSTS.keys()],
          allowHosts: [...opts.allowHosts],
          allowPorts: [...opts.allowPorts],
          scanned: inspection.sources,
          stats: summary.totals,
          skipped: { xmlns: summary.skips.xmlns, placeholder: summary.skips.placeholder },
          counts: summary.counts,
          classes: {
            endpoint: summary.byClass[CLASS.ENDPOINT].map(projectHit),
            legacy: summary.byClass[CLASS.LEGACY].map(projectHit),
            unregistered: summary.byClass[CLASS.UNREGISTERED].map(projectHit),
            disputed: summary.byClass[CLASS.DISPUTED].map(projectHit),
            allowed: summary.allowed.map(projectHit),
          },
          denied: summary.denied.map(projectHit),
          allowed: summary.allowed.map(projectHit),
          verdict: summary.denied.length ? 'leak' : 'clean',
        },
        null,
        2
      )
    )
  } else if (!opts.quiet) {
    reportConsole({ opts, policy, inspection, summary })
  }

  if (!summary.denied.length) {
    if (!opts.quiet && !opts.json) {
      const granted = summary.allowed.length
        ? `（其中 ${summary.allowed.length} 个地址由 --allow-* 显式放行，正式包不许带这些参数）`
        : ''
      console.log(
        `\n通过：产物里没有「旧池地址」也没有「未登记地址」` +
          `（产品端点 ${summary.counts[CLASS.ENDPOINT]} 条按功能需要保留，争议域名 ${summary.counts[CLASS.DISPUTED]} 条待裁决）${granted}。`
      )
    }
    return { code: EXIT.CLEAN, summary }
  }

  if (!opts.json) {
    const kinds = new Set(summary.denied.map((hit) => KIND_LABEL[hit.kind] ?? hit.kind))
    console.error('')
    console.error(
      `清不掉的地址：${summary.counts[CLASS.LEGACY]} 条旧池 + ${summary.counts[CLASS.UNREGISTERED]} 条未登记出现在公开产物里` +
        `（${[...kinds].join(' / ')}）—— 这些包不许公开发布。`
    )
    console.error('  旧池：先 grep 调用方，确认 0 处再删（删完重出包，再跑本门禁复核）。')
    console.error('  未登记：要么在 config/endpoints.json 里登记并裁决它属于哪一类，要么把它从产物里摘掉。')
    console.error('  联调 / staging 包确实需要时，用 --allow-host / --allow-port 显式放行，并把这些参数留在命令记录里。')
  }
  return { code: EXIT.LEAK, summary }
}

/** JSON 输出里每条命中的字段（固定形状：别把内部字段名漏出去，也别少给） */
const projectHit = ({ kind, file, token, detail, why, className, count }) => ({
  kind,
  file,
  token,
  class: className,
  why,
  detail,
  count,
})

/** 只有被直接执行时才跑 CLI（被 import 时不许触发 process.exit） */
const invokedDirectly = () => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exitCode = run(process.argv.slice(2)).code
}
