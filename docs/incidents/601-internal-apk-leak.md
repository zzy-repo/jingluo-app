# 事故复盘 #601：internal 联调包被写进公网分发清单，6 个外部 IP 取到文件

> 本文是 2026-11-20 分发清单泄漏事故（#601）的复盘记录。时间线里我方处置的失误**照原样写入**，
> 不美化：这份文档的价值在于「下次怎么判」，不在于「当时我们做得不错」。

| | |
| --- | --- |
| 事故编号 | #601（车道 A） |
| 发生时间 | 2026-11-20 22:14:58（Asia/Shanghai），公网可见窗口 ≈ 30 分钟（22:15:04 → 22:44:47） |
| 复盘状态 | **关闭**（判据 1–4 均已达可核对深度，取证结案于 2026-11-21 12:40） |
| 取证物 | 分发机 `/opt/dl-leak-evidence/`（9 份，webroot 之外，到期规则见 `docs/RELEASE-MANUAL.md` §15.1） |
| 关联单 | #690（结构根因修复）· #615 / #619 / #620 / #644 / #693（守卫）· #697 / #702 / #705（判据收敛）· #662（保留策略）· #480 / #482 / #487（土壤） |
| 本复盘解除的悬置条件 | #662 里「取证物到期依赖复盘关闭」——见 §7 末尾 |

---

## 1. 摘要

**一句话**：有人按脚本**默认参数**跑 `publish-private-apk.mjs --variant internal`，而这个脚本当年的默认站点根就是公网
webroot，于是「私有发布」直接把 `consume.baseUrl=http://127.0.0.1:18000` 的 1.4.2 internal 联调包写进了公网
`releases.json` 与公网静态目录；公网可见 ≈ 30 分钟内 **6 个外部 IP 取到过该文件：合计 7 次请求，其中 2 个 IP 完整下载了 6,870,715 B
（共 3 次完整下载，其中一个 IP 下了两次）**。

**影响面**：

- 分发内容：公网清单多出 1 条 `artifactVariant: internal` 条目（19 → 20 条），对应 APK 落在公网静态目录；
- 接收方：6 个外部 IP 命中该 URL（合计 7 次请求：3 次完整 6,870,715 B、4 次部分），窗口内 `releases.json` 被拉取 1336 次；
- 实际可用性：该包 `consume.baseUrl` 指向回环，**任何外部设备装上也无法连我们的后端**；APK 内是本来就公开分发的客户端
  代码，签名为已发布的那把 key。因此这次泄漏的**不是机密数据，而是一个坏产物 + 一次「私有通道并不私有」的证明**；
- 真正被推翻的是我们自己的结论：正文最初写「无人下载」，被 Caddy 原始访问日志推翻（见 §2 失误 3）。

**当前状态**：公网清单 11 条 / `internal` 条目 0（2026-11-21 01:35:08 定型），泄漏 URL 404，结构根因已修（#690），
守卫已补齐（§5）。仍有两件事**不由工程侧决定**：外部 IP 是否需要后续处置、dl 公网站是否继续匿名可取（§6）。

---

## 2. 时间线

时刻均为 2026-11-20（Asia/Shanghai），除另行标注。「来源」列写的是**取证时真正被读到的那一份**。

