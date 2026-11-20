# #487 A7 验收截图：三个钱入口合成一格「账户与消费」

`#484 §九 A7` 的口径是「UI 收敛」，脚本（`scripts/check-refactor-direction.mjs`）不判、也不该判，
只要求一张 **390 宽**截图确认这件事：

> 设置里「付款记录 / 我的购买 / 支付时间线」三个入口已经合成**一个**「账户与消费」页。

这批图就是这条判据的取证（来源 `pnpm shot:mobile -- --page=a7-entry --viewport=390`）。

| 文件 | 视口 | 场景 |
| --- | --- | --- |
| `390/a7-entry-01-settings-data-account-consume-entry-390.png` | 390×844（DSF 2、`isMobile`、`hasTouch`、`locale=zh-CN`） | 设置 → 数据管理，滚到「账户与消费」那一格 |
| `390/a7-entry-02-entry-closeup-390.png` | 同上 | 那一格的放大图（格子标题 + 描述 + 「查看」） |
| `390/metrics.json` | — | 截图时同时量到的数字（见下） |

## 判据是量出来的，不是「看着像」

`metrics.json` 的 `accountConsumeEntry` 每次截图都会重新量；改坏了直接看得见：

| 判据 | 期望 | 本次实测（390） |
| --- | --- | --- |
| `[data-testid="account-consume-open"]` 个数 | **1**（合成一格） | 1 |
| 旧三个入口 `payment-records-open` / `purchases-open` / `payment-trail-open` | **各 0**（真的搬进新页面，不是藏在别处） | 0 / 0 / 0 |
| 设置页正文里的旧叫法「付款记录 / 我的购买 / 支付记录」 | **0 处**（同一件东西不许有两份名字） | `[]` |
| 横向溢出 `scrollWidth > clientWidth` | 不溢出 | false |
| 「查看」按钮点击区高度 | ≥ 44px（移动端下限） | 44 |
| 这一格完整落在视口内 | true（否则这张图证明不了「一眼看到」） | true |
| 控制台错误 | 0 条 | `[]` |

## 怎么重新生成

```bash
TEST_AUTH_SEAM=1 pnpm build          # 未登录冷启动只会画登录页，截不到设置页（接缝只改启动判定）
pnpm shot:mobile -- --page=a7-entry --viewport=390
# 或直接：node scripts/shot-mobile.mjs --page=a7-entry --viewport=390 --out=docs/ui/487-a7-entry
```

## 边界（别当成真机取证）

- **浏览器视口截图**，不是真机截图（真机取证另走 adb，见 `docs/ISSUE-STANDARD.md`）。
- 用的是 `TEST_AUTH_SEAM=1` 的测试产物：登录墙之后的界面在浏览器里没有真账号可登，
  接缝只把「启动判定」置成已登录（`docs/TESTING-POLICY.md` 第 13 节），设置页与发版产物逐字相同。
- 里头的 API Key 是假串，渠道类型被预置成 `ours`（这格只在自有渠道出现，#166），不涉及真实凭据。
