# chat-demo 服务配置（API Key / 服务地址 / 模型）改造：回归测试 + 验收报告

- 被测站点：`http://100.113.135.55:5181`（systemd `dsk-chat.service`，静态服务 `dist`）
- 改造前产物：`dist-baseline/`（改造前线上 dist 的原样快照，回归基线用它录制）
- 改造后产物：`dist/`（`main.98ff1373.js`）
- 最终形态：设置页「数据管理」内、原 API Key 区的位置上纵向三行 —— **API Key / 服务地址 / 模型**，无列表、无二级弹窗、无新分组
- 截图：`docs/settings-service-config.png`
- 结论：**回归 164 项 PASS / 0 FAIL / 4 项预期差异（仅新增两行 DOM）；验收 17 项全 PASS**

> 临时测试 Key 只写入浏览器 `localStorage` 与 curl 环境变量，**未进入任何被跟踪文件**（见 §6 扫描证据）。

---

## 1. 回归测试（特征测试 / Golden Master）

### 1.1 方法

改造前先把线上 `dist` 原样快照为 `dist-baseline/`，用 `python3 -m http.server 5199` 在**同机、同一非安全上下文**（`http://100.113.135.55:5199`，与 5181 同为 http 源，避免 `localhost` 属安全上下文导致「麦克风按钮禁用与否」这类假差异）提供服务后录制金标准。

8 个场景：S1 全新首页 / S2 设置页（通用+数据管理）/ S3 会话抽屉+20 轮会话视图 / S4 新建→输入「你好」→发送（官方默认上游 + 假 Key → 401）/ S5 无 Key 发送 / S6 断网发送 / S7 深度思考+附件上传 / S8 深度思考+标题生成。

每场景记录：`method + 完整路径`、请求头**名称**集合、body **顶层字段名**与关键值、响应状态码、console/page error、DOM 结构摘要（类名 hash 归一化）、localStorage 各 key 结构（值脱敏）、消息数 / 按钮可用性 / 提示文案。

判定：路径变了、body 字段少了、存储结构变了且没迁移 → **FAIL**；文案微调、DOM 多出新节点 → **DIFF（预期差异，需说明）**。

### 1.2 结果

```
汇总：PASS=164  FAIL=0  DIFF=4  INFO=2
```

**硬约束（三条请求路径 + header 名 + body 顶层字段）逐项一致：**

| 路径 | 改造前 | 改造后 | header 名 | body 顶层字段 |
| --- | --- | --- | --- | --- |
| models | （未触发） | （未触发） | — | — |
| messages | `POST api.deepseek.com/anthropic/v1/messages` | 同 | `accept, accept-language, content-type, referer, sec-ch-ua*, user-agent, x-api-key` | `messages, model, safety_check, stream, system, thinking, title, tools` |
| files | `POST api.deepseek.com/anthropic/v1/files` | 同 | 同上 + `anthropic-beta` | （multipart） |

- 响应状态码：`/anthropic/v1/messages → 401`、`/anthropic/v1/files → 401`，两侧一致。
- 关键值：`stream=true`、`model=deepseek-flash`、`thinking.type=disabled/enabled`（S4/S8 各自一致）、`title.enabled=true`、`safety_check.level=high`、`tools=[deepseek_read_url]`、`system` 非数组 —— 全部逐字一致。
- 界面行为：会话 20 条消息渲染、发送后消息数/按钮状态、401 提示「API Key 无效或已被删除，请更换后重试 + 更换 API Key」、断网提示「网络异常，请检查你的网络状况」全部 PASS、文案逐字未变。

### 1.3 4 项预期差异（非 FAIL）

| 场景 | 差异 | 原因 |
| --- | --- | --- |
| S1 首页 / S2 数据管理 / S5（×2） | DOM `+12 / -0` 行：数据管理页在 API Key 行下方新增 `.cell > .apiKey` 两行（服务地址、模型）及其 input / 分割线 / 「测试」按钮 | 本次新增的两个字段，属需求本身 |
| 全部 8 场景 | **localStorage 无任何差异**（`chat-demo:api-key` 结构一致，未新增 `chat-demo:base-url` / `chat-demo:model`） | 三字段按「未配置即用默认值」实现：用户不填就不落盘，旧数据天然兼容、无需迁移 |

旧数据兼容性由此得到直接证明：只有 `chat-demo:api-key` 时，改造后**不写任何新 key**，请求照旧打到 `https://api.deepseek.com/anthropic/v1/messages`。

### 1.4 构建产物体积

