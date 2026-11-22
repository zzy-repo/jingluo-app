# #830 账号页邀请区域「闪现后消失」（#819 二次修复）验收截图

**这是浏览器视口截图（headless Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。

被测实例是本机 dev（`rspack serve` 端口 8108），接口是真 staging
（`https://apia.ecsafe.cn/staging/api/v1`，实测 `invitation_code_enabled: false`、`affiliate_enabled: false`），
登录用测试账号 `2067922098@qq.com`。

## 判据（怎么量出来的）

进入「设置 → 账户与消费 → 账号」时，在**点「账号」那一刻**装一个 `requestAnimationFrame` 采样器，
每帧记录两件事，一直录到 1800ms：

```js
document.querySelectorAll('[data-testid^="invite"]').length           // 数量
document.querySelector('[data-testid="invite-panel"]')
  ?.getBoundingClientRect().height                                   // 高度（px）
```

再用这些帧去对齐 **t = 0 / 30 / 80 / 200 / 600 / 1500ms** 六个时刻（取每个时刻之前最后一帧）。
所以下面表里的数字是**每一帧的 DOM 实测**，不是"看着像"。

## 文件

| 文件 | 内容 |
| --- | --- |
| `830-01-flash-frame-390.png` / `-360.png` | **闪现帧**（改前的 bug）：账号页上出现了 86px 高的「我的邀请 / Loading…」骨架 |
| `830-02-flash-gone-390.png` / `-360.png` | 同一页面 1.2s 后：骨架已被抹掉，`invite-*` 节点数 0 —— 这就是"闪一下就没" |
| `830-03-account-fixed-390.png` / `-360.png` | **改好后**的账号页：从第一帧起就没有邀请区域（开关 false 就该没有） |
| `830-04-switch-on-panel-390.png` / `-360.png` | 开关为 true（`page.route` 改 `settings/public`）时：面板正常出现，高度 268px 稳定不动 |
| `830-trace-before-*.txt` | 改前（main 原顺序）的六时刻原始输出 |
| `830-trace-after-*.txt` | 改后的六时刻原始输出（全 0） |
| `830-trace-negctl-*.txt` | 负向对照（把"先等开关"去掉）的六时刻原始输出（又出现 >0 后归 0） |
| `830-trace-switchon-*.txt` | 开关 true 场景的原始输出（骨架 86px → 内容 268px，不回 0） |
| `830-trace-slownet-*.txt` | 慢网络（`settings/public` 延迟 800ms）下的可见性统计 |

> `830-01-flash-frame-*.png` 的抓法：`page.route` 给 `settings/public` 注入 **400ms 延迟**，
> 让本来只活 ~48ms 的骨架帧能被截图（`page.screenshot` 本身就要几十毫秒）。
> 注入的只是网络延迟，**面板的渲染顺序一字未改** —— 截到的就是那条要修的帧，
> 帧内容实测为 `{"nodes":["invite-panel"],"height":86,"text":"My invitesLoading…"}`。

## 时间序列（改前 → 改后）

390 × 844、开关 false。同一台 dev、同一个账号、同一份采样器：

| t | 改前 `invite-*` 数 | 改前高度 | 改后 `invite-*` 数 | 改后高度 |
| --- | --- | --- | --- | --- |
| 0 | 0 | 0 | **0** | **0** |
| 30ms | 0 | 0 | **0** | **0** |
| 80ms | 1 | 86 | **0** | **0** |
| 200ms | 0 | 0 | **0** | **0** |
| 600ms | 0 | 0 | **0** | **0** |
| 1500ms | 0 | 0 | **0** | **0** |

改前的帧统计：**可见 4 帧 / 首次可见 t=44.6ms / 末次可见 t=92.2ms / 可见时长 ≈47.6ms / 峰值 86px / 消失后 0**。
改后：**可见 0 帧**（110 帧采样里一次都没出现 `invite-*`）。

360 × 740 档同理（原始输出见 `830-trace-before-360.txt` / `830-trace-after-360.txt`）。

## 开关 true 时不会"先空后满"

`page.route` 把 `settings/public` 的 `invitation_code_enabled` / `affiliate_enabled` 改成 true
（`/user/aff` 走真接口）：

| t | `invite-*` 数 | 高度 | 说明 |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 页面还在切（面板尚未提交） |
| 30ms | 0 | 0 | 同上 |
| 80ms | 1 | 86 | 面板自己的骨架（`invite-panel` + `panel-loading`） |
| 200ms | 8 | 268 | 最终形态（邀请码 / 复制 / 已邀请 0 人 / 返利 ¥0.00 / 语义说明） |
| 600ms | 8 | 268 | 不动 |
| 1500ms | 8 | 268 | 不动 |

**高度从不回落**：0 → 86 → 268，没有"先有后归 0"。

## 慢网络下更狠的一条

把 `settings/public` 延迟 800ms（本该让骨架活 0.8 秒）：

| 版本 | 800ms 窗口内 `invite-*` 出现的帧数 |
| --- | --- |
| 改前（负向对照） | **53 帧**（首次 t=43ms、末次 t=909ms，然后消失） |
| 改后 | **0 帧**（152 帧全 0） |

这一条同时证明采样器是**灵敏的**：同样的环境下，旧代码能测出 53 帧，
所以改后的"0 帧"不是"没测到"。
