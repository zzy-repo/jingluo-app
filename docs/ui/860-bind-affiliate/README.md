# #860 填写邀请人入口跟 `affiliate_enabled`（产物级截图）

构建产物 + 真 staging 登录（测试账号），390×844 / 360×740。`closed` 场景只用 `page.route` 改写前端看到的
`GET /api/v1/settings/public`（`affiliate_enabled:false`），不改真数据，不发任何 `aff/bind`。

| 文件 | 场景 | 填写邀请人表单 | 面板其余内容 |
| --- | --- | --- | --- |
| `real-390.png` / `real-360.png` | 真实 staging（`affiliate_enabled=true`） | 显示 | 邀请码 / 已邀请 1 人 / 返利余额 |
| `closed-390.png` / `closed-360.png` | `affiliate_enabled:false`（改写） | **不显示** | 照常显示 |
| `unreadable-390.png` / `unreadable-360.png` | `settings/public` 读取失败（请求中止） | 显示（读不到不等于关闭） | 照常显示 |
