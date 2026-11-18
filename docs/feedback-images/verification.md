# 单图反馈适配验收

- 基线：已发布 `origin/main`，`1d08b2477ce75d8d245e3a42a635fcccaaef5cd1`（beta.4）。独立分支 `feat/feedback-images`，未混入 beta.5。
- 默认仍为 `LegacyTransport`；单张截图映射为 `images: [dataURL]`，无截图时维持原 body 形状。首次、web/native 降级重试均保留截图。
- 预算：整个 JSON.stringify(body) 的 UTF-8 字节数 ≤ 184320；包括中文、emoji、换行、引号、反斜杠和图片前缀。裁剪非关键日志；所有 error 与末次 import/chat/state_snapshot 保留，保护条目自身超限时报错而非静默丢失。
- 大图最多 6 档重编码（1280/0.72 至 320/0.3）；仅采用更小结果。解码/重编码失败或仍超限时提示 too_large，未发送超限请求、未删除截图。
- `node --test tests/unit/feedback-images.test.mjs`：6/6 通过；独立模块级 Capacitor mock，零真实网络、零浏览器/模拟器。
- `node tests/run-layer.mjs unit`：2 文件通过（新增6用例、原适配器28断言）；`tsc -p tsconfig.json`、改动文件 oxlint、`git diff --check` 均通过。
- 未做网页/APK重构建、设备测试或 UI 截图，避免争用更新/发布资源；附件 PNG 是人工生成的接口验收图片，不是 App 页面截图。
- 接收证据：[reception.json](./reception.json)，配图 [synthetic-blue.png](./synthetic-blue.png)：16×16 RGB PNG，zlib 编码且各 chunk CRC32 正确；已用图片工具解码确认。HTTP 200，`ok:true`，`images:1`，id `d64b8e8f-e392-47be-805f-b5fafb2ed5b7`，399 字节请求。仅证明服务接收数量，不证明落盘或后续可取回；未访问用户图片或管理接口。
- 初轮 native mock 曾因 Capacitor ESM/CJS 实例差异未生效，发送过一次仅含人工 1px PNG/fixture 日志的请求并返回成功；随后换为解析级全 mock，全部最终测试严格隔离。正式接收证据只采用上面的自生成 CRC 有效 PNG。
- 合并关注：`src/services/diagnostics/transport.legacy.ts`、`config.ts`、`shared.ts`、`src/i18n/{zh,en}.ts`；本次检查与 `release/beta5-prep`、`feat/in-app-update` 相对 origin/main 的改动路径无交集（仍应以合并当时分支为准）。
