# 真机验证：额度与卡密（兑换链路走**本地 mock 后端**）

> ⚠️ **本目录里的「兑换成功」全部来自本地 mock 服务，不是真实兑换。**
> 真实卡密（线上）已被用掉，本次不碰任何真实卡密、不调用 `/rotate`、不发版。

## 为什么不用 page.route

之前实测：Android WebView 下 Capacitor 把请求交给**原生 `CapacitorHttp`**，页面级 `fetch` 拦截
根本看不到这些请求（还因此误发过一条测试反馈）。所以 mock 只能发生在**构建期**：

```
测试分支 test/pay-mock-device（基于 feat/pay-reapply）
  └─ rspack DefinePlugin 注入 __TEST_INVITE_API_BASE__ / __TEST_OURS_API_BASE__
       └─ src/services/invite/api.ts   INVITE_API_BASE  → http://10.0.2.2:8099
       └─ src/services/ours/api.ts     OURS_API_BASE    → http://10.0.2.2:8099
```

覆盖为空串时行为与正式构建完全一致（回落硬编码地址），所以这份补丁**不会**改变发布行为。

## 文件

| 文件 | 作用 |
| --- | --- |
| `scripts/mock-pay-server.mjs` | 零依赖 node mock：`/apply` `/me` `/api/plans` `/api/balance` `/api/redeem` `/buy`，并记录每个请求（脱敏） |
| `scripts/apply-url-override.mjs` | 打测试专用 base URL 覆盖补丁（幂等，可 review） |
| `scripts/build-test-apk.sh` | 构建测试 APK：`INTERNAL_BUILD=1` + 覆盖地址 + `assembleDebug -PartifactVariant=internal`（debug 签名） |
| `scripts/device-verify.mjs` | 真机（模拟器）全链路断言 + 390/360 截图，走 WebView CDP |

## mock 的契约（与线上同形）

| 请求 | 行为 |
| --- | --- |
| `POST /apply {device_id}` | 201 首次（同一 device_id 再申请 → 200 幂等）；返回 `key`（假 key `sk-mock-dNmock01`）、`invite_code`、`quota_points/remaining_points = 100` |
| `GET /me?device_id=` | 当前 `remaining_points`（redeem 会 +300） |
| `GET /api/plans` | `p1 ¥3.00/300`、`p2 ¥39.00/3900` |
| `GET /api/balance` | 需 `Authorization: Bearer`（缺 → 401）；返回 `{valid:true}`，不返回额度 |
| `POST /api/redeem {card_no,api_key,request_id}` | `MOCK-OK` 首次 → 200 `{ok:true,points:300,sync:"credited"}` 且 `remaining_points += 300`；`MOCK-OK` 第二次 / `MOCK-USED` → 409 `CARD_ALREADY_USED`；其它卡号 → 404 `CARD_NOT_FOUND` |
| `GET /buy?plan=` | 默认 `no-location`：302 **不带** Location（验证「拿不到收银台地址」的可读提示）；`POST /__control/buy-mode {"mode":"redirect"}` 切到带 Location（验证交给系统浏览器，不付款） |

控制面（只给测试脚本用）：`/health`、`/__log`、`/__control/clear-log`、`/__control/reset`、`/__control/buy-mode`。

日志脱敏：Key 只留尾 6 位、卡密只留尾 4 位，并额外记录
`urlHasKeyParam` / `urlLeaksMockKey` / `auth.isBearer` 三个断言标记。

## 跑一遍

```bash
# 0) 单台模拟器（compat31 / Android 12 / WebView 91），启动前 available ≥ 6GiB、无 Gradle 在跑
# 1) 起 mock
node scripts/mock-pay-server.mjs &
curl -s localhost:8099/health

# 2) 构建测试 APK（在 test/pay-mock-device 的 worktree 里）
MOCK_PORT=8099 ./scripts/build-test-apk.sh

# 3) 真机验证（脚本自己装包、清数据、走 CDP）
APK=dist-mock-device/app-debug-mock-device.apk node scripts/device-verify.mjs

# 4) 收尾
adb emu kill
```
