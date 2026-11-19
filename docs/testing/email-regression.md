# 邮箱适配回归基线（Issue #427）

一条命令跑完全部邮箱适配回归，**离线、可重复、结果稳定**：所有请求由假 transport 给出，
时间用假时钟，没有任何真实网络与 `sleep`。

```bash
pnpm test:email          # = node tests/run-layer.mjs unit --only email
```

退出码由 `tests/run-layer.mjs` 决定：**任一用例失败即非零退出**（不是「打印红字但 exit 0」）。
它同时是统一入口 `pnpm test`（`node tests/run-layer.mjs unit`）的一部分 —— 分层 runner 用
`readdir` 枚举 `tests/unit/`，新增的 `email-*.test.mjs` 自动进 `pnpm test` 与 CI 的 `Unit tests` 步骤，
不需要额外接线。`test:email` 只是把这一块单独抽出来跑（约 6 秒），方便改动时只看红绿。

## 用例分组

| 组 | 文件 | 断言什么 |
| --- | --- | --- |
| 三态 / 错误码 / 入口探测 / 附加字段 | `tests/unit/email-427-api.test.mjs` | `has_email` / `email_masked` 四态；13 条错误码逐条（`send-code` + `verify` 两条路由）；409 **先按 `error.code`**、`customer_has_email` 不得落到「已绑定过邀请码」；无 `code` 时按状态码兜底；404 + `not_found` → 隐藏入口，`device_not_found` / 网络失败 / 404 无码 → 隐藏但 `code` 各自可辨；`attempts_left` / `retry_after` / `bound_email_masked` 的位置与垃圾值 |
| 采用路径 | `tests/unit/email-427-adopt.test.mjs` | `action:"login"` → `device_id` 与 `key` 被采用、坏 `device_id` 不落盘、相同不写、没 Key = `KEY_MISSING`；`action:"bound"` → 凭据一个字不动；失败分支零副作用；采用走的就是 `device.ts` 那条实现 |
| 文案 | `tests/unit/email-427-copy.test.mjs` | `oursInviteErr*` / `oursEmail*` 在 `src/i18n/zh.ts` 与 `src/i18n/en.ts` 两侧都存在、非空、占位符对齐，且在 `src/**` 里真被引用；409 两句话必须不同；交互文案的占位名与代码传的字段对得上 |
| 入口 / 提示分流 / 交互 | `tests/unit/email-427-ui.test.mjs` | 已绑邮箱不再出现「复制设备码备份」、绑定成功后当场消失、未绑时照旧出现；`retry_after` → 「N 秒后再试」、`attempts_left` → 「还剩 N 次机会」（含 0）、`bound_email_masked` → 已绑地址；login 切设备码 + 落 Key 且界面无 Key 原文 |
| #421 契约形状（存量） | `tests/unit/email-421-contract.test.mjs` | #426 落地时的请求形态、三态、错误码、入口、文案底线（26 例） |
| #421 入口组件（存量） | `tests/unit/email-421-entry.test.mjs` | 入口出现条件与备份提示分流（10 例） |

合计 6 个文件、83 例（`email-421-*` 36 + `email-427-*` 47）。

## 回归清单：改动哪一块必须跑哪组

改之前先按这张表确认「我动的是哪一格」，改完只跑那一行也够；发 PR 前跑一次全量 `pnpm test:email`。

| 你改了 | 必跑 | 为什么 |
| --- | --- | --- |
| `src/services/invite/api.ts` 的 `EMAIL_ERROR_KEYS` / `EMAIL_STATUS_KEYS` / `emailFailure` / `emailExtras` | `--only email-427-api` | 错误码分流、409 优先 `code`、状态码兜底、附加字段全在这几处；改一处就可能把「已绑邮箱」显示成「已绑定邀请码」 |
| `api.ts` 的 `parseInviteProfile` / `parseInviteProfile` 用到的 `readOptional*` | `--only email-427-api` + `--only email-421-contract` | 三态（缺失 → `null`、`false`、`true`、垃圾值）被邀请 / 额度 / 邮箱三处共用，改口径会同时影响老字段 |
| `api.ts` 的 `sendEmailCode` / `verifyEmailCode` 请求形态（路径、body、超时、`X-Device-Fp`、不跟随重定向） | `--only email-421-contract` + `--only email-427-ui` | 契约形状在 421，界面是否真发了在 427（`K6`） |
| `api.ts` 的 `fetchEmailStatus` / `shouldShowEmailEntry` | `--only email-427-api` + `--only email-421-entry` | 404 三向分流（`not_found` / `device_not_found` / 无码）与「入口出不出现」是一件事的两端 |
| `src/services/invite/email.ts`（`verifyEmailAndAdopt` / `adoptEmailVerify`） | `--only email-427-adopt` + `--only email-427-ui` | 采用路径唯一会写本地凭据的地方；写错没有任何报错，只有「号丢了」 |
| `src/services/invite/device.ts` 的 `adoptServerDeviceId` / `shouldShowDeviceBackupHint` | `--only email-427-adopt` + `--only email-427-ui` | #261 的「合法才写、相同不写」被邮箱登录复用；备份提示的三态被 #421 第 5 点复用 |
| `src/components/settings/OursServicesDialog.tsx` 的邮箱区块（入口 / 表单 / 结果区） | `--only email-427-ui` + `--only email-421-entry` | 提示分流与附加字段文案都在这里渲染 |
| `src/i18n/zh.ts` / `src/i18n/en.ts` 里 `oursEmail*` / `oursInviteErr*` | `--only email-427-copy`（并可另跑 `node scripts/check-i18n.mjs`） | 漏一侧、占位符错位、写了没人引用都只会在这里显形 |
| 任何一块 | `pnpm test:email` | 一条命令跑全量，失败非零退出 |

## 未覆盖边界（如实记录）

- **服务端未上线**（邮箱功能只在 `feat/email-signup`）：没有集成 / E2E / 真机 / 390·360 截图，
  全部断言都在 mock 下。真发信、频控窗口、验证码过期、多设备并发属服务端行为，客户端不覆盖。
- **秒级倒计时器不存在**：实现只在结果区显示一次 `oursEmailRetryAfter`（「N 秒后再试」）静态文案，
  没有逐秒递减的 UI 状态，因此「倒计时递减」这一格**填不了**。`K1` 覆盖的是「秒数来自服务端
  `retry_after`、不随本地时钟漂移、链路零 sleep」。若将来真的加了倒计时器，`K1` 里
  `clock.scheduled` 必须为空的那条断言会红 —— 那时应改成 tick 驱动（`clock.advance` 逐秒推进），
  不是删断言。
- **登录冲突弹窗**（`device_has_account` + `options`）未实现，不在 #427 覆盖范围（见 #421 边界）。
- 老服务端 404 无业务码的真实部署行为无法在本机复现，只用假 transport 模拟。

## CI

`pnpm test` 已经包含本组用例，CI 的 `Unit tests` 步骤会跑到，无需新增步骤。
如果后续想让它独立成一个 job / step，需要补的一行是 `run: pnpm run test:email`
（改 `.github/workflows/*` 需要 token 带 `workflow` scope，见 PR 说明）。
