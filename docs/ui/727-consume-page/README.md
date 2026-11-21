# #727 验收取证（对 `main` 上的实现拍）

`main` 上 #727 的实现已由 **#758** 合入（1.4.8 定版 `ccd4dff`）。本目录补的是 **#758 缺的验收取证**；
其中第 1 节那个真实缺陷已单独合入 main（**#762**），这里保留 before/after 作为它的取证。

```bash
node scripts/build.mjs --internal
node scripts/shot-mobile.mjs --page=727-consume-page --viewport=390,360
```

## 1. 360 档：设置导航第三项「账户与消费」被裁切（已修，见 #762）

`main` 上 `.navItem` 是 `flex: 1 0 auto; min-width: 108px`。加了第三项之后，360×740 档三项的
内容宽度合计 328px > 导航可视宽 320px → 导航变成横向滚动，第三项顶在屏幕右边缘被切掉（「账户与消…」）。

| | before | after |
| --- | --- | --- |
| 整屏 | `nav-360-before.png` | `nav-360-after.png` |
| 导航特写（判据都在这张） | `nav-360-before-closeup.png` | `nav-360-after-closeup.png` |

同一台机器实量（`scrollWidth` / `getBoundingClientRect`，360×740，自有渠道）：

| 指标 | before | after |
| --- | --- | --- |
| 导航 `clientWidth` | 320 | 320 |
| 导航 `scrollWidth` | **344**（溢出 24） | **320**（不溢出不滚动） |
| 第三项右边缘 | **360**（= 视口右边界，被切） | **336**（留 24px 右边距） |
| 第三项宽度 | 112（内容宽，挤不动） | 111（三项平分一行） |

修法只有那一条规则：`flex: 1 0 auto` → `flex: 1 1 auto`、`min-width: 108px` → `92px`。
两项时 `flex-grow: 1` 仍撑满，行宽与改动前一致。

## 2. 整页取证：390 / 360 × 未登录 / 已登录（9 张/档）

| 文件 | 证明什么 |
| --- | --- |
| `00-settings-entry` | 设置里「账户与消费」是**一级入口**（导航第三项），且全页**只有 1 个** `account-consume-open` |
| `01-page-home-signed-out` | 整页骨架：34px 大标题 · 56px inset 行 + 分隔线 · 余额卡（未登录给「—」不是 0.00） |
| `02-source-sheet` | 模型来源**底部 sheet**，选项 = 既有 `ProviderKind` 四档 |
| `03-connectivity-ok` | 点一下才发请求，落到 `正常 N ms` + 绿点 |
| `04-cards` | 卡密卡：脱敏尾号 + 已兑换 badge + 复制 / 去兑换；**完整卡密不在 DOM 文本里** |
| `05-history` | 历史消费分区（`HistoryView`）—— mock 未命中行时是空态，属正常态 |
| `06-account-signed-out` | 未登录 = 「不登录也可以…」+ 去填 API Key + 登录/注册 segmented 卡片（**不是登录墙**） |
| `07-page-home-signed-in` | 已登录余额卡 `¥128.50`（`/v1/usage` 的 `balance`） |
| `08-account-signed-in` | 资料头 + 账号 ID / 绑定邮箱 / 登录方式 + 退出登录行；JWT 字面量不上屏 |

`metrics.json`（每档一份，顶层可直接读）：

| 视口 | `overflowCount` | `consoleErrors` | 截图 |
| --- | --- | --- | --- |
| 390×844 | **0** | **`[]`** | 9 |
| 360×740 | **0** | **`[]`** | 9 |

同一次运行里断言（不满足即**抛错**，不是 warn）：四个分区入口都在且行高 56px、模型来源选项 = 4 条、
sheet 贴底、连通性落到 `ms`、卡密脱敏且完整卡密不上屏、segmented 两段、余额 `128.50`、资料头有邮箱、JWT 不上屏。

## 3. 与原型同屏对照（左 375 宽原型 HTML，右实现截图 390×844）

- `compare-01-page-home-signed-out.png`
- `compare-02-source-sheet.png`
- `compare-06-account-signed-out.png`

## 4. 观察到但与原型不同（本 PR **不改**，留给维护者定）

1. **sheet 不是通栏贴底**：实量宽度 358 / 视口 390、`bottomGap = 8px`（原型是 100% 宽、贴底）。
2. **菜单用词**：来源是「内置服务 / 第三方服务 / DeepSeek 官方服务 / Anthropic 协议服务」，
   钱包四行是「我的卡密 / 历史消费 / 我的额度 / 购买」（原型是「我的钱包」下两行）。
3. 首页常驻「连通性测试」一行（原型是选了来源之后才出现）——本仓来源永远有值，等价。
4. `05-history` 的空态：本页 mock 的 `/api/v1/usage` 形状没被 `HistoryView` 认出来（字段名口径不同），
   取证时保留空态截图；这一条只影响取证数据，不是产品缺陷，未在本 PR 里改 `HistoryView`。

> 本目录的截图均为**浏览器视口截图**（`deviceScaleFactor: 2`），不是真机截图。