| 时刻 | 事件 | 来源 |
| --- | --- | --- |
| 22:12–22:14 | 私有发布脚本 `--exercise` 反复演练，产生 4 份 `bak-private-*` 备份，公网清单尺寸在 17048 / 17612 之间抖动 | 会话存档 `cb6e17d2` + Caddy `dl.log` |
| **22:14:56** | 发布者执行：`node scripts/publish-private-apk.mjs --apk … --version 1.4.2 --versionCode 21 --variant internal`（**一个根参数都没带**）。脚本 `cp -p` 生成 `releases.json.bak-private-1795184096`（19 条，其中 8 条 internal） | 会话存档 `cb6e17d2`；文件 uid=33（`cp -p` 保留属主） |
| 22:14:58–22:15:03 | 公网清单被原子替换：**19 → 20 条（17048 → 17766 B）**，APK `apk/deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk` 入库 | 脚本 `:670-674` 行为 + Caddy 尺寸链 |
| 22:15:04 | 泄漏包首次公网 `200` | Caddy `dl.log` |
| 22:26:23–22:34:24 | **6 个外部 IP 取到该文件**（下列 IP 均为 Caddy 访问日志里的原始 peer，未做加工）：22:26:23 `13.185.103.64` 180,224 B（部分）· 22:26:36 `136.83.27.25` **6,870,715 B（完整）** · 22:28:56 `54.70.53.60` 6,094,848 B（部分）· 22:29:41 与 22:29:55 `112.50.55.126` **6,870,715 B ×2（完整）** · 22:30:53 `172.252.31.5` 196,608 B（部分）· 22:34:24 `147.185.226.32` 327,680 B（部分） | Caddy `dl.log`（原始访问日志） |
| 22:44:09 | 维护者：「卧槽，谁把包发到公网了，快点把包退回！」 | 会话存档 `session-565292e1` |
| **22:44:47** | 处置：`cp -a` 现场存为 `releases.json.LEAKED-1795185887`（20 条）→ `cp -a bak-private-1795184096` 回滚到 19 条 → `rm` 泄漏 APK。**❌ 失误 2**：用作「干净清单」的那份备份本身就含 8 条 internal，这次「恢复」只去掉了 `1.4.2` 一条 | 会话存档 `session-565292e1`；Caddy 22:44:58 起 17048 |
| 22:48 | 第一轮核查完成，结论「已回滚、无人下载」（当天看起来自洽：探针 404、目录里无 1.4.2 文件） | #601 正文 |
| 22:51:11 / 22:51:46 | 把 `*LEAKED*` 与 `releases.json.bak*` 移出 webroot → `/opt/dl-leak-evidence/`，探针复验 404 | 会话存档 + Caddy 22:51:11 |
| 22:51:13 / 22:51:49 | 另一次撤回动作把清单写成 **11 条 / 0 internal**（两台分发机都做） | 会话存档 `session-75cbe7a6`（`bak-withdraw-*` 为裸 `cp`，uid=0） |
| 22:51–22:57 | 同一轮撤回把 8 个 internal/beta 包挪进 `/var/www/dl/_withdrawn_20261120/`，`/private/` 整目录（12 个内测包）也仍留在 webroot 内 —— **❌ 失误 1：换了路径继续公开**。旧机 22:55:47 起把两处移出 webroot，**新机当时实测仍是 `200`**（`/_withdrawn_20261120/…1.4.0-internal.apk`、`/private/…`），到当晚 23:20 才逐条移出并复验 404 | 会话存档 + #601 评论（2026-11-20 15:00 / 15:20 / 15:55 UTC 三条实测表） |
| 23:25:30–46 | 撤销 22:51–22:57 的过度撤回：11 条现场留档 → 恢复 19 条 + 8 个包归位（含把 `_withdrawn_20261120/`、`/private/` 移出 webroot 的动作） | 会话存档 `session-565292e1`；Caddy 23:25:46 → 17048 |
| 2026-11-20 23:18 | 评论里第一次更正「无人下载」：按 Caddy `dl.log` 逐条统计，多个外部 IP 拉过、其中 2 个 IP 各下完整 6.87 MB | #601 评论（2026-11-20 15:18 UTC） |
| 2026-11-21 01:35:08 | 收敛定型：公网清单 **11 条 / internal=0**，私有清单独立到私有根（webroot 之外） | Caddy 尺寸 9496 |
| 2026-11-21 04:34 | **❌ 失误 3**：正文层面更正「无人下载」。此前正文表格仍写着「0 条 / 没有人下载到」，与日志矛盾 | #601 评论（取证结案）+ 正文更正块 |
| 2026-11-21 04:57 | **结构根因修复 #690** 合入（`b248279`）：默认站点根 = 私有根；`internal × webroot` 早于 I/O 拒绝；`check:private-publish-root` | `git log` / PR #690 |
| 2026-11-21 05:10 | #693 合入（`24c3e17`）：明文 consume 的显式放行 + `INSECURE_CONSUME` 自证标记（三层同源） | PR #693 |
| 2026-11-21 12:15–12:40 | 判据 3 取证结案：发布者 / 隔离者 / 回滚者 / 二次恢复者全部定位到会话 + 命令 + 时间，字节哈希闭环 | 取证结案包（#601 评论 2026-11-21 04:34） |

### 2.1 我方处置中的三处失误（单列，便于直接复用教训）

