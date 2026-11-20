# 诊断日志规范：一条合格日志的最小字段集

> 母单 [#301](https://github.com/zzy-repo/deepseek-app/issues/301)。本文只写**判据与字段契约**，
> 不重复采集层实现细节（那是 `src/services/diagnostics/` 的注释与 `docs/diagnostics-coverage-audit.md` 的活）。
>
> 判据只有一条：**一条日志能不能回答「发生了什么 / 在哪一步 / 怎么办」**。答不上就是不够细。
> 把一句话拆成两句、给 `msg` 加 `[INFO]` 前缀，都不算。

## 1. 最小字段集（新埋点照这个写）

| 字段 | 必填性 | 取值 | 支撑哪一问 |
| --- | --- | --- | --- |
| `kind` | **必填** | `EventKind`（21 种，`src/services/diagnostics/types.ts`） | 发生了什么（哪类事） |
| `level` | **必填** | `error` / `warn` / `info`（`recordEvent` 按 kind 有默认值） | 严重度 |
| `stage` | **必填**（生命周期类豁免，见 §2） | `Stage` 枚举（带域前缀，`src/services/diagnostics/fields.ts`） | **在哪一步** |
| `status` | 有条件 | HTTP 0–599 或 `ok` / `partial` / `error` / `timeout` / `aborted` / `rejected` / `retrying` | 成了没有 |
| `reason` | 失败 / 中止 / 等待类**必填**，成功类**不写** | `LogReason`（47 值，`src/services/diagnostics/reasons.ts` 的 `REASON`） | **为什么**（机器可读） |
| `retryable` | 失败 / 中止类**必填** | boolean；默认值取 `REASON_RETRYABLE`，链路可显式覆盖 | **怎么办** |
| `durationMs` | 有等待时必填 | 毫秒（`clampCounter`，上限 24h） | 慢在哪 |
| `upstreamCode` | 上游给了码就填 | 上游短码原文（`invalid_request_error`、`CARD_ALREADY_USED`） | 上游怎么说的 |
| `meta` 的键数 | **≥ 2**（除 §2 豁免项） | 白名单键，见 §4 | 能否切片 |

条件必填（有就带，不要为了凑数硬写）：`attempt`（有重试）、`bytes` + `totalBytes`（有传输）、
`speedBps`（有传输且能算）、`endpointKey`（网络请求）、`correlationId`（一次操作多条日志）、
`flow`（与 `stage` 前缀一致）。

**写法**：新埋点用 `buildMeta({...})`（键与取值都在类型里，写错编译期就红）；`reason` 用
`REASON.<名字>` 常量，不要就地写裸字符串。

## 2. 豁免：生命周期与采集层自产事件

`app_launch` / `app_pause` / `app_resume` / `state_snapshot` / `longtask` / `ui_rendered`
只回答「什么时候发生」，没有业务维度可切，**不要求** `stage` / `reason` / `retryable`，
`meta` 允许 ≤ 1 个键。这份名单与门禁里的 `LIFECYCLE_OK` 是同一份口径，改一处要同时改另一处。

## 3. `reason` 的边界：它是「为什么」，不是「谁说了什么」

同一个失败往往同时有三层信息，**各归各位，不许互相塞**：

| 信息 | 落哪个字段 | 反例（改造前真实写法） |
| --- | --- | --- |
| 为什么会失败（本地判定） | `reason`（47 值之一，kebab-case） | `reason: 'MANIFEST_HTTP_404'`（其实是 `reason:'http-error'` + `status:404`） |
| HTTP 状态码 | `status` | `reason: 'http-404'` |
| 上游自己给的短码 | `upstreamCode` | `reason: 'CARD_ALREADY_USED'` |
| 给人看的一句话 | `msg` | `reason: 'oursPlansFailed'`（那是 i18n key，不是原因） |

默认可重试性由 `REASON_RETRYABLE` 统一给出（`retryableFor(reason, status?)`）：
`http-error` 是唯一「看状态码」的取值（5xx 可重试、4xx 终态）。链路要覆盖默认值就显式写
`retryable`，不要在本地再维护一份可重试名单。

## 4. 白名单：键写不进去时，日志里就没有这条证据

`meta` 的键必须来自白名单（`MetaInput` 的 24 个类型化键 + `EXTRA_KEYS` 的历史裸键
+ `EXTRA_KEY_PATTERNS` 的点号键族），**白名单外的键静默丢弃**。丢弃是静默的，所以：

1. **加键之前先确认它在被写**：静态扫描 `record*` / `buildMeta` 的 meta 字面量键，与白名单比对；
2. **新键要么进 `MetaInput`（推荐，有类型），要么进 `EXTRA_KEYS`（历史裸键）**，不要两处都写；
3. **加 `Stage` 值必须同步 `STAGES` 数组**（#312 踩过：只改类型不改数组，`stage` 会被静默丢掉且
   `tsc` 不报）；`reason` 同理，改 `REASON` 表即可，`LogReason` 与 `REASONS` 都从它推导。

键名最后一段命中密钥词（`key` / `token` / `secret` / `card` / `deviceid` / `phone` …）会**整条丢弃**，
所以尾号类字段一律命名成 `key.tail` / `card.tail` / `order.tail`。

## 5. 脱敏铁律（不因埋点细化而放宽）

- API Key / 卡密 / 单号：**只留尾 4 位**（`key.tail` / `card.tail` / `order.tail`），原文一个字符都不进日志；
- `device_id`、`order_token` 不落库；完整 URL 压成 `url.path` / `url.host`（query 里的签名一律丢弃）；
- 不记用户正文、不记文件名、不记卡号原文；
- 值维度由 `src/services/diagnostics/redact.ts` 兜底，键维度由白名单 + 密钥词表兜底，**两边都要有**。

## 6. 三条真实故障：合格日志长什么样

**① 装到了非 internal / standard 的包（更新检查第一步就失败）**

```json
{"kind":"error","level":"error","msg":"update check failed",
 "meta":{"flow":"update","stage":"update.check.installed","status":"rejected",
         "reason":"variant-invalid","retryable":false,"attempt":1,"durationMs":2,
         "buildType":"beta","versionCode":10409}}
```

三问：`variant-invalid`（不是内部短码反读）／`update.check.installed`（不是笼统的 manifest）／
`retryable:false`（换包，别再点一次）。

**② 兑换卡密返回 409（同一张卡第二次兑换 vs 新人特惠已用）**

```json
{"kind":"nav","level":"warn","msg":"action: ours-redeem",
 "meta":{"flow":"quota","stage":"quota.redeem","status":409,"reason":"card-already-used",
         "retryable":false,"upstreamCode":"CARD_ALREADY_USED","card.tail":"****4321",
         "durationMs":842}}
```

`NEWBIE_USED` 只换 `reason:"newbie-used"` —— 同一个状态码、下一步完全不同，所以必须分开记。

**③ 链接导入下载停滞（18 秒没有新字节）**

```json
{"kind":"import_stage","level":"warn","msg":"import: download stalled",
 "meta":{"flow":"import","stage":"import.download","status":"timeout","reason":"stalled",
         "retryable":true,"attempt":2,"correlationId":"imp-1710-4821",
         "bytes":3145728,"totalBytes":12582912,"idle.ms":18002,"durationMs":41000}}
```

`status:'timeout'` + `reason:'stalled'` + `idle.ms` 三个一起才能区分「太慢但还在走」与「根本没动静」。

## 7. 门禁：不靠自觉

`node scripts/check-log-coverage.mjs`（CI 里是 `pnpm check:log-coverage`，非 strict）三条规则：

| 规则 | 判什么 | 违反时 |
| --- | --- | --- |
| R1 死枚举 | `EventKind` 每个取值必须有调用点；`BUSINESS_KINDS` 必须有采集层之外的调用点 | FAIL |
| R2 关键链路 | `CRITICAL_PATHS` 每条链路都要有埋点；未补的登记在 `scripts/log-coverage-baseline.json` 的 `knownGaps`（只能减） | 默认告警 / `--strict` FAIL |
| R3 meta 贫瘠 | 除生命周期类外，每条埋点 `meta` ≥ 2 个键；存量违反项登记在 `metaDebt`（只能减） | 同上 |

脚本是静态扫描：`{...spread}` 记 1 个键、meta 实参是标识符 / 函数调用时按「非空」放过（宁漏不误报）。
所以**过了门禁不等于日志合格**，它只是挡住「只有一句人话、meta 为空」这种退化。

## 8. 迁移状态（2026-11-20）

| 链路 | 状态 |
| --- | --- |
| 支付 / 额度 / 卡密 / 购买记录 | 达标（#312，17 处 / 8 个 `quota.*` stage）；`reason` 仍有一半在写 i18n key，待迁移到字典值 |
| 导入（文件 / URL） | 达标（#313）：`reason` / `retryable` / 各阶段 `durationMs` 齐全 |
| 更新检查 → 下载 → 安装 | **未达标**（#311）：`update.install` 无埋点、下载失败的 catch 无日志、失败统一记成 `update.check.manifest`、缺 `reason` |
| 聊天流式 | `stage` / `status` / `upstreamCode` 齐全；`reason` 与「额度不足」标记补齐见 #301 维度 3 |
| 附件上传 | 三态齐全；开始 / 成功用的是 `kind:'nav'`，按 kind 切片会切到「导航」（口径问题，需先定 `EventKind` 归属） |

## 相关文档

- [`docs/diagnostics-coverage-audit.md`](diagnostics-coverage-audit.md)：一次真实反馈的覆盖审计（解释边界与能力字段）
- [`docs/TESTING-POLICY.md`](TESTING-POLICY.md)：门禁分级与「负向对照」要求
