# 本地复现报告（索引）

本目录收录 8 份本地复现报告，按 issue 分组，覆盖 #10–#50 区间内的 26 个 issue；文件名格式为 `g<组号>-issue-<编号列表>.md`，文件名中的编号即该报告覆盖的 issue。

| 报告 | 覆盖 issue |
| --- | --- |
| `g1-issue-38-34-24.md` | #38、#34、#24 |
| `g2-issue-40-49-50.md` | #40、#49、#50 |
| `g3-issue-32-14-18.md` | #32、#14、#18 |
| `g4-issue-13-39-10.md` | #13、#39、#10 |
| `g5-issue-30-31-28.md` | #30、#31、#28 |
| `g6-issue-45-46-25-44.md` | #45、#46、#25、#44 |
| `g7-issue-19-41.md` | #19、#41 |
| `g8-issue-37-35-36-43-22.md` | #37、#35、#36、#43、#22 |

结论均已同步到对应 issue 评论。

---

## 已删除的一次性复现装置（`repro/`，Issue #291）

`repro/` 下的 7 个脚本 + `before/`+`after/` 16 个产物已**整目录删除**：`git grep -n -I 'repro/' origin/main -- package.json README.md RELEASE.md CHANGELOG.md .github` 0 命中 —— 没有 npm script、CI 与发布流程引用它，复现步骤已经写在上面 g1–g8 各报告与对应 issue 评论里。**脚本原文在 git 历史里：`git show e130000c:repro/<名字>`（删除前的最后一个提交）。**

| 已删脚本 | 干什么 | 怎么跑 | 产出 / 结论落点 |
| --- | --- | --- | --- |
| `repro/render-crash.mjs` | #28 对照：把一条会话的标题写成对象 → React 渲染期必抛，比较「修复前整屏纯白」与「修复后可读错误页」 | `DIST_DIR=<包目录> OUT_DIR=<截图目录> node repro/render-crash.mjs` | `repro/before|after/render-crash.json` + 360/390 截图；结论见 #28、`docs/ui/1.4.0-error-boundary-*.png` |
| `repro/corrupt.mjs` | #28 补充：IndexedDB 半写入 / 数据损坏时主界面与会话表现（没有错误边界是否 = 全屏空白） | `DIST_DIR=… OUT_DIR=… node repro/corrupt.mjs`（默认 `http://127.0.0.1:5221`，`KEY=sk-repro-…` 打桩） | `corrupt-*.json`；结论见 #28 |
| `repro/quota-no-cny-shots.mjs` | #75：「额度与卡密」面板剩余额度只显示「N 积分」、无 ¥ 折算 | 另开终端 `pnpm dev`（8090）后 `node repro/quota-no-cny-shots.mjs` | 390/360 × zh/en 截图 + `text.json` → `docs/ui/quota-no-cny/`；结论见 #75 |
| `repro/settings-cell-shots.mjs` | 「反馈与日志」行窄视口实测（文本列宽、标题行数、动作区溢出），只读真实 Chromium 的 computed style / bounding box | `node repro/settings-cell-shots.mjs [outDir] [exePath]`（`APP_URL` 默认 `http://127.0.0.1:5419`） | metrics JSON + 截图 → `docs/ui/settings-cell-wrap/`（**#57 关单证据**） |
| `repro/settings-cell-mechanism.mjs` | 机制取证：同一台真实 Chromium 上逐个只改一个变量，判定 flex-basis / min-content / nowrap 哪一项在起作用 | `APP_URL=http://127.0.0.1:8090 node repro/settings-cell-mechanism.mjs [outJson]` | `mechanism-chromium156-360-en.json` → `docs/ui/settings-cell-wrap/` |
| `repro/webview91-measure.mjs` | 在真实老内核（compat31 / WebView 91.0.4472.114）上用 page 级 CDP 读 computed style + 截图（WebView 91 不支持 Playwright 的 `connectOverCDP`） | `node repro/webview91-measure.mjs <tag> <outDir> [locale]`（先跑 `repro/wv91.sh` 建 forward） | `before|after-wv91-*.json` + 360/390 × en/zh 截图 → `docs/ui/settings-cell-wrap/` |
| `repro/wv91.sh` | CDP 包装：按当前 webview pid 重建 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`，再 exec 指定测量脚本 | `bash repro/wv91.sh node repro/webview91-measure.mjs …` | 同上 |

**已知挂空引用（本批刻意不动）**：`docs/ui/settings-cell-wrap/README.md` 第 48 / 75 / 99 行仍写着 `repro/wv91.sh`、`repro/settings-cell-shots.mjs`、`repro/settings-cell-mechanism.mjs` —— 那份 README 是 #57 的关单记录，`docs/ui/**` 在 #291 里整目录不动（改它会动到关单证据）。要重跑按上表第 4–7 行执行；脚本原文用 `git show e130000c:repro/<名字>` 取。
