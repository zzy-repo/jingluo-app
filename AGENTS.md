# AGENTS.md

本文件给所有参与本仓库的智能体与协作者看。**动手前先读规范正文。**

## 必读

- Issue 规范：[`docs/ISSUE-STANDARD.md`](docs/ISSUE-STANDARD.md)
- 协作流程（认领 / 分支 / 验收）：[`docs/CONTRIBUTING-ISSUES.md`](https://github.com/zzy-repo/deepseek-app/blob/test/429-error-mapping/docs/CONTRIBUTING-ISSUES.md)

## 三条硬规则

1. **任务只认 GitHub Issue。** 聊天里的口头计划不算任务；开工前把 Issue 状态改成 `status:in-progress`，完成后按该 Issue 的关闭条件关闭。
2. **一次只做一件事。** 一条 Issue 最多 5 项必做内容；发现问题另开 Issue 或记入 follow-up backlog，不在原单堆积。
3. **不许伪造完成。** 必须给修复前失败证据、回归真实输出、UI 截图（390 / 360）、未测边界。模拟结果不得写成真机通过。

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
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890

# 一次性写法（不常驻环境变量）
timeout 120 env https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 \
  git fetch origin --prune
timeout 120 env https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 \
  git push --force-with-lease=<branch>:<old-sha> origin <branch>

# 不依赖本地 ref 缓存的复核（推完必查）
timeout 60 env https_proxy=http://127.0.0.1:7890 git ls-remote --heads origin <branch>
# socks5 亦可：-x socks5h://127.0.0.1:7890，或 ALL_PROXY=socks5h://127.0.0.1:7890
```

磁盘卫生（清 `node_modules` 不删 worktree）见
[`docs/RELEASE-MANUAL.md`](docs/RELEASE-MANUAL.md) 第 10 节第 6 条。

## 禁止

- 提交真实 API Key、管理 Token、签名下载链接
- 把用户反馈原始日志 / 联系方式写进 Issue
- 直接 push `main`（发布走 release 分支）
- 同时跑多台模拟器；重构建串行（内存有限）
- `git add -A` 提交无关改动