1. **「移走」不等于「关掉」**：把撤回文件挪进 `/var/www/dl/_withdrawn_20261120/`，目录仍在 webroot 内 → 换路径继续公网可取
   （新机当时仍 `200`，后被别人移出）。同一个错误形态还出现了一次：把泄漏清单改名成 `releases.json.LEAKED-*` 留在原地，
   实测 `200` 可下。**判据**：处置完成的唯一标准是「按 URL 打一遍得到 404」，不是「文件系统里不在 `apk/` 下了」。
2. **「恢复干净清单」用的是含脏条目的备份**：22:44:47 回滚用的 `bak-private-1795184096` 有 19 条，其中 **8 条是 internal** ——
   这次回滚只去掉了 `1.4.2` 一条，internal 是后来那一轮 11 条撤回才清零的。于是「已回滚」这个结论当天是**不成立**的，
   而它在正文里被写成了既成事实。
3. **「无人下载」是结论，不是证据**：正文最初那张「0 条 / 没有人下载到」的表来自「探针 404 + 目录里没有文件」，
   属于**事后状态检查**，而下载是**发生过的事**，只能由访问日志回答。日志一读，6 个外部 IP 直接翻盘。

---

## 3. 根因

### 3.1 直接根因

**有人按默认参数跑了私有发布脚本。** 那一晚的命令一个根参数都没带：

```
node scripts/publish-private-apk.mjs --apk <app-release.apk> \
  --version 1.4.2 --versionCode 21 --variant internal --changes "…consume.baseUrl 保持本地实例…"
```

当时的脚本里 `DEFAULT_SITE_ROOT`（站点根缺省值）就是 `/var/www/dl` —— 也就是 Caddy `file_server` 直出的公网根。
于是「私有发布」这条路的**正常、默认、按文档跑**的行为就是：备份公网清单 → `scp` 上传 → `chown www-data` →
`mv -f` 原子替换公网 `releases.json`。**这不只是一次误操作。**

### 3.2 结构性根因（三件事叠在一起才出事）

| # | 结构问题 | 后果 |
| --- | --- | --- |
| S1 | **脚本默认值错**：私有发布的默认站点根是公网 webroot（`DEFAULT_SITE_ROOT = '/var/www/dl'`） | 默认参数 = 往公网写内部包。任何人复跑同一命令都能复现 #601 |
| S2 | **没有「internal × 公网根」这条拒绝**：闸只看「变体 × 目标清单」，而目标是脚本自己推出来的（`--target` 缺省 + 默认根），等于自己给自己发通行证 | 即便有人带了 `--variant internal`，也没有任何一处判「internal 不许落 webroot 形态的根」 |
| S3 | **清单落在 `file_server` 目录下**：`releases.json` 与 `apk/` 都在 Caddy 静态根里，清单本身公开可读，条目里的 `file` 字段就是一条公开直链 | 「internal」只是命名约定，不是访问控制；清单一被写脏，直链就广播出去。目录同理：`private/` 这个目录名没有任何鉴权，实测公网 `200` |

附加土壤（不是根因，但没有它这次不会用回环地址出包）：`consume` 的**生产 host 至今未提供**（#482 / #487），
仓库里 `config/endpoints.json` 的 `consume.baseUrl` 只能是回环占位 —— 想出「能真连后端」的包只能填回环，于是「回环包」
成了常态产物，而当时的构建期校验只拦「release 变体用回环」，`--variant internal` 正好绕过。

### 3.3 一句话归因

不是「某个 agent 手滑」，而是**默认值把正确操作的默认结果设成了错误结果**，再叠上「没有一条判 internal 不许进公网根」。
修法因此只能是改默认值 + 加门禁，不能是「发布前多看两眼」（#690 的取舍说明）。

---

## 4. 检测与响应

### 4.1 怎么发现的

- **人工比对清单**：22:44 维护者看到公网清单里出现了 `1.4.2` 条目（当时 latest 应为 1.4.1）。
- **可机械化的信号**：`releases.json` 的**尺寸就是状态机** —— 17048 B（19 条）→ 17766 B（20 条）→ 17048 → 9496。
  Caddy 访问日志里 `GET /releases.json` 的 `size` 变化可以逐秒还原「谁在什么时候换了清单」，比读清单本身更可靠
  （清单会被覆盖，日志不会）。
