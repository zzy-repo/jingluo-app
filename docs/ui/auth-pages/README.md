# 登录 / 注册页截图（W1-B 前半，Issue #487）

两档手机视口 × 9 个状态，共 18 张。**这是浏览器视口截图，不是真机截图**（口径见
`docs/ISSUE-STANDARD.md`）；AuthGate 还没接进首启流程（W1-B 后半才接），所以这批图是把
组件单独挂在一个临时页面上拍出来的，不是从 `dist/` 的完整 App 里点出来的。

| 项 | 值 |
| --- | --- |
| 视口 | 390 × 844、360 × 740（`deviceScaleFactor=2`、`isMobile`、`hasTouch`、`locale=zh-CN`） |
| 被测代码 | `src/components/auth/LoginPage.tsx`、`RegisterPage.tsx`、`AuthGate.tsx` |
| 语言 | 中文（全部文案来自 `src/i18n/zh.ts` 的 `sub2auth*` / `inviteCode*` / `oursEmailCodePlaceholder`） |
| 主题 | 浅色（深色走同一批 CSS 变量，`body[data-ds-dark-theme]` 下自动跟随） |
| 量数 | 每档的 `metrics.json`：横向溢出、文档高度、输入框高度（均为 44px） |

## 场景

| 文件 | 状态 | 看什么 |
| --- | --- | --- |
| `login.png` | 登录页 · 空表单 | 标题 / 两个字段 / 主按钮 / 注册入口（`registration_enabled=true` 时才显示） |
| `login-error.png` | 登录页 · 提交失败 | 错误条文案来自 transport 归一结果的 `messageKey`（这里是 `sub2authCredentialInvalid`） |
| `login-busy.png` | 登录页 · 提交中 | 按钮置灰 + `aria-busy` + 按钮内 spinner，布局不跳 |
| `login-no-register.png` | 登录页 · `registration_enabled=false` | **注册入口整块消失**（不是置灰），只剩登录 —— #484 §3.1d 的口径 |
| `register.png` | 注册页 · 完整字段 | 邮箱 / 验证码（`email_verify_enabled`）/ 密码 / 确认密码 / 邀请码（`invitation_code_enabled`） |
| `register-code-sent.png` | 注册页 · 验证码已发 | `sub2authCodeSent` 的 `{seconds}` 倒计时 + 发送按钮冷却置灰 |
| `register-invalid.png` | 注册页 · 本地校验 | 邮箱格式错误用 `sub2authEmailInvalid` 上屏；密码长度 / 两次不一致只标红框（缺词条，见下） |
| `register-busy.png` | 注册页 · 提交中 | 按钮 spinner，其余字段保持可见 |
| `gate-loading.png` | AuthGate · 启动恢复中 | 只有 spinner：恢复完成前不闪登录页 |

## 复现

组件是**受控**的（`LoginPage` / `RegisterPage` 只吃 props、不认识 store），所以可以直接挂到任意
临时页面上拍：`react-dom/client` 的 `createRoot` + `import` 三个组件，`scene` 走查询串，
Playwright 用上表的视口截屏。本次临时页面与脚本放在仓库之外的 `/tmp`（不提交），原因是
`src/main.tsx` 目前仍是「占位接线」（`void restoreAuth()`，渲染树没动），W1-B 后半接上
`<AuthGate>` 之后这批图应该改成从 `dist/` 完整 App 里点出来，届时这份 README 的「被测产物」
一行要同步改成 `dist/`。

## 已知缺口（不在本单修）

1. **密码长度 / 确认密码不一致没有文案**：已合并的 `sub2auth*` 骨架里没有对应词条，
   本单只标红框 + `aria-invalid`、不硬编中文。补词条后改
   `src/components/auth/authForm.ts` 的 `issueMessageKey` 即可。
2. **`expired` 状态没有提示句**：缺「登录已过期」这类 key，本轮回登录页但不显示原因。
