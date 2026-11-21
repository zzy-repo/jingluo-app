# 自建 GitHub Actions runner 落地方案（应对 Actions 计费停摆）

> **这份文档是什么**：一份**供 owner 决策**的方案。它给出三条出路的成本/风险对比，然后把「选项 C 自建 runner」写到可执行粒度（命令、systemd unit、`runs-on` 建议 diff、风险与清理）。
>
> **这份文档不是什么**：它**没有**改 `ci.yml`、**没有**改任何仓库设置、**没有**在任何机器上装任何东西。所有命令都是待执行的清单，所有 diff 都是**建议**（标了「不落地」）。
>
> 事实来源：#651 的 P0 报告（`main` CI 从 07:41 起 9/9 job 全 `failure`、`steps=0`、runner 名为空）。

---

## 0. 字母口径先对一遍（防串线）

本文件的字母口径：

| 字母 | 动作 |
| --- | --- |
| **A** | 修 Billing（补缴 / 提高 spending limit） |
| **B** | 仓库转回 public |
| **C** | 自建 self-hosted runner |

⚠️ **注意**：#651 里 07:52:57Z 那条 P0 评论末尾的表格，把 **A 写成「转回 public」、B 写成「提 spending limit」**（与本文件相反）。字母只在本文件内自洽——**跨人沟通时请说动作，不要只报字母**，否则「按 A 办」会办成两件完全不同的事。

---

## 1. 现状（为什么需要这份文档）

已核实的事实：

| 事实 | 值 | 怎么核的 |
| --- | --- | --- |
| 仓库可见性 | **private** | `gh api repos/zzy-repo/deepseek-app --jq .private` → `true` |
| 单次 run 的 job 数 | **9** | `checks` ×1 + `golden` ×1 + `integration` ×6（分片 1/6…6/6）+ `flaky-cross-runner` ×1 |
| 单次 run 的 runner-分钟 | **≈24** | 按 P0 报告的实测口径（9 job × 约 2.7 分钟均值） |
| 当日 run 次数 | **100+** | 见 #651 P0 报告 |
| 当日推算消耗 | **≈2400 runner-分钟/天** → 约 **72 000 分钟/月** | 上两行相乘。**注意：这是推算，不是账单读数**——查余额需要 `user` scope，我这边没有 |
| 失败形态 | `failure` / `runner=(空)` / `steps=0` / 2 秒结束 | run 44881951997 等 |
| GitHub 原话 | `The job was not started because recent account payments have failed or your spending limit needs to be increased.` | job annotation |

**关键判断**：`runner 空 + steps=0 + 2 秒` 意味着 **job 从未被任何 runner 领取**，一行代码都没跑。所以现在的「9/9 红」**不是代码红，是跑不了**——所有 PR 的 check 都会以同样方式红，**任何 PR 都无法合并**。

这条决定了一件重要的事：**这条路是「恢复」而不是「修 bug」**。改代码、改 `ci.yml` 语义、重跑，都不会让绿回来。

---

## 2. 三条路对比（现状 → 成本 → 恢复时间 → 风险）

| | **A 修 Billing** | **B 转回 public** | **C 自建 runner** |
| --- | --- | --- | --- |
| 具体动作 | Settings → Billing & plans：补缴欠款 / 提高 spending limit / 买 minutes | Settings → 改 visibility 回 public | 在自有机器装 `actions/runner`，把**轻活** job 的 `runs-on` 指过去 |
| 谁执行 | **只有 owner**（代理无 billing 权限） | **只有 owner**（可见性属仓库设置） | owner 给机器 + 一次装机；之后代理可维护文档 |
| 现金成本 | 有。且**按分钟持续烧**：按上表约 72 000 分钟/月的量级，免费额度（个人/团队档通常 3 000 分钟/月）根本不够 | **0** | 0 现金（机器已有）；成本是**运维时间** + 机器折旧 |
| 恢复时间 | **最快**，分钟级～小时级（付款成功即恢复；若走工单则看 GitHub 侧） | **最快**，分钟级（改完即恢复免费额度） | **最慢**：装机 + 注册 + 调 `runs-on` + 首次跑通，乐观半天到一天 |
| 主要风险 | ① 持续按分钟计费，**今天这种量级会反复触顶**；② 若欠款是账户级问题，可能连带其他仓库 | **代码全部公开**。本仓库含内部线索的历史包袱（见 #601 事故：正文带过 versionCode/dl 路径/裸 IP），公开会把这些一并暴露 | ① 需守住「**不许 Gradle 与 AVD 并行**」的既有约束；② 4 核机器跑重活会互相拖慢；③ 自建 runner 需要人长期维护（升级、清理、掉线） |
| 对「能否合并 PR」的效果 | 立刻解除 | 立刻解除 | **只能解决一部分**：轻活绿了，重活仍要等 A/B 恢复（详见 §3.5） |
| 隐含前提 | 你愿意持续付费 | 你能接受代码公开 | **必须保持 private**（public + self-hosted 是安全红线，见 §3.7） |

