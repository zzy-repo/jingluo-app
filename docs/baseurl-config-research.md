# 调研报告：把 API baseurl 改成运行时可设置项

- 仓库：`/root/deepseek-app`（DeepSeek 官方开源前端 chat-demo v0.1.1，React 18 + TS + rspack 2）
- 线上产物：http://100.113.135.55:5181 （`python -m SimpleHTTP/0.6` 静态托管，`dist/` 同仓库 `dist/`，入口 `static/js/main.9820cd3a.js`）
- 调研时间：2026-11-17；**本次未修改 `src/` 任何文件，未重新构建**
- 结论一句话：**能改，而且改动很小**（唯一 URL 来源就是 `__API_ORIGIN__` 一个常量，共 3 个拼接点、6 个请求），推荐「构建期默认值 + 运行时可覆盖」；真正的风险不在前端代码，而在**中转站是否兼容 DeepSeek 专有协议与 CORS**。

---

## 0. 结论速览

| 问题 | 答案 |
| --- | --- |
| 现在能不能改？ | **能**。`API_ORIGIN` 是构建期 `DefinePlugin` 注入的字符串常量（`rspack.config.ts:83`），全仓库仅 3 处派生 URL（`client.ts:15/94`、`speech.ts:9`），改成「每次请求取值」是局部重构 |
| 推荐方案 | **方案 C：保留 `__API_ORIGIN__` 作为出厂默认值 + 设置页可覆盖 + localStorage 持久化**（等价于方案 A 加一个兜底默认，代码量几乎相同，但保留 `pnpm dev` / 官方渠道开箱可用） |
| 要改的文件 | 5 个必改 + 1 个新增 + 1 个可选：`src/services/settings.ts`、`src/services/api/client.ts`、`src/services/api/speech.ts`、`src/components/settings/SettingsDialog.tsx`、`src/i18n/zh.ts`、`src/i18n/en.ts`、新增服务地址输入组件（实际落在 `src/components/settings/ApiConfigFields.tsx`；若复用 `Settings.module.css` 现有类则 0 改动） |
| 工作量 | MVP **约 3–4 人时**；含 URL 规范化和 API Key 重校验 **约 6–7 人时**；含全能力回归测试与文档 **约 10–11 人时（≈1.5 人日）** |
| 最大的坑 | **中转站语义兼容 + CORS 预检**，不是前端。① `messages` 里用了非标准 `role: 'latest_reminder'`（`reply.ts:315`）和 `safety_check` / `title` / `deepseek_read_url` / `deepseek_web_search` 等专有字段，普通 Anthropic 反代会被 400；② 中转站必须回显 `Origin` 并放行 `x-api-key`、`anthropic-beta`、`content-type`、`authorization` 头，否则前端只显示「网络错误」，用户完全无法自查 |

---

## 1. `API_ORIGIN` / `__API_ORIGIN__` 的注入机制

### 1.1 注入点（构建期，唯一定义处）

`rspack.config.ts`：

```ts
19  type ConfigOptions = {
20    /** 公开 API 的地址，注入为 __API_ORIGIN__ */
21    apiOrigin?: string
22    /** 开发服务器配置，支持本地接口代理 */
23    devServer?: Configuration['devServer']
24  }
25
26  /** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
27  export const createConfig = ({
28    apiOrigin = 'https://api.deepseek.com',      // ← 出厂默认值
29    devServer,
30  }: ConfigOptions = {}): Configuration => ({
...
83      new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify(apiOrigin) }),
```

- **第 28 行**：默认值 `'https://api.deepseek.com'`。
- **第 83 行**：`DefinePlugin` 把 `__API_ORIGIN__` 文本替换为字符串字面量。
- **第 93 行**：`export default defineConfig(createConfig())` —— 默认导出调用时**没有传参**，所以 `pnpm build` 一定用第 28 行的默认值；要改就得改源码或 `createConfig({ apiOrigin })`。仓库没有从 `process.env` 读取的代码，也没有 `.env` 支持（`package.json` 的 `build` 脚本为 `rm -rf dist && NODE_ENV=production rspack build -c rspack.config.ts`，无额外变量）。
- CI（`.github/workflows/pages.yml`）直接 `pnpm build`，同样走默认值。

