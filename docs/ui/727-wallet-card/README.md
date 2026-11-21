# #727 阶段 2：「我的钱包」余额卡 + 购买按钮（截图证据）

维护者原话：「这个充值太丑了」。本目录是**改完之后的实拍**：真实 dev server（8099）里点
「设置 → 账户与消费 → 我的钱包」打开那一页截的，不是组件级拼图。

| 文件 | 状态 | 看点 |
| --- | --- | --- |
| `390/signed-in.png` | 已登录 · 390×844 | `剩余余额` + `¥12.34`（30px / 600 / 等宽数字）→ 1px 极浅分隔线 → `我的额度 ›`（56px 行）→ **整宽品牌色** `购买 / 充值`（48px） |
| `390/signed-out.png` | 未登录 · 390×844 | 金额位不再是破折号：`登录后查看` + 右端可点的 `登录 ›`；按钮照旧可点，按钮下方一行 12px `登录后可在此查看卡密` |
| `360/signed-in.png` | 已登录 · 360×740 | 同 390，窄一档；按钮宽度 = 卡片内容宽（276 / 276） |
| `360/signed-out.png` | 未登录 · 360×740 | 同 390；横向溢出 0 |
| `390/signed-in-no-data.png` | 已登录 · 服务端没给余额 | `¥0.00`（**不是** `—`，也不是空白） |
| `360/signed-in-no-data.png` | 同上 · 360 | 同上 |
| `390/buy-page-after-click.png` | 点「购买 / 充值」之后 | 进的是既有购买页（`BuyTab`：套餐表 + 「去支付」），余额卡已换走 |
| `360/buy-page-after-click.png` | 同上 · 360 | 同上 |
| `metrics.json` | 两档 × 四态 | `overflowCount` / `consoleErrors` / 按钮宽度占比 / 字号字重等实测值 |

## 怎么重新生成

```bash
node scripts/shot-727-wallet-card.mjs                        # 390 + 360，四个状态全拍
node scripts/shot-727-wallet-card.mjs --viewport=390          # 只拍一档
node scripts/shot-727-wallet-card.mjs --base=http://127.0.0.1:8099/
```

脚本直接打 `http://100.113.135.55:8099/`（正在跑的 dev server），用真入口点进去；两处打桩只
为了让「浏览器里也能看到真实版式」，不改产品行为：

1. `nativeBridgeStub`：消费层只走 `CapacitorHttp`，浏览器里没有原生桥时请求直接 `unsupported`
   —— 桩把它转成一次 `fetch`（配方同 `scripts/shot-mobile.mjs` / `tests/golden/g15,g16`）；
2. `page.route()`：拦截消费侧 / 支付侧两套端点，回契约形状的固定报文。已登录那张写的是**真格式**
   的落盘凭据（`chat-demo:auth-token` = `{v:1,token,user}`）再 reload，让后台 `restoreAuth()`
   真跑一遍，登录态的唯一真值仍是 `useAuthStore`。

## 断言（脚本内，任一不成立就 exit 1）

- 余额位元素存在且文本**不是** `—`（未登录 → `登录后查看`；已登录无数据 → `¥0.00`）；
- 购买按钮 `isVisible()`，且宽度 / 卡片内容宽 ≥ 0.9（实测两档都是 **1.0**）；
- 购买按钮**独占一行**（`top` 在「我的额度」行的 `bottom` 之下）；
- `overflowCount === 0`、`consoleErrors === []`（两档四态全部为 0）；
- 点「购买 / 充值」后必须出现购买页的套餐行，且余额卡已从 DOM 移除。
