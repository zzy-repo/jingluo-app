# Issue #234 邀请奖励改版：界面文案截图

Chromium 156.0.8078.4（Playwright 无头，非 WebView 实机）。

采集方式：~~`tests/integration/issue-234-invite-copy.test.mjs`~~（邀请服务全部本地打桩，
不连真服务端），390×844 / 360×780 两个手机视口各一组：

> #562 起：这条 L1 脚本随旧 `OursServicesDialog` 退役删除（它点的就是那个弹层里的邀请码区）。
> 邀请码 / 返利语义现在由 `tests/unit/issue-234-invite-copy.test.mjs`（服务层）与
> `tests/unit/consume-panels-invite-email.test.mjs`（「账户与消费 → 账号」的 `InvitePanel`）锁住；
> 下面是历史截图，保留作取证。

| 文件 | 状态 | 该看到的文案 |
| --- | --- | --- |
| `234-01-rules-from-server-*.png` | `/me` 下发 `invite_rules` | 规则行由服务端数值生成（邀请人 100 积分 / 好友首付后再得 100 积分），不出现 ¥ 折算 |
| `234-02-invitee-bound-*.png` | `reward_points: 0`（被邀请人） | 「邀请关系已绑定」，**不再**出现「+0 积分」 |
| `234-03-inviter-ok-*.png` | `reward_points: 100`（邀请人） | 「绑定成功，+100 积分」逐字不变 |
| `234-04-circular-invite-*.png` | 409 `circular_invite` | 互填邀请码的专属提示，不落到「已经绑定过邀请码」 |
| `234-05-rules-missing-*.png` | 老服务端：没有 `invite_rules` | 规则行整行隐藏，且没有「双方各得 1 元」这类写死文案 |

复现：

```bash
DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
node tests/run-layer.mjs integration --only issue-234
```

注：截图是 Chromium 无头渲染，**不是** WebView 真机；移动端 WebView 的真实排版仍需真机确认。
