# #608 拆掉登录墙：账户改为「我们的渠道」内的可选能力 —— 验收截图

**这是浏览器视口截图（Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
pnpm build:internal                                  # 产物落 dist/（本场景用 --dist=dist-internal 也行）
node scripts/shot-mobile.mjs --page=487-account-optional --viewport=390,360 --dist=dist-internal
```

场景名是 `487-account-optional`（沿用 #487 的目录编号：账户体系那一系列工作都在这个号下面，
本单 #608 是它的最后一步 —— 把墙拆掉）。

## 拍的是什么（四个状态、五张图）

| 文件 | 内容 |
| --- | --- |
| `390/487-account-optional-01-signed-out-boot-main-ui-390.png` | **未登录冷启动 = 主界面**：没有登录页、没有密码框，输入框与模式切换就在首屏 |
| `390/487-account-optional-02-signed-out-account-tab-390.png` | 设置 → 数据管理 → 账户与消费 → **账号 tab（未登录）**：顶部「不登录也可以：在设置里填 API Key 即可使用各渠道」+ 主 CTA「去填 API Key」+ 底部「登录 / 注册（可选）」 |
| `390/487-account-optional-03-signed-out-inline-login-card-390.png` | 同一页往下滚：**局部登录卡**（`variant="inline"`）真的嵌在面板里，没有占满一屏 |
| `390/487-account-optional-04-signed-out-quota-guide-390.png` | **我的额度 tab（未登录）**：引导态（`登录后可查看额度…` + 一个「去登录」出口），不是报错、不是空白 |
| `390/487-account-optional-05-signed-in-account-tab-390.png` | **已登录态**：`当前已登录：demo@example.com` + 账号资料（余额 / 注册时间）+ Key 列表（两条）+ 退出登录 |
| `360/…-360.png` | 同上五张，360 × 740 档 |

## 这些图是怎么拍出来的（可复核，不是摆拍）

- **未登录那三张**：浏览器真实行为 —— 冷启动不发任何账号请求，sub2api 一律回 401，
  首屏照样进得去。这正是「登录墙没了」和「接口挡着」互不干扰的证明。
- **已登录那张**：先往 `localStorage` 写一份**真实格式**的落盘凭据
  （`chat-demo:auth-token` = `{v:1,token,user}`，见 `src/services/auth/store.ts`）再整页 reload，
  让 `main.tsx` 的后台 `restoreAuth()` 真的跑一遍（`/auth/me` → `/user/profile` → `/keys`），
  走的是产品代码里唯一的映射链（`toConsumeUser` / `toConsumeApiKey` / `toAuthUser`）。
  登录态唯一真值来源仍是 `useAuthStore`，没有第二条旁路。
- **为什么需要原生桥替身**：消费层按 #484 §4.6 **只走原生 `CapacitorHttp`**（sub2api 的 CORS
  默认拒绝所有跨域），浏览器里 `Capacitor.isNativePlatform()` 为假时它直接返回 `unsupported`
  —— 那样「账号」tab 只会出现「当前版本不支持这个功能」（#487 留下的旧链路截图就是那样），
  「已登录态长什么样」根本拍不到。所以第 ④ 步之前注入一份**原生桥桩**：
  `window.androidBridge` 让平台判定成 android、`window.Capacitor.PluginHeaders` 声明
  `CapacitorHttp.request`，`nativePromise` 里**在页面里真发一次 `fetch`** —— 请求仍然落在本场景
  自己的 `page.route` 路由表上（与 `tests/golden/g15`、`g16` 同一套配方，出处见
  `tests/golden/README.md`）。**只在第 ④ 步之前注入**：前三张图仍是浏览器真实行为
  （未登录、不发请求），不为拍照去改被测物；这个替身不进 bundle（只存在于截图脚本里），
  也没有绕过登录。

## 量到的数字（`metrics.json`，两档各一份）

| 项 | 390 档 | 360 档 |
| --- | --- | --- |
| 未登录首屏：输入框 / 密码框 | 有 / **0 个** | 有 / **0 个** |
| 未登录账号 tab：引导语 / 局部登录卡 / 密码框 | 有 / 有 / 有 | 有 / 有 / 有 |
| 未登录账号 tab 出现「已登录」状态行 | **没有** | **没有** |
| 未登录额度 tab：引导 / 错误态 / 去登录出口 | 有 / **0 个** / 1 | 有 / **0 个** / 1 |
| 局部登录卡尺寸（宽 × 高） | 280 × 254 | 250 × 254 |
| 宿主弹层宽 | 358 | 328 |
| 已登录态：状态行文案 | `当前已登录：demo@example.com` | 同 |
| 已登录态：Key 行数 | 2 | 2 |
| 已登录态仍显示未登录引导 | **没有** | **没有** |
| JWT 字面量出现在界面文本 | **没有** | **没有** |
| 文档级横向滚动 | 无（390 / 390） | 无（360 / 360） |
| 控制台报错 | 0 条 | 0 条 |

## 观察

- 「账号」tab 的未登录态是**引导**，不是拦截：不登录照样聊天（首屏那张就是证据），
  账号只多「余额 / Key 管理 / 邀请返利」这三类账单信息。
- 局部登录卡的宽度跟随宿主（280 / 250），高度 254px 远小于视口（844 / 740）——
  `embedded` 形态确实没把 `min-height: 100vh` 带进弹层。
- 已登录与未登录**共用同一个 tab、同一份表单**：区别只在有没有 `useAuthStore` 的登录态，
  以及加载完成后的状态行文案（`accountOptionalStatusLoggedIn`）。
- 两档都没有横向滚动，四个 tab 在 360 档仍是一行（沿用 #562 的布局口径）。
