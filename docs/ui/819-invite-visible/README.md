# #819-v2 「邀请码板块现在直接没有了」产物级验收（390 / 360）

**这是浏览器视口截图（headless Chromium 设备模拟，`deviceScaleFactor: 2`、`isMobile`、`hasTouch`），不是真机截图。**
两档：390 × 844、360 × 740。

被测对象**不是 dev server**，而是 `pnpm build` 打出来的 `dist/`（`node scripts/build.mjs`，产物见 `dist/build-info.json`：
`consume=https://apia.ecsafe.cn/staging`、`version=1.4.14`），用本机静态服务器起 `dist/` 后用 Playwright 打开。
接口用 `page.route` 打桩，桩数据 = 维护者给的 **staging 现场事实**：

```
GET /settings/public → invitation_code_enabled=false, affiliate_enabled=false, registration_enabled=true, promo_code_enabled=true
GET /user/aff        → 200 {"aff_code":"6EFT6PUQ4JSY","aff_count":0,"aff_quota":0,"effective_rebate_rate_percent":20,
                             "max_invitees":30,"invite_remaining":30,...}
```

登录走**真表单**（设置 → 账户与消费 → 账号 → 邮箱+密码 → `POST /api/v1/auth/login`），随后 reload
（= 真实「登录之后再来」的凭据恢复路径）再进「设置 → 账户与消费 → 账号」，在**点「账号」那一刻**
装 `requestAnimationFrame` 采样器，每帧记录 `[data-testid^="invite"]` 节点数与面板高度，录到 1800ms；
下面表里的数字是**逐帧 DOM 实测**（取该时刻之前最后一帧），原始帧在 `819v2-raw-after.json`。

## 结论

| 场景 | 结果 |
| --- | --- |
| `invitation_code_enabled=false` + `aff_code` 有值 | **面板出现**（邀请码 `6EFT6PUQ4JSY`、已邀请 0 人、返利余额 ¥0.00、20% 结算说明） |
| `aff` 没给 `aff_code` | **hidden**（DOM 里 0 个 `invite-*` 节点） |
| `aff` 请求失败 | `failed` + 重试（不猜「有」也不猜「没有」） |
| 未登录 | 引导态「登录后可查看邀请」（不发请求） |
| 注册页 `invitation_code_enabled=false` | 没有那一行（不回归） |
| 注册页 `invitation_code_enabled=true` | 有那一行（证明这条检查灵敏） |

## 逐帧序列（改后，无「有 → 无」）

390 × 844：

| t | `invite-*` 节点数 | 面板高度 |
| --- | --- | --- |
| 0 | 0 | 0 |
| 30ms | 0 | 0 |
| 80ms | 0 | 0 |
| 200ms | **8** | **220** |
| 600ms | 8 | 220 |
| 1500ms | 8 | 220 |

360 × 740：0 / 0 / **8** / 8 / 8 / 8（节点数），高度 0 / 0 / 220 / 220 / 220 / 220。
两档的「首次可见」分别是 t=85ms（390）/ t=57ms（360），**峰值之后归 0 的帧：无**（`fallback=null`）。
即：**0 → 稳定值，一路可见，不回落**（#830 的成果保持：初始态仍是 `hidden`，不是骨架）。

## 负向对照（把可见性判定改回依赖 `invitation_code_enabled`）

`819v2-trace-negctl.txt`：同一份 dist 构建流程、同一套桩数据，只把 `invitePanelModel.ts` / `InvitePanel.tsx`
还原成修复前（`loadInvite` 先读 `settings/public`、`initialInviteState(flags)` 按开关起跳）：

| t | 390 | 360 |
| --- | --- | --- |
| 0 / 30 / 80 / 200 / 600 / 1500ms | 0 / 0 / 0 / 0 / 0 / 0 | 同 |

`DOM invite-* = []`、面板高度 0px、`邀请码="null"` —— **整块没有**，就是维护者报的那一幕。

## 文件

| 文件 | 内容 |
| --- | --- |
| `after-invite-panel-390.png` / `-360.png` | 改后：账号页邀请板块（可见、220px） |
| `after-invite-panel-390-full.png` / `-360-full.png` | 同上整页 |
| `819v2-trace-after.txt` | 改后的六时刻原始输出（含 DOM 清单 / 请求序列） |
| `819v2-trace-negctl.txt` | 负向对照的六时刻原始输出（全 0，面板不存在） |
| `819v2-raw-after.json` / `819v2-raw-negctl.json` | 逐帧原始数据（含每帧节点 id） |
| `819v2-register-off-390.png` / `-360.png` | 注册页：`invitation_code_enabled=false` → 没有邀请码行 |
| `819v2-register-on-390.png` / `-360.png` | 注册页：`invitation_code_enabled=true` → 有邀请码行（灵敏性对照） |

## 截图的抓法（可复现）

`page.route('**/api/v1/**')` 打桩（含 `OPTIONS` 预检）、`addInitScript` 注入原生桥替身（消费层在浏览器里只走
`CapacitorHttp`，见 #484 §4.6，与 `scripts/shot-mobile.mjs` 同一配方）、`localStorage['chat-demo:provider-kind']='ours'`；
采样器：

```js
window.__samples = []
const t0 = performance.now()
const tick = () => {
  const nodes = Array.from(document.querySelectorAll('[data-testid^="invite"]'))
  const panel = document.querySelector('[data-testid="invite-panel"]')
  window.__samples.push({ t: Math.round(performance.now() - t0), n: nodes.length, h: panel ? Math.round(panel.getBoundingClientRect().height) : 0 })
  if (performance.now() - t0 < 1800) requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
```

采样器在**点「账号」之前**装好，所以 t=0 就是「面板该出现的那一刻」。