| 指标 | 改造前 | 改造后 | 变化 |
| --- | --- | --- | --- |
| `dist` 总大小 | 4,395,104 B | 4,401,363 B | +6,259 B（+0.14%） |
| 主包 `main.*.js` raw | 474,903 B | 481,162 B | +6,259 B（+1.32%） |
| 主包 `main.*.js` gzip -9 | 158,363 B | 160,072 B | +1,709 B（+1.08%） |
| 主包 `main.*.css` | 88,771 B | 88,771 B | 0（完全复用现有样式类，未新增 CSS） |
| 异步 chunk 合计 | 2,728,914 B | 2,728,914 B | 0 |

CSS 体积零变化，是「新字段完全复用 `.cell / .apiKey / .apiKeyInput / .divider / .confirm / .label / .description / .error`」的直接证据。

渲染观察项（20 轮会话）：打开会话 111 ms → 96 ms；滚动到底部两侧均 0 ms。

> 说明：测试口径为父任务第二轮指定的「回归测试（Golden Master）」，首屏 DCL/load 等基准项不再单列。

---

## 2. 界面形态

设置 → 数据管理，三个字段纵向排列，与原 API Key 行同宽、同高、同圆角、同字号、同 8px 行间距：

```
输入 API Key 开始使用
[ ***************************************  ✎ ]
─────────────────────────────────────────────
服务地址
[ http://127.0.0.1:5288                 测试 ]
  连接成功（HTTP 200），共 3 个模型：claude-haiku-5.5, claude-opus-5.5, claude-sonnet-5.5
─────────────────────────────────────────────
模型
[ claude-sonnet-5.5                        ]
─────────────────────────────────────────────
导入历史对话 ...
```

- 复用类：`.cell`（行与 1px 分隔线）、`.apiKey`（列布局）、`.label`（14px 标签）、`.apiKeyInput`（`--ds-control-height-xl` 胶囊输入，`1px border-l2`、`border-radius: 22px`、聚焦变品牌色）、`.divider`（20px 竖线）、`.confirm`（品牌色文字按钮）、`.description` / `.error`（12px 辅助与错误文案）。
- 「测试」按钮与 API Key 行的「确认」用完全相同的 `.divider + .confirm` 结构，视觉一致。
- 移动端沿用原有的整行「确定」按钮与 52px 高胶囊输入，无新增断点样式。

---

## 3. 存储与取值

| localStorage key | 含义 | 缺省行为 |
| --- | --- | --- |
| `chat-demo:api-key` | API Key（**沿用原名**，旧数据直接可用） | 空 → 视为未配置，界面提示先填 Key |
| `chat-demo:base-url` | 服务地址 origin | 空 → 构建期 `__API_ORIGIN__`（`https://api.deepseek.com`），输入框显示该默认值 |
| `chat-demo:model` | 请求的 model | 空 → `deepseek-flash` |

无需迁移：旧版本本来就只有 `chat-demo:api-key`，另两个 key 缺失即走默认值；三个 key 都是「有值才写、清空即 `removeItem`」。

请求拼接（每次请求现取，改完立即生效）：
- `messages` / `files`：`{baseUrl}/anthropic/v1/...`（前缀固定，与改造前一致）
- `models`（连通性测试）：`{baseUrl}/models`
- `asr` / `tts`：`{baseUrl}/v1/tools/...`（保持现状）

校验：baseUrl 必须 `^https?://` 且能被 `new URL()` 解析，保存时去尾斜杠（`http://127.0.0.1:5288///` → `http://127.0.0.1:5288`）；model 不能为空。交互：失焦或回车保存，非法输入就地提示且不落盘。

---

## 4. 验收测试（17 项全 PASS）

当时的一次性验收脚本（运行时把结果写在 `docs/` 下的 acceptance 目录，**产物不入库**；脚本本身已并入 `tests/integration/full-acceptance.test.mjs`），逐条 PASS/FAIL + 证据：

