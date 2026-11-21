# 公开产物 http 字面量审计（Issue #745 第一步）

> **这份文档只读不改**：`config/endpoints.json` 与 `src/` 一个字节都没动，`ci.yml` 没动，没有新增门禁。
> 第二步（收口）等本单的判定结果与放行。
>
> 回答三个问题：**公开产物里到底有多少个 `http://`？哪些是噪音、哪些是内网地址、哪些是真端点？
> 这四个内网地址每一条还有没有代码路径在真请求它？该按哪一级收口、代价多大？**

审计对象（两个真实产物，不是"应该会"）：

| 产物 | 文件 | 大小 | 说明 |
| --- | --- | --- | --- |
| 已发布 | `deepseek-chat-1.4.5.apk` | 6,891,043 B | `release-1.4.5/`，线上那一版 |
| draft | `deepseek-chat-1.4.6.apk` | 6,893,807 B | `release-1.4.6/`，未发 |

两个包的 bundle 字面量**逐个相同**（下文所有计数两边一致），所以这不是某一次构建的意外，是
`config/endpoints.json` 被整体注入的必然结果。

---

## 0. 结论速览

| 问题 | 答案 |
| --- | --- |
| 产物里有几处 `http://`？ | **146 处**，去重 **28 条**（扫 97 个 `.js/.css/.html`） |
| 其中真正要处理的？ | **7 处 / 4 条**（类 3，全是内网 IP 字面量） |
| 其余 139 处？ | 126 处 XML 命名空间 + 13 处正则/占位 —— **无害，不要动** |
| 真实端点有没有被 `http://` 泄漏？ | **没有**。`http://` 里真实端点 0 处；6 条真端点全走 `https://` |
| 四个内网地址**服务器**还活着吗？ | **全活着**（4/4 TCP 通，HTTP 有响应） |
| 四个内网地址**代码路径**还活着吗？ | **两个活、一个死、一个活**：`chatBaseUrl` 活、`feedbackUrl` 活、`62.106.70.167:8888` 活、`inviteBaseUrl` **死** |
| 推荐哪一级？ | **A + B（先做），C 单独放行**：A 立刻生效、B 堵住"再写死一个"，C 才是根因门禁但要改 CI |
| 一句话根因 | 不是"混进了内网 IP"，是 **`__ENDPOINTS__` 被整份注入到 bundle，而其中三个字段是明文 http 的 IP 字面量**；`check:ip` 扫 `src/`+`scripts/`，**产物不在它的射程内** |

---

## 1. 四类统计（这是 #745 要的判据口径）

### 1.1 判据口径：怎么把一条 `http://` 归到某一类

一条 `http://` 命中**按顺序**过下面四道，命中即停（顺序即优先级，避免"既像命名空间又像真地址"这类歧义）：

| 序 | 类 | 判据（可机械判定） | 为什么无害 / 要处理 |
| --- | --- | --- | --- |
| 1 | **XML 命名空间** | 主机 ∈ `www.w3.org` / `ns.adobe.com` / `www.xfa.org`，且出现在字符串字面量里当 SVG/XHTML/XSL/XFA 的 `xmlns` 值 | 这些是本机解析用的**标识符**，不是网络地址，浏览器与 pdf.js 从不解析它们为 URL |
| 2 | **正则/占位** | 裸协议（`"http://"` 这种前缀常量）、不可解析主机（`redacted.local`、`example.com`）、模板变量（`http://${origin}`、`http://%s`） | 永远不会被当成完整 URL 发出去；是拼接/校验/日志用的零件 |
| 3 | **内网/已下线主机** | 主机是 `config/endpoints.json` 的 `allowedHosts` 或 `legacyHosts` 里的 **IP 字面量**（`140.210.13.146` / `62.106.70.167` / `123.207.199.196`） | **要处理**：把一个可被任何人扫到的 IP+端口写进公开下载物，等于公开攻击面与资产归属信息 |
| 4 | **真实端点** | 主机是产品真要连的服务（`sub2api.rose7.cn` / `apia.ecsafe.cn` / `dl.rose7.cn` / `api.deepseek.com` …） | **必须保留**：删了产品就废了。这一类的正确形态是 `https://` + 域名 |
| — | （其它） | 第三方库的文档/报错链接（`github.com/...`、`chevrotain.io/...`） | 不属于上述四类之一，另计一行，见 §1.3 |