**类型声明**：`src/env.d.ts:9`

```ts
/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string
```

### 1.2 全仓库引用清单（`grep -rn "API_ORIGIN\|__API_ORIGIN__"`，排除 node_modules）

| # | 文件:行 | 内容 | 角色 |
| --- | --- | --- | --- |
| 1 | `rspack.config.ts` 的 `__API_ORIGIN__` 注释（`apiOrigin`） | 注释 | — |
| 2 | `rspack.config.ts:83` | `new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify(apiOrigin) })` | **注入点** |
| 3 | `src/env.d.ts:9` | `declare const __API_ORIGIN__: string` | 类型声明 |
| 4 | `src/services/api/client.ts:13` | `export const API_ORIGIN = __API_ORIGIN__` | **唯一的运行时取值点** |
| 5 | `src/services/api/client.ts:15` | `` const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1` `` | 派生 |
| 6 | `src/services/api/client.ts:94` | `` request(`${API_ORIGIN}/models`, …) `` | 派生（verifyApiKey） |
| 7 | `src/services/api/speech.ts:1` | `import { ApiError, API_ORIGIN, request } from './client.js'` | 跨模块引用 |
| 8 | `src/services/api/speech.ts:9` | `` const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools` `` | 派生 |

`grep -rn "deepseek.com" src` 只剩 4 处与 API 无关的文档/外链：`AssistantMessage.tsx` 的充值页链接、`attachments.ts` 的 `DELETE_FILE_DOCS_URL`（删除文件文档链接）、`src/services/api/types.ts` 的协议文档链接注释、`client.ts:12`（注释）。**没有任何第二套 URL 常量。**

### 1.3 构建产物实证（证明当前是「编译期烧死」）

```
$ cd /root/deepseek-app/dist && grep -ro "https://api.deepseek.com" . | sort | uniq -c
      1 ./static/js/main.9820cd3a.js:https://api.deepseek.com
```

- 全量产物中该字符串**只出现 1 次**，位于 `main.9820cd3a.js`，源码形态为 `m="https://api.deepseek.com",g=`${m}/anthropic/v1``。
- 说明：① 没有独立的运行时配置文件（`index.html` 只有 `static/js/main.*.js` + 一份 CSS，无内联脚本、无 `window.__CONFIG__`）；② `client.ts` / `speech.ts` 全在主 bundle（同步 import），异步 chunk 里没有第二份副本——这对改造是好事，**不需要处理 chunk 一致性**。
- 结论：**上线后无法通过改任何文件/环境变量改变 baseurl**，必须重新构建。

---

## 2. 路径拼接规则与完整 URL 清单

拼接只发生在两处常量上，全部请求都经过 `client.ts` 的统一 `request()`（`client.ts:69`，内部只做 `fetch` + 错误包装，不拼 URL）。

### 2.1 拼接点

| 派生常量 | 定义位置 | 值 | 使用位置 |
| --- | --- | --- | --- |
| `API_ORIGIN` | `client.ts:13` | `__API_ORIGIN__` | `client.ts:94`、`speech.ts:9`（经 import） |
| `ANTHROPIC_BASE_URL` | `client.ts:15` | `${API_ORIGIN}/anthropic/v1` | `client.ts:116`、`client.ts:127`、`client.ts:149` |
| `TOOLS_BASE_URL` | `speech.ts:9` | `${API_ORIGIN}/v1/tools` | `speech.ts:24`、`speech.ts:55` |

### 2.2 每种能力的完整 URL（以 `ORIGIN=https://api.deepseek.com` 为例）