| ID | 结果 | 证据（实测输出） |
| --- | --- | --- |
| AC1.1 | PASS | 输入 `http://127.0.0.1:5288///` 回车 → `chat-demo:base-url=http://127.0.0.1:5288`（尾斜杠已去） |
| AC1.2 | PASS | 填 Key 点「确定」→ 校验请求走**已配置的** `{baseUrl}/models`，成功后落盘（`keyLen=67`）、输入框变掩码 |
| AC1.3 | PASS | 模型填 `claude-sonnet-5.5` 回车 → `chat-demo:model=claude-sonnet-5.5` |
| AC1.4 | PASS | 刷新后三字段仍在：`{"baseUrl":"http://127.0.0.1:5288","model":"claude-sonnet-5.5","masked":1}` |
| AC1.5 | PASS | 本轮 console error = 0 |
| AC3 | PASS | 预置旧数据（只有 `chat-demo:api-key`）：keys 仍只有 `chat-demo:api-key, chat-demo:locale`（**未写新 key**），界面显示 `https://api.deepseek.com` / `deepseek-flash`，请求 `POST https://api.deepseek.com/anthropic/v1/messages` |
| AC4.1 | PASS | `abc` → 提示「服务地址必须以 http:// 或 https:// 开头…」，`chat-demo:base-url` 保持原值不变 |
| AC4.2 | PASS | `ftp://x` → 同上，未落盘 |
| AC4.3 | PASS | 空值 → 视为清除，落盘为 `null`，输入框回落显示 `https://api.deepseek.com` |
| AC4.4 | PASS | 模型留空 → 提示「模型不能为空」，`chat-demo:model=null` |
| AC5.1 | PASS | 正确配置 → `连接成功（HTTP 200），共 3 个模型：claude-haiku-5.5, claude-opus-5.5, claude-sonnet-5.5` |
| AC5.2 | PASS | 错误 Key → `请求失败（HTTP 401）：{"code":"INVALID_API_KEY","message":"Invalid API key"}` |
| AC5.3 | PASS | 错误地址 `http://127.0.0.1:9` → `无法连接：Failed to fetch（地址错误、服务未启动或被跨域策略拦截）` |
| AC5.4 | PASS | 不可达地址 `http://10.255.255.1:8080` → `连接超时，请检查地址与网络后再试` |
| AC2 | PASS | `page.on('request')` 抓到 `POST http://127.0.0.1:5288/anthropic/v1/messages`（= 配置的 baseUrl + 固定前缀 + `/messages`） |
| FUNC.chat | PASS | 真实中转对话（内容「你好」）：首 token 7167 ms、总 7423 ms、41 字符、无错误提示、`200 text/event-stream` |
| AC2.console | PASS | 对话过程 console error = 0 |

四次失败情形的截图：`docs/acceptance/AC5_ok.png`、`AC4_invalid.png`、`AC5_timeout.png`、`AC2_chat.png`。

---

## 5. 真实中转测试结果（重要限制）

配置：服务地址 `http://111.231.174.164:8080`、Key 为临时 Key（仅 runtime）、模型 `claude-sonnet-5.5`。

1. **中转本身不含 `/anthropic/v1` 前缀，也不支持 CORS。**
   - `POST http://111.231.174.164:8080/anthropic/v1/messages` → `200 text/html`（返回 SPA 页面，不是 SSE）；该中转只提供 `/v1/messages`。
   - `OPTIONS` 预检 → `403`，所有响应都没有 `Access-Control-Allow-*` 头 → 任何浏览器页面直连必然被拦。
   - 因为前缀被固定成 `/anthropic/v1`（这是「路径与改造前完全一致」这条硬约束的直接结果），**在界面上填该中转的 origin 无法直接跑通对话**：连通性测试（`{baseUrl}/models`）正常，对话会因返回 HTML 而报协议错误。
2. 因此用**测试夹具**做端到端验证（一次性脚本，已随验收套件清理、不入库；本地 `127.0.0.1:5288`，把 `/anthropic/v1/*` 透传到中转 `/v1/*` 并补 CORS 头；仅测试用，不进产物）：
   - 连通性：`连接成功（HTTP 200），共 3 个模型：claude-haiku-5.5, claude-opus-5.5, claude-sonnet-5.5`
   - 对话「你好」：`200 text/event-stream`，首 token 7167 ms / 总 7423 ms / 41 字符，无错误提示（正文是当次一次性产物，未入库）
3. curl 直连中转（不经浏览器/夹具，同请求体）：`GET /models` → 200；`POST /v1/messages` → 200 SSE，正文 14 字符。三次计时：

   | 次数 | TTFB | 总时长 |
   | --- | --- | --- |
   | 1 | 6.36 s | 6.36 s |
   | 2 | 5.51 s | 5.51 s |
   | 3 | 6.54 s | 6.54 s |

   **事实标注**：该上游是「假流式」——响应带 `Content-Length`，TTFB ≈ 总时长，首 token 与整体同时到达。这是上游行为，不是改造引入的问题。
4. 上游对 DeepSeek 扩展字段（`safety_check`、`tools:[deepseek_read_url]`、`thinking`、`title`）**不报错**，原样接受（见 §5.3 的 200 与 SSE 正文），未因此修改协议。

**结论**：应用侧接线（baseUrl / Key / model 三字段 → 三条请求路径 → SSE 解析 → 渲染）在真实上游上端到端跑通；该特定中转因缺少 `/anthropic/v1` 与 CORS 无法在浏览器里直连，属部署侧选择（换支持的中转，或加同源反代），无需改代码/协议。

---

## 6. 安全检查

