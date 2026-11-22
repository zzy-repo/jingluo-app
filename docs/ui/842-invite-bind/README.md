# #842 登录后填写邀请人（390 / 360）

**这是浏览器视口截图（组件级同源渲染 + headless Chromium，`deviceScaleFactor: 2`、`isMobile`），不是真机截图，也不是模拟器截图。**
入口 `INVITE_BIND_ENABLED` 默认关闭，整页 dist 里看不到，所以用真视图函数 + 真样式表渲染，数据是脚本里的 mock 夹具，
**没有对任何真实接口验证**（后端 `POST /api/v1/user/aff/bind` 尚未上线）。

生成：`node scripts/shot-invite-bind-842.mjs --out=docs/ui/842-invite-bind`

| 场景 | 390 | 360 |
| --- | --- | --- |
| 未绑定：输入框 + 提交 | `390/unbound-390.png` | `360/unbound-360.png` |
| 错误提示（400 `AFFILIATE_CODE_INVALID` 文案） | `390/error-390.png` | `360/error-360.png` |
| 已绑定只读 | `390/bound-390.png` | `360/bound-360.png` |

六张图横向溢出均为 0px。截图里「注册时填写邀请码（可选）」一行是 #841 要删的既有文案，本单没动。
