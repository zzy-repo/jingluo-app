# #727 阶段 3：「我的卡密」/「历史消费」两屏照原型落版 + dev-only mock

维护者原话：「这两屏照原型重做样式」。本目录是**改完之后的实拍**：真实 dev server（8099）里
点「设置 → 账户与消费 → 我的钱包 → 我的卡密 / 历史消费」截的，不是组件级拼图。

数据来自 `src/components/consume/__mock__/walletDemo.ts`（**只 dev 构建**，开关见第 4 节），
所以这两屏不用登录、不用真买卡就能看到原型里的最终效果。

## 1. 两屏（390 / 360 × 每屏一张）

| 文件 | 视口 | 看点 |
| --- | --- | --- |
| `390/cards.png` | 390×844 | 三张卡：`••••RRQY` 已兑换 / `••••A3SR` 已兑换 / `••••JP9Q` 未兑换；1px 极浅描边 + 16px 内距 + 14px 圆角 + 卡间 12px；卡密 18px/600 字距 0.08em；徽标已兑换=浅绿底绿字、未兑换=浅灰底灰字；两枚 36px 胶囊按钮（`复制卡密` 描边 / `去兑换` 品牌色实心，已兑换那张是 disabled ghost） |
| `360/cards.png` | 360×740 | 同 390，窄一档；横向溢出 0 |
| `390/history.png` | 390×844 | 分组标题 `今天` / `昨天` / `11月19日`（13px 次级色）；每行「模型调用」+ 下一行时间 + 右侧 `-¥0.12`（16px/500、`tabular-nums`）；行间 1px 极浅分隔线，**没有描边盒子** |
| `360/history.png` | 360×740 | 同 390，窄一档；横向溢出 0 |

## 2. 与原型并排（左 = 原型 HTML 375 宽，右 = 实现 390×844）

| 文件 | 说明 |
| --- | --- |
| `compare-cards-390.png` | 卡密屏：三张卡的顺序、文案、徽标两态、按钮两态逐条对得上 |
| `compare-history-390.png` | 历史屏：分组标题 + 记录行 + 分隔线的层次一致 |
| `prototype-cards-375.png` | 原型那一屏（`服务Tab.html` 的 `screenCards()`） |
| `prototype-history-375.png` | 原型那一屏（`screenHistory()`） |

## 3. 断言与实测（`metrics.json`）

| 断言 | 实测（390 / 360 一致） |
| --- | --- |
| 卡密文本形如 `••••` + 4 位（`/^••••[A-Z0-9]{4}$/`） | 3/3：`••••RRQY` `••••A3SR` `••••JP9Q` |
| 徽标文案只有 `已兑换` / `未兑换` | `已兑换` `已兑换` `未兑换` |
| 已兑换那两张的「去兑换」是 disabled | `true,true,false` |
| 「复制卡密」复制的是**完整卡号** | 拦 `document.execCommand('copy')` 读回 `K7M4-2VQD-9XTB-RRQY`（≠ 掩码） |
| 金额匹配 `/^-¥\d+\.\d{2}$/` | `-¥0.12` `-¥0.20` `-¥0.36` `-¥0.05` `-¥0.08` |
| 金额是等宽数字 | `font-variant-numeric: tabular-nums`，16px / 500 |
| 分组标题存在且是「今天 / 昨天 / M月D日」 | `今天` `昨天` `11月19日`（13px） |
| 卡片几何 | `padding:16px`、`border-radius:14px`、`border-top-width:1px`、卡间 12px |
| 按钮几何 | `复制卡密` / `去兑换` 均 36 高、`999px` 胶囊 |
| `overflowCount` | **0**（两屏 × 两视口） |
| `consoleErrors` | **`[]`**（两屏 × 两视口） |

## 4. mock 数据只在 dev（生产构建摇得掉）

`__mock__/walletDemo.ts` 的唯一引用方式是：

```ts
if (process.env.NODE_ENV !== 'production') {
  if (未登录 || URL 带 ?mock=1) { const { DEMO_CARDS } = await import('./__mock__/walletDemo.js') … }
}
```

生产构建里 `process.env.NODE_ENV` 被 DefinePlugin 折成字面量 → 分支是死的 → 动态 `import()`
不注册 → 模块不进产物（**不是**靠 `sideEffects` —— 仓库根 `package.json` 没声明它，静态 import 摇不掉）。

```bash
$ ALLOW_INSECURE_CONSUME=true pnpm build     # 本机 config/endpoints.json 是别人在改的明文 staging，用这个开关放行
[build] OK dist/ 已生成
$ grep -r "RRQY" dist/ -l
（无输出）
$ grep -ro "RRQY\|JP9Q\|A3SR\|DEMO-727" dist/ | wc -l
0
```

正向对照（同一个开关在 dev 下必须**有**）：8099 打开「我的卡密」时浏览器拉的是
`static/js/async/src_components_consume___mock___walletDemo_ts.*.js`（含 `RRQY`），
也就是说这份数据是懒加载 chunk、只在 dev 的这条开关下才会被取。

## 5. 观察到但与原型不同（本单**不改**，留给维护者定）

1. **卡密屏顶部还有「兑换卡密」输入区**：原型那一屏只有卡片列表，但本仓的兑换入口就在这一页
   （`去兑换` 只是把卡号填进上面的输入框，提交仍要用户自己点）。删掉它等于删功能，所以按「原型样式 + 保留既有入口」处理。
2. **负号用 ASCII `-` 而不是原型的 `−`（U+2212）**：验收口径给的是 `/^-¥\d+\.\d{2}$/`，
   所以金额那一位是 ASCII hyphen（原型那一版用的是长减号，字形略宽）。要换回只改 `HistoryView.tsx` 一处。
3. **分组标题第二档是「昨天」不是「11月20日」**：验收口径写的是「今天 / 昨天 / M月D日」，
   而原型把日期写死了。所以 mock 的时间戳按「相对今天」生成，换一天打开也还是这三档。
4. **卡密文本用等宽字体**：原型是系统字体；这一格在本仓一直是 `--ds-font-family-code`
   （`••••` 与后 4 位对齐得更稳），尺寸/字重/字距按原型放大到 18px / 600 / 0.08em。
5. **外框仍是设置弹层**：截图里上面那条「设置 / 通用设置 · 数据管理 · 账户与消费」是 8099 上的真实
   入口容器（#727 阶段 1 已定的形态），原型是整页手机壳。

## 6. 怎么重新生成

```bash
node scripts/shot-727-wallet-lists.mjs                                  # 390 + 360 × 两屏
node scripts/shot-727-wallet-lists.mjs --viewport=390                    # 只拍一档
node scripts/shot-727-wallet-lists.mjs --base=http://127.0.0.1:8099/     # 换端口
node scripts/shot-727-wallet-lists.mjs --proto=wt-727/proto/服务Tab.html  # 额外产出「与原型并排」两张
```

脚本直接打 `http://100.113.135.55:8099/?mock=1`，用真入口点进去；**不打桩、不发请求**
（mock 那条分支一个后端都不碰），所以 `consoleErrors` 天然是 `[]`。任一断言不成立即 exit 1。

> 截图均为浏览器视口截图（`deviceScaleFactor: 2`），不是真机截图。
