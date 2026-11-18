# 红队 / 对抗用例（Issue #143 · D 类）

这里放的不是 happy path，而是**主动构造的破坏性输入**：畸形归档、超大规模的归档与会话、弱网 / 时钟异常 / 离线、以及「这一版 WebView 到底会不会炸」的语法与 API 探针。目的只有一个：让旧 WebView 和弱环境里的兼容性缺陷现形。

**所有结论都是静态推断 / 单元级模拟，没有模拟器、没有真机**。任何一条都不能写成「真机通过」。

## 和其它测试目录的关系

- `tests/run-layer.mjs` 只收集 `LAYERS = ['unit', 'integration', 'e2e', 'device']`，**不会**碰 `tests/adversarial/`，所以这里的任何红都不会污染基线。
- 用例里有一条断言刻意保持红色（真产品缺陷）时，用 `baseline.json` 标注，由运行器区分「已知缺陷」与「新回归」。

## 怎么跑

```bash
# 全部（推荐；会读 baseline.json 判定 PASS / KNOWN-DEFECT / REGRESSION）
node tests/adversarial/run-adversarial.mjs

# 只跑一个桶（a / b / c / d）
node tests/adversarial/run-adversarial.mjs --only a

# 单独跑一条（排查时用；退出码 0 = 全部符合期望，1 = 有断言没被满足）
node tests/adversarial/cases/a3-duplicate.mjs; echo exit=$?

# 机器可读
node tests/adversarial/run-adversarial.mjs --json
```

> 看退出码时不要接 `| tail`——管道会把真实退出码吃掉。要么直接 `; echo exit=$?`，要么看输出末尾的 `[a3] n/m 项符合期望`。

用例里的每个 `check` 都写成三种信息：**构造方式**（这个畸形输入长什么样）、**期望**（依据 `docs/ISSUE-STANDARD.md` 或产品语义，不臆造）、**实际**（真实跑出来的错误 key / 数值 / 耗时）。

## 目录

```
tests/adversarial/
  cases/                 # 16 条用例（a1–a8 / b1–b3 / c1–c3 / d1）
  lib/zip.mjs            # 手写 ZIP 写入器：能造截断、重复条目、撒谎尺寸、路径穿越……
  lib/harness.mjs        # 导入链路的桩：errors.js / db.js 用 data URL 模块顶掉，其余走真实源码
  lib/url-harness.mjs    # URL 导入链路的桩：@capacitor/core 与诊断收集器换成可控实现
  baseline.json          # 每条用例的构造方式 / 期望 / 实际 / 判定（green | known-defect）
  run-adversarial.mjs    # 运行器
```

## 桶与用例

| 桶 | 编号 | 打的是什么 |
| --- | --- | --- |
| A 畸形归档（导入路径） | a1 | 截断的 ZIP、声明尺寸撒谎 |
| | a2 | 条目顺序异常（index 在会话之前、交错） |
| | a3 | 重复条目名 |
| | a4 | 路径穿越、绝对路径、反斜杠、空名 |
| | a5 | 超长文件名、BOM 前缀名、UTF-16 体 |
| | a6 | 空 ZIP、只有目录项、只有 manifest |
| | a7 | ZIP 炸弹（1004:1）、解压尺寸写成 4GB |
| | a8 | manifest 字段类型错误 / 缺失 / 0 字节 / 版本越界 |
| B 巨大输入 | b1 | 单条 10MB 消息 + 100 万字符单行 |
| | b2 | 2000 轮历史、4000 行虚拟列表、500 会话索引、重复 id |
| | b3 | 10 万 emoji / 10 万组合字符 |
| C 极端环境 | c1 | 滴流下载（一直有进展但很慢） |
| | c2 | 系统时间前跳 / 回拨 |
| | c3 | 离线、不可用端口、通用 fetch 失败 |
| D 语法/API 探针 | d1 | `scripts/compat/probe.mjs`：哪一版 WebView 会出问题 |

## 探针（D 类主角）

`scripts/compat/probe.mjs` 不是「检查产物语法」（那是 `scripts/check-bundle-syntax.mjs`），它回答的是**给定一份特性清单，目标 WebView 版本上哪些能力缺失、最低要到哪一版**，因此可被其它 lane 复用。

```bash
node scripts/compat/probe.mjs --target chromium83           # 人读报告
node scripts/compat/probe.mjs --target all                  # 79 / 83 / 91 / 109 一起看
node scripts/compat/probe.mjs --target chromium83 --json     # 机器可读（stdout 只有 JSON）
node scripts/compat/probe.mjs --target chromium83 --scan src # 定位源码里的使用点 + 冲突项
node scripts/compat/probe.mjs --list                         # 46 条特性及其最低版本
```

退出码：`0` 该版本全部可用 / `1` 存在不可用特性 / `2` 用法错误。每条特性的最低版本都附了依据（MDN / caniuse），结论一律标 `静态推断`。

> stderr 里可能出现 node 自身的 `ExperimentalWarning`（代理环境），不属于探针输出；`--json` 的 stdout 是纯 JSON。

## 只想看缺陷

看 `baseline.json` 里 `verdict: "known-defect"` 的四条（a2 / a3 / c1 / c2 / c3）：它们的红色断言就是真产品缺陷，附了严重度与影响面。**不要为了让它们变绿去改断言或改产品代码**——确认缺陷被修之后再更新 baseline。