**为什么类 3 的门槛是"IP 字面量"而不是"私网段"**：`140.210.13.146`、`62.106.70.167` 都**不是**
RFC1918 私有地址，是公网可路由的 IPv4 字面量（Issue #745 标题写"内网 IP"是运维语境的叫法）。
这决定了收口建议 B 的措辞：门禁若写成"生产配置不得含**私网**地址"，**这两个地址一个都拦不住**。
判据必须落在"**主机是 IP 字面量 / 无域名**"，与既有 `check:ip` 同一口径。

### 1.2 四类结果（`http://` 命中 146 处 / 去重 28 条）

| 类 | 命中处数 | 去重条数 | 占总数 | 样例 |
| --- | --- | --- | --- | --- |
| ① XML 命名空间 | **126** | 21 | 86.3% | `http://www.w3.org/2000/svg` ×78、`http://www.w3.org/1999/xhtml` ×14、`http://www.w3.org/1999/xlink` ×7、`http://www.w3.org/XML/1998/namespace` ×6、`http://www.w3.org/1998/Math/MathML` ×5、`http://www.xfa.org/schema/xfa-template/` ×1、`http://ns.adobe.com/xmpmeta/` ×1 … |
| ② 正则/占位 | **13** | 3 | 8.9% | `"http://"` ×9（协议前缀常量）、`http://redacted.local` ×2、`http://${t` ×2（pdf.js 模板拼接） |
| ③ **内网/已下线主机** | **7** | 4 | 4.8% | `http://140.210.13.146:60010` ×2、`http://140.210.13.146:60012/feedback` ×2、`http://140.210.13.146:60013` ×1、`http://62.106.70.167:8888` ×2 |
| ④ 真实端点 | **0** | 0 | 0% | ——（`http://` 里一个都没有，见 §1.3） |
| **合计** | **146** | **28** | 100% | |

**类 3 的额外一条（不计入 146）**：`legacyHosts` 数组里还有**不带 scheme 的裸主机**
`123.207.199.196` ×2 处、`62.106.70.167`（作为裸主机，与 `:8888` 的 URL 分开计）×2 处。
它们不是 `http://` 命中，但同属"内网地址进产物"，收口时**必须一起处理**，否则漏一半。

### 1.3 真实端点：0 处在 `http://` 里，6 条在 `https://` 里

`https://` 命中 **60 处 / 去重 41 条**，拆开看：

| 子类 | 处数 | 条数 | 处置 |
| --- | --- | --- | --- |
| 真实端点（产品要连） | **10** | **6** | **保留** |
| 第三方库文档/报错链接 | 37 | 30 | 无害（`chevrotain.io` / `github.com` / `reactjs.org` 等，只在报错信息里出现） |
| 占位/示例 | 6 | 4 | 无害（`your-gateway.example.com` / `localhost` / `https://…/deepseek_data.zip`） |
| 裸协议 `"https://"` | 7 | — | 无害（前缀常量） |

6 条真实端点明细（**这一张表就是"应该保留"的白名单起点**）：

| 处数 | 地址 | 读它的代码 |
| --- | --- | --- |
| 2 | `https://sub2api.rose7.cn` | `src/services/consume/http.ts`（消费/账号/邀请/卡密，`__ENDPOINTS__.consume.baseUrl`） |
| 2 | `https://apia.ecsafe.cn` | `src/services/ours/api.ts`（买卡支付，`__ENDPOINTS__.pay.baseUrl`） |
| 2 | `https://dl.rose7.cn` | `src/services/updateManifest.ts`（分发回退机，`__ENDPOINTS__.dlFallbackBase`） |
| 2 | `https://api.deepseek.com` | `src/services/api/providers.ts`（DeepSeek 官方渠道出厂默认） |
| 1 | `https://api-docs.deepseek.com/api/delete-file` | 报错文案里的文档链接 |
| 1 | `https://platform.deepseek.com/top_up` | 「去充值」按钮 |

