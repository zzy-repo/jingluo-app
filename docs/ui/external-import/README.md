# `docs/ui/external-import` —— 外部应用文件导入在**网页端零行为变化**的取证

**口径**：Playwright Chromium（headless）浏览器视口截图，**不是真机**，也**不是** Android 外部导入
本身的截图 —— 那个能力在网页端不存在（浏览器没有「外部应用把文件推给某个网页」的系统级入口，
见 [`docs/capability-matrix.md`](../../capability-matrix.md)「外部应用文件导入」那一行：
Web ❌不可用 / iOS ❓未实现 / Android ✅可用但只做到静态验证）。所以本目录要证的**恰恰是
「加了 Android 外部导入之后，网页端看起来一个像素都没变」**。

| 文件 | 记录的功能 / 状态 | 代码位置（当前 HEAD） | 角色 & 这一帧证明什么 |
| --- | --- | --- | --- |
| `web-360-baseline.png` | 首页新对话屏（未接入外部导入时的基线） | 能力判据 `isExternalImportSupported()` = `Capacitor.getPlatform() === 'android'`（`src/services/externalImport.ts:116`）；首页 `src/app/App.tsx` | **改前**：360×740 下标题 / 模式切换 / 输入区 / 底部免责声明（基线帧） |
| `web-360-current.png` | 同一屏（接入 `externalImport.ts` 与 `ExternalFile` 插件之后） | 同上 | **改后**：与 baseline 逐字节相同 → 「网页端无 external-import 痕迹」。sha `cfc1e984…` |
| `web-390-baseline.png` | 同上（390 档基线） | 同上 | **改前**：390×844 基线帧 |
| `web-390-current.png` | 同上（390 档改后） | 同上 | **改后**：与 390 baseline 逐字节相同。sha `982ca7b5…` |

判据在同目录的 [`web-regression.json`](./web-regression.json)：两个视口都是
`pixelsIdentical: true`、`sha256.current === sha256.baseline`、`sameText: true`、`sameControls: true`、
`controlCount` 10 → 10、`consoleErrors: []`、`pageErrors: []`，结论「网页端无 external-import 痕迹」。
两档可见文本摘录都是「今天有什么可以帮到你？ 快速模式 专家模式 深度思考 智能搜索 内容由 AI 生成，请仔细甄别」。

## 有意保留：baseline 与 current 逐字节相同

`web-360-current.png` 与 `web-360-baseline.png`、`web-390-current.png` 与 `web-390-baseline.png`
是**同 blob**（两对，共 110 737 B 冗余）。这**不是**「别名副本」，而是**结论本身**：
「改前改后像素一致」这句话要两侧同时在才能成立 —— 删掉任一 `-current`，
`web-regression.json` 里的 `sha256.current` 就失去对照物，那条结论的取证链就断了。

> **请勿当垃圾删除。** 这份冗余是取证成本。复核方式：
>
> ```bash
> sha256sum docs/ui/external-import/web-{360,390}-{baseline,current}.png
> ```

来源：`83956bf6 feat(android): 外部应用文件导入（WPS/微信/QQ/文件管理器的打开方式与分享）`。