| 能力 | 方法 + 完整路径 | 代码位置 | 鉴权头 |
| --- | --- | --- | --- |
| 校验 API Key（不产生费用） | `GET https://api.deepseek.com/models` | `client.ts:92-99` | `Authorization: Bearer <key>` |
| 聊天 / 深度思考 / 智能搜索 / 读链接 / 自动标题（SSE 流） | `POST https://api.deepseek.com/anthropic/v1/messages` | `client.ts:144-158` | `x-api-key`、`anthropic-beta`（带附件时）、`Content-Type: application/json`、`Accept: text/event-stream` |
| 上传附件（图片 / PDF / Word / PPT / 文本） | `POST https://api.deepseek.com/anthropic/v1/files` | `client.ts:105-123` | `x-api-key`、`anthropic-beta: files-api-2025-04-14`、`multipart/form-data` |
| 删除附件 | `DELETE https://api.deepseek.com/anthropic/v1/files/{file_id}` | `client.ts` 的 `deleteFile()` | `x-api-key`、`anthropic-beta` |
| 语音识别 ASR | `POST https://api.deepseek.com/v1/tools/asr` | `speech.ts:17-46` | `Authorization: Bearer`、`multipart/form-data` |
| 语音合成 TTS | `POST https://api.deepseek.com/v1/tools/tts` | `speech.ts:49-65` | `Authorization: Bearer`、`Content-Type: application/json` |

补充事实：

- `deleteFile`（`client.ts` 里的 `deleteFile()`）**全仓库无调用者**（`grep -rn "deleteFile" src` 只命中定义本身），所以 DELETE 请求当前实际不发；但改造时仍需让它跟随 baseurl，以免将来启用时踩坑。
- 没有其他能力级 baseurl：`grep -rn "fetch("`、`EventSource`、`WebSocket`、`sendBeacon` 均无其他命中；搜索结果里的图片/站点图标是服务端返回的第三方 URL，由浏览器直连，与 baseurl 无关（`components/search/*`）。
- 三个能力前缀不同（`/models`、`/anthropic/v1`、`/v1/tools`）——**baseurl 语义必须是"origin"**（如 `https://api.deepseek.com`），不是"API 前缀"（如 `https://x.com/v1`），否则拼出来的路径会重复或错位。这是设置项文案必须讲清楚的点。

### 2.3 请求体里的非标准字段（决定中转站能否用）

`client.ts:149` 发往 `/anthropic/v1/messages` 的 body（`store.ts` 里 `streamMessage(...)` 的请求体 + `src/services/api/types.ts` 的 `CreateMessageRequest`）：

```ts
model: 'deepseek-flash' | 'deepseek-v4-pro'     // src/services/chat/store.ts:36, types.ts:7
system, messages,
thinking: { type: 'enabled' | 'disabled' }
safety_check: { level: 'high' }                  // 专有
tools: [{ type: 'deepseek_read_url', … }, { type: 'deepseek_web_search', … }]  // 专有
title?: { enabled: true }                        // 专有（自动生成标题）
```

并且 `messages` 数组里会出现**非标准角色**：

```ts
// src/services/chat/reply.ts:315
messages.push({ role: 'latest_reminder', content: reminder })
```

→ 任何"只做标准 Anthropic 协议校验/转换"的中转站都会在这些字段上 400/422。中转站必须是 **DeepSeek 的透传或 DeepSeek 兼容实现**。

---

## 3. 设置系统现状（新增字段的落点）

### 3.1 存储层：`src/services/settings.ts`

- 结构体：`Settings`（第 11–20 行），字段 `apiKey | locale | themePreference | location | ttsVoice | thinking | search | siderCollapsed`。
- **key 命名规范**（第 22–31 行）：统一 `chat-demo:` 前缀 + kebab-case：

```ts
const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const
```

- 读写封装：`read()`（33–39）/ `write()`（41–51），**都带 try/catch**（隐私模式、`file://` 存储不可用时只在内存生效）。新字段必须走这两个函数，不要直接 `localStorage.getItem`。
- store：`useSettings = create<Settings>(() => ({…}))`（90–99），初始值用 `initialXxx()` 惰性函数（如 `initialTtsVoice()` 88 行：非法值回落到默认）。
- setter 模式（101–139）：每个 setter 都是 `write(KEYS.x, value)` + `useSettings.setState({ x })` 两行，例：