**一句话结论**：**A/B 是「恢复」，C 是「降本 + 长期解」，两者不是同一层面的替代品。** C 无法单独把今天的 CI 救回来——它只能让「轻活」在没有 GitHub 分钟的情况下继续跑。

---

## 3. 选项 C 的落地方案（具体到命令，全部**待执行**）

### 3.1 选机与前置核对（**先量，不要先装**）

目标机：`aliyun`（tailscale `100.114.12.76`，公网 `182.92.157.214`），已在跑 Caddy + `dl-release`。

**必须先量这四项，再决定装不装、限多少资源**——本文件**不替你假设** `aliyun` 的规格（我这边 SSH 到这台机 `Permission denied (publickey)`，无法实测，故不做任何数字假设）：

```bash
# 在 aliyun 上跑，把输出贴回 #651 再决策
nproc                                  # 核数
free -g                                # 内存与 MemAvailable
df -h /opt /var                        # runner 与 _work 放哪块盘、剩多少
systemctl is-active caddy dl-release   # 两个既有服务当前状态
ss -lntp | grep -E ':80|:443'          # 端口占用（runner 不需要监听端口，确认这点即可）
```

判定口径（供参考，来自本机 `zzy-eq` 的实测，仅作对照）：

| 指标 | `zzy-eq` 实测（2026-11-21） | 含义 |
| --- | --- | --- |
| 核数 | 4 | 单机并发上限很低 |
| 内存 | 15 G 总、**可用仅 4 G** | 「资源紧张」是真的，不是感觉 |
| 磁盘 | 452 G 总、**剩 134 G** | `_work` 堆积有空间，但仍需清理 |

**若 `aliyun` 可用内存 < 2 G：不要在这台装 runner。** 它已经在跑 Caddy + `dl-release`（生产分发面），再加一个会跑构建的 runner，最坏情况是**把发版面拖挂**——这比 CI 红严重得多。

### 3.2 安装 runner（命令清单，勿直接粘到生产机盲跑）

用**专用非 root 用户**，不要用 root 跑 runner：

```bash
# 1) 建专用用户与目录（runner 自己 spawn 子进程，不该和你共用身份）
useradd --system --create-home --home-dir /var/lib/actions-runner/home --shell /usr/sbin/nologin ghrun
install -d -o ghrun -g ghrun -m 0755 /opt/actions-runner /var/lib/actions-runner/_work

# 2) 取最新版本号（**不要抄死版本**；本文件写作时最新为 v2.338.2 / 2026-10-26）
VER=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')

# 3) 下载 + 校验 sha256（官方哈希写在 release 正文的 HTML 注释里，没有独立 .sha256 资产）
cd /opt/actions-runner
TARBALL="actions-runner-linux-x64-${VER}.tar.gz"
curl -fsSLO "https://github.com/actions/runner/releases/download/v${VER}/${TARBALL}"
EXPECT=$(gh release view "v${VER}" --repo actions/runner --json body -q .body \
          | grep -o "BEGIN SHA linux-x64 -->[0-9a-f]\{64\}" | sed 's/.*-->//')
echo "${EXPECT}  ${TARBALL}" | sha256sum -c -      # 必须输出 OK，否则停

# 4) 解包（保留必要的依赖运行时：官方包自带 .NET，不需要装 dotnet）
tar xzf "${TARBALL}"
```

### 3.3 注册 token：怎么拿、为什么不能写进任何地方

**注册 token 由 GitHub 现签、约 1 小时有效、且只能用一次**。它不是 PAT，不能复用到别处，也**绝对不能**进仓库/PR/issue/日志/systemd：

```bash
# 需要对该仓库有 admin 权限（你自己的 PAT/gh 登录即可）
gh api -X POST repos/zzy-repo/deepseek-app/actions/runners/registration-token --jq .token
```