- **事后才发现的那个信号**：`apk/deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk` 的首次 `200` 出现在 22:15:04，比人工发现早了 29 分钟。

### 4.2 哪些日志能定位、哪些不能

| 日志 | 结论 | 为什么 |
| --- | --- | --- |
| `journalctl -u dl-release` | **不能**定位本次写入 | 22:00–23:10 该单元 **0 行**（当日共 344 行，服务是活的，只是没有请求）→ **不是**走 `POST /api/v1/release`，而是直接改文件。它能证明「没走接口」，但证明不了「谁改的文件」 |
| Caddy 访问日志（`dl.log`） | **能**看到下载，能还原清单尺寸链 | 窗口内非 `GET`/`HEAD` 请求 **0 条**（再次排除接口上传）；`uri` + `status` + `size` 是唯一能回答「有没有人真的下到」的证据 |
| `sshd` journal | **能**定位到来源主机与 key，但**到不了 lane 粒度** | 20:00–02:00 共 168 次认证，全部 `root` + `publickey` + 同一来源 IP + **同一把 key**；`last -F` 显示当晚 0 次交互登录（全是非交互 `ssh '<cmd>'`） |
| `/root/.bash_history` | 不能 | 非交互 `ssh '<cmd>'` 不写 history（该文件 mtime 停在 10-16） |
| `acct`（lastcomm）/ `auditd` | 不能 | 两台机器上均 inactive → 进程级命令审计缺席 |
| **发起侧会话存档** | **能**（本次就是靠它结案的） | 会话 id + 具体命令 + 命令输出三者与文件事件秒级对齐，才能说「是这条 lane 的这条命令」而不是「是我们自己的某个 agent」 |

一句话：**服务端只能证明「有人直接写文件」，谁是那个人只能从发起侧（会话存档）读回来。** 这条边界本身就是风险（§6 R4）。

### 4.3 响应动作与每一步的失效点

1. 隔离现场（改名 `LEAKED-*`）→ ❌ 文件仍在 webroot，`200` 可下；
2. 回滚清单（用泄漏前备份）→ ❌ 备份本身含 8 条 internal，只去掉了新加的那一条；
3. 删包 + 探针 404 → ✅ 该 URL 真的 404 了（这一步是对的，也因此被误当成「全部搞定」）；
4. 移出隔离清单/备份 → ✅ 真 404（这一步才开始正确：移出 webroot，
   落点 `/opt/dl-leak-evidence/`）；
5. 撤回 internal/beta 包 → ❌ 落点 `_withdrawn_20261120/` 仍在 webroot（§2 失误 1）；
6. 再撤回 → ✅ 移出 webroot，逐条 URL 复验 404；
7. 撤销过度撤回（恢复 19 条）→ 这次恢复**又**把 8 条 internal 放了回去，直到 11-21 01:35 才收敛到 11 条 / internal=0。

第 7 步说明一件重要的事：**处置动作本身也会制造新的事实**。「恢复」比「删除」更容易把脏数据带回来，因为它通常靠一份历史备份，
而历史备份的干净程度没有人验过。

---

## 5. 已加的防线

每条都写明「它拦什么」。**方向一律是加严与去重**：没有一条是把判据拆掉换绿的。