**为什么每条内网地址在 bundle 里恰好出现 1～2 次**（能对上号，说明计数可信）：
`rspack` 的 DefinePlugin 把 `__ENDPOINTS__.xxx` 在**每个使用点**替换成字面量，而
`src/services/diagnostics/fields.ts:175` 读的是**裸 `__ENDPOINTS__`（整份对象）**。于是：

| 字面量 | 出现次数 | 出处 |
| --- | --- | --- |
| `chatBaseUrl` | 2 | `src/services/api/providers.ts:287` + `fields.ts` 整份对象 |
| `inviteBaseUrl` | **1** | **只有** `fields.ts` 整份对象 —— 没有任何请求代码读它（§2 就是这个证据） |
| `feedbackUrl` | 2 | `src/services/diagnostics/config.ts:22` + `fields.ts` 整份对象 |
| `dlPrimaryBase` | 2 | `src/services/updateManifest.ts:22` + `fields.ts` 整份对象 |

---

## 2. 逐条判定：这四个地址**还活着吗**

> 判定分两层，**不能混**：**服务器活着** ≠ **代码会去请求它**。
> 下面每一条先给代码证据（谁在读），再给运行时可达性。

### 2.1 判定表

| 地址 | 字段 | 谁在读（代码证据） | 服务器 | 代码路径 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `http://140.210.13.146:60010` | `chatBaseUrl` | `src/services/api/providers.ts:287` → `ours.defaults.baseUrl` | 活 | **活** | **不能删**（见 §2.2） |
| `http://140.210.13.146:60013` | `inviteBaseUrl` | **无请求代码**；只有 `src/services/diagnostics/fields.ts:175` 拿它做端点归类 | 活 | **死** | **可剔**（见 §2.3） |
| `http://140.210.13.146:60012/feedback` | `feedbackUrl` | `src/services/diagnostics/config.ts:22` → `src/services/diagnostics/transport.legacy.ts:423` 的 `fetch()` | 活 | **活** | **不能删**（见 §2.4） |
| `http://62.106.70.167:8888` | `download.primaryBase` | `src/services/updateManifest.ts:22` → `:407` 拉 `${base}/releases.json` | 活 | **活** | **不能删**（见 §2.5） |

> 第四条不是"deprecated 表"，是**两副面孔**：`62.106.70.167` 同时出现在
> `legacyHosts`（**要拒绝**的旧机名单）和 `download.primaryBase`（**正在用**的分发首选机）。
> 判据只能落在字段上，不能落在 IP 上 —— 按 IP 判会得出"既该删又该留"的自相矛盾结论。

### 2.2 `chatBaseUrl` → **活**，且公开包也活

证据链（三道，缺一不可）：

1. `src/services/api/providers.ts:287` —— `ours` 渠道的 `defaults.baseUrl` 直接取 `__ENDPOINTS__.chatBaseUrl`，`locked: true`（用户改不了，只能用这个值）。
2. `src/components/settings/ApiConfigFields.tsx:200` —— 渠道下拉渲染的是 `PROVIDER_SPECS`，**没有任何 `INTERNAL_BUILD` 过滤**；`src/services/api/providers.ts:337` 的 `DEFAULT_PROVIDER_KIND` 只是在标准包里默认选 `deepseek`，**不代表 `ours` 不可选**。
3. Key 来源不成问题：`ours` 的 Key 由服务端下发（`src/services/api/managedKey.ts`），走 `https://sub2api.rose7.cn`，公开包用户的这条链是通的。

所以：**公开 APK 的用户只要在设置里选「我们的渠道」，请求就明文打到 `http://140.210.13.146:60010`。**
产物里 `chatBaseUrl` 出现 2 次不是"历史残留"，是活引用。

