# #817 钱包页付款入口（Android 13 模拟器，非真机）

| 文件 | 内容 |
| --- | --- |
| 01-before.png | 修复前：余额卡独占一行，带「我的额度 ›」，没有付款入口 |
| 02-after-default.png | 修复后：余额在左、「充值」在右，同一行，「我的额度」已删 |
| 03-after-360-long-balance.png | 360 宽度 + 极端长余额 `¥123456789012.34`：余额折成两行，按钮完整，不出卡片 |
| 04-pay-page-in-app.png | 点「充值」后收款页在 App 内（Chrome Custom Tab）打开 |
| 05-back-to-cards.png | 关掉收款页回到 App，落在「我的卡密」；未登录时 toast「登录后卡密会自动到账」 |

说明：模拟器、未登录态。已登录后的自动兑现（#784）本次未实测，代码里触发点仍只有 `backToCards`（见 `tests/unit/wallet-pay-entry-817.test.mjs`）。
