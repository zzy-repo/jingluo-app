# 客户端基础设施模块统一规范

适用：Storage Module（#906）、FileSystem（#907）、HostFiles（#908）、Storage Protection（#909）、SQLite（#910）及后续所有触碰原生能力的基础设施模块。

## 1. 验证口径
- 真机验证**不**阻塞 PR 合并。必须保留：构建验证、契约测试、故障注入测试。
- PR 正文必须如实列出「未验证范围」（例如「Android 原生写入未真机验证」）。模拟结果不得写成真机通过。

## 2. 原生调用只经 Adapter
- 一个模块里**只有** `src/services/<模块>/native/` 下的文件可以 import `@capacitor/*` 或调用 `Capacitor.*`、`registerPlugin`。
- Adapter 内部负责：能力探测、安全调用、异常标准化、降级。业务层与模块的非 native 文件看到的只有模块的公开接口。
- 业务代码里不得出现 `isNativePlatform()` / `getPlatform()` 判断；平台差异由 `getXxx()` 工厂返回对应实现。

## 3. 能力探测不能只看平台
统一入口 `src/services/capability/probe.ts` 的 `probeNativePlugin()`，依次覆盖：
1. 宿主是否原生（复用 `utils/capabilities.ts` 的 `isNative`）
2. 插件是否注册（复用 `hasPlugin`）
3. 方法是否支持（插件提供 `capabilities()` 返回方法清单，不靠「调了看会不会炸」）
4. 必要权限（插件有 `checkPermissions` 时调用）
5. 运行时可用性（一次轻量 ping，如目录可写）

返回 `{ available: true }` 或 `{ available: false, reason, detail? }`，`reason` ∈ `not-native | plugin-unregistered | method-missing | permission-denied | runtime-failed`。瞬时失败（runtime-failed）不写缓存，结论性的（not-native、plugin-unregistered）才缓存。

## 4. 统一错误语义
所有基础设施模块对外只抛带 `kind` 的标准错误：`unsupported`（宿主没有此能力）、`permission`（权限不足）、`quota`（空间不足）、`unavailable`（运行时不可用）、`unknown`（执行失败）。
- 禁止静默失败：调用方一定能区分「成功 / 不支持 / 失败」。
- **禁止把持久化操作降级到内存后返回成功。**拿不到持久化能力，就抛 `unsupported` 或 `unavailable`。
- 与现有 `StorageFailureKind`（quota/clone/unavailable/unknown）口径兼容：新增的 `unsupported`、`permission` 只做加法。

## 5. 不重复实现
能力探测、错误类型、`kind` 映射各只有一份（`src/services/capability/`）。模块里出现第二份就是缺陷。

## 6. 数据保护标记
Storage Protection 的高水位标记，Native 端优先写独立于 WebView 存储的原生持久化空间（经 `AppFileSystem`）；localStorage 只在 Web 端作为实现，或原生不可用且明确标注的备份。不得因为原生不可用就静默改用内存。

## 7. 依赖方向
Storage Protection 只经 Storage Module 与 FileSystem 的**公开接口**接入（`getStorage()` / `getFs()` 及其类型），不得 import `chat/db.ts` 等内部实现。

## 8. 边界测试
`tests/unit/infra-boundary.test.mjs` 断言：`src/services/{capability,fs,storage,protection}/` 下，`native/` 以外的文件不 import `@capacitor/*`，且不含 `isNativePlatform` / `getPlatform`；`storage/**`、`fs/**` 不 import react、zustand、components、app、i18n。这是单元测试，不是新增 CI 门禁。