**这时该反过来质疑生产**：一个公开分发的客户端把对话上游指到
`http://<裸 IP>:60010`（无域名、明文、无 TLS），这本身是设计缺陷 —— 它把用户 token、
对话正文、以及后端拓扑同时暴露给任意中间人。**"为什么公开发布物必须含内网地址"的答案不是
"因为要能连"，而是"因为对话上游还没有域名与证书"**。这条不该由 #745 用"删字符串"解决，
应该记一条独立的技术债：**上游域名化 + TLS**，之后 `chatBaseUrl` 自然变成 `https://`，类 3 自动消失。

### 2.3 `inviteBaseUrl` → **死**（唯一可以立刻剔的一条）

证据链：

1. 全仓 `grep -rn "inviteBaseUrl" src/ scripts/ config/` 的结果只有四类：`src/env.d.ts` 的**类型声明与注释**、`src/services/diagnostics/fields.ts` 的**端点归类表**、`scripts/lib/endpointsSchema.mjs` 与 `scripts/check-endpoints.mjs` 的**校验**、`scripts/lib/endpoints.mjs` 的**读取导出**。**没有一处 `fetch` / `CapacitorHttp` 读它**。
2. 邀请 / 额度 / 卡密早在 #604 就迁到了 `src/services/consume/`（走 `https://sub2api.rose7.cn/api/v1/**`）。`src/services/invite/` 现在只剩纯逻辑（`keyIdentity.ts` / `fingerprint.ts` / `emailCooldown.ts` / `device.ts`），**没有 api.ts**。
3. `src/services/diagnostics/fields.ts:175` 读它**只为了把一条日志里的 URL 映射成端点键**（`chatBaseUrl` / `inviteBaseUrl` / `feedbackUrl` / `other`），属于**脱敏归类**，不是请求。
4. bundle 里它只出现 **1 次**（就是 `fields.ts` 那份整份对象），与"只有一个读者"完全吻合 —— 反证：真有请求代码的话至少 2 次。

**顺带查出一个文档缺陷**：`src/env.d.ts:27` 还写着
`inviteBaseUrl 邀请 / 额度 / 卡密服务（~~invite/api.ts~~ 的 INVITE_API_BASE）`，
而 ~~src/services/invite/api.ts~~ 已经不存在（#604 删除）。这条注释会让下一个人以为还有活的读者。

**结论**：`inviteBaseUrl` 是**纯死字段**。可剔除、可改占位、可整键删除（连带 `allowedPorts` 的 `60013`）。
删它的唯一风险不在运行时代码，而在**校验与测试**：`check:endpoints` 要求三个 URL 字段齐全。

### 2.4 `feedbackUrl` → **活**（反馈上传是默认通道）

证据链：

1. `src/services/diagnostics/config.ts:22` —— `LEGACY_FEEDBACK_URL = __ENDPOINTS__.feedbackUrl`。
2. `src/services/diagnostics/index.ts:62` —— `let transport: FeedbackTransport = new LegacyTransport()`，**默认就是 legacy**（不是"实验分支"）。
3. `src/services/diagnostics/transport.legacy.ts:423` —— `await fetch(LEGACY_FEEDBACK_URL, { method: 'POST', … })`，Web 与原生（`:471` 的 `CapacitorHttp.post`）两条都读同一个常量。

**结论**：用户点「反馈」就真的会 POST 到 `http://140.210.13.146:60012/feedback`。
删掉它 = 反馈功能整体失效。真要收口，得先有 `https://` 的反馈域名（或让 `feedbackUrl` 走
`sub2api` 的同域路径），这是**第二步之后的事**，不是"删字符串"。

### 2.5 `62.106.70.167:8888` → **活**（分发首选机，且原生侧也认它）

证据链：

