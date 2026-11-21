# #727 阶段 1（P0 最小可发布集）：设置 →「账户与消费」整页

本目录是这一轮的 UI 验收取证（390×844 / 360×740 两档，未登录 + 已登录两态），
由仓库既有工具 `scripts/shot-mobile.mjs` 的 `--page=727-consume-page` 生成（纯对象注册表里加的一条）：

```bash
node scripts/build.mjs --internal            # 先出 dist
node scripts/shot-mobile.mjs --page=727-consume-page --viewport=390,360
```

## 1. 层级证据（一次点击进整页，再一次点击到账号）

```
设置（侧栏「设置」）
 └─ 导航第三项「账户与消费」        ← 一级入口，1 次点击，不再藏在「数据管理」分组里
     └─ 页面：模型来源 / 连通性测试 / 我的钱包（余额卡 + 三行）/ 账号
         └─ 「账号」行                  ← 第 2 次点击
```

- 一级入口：`nnn-consume-page-00-settings-entry-{390,360}.png`（设置导航里三项平级）
- 整页：`01-page-home-signed-out` / `07-page-home-signed-in`
- 到账号：`06-account-signed-out` / `08-account-signed-in`

改前：设置 → 数据管理 → 该分组里的一格「查看」（2 次点击 + 一个描边盒子）。
改后：设置 → 账户与消费（1 次点击）。**旧的 `SettingCell` 已删**：

```bash
$ grep -rn "accountConsumeEntryDescription\|oursPayRecordsEntryAction" src/components/settings/
# 只剩导航项的 title 复用那一句说明；旧的「查看」按钮与它的 SettingCell 一起删了
$ grep -rn "SettingCell" -A 3 src/components/settings/SettingsDialog.tsx | grep -c account-consume-open
0
```

## 2. 与原型同屏对照

| 并排图 | 说明 |
| --- | --- |
| `compare-01-page-home-signed-out.png` | 原型「服务」首页 vs 实现（未登录） |
| `compare-02-source-sheet.png` | 原型「模型来源」底部弹层 vs 实现 |
| `compare-03-auth-dialog.png` | 原型「登录」居中对话框 vs 实现 |

**刻意保留的差异（与理由）**

| 原型 | 实现 | 为什么 |
| --- | --- | --- |
| 首页只有「模型来源 / 我的钱包 / 账号」三行 | 多出「连通性测试」一行 | 原型只在已选来源后显示它；本仓的来源（`ProviderKind`）**永远有值**（默认渠道），所以常驻，行为等价 |
| 钱包页 / 卡密页 / 历史页 / 账号页是四个独立页 | 四块内容在**同一页**里按行切换（`role="tablist"`） | #727 §三 第 4 条：`data-testid` / `aria-*` / 事件绑定不许因布局而变。付款回跳与消息流 CTA 的 `openAccountConsume(tab)` 深链仍然落在同一块；四个 `account-consume-tab-*` 只是从 pill 按钮搬到 inset 列表行 |
| 模型来源三选一（内置 / 第三方 / DeepSeek 官方） | 四选一 = 既有 `PROVIDER_SPECS`（DeepSeek 官方 / Anthropic 协议 / OpenAI 兼容 / 我们的渠道） | 不进第二套渠道枚举：原型的「第三方服务」在仓库里是**两条协议**，合并成一条会让用户选不到自己那家中转 |
| sheet 里直接填「接口地址 / API Key」 | sheet 只切来源，末尾一行「去设置里填写 API Key 与服务地址」跳既有 `ApiConfigFields` | 地址 / Key 的输入行、校验、保存、必错拦截（#451 / #490 / #596）都只有一处实现；在 sheet 里重画一套输入框就是第二套 |
| 余额卡只显示「剩余余额」 | 多一行「已用 ¥12.34」 | 「已用」= `usage.total.actual_cost`（`quotaSummaryOf`），把它显示出来才能一眼验证口径不是 `quota.used`（实测恒 0） |

## 3. 量数（`metrics.json`）

| 视口 | overflowCount | consoleErrors | 备注 |
| --- | --- | --- | --- |
| 390×844 | 0 | `[]` | 8 个状态各量一次 |
| 360×740 | 0 | `[]` | 同上 |

同一次运行里断言的其它数字（都写进 `metrics.json`）：

- 大标题 `34px / 700`（原型 `.h1`）
- 四个入口行行高 `56px`（原型 `.row`）
- 模型来源 sheet：贴底 `bottomGap=0`、宽度 = 视口宽
- 登录 dialog：`segmented` 两段（登录 / 注册）、含「不登录也可以…」、没有第二张内嵌登录卡
- 连通性：点下去才发请求，落到 `phase=ok`、绿点 `rgb(34, 197, 94)`、文案 `正常 N ms`
- 卡密：2 行、脱敏（完整卡密不进 DOM 文本）
- 已登录：余额卡 `¥128.50` + 已用 `¥12.34`（来自 `/v1/usage` 的 `balance` 与 `usage.total.actual_cost`）

## 4. 三态里的另两态怎么验

`正常 / 未测试` 在截图里；`Key 无效`（401/403）与`网络或配置错`（超时 / 断网 / 非 JSON / 5xx）
由单测钉住分类与文案：`tests/unit/727-consume-home.test.mjs` 的 `[1]` / `[1b]`。
截图里不摆 401，是因为浏览器会把 401 打成一条 `Failed to load resource` 的 console error，
而本页的验收要求是 `consoleErrors: []` —— 摆拍一条必然带红字的状态没有意义。

## 5. 文件

- `390/` 与 `360/`：9 张/档（`00-settings-entry` … `08-account-signed-in`）+ `metrics.json`
- `compare-*.png`：与原型 HTML 的并排对照（左 375 宽原型，右实现截图）