| 防线 | 拦什么 | 落地 |
| --- | --- | --- |
| **默认根 = 私有根** | 「按默认参数跑」这个动作本身。`DEFAULT_SITE_ROOT = DEFAULT_PRIVATE_ROOT = /opt/dl-private`（`scripts/publish-private-apk.mjs:146`）—— 默认跑出来的落点在 webroot 之外；公网根**不再有缺省值**，`targetPaths({target:'public'})` 缺根直接抛错 | #690（`b248279`） |
| **`internal/prerelease` × webroot 形态根 → 拒** | S2。纯函数 `gatePublishRoot()`（`scripts/publish-private-apk.mjs:452`）在 `main()` 第一步与 G1 合并判，**早于任何 ssh/scp/目标读写**：命中即「内部包不得写入公网分发根」。写公网 webroot 必须**显式** `--site-root` **且** `--allow-public-webroot`，缺一个就非 0 退出 | #690 |
| **`check:private-publish-root` 门禁** | 「有人把默认值改回去」。静态 R1–R5（默认站点根必须等于私有根、字面量不得是 webroot 形态、`--target` 缺省必须是 `private`、确认开关必须存在、webroot 不许当默认值回落）+ 行为 B1–B5（import 脚本调纯函数），`--selftest` 内置 5 种改坏方式的负向对照；已接 CI 并登记进负向对照登记簿 | #690（`scripts/check-private-publish-root.mjs`） |
| **兄弟目录也认作 webroot** | 「换个名字绕过」。`isWebrootPath()`（`scripts/publish-private-apk.mjs:170`）按「`/var/www` 家族 + 常见静态目录名」判，`/var/www/dl-private` 这类**兄弟目录**也算 —— 这正是原先 `startsWith(webroot + '/')` 前缀判断漏掉的那一类 | #690 |
| **构建期回环闸（全变体）** | 「以为 internal 变体不归闸管」。回环 `consume`/`pay`/`migration` base 在**任何变体**（不看 `taskNames`）下都在配置阶段 `GradleException`；逃生舱只认字面 `-PallowLoopbackConsume=true`（`android/app/build.gradle:392`），且产物带 `LOOPBACK_CONSUME=true` 标记 —— 打得出来，但传不上去 | #615（`ef4ba3e`） |
| **上传侧拒绝回环包** | 「打得出来但传得上去」。`POST /api/v1/release` 读 APK 内标记 → `400 LOOPBACK_BUILD_REJECTED`；`release-upload.mjs` 发请求前就停 | #615 |
| **四条硬闸 + 独立私有清单 + webroot 卫生门禁** | S3。私有发布写私有根（webroot 之外）的独立清单；G1 目标×变体 / G2 回环 baseUrl（从 APK 字节里读）/ G3 清单自洽 / G4 孤儿文件；`scripts/check-webroot-hygiene.mjs` R1（`*.bak*` / `*LEAKED*` / `_withdrawn*` / `releases.json.*` 白名单外）/ R2（webroot 里非 `apk/` 的顶层目录、任何符号链接）/ R3（`apk/` 与各顶层目录下的 `internal`、`dev` 文件名）/ R4（公网清单里 `artifactVariant !== standard`，且证明不了 0 就不许判绿） | #619（`314c6f9`） |
| **接口层同口径** | 「绕过脚本改用 HTTP 上传」。`POST /api/v1/release` 只收 `standard` + `stable`（判不出来也拒）；合并后整份清单若有 internal 条目 → `409 MANIFEST_INTERNAL_ENTRY`，整单拒收；私有根落在 webroot 内则服务**拒绝启动** | #620 / #625（`5cf6581`） |
| **`check:retention` 到期账本** | 「没人敢删、永远不清」。每个目录一份 `<dir>/.retention.json`（sha256 / 大小 / 何时进来 / 何时该删 / 为什么能删），过期 → exit 1；`deleteAfter: null` 必须配 `deleteAfterRule` + `reviewAfter`，到复核日仍没确认就判 `REVIEW-DUE`（**不是自动删，是逼人做一次判断**）；文件与账本对不上判 `DRIFT` | #670（`8009dd1`），`scripts/check-retention.mjs` |
| **构建期 / 运行时 / 产物三层一致的 `INSECURE_CONSUME`** | 「只放宽构建期 → 装得上、一开就白屏」。明文（http）非回环 base 的显式放行通道 `-PallowInsecureConsume=true` / `ALLOW_INSECURE_CONSUME=true` 只认字面 `true`，并在**产物**里打 `INSECURE_CONSUME` 自证标记；**运行时**判据读的是标记（`src/services/consume/http.ts`），因为运行时读不到 `-P`/env；`verify:apk` 默认拒收该标记，`--allow-insecure` 时结论行强制标 `INSECURE(staging-only)` | #693（`24c3e17`） |
| **证书指纹：三处判据各守一个界面 + 单一来源** | 「同一个事实抄三份，两份一起改就骗过所有『互相一致』的检查」。期望值只有 `config/appIdentity.json` 一处，读取实现只有 `resolveExpectedCertSha256()`（`scripts/lib/certFingerprint.mjs:63`）；配置侧一致性 / keystore 侧 / APK 侧各判一个界面，谁也不抄值；`verify:apk` 的默认值副本已删除，读不到就 `exit 2`（fail-closed）；**并保留一条第三方见证**（写死的已发布值，见 §7 教训 5） | #697（`fd61188`）· #702（`9db3e4c`）· #705（`e4ae925` / `27c82b3`）· 见证断言 #714（`9378d6a`）· 手册 §16（`c02d365` / `292fafe`） |
| **`verify:apk` 读侧** | 「判据只活在发布链里，出包到上传之间没人能一键复算」。第 3 项 = `LOOPBACK_CONSUME`（缺标记按 false，不误伤历史包；值不是布尔则 fail-closed 拒收），第 5 项 = `INSECURE_CONSUME` | #644（`e1891bc`）· #693 |
| **标记解析只有一份实现** | 「同一条事实两套解析，其中一套静默认不出」。aapt2 会把 `android:value="true"` 编成 `TYPE_INT_BOOLEAN`（`dump xmltree` 里没有 `Raw:`），只认 quoted string 的解析会把回环包判成「标记缺失」→ **静默放行**。`parseMetaDataFromXmltree()`（`deploy/dl-release/variant.mjs:55`）覆盖 quoted / typed / 无值三种形状，变体判定与回环/明文判定共用它 | #644 · #693 |

