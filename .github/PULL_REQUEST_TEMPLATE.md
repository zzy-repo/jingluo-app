<!-- 追踪单/母单请用 Refs #N；不要写 Closes #N（哪怕是"Closes #N? 不"这种否定句，也会被自动匹配） -->

> [!IMPORTANT]
> **不要用 closing keyword 关追踪单。** 目标是 `[TRACK]` / `[追踪]` 母单时，
> 正文只写 `Refs #N`，**绝不写** `Closes / Fixes / Resolves #N`（含 `Closes: #N`、大写）。
> GitHub 的解析器**只看字符串不看语义**：`Closes #N? 不——母单保持开启` 这句否定句照样
> 会把 #N 关掉（#362 事故：squash 合并后 1 秒被自动关闭，而阶段二只完成 2/5）。
> 引用本 PR 时请用 `Refs #N`；举例说明规则时用 `Closes #N`（`N` 不是数字，构不成引用）。
> 完整规则见 [`AGENTS.md`](../AGENTS.md) 「Issue 关闭纪律」。

## 做了什么

<!-- 一两句话说清改动与动机 -->

## 关联 issue

<!-- 子单/普通 issue：Closes #N 可以（合并后核对状态）；追踪单：只写 Refs #N -->

- Refs #

## 验证

<!-- 真实输出，别只写"测试通过" -->

```
$ 
```

## 边界（不阻塞合并）

- 未测：

## 自查

- [ ] 追踪单（`[TRACK]` / `[追踪]`）只用了 `Refs #N`，正文里**没有** `Closes / Fixes / Resolves #N`
- [ ] 正文里没有"否定形式的 closing keyword"（`Closes #N? 不` 这类也会被匹配）
- [ ] 若本 PR 会关闭普通 issue：合并后逐条核对 `gh issue view <n> --json state,title,closedAt`
- [ ] 无真实 API Key / 管理 Token / 签名下载链接 / 用户原始日志
- [ ] 文档改动带 `文件:行号` 引用时用函数名/常量名定位，不靠裸行号
