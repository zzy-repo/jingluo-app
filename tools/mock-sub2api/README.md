# sub2api 契约 mock 服务器

> **一句话**：按 [`docs/sub2api-client-contract.md`](../../docs/sub2api-client-contract.md) §3 白名单
> 实现的本地假后端，让 UI / 身份层在真实 sub2api 起来之前就能发请求、能走完错误态。
>
> **它是什么**：契约的**可执行版本**。mock 与文档不一致 → 立刻暴露，比等真实实例划算。
> **它不是什么**：不是 sub2api 的替代实现，不是后端，**不进打包**（在 `tools/`，不在 `src/`），
> 数据全在内存里，进程一停就没了。

- 端口：**`127.0.0.1:18080`**（真实实例用 `18000`，故意错开）
- 依赖：**零第三方**，只用 `node:http` / `node:crypto`
- 端点数：**23 个白名单端点 / 24 条路由**（`/api/pay-link` 同时收 GET 与 POST）

---

## 1. 起服务

```bash
export PATH="/opt/node24/bin:$PATH"   # 本机 node 24
pnpm mock:sub2api                     # = node tools/mock-sub2api/server.mjs
```

启动行会打印端口、种子账号、种子 Key 和错误态开关。**端口被占时不会静默换端口**——
换了端口的 mock 比没起来更坏（请求打到别人的服务上，UI 会「跑绿」在错误的目标上）：

```
[mock-sub2api] 端口 18080 已被占用（127.0.0.1:18080）。
[mock-sub2api]   MOCK_SUB2API_PORT=18081 node tools/mock-sub2api/server.mjs
```

> 本机实测：`18080` 曾被一个**无关**容器（`qiqi-gateway`，`0.0.0.0:18080->80`）占用，
> 那种情况下用 `MOCK_SUB2API_PORT=18081` 即可，代码不用改。

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MOCK_SUB2API_PORT` | `18080` | 端口；`0` = 内核分配（自检脚本用） |
| `MOCK_SUB2API_HOST` | `127.0.0.1` | 监听地址（只绑回环） |
| `MOCK_SUB2API_ENVELOPE` | `contract` | 401 的 `code` 口径：`contract` = 数字码 `40101/40102`；`real` = 真实实例的 `"UNAUTHORIZED"` 字符串。见 §6 |
| `MOCK_SUB2API_SETTINGS` | 空 | 临时翻开关，如 `'{"affiliate_enabled":true}'`（未知键会打印警告） |

## 2. 三步冒烟

```bash
# ① 公共设置：74 字段全量，registration_enabled=true / email_verify_enabled=false / invitation_code_enabled=true
curl -s localhost:18080/api/v1/settings/public | head -c 300; echo

# ② 未知路径必须是 text/plain 404（不是 JSON）
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' localhost:18080/api/v1/nope
# -> 404 text/plain