落地时**只放进当前 shell 的环境变量**，不进命令行参数（argv 会出现在 `ps` 和历史里）：

```bash
read -rsp "registration token: " TOKEN; echo          # 交互式读入，不回显
./config.sh --unattended \
  --url https://github.com/zzy-repo/deepseek-app \
  --token "$TOKEN" \
  --name aliyun-dl-release \
  --labels dl-release \
  --work /var/lib/actions-runner/_work \
  --replace
unset TOKEN                                          # 用完立刻清
```

关于 `--labels` 的一个**实测校准**：`self-hosted`、`linux`、`x64` 这三条**是 runner 注册时自动加的**，不需要手写。所以 `--labels self-hosted,linux,x64,dl-release` 与 `--labels dl-release` 等价，后者更干净。

> ⚠️ 但反过来在 `runs-on` 里，`self-hosted` **必须显式写**（见 §3.6 的 diff），否则匹配不到。注册时自动加、选用时必须写，这两件事方向相反，容易搞混。

注册完会产生 `.runner` 与 `.credentials`（含凭据）→ 权限收紧：`chmod 600 /opt/actions-runner/.credentials*`，且**不要**把 `/opt/actions-runner` 备份进 git。

### 3.4 以 systemd 常驻（unit 文件）

**unit 里不含任何 token**——凭据在 §3.3 已经落到 `.credentials` 文件里了。

`/etc/systemd/system/actions-runner.service`：

```ini
[Unit]
Description=GitHub Actions Runner (deepseek-app, label dl-release)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ghrun
Group=ghrun
WorkingDirectory=/opt/actions-runner
Environment=HOME=/var/lib/actions-runner/home
ExecStart=/opt/actions-runner/run.sh

# 断网 / 重启 / 崩溃后自愈：这是「掉线要人工发现」的主要缓解手段
Restart=always
RestartSec=10
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=60

# ── 与 Caddy / dl-release 同机的资源闸（数值按 §3.1 实测填，此处是示例）──
# 例：若 MemAvailable ≈ 4 GiB → MemoryMax=3G，留 1 GiB 给系统与既有服务
Nice=10
CPUQuota=250%
MemoryHigh=3G
MemoryMax=3G
TasksMax=4096
IOWeight=50

# ── 权限收紧 ──
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
ReadWritePaths=/opt/actions-runner /var/lib/actions-runner

[Install]
WantedBy=multi-user.target
```

启用：

```bash
systemctl daemon-reload
systemctl enable --now actions-runner
systemctl status actions-runner --no-pager
journalctl -u actions-runner -n 30 --no-pager
```

**两个必须注意的坑**（不写出来就会踩）：

1. **`ProtectHome` 与 pnpm 的 HOME 缓存冲突**：`actions/setup-node` 的 `cache: pnpm` 默认把 store 放在 `$HOME` 下。上面用 `Environment=HOME=/var/lib/actions-runner/home` 把 HOME 挪进可写路径来规避。**不要**图省事加 `ProtectHome=yes` 而不改 HOME，否则 job 会在「装依赖」那步因无写权限假红——而假红比真红更难查。
2. **这是示例不是定值**：`MemoryMax=3G` / `CPUQuota=250%` 必须按 §3.1 的实测输出改。抄一份别人的数字，等于把「资源争抢」这个风险从 CI 转移到生产分发面。

### 3.5 资源隔离：**哪些活可以迁、哪些绝对不能迁**

这是本方案最重要的一节。先说一个**必须正视的结构事实**：

> 当前 `ci.yml` 的 job 粒度**不等于**「轻活/重活」的粒度。`checks` 这一个 job（`.github/workflows/ci.yml:30`）里**同时**装着：
> - 轻活：`type` / `lint` / `unit`、37 道 `check-*` 门禁、`test:dl-release`
> - **偏重活**：`Build (internal)`（`.github/workflows/ci.yml:393`）、`Setup JDK 21`（`:413`）、`gradle 配置可解析`（`:474`）、keystore 负向对照（要真 keystore + 临时 key）
>
> **所以「只迁轻活」没法靠改一行 `runs-on` 实现**——`runs-on` 只能整 job 迁移。想要真正的「轻/重」切分，得**再拆一个 job**，那是一次独立的 `ci.yml` 改动（本文件不做，也不建议和计费故障的应急混在同一个 PR 里）。

按现状，各 job 的迁移建议：