```ts
export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}
```

### 3.2 UI 层：`src/components/settings/`

| 文件 | 作用 | 关键行 |
| --- | --- | --- |
| `SettingsDialog.tsx` | 设置弹窗骨架：两个分组 tab，`SettingCell` 行组件 | `sections` 48–55；通用分组 97–103（主题/语言/音色/位置）；数据分组 104–125（API Key / 导入 / 导出 / 删除）；`SettingCell` 408–437 |
| `ApiKeyField.tsx` | 最接近"新增一个 URL 输入框"的现成范式：**已保存 → 掩码 + 编辑按钮 → 输入框 + 确认按钮** | `useApiKeyEditor` 11–16；`ApiKeyField` 21–84；移动端整行确认 `ApiKeyConfirm` 87–100 |
| `useApiKeyForm.ts` | 表单状态 + **保存前用 `verifyApiKey()` 校验**（`GET /models`），通过才 `setApiKey()` | 30–47 |
| `settingsDialogState.ts` | 弹窗开关与分组（`openSettings('general' \| 'data')`） | 8–24 |
| `Settings.module.css` | 样式；`.apiKey / .apiKeyInput / .apiKeySaved / .divider / .confirm` 可直接复用于 URL 输入框 | 207–289 |

### 3.3 i18n

- 字典：`src/i18n/zh.ts`、`src/i18n/en.ts`；`TranslationKey = keyof typeof zh`（`i18n/index.ts:5`）→ **新增 key 必须两套同步加**，缺 en 会类型报错。
- 设置项文案集中在 `zh.ts` 第 87–105 行 / `en.ts` 第 92–110 行附近（`settingsTtsVoice`、`settingsLocation`、`apiKeyStart`、`apiKeyEdit`、`apiKeyPlaceholder`、`apiKeyVerifying`、`apiKeyInvalid`、`apiKeyVerificationFailed`）。

### 3.4 新增 "Server URL" 字段需要动的位置（严格照现有模式）

1. `settings.ts`：`Settings` 加 `serverUrl: string | null`；`KEYS` 加 `serverUrl: 'chat-demo:server-url'`；新增 `initialServerUrl()`（校验协议 + 去尾斜杠）；store 初始化加一行；新增 `setServerUrl`（两行，照抄 `setApiKey`）。
2. `components/settings/ServerUrlField.tsx`（新增，~60–80 行）：照 `ApiKeyField.tsx` 的输入框 + 确认按钮模式；`<input type="url">` 而非 `type="password"`；占位符显示默认值 `https://api.deepseek.com`。
3. `SettingsDialog.tsx`：在数据分组 106 行 `ApiKeyField` 之前（或通用分组 103 行 `LocationSetting` 之后）挂一行 `<ServerUrlField />`。**建议放在 `ApiKeyField` 之前**，因为改地址后 API Key 的可用性会变。
4. `i18n/zh.ts` + `i18n/en.ts`：新增 4–6 个 key（`settingsServerUrl` 标题、`settingsServerUrlPlaceholder`、`settingsServerUrlDescription`、`settingsServerUrlInvalid`、`settingsServerUrlReset`）。
5. `Settings.module.css`：若直接复用 `.apiKey / .apiKeyInput / .apiKeySaved / .confirm`，**可以 0 新增**；要独立命名再加 ~20 行。

---

## 4. 三种改造方案对比

前置事实：`client.ts` 和 `speech.ts` 目前都是**模块级常量**，而仓库既有代码已经大量在"请求时读取设置"（`useSettings.getState().apiKey`：`store.ts` 的 `prepareFiles()` / `streamReply()`、`readAloud.ts:95`、`useVoiceInput.ts:78`）——所以把它们改成函数取值，**是顺着既有架构走，不是引入新模式**。

