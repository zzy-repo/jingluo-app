# 端到端回归测试（Playwright）

覆盖设置页「服务地址」那一行「测试」按钮的鉴权行为：

- `test.probe-auth.spec.mjs`：只在 API Key 输入框里填 key（**不点「确定」**）后点「测试」，断言 `/models` 请求的
  `Authorization` 头 === `Bearer <输入框里的 key>`。修复前该用例失败（发的是 `Bearer` 空鉴权），修复后通过。
- `test.probe-nokey.spec.mjs`：完全不填 key 时点「测试」，断言不发任何请求，并且界面给出「请先填写 API Key」。

依赖：任意可用的 playwright（1.64.x）。仓库里没有装，`tests/node_modules` 软链到已有的安装即可（已被 .gitignore 忽略）：

```bash
ln -sfn /root/bak/deepseek-web/node_modules /root/deepseek-app/tests/node_modules
```

跑法（被测页面由 http://100.113.135.55:5181 提供 `dist/`）：

```bash
cd /root/deepseek-app && node tests/test.probe-auth.spec.mjs && node tests/test.probe-nokey.spec.mjs
# 或：cd tests && node test.probe-auth.spec.mjs
# 自定义地址：APP_URL=http://127.0.0.1:5181 node tests/test.probe-auth.spec.mjs
```

## 内测构建（1.4.0-beta.1）的验收：两套构建分开跑

1.4.0 起有两种构建产物，spec 与它们一一对应：

| 构建 | 命令 | 覆盖的 spec |
| --- | --- | --- |
| 标准构建（默认，行为同 1.3.0） | `pnpm build` | 既有 9 个 spec（含三种服务类型 / 协议适配 / 旧配置兼容） |
| 内测构建（固定地址+模型，只留 API Key） | `INTERNAL_BUILD=1 pnpm build:internal` | `test.internal-build.spec.mjs` |

内测构建里「服务类型 / 服务地址 / 模型」三项不可编辑，所以那 9 个依赖切换服务类型、自填地址的用例只对标准构建有意义；
它们的断言一条都没有削弱，仍然逐字校验 deepseek / anthropic / openai 三条链路。

### 内测构建验收（自建，不依赖真实上游）

```bash
# 1) 把内测版固定的上游 IP 绑到本机回环，让请求真的打到本地 mock（root 权限）
ip addr add 123.207.199.196/32 dev lo

# 2) 构建内测包（dist 即内测产物）并跑验收：mock 上游 + 静态服务 + Playwright 都由脚本自己拉起
pnpm build:internal
cd tests && node test.internal-build.spec.mjs
```

`test.internal-build.spec.mjs` 断言：设置页没有 Service URL / Model 输入框、没有服务类型下拉、没有位置信息项，
只剩 API Key 输入框；发消息请求 URL 必须是 `http://123.207.199.196:60010/v1/messages`、`body.model` 必须是
`deepseek-v4.1-flash`、请求体不含 `safety_check`/`title`/`tools`/`role:'latest_reminder'`；固定项不落 localStorage；
console error = 0；并输出截图到 `docs/ui/1.4.0-beta.1-*.png`。

`mock-anthropic.mjs` 是 node 标准库实现的 mock 上游（默认监听 `123.207.199.196:60010`），回标准 Anthropic SSE，
并把收到的每个请求（含请求体）记到 `/tmp/mock-anthropic-requests.jsonl` 供断言。

## 交互动效验收（1.4.0-beta.2）

```bash
cd /root/deepseek-app && node tests/test.motion.spec.mjs
```

覆盖外壳动效（侧边栏抽屉、设置弹窗、按钮按压、会话列表切项、主题切换），完全不涉及消息流：

- 中间帧：侧边栏 / 设置弹窗在 t=80/150/250ms 各截一张（`docs/ui/motion-*.png`），
  同时读 `getComputedStyle().transform` 的中间值，证明是渐变而不是瞬变
- 计算样式：侧边栏打开后 `transform = matrix(1, 0, 0, 1, 0, 0)`；关闭过程中 `tx < 0` 且 DOM 仍在（退出动画不被吞）
- reduced-motion：`page.emulateMedia({ reducedMotion: 'reduce' })` 下 `transition-duration = 1e-05s`、主题淡入 `animation: none`
- 静态检查：`src/` 下没有任何 `transition`/`animation` 动布局属性；相对基线提交 `68f9342` 没新增 `transform`/`opacity` 之外的动画属性
- 消息流冻结：`git diff 68f9342 -- src/components/messages src/components/chatInput` 必须为空
- 功能回归：侧边栏能点会话、设置能开能关、发消息正常（上游用 `page.route` 打桩，不需要真实 IP）

被测页面默认是 `dist/`（内测构建产物）上的独立静态服务（端口 5292），可用 `APP_URL` / `DIST_DIR` / `PORT` 覆盖。