1. `src/services/updateManifest.ts:22` → `PRIMARY_RELEASE_BASE`；`:25` 组成 `RELEASE_BASES`；`:26` 它是 `DEFAULT_RELEASE_BASE`。
2. `src/services/updateManifest.ts:407` —— `fetchManifestText(`${base}/releases.json`)`，按 `RELEASE_BASES` 顺序**首选就是它**（`http` 先试，失败才落 `https://dl.rose7.cn`）。
3. 原生侧同源：`android/app/src/main/java/com/example/deepseekchat/UpdateEndpoint.java` 的 `PRIMARY_BASE = BuildConfig.DL_PRIMARY`，下载白名单与 `allowsDownloadUrl` 从它派生。
4. 探测（§3）：`http://62.106.70.167:8888/` 回 **200 + Caddy**，是个在服务中的站点。

**结论**：活。它进产物**不是笔误，是分发拓扑**（首选机只有明文 `:8888`，回退机才有 `https`）。
要收口必须先给分发机配上域名与证书 —— 与 §2.2 是同一类债。

### 2.6 小结：3 活 1 死

| 结论 | 条目 | 能不能"就地删" |
| --- | --- | --- |
| **活** | `chatBaseUrl`、`feedbackUrl`、`62.106.70.167:8888`（`download.primaryBase`） | **不能**。删了就是线上故障（分别在：对话、反馈、更新） |
| **死** | `inviteBaseUrl`（`:60013`） | **能**。但要同时改 `check:endpoints` 的三字段约束 |
| **活但纯拒绝用** | `legacyHosts` 里的 `123.207.199.196`、`62.106.70.167` | 表本身要留（老用户配置重写），**但值可以换成占位**：它只做 `includes()` 比对（`src/services/api/apiConfig.ts:168`），换成 `__REDACTED__` 后老配置会"失联"→ 需要同步改契约 |

> `legacyHosts` 的判定值得单独说清：它**不是**"会去请求的地址"，而是"读到就当成没配过、
> 回落当前默认"的重写表（`src/services/api/apiConfig.ts:175` 的 `dropLegacyHost`）。所以它
> **没有"请求"风险，只有"泄漏"风险**。这正好是最适合"构建期占位"的一类 —— 见建议 A。

---

## 3. 探测（只读，2s 超时；未对生产做任何写操作）

执行时间 2026-11-21 18:28（Asia/Shanghai）。判据：`/dev/tcp` 建连超时 2s；HTTP 单选 `GET`，`--max-time 2`。

| 地址 | TCP(2s) | HTTP | 响应特征 |
| --- | --- | --- | --- |
| `140.210.13.146:60010` | **OPEN**（47ms） | `401` | `nginx/1.24.0 (Ubuntu)`，CORS 放行 `authorization/content-type/x-api-key/…`，`application/json` —— 就是对话网关 |
| `140.210.13.146:60012` | **OPEN**（53ms） | `401` | `{"ok":false,"error":"unauthorized"}` —— 反馈服务（没带 `X-Client-Token` 就是这个回执） |
| `140.210.13.146:60013` | **OPEN**（46ms） | `404` | `Server: invite/1.0 Python/3.12.3`，`{"error":{"code":"not_found","message":"unknown path"}}` —— **邀请服务仍在跑**（根路径无路由才 404） |
| `62.106.70.167:8888` | **OPEN**（49ms） | `200` | `Server: Caddy`，`text/html; charset=utf-8`，`Last-Modified: 2026-11-17` —— 在服务的下载站（`/apk/` 子路径 404，index 200） |

**四条全在线（4/4）。**

这条结果改变了收口的性质，必须写明：**"已死"不能按服务器判，只能按代码路径判**。
如果按"服务器还通不通"来决定删不删，会得出"四条都要留"的错误结论；
反过来按"名字里有 legacy 就删"来删，会当场打断对话、反馈、更新三条链路。

**顺带确认的事实**：`140.210.13.146` 与 `62.106.70.167` 都是**公网可路由的 IPv4 字面量**（不是
RFC1918），所以"内网 IP"这个说法在判据上要翻译成"**无域名的 IP 字面量**"，否则门禁写不对（§1.1）。