### 方案 A：纯运行时（设置页填写 + localStorage，"必填"）

改动：`settings.ts`、`client.ts`、`speech.ts`、新增 `ServerUrlField.tsx`、`SettingsDialog.tsx`、`zh.ts`、`en.ts` → **6 改 + 1 新增**；`rspack.config.ts` 的 `DefinePlugin` 可删（也可留着不用）。

| 维度 | 评估 |
| --- | --- |
| 状态管理 | 需要（`zustand` 已有，成本几乎为 0） |
| 已缓存会话 | 会话 metadata 不受影响；**附件 `file_id` 会跨服务失效**（见 §5.1） |
| CORS | 与 C 相同 |
| APK 套壳 | 一个包通用，最友好 |
| 缺点 | 首次使用必须先填地址，`pnpm dev` / 官方 GitHub Pages 开箱即用的体验被破坏；一旦用户填错、又没有默认值兜底，表现为"连不上、什么都没发生" |

### 方案 B：多套构建产物（不同 baseurl 不同包）

改动：`rspack.config.ts:28/93` 加 `process.env.API_ORIGIN` 读取 + 构建脚本/CI 参数 → **1–2 个文件**（源码 0 改动）；每个分发对象出一份 `dist`。

| 维度 | 评估 |
| --- | --- |
| 状态管理 | 不需要 |
| 已缓存会话 | 各包为独立 origin，天然隔离；但用户换包即换站点 origin，**IndexedDB/localStorage 全部重新开始**（数据不迁移） |
| CORS | 每个中转站仍需单独配置允许该域名，N 个客户 = N 次运维 |
| APK 套壳 | **最差**：N 客户 = N 个 APK，每次客户换中转站都要重新打包发布、重新提审 |
| 适用 | 只适合"客户数量固定且极少、且坚决不接受设置页暴露 baseurl"的场景 |

### 方案 C（推荐）：构建期默认值 + 运行时可覆盖

`apiOrigin()` 取值顺序：`localStorage['chat-demo:server-url']` → 否则 `__API_ORIGIN__`（构建期默认）。即**在方案 A 上加一个兜底**，代码量与 A 几乎相同（多 2 行），但：

- 出厂/默认分发仍指向 `https://api.deepseek.com`，老用户体验不变；
- `rspack.config.ts` 一行不改，`pnpm dev`、CI、`file://` 离线包全部照旧；
- 业务方要换中转站：设置页填一次即可；
- 想给某客户出"锁定版"仍可用 B 的手段（给 `apiOrigin` 传参并隐藏设置项），两种策略可叠加。

| 维度 | 评估 |
| --- | --- |
| 改动文件数 | 6 改 + 1 新增（与 A 相同） |
| 状态管理 | 需要（复用 zustand `useSettings`） |
| 已缓存会话 | 同 A |
| CORS | 同 A |
| APK 套壳 | 一个包通用；WebView 的 Origin 需中转站放行（见 §5.4） |

### 汇总表

| | 改文件数 | 动状态管理 | 影响已缓存会话 | CORS 风险 | APK 套壳 |
| --- | --- | --- | --- | --- | --- |
| A 纯运行时 | 6+1 | 是（轻） | 附件 file_id 失效 | 取决于中转站 | 好 |
| B 多套产物 | 1–2（0 源码） | 否 | 换包即换 origin，**本地数据全丢** | 每客户配一次 | 差（N 包） |
| **C 默认+覆盖（推荐）** | **6+1** | **是（轻）** | **附件 file_id 失效** | **取决于中转站** | **好** |

---

## 5. 兼容性风险清单（换 baseurl 后可能坏掉的地方）

### 5.1 附件（Files API）——最容易坏，且是"历史数据级"的坑

