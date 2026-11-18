# Issue 标准（统一规范）

本仓库所有任务以 GitHub Issue 为唯一任务源。本文件是规范正文，`AGENTS.md` 指向这里。

术语对照（都是公开的成熟实践，不是自创）：

| 本仓库做法 | 正规名称 | 出处 |
| --- | --- | --- |
| 每条 Issue 写"关闭条件" | Acceptance Criteria（单条）＋ Definition of Done（团队级） | Scrum / 敏捷 |
| 创建时就写清、之后只删不加 | Definition of Ready（DoR） | Scrum 社区 |
| 一条 Issue 只做一件事、最多 5 项 | INVEST（Independent / Negotiable / Valuable / Estimable / Small / Testable） | Bill Wake |
| 一个问题裂成多条 | Story Splitting（SPIDR） | Richard Lawrence |
| "先查清楚再修"的调查单 | Spike（时间盒，产出结论不产出功能） | XP |
| 衍生问题先入池 | Follow-up backlog ＋ Bug Triage | 团队惯例 |
| 状态用标签，进度看 Milestone | Labels as state machine ＋ GitHub Milestones | GitHub 推荐用法 |
| 同时开工数量受限 | WIP Limit | Kanban |

## 一、Issue 类型与关闭条件

每条 Issue 创建时必须选一种类型，并只按该类型的条件关闭。

| 类型 | 关闭条件 |
| --- | --- |
| 实现 | 有 commit ＋ 有可验证证据（测试输出或截图）＋ 未测边界写清 |
| 修复 | 修复前失败证据 ＋ 修复后同路径回归证据 |
| 发布 | 双端下载 ＋ 签名/版本/manifest 校验通过 |
| Spike（调查） | 给出结论，结论可以是"不可复现" |
| 验证 | 在有条件的设备上跑完，或明确该环境不可得 |

硬性规定：

- 实现单不等待真机验证、不等待发布。
- 真机验证归验证单，构建发布归发布单，不混用。
- 允许"带边界关闭"：未验证项写在 Issue 里，不阻塞关闭。

## 二、必填结构

```markdown
# 现象 / 目标

# 关闭条件（创建时确定，之后只删不加）
- [ ] ...
- [ ] ...

# 证据
修复前：<失败输出或截图>
修复后：<命令 + 真实输出>

# 边界（不阻塞关闭）
- 未测：...

# 关联
父/子 Issue、commit、分支
```

## 三、拆分规则

1. 一条 Issue 的必做项最多 5 条，第 6 条起转 follow-up。
2. 一个操作引出多个问题，拆成多个 Issue，不在原单堆。
3. 衍生问题默认不建单，记入 follow-up backlog 汇总 Issue（标签 `follow-up`）。
4. 只有被排进某个 Milestone 时，才把 backlog 条目升级为独立 Issue。
5. 不许中途加码：要扩大范围就另开 Issue。

## 四、状态标签

| 标签 | 含义 |
| --- | --- |
| `status:todo` | 已确认，排队中 |
| `status:in-progress` | 正在做（受 WIP 限制，同时不超过 4 条） |
| `status:blocked` | 缺外部条件，必须写恢复动作 |
| `status:review` | 实现完成，等待验收 |
| `status:done` | 关闭前打，随即关闭 |
| `status:paused` | 主动暂停，保留恢复动作 |

一次只能有一个状态标签。

## 五、进度可见

- 每个版本建一个 Milestone（如 `beta.8`），Issue 归属其中。
- 关闭即计入进度，Milestone 百分比就是真实完成度。
- 每周清一次 `follow-up` backlog：排期、降级或 `wontfix`。

## 六、验收与禁止事项

完成必须包含：

- commit（含 changed paths）
- 修复前失败证据
- 回归命令与真实输出（不许只写"测试通过"）
- UI 改动附 390 / 360 截图，并由维护者实际查看
- 未测边界
- 隐私检查：无 API Key、无完整带凭据 URL、无聊天/支付正文

禁止：

- 提交真实 API Key、管理 Token、签名下载链接
- 把用户反馈原始日志与联系方式写进 Issue
- 用模拟结果冒充真机通过
- 同时启动多台模拟器；重构建串行
- `git add -A` 提交无关改动