**明文之所以能跑**：产物 `AndroidManifest.xml` 里 `usesCleartextTraffic="true"`，且**没有**
`networkSecurityConfig`（本次对 1.4.5 APK 的二进制 manifest 解码确认）。也就是说 Android 侧
没有任何机制会拦住这些 `http://` —— 这也是为什么"删了也不影响"这种直觉是错的。

---

## 4. 收口建议（三级，不改代码，只给判断）

### A 最小：把内网字面量改成**构建期占位串**（推荐先做）

做法：`config/endpoints.json` 保留真值供 dev/联调；**生产构建**在 `rspack.config.ts` 注入前把
`chatBaseUrl` / `inviteBaseUrl` / `feedbackUrl` / `download.primaryBase` / `legacyHosts[]` 里的
IP 字面量替换成 `__REDACTED__`（非空、不可解析），产物里就只剩占位。

- **能治到什么**：类 3 的**泄漏面**全部消失（7 处 + 4 处裸主机 = 0）。IP 与端口不再随安装包扩散。
- **治不到什么**：**运行时行为会变**。占位串不是地址 → `ours` 渠道、反馈、更新首选机会真的连不上。
  所以 A 必须与"这三条链路要么在标准包里关掉、要么已经域名化"**同时成立**，否则就是用一个缺陷换三个故障。
- **代价**：`rspack.config.ts` 一处注入逻辑 + `check:endpoints` 需接受占位（约 1–2 人时）；
  再加 §2.2/§2.4/§2.5 三条链路的先行条件（**这才是真正的工作量，属于别的单**）。
- **我建议的实际切法**：A **只对 `inviteBaseUrl`（死字段）与 `legacyHosts`（只做拒绝比对）先落地**——
  这两条替换成占位**零运行时风险**，能立刻把"内网地址条数"从 4 条降到 2 条。

### B 中等：删死条目 + 加"生产配置不得含 IP 字面量"门禁

做法：① 从生产 `endpoints.json` 删除 `inviteBaseUrl`（连同 `allowedPorts` 的 `60013`），同步
`check:endpoints` 的三字段约束；② 在 `check:endpoints` 里加一条判据：**`chatBaseUrl` /
`feedbackUrl` / `download.primaryBase` 的主机不得是 IP 字面量，`legacyHosts` 除外（它必须写 IP 才有意义）**。

- **代价**：① 死字段删除要动 `scripts/lib/endpointsSchema.mjs` 的字段表 + 若干断言（实测
  `tests/`+`scripts/` 里 `140.210.13.146` 共 **32 处**引用，其中 `tests/unit/check-ip-version.test.mjs`
  7 处、`scripts/check-refactor-direction.mjs` 4 处要逐条核对）；② 门禁加了以后**当前配置直接红**，
  必须与 A（或域名化）同批合入，否则 CI 全红。
- **注意措辞**：写"不得含**私网**地址"在这份配置上**永远绿**（两个 IP 都是公网）。判据必须写
  "**不得含 IP 字面量（必须有域名）**"。

### C 彻底：新增 `check:public-artifact-redaction`（**改门禁，要放行**）

做法：新脚本扫 **APK 解包后的 `assets/public/**`**（或 `dist/**`），判据是
"`http(s)://<IP 字面量>` 命中数 == 白名单内条数"，白名单来自 `config/endpoints.json` 的
`allowedHosts`/`allowedPorts`；挂进 `ci.yml` 或 `release.yml`。

- **为什么这是唯一治根的一级**：`scripts/check-hardcoded-ip.mjs:57` 的扫描范围是 `['src','scripts']`——
  **产物根本不在射程内**。这就是为什么源码"零副本"、产物却仍有 7 处：注入发生在构建期，
  检查发生在构建前。这是**门禁的结构性盲区**，不是执行不力。
- **成本其实很低（有现成载体）**：`scripts/verify-release-apk.mjs` 已经是"发布 APK 一条命令出结论"
  的六项判据，文件头第 8 行就写着当年是**手打 `unzip grep baseUrl`** 才确认干净。加**第 7 项**
  （bundle 内 IP 字面量 = 白名单）是纯增量，不需要新造一套 unpack/解析。
