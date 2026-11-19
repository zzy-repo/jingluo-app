# 当前诊断日志覆盖审计说明

## 审计对象

- 候选基线：`16b1240`（`integration/next`）
- beta 反馈：`v1.4.0-beta.7`
- 反馈文件：`/root/.dsh/attachments/v1/files/f3/f35ca5e43ec002789e6f3cc2e79456f580982db3f41198e6da5e3f2442aec65c/deepseek-feedback-2026-11-18T04-56-55-929Z-v1.4.0-beta.7.json`
- 反馈环境：FIN-AL60、Android 12、WebView 114；日志共 63 条。

## 反馈中可确认的事实

- 日志包含设置页打开、日志完整性检查、相册点击、反馈提交等操作。
- 日志中没有导入入口点击、确认、`import_start`、原生桥调用/返回、`import_done` 或导入错误事件。
- 因而这份反馈只能证明“提交的日志没有导入链路证据”，不能单独证明导入实现失败；用户是否实际进入导入入口/确认操作仍需由入口事件确认。
- 观察到的多次长任务（约 900/925ms，以及跨应用暂停恢复后的 303502ms、636651ms）不能作为导入耗时或 OOM 证据。暂停期间的可见性间隔已从 watchdog 计算中排除。

## 本候选的覆盖改动

导入操作现在以短生命周期 `correlationId` 关联确认、导入开始、原生下载开始、取消、解析/写入失败和完成事件；日志不保存 URL 路径、查询、签名或完整链接。错误仅保留脱敏后的错误元数据、阶段、耗时和错误码。

## 解释边界

- `watchdog` 只记录前台期间的主线程等待/耗时，不推断网络断开、DNS、TLS 或 OOM 根因。
- 原生网络真实请求、用户 API key、管理数据、AVD 和设备构建均未在本审计中调用。
- 诊断集成测试通过；全量集成中的其他失败涉及缺失标准构建产物、版本 fixture 与既有页面/环境问题，不作为本次导入覆盖改动的结论。

## 能力字段（capabilities / nativeCapabilities / polyfilled）—— #220

诊断快照里 `device.system` 下的能力字段现在分两个维度，别再当成一个布尔看：

| 字段 | 含义 | 说明 |
| --- | --- | --- |
| `capabilities.<key>` | 运行时可用（含入口兜底） | 与 #220 之前同义：`true` 只说明「调得到」 |
| `nativeCapabilities.<key>` | 内核原生具备 | 字段集合与 `capabilities` 相同；排查「这颗 WebView 差在哪」只认这份 |
| `polyfilled` | 入口兜底实际装上的 API 名 | 点名即该 API 原生缺失；末尾的 `__DEEPSEEK_LEGACY_POLYFILL__` 是兜底自己的标记位，不是 API |
| `degradedClones` | `structuredClone` 按引用降级透传的次数 | `>0` 表示有调用方在共享引用，排「改了原对象影响到别处」时先看它 |

原生结论取自 `src/polyfills/legacy.ts` 的 `legacyPolyfillReport()`（每个 installer 原生在就早退、不在才登记），
所以它反映的是**装兜底之前**的事实，不受 `main.tsx` 里 import 顺序影响。判定逻辑在
`src/services/diagnostics/capabilityTruth.ts`，回归用例 `tests/unit/diagnostics-capability-truth.test.mjs`
（宿主里真的删掉 `Object.hasOwn` / `Array.prototype.at` / `Array.prototype.toSorted` 再装真实兜底）。

未测边界：以上全部是 Node 里对真实模块的可执行对照（删原生 API 的测试替身），**没有**真机 / 模拟器
WebView 83 上的诊断截图；`nativeCapabilities` 只在入口兜底覆盖的 API 上有意义（其余字段入口没补过，
两个维度必然相等）。