- 上传走 `POST {base}/anthropic/v1/files`，带**专有头** `anthropic-beta: files-api-2025-04-14`（`client.ts:17/85-90`）和 `purpose: rich_layout_recognition | user_data`（`attachments.ts` 的 `getUploadPurpose()`）。中转站若不实现，附件功能整体不可用。
- 会话里已存的 `serverId` 指向**旧服务的 file_id**，新服务不认。仓库有自愈逻辑：`src/services/chat/store.ts:896-926` 在服务端报 `invalid file_id` 时清空 `serverId`，再用 IndexedDB 里的原件补传（`db.ts:7-11`、`src/services/chat/store.ts:43` `FILE_RETRY_LIMIT=2`）。
- **但有代价**：① 每次首轮遇到旧 file_id 会多一轮 400 + 重传；② 若该附件在 IndexedDB 没有原件（例如从外部导入的历史 ZIP 里的**非图片**附件，见 README 数据章节），则永远补不回来 → 旧会话里这类附件会静默变成"不进入请求"。
- 结论：**切换 baseurl 后建议明确提示"历史附件可能需要重新上传"**，或提供"清空旧 serverId"的一次性迁移。

### 5.2 ASR / TTS

- 走完全不同的前缀 `{base}/v1/tools/asr`、`{base}/v1/tools/tts`（`speech.ts:9/24/55`），且 TTS 返回**裸 PCM**（24kHz 单声道 16-bit，`speech.ts:13-14`），由前端 `AudioContext` 播放。中转站若不透传这两条路径，语音输入/朗读直接 404，与聊天功能互不影响（不会连累主流程，但用户会以为"坏了"）。

### 5.3 搜索 / 读链接 / 自动标题（协议扩展）

- 全部复用 `POST /anthropic/v1/messages`，靠 `tools: deepseek_read_url / deepseek_web_search`、`safety_check`、`title`、`messages[].role='latest_reminder'` 触发（§2.3）。中转站做标准 Anthropic 校验 → 主聊天也会 400，**这是最致命的一类不兼容**（不是"搜索不可用"，而是"完全不能聊天"）。

### 5.4 CORS 预检（前端只能给出误导性的「网络错误」）

- 触发点：`application/json`（非安全列表 MIME）+ 自定义头 `x-api-key` / `anthropic-beta` / `authorization` → **所有 POST 都先发 OPTIONS 预检**。
- 前端对预检失败的处理：`client.ts:69-78` 把任何 `fetch` 抛出的 `TypeError: Failed to fetch` 包成 `ApiError('network')`，UI 只显示"网络错误"（`useApiKeyForm.ts:19-20`）。**用户无法从界面区分"地址填错/CORS 被拦/服务挂了"**。
- 官方端点的实测基准（作为中转站的验收标准，`curl -X OPTIONS` 于 2026-11-17）：

```
OPTIONS https://api.deepseek.com/anthropic/v1/messages
  → 200, access-control-allow-origin: <回显 Origin>
    access-control-allow-methods: POST
    access-control-allow-headers: x-api-key,anthropic-beta,content-type

OPTIONS https://api.deepseek.com/anthropic/v1/files/xyz  (DELETE)
  → access-control-allow-methods: DELETE, allow-headers: x-api-key,anthropic-beta

OPTIONS https://api.deepseek.com/v1/tools/asr
  → access-control-allow-methods: POST, allow-headers: authorization,content-type
```

  → 中转站必须：**回显 `Origin`（或配白名单）**，并放行上述 4 个头 + `POST`/`DELETE`，且**不能**要求 cookie（前端 `fetch` 未设 `credentials`，不用 `allow-credentials`）。
- 额外：`file://` 打开离线包时 Origin 是 `null`，多数网关不放行（README:28 已提到这一限制）；WebView 套壳同理，**需要在 WebView 侧注入/代理请求或改用本地 http 容器**（此项需实测确认）。

### 5.5 URL 形态

