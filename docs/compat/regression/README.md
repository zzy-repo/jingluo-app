# 已关闭项回归（#143 分支：可重复的「修复仍然成立」）

本目录把历史上**已关闭的 bug / 兼容性 issue** 变成可重复执行的回归用例，判断标准只有一条：
**修复前会失败的症状，现在还能不能复现**。断言只钉行为（文案 key、分类结果、错误码、可见文案），
不钉实现细节（函数名、内部字段顺序、日志措辞）。

- 执行环境：纯 Node（`node tests/regression/*.test.mjs`），**不起模拟器、不连真实服务、不读真实 API Key**。
- 与 `tests/unit`、`tests/integration` 同一套 `node:test` + `registerHooks` 写法，但**独立目录**：
  `tests/regression/**` **不在** `tests/run-layer.mjs` 的 `LAYERS`（unit/integration/e2e/device）里，
  因此 `pnpm test` **不会**自动收集它（全量总数保持 58），运行器**故意未改动**。跑本目录要单独点文件：

```bash
# 一条一条跑（推荐：定位快）
node tests/regression/issue-49-import-skip-tiers.test.mjs
# 全跑一遍并汇总
for f in tests/regression/*.test.mjs; do node "$f" || echo "FAILED: $f"; done
```

> 网络相关用例（#130 绑端口、#38 假链路）请**去掉代理**再跑，否则 fetch 会被代理劫持成假红：
> `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY node tests/regression/xxx.test.mjs`

## 结论表