| job | 现状 | 建议 | 理由 |
| --- | --- | --- | --- |
| `checks`（type/lint/unit + 门禁） | `ubuntu-latest` | ⚠️ **可迁，但要接受它带着 build + gradle 校验一起过去** | 这是唯一「以轻活为主体」的 job。迁它的收益最大（分钟数占比高、且不含浏览器），但会把 JDK 与 Gradle 求值带到 4 核机上 |
| `golden` | `ubuntu-latest` + **容器** `mcr.microsoft.com/playwright:v1.64.1-jammy`（`.github/workflows/ci.yml:945`） | ❌ **不迁** | ① 要 Chromium；② 用了 `container:`，自建 runner 上得先有 docker 且把 runner 用户加进 docker 组——**docker 组 ≈ root**，等于把 §3.4 的权限收紧全部作废 |
| `integration` ×6（L1 分片 1/6…6/6） | `ubuntu-latest` + 同款容器（`:1091`） | ❌ **绝对不迁** | 6 个分片并发在 4 核机上 = 互相拖慢；P0 报告实测单分片 ~1147s 的全量口径，若 6 并发抢核，单分片会远超 `timeout-minutes: 25`（`.github/workflows/ci.yml:1082`）→ **红的原因从「没 runner」变成「超时」，更难分辨** |
| `flaky-cross-runner` | `ubuntu-latest` | ❌ **不迁** | 名字就是它的语义：**跨 runner 判定的 flaky 三态**。迁到单一自建 runner 会削弱「跨 runner」这个前提本身 |

**结论（供决策的一句话）**：C 的合理形态是「**`checks` 迁过去分担，L1 与 golden 等 A/B 恢复**」。C 省下的是 `checks` 那部分分钟数；**L1 的 6 个分片仍是计费大头**，这部分 C 帮不上忙。

**另一条必须提的容量事实**：只有 1 台自建 runner ⇒ **同时只能跑 1 个 job**。今天 100+ run、多个 PR 并行的场景下，轻活会在这里**串行排队**。`ci.yml` 的 `concurrency: ci-${{ github.ref }}`（按 ref 分组）只取消同一 ref 的旧 run，**不会**帮你解决跨 PR 的排队。

### 3.6 `runs-on` 建议 diff（**不落地，仅供评审**）

> 以下 diff **没有**被应用到 `ci.yml`。它是决策材料：如果选 C，落地时照此改，并单独开 PR。

**最小改动（只迁 `checks`）**：

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -30,8 +30,12 @@
   checks:
     name: type / lint / unit / 产物兼容门禁
-    runs-on: ubuntu-latest
-    timeout-minutes: 20
+    # 自建 runner（aliyun，标签 dl-release）；self-hosted 在 runs-on 里必须显式写，
+    # 与注册时 --labels 自动加 self-hosted 不同（见 docs/ci-self-hosted-runner.md §3.3）
+    runs-on: [self-hosted, linux, x64, dl-release]
+    # 冷缓存 + 4 核：首次跑会比托管 runner 慢，20 分钟偏紧
+    timeout-minutes: 40
```

其余三个 job（`golden` / `integration` / `flaky-cross-runner`）**保持 `ubuntu-latest` 不动**——`golden:937`、`integration:1081`、`flaky-cross-runner:1347` 三处 `runs-on` 一行都不改。

**如果你想把「轻」真的摘干净（更彻底，但要拆 job）**——一次独立的、更大的改动：

```diff
   checks:
     ...