- **尾斜杠**：用户填 `https://relay.example.com/` → 拼成 `…com//anthropic/v1/messages`（多数网关能容忍，少数 404）。必须 `replace(/\/+$/, '')`。
- **误填路径前缀**：填 `…/v1` 或 `…/anthropic/v1` → 变成 `/v1/anthropic/v1/…`。设置项标签必须写"服务地址（origin）"，并做形态校验。
- **协议**：只接受 `http:` / `https:`，用 `new URL()` 校验；非法值不得写入 localStorage（否则下一次启动直接不可用，且没有界面可进入）——这是 `initialServerUrl()` 必须兜底回默认值的原因（照 `settings.ts` 的 `initialTtsVoice()` 的写法）。
- **带查询串/锚点**：`https://x.com?k=1` 拼接会错位，应拒绝。
- **混合内容**：当前站点是 **`http://100.113.135.55:5181`**，配 http 中转站暂时可行；一旦站点上 https（或套壳用 https 容器），**http 中转站会被浏览器以 Mixed Content 直接 block**，且报错同样是 `network`。建议设置项在 `location.protocol === 'https:'` 时对 `http:` 值给出显式警告。

### 5.6 安全与隐私（新增面）

- API Key 与新 baseurl **分开存储**：用户切换中转站后，**旧 Key 会被原样发给新地址**（每次请求读 `apiKey` + 新 origin）。改造时建议：保存新 baseurl 时提示"将使用当前 API Key 访问该地址"，或干脆清空 `apiKey` 强制重填/重新 `GET /models` 校验。
- `useApiKeyForm.ts` 的校验只在**存 Key 时**发生。若先存了 Key 再改地址，界面会显示"已保存"的掩码而实际不可用 → 应在保存 baseurl 后触发一次 `verifyApiKey()` 并回显结果。

---

## 6. 工作量估算与 MVP

### 6.1 明细（方案 C，1 名熟悉该仓库的前端）

| 工作项 | 涉及文件 | 人时 |
| --- | --- | --- |
| settings 增加字段 / KEYS / 初始化 / setter / URL 规范化 | `services/settings.ts` | 1.0 |
| `client.ts`：`API_ORIGIN` → `apiOrigin()` 函数，改 3 处调用点（含 `ANTHROPIC_BASE_URL` 改为函数内拼接） | `services/api/client.ts` | 0.5 |
| `speech.ts`：`TOOLS_BASE_URL` 模块常量 → 函数，改 2 处调用点 | `services/api/speech.ts` | 0.5 |
| 设置页新字段组件 + 挂载（复用现有 CSS 类） | `settings/ServerUrlField.tsx`(新增)、`SettingsDialog.tsx` | 2.0 |
| 中英文案 4–6 个 key | `i18n/zh.ts`、`i18n/en.ts` | 0.5 |
| 保存 baseurl 后重校验 Key / 旧 Key 处理提示 | `ServerUrlField.tsx`、`useApiKeyForm.ts`（可选） | 1.0 |
| 手工回归：聊天、深度思考、搜索+读链接、自动标题、附件上传（图/PDF）、ASR、TTS、错误路径（错地址/CORS/401）、刷新后持久化 | — | 3.0 |
| 文档（README 第 56 行附近 + 本文档落地） | `README.md` | 0.5 |
| **合计** | **6 改 + 1 新增** | **≈9–10 人时** |
| 其中可省（不做重校验/CORS 友好提示/文档） | | 省 ~2 → **≈6–7 人时** |

### 6.2 MVP（最小可行改动，**3–4 人时**）

只做"能用"的四件事，**不动 UI 设计、不动 CSS、不加重校验**：

1. `src/services/settings.ts`：加 `serverUrl: string | null`、`KEYS.serverUrl = 'chat-demo:server-url'`、`initialServerUrl()`（`new URL` 校验 + 去尾斜杠 + 非法回 `null`）、`setServerUrl()`（照抄 `setApiKey`）。
2. `src/services/api/client.ts`：
   ```ts
   export const apiOrigin = (): string =>
     useSettings.getState().serverUrl ?? __API_ORIGIN__
   ```
   `ANTHROPIC_BASE_URL` 常量的 3 个使用点（116/127/149）改为函数内 `` `${apiOrigin()}/anthropic/v1/...` ``；94 行改为 `` `${apiOrigin()}/models` ``。（`speech.ts:1` 的 `API_ORIGIN` import 若保留导出可先不动，但更好是一并改成 `apiOrigin()`。）
