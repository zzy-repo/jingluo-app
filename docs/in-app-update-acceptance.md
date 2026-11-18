# Android 检查更新：实现与有界验收

## 契约与行为

- 固定公开 HTTPS 清单 `https://dl.rose7.cn/releases.json`，不使用发布/日志 token；原生桥固定清单 URL 和 APK host，禁止重定向。
- `file` 必须是 `apk/NAME.apk` 相对路径，不接受绝对 URL、协议相对、目录穿越、查询参数。`latest` 不参与推荐。
- `artifactVariant=internal|standard` 与 `buildType=stable|prerelease` 分开。仅同变体、严格更大 versionCode、有效小写 SHA256、已知 buildType 可推荐；预发布选项包含稳定版。旧记录无 variant/hash/buildType 可读取，不猜测、不回退 MD5。
- APK marker `com.example.deepseekchat.ARTIFACT_VARIANT`。Gradle `-PartifactVariant=internal|standard`，与存在的 `INTERNAL_BUILD` 冲突即失败。
- 用户确认后原生流式下载，实际字节进度、主动断开取消、私有 cache 临时文件；安装前再次核大小、SHA256、包名、code、当前签名集合及 marker。缓存复用重新校验。
- 使用既有 FileProvider content URI、临时读授权打开系统安装器；未知来源权限往返后仍需再次点安装，绝不自动安装、卸载或清库。Web 仅下载链接。

## 已执行（2026-11-18，独立 worktree）

1. `node --experimental-strip-types --test tests/unit/app-update.test.mjs`：8/8；覆盖新旧 code、变体、渠道、旧/非法摘要字段、异常清单、路径约束、匿名请求、取消与迟到事件、缓存响应及校验错误 mock。
2. `tsc -p tsconfig.json`、更新文件 focused oxlint、`git diff --check` 均通过。
3. 内测网页 production build、Capacitor sync、Android assembleDebug --offline 成功。
4. 专用 AVD test34/emulator-5554：先将线上 beta.4/code11 同签 `adb install -r` 为隔离 code12。真实清单检查显示无更新；发现旧记录缺 buildType 并修复兼容。
5. 仅 CDP 调试上下文注入 code13 清单（没有生产配置入口、没有改线上 releases.json/tag）。设置弹窗显示版本/changes/5.9MB 后点击确认，真实 HTTPS 下载托管 fixture，进度 3719→6226840 字节，校验成功并缓存。
6. 真实未知来源权限：未允许返回、允许后返回；再次点击才打开系统安装器。系统安装取消可再次打开。点击系统 Update 后显示 App installed，重启原生读到 code13/internal。
7. 覆盖前后 localStorage 合成标记 `preserved-code12` 保留；IndexedDB 数据库 chat-demo v12、chat-diagnostics v1 仍存在。**这证明合成标记和数据库存在性，不等价于已逐条核验真实会话内容/附件。**未读取真实聊天/API Key，未卸载或清数据。
8. 手机 WebView 360/390/412 CSS px：更新弹窗不越视口、页面无横向溢出。真实已装 code13 再提交 code13 下载请求返回 VERSION_MISMATCH。

## 证据与边界

原始轻量证据保存在实施 worktree `.update-evidence/`（不提交 APK、keystore 或诊断原始信息）：device-no-update.json、device-update-confirm.png、device-download.json、permission-denied-return.json、permission-granted-return.json、installer-confirm.xml、installer-result.xml、data-before.json、data-after.json、mobile-360/390/412.json、native-low-code.json。

真实下载/权限/安装取消/系统覆盖已执行；**下载中途取消、缓存复用、异包/异签/损坏缓存、网络中断目前为 mock+源码分支覆盖，未逐项设备实测。** code12/13 为隔离 fixture，正式源码版本恢复 beta.4/code11，版本提升交发布流程。已装证书 SHA256 e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1；本次未修既有 keystore 路径，避免更换线上证书。fixture CDN 文件由发布协调者清理并核404。