-    runs-on: ubuntu-latest          # 现状：轻活 + build + gradle 校验混在一个 job
+    runs-on: [self-hosted, linux, x64, dl-release]   # 只放轻活
+  # 新增：把 Build/JDK/gradle 三段搬进这个 job，留在托管 runner 上等 A/B 恢复
+  build-gradle:
+    name: 产物构建 + gradle 配置可解析
+    runs-on: ubuntu-latest
+    timeout-minutes: 25
```

⚠️ 这个拆分会**改变 check 名称**，而分支保护规则通常按 check 名匹配——**拆 job 前先确认 required checks 列表**，否则会出现「新 job 没被要求 / 旧 check 永不到场」的假绿。

### 3.7 安全边界（**这条决定 C 隐含「保持 private」**）

| 场景 | 判定 |
| --- | --- |
| **public 仓库 + self-hosted runner** | ❌ **禁止**。fork 一个 PR 就能在你机器上执行任意代码——这是 GitHub 明文警告的红线，也是本方案最大的单点风险 |
| **private 仓库 + self-hosted runner** | ✅ 可接受。能被触发的只有「有写权限的协作者推的分支 / 同仓 PR」，攻击面从「全世界」缩到「有权限的人」 |
| 与 `dl-release` 同机 | ⚠️ 需要收紧。该机上有分发面（Caddy + `dl-release`，且历史上承载过读/写令牌分离的收口，见 #641）。**runner 用户不该能读那些凭据** |

所以：**选 C ⇒ 隐含承诺「仓库保持 private」**。如果之后因为别的原因转 public，**必须同时把 self-hosted 的 job 摘掉**（或立即下线 runner），否则一次 fork PR 就能打穿这台生产分发机。

补充边界（写清「可控」到哪为止）：

- private 仓库里 self-hosted 的风险**不是零**：`pull_request` 事件下，**同仓分支**的代码会真实执行在你的机器上。runner 用户的权限 = 该代码的权限。
- ⚠️ 本仓库历史上有过「文档正文带裸 IP / versionCode / dl 路径」的情况（#601 事故）。在这台机器上跑任何 `check-*` 门禁，等于让它**读取整个工作树**——所以 runner 用户必须**读不到** `dl-release` 的令牌文件。
- `repository secrets` 会注入到 self-hosted 上的 job 里。**除非必要，不要给迁过去的 job 配 secret**；一旦配了，同仓 PR 分支就能读到它。

---

## 4. 风险清单（8 条，每条给判定 + 缓解）

| # | 风险 | 判定 | 缓解 |
| --- | --- | --- | --- |
| 1 | **不可信 PR 在自有机器上执行** | 高（选 C 的核心风险） | 保持 private；runner 用专用低权用户；不和 `dl-release` 凭据同权限；不轻易挂 secret |
| 2 | **单机并发：4 核跑 6 个 L1 分片互相拖慢** | 高 | **不要迁 L1**（§3.5）。6 分片是并发设计，4 核机上会退化成 6 路争抢，且结果是超时假红 |
| 3 | **磁盘 `_work` 堆积** | 中（一定会发生） | 定期清理，命令见下方；`df` 告警阈值建议 85% |
| 4 | **断网 / 重启后 runner 掉线** | 中 | systemd `Restart=always` + `RestartSec=10`；另加「在线性」监控（见下方），因为 `Restart=always` 救不了「进程活着但连不上 GitHub」 |
| 5 | **与 `dl-release` / Caddy 争抢资源** | 中高（同机） | `nice` + cgroup（`CPUQuota` / `MemoryMax`，见 §3.4）；数值按 §3.1 实测填 |
| 6 | **「不许 Gradle 与 AVD 并行」的既有约束** | 中（容易违反且难发现） | `checks` 迁过去后**带着 gradle 求值**（`:413`/`:474`）。若该机或同网还有人在跑 AVD，就撞上这条约束 → 要么接受串行（1 台 runner 天然串行），要么按 §3.6 把 gradle 段留在托管 runner |
| 7 | **自建 runner 不自动升级** | 中（长期债） | runner 版本与 `node`/`pnpm` 版本都得人管；建议每季度对一次版本，并在文档记录当前版本 |
| 8 | **计费恢复后「双轨」被遗忘** | 低但真实 | A/B 恢复后**复核一次** `runs-on` 分布，确认没有「以为在托管、其实在自建」的 job（或反之）；这属于 #601 那类「以为改了其实没改」的同款形状 |

**风险 3 的清理命令**（**只在没有 job 在跑时执行**）：

```bash
# 先确认空闲：busy=false
gh api repos/zzy-repo/deepseek-app/actions/runners \
  --jq '.runners[] | {name,status,busy}'

# 看占用
du -sh /var/lib/actions-runner/_work

# 清空工作区（保留目录本身）
find /var/lib/actions-runner/_work -mindepth 1 -maxdepth 1 -exec rm -rf {} +
```

**风险 4 的在线性监控**（比 systemd 更早发现问题）：

```bash
# 定期跑；status 应为 online
gh api repos/zzy-repo/deepseek-app/actions/runners \
  --jq '.runners[] | select(.name=="aliyun-dl-release") | "\(.name) status=\(.status) busy=\(.busy)"'