| issue 号 | 标题 | 覆盖方式（新写用例 / 复用现有） | 结论 |
| --- | --- | --- | --- |
| #13 | 低内核（WebView 83）白屏：语法目标 + polyfill 门禁 | **新写** `issue-13-legacy-syntax-gate.test.mjs`（5 例，语法门 + 归一化 + 零误报 + AST 层容错）；另复用 `legacy-webview-compat` / `legacy-boot-guard` | 仍然成立 |
| #32 | URL 导入 staging 报「文件内容不完整」 | **新写** `issue-32-archive-entry-order.test.mjs`（3 例：清单先写、条目顺序、暂存三件套齐备） | 仍然成立 |
| #34 | 链接导入误报「文件超过 200MB」 | **新写** `issue-34-import-size-limit.test.mjs`（3 例：默认 200MB、环境变量口径、非法值回落）；另复用 `import-size-limit` | 仍然成立 |
| #38 | 慢链路被误判「卡死」中止 | **新写** `issue-38-stall-vs-progress.test.mjs`（2 例：慢但在推进不判死 / 总预算不被进展重置）；另复用 `url-import-stall` | 仍然成立 |
| #39 | 产物必须内含 ES2022 polyfill | **新写** `issue-39-legacy-runtime-api-gate.test.mjs`（5 例：缺标记 / 入口外 polyfill / 缺失 API 清单 / 无入口脚本） | 仍然成立 |
| #49 | 链接导入整包失败应降级跳过损坏会话 | **新写** `issue-49-import-skip-tiers.test.mjs`（7 例：会话级 / 分支级 / 重复 id / 全坏 / 跨会话图片 / 合法图片）；另复用 `import-partial-skip` | 仍然成立 |
| #79 | 旧内核补 `String.prototype.replaceAll` | **新写** `issue-79-replace-all-polyfill.test.mjs`（5 例：语义 / 非全局正则抛错 / 不可枚举 + 幂等 / 不覆盖已有实现 / 自检报告）；另复用 `legacy-replace-all`、`legacy-polyfills` | 仍然成立 |
| #94 | `formatPoints` 硬编码「积分」 | **新写** `issue-94-i18n-parity.test.mjs`（4 例：zh/en 键集合与占位符完全对齐、无空串、单位随语言）；另复用 `format-points-i18n` | 仍然成立 |
| #95 | legacy-bundle 无 dist 时静默 return（假绿） | **新写** `issue-95-legacy-bundle-no-dist.test.mjs`（2 例：无产物必须 exit 2 + 明确报错）；另复用 `legacy-bundle-target` | 仍然成立 |
| #111 | 导入失败文案未按原因分档 | **新写** `issue-111-import-error-tiers.test.mjs`（9 例：offline / refused / server 三档纯函数分类 + 未知原因不硬塞 + 403 三分档 + 5xx + 原生桥两类错误文案）；另复用 `import-error-copy` | 仍然成立 |
| #130 | 测试端口撞 fetch 禁用端口 → 假红 | **新写** `issue-130-fetchable-port.test.mjs`（4 例：禁用端口清单、可用端口口径、坏端口拒绝、重绑到可连端口） | 仍然成立 |
| #135 | `/buy` 必须带 cid | **新写** `issue-135-buy-customer-id.test.mjs`（6 例：缺 cid / 非法 cid / 缓存被污染 / 正常拼 cid / 显式 cid / 空方案）；另复用 `ours-api`、`ours-cid-order` | 仍然成立 |
| #122 | 长会话请求不做上下文预算 | 复用现有 `context-budget`、`chat-context-budget-long-session`、`chat-context-limit-error` | 仍然成立 |
| #105 | 断流自动重试 | 复用现有 `chat-retry-retryable`、`chat-stream-interrupt`、`import-partial-skip` | 仍然成立 |
| #45 | 长会话消息加载不出来一直转圈 | 复用现有 `message-list-virtual` | 仍然成立 |
| #90 | 前端接入 `/rotate` | 复用现有 `rotate-key` | 仍然成立 |
| #93 / #112 | 自动标题非流式抢槽 / 无并发上限 | 复用现有 `auto-title-stream`、`auto-title-backpressure` | 仍然成立 |
| #108 | 回车发送模式 | 复用现有 `enter-key-mode` | 仍然成立 |
| #106 | 双击会话标题回到第一条消息 | 复用现有 `mobile-header-scroll-top`（逻辑部分） | 仍然成立（滚动动画的视觉部分见下） |
| #100 | 弹层打开即自动 `/apply` | 复用现有 `dialog-open-no-apply` | 仍然成立 |
| #24 | 链接导入误报文件过大（Content-Range 口径） | 复用现有 `url-import-content-range` | 仍然成立 |
| #40 | 导入 check 阶段识别不了文件 | 复用现有 `import-archive-manifest`、`import-archive-unclassified` | 仍然成立 |
| #41 | 断流与首字过慢分段提示与本地化 | 复用现有 `chat-stream-interrupt`、`chat-wait-notice` | 仍然成立 |
| #11 | 429 映射 | 复用现有 `chat-retry-retryable`、`api-request-timeout` | 仍然成立 |
| #46 | 思考过程默认折叠 | 复用现有 `thinking-display` | 仍然成立 |
| #73 | legacy-bundle-target 假红（正则正斜杠） | 复用现有 `legacy-bundle-target` | 仍然成立 |
| #2 | 长文本复制超限 | 复用现有 `copy-limit` | 仍然成立 |
| #22 | 邀请额度服务与卡密支付 | 复用现有 `redeem-pool`、`ours-invite` | 仍然成立 |
| #7 / #115 | 卡密购买与兑换 UI / 付款记录带 cid | 复用现有 `ours-payment-records`、`ours-webpay` | 仍然成立 |
| #5 | 系统信息采集 | 复用现有 `diagnostics-system-info` | 仍然成立 |
| #86 | 前端接入 `/bind` | 复用现有 `bind-key` | 仍然成立 |
| #9 / #12 | 链接导入一直加载 / 连接被拒与服务不可达区分 | 复用现有 `url-import-stall`、`url-import-content-range`、`import-error-copy` + 本目录 #111 新用例 | 仍然成立 |
| #102 | 阅读设置 | 复用现有 `reading-settings`（存储与取值），样式见「无法自动覆盖」 | 仍然成立 |
| #94 关联项 | `formatPoints` 单位不再硬编码 | 见 #94 | 仍然成立 |
| #27 / #28 / #35 / #44 | HONOR 50 SE 退出再进白屏 / 填 Key 后白屏 / 兑换 503 / onRenderProcessGone | 只能真机验证 | **无法自动覆盖**，理由见下 |
| #30 / #57 | 反馈弹窗无法滚动 / 设置页文本列被压扁 | 纯 CSS 像素布局 | **无法自动覆盖**，理由见下 |
| #60 | 历史发布包 debuggable | 需要真实 APK 产物 | **无法自动覆盖** |
| #63 | `feedback-scroll` 用例回归 1!==0 | 属 integration 层（Windows 不可运行） | **无法自动覆盖**（同一 issue 已在 CI 的 Linux 上被 integration 覆盖） |
| #36 | 网页版购买 opaqueredirect 改顶层导航 | 需要真实浏览器导航语义 | **无法自动覆盖** |
| #25 | 快速/专家模式无差异 | 主观交互判断 | **无法自动覆盖** |