# ③ 登录：任意邮箱 + 密码 ≥8 位，回面板信封里的 token 对
curl -s -X POST localhost:18080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"12345678"}'
```

拿 token 打 JWT 接口：

```bash
TOKEN=$(curl -s -X POST localhost:18080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ui@mock.local","password":"12345678"}' | jq -r '.data.access_token')

curl -s localhost:18080/api/v1/auth/me      -H "authorization: Bearer $TOKEN"
curl -s localhost:18080/api/v1/user/profile -H "authorization: Bearer $TOKEN"
```

`sk-` Key 通道（`/v1/*`）：启动时就有一把种子 Key，**不用先创建**：

```bash
# 种子 Key：sk-c0ffee…c0ff（启动行会打印）
curl -s localhost:18080/v1/usage -H 'authorization: Bearer sk-c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff'
```

## 3. 端点清单（白名单 23 个 / 路由 24 条）

响应信封与真实实例一致：**面板成功 `{code:0,message:"success",data:{…}}`**、
面板失败 `{code:<HTTP 整数>,message,reason?}`、`/v1/usage` **扁平不套 `data`**、apia 平铺对象。

| 分组 | 方法 + 路径 | 鉴权 | mock 行为 |
| --- | --- | --- | --- |
| 公共 | `GET /api/v1/settings/public` | — | 74 字段全量；`registration_enabled:true`、`email_verify_enabled:false`、`invitation_code_enabled:true` |
| 认证 | `POST /api/v1/auth/register` | — | 任意邮箱 + 密码≥8；邮箱重复 → `409 EMAIL_EXISTS` |
| 认证 | `POST /api/v1/auth/login` | — | 任意邮箱 + 密码≥8；**未注册的邮箱自动建号**（真实实例回 401） |
| 认证 | `POST /api/v1/auth/send-verify-code` | — | `{message,countdown:60}`，不回验证码（任意 6 位都通过） |
| 认证 | `POST /api/v1/auth/refresh` | — | 换新 token 对；旧 refresh_token 立刻失效（重放 → 401） |
| 账号 | `GET /api/v1/auth/me` | JWT | `profile + run_mode:"standard"` |
| 账号 | `GET /api/v1/user/profile` | JWT | `dto.User` + 5 个身份摘要 + `email_bound` |
| 账号 | `GET /api/v1/user/aff` | JWT | `aff_code / aff_count / aff_quota / effective_rebate_rate_percent` |
| Key | `GET /api/v1/keys` | JWT | 分页 `{items,total,page,page_size,pages}`，支持 `page/page_size/search/status`；**空列表是正常态** |
| Key | `POST /api/v1/keys` | JWT | `name` 必填；`quota:0` = 不限（**不是**零额度）；`custom_key` 撞车 → `409 API_KEY_EXISTS` |
| Key | `GET /api/v1/keys/:id` | JWT | `:id` 非整数 → 400；不存在 → 404 |
| Key | `PUT /api/v1/keys/:id` | JWT | 改名 / `status` / `quota` / `reset_quota`；**没有 `key` 字段**（无法原位换值） |
| Key | `DELETE /api/v1/keys/:id` | JWT | 已删除再删 → 404（按契约不算致命错） |
| 用量 | `GET /v1/usage` | `sk-` Key | `mode:"quota_limited"`；**`quota.used` 恒 0**，真实花费在 `usage.total.actual_cost`；**没有 `rate_limits` 键** |
| 兑换 | `POST /api/v1/redeem` | JWT | `MOCK-OK-0001` → 成功（余额 +10）；`MOCK-USED-0001` → `409 REDEEM_CODE_USED`；其它 → `404 REDEEM_CODE_NOT_FOUND` |
| 兑换 | `GET /api/v1/redeem/history` | JWT | 不带分页参数回**数组**（旧兼容形态），带 `page` 回分页信封 |
| 邮箱 | `POST /api/v1/user/account-bindings/email/send-code` | JWT | `{message,countdown:60}` |
| 邮箱 | `POST /api/v1/user/account-bindings/email` | JWT | `{email,verify_code}` → 换绑并回新的 profile |
| 邮箱 | `DELETE /api/v1/user/account-bindings/:provider` | JWT | 邮箱是主身份 → 400；第三方未绑定 → `404 IDENTITY_NOT_BOUND` |
| 支付 | `GET /api/plans` | — | 平铺 `{plans:[{id,name,price,points,currency,enabled}]}`（含 1 个 `enabled:false`） |
| 支付 | `POST /api/pay-link`（也收 GET） | — | `{ok,url,note}`，`url` 是打不开的假地址 |
| 支付 | `GET /api/orders` | — | `{customer_id,total,limit,offset,total_paid_yuan,orders[]}`，订单含 `timeline` / `card` |
| 支付 | `GET /api/card/trail?card_no=` | — | `{card_no,purchase,redemption}`；缺参 → `400 BAD_INPUT`；`MOCKCARD9999` → `404 CARD_NOT_FOUND` |

**白名单之外**（含方法不匹配）：`content-type: text/plain`，body 就是 `404 page not found`。
`/api/v1/admin/*` 是唯一例外：回 admin 的 401 信封（见 §5 ②），因为真实实例在这些路径上
就是那个 message —— 留它是为了让 UI 能验证「两套 401 message 不同」，**不是**实现管理台。

## 4. 内存状态（进程内，重启即清）

| 状态 | 初始值 |
| --- | --- |
| 用户 | 种子 `demo@mock.local`（密码任意 ≥8 位）；登录/注册新邮箱自动建号 |
| API Key | 种子 `sk-c0ffee…c0ff`（`quota:0` 不限）；其余靠 `POST /api/v1/keys` 造 |
| 卡密 | 只有 `MOCK-OK-0001`（可用，+10 USD）与 `MOCK-USED-0001`（已用） |
| 兑换记录 | 空，兑换成功后进 `GET /api/v1/redeem/history` |
| 余额 | 新用户 2.00 USD（`user.balance`） |

## 5. 五种错误信封 + 触发开关

这是 mock 的核心价值：**错误态不用等真断网/真限流**，一条 URL 就能逐条验。

触发方式（二选一，可叠加在任意路径上，**优先级最高**）：

```bash
curl -s 'localhost:18080/api/v1/auth/me?mock_error=auth'     # query
curl -s -H 'x-mock-error: auth' localhost:18080/api/v1/auth/me  # header
```

| # | 开关 | HTTP | 响应体 | 一句话 |
| --- | --- | --- | --- | --- |
| ① | `?mock_error=auth`（别名 `401` / `user401`） | 401 | `{"code":40101,"message":"Authorization header is required"}` | **用户** 401 |
| ② | `?mock_error=admin401`（别名 `admin`） | 401 | `{"code":40102,"message":"Authorization required"}` | **admin** 401，**message 不同** |
| ③ | `?mock_error=rateLimit`（别名 `429` / `rate_limit`） | 429 | `{"error":"rate limit exceeded","message":"Too many requests, please try again later"}` + `retry-after: 59` | **没有 `code` 字段** |
| ④ | `?mock_error=gateway`（别名 `502`） | 502 | `{"error":{"message":"…","type":"upstream_error"}}` | 网关错误 |
| ⑤ | `?mock_error=text404`（别名 `404` / `text`） | 404 | 纯文本 `404 page not found`，`content-type: text/plain` | **不是 JSON** |

不带开关时，①②⑤ 这些错误也会自然发生（无 token 打 JWT 接口 = ①、未知路径 = ⑤、
`/v1/usage` 无 Key = `{"code":"API_KEY_REQUIRED","message":"…"}` 中间件信封）。

**UI 侧硬要求**（契约 §4）：`kind` 分派、**不许按 `message` 分支**（①和②的 message 只差
`header is` 三个词）、**429 不许按 `body.code` 分支**（它根本没有 `code`）、
**未知路径的 404 不许 `JSON.parse`**（先看 `content-type`）。

## 6. 与真实实例的已知差异

差异分两类：**mock 故意简化**（不影响 UI 联调）与**契约 vs 实机不一致**（值得改文档）。

### 6.1 故意简化 / 不支持

| 项 | 真实实例 | mock |
| --- | --- | --- |
| 存储 | Postgres + Redis，持久 | 内存，重启清空 |
| 注册限流（5/min）、登录（20/min）、发码（5/min） | 有，超了回 429 | **没有**；要 429 用 `?mock_error=rateLimit` |
| 密码策略 | `min=6`（`RegisterRequest`） | **≥8 位**（本单要求，便于 UI 校验文案） |
| 邮箱验证码 | 真发邮件 | 任意 6 位数字都通过 |
| 忘记密码 / 重置密码 / 2FA / OAuth / `revoke-all-sessions` | 有 | **未实现**（不在本单白名单表里，打过去是 text/plain 404） |
| `/v1/chat/completions` 等模型调用 | 有 | **未实现**（text/plain 404） |
| `/health`、`/setup/status` | 无 / 被边缘 Basic 认证拦 | 无 |
| `/api/v1/usage`、`/usage/stats`、`/usage/dashboard/*` | 有（面板 JWT） | **未实现**（本单只做 `/v1/usage`） |
| CORS | `allowed_origins` 默认空 → 拒跨域 | 全站 `access-control-allow-origin: *`（方便浏览器直连） |
| `/api/plans` | 现返回 `{"plans": []}`（全线下架） | 给 3 条假套餐（含 1 条 `enabled:false`），UI 才有东西可渲染 |
| apia 鉴权 | `/api/orders`、`/api/card/trail` 要 `Bearer <apiKey>` | 不校验（随便打） |
| JWT 验签 / 过期 | 真 HS256 + 过期 | 签名是假的、不校验过期；只认内存里发过的 token |
| `MOCK_SUB2API_SETTINGS` | — | mock 独有的临时开关覆盖 |

### 6.2 契约文档 vs 实机（**这条最值得看**）

| 项 | 契约 `docs/sub2api-client-contract.md` / 本单要求 | 真实实例实测（本机 `127.0.0.1:18000` = 0.2.20；公网抓包 0.2.22 同形） | mock 怎么做 |
| --- | --- | --- | --- |
| 用户 401 的 `code` | `40101`（数字） | `"UNAUTHORIZED"`（**字符串**），message 是 `Authorization header is required` | 默认按契约给 `40101`；`MOCK_SUB2API_ENVELOPE=real` 切到实机口径 |
| admin 401 的 `code` | `40102`（数字） | 同样是 `"UNAUTHORIZED"`，**只有 message 不同**（`Authorization required`） | 同上 |
| 429 信封 | 契约 §4 写 `{code:"RATE_LIMITED"}` 或整数 `code` | `{"error":"rate limit exceeded","message":"…"}`，**无 `code`** + `retry-after` | 按实机（任务口径）；UI 只能按 HTTP 状态分支 |
| `/api/pay-link` 方法 | 契约写 `POST` | 客户端既有契约注释（`src/services/ours/api.ts`）写 `GET` | **两个都收**，这个不一致正好在这里暴露 |
| `/api/v1/admin/*` | 白名单外，禁止调用 | `/admin/users`、`/admin/settings` → 401；`/admin/dashboard`、`/admin/stats` → text 404 | 统一回 admin 401 信封（只回 401，没有数据） |
| `settings.version` | — | 本机 dev 实例 `0.2.20`，公网抓包 `0.2.22` | 取 `0.2.22`（抓包值） |
| `quota.used` | — | 真实实例会累计 | **恒 0**（mock 不记账），花费只放 `usage.total.actual_cost` |
| `rate_limits[]` | 契约 §3.3 说 quota_limited 带它 | 实测没有该键 | 不返回该键（硬 `map()` 会崩，就是为了让这个坑在 mock 上先崩一次） |

> 结论级提醒：**`code` 用数字还是字符串，是 mock 与实机唯一的硬冲突**。
> 如果 UI 层按 `40101` 写分支，接真实实例前必须先确认契约改成哪一套；
> 拿不准就先用 `MOCK_SUB2API_ENVELOPE=real` 跑一遍，两边都过一遍再定。

## 7. 自检（改了 `server.mjs` 就跑）

```bash
node tools/mock-sub2api/smoke.mjs
```

零依赖、**不写死端口**（子进程用 `MOCK_SUB2API_PORT=0` 让内核分配），覆盖 57 项：
23 个白名单端点、分页/空列表/404/409 分支、`quota.used` 恒 0、`rate_limits` 不存在、
五种错误信封逐字比对、`?mock_error=` 与 `x-mock-error` 两种触发方式、白名单外一律 text/plain 404、
方法不匹配也 404。

```
57/57 项通过
```

它**没进 CI**（`.github/workflows/ci.yml` 不在本单改动范围），所以是「想跑就跑」的自证工具；
`server.mjs` 或契约一改就手动跑一次。

## 8. 边界（别把这些当功能）

- **不要把 mock 的端口/base 写进 `src/`**：base 只从 `config/endpoints.json` 的 `consume.baseUrl` 读（契约 §6）。
- **不要在 mock 上加白名单外的端点**：要加先改 `docs/sub2api-client-contract.md` §3 加一行 + review（契约 §8）。
- **不要用 mock 的 200 结果断言「已接通」**：接通的判据是真实实例 + CORS 放行（契约 §6.4 第 5 条）。