---

## 6. 仍然存在的风险（如实写）

| # | 风险 | 现状与理由 |
| --- | --- | --- |
| **R1** | **dl 公网站仍是匿名可取** | `dl.rose7.cn` 的 `releases.json` 与 `apk/*` 本来就是公开分发渠道，「不带任何凭据能不能下载」的答案是「能」。**这是产品决策**，不是漏洞：本复盘不把「公网站公开」当问题，只把「内部包进了公网站」当问题。判断标准见手册 §14.5 |
| **R2** | **外部 IP 是否需要后续处置 —— 待指挥台裁决** | 6 个外部 IP 取到过该文件（7 次请求里 3 次是完整 6,870,715 B，来自 2 个 IP）。取证能给出的边界是：包内 `consume.baseUrl` 是回环、内容为公开分发的客户端代码、签名为已发布那把 key，因此**不具备可用性收益**；但「是否宣布内测产物外泄 / 是否通知 / 是否触发签名轮换」属于产品与安全裁决，不是取证能下的结论。**当前状态：未裁决，未处置** |
| **R3** | **`verify:apk` 需要 Android SDK，CI 只能跑降级档** | 第 2/3/5 项要 `aapt2`、第 4 项要 `apksigner`（从 `$ANDROID_HOME/build-tools/` 取），缺工具 → `exit 2`（fail-closed，不是「当通过」）。CI 里能真跑的是**不碰 APK 的前门三道配置判据**与纯函数解析器用例；真实的五项验证只能在签名机 / 有 SDK 的机器上跑。**后果**：CI 绿 ≠ 「这个包的签名/变体/回环/明文都对」，它只证明「期望值本身健康」 |
| **R4** | **多 lane 共用一把 root key，且「直接写 webroot」的通道仍在** | 取证时 168 次认证全部是 `root` + 同一把 key + 同一来源 IP → 服务端**到不了 lane 粒度**；`/root/.bash_history` 不记录非交互命令，`acct`/`auditd` 均 inactive。分离 `authorized_keys`（每 lane 独立 key + `from=` / `command=` 限制）与「webroot 只由 `dl-release` 专用账号写」**都还没有落地**。下一次同类事故仍然只能查到「是我们自己」 |
| **R5** | **`verify:apk` 之外没有独立的产物出处证明** | `sha256` 只能证明「现在的字节就是这份字节」，不能证明「它是 CI 从哪个 commit 构建的」。Release 资产审计时已如实记下这条边界：能做的是把 sha256 锚定下来，让任何替换可被发现 |

---

## 7. 可移植的教训（写成别人能直接用的判据）

**L1 · 「移走」必须按 URL 复验 404，不能只确认文件系统位置。**
判据：任何「已处置」的声明，必须附一条**按公网 URL 打的探针**及其状态码；只对文件系统做 `ls`/`mv` 检查不算。
理由：`_withdrawn_20261120/` 与 `releases.json.LEAKED-*` 两次都是「文件不在 `apk/` 下了」但「URL 仍 200」——
静态目录不看清单、不看文件名，只看**路径是否在 webroot 下**。