## 无法自动覆盖，及理由

1. **#27 / #28 / #35 / #44（真机 WebView / Android 进程）**：症状是国产 ROM WebView 进程被杀后重建白屏、`onRenderProcessGone` 回调、
   兑换 503 的服务端态。Node 里没有 WebView 也没有 Android 进程模型，任何断言都只是"模拟"，按 AGENTS.md 不能写成真机通过。
2. **#30 / #57 / #102 的样式部分（CSS 像素布局）**：断言需要真实布局引擎（要么浏览器、要么截图）。本仓库的 DOM 断言通道不存在，
   用快照字符串替代等于钉实现，不做。
3. **#60**：需要真实打包产物（APK）里的 `android:debuggable` 标记，构建机才有。
4. **#63**：该 issue 本身是 integration 层用例在 Windows 跑不了导致的回归，本机无法复现；Linux CI 已有覆盖。
5. **#36**：`opaqueredirect` 只有真实浏览器跨域导航才会出现，Node fetch 语义不同。

## 未测边界（诚实标注）

- **语法门禁的 AST 层**：`scripts/check-bundle-syntax.mjs` 的 AST 检查依赖 `acorn`，本仓库未安装（`loadAcorn()` 返回 null）。
  用例只断言"存在 AST 层且不误报"（`findForbiddenAst` 返回 null 或空数组），**真实的 AST 命中未被覆盖**。
  词法层（`||=` / `&&=` / `??=` / 静态块）与产物级 API 白名单（#39）已实际覆盖。
- **`src/**/*.tsx` 无法在 Node 里 import**（Node 类型剥离不支持 JSX），因此 #111 / #57 涉及的"设置页展示映射"只能覆盖到服务层与文案层。
- **真机型 / 真机 WebView 版本矩阵**（#10 的矩阵本身）不在本目录范围。
- `#111` 的 403 文案细节依赖 OBS 返回体，用例用固定 XML 片段模拟，未覆盖真实服务端返回体的各种畸形写法。

## 新增文件

```
tests/regression/
  issue-13-legacy-syntax-gate.test.mjs        #13  5 例
  issue-32-archive-entry-order.test.mjs       #32  3 例
  issue-34-import-size-limit.test.mjs         #34  3 例
  issue-38-stall-vs-progress.test.mjs         #38  2 例
  issue-39-legacy-runtime-api-gate.test.mjs   #39  5 例
  issue-49-import-skip-tiers.test.mjs         #49  7 例
  issue-79-replace-all-polyfill.test.mjs      #79  5 例
  issue-94-i18n-parity.test.mjs               #94  4 例
  issue-95-legacy-bundle-no-dist.test.mjs     #95  2 例
  issue-111-import-error-tiers.test.mjs       #111 9 例
  issue-130-fetchable-port.test.mjs           #130 4 例
  issue-135-buy-customer-id.test.mjs          #135 6 例
  stubs/history-db.mjs                        #    暂存层替身（#32 用）
```

合计 **12 个文件 / 55 个用例**，全部为 `node:test`，逐个单独跑均 `# fail 0`。

## 本轮未发现产品回归

55 个用例全部一次或经"断言写错"修正后通过；**没有出现"产品真的坏了"的红灯**。
过程中确认到的两处「看着像回归、其实是断言问题」：

- `#49` 的 `rootMessageId` 是**字符串** `'1'` 而不是数字（本地会话 id 一律字符串），断言已按事实修正。
- `#135` 的文案 key 是 `oursErrCustomerNeedsKey`（不是早期分支里的 `oursErrCustomerMissing`），以 `origin/main` 为准修正。
