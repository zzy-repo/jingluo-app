# #842 登录后填写邀请人：整页联调前自检（390 / 360）

**这是浏览器视口截图（headless Chromium，`deviceScaleFactor: 2`、`isMobile`、`hasTouch`），不是真机截图，也不是模拟器截图。**
页面是开发预览（rspack dev server），**真登录**（staging 测试账号），入口 `INVITE_BIND_ENABLED` 只在预览的**本地补丁**里改成 `true`，仓库里仍是 `false`。

`POST /api/v1/user/aff/bind` 以及「已绑定」状态下 `GET /user/aff` 的 `inviter_id` 由**本地契约模拟层**回包（形状按 #856 的 staging 实测），
其余请求（登录、`GET /user/aff` 等）原样走真 staging。staging 上 `affiliate_enabled=false`，真接口只能走到 `AFFILIATE_DISABLED`，
所以**这些截图里的成功 / 已绑定 / 名额满 / 码无效都是模拟，不是真接口结果**。

| 文件前缀 | 场景（假码） |
| --- | --- |
| `00-signedout` | 未登录：整块不渲染（#846） |
| `01-unbound` | 未绑定：输入框 + 提交 + 「只能绑定一次」说明 |
| `02-format-error` | 客户端校验：格式不对，不发请求 |
| `03-submitting` | 提交中（`SLOWCODE`，3 秒）：按钮「提交中…」且禁用，输入框禁用 |
| `04-bound` | 成功（`GOOD0001`）→「已绑定邀请人」只读，无邀请人个人信息 |
| `05-invalid` / `05-disabled` / `05-full` | `BADCODE0` / `DISABLED0` / `FULLINV00` |
| `05-already-bound` | `BOUND000`：409 → 切只读并重拉 `GET /user/aff` |
| `05-ratelimit` | `LIMIT000`：429（**不在真实契约里**，只演示通用分支） |
| `05-server500` / `05-noreason400` / `05-netdrop` | `SERVER50` / `NOREASON0` / `NETDROP0`：通用失败 |
| `06-bound-after-reload` | 刷新后仍是已绑定 |
| `07-layout` / `07-keyboard-sim` | 窄屏布局；缩视口高度**模拟**键盘（不是真软键盘） |

`results.json` 是本次自检的断言记录（134 项，含 390 与 360 两套）。
