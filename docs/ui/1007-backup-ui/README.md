# Issue #1007 取证：备份界面的两条「看起来丢数据 / 说旧话」缺陷

**口径（与 `docs/ui/README.md` 一致）**：下列全部是 **Playwright Chromium（headless）浏览器视口截图
（deviceScaleFactor = 2，390 × 844 与 360 × 740）**，**不是真机截图**，不能替代 adb 取证。
「未测」= 没跑过，不是通过。

**被测产物**：本仓 `main` = `b08fc635` 的两种构建 ——
- `before/` 段：`b08fc635` 原样构建（**修复前**）；
- `390/` `360/` 段：同一基线 + 本单修复（`fix/backup-ui`）。

## 为什么要在页面里装桩

备份读写的是**原生私有目录**，纯浏览器里 `isBackupStorageAvailable()` 恒为 false，设置页只会显示
「当前环境不支持备份到本机存储」——按真实浏览器能力，这两条缺陷根本走不到。所以取证脚本在页面里
装了一套**内存文件系统 + `BackupFile` 桥**（`begin / writeChunk / finish / abort / list / readChunk /
hash / remove / freeBytes`，语义照抄 `BackupFilePlugin`：先写临时文件、`finish` 时对盘上字节重算
sha256、`freeBytes` 可拨），并只把「能力探测」这一个函数掰成原生。跑过的仍是**真实的备份 / 恢复代码
路径**（列清单、写清单、校验、安全备份、导入），只是文件落在内存里。

## 结论一：盘上 7 份 → 列表只给 5 条，且没有入口（缺陷 1）

| 视口 | 修复前 | 修复后 |
|---|---|---|
| 390 | `before/390/a2-list-default-5.png`：占空间一格「56 MB（共 7 份）」，恢复列表 **5 条**，没有「还有 N 份」入口 → `before/390/a3-no-entry.png` 仍是 5 条，**多出来的 2 份在界面上不可达** | `390/a1-seven-on-disk.png`（共 7 份）→ `390/a2-list-default-5.png`（默认 5 条 + 「还有 2 份」）→ `390/a3-list-expanded-7.png`（点开后 **7 条全在**） |
| 360 | `before/360/a2-list-default-5.png` / `before/360/a3-no-entry.png`：同上 | `360/a1-seven-on-disk.png` / `360/a2-list-default-5.png` / `360/a3-list-expanded-7.png` |

量到的数字（同名 `.json` 里）：修复前 `restoreItems = 5`、`hasMore = null`；修复后默认
`restoreItems = 5` + `hasMore = "还有 2 份"`，展开后 `restoreItems = 7`。**「共 7 份」两次都是 7** ——
真实份数一个字节没改，改的只是「露几条 / 差额说不说」。

## 结论二：低空间失败提示与「已恢复完成」并存（缺陷 2）

同一条流程，两边都真跑：① 空间充足时手动备份一次（拿到一份可恢复的档案）→ ② 把剩余空间拨到
200 KB，点「立即备份」→ 失败，「存储空间不足，暂时无法备份」→ ③ 空间恢复，恢复那一份 → 成功。

| 视口 | 修复前 | 修复后 |
|---|---|---|
| 390 | `before/390/b1-space-failure.png`（存储空间不足）→ `before/390/b2-after-restore-no-stale.png`：状态行 **「存储空间不足，暂时无法备份」+「已恢复完成」两条并存**，`stale = true` | `390/b1-space-failure.png`（同一句失败照报）→ `390/b2-after-restore-no-stale.png`：状态行 **「一切正常」+「已恢复完成」**，`stale = false` |
| 360 | `before/360/b1-space-failure.png` / `before/360/b2-after-restore-no-stale.png`（同样并存） | `360/b1-space-failure.png` / `360/b2-after-restore-no-stale.png` |

「恢复之后盘上仍是 `space`」这件事**没有被粉饰**：占空间一格在两次截图里都照实写着
「设备剩余空间不足，可能无法完成备份」——收声的只有「上一次操作失败」这句旧话（判据见
`backupView.ts` 的 `failureIsStale`：失败之后**真的成功过**才算旧话，成功发生在失败之前不算）。

## 复现

```bash
node scripts/build.mjs                 # 出产物（默认 dist/，可用 DIST_OUT 改）
node docs/ui/1007-backup-ui/capture.mjs

# 修复前对照（另起一个基线 worktree 出产物，再让同一脚本只负责驱动界面）
DIST_OUT=<基线产物目录> SHOT_SUBDIR=before SHOT_EXPECT_FIX=0 \
  node docs/ui/1007-backup-ui/capture.mjs
```

每个场景 × 视口除了 `.png` 还写了同名 `.json`：`statusLine`（状态行原文）/ `spaceLine`（占空间一格原文）/
`restoreItems`（列表条数）/ `hasMore`（「还有 N 份」入口文案）/ `overflowX`（是否横向溢出，全部 false）。
