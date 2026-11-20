# 「账户与消费」四面板截图（W1-C2 #487）

两档验收宽度（390×844 / 360×740）下四个面板的组件级截图。

| 文件 | 场景 | 看点 |
| --- | --- | --- |
| `quota-{390,360}.png` | 额度面板（钱包模式） | 余额 / 已用（= `usage.total.actual_cost`，不是恒为 0 的 `quota.used`）+ 展开的用量列表 + 「加载更多」；金额一律 `¥`（元，1 元 = 1 额度）|
| `quota-nokey-{390,360}.png` | 额度面板 · 还没有 Key | 不发请求，直接引导去「账号」标签页创建 Key |
| `account-{390,360}.png` | 账号面板 | 资料（邮箱 / 余额 / 注册时间）+ 「Key 只显示这一次」块（完整值 + 复制）+ Key 列表（**只显示末 4 位**）|
| `invite-{390,360}.png` | 邀请面板 | 邀请码（可复制）/ 已邀请人数 / 返利余额（元 / ¥）+「注册时填、按比例结算」的新语义说明 |
| `email-form-{390,360}.png` | 邮箱绑定 · 换绑表单 | 脱敏后的当前邮箱 + 「需要先验证邮箱」+ 发码倒计时（42s）|

## 怎么重新生成

```bash
node scripts/shot-consume-panels.mjs                        # 两档 × 全部场景
node scripts/shot-consume-panels.mjs --scene=account        # 只截一个场景
node scripts/shot-consume-panels.mjs --viewport=390 --out=docs/ui/consume-panels
```

脚本在 Node 里用**真视图函数**（`src/components/consume/*.ts` 的 `createElement`）`renderToStaticMarkup`，
再配上真样式表（`src/app/theme.css` 令牌 + `src/app/global.css` + `panels.module.css`）由 Playwright 截图，
所以截出来的版式与真机同一份 CSS、同一份文案表；数字来自脚本里声明的夹具（按契约 §3 的实测字段写）。

两点边界必须说明：

1. **这是浏览器视口截图，不是真机截图**（不能替代 adb / 真机取证，见 `docs/ISSUE-STANDARD.md`）；
2. 页面外壳（`AccountConsumePage.tsx`）由 W1-C1 负责，本单只交付面板组件，所以这里**不走 `dist/` 整页**，
   而是同源渲染单个面板 —— 外壳接线后的整页取证在 W1-C1 的单子里做。

脚本每次都会量一次横向溢出：390 / 360 两档都必须为 0px，出现溢出直接 exit 1（本次全部 0px）。
