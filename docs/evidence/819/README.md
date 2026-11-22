# #819 —— 邀请功能恢复挂载的取证

依 2026-11-22 的实现（分支 `fix/819-restore-invite-mount`）。**C 类修复**：恢复挂载 + 注册补邀请码字段，
**开关语义一字未改**（`invitation_code_enabled` / `affiliate_enabled` 为 false 时仍是「整块隐藏」）。

## 根因（一句话）

`6d7ab635`（#788）把账号 L2 页改成手写三行时，原本挂在 `AccountPanel` 里的 `<InvitePanel …/>`
连同 `import { AccountPanel, QuotaPanel }` 一起没了 —— 于是邀请面板**从未被渲染**
（`<AccountPanel` 全仓只剩 `index.ts` 文档注释里那一处），`GET /api/v1/user/aff` 一次都没打过；
注册侧 `SettingsAuthCard` 又只发 `email/password/verify_code`，`consume/auth.ts` 的
`invitation_code` 分支永远进不去。

## 文件

| 文件 | 内容 |
| --- | --- |
| `acceptance-819-green.txt` | 用例 ①—④ 全绿（7 条）的完整 `node --test` 输出 |
| `negative-control-1-mount-removed.txt` | 负向对照 1：把挂载删掉 → ① 红（6 pass / 1 fail） |
| `negative-control-2-flag-gate-removed.txt` | 负向对照 2：把开关判断去掉（恒显示 + 恒传） → ④ 红（6 pass / 1 fail） |
| `pre-existing-reds-on-origin-main.txt` | 说明 `unit` 层那 5 个红文件在本单**之前**就红（干净 `origin/main` 同跑：51 条 37 pass / 14 fail） |

## 复现

```bash
cd /root/wt-819fix
node --test tests/unit/invite-restore-819.test.mjs      # 7/7 绿
node scripts/check-i18n.mjs                            # 912/912
node scripts/check-test-layout.mjs --strict            # 孤儿 0
npx tsc -p tsconfig.json && npx oxlint src              # 0 / 0
```

负向对照怎么复现：把 `AccountConsumePage.tsx` 里账号分支的 `<InvitePanel …/>` 删掉 → ① 红；
把 `settingsAuthCardModel.ts` 里 `registering && props.invitationCodeEnabled` 的开关判断和
`ctx.invitationCodeEnabled` 的守卫去掉 → ④ 红。
