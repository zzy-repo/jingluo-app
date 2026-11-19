# AGENTS.md

本文件给所有参与本仓库的智能体与协作者看。**动手前先读规范正文。**

## 必读

- Issue 规范：[`docs/ISSUE-STANDARD.md`](docs/ISSUE-STANDARD.md)
- 协作流程（认领 / 分支 / 验收）：[`docs/CONTRIBUTING-ISSUES.md`](https://github.com/zzy-repo/deepseek-app/blob/test/429-error-mapping/docs/CONTRIBUTING-ISSUES.md)

## 三条硬规则

1. **任务只认 GitHub Issue。** 聊天里的口头计划不算任务；开工前把 Issue 状态改成 `status:in-progress`，完成后按该 Issue 的关闭条件关闭。
2. **一次只做一件事。** 一条 Issue 最多 5 项必做内容；发现问题另开 Issue 或记入 follow-up backlog，不在原单堆积。
3. **不许伪造完成。** 必须给修复前失败证据、回归真实输出、UI 截图（390 / 360）、未测边界。模拟结果不得写成真机通过。

## Issue 关闭纪律（closing keyword）

> **事故（2026-11-19，PR #389）**：正文第 49 行写了
> `Closes #362? 不——域 1+2 只是十域中的两域，母单 #362 保持开启。`
> 作者本意是**否定**，但 GitHub 的 closing keyword 解析器**只看字符串、不看语义**：
> squash 合并（14:44:51Z）后一秒（14:44:53Z）就把追踪单 #362 自动关了。而 #362 阶段二
> 实际只完成 2/5（A/E 完成，B/C/D 未完成）、L0 耗时目标未达成、6 个命名违规未改、
> 5 个 fixture 还在散放。16:09:06Z 才人工 reopen —— 那 1 小时 24 分里，这单对所有人
> 都是"看起来完成了"，剩余工作没有承接单。

规则：

1. **PR 正文禁止对追踪单用 closing keyword。** 目标是母单（标题带 `[TRACK]` / `[追踪]`
   的汇总单，如 #362 / #301 / #285 / #245 / #62）时，**只写 `Refs #N`**，
   不写 `Closes / Fixes / Resolves #N`（含 `Closes: #N`、大写的 `CLOSES #N`）。
2. **否定句一样会被匹配。** `Closes #362? 不` / `这个 PR 不 Closes #362` 都算数 ——
   关键词后面只要跟一个 `#数字` 就成立，问号、括号、"我是否定意思"一概不看。
   想表达"不关它"，**就别把那串字写出来**：写「母单 #362 保持开启」「Refs #362」即可。
   需要举例说明规则时，用 `Closes #N`（`N` 不是数字，构不成引用）。
3. **追踪单只允许人工关闭**，且必须在 checklist 全部 ✅ 之后，按下面的命令手动关。
   任何一个子项没完成就继续挂着，未完成项另开承接单。
4. **普通 issue 可以由 PR 自动关闭**，但**合并后必须核对被引用 issue 的状态**：
   `gh issue view <n> --json state,title,closedAt` 逐条确认；关错了立刻 reopen，
   并在该单评论里写清"被 PR 误关、剩余工作是什么"。
5. **合并前核对 CI 全绿，并且分清"是谁红的"。** `gh pr view <n> --json statusCheckRollup`；
   若红的是 main 上的既有问题、与你的改动无关，**先修 main，不要在红的基础上叠加 PR** ——
   PR 的 CI 跑的是 merge-ref（main + 你的分支），main 一红，所有在飞的 PR 都跟着红，
   最后谁也说不清是谁弄坏的。（实测：为 #362 落地本节的 #411 就被 #402 拖红 —— main 上
   `src/services/memory` 带 324 条 lint 错误，而 #402 是在自身 CI 已 FAILURE 时被合并的，见 #417。）

官方口径（GitHub docs: Linking a pull request to an issue）：关键词只有 9 个 ——
`close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved`；可带冒号、
不分大小写；引用形态有 `#10`、`owner/repo#100`、完整 issue URL 三种；只看 **PR 描述和
commit message**，且只在 PR 指向**默认分支**时生效。自动关闭发生在**合并那一刻**，
写错了改正文也救不回来（只能 reopen）。

```bash
# 合并后核对被引用的 issue 有没有被误关
gh issue view <n> --json state,title,closedAt
# 追踪单人工关闭（先确认 checklist 全 ✅）
gh issue edit <n> --remove-label status:in-progress --add-label status:done
gh issue close <n> --comment "checklist 全 ✅，阶段 X 完成；剩余：<无/已转 #M>"

# 合并前自查 PR 正文（可选脚本，见下）
node scripts/check-issue-close-keywords.mjs --pr <pr-number>
node scripts/check-issue-close-keywords.mjs --body-file pr-body.md --strict
```

静态检查状态：`scripts/check-issue-close-keywords.mjs` 能查出「正文 closing keyword 指向
`[TRACK]`/`[追踪]` 单」，**但目前没有进 CI**——接线要改 `.github/workflows/ci.yml`
（加 `pull-requests: read` 权限 + 一步 `--strict`），而落地这条规则的那次改动只覆盖文档与
模板。**在接线完成前，它只能手动跑：别把"脚本存在"当成"规则生效"。** 追踪：见
[`docs/ISSUE-STANDARD.md`](docs/ISSUE-STANDARD.md) 第七节。

## 常用命令

```bash
# 认领
gh issue comment <n> --body "/claim 分支 feat/xxx"
gh issue edit <n> --remove-label status:todo --add-label status:in-progress

# 查看当前可做
gh issue list --label status:todo

# 关闭（先打 done 标签）
gh issue edit <n> --remove-label status:review --add-label status:done
gh issue close <n>
```

### 网络：GitHub 必须走代理

本机直连 github 不通（`github.com` 被解析到 `57.155.223.240`；`git fetch` 报
`RPC failed; curl 28 ... port 443`，`git push` 报 `GnuTLS recv error (-110)`）。
**所有** fetch / push / ls-remote / gh 命令都要带代理，否则表现为超时或 TLS 中断：

```bash
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897

# 一次性写法（不常驻环境变量）
timeout 120 env https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  git fetch origin --prune
timeout 120 env https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  git push --force-with-lease=<branch>:<old-sha> origin <branch>

# 不依赖本地 ref 缓存的复核（推完必查）
timeout 60 env https_proxy=http://127.0.0.1:7897 git ls-remote --heads origin <branch>
# socks5 亦可：-x socks5h://127.0.0.1:7897，或 ALL_PROXY=socks5h://127.0.0.1:7897
```

磁盘卫生（清 `node_modules` 不删 worktree）见
[`docs/RELEASE-MANUAL.md`](docs/RELEASE-MANUAL.md) 第 10 节第 6 条。

## 禁止

- 提交真实 API Key、管理 Token、签名下载链接
- 把用户反馈原始日志 / 联系方式写进 Issue
- 直接 push `main`（发布走 release 分支）
- 同时跑多台模拟器；重构建串行（内存有限）
- `git add -A` 提交无关改动