- **代价 / 风险**：① **要改 `ci.yml`**——本单约束明确"不改 ci.yml、不新增门禁"，所以只能到"建议 +
  可验证的判据"为止；② 判据上线即红（当前 7 处），必须先有 A/B 的处置或显式白名单，
  否则等于给所有 release 挂一个必红项；③ 白名单若按"放行现存值"写，就成了把缺陷固化成契约——
  这是这一级唯一真正的陷阱。

### 推荐

**A（只对死字段与 `legacyHosts`）+ B（删 `inviteBaseUrl`、门禁措辞改为"IP 字面量"）先做，
C 单独开单放行。**
理由：A/B 能在**不触碰三条活链路**的前提下把"内网地址"从 4 条压到 2 条、并把回归风险锁死；
而剩下两条（`chatBaseUrl` / `download.primaryBase`）的根因是**上游没有域名与 TLS**，删字符串只会
把泄漏换成故障。C 是真正的根因门禁，但它必须等 A/B 落地后才可能绿，且需要改 CI —— 属于第二步。

---

## 5. 复现命令

产物侧（本文所有计数都来自这条，扫的是解包后的 `assets/public`）：

```bash
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8
mkdir -p /tmp/apk145 && cd /tmp/apk145 && unzip -oq <deepseek-chat-1.4.5.apk>
cd <解包目录>/assets/public
# 总命中
grep -roah "http://[^\"'\\\\\`<> )},;|]*" . --include='*.js' --include='*.css' --include='*.html' | wc -l   # 146
# 去重排行
grep -roah "http://[^\"'\\\\\`<> )},;|]*" . --include='*.js' --include='*.css' --include='*.html' \
  | sort | uniq -c | sort -rn | head -30
# 只看类 3
grep -roah "http://\(140\.210\.13\.146\|62\.106\.70\.167\|123\.207\.199\.196\)[^\"' ]*" . | sort | uniq -c
```

> 注意路径：本仓产物的 JS 在 `static/js/`（不是 `dist/assets/*.js`），入口是
> `static/js/main.<hash>.js`。任务里那条 `dist/assets/*.js` 的写法在这个仓库**扫不到任何东西**
> （会静默输出空），已按实际布局改正。

源码侧（判定依据）：

```bash
grep -rn "chatBaseUrl\|inviteBaseUrl\|feedbackUrl" src/ scripts/ config/
grep -rn "62\.106\.70\.167" src/ scripts/
grep -rn "__ENDPOINTS__\." src/
```

探测侧（只读，2s）：

```bash
for h in 140.210.13.146:60010 140.210.13.146:60012 140.210.13.146:60013 62.106.70.167:8888; do
  timeout 2 bash -c "cat < /dev/null > /dev/tcp/${h%:*}/${h#*:}" && echo "$h TCP open" || echo "$h TCP fail"
  timeout 3 curl -s -o /dev/null -w "$h -> %{http_code}\n" --max-time 2 --connect-timeout 2 "http://$h/"
done
```

---

## 6. 边界：本单**没有**回答的问题

1. **没有改任何配置与代码**，也没有新增门禁 —— A/B/C 全是建议。
2. **没有判定"该不该给对话上游配域名"**。这是 §2.2 指出的技术债，需要产品/运维决策，不在本单。
3. **没有覆盖 Android 原生产物内的其它字符串**（`classes.dex`、`resources.arsc`）。本次只扫
   Web 侧 bundle（`assets/public/**`）—— dex 里若还有 IP，需另开一次 `strings classes*.dex | grep`。
   这条是已知的覆盖缺口，写在这里免得被当成"已清零"。
4. **`62.106.70.167:8888` 只做了 GET 探测**，没有验证 `${base}/releases.json` 是否真的可取
   （避免对分发机产生请求）。若第二步需要，可单独只读校验一次。
