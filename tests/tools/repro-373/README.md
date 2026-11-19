# Issue #373 复现工具（只用于复现，不是产品代码）

「更新下载到 100% 后按钮仍是『确认下载』」的 L1 复现。跑法（仓库根目录，Node 22 + playwright chromium）：

```bash
node tests/tools/repro-373.mjs              # 构建 harness 并跑 7 条场景（约 30s）
SKIP_BUILD=1 node tests/tools/repro-373.mjs # 复用 tests/tools/repro-373/out
```

- 失败即复现：脚本按 Issue #373 的「期望行为」断言，main 上应为 B/B2/D/E/F 红。
- `result.json` 是本次运行的原始证据（按钮文案 / 进度 / 状态行 / 原生调用序），`shots/*.png` 是对应截图。

## 为什么放在 `tests/tools/` 而不是 `tests/integration/`

按 `tests/README.md` 的约定「测试脚本不编译、复用已有产物」，而这里要跑的是**只有 APK 才进入的分支**
（`isAndroidUpdate()` → `nativeUpdate.*`），必须换掉原生桥并单独构建一份 harness；
这份 harness 不属于任何发布产物，所以按「手工用的一次性脚本」归档在这里。

## 结构

| 文件 | 作用 |
| --- | --- |
| `../repro-373.mjs` | driver：构建 + 静态服务 + Playwright 逐条场景驱动与断言 |
| `repro-373/harness.tsx` | 挂载**真实** `src/components/settings/AppUpdateField.tsx` |
| `repro-373/capacitor-mock.ts` | 通过 rspack alias 顶掉 `@capacitor/core`，桥行为由页面 `window.__bridge` 编排 |
| `repro-373/rspack.repro.config.ts` | 只构建上面这个 harness（swc + CSS Modules + Define，与主配置同口径） |
| `repro-373/fix-proposal.md` | 最小修复方案（**未应用到产品代码**） |
| `repro-373/verified-fix.diff` | 按 `fix-proposal.md` 打完补丁后，7 条场景全绿的实测 diff |

被测代码是 `origin/main@f182748` 的真实组件与真实 `downloadUpdate()`；被替换的只有原生 `AppUpdate` 插件
（`installed` / `manifest` / `download` / `cancel` / `install` / `addListener`），
进度事件按 `AppUpdatePlugin.java` 的真实顺序发（含 `received === size` 的那一帧早于 `verify()`）。