- `git status`：改动仅 `src/` 下 12 个文件 + `.gitignore`（详见 §8），无任何含密钥的文件。
- 全仓扫描 `sk-[A-Za-z0-9]{20,}`（`src/`、`dist/`、`docs/`）→ **0 命中**。
- 对临时 Key 字面量做全仓 `grep -rl`（排除 `node_modules/`、`.git/`）→ **空命中**（报告中不保留该字面量）。
- 截图中的 Key 均为掩码圆点，不含明文。

---

## 7. 已知未做 / 受限

1. **协议前缀固定为 `/anthropic/v1`**：这是「三条路径与改造前完全一致」的必然结果。只提供 `/v1/messages` 的中转（如本次测试的中转）需要前面挂一层改写前缀或换支持 `/anthropic/v1` 的服务；界面不提供自定义前缀（按新的 UI 规格，只有三个字段）。
2. **上游 CORS 是硬约束**：浏览器直连不支持 CORS 的中转必然失败，连通性测试会明确提示「或被跨域策略拦截」。
3. **语音（ASR/TTS）**：地址仍是 `{baseUrl}/v1/tools/{asr,tts}`，官方以外的中转基本没有这两个接口；且 `http://100.113.135.55:5181` 非安全上下文，语音入口本来就禁用。
4. **搜索 / 链接阅读 / 安全审核语义**：仅 DeepSeek 官方支持；上游接受字段但不代表真的执行。
5. **附件上传到中转**：走 `{baseUrl}/anthropic/v1/files`，该中转没有 Files API，可用性未验证（回归只证明了路径/字段未变）。
6. **无官方 Key**，故「官方上游成功出词 / 成功上传 / 标题真被生成」未做端到端验证，用请求形态逐字比对（0 差异）替代。
7. **多标签页**：配置存 localStorage，跨标签页不实时同步（与项目原有设置项一致）。
8. 深度思考 / 智能搜索仍是全局开关（未按服务记忆），与改造前一致。

---

## 8. 回滚方法

**A. 直接换回改造前产物**
```bash
cd /root/deepseek-app
rm -rf dist && cp -a dist-baseline dist
systemctl restart dsk-chat.service
curl -s -o /dev/null -w '%{http_code}\n' http://100.113.135.55:5181/   # 期望 200
```

**B. 回滚源码重建**
```bash
cd /root/deepseek-app
git checkout -- src .gitignore
rm -f src/services/apiConfig.ts src/components/settings/ApiConfigFields.tsx
/usr/local/bin/heavy-run pnpm build
systemctl restart dsk-chat.service
```

**C. 只回滚数据（保留新版本）**
```js
localStorage.removeItem('chat-demo:base-url')   // 回到构建期默认地址
localStorage.removeItem('chat-demo:model')      // 回到 deepseek-flash
// chat-demo:api-key 未改过名、未改结构，回滚到旧版本后仍可直接使用
```

---

## 9. 本次改动文件

新增：
- `src/services/api/apiConfig.ts` —— 三字段读写（三个 localStorage key）、默认值回落、baseUrl/model 校验、三条 URL 构造
- `src/components/settings/ApiConfigFields.tsx` —— API Key / 服务地址 / 模型三行（含连通性测试），完全复用现有样式类

修改：
- `ApiKeyField` 旧组件 → 删除（内容并入 `src/components/settings/ApiConfigFields.tsx`）
- `src/components/settings/SettingsDialog.tsx` —— 数据管理页改用 `ApiConfigFields`（未新增分组/页面）
- `src/components/settings/useApiKeyForm.ts`、`settingsDialogState.ts` —— Key 改由 `apiConfig` 管理
- `src/services/api/client.ts` —— 去掉写死的 `API_ORIGIN`/`ANTHROPIC_BASE_URL`，改为每次请求取 `getMessagesBaseUrl()` / `getModelsUrl()`；新增 `probeProvider`（连通性测试）
- `src/services/api/speech.ts` —— `TOOLS_BASE_URL` → `getToolsBaseUrl()`
- `src/services/api/types.ts` —— `ChatModel` 放宽为 `string`
- `src/services/chat/store.ts` —— `MODEL` → `getModel()`；Key → `getApiKey()`
- `src/services/settings.ts` —— 移除 `apiKey` 状态（改由 `apiConfig` 管理同一 key）
- `src/services/speech/readAloud.ts`、`src/components/chatInput/ChatInput.tsx`、`useVoiceInput.ts` —— Key 来源改为 `getApiKey()`
- `src/i18n/zh.ts`、`src/i18n/en.ts` —— 新增 12 条文案（服务地址 / 模型 / 测试结果与错误），中英同步
- `.gitignore` —— 忽略本地回归基线 `dist-baseline/`

未改动：`rspack.config.ts`（`__API_ORIGIN__` 注入保留作默认值）、`src/env.d.ts`、`Settings.module.css`（零改动）、IndexedDB 结构、消息渲染/流式解析、导入导出格式。
