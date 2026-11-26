# dist/2.0.1 —— 预构建 Web 产物（给有 Xcode 的人做原生壳）

这个分支不是代码分支，**不要合并进 main**：`dist/` 在 `.gitignore` 里，
每次 `pnpm build` 都会把它改脏，而且 `dist/static/js/main.*.js` 超过 `check:hygiene` 的
512 KiB 文本阈值（台账 §2.1）。放在这里只是为了「有人要立刻构建原生壳，不必先在本机跑通 Web 构建」。

## 里面是什么

| | |
| --- | --- |
| 源提交 | `6322eeb132f771561aa0631ea6996590a47c8fe4`（main） |
| 版本 | `2.0.1` |
| 变体 | `standard`（公开口径，非 internal / staging） |
| 构建命令 | `pnpm build`（node 22.22.1，rspack `2.0.2`） |
| 产物 | `dist/`，8.3 MB，入口 `dist/static/js/main.8914ba53.js` |
| 端点 | consume / pay 均为 `https://apia.ecsafe.cn` |
| 构建时间 | 2026-11-26T08:33:07Z |

产物自带的 `dist/build-info.json` 是权威信息（版本/hash/端点/构建时间都在里面）。

## 怎么用

已有仓库（推荐，能同时拿到 `ios/` 工程与全部脚本）：

```bash
git fetch origin dist/2.0.1
git checkout origin/dist/2.0.1 -- dist          # 只取产物，不动当前分支
pnpm install                                     # 需要 @capacitor/cli
pnpm exec cap sync ios                           # dist → ios/App/App/public + 重写 Package.swift
open ios/App/App.xcodeproj                       # 用 Xcode 跑
```

或者整分支拉下来：`git clone --branch dist/2.0.1 <repo>`。

改完 Web 代码要重新出包时，别手改 `dist/`：在 main 上 `pnpm build` 再重新推这个分支。

## 已知口径（别当成「可以公开发布」）

- `pnpm run check:public-artifact-redaction -- --dist dist` 在这份产物上 exit 1：
  3 处**旧池**地址（`123.207.199.196` / `62.106.70.167` 各 2 次，来自
  `config/endpoints.json` 的 `legacyHosts` 拒绝表；\+ 内网端口 443 的端口表）。
  门禁自己的分类里这两类都是「只用于拒绝、没有调用方」，但**公开发布前必须按门禁口径逐条裁决**。
- `check:legacy` / `check:bundle-target` / `check:syntax-floor` / `check:webroot-hygiene` /
  `check:artifact-prefix` 在这份产物上全绿。
