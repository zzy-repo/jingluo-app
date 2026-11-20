# Issue #373 证据：下载 / 校验失败不再残留满格进度

用例：`tests/integration/update-stuck-button-373.test.mjs`（自建 harness，把原生 `AppUpdate` 桥换成 mock，
组件与 `downloadUpdate()` 都是产品代码）。截图与原始探针数据都由用例自己写在这里。

跑法（仓库根目录）：

```bash
node tests/integration/update-stuck-button-373.test.mjs                          # 修复后取证（写 after-*）
UPDATE_SHOT_PREFIX=before node tests/integration/update-stuck-button-373.test.mjs # 修复前取证（写 before-*）
```

## 前后对照（同一条用例、同一份 mock 剧本）

| 文件 | 场景 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `*-A-390x844.png` | A 正常完成 | 按钮「安装更新」+ 满格进度（正确） | 不变 |
| `*-B-390x844.png` | B 校验失败 `HASH_MISMATCH` | **满格 5.2 MB / 5.2 MB + 按钮「确认下载」**（就是本单附图） | 进度条清空，按钮「确认下载」，文案点出 SHA-256 |
| `*-B-360x740.png` | 同上，窄屏 | 同上 | 同上 |
| `*-B2-390x844.png` | B2 安装阶段 `VERSION_MISMATCH` | 满格 + 确认下载 | 进度条清空，文案点出「版本号」而不是「大小或 SHA-256 不符」 |
| `*-D-390x844.png` | D 下载中取消 | 进度停在 4.9 MB / 5.2 MB | 进度条清空 + 「已取消下载」 |
| `*-E-390x844.png` | E 同一 tick 连点两次 | 向原生下发 **2 次** `download`（第 2 次被 BUSY 拒） | 只下发 1 次 |
| `*-result.json` | 原始探针（按钮文案 / 进度值 / 原生调用序 / 页面异常） | 5 条断言红 | 6 条断言全绿 |

修复前跑法下的红：`A` 绿、`B` / `B2` / `D` / `E` 红（退出码 1），与 #373 的附图一致。

## 未覆盖

- 真机 Android 上的 installer / `PackageManager` 行为（本用例只到 JS 侧状态机）。
- 原生侧「把 100% 那一帧挪到 `verify()` 之后」这项改动不在本单范围内（`AppUpdatePlugin.java` 未改，另开单）。
- 英文界面截图：本用例只断言 zh 侧的与语言无关的状态与文案关键词；文案双语对由
  `tests/unit/update-failure.test.mjs` 钉住。
