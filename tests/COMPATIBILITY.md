# beta6 旧设备兼容审计（轻量、非发布阻塞）

基线：已发布 `v1.4.0-beta.6` / `21987ea`。本任务不绑定下一次功能发布，离线日志最高优先，不等待本审计。

## 判断边界

- `android/variables.gradle`：minSdk 24（Android 7.0）、compile/target 36。minSdk 仅代表安装门槛，不代表系统内置 WebView 能执行页面；同一 Android 版本可以安装不同 WebView provider/版本。OEM 固化组件、WebView 更新状态与安全上下文均需另记。
- `rspack.config.ts:8` 显式目标 Chrome/Edge >=105、Safari >=16、Firefox >=110，非独立 browserslist 文件。SWC 只转换源码语法，排除 node_modules；无 core-js 或运行时 API polyfill。LightningCSS 的目标转换不证明布局、第三方依赖或运行时 API可用。
- **105 可加载 UI 尚未实测**。beta6 三处 `toSorted`/`toReversed` 需要 Chrome110+，相关修复由发布/导入 owner 负责，本分支不重复。去掉这三处不等于支持92：首屏 `Object.hasOwn` 需要93，Array.at需要92；依赖与CSS还需真实旧内核验证。
- 本分支仅增加 ES5 HTML 启动提示和能力缺失 fixture；不降低构建目标、不安装旧浏览器、不构建APK、不启动模拟器。提示保留在 React 启动前，首屏解析/模块加载/异步任务失败有可读信息；React 成功渲染移除占位后不干预运行中错误。提示不是全功能polyfill或浏览器兼容认证。

## 风险排序与能力策略

| 优先级/路径 | beta6 实际 API / 风险 | 检测与最小替换方向 |
| --- | --- | --- |
| P0 首屏/状态/i18n | App、store、i18n 的 Object.hasOwn（93+）；消息/Modal 的 Array.at（92+）；ResizeObserver/CSS.escape；第三方依赖未转译 | HTML 在 bundle 前检测并留可读错误；若决定92支持，用 hasOwnProperty.call、显式索引并检查依赖编译目标，非本轮承诺 |
| P0 导入/聊天/更新 | 三处新 Array API 在105失败，owner处理中 | slice().sort / slice().reverse 由对应owner验收，审计不重复改 |
| P1 更新 | appUpdate.ts:56 直接 crypto.randomUUID（92+，secure context）；原生 AppUpdate 版本签名/安装权限API有SDK条件分支 | 检查 crypto 与方法再选已有 createId helper；WebView origin、插件注册和用户安装权限必须真机验证，本轮仅启动提示 |
| P1 聊天/模型 | fetch + AbortController + Response.body.getReader + TextDecoder；模型加载同用fetch，HTTP/桥接差异 | 分别检测 API、流式 body，缺流时显式报错或非流模式（后续）；测试超时取消/断流/模型接口错误，不凭 UA 判断 |
| P1 导入/导出/离线日志 | Blob.stream().getReader、File/Blob/URL.createObjectURL、IndexedDB 与存储权限/配额；fflate worker行为 | 存储失败需可读提示与导出路径；Blob.stream缺失可分片arrayBuffer适配；离线日志归日志owner立即发布，不等待旧版全量验证 |
| P1 反馈 | FileReader、FormData、fetch/AbortController；native transport 与 browser transport不同 | 模拟 FileReader/网络/桥接缺失，不用真实反馈后端；实际文件分享和权限需真设备 |
| P2 复制 | beta6 navigator.clipboard.writeText 有 try/catch 并降级textarea/execCommand | 缺方法、权限失败、长文本分开验；新的Android桥接复制由clipboard owner负责 |
| P2 布局/模型弹层 | 100dvh（Chrome108+）；:has（105+）；设置弹层max-height及键盘 | 用vh固定回退+visualViewport实测；105目标不保证dvh原生支持，需看真实生成CSS；模型选择仍需弹层/滚动/键盘观察 |

## 最小矩阵（每格都独立记录，未跑不写PASS）

| Android/API | WebView/provider | 最小用例 | 当前证据 |
| --- | --- | --- | --- |
| Node vm fixture / 无设备 | 每项能力独立删去 | 正常能力、Object.hasOwn缺失、各必需API缺失、启动错误提示、main保护 | 可执行：`node --test tests/unit/legacy-capabilities.test.mjs`；只证明控制流 |
| Android7/API24 | OEM实际可安装旧provider/准确包版本 | 首屏和可读失败；安装门槛不替代WebView检查 | 未测；先核实Capacitor8真实支持的provider版本 |
| Android10/API29 | WebView92（若设备支持固定） | 首屏预期明确缺Object.hasOwn，绝不宣称全功能 | 未测；本轮仅VM缺失模拟 |
| Android10+/API29+ | WebView105固定包版本 | 固定commit标准/内测产物，首屏、模型、导入、发送、更新、反馈、长文复制 | 未测；三处Array修复后仍需原始内核实测 |
| 当前可用Android | 当前provider完整版本 | 相同用例作为对照 | 本轮未跑，复用owner已有证据时必须标注commit/产物 |

## 低资源后续顺序

1. 日志发布先行。借一台闲置实体机，读取 `adb shell getprop ro.build.version.sdk` 与 `adb shell dumpsys webviewupdate`；记录 WebView provider/version、App commit/versionCode、origin、安全上下文；不在共享机安装旧浏览器或启动AVD。
2. 由发布owner给固定commit的现有APK/私有dist及哈希。单设备串行执行矩阵；先首屏提示，再本地fixture导入→模型mock→聊天SSE mock→取消/断流→更新bridge mock→反馈离线导出→长文复制；禁止把“WebView105 UA伪装”算真105。
3. 保留截图、console首错、网络/离线日志、provider版本；真实105稳定后再评估92是否值得降目标/补运行时兼容。需要重build或额外设备资源时先告知；本轮零build。