3. `src/services/api/speech.ts`：`TOOLS_BASE_URL` 常量 → `const toolsBaseUrl = () => `${apiOrigin()}/v1/tools``，改 24/55 两行。
4. 新增服务地址输入组件（~50 行，落在 `src/components/settings/ApiConfigFields.tsx`，复用 `.apiKey` / `.apiKeyInput` / `.confirm` 三个类）+ 在 `SettingsDialog.tsx` 的 `data` 分组第 106 行前挂一行 + `zh.ts`/`en.ts` 各 3 个 key（标题、占位符、非法提示）。

**不为 MVP 做、但建议第二批做**：保存后自动 `verifyApiKey()`、`http:` 混合内容告警、历史附件 `serverId` 迁移提示、README 更新。

### 6.3 建议的验收清单（改造后逐项过）

- [ ] 默认不改设置：一切与现在完全一致（构建期默认仍生效）
- [ ] 填合法中转站 + Key → `GET /models` 通过、普通聊天、深度思考、搜索、读链接、自动标题均正常
- [ ] 上传图片 / PDF 成功、历史会话里旧附件能自愈补传或给出明确提示
- [ ] ASR、TTS 可用
- [ ] 填带尾斜杠的地址、填带 `/v1` 的地址、填非法字符串 → 三种情况表现可控（不写坏存储）
- [ ] 刷新页面 / 重开浏览器 → baseurl 持久化
- [ ] 清除该 localStorage key → 回落 `https://api.deepseek.com`
- [ ] CORS 未配置的中转站 → 提示可理解（至少别只说"网络错误"）

---

## 附录 A：改动文件清单（可直接派工）

| # | 文件 | 改动性质 | 关键行 |
| --- | --- | --- | --- |
| 1 | `src/services/settings.ts` | 改 | 类型 11–20；`KEYS` 22–31；新增 `initialServerUrl()`（参考 88 行）；store 90–99；setter（参考 122–125） |
| 2 | `src/services/api/client.ts` | 改 | 13、15 → 函数；94、116、127、149 四个调用点 |
| 3 | `src/services/api/speech.ts` | 改 | 1（import）、9 → 函数；24、55 |
| 4 | 新增服务地址输入（落在 `src/components/settings/ApiConfigFields.tsx`） | **新增** | 参考 `src/components/settings/ApiConfigFields.tsx` 的输入框模式 |
| 5 | `src/components/settings/SettingsDialog.tsx` | 改 | 分组内容 97–103 / 104–126（建议 106 行前插入） |
| 6 | `src/i18n/zh.ts` | 改 | 87–105 区域新增 3–6 个 key |
| 7 | `src/i18n/en.ts` | 改 | 92–110 区域同步 |
| 8 | `src/components/settings/Settings.module.css` | 可选 | 207–289 已有可复用类；如需独立样式再加 |
| — | `rspack.config.ts` | **方案 C 下不改** | 28、83 保留为出厂默认 |
| — | `src/env.d.ts` | 不改 | 9 行声明保留 |

## 附录 B：本次调研的取证命令（可复现）

```sh
cd /root/deepseek-app
grep -rn "API_ORIGIN\|__API_ORIGIN__" src rspack.config.ts        # 全部引用点
grep -rn "fetch(" src                                              # 网络调用全集
grep -rn "deepseek.com" src                                        # 有无第二套 origin
grep -ro "https://api.deepseek.com" dist | uniq -c                 # 产物中被烧死的次数（=1）
grep -rn "role: 'latest_reminder'" src                             # 非标准协议字段
curl -sI http://100.113.135.55:5181/ | head                        # 现网托管方式与响应头（无 CSP）
curl -si -X OPTIONS https://api.deepseek.com/anthropic/v1/messages \
  -H "Origin: http://100.113.135.55:5181" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: x-api-key,anthropic-beta,content-type"
```
