# #817 验收取证：「我的钱包」页首那一行（余额卡 + 付款入口）

```bash
node scripts/measure-wallet-head-817.mjs            # 390/360 两档 + 两个压力档，写本目录
node scripts/measure-wallet-head-817.mjs --no-write  # 只量不落盘
```

**量的不是手抄的示意图**：markup 由 `src/components/consume/walletHeaderView.ts` 的
`WalletHeaderView` 真渲染（`renderToStaticMarkup`，与单测同一份源码），CSS 直接读
`src/app/theme.css`（设计 token）+ `AccountConsume.module.css`；外层壳只复刻
`Settings.module.css` 的三条真实规则（弹层左右 24px 内距 / `.content` 的 `padding: 0 24px` /
`margin-right: -24px`），所以内容宽 = 视口 − 72。

## 实测（Chromium / Playwright 1.64.1，`measured.json` 记着两次运行的时间）

| 档位 | 内容宽 | 余额卡 + 入口 | 余额数字 | 横向 |
| --- | --- | --- | --- | --- |
| 390×844 | 318px | 225 + 81px，**同一行** | `¥128.50`，未裁未拆行 | `head 318/318`、`document 390/390` → **无溢出** |
| 360×740 | 288px | 195 + 81px，**同一行** | `¥128.50`，未裁未拆行 | `head 288/288`、`document 360/360` → **无溢出** |

`metrics.json`（每档一份，顶层可直接读）：`head.rowCount = 1`（卡与入口中线差 < 2px = 同一行）、
`balance.clipped = false`、`balance.wrapped = false`、`head.scrollWidth === head.clientWidth`。

## 「放不下时怎么办」——折行，不做横向滚动

压力档（只打印、不落 `docs/`，脚本里带断言）：

| 压力档 | 结果 |
| --- | --- |
| 320×720（比 360 更窄） | **仍然同一行**（余额卡 155 + 入口 81），无横向溢出 |
| 360×740 + 长金额 `¥1234567.89` | **折行**：入口掉到余额卡下一行、靠右；无横向溢出；数字完整（`clipped=false`、`wrapped=false`） |

折行靠的是两条 CSS（`AccountConsume.module.css` 的 `.walletHead` / `.walletHead .balance`）：

- `.walletHead { display: flex; flex-wrap: wrap; gap: 8px 12px }` —— 放不下就**整块**折行，
  这一行（和它的容器）都**没有** `overflow-x`，所以不存在横向滚动；
- `.walletHead .balance { flex: 1 1 auto; min-width: min-content }` —— 卡可以先缩，
  但绝不缩到比「¥128.50」还窄：压不下去时由上面的 `flex-wrap` 折行，而不是把数字拆开 / 截断。

## 付款入口是什么

`data-testid="account-consume-wallet-pay"`（文案复用既有词条 `oursBuyAction` =「去支付」），
点它只是换页到 **`buy` 子页**（`WALLET_PAY_ENTRY_PAGE`，`src/components/consume/walletPayFlow.ts`），
那一页挂的就是既有 `BuyTab`（`/api/pay-link` + `openPayLinkInApp`）——**没有第二套付款逻辑**。
收款页关掉之后落在 **`cards` 子页**（`landAfterPayReturn` → `onNavigate('cards')`），
调用链见 `walletPayFlow.ts` 的文件头与本单 PR 说明。

## 余额卡的契约没动

`data-testid="account-consume-balance"` 仍挂在余额卡那个 `div` 上（#727 起的既有契约）；
被删掉的只有卡里那条「我的额度」入口（`account-consume-tab-quota`）—— 连带「我的额度」整页退场，
详见 `tests/unit/wallet-pay-entry-817.test.mjs` ②。