```

再加一条**兜底**（本方案不新增监控系统）：注意 `runs-on: [self-hosted, ...]` 在**没有匹配 runner 时不会快速失败**，job 会一直排队（表现为 check 长时间 `in progress`）。所以「runner 掉线」在界面上看起来是**卡住**而不是**变红**——这比红更难被发现，务必配上面的在线性检查。

---

## 5. 恢复顺序建议（无论选哪条都适用）

### 第 1 步：先恢复 CI —— 选 **A** 或 **B**（**不要先做 C**）

理由：C 需要「装机 + 注册 + 调 `runs-on` + 首次跑通」，最快也要半天；而 A/B 是分钟级。**先用 A/B 把「所有 PR 都无法合并」这个局面解掉**，再谈降本。

- 选 **A**：Settings → Billing & plans，补缴 / 提额度，然后按第 3 步重跑。
- 选 **B**：Settings → 转 public，然后按第 3 步重跑（注意 §3.7：转 public 与 self-hosted **互斥**）。

### 第 2 步：再按需上 C，**只分担轻活**

只有在这两种情况下 C 才值得做：① 你算下来分钟费确实不划算；② 你希望「GitHub 计费再出问题时，至少 `type/lint/unit` 门禁还能跑」。**否则先不做**——它带来的是长期运维负担。

### 第 3 步：恢复后需要 `gh run rerun` 的 run 列表（从 #651 拿）

```bash
# 列出失败/未启动的 run（按时间倒序），先看清单再决定重跑哪些
gh run list --repo zzy-repo/deepseek-app --workflow=ci.yml --limit 100 \
  --json databaseId,conclusion,headSha,createdAt,displayTitle \
  --jq '.[] | select(.conclusion=="failure") | "\(.databaseId)\t\(.createdAt)\t\(.headSha[0:7])\t\(.displayTitle)"'

# 逐条或按需重跑（--failed 只重跑失败的 job）
gh run rerun <run-id> --failed
```

⚠️ **重跑前先算账**：每次 rerun **会再计一次分钟**。今天已经 100+ run；如果恢复 banner 后不加选择地全量重跑，等于把同一个额度问题**再触发一次**。建议顺序：

1. **只重跑 `main` 的最新一次**（先确认 CI 真的能跑起来，而不是「没启动」——判据：job 的 `steps` 数 > 0、且有 runner 名）
2. 再重跑**当前 open PR 的 head**（它们迟早要合）
3. **历史 run 不重跑**（已经过去的结论没有价值，纯烧额度）

判据提醒：**「重跑后 9/9 success」不等于「计费恢复」**。要看 job 的 `steps` 是否非空、runner 是否非空——这正是 P0 报告用来定性的那条证据。

---

## 6. 决策建议（不替你选，只把权衡摊开）

| 如果你… | 建议 |
| --- | --- |
| 只想**最快**恢复，且不介意代码公开 | **B** |
| 想保持 private，且能接受**持续付费** | **A**（但要正视：按当前量级会反复触顶，可能需要长期买分钟） |
| 想保持 private，又**不想持续付费** | **A 先恢复**（今天就要能用）+ **C 作长期解**（分担 `checks`，L1 等额度/机器条件更好时再议） |
| 完全不接受自建机器的运维成本 | **A 或 B**，不要碰 C |

三条都属于**owner 决策**：A/B 涉及付款与可见性，代理**没有权限也不应**代为执行；C 涉及机器与凭据，装机这一步也只能由 owner 或授权人做。

---

## 附：本文档涉及的仓库事实索引

| 事实 | 位置 |
| --- | --- |
| `checks` job 定义（轻活主体 + build/gradle 混装） | `.github/workflows/ci.yml:30` |
| `checks` 的 `runs-on` / 超时 | `.github/workflows/ci.yml:32` |
| `Build (internal)`（偏重活，在 `checks` 内） | `.github/workflows/ci.yml:393` |
| `Setup JDK 21`（偏重活） | `.github/workflows/ci.yml:413` |
| `gradle 配置可解析`（偏重活） | `.github/workflows/ci.yml:474` |
| `golden` 的 `runs-on` / 容器镜像 | `.github/workflows/ci.yml:937` · `.github/workflows/ci.yml:945` |
| `integration` 的 `runs-on` / 超时 / 容器镜像 | `.github/workflows/ci.yml:1081` · `.github/workflows/ci.yml:1082` · `.github/workflows/ci.yml:1091` |
| `flaky-cross-runner` 的 `runs-on` | `.github/workflows/ci.yml:1347` |

（行号对应 `main@aab53de0`。若 `ci.yml` 之后有改动，以 `git log -L` 重新核对——本文档的行号会被 `check:doc-refs` 盯住。）