**L2 · webroot 顶层只许白名单内容；备份 / 隔离物一律放 `/opt/` 以下。**
判据：webroot 的合法形状只有「顶层文件 + 允许的子目录（`apk/`）」，其余一律红；`*.bak*`、`*LEAKED*`、`_withdrawn*`、
`releases.json.<任何后缀>`、`*.tmp-*`、任何符号链接、任何非允许顶层目录 —— 全部是「有人手工改过」的痕迹。
理由：隔离物放在 webroot 里 = 把证据换成第二个泄漏面。落地形态见 `scripts/check-webroot-hygiene.mjs` 的 R1/R2。

**L3 · 单条命令出包的危险默认值 = 下一次事故；默认值必须是安全的。**
判据：问一句「**不带任何参数**跑这条命令会发生什么？」如果答案是「写进公网 / 覆盖线上 / 删掉历史」，那这个默认值就是缺陷，
不管文档里写没写「请谨慎使用」。修法是让**危险动作必须显式**（显式参数 + 确认开关 + 双开关齐全），并且让默认值本身落在安全侧；
再把「有人把默认值改回去」变成门禁红灯（`check:private-publish-root` 就是这么来的）。
反面样本：老 `DEFAULT_SITE_ROOT = '/var/www/dl'` —— 任何人按默认参数跑私有发布都能复现 #601，所以这不是「误操作」问题。

**L4 · 只放宽构建期会得到「装得上、一开就白屏」的包 —— 三层必须同源。**
判据：任何「放行某类产物」的开关，必须在**构建期（原生）**、**构建期（web bundle）**、**运行时**三处用同一条判据、
同一份标记，且由产物携带（运行时读不到 `-P`/env）。缺运行时那一层，现象不是「构建失败」而是「冷启动白屏」——
后者不会在 CI 里出现，只会出现在用户手机上。可执行的负向对照：只放行构建期、不放行运行时 → 模块级的
`getConsumeClient()` 必须抛 `ConsumeConfigError`；有标记时不许抛（`tests/unit/insecure-consume-seam.test.mjs` 的 R3）。

**L5 · 「两份配置互相一致」防不了「两处一起改」—— 需要独立见证。**
判据：凡是「一致 / 相等 / 两份相同」这类断言，只要两份都能被同一个改动同时改掉，它就**只防手滑、不防改口**。
必须另外留**至少一处不依赖任何配置的写死值**（第三方见证 tripwire），且它**不许**以「去重」为理由删除或改成比对方。
理由与实测见 `docs/RELEASE-MANUAL.md` §16（同时改 `config/appIdentity.json` 与 `PUBLISHED_IDENTITY` 时，
所有「两份一致」的检查一起变绿，只有 `tests/unit/app-identity.test.mjs` 里那条写死的已发布证书指纹会红）。
同一条道理也解释了 #601 的另一面：`releases.json` 与 `apk/` 目录「看起来一致」没有任何用 —— 它们都能被同一个 `scp` 改掉。

---

## 附录 A · 复验（只读，任何人可重跑）

```bash
# 1) 泄漏 URL 必须 404
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dl.rose7.cn/apk/deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk    # 期望 404

# 2) 公网清单必须 internal = 0
curl -s https://dl.rose7.cn/releases.json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const m=JSON.parse(s), bad=m.releases.filter(r=>r.artifactVariant!=="standard");
    console.log("entries=%d internal=%d latest=%s",m.releases.length,bad.length,m.latest);
  })'

# 3) webroot 卫生（分发机上跑）
ssh aliyun 'cd <repo> && pnpm check:webroot-hygiene'

# 4) 保留账本（取证物到期）
ssh aliyun 'cd <repo> && pnpm check:retention --verbose'
```

**取证物与到期规则**：`/opt/dl-leak-evidence/` 9 份（清单篡改前后快照 + 撤回现场），webroot 之外，
`deleteAfter: null` + `deleteAfterRule`「复盘关闭后 30 天」+ `reviewAfter` 复核日；删前必须人确认，
且**不得**以「保留策略」的名义删被清单引用的活资源。规则原文见 `docs/RELEASE-MANUAL.md` §15.1 与 §15.3。

**本复盘对 #662 的意义**：取证物的条件到期里，那个「只能人判断」的变量（复盘关没关）**现已确定**——
本文件即 #601 的复盘记录。把它填进 `deleteAfter`（复盘关闭日 + 30 天）这一步仍需要在分发机上执行
`check:retention` 的顺序（§15.3），由发布 owner 完成。
