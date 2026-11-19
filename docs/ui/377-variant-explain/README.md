# #377 内测变体用户「看不到 1.4.1」→ 文案说清原因

## 场景（与 #377 正文一致）

- 本机：`1.4.0-beta.10`（code 17，`artifactVariant=internal`），渠道「稳定版与预发布版」
- 清单：更高的版本只有 `1.4.1`（code 20，`buildType=stable`，`artifactVariant=standard`）——
  **没有** internal 包，即「变体矩阵断链」
- 清单由 playwright `route` 拦截两台分发机的 `releases.json` 返回同一份 fixture，
  不读也不改线上清单（fixture 见 `result.json`）

## 修复前 / 修复后

| 视口 | 修复前 | 修复后 |
| --- | --- | --- |
| 390x844 | `before-internal-390x844.png`：**已是最新，该渠道没有更高的版本** | `after-internal-390x844.png`：说清「本机是内测包、清单里只有正式包」，请手动下载正式版 |
| 360x740 | `before-internal-360x740.png`：同上 | `after-internal-360x740.png`：同上（弹窗不越视口、按钮在视口内） |

「已是最新」在修复前是**假话**：清单里确实有更高的 1.4.1，只是它没有 internal 变体。
本单不放开跨变体候选（原生 `verify()` 的 `VARIANT_MISMATCH` 仍拦截），只把结论说成事实。

## 复现方法

```bash
INTERNAL_BUILD=1 DIST_OUT=dist node scripts/build.mjs --internal   # 内测产物
# 起静态服务 + playwright，route 掉 http://62.106.70.167:8888/releases.json
# 与 https://dl.rose7.cn/releases.json，返回 result.json 里的 fixture
# 打开 设置 → 应用更新 → 检查更新，截图 390x844 / 360x740
```

驱动的具体步骤与被替换的产物见 `result.json` 的 `method` 字段。
