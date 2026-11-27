# 升级兼容审计（#910，migration-audit，对抗性验收）

范围：已发布版本（`git tag` 的 `v*`，2026-11-13 至 2026-11-22）到「带迁移的版本」之间，旧 IndexedDB 是否仍然可达、备份还原会不会把新旧存储拼成不一致状态、IDB 升级与 SQLite 迁移会不会互相干扰、回滚到旧版本会看到什么。全部结论来自仓库历史与代码，不是推测；做不到的明确标「未知」并写清缺什么证据。

**未验证范围（必须先说）**：本审计没有真机、没有已发布 APK 实物、没有真机备份还原。所有「安全」都是「源码与配置层面没有发现会让旧库不可达的变化」，不是「真机已验证」。

## 1. 应用标识、WebView Origin 与旧库可达性

WebView 的 IndexedDB 按 Origin 隔离。本工程是 Capacitor 壳，Origin = `server.androidScheme` + `server.hostname`（缺省 `https://localhost`，见 `@capacitor/android` 的 `CapConfig`（依赖包内源码，不入本仓），默认 `hostname="localhost"`、`androidScheme="https"`，且 schema 校验只允许 `http`/`https`）。**任一变化都等于换库**：旧 IDB 在新版本里打不开。

逐版本核对（每个 `v*` tag 上对 `capacitor.config.ts`、`config/appIdentity.json`、`android/app/build.gradle`、`AndroidManifest.xml` 跑 `git show` / `git grep`）：

| 维度 | 结论 | 证据 |
|---|---|---|
| `applicationId` / `namespace` / `appId` | **安全** | 从第一个有 Android 工程的 tag（`v1.1.0`，2026-11-17）到 `v1.4.21`，全部是 `com.example.deepseekchat`，无一例外。`git log` 全历史里这个字符串只出现过这一个值（`build.gradle` 19 次、`appIdentity.json` 12 次，`uniq` 后只有一个）。`build.gradle` 无 `applicationIdSuffix`、无 `productFlavors`（`artifactVariant` 只进 manifest 元数据，不进包名）。iOS `PRODUCT_BUNDLE_IDENTIFIER` 同值（`ios/App/App.xcodeproj/project.pbxproj:312,333`），但 iOS 工程 2026-11-26 才入库（`6322eeb1`），**没有已发布的 iOS 版本**。 |
| `server.hostname` / `androidScheme` / `iosScheme` / `server.url` / `allowNavigation` | **安全**（源码层面） | 全部 tag 的 `capacitor.config.ts` 都没有 `server` 块（`git log -S` 全历史 0 命中）。生成物 `capacitor.config.json`（`android/app/src/main/assets/` 下，被 `android/.gitignore` 忽略）、不入库，所以**无法从 git 证明已发布 APK 里的生成物没有被构建机改过**——这是下面「未知」的来源。 |
| WebView 数据目录（`setDataDirectorySuffix`、自定义 WebView 存储路径） | **安全**（源码层面） | `android/app/src/main/java` 全历史 0 处 `setDataDirectorySuffix` / `WebView.setDataDirectory`。`MainActivity` 继承 `BridgeActivity`，用默认 WebView。 |
| 签名证书 | **安全，但有一个必须守住的前提** | `android/app/build.gradle` 的 release 签名段注释写明：历史上 `keystore.properties` 路径写错（`rootProject.file("../keystore/...")` 指向从未存在的目录），**已发布包全部由 AGP 默认的 `/root/.android/debug.keystore` 签出**，指纹 `e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1`，该值从 `v1.4.1`（`appIdentity.json` 入库）到 HEAD 未变。换证书 = Android 拒绝覆盖安装 = 用户只能卸载重装 = 私有目录（含 IDB）被删。`build.gradle` 已有 release 构建的指纹闸门，**迁移版本的发布包必须继续用这把钥匙签**。 |
| Capacitor 版本 | **安全** | `pnpm-lock.yaml` 在 `v1.1.0` 与 `v2.0.0` 都锁定 `@capacitor/android@8.6.2`；`package.json` 各 tag 都是 `^8.6.2`。没有跨大版本升级带来的 WebView 存储布局变化。 |
| 库名 | **安全** | `DB_NAME = 'chat-demo'`（`db.ts:49`），`v1.1.0` 时写死同名（`openDB('chat-demo', …)`）。改名同样等于换库。 |

**未知（需要 lead 安排，本审计做不到）**：

1. 已发布 APK 实物的 `capacitor.config.json`（APK 产物内路径，不在仓库里）没有入库。源码缺省值稳定，但构建机若注入过 `server.hostname`，git 看不出来。建议对每个已分发版本的 APK 解包核对该文件（`aapt`/`unzip` 即可，不需要真机）。
2. 覆盖安装时 Android 对 WebView 数据目录的保留是平台行为，不是本仓库能证明的。源码没有主动迁移/清理该目录的代码（全历史 0 处），这是目前能给的全部证据。
3. `v0.1.0` / `v0.1.1` / `v0.1.2` / `v0.1.3` / `v1.0.0` 这五个 tag **没有 `android/` 目录**（纯 Web 构建）。若它们曾被当作网页发出去，那些用户的 IDB 在网页 Origin 下，与 App 的 `https://localhost` 不是同一个库——这不是升级会弄丢，是**本来就不是同一份数据**。是否有人在用网页版，仓库无法回答。

## 2. 备份还原的一致性

### Android Auto Backup —— **有风险**

`AndroidManifest.xml` 从 `v1.1.0` 到 HEAD 每一版都是 `android:allowBackup="true"`，且**从未有过** `android:fullBackupContent` 或 `android:dataExtractionRules`（全历史 grep 0 命中）。默认行为是「什么都备」：

- WebView 的 IndexedDB 在 `app_webview/`，属 `data/data/<pkg>/` 私有目录，在默认备份范围内。
- 迁移后的 SQLite 库与 `<getFilesDir()>/storage-engine/state.json`（设备运行期目录，不在仓库里）都在应用私有目录下（`AppFileSystemPlugin.java:41` 用 `getFilesDir()/app-fs`；SQLite 若用默认 `getDatabasePath()` 则在 `databases/`，同样在备份范围内——**具体落点要等 native-sqlite 定，见末尾决策点**）。
- 没有任何规则能表达「这几个文件必须同一时刻一起备、一起还原」。

后果：Auto Backup 是按文件、按各自的修改时间增量上传的，还原时每个文件取它自己的最新版本。一次备份周期里 `state.json` 已是 `committed` 而 SQLite 库还是上一周期的副本（或反过来：库是新的、状态文件是旧的），还原出来就是**两份见证各自正确、合在一起矛盾**，而且可能和同时还原出来的旧 IDB 也不是同一时刻的。这正是计划 §4 的「两份见证矛盾」场景，只是触发者不是崩溃而是系统备份。

第二个问题是**配额**：Auto Backup 每应用 25MB（[官方文档](https://developer.android.com/identity/data/autobackup)）。本应用的合法数据量远超此值（见第 4 节，单库可达数百 MB），超限后整份备份会被跳过。于是「换机/还原后数据还在」对大部分真实用户**本来就不成立**，不能把系统备份当成迁移的安全网。

建议（写在这里，不实施）：迁移版本起把 `storage-engine/` 与 SQLite 库排除出云备份（`noBackupFilesDir`，或 `data_extraction_rules` 里 exclude），云备份继续只带偏好类小文件；「换机不丢数据」只承诺**应用内导出**这一条路径，并在文案里说清楚。排除规则必须在**第一个会写这些文件的版本**就带上——晚一个版本，中间版本产生的备份已经是不一致的了。

### iOS iCloud / iTunes 备份 —— **未知，且当前无排除配置**

`ios/` 工程 2026-11-26 才入库（`6322eeb1`），所有已发布 tag 都没有它，**没有已发布的 iOS 版本，不存在「升级老 iOS 用户」这条路径**。但工程一旦发出去就受这条约束：`Info.plist` 无 `NSFileProtection` 覆盖、无备份排除；`ios/` 内 0 处引用 `AppFileSystem`（iOS 侧文件系统插件还没接，计划里 iOS 本来就排后）。iOS 备份默认包含应用容器全部内容，同样没有「同一时刻」保证。建议与 Android 同一口径：库与状态文件标 `isExcludedFromBackup`，在 iOS 插件落地时一起做，而不是事后补。

### 应用内更新器不会装旧版本 —— **安全**

`AppUpdatePlugin.java:186`：`if (code(apk) != versionCode || code(apk) <= code(current)) throw VERSION_MISMATCH`。应用内更新路径拒绝版本回退。回退只可能来自用户手动装旧 APK（见第 3 节）。

## 3. 升级路径与回滚

### 3.1 版本分布（每个 tag 的 `db.ts` 实测）

| DB 版本 | 引入 | 已发布 tag |
|---|---|---|
| 11 | `783829d5`（2026-11-13，Initial commit，**仓库里最早的 schema 就是 11**） | `v0.1.0` `v0.1.1` `v1.0.0` `v1.1.0` `v0.1.2` `v0.1.3` |
| 12 | `311f6a10`（2026-11-17，新增 `appAssets`） | `v1.2.0`–`v1.4.1`（16 个 tag） |
| 13 | `f6ca4d0d`（2026-11-20，#480 附件两表） | `v1.4.3` `v1.4.4-staging` |
| 14 | `f609ac62`（2026-11-21，#399 `sessionMemory`） | `v1.4.5`–`v1.4.15` |
| 15 | `a22abe41`（2026-11-22，#831 `branchOf` 索引） | `v1.4.16`–`v1.4.21`、`v2.0.0` |

HEAD 也是 15（`db.ts:46`）。**迁移版本不再升 IDB 版本**（计划 D6：不改旧库 schema）。

### 3.2 IDB 升级与 SQLite 迁移的先后 —— **安全，附一条必须守住的顺序**

`upgradeChatDB`（`db.ts:606-656`）对全部 5 个历史版本都一样：**`_oldVersion` 形参未使用**，全程 `objectStoreNames.contains()` / `indexNames.contains()` 守卫，只建缺失的 store 和索引，不读、不写、不删任何已有记录。所以「跳过多个中间版本直接升上来」与「逐版升上来」在 IDB 侧结果相同，旧记录逐字节不动（这一点由 `tests/unit/storage-char-lifecycle.test.mjs` 的合成起点用例覆盖，本审计的 `dataset.mjs` 另有独立的一份，见下）。

顺序上的依赖是真实存在的：迁移的源是 `RawStoreSource`，而 `idb/raw.ts` 经 `openChatTransaction()` 开门——**开门就会先跑 `upgradeChatDB`**。因此实际顺序是「先把 IDB 升到 15，再读它」。这个顺序是安全的，前提是迁移代码**只在 `getChatDB()` 成功之后**才把任何状态写成「已开始」：升级本身不改数据，所以即便升级后、复制前崩溃，重跑也是幂等的。反过来的顺序（先标状态再开门）会让「升级失败」被记成「迁移失败」，两者的恢复路径不同，不要混。

两者不会互相写：迁移按 D6 不写 IDB；IDB 升级不碰 SQLite。唯一的交点是「开门」这个动作，它只加 schema 不加数据。

`v1`–`v10` 在本仓库**不存在**（Initial commit 即 v11）。若有更早的库流入（例如从别的分支手工拷贝），`upgradeChatDB` 不识别也不拒绝，只会补齐 9 个 store——补齐不等于读得懂里面的记录。本审计的数据集把 v1–v10 标为 synthetic，不把它们当真实用户数据。

### 3.3 `committed` 之后回滚到旧版本 —— **有风险（这是 D5 要防的场景，现状防不住）**

复现路径：用户装了迁移版本 → 迁移 `committed`（SQLite 为真源，此后写入不再进 IDB，D6 也不许写）→ 用户手动安装旧 APK（应用内更新器拒绝回退，但 adb / 文件管理器不拒绝）。

旧版本打开 IDB 时请求自己的 `DB_VERSION`，库此时是 15（迁移版本不改版本号，D6）。IDB 规则：请求版本 < 现存版本 → `VersionError`；等于 → 直接打开；大于 → 升级。用 fake-indexeddb 实测（先开 15，再依次请求）：`15→ok  15→ok  12→VersionError  14→VersionError  16→ok  15→VersionError`（最后一项是库已升到 16 之后）。据此按旧版本的 `DB_VERSION` 分两类：

- **请求 15 的版本（`v1.4.16`–`v1.4.21`、`v2.0.0`，共 7 个 tag）：静默读写过期 IDB。** 打开成功，没有任何信号。用户看到迁移那一刻的快照，之后在迁移版本里产生的数据全部消失，旧版本还会继续往这个过期库里写，重新升级时这些写入与 SQLite 里的新数据分叉（D5 要防的正是这个）。这一类是真实风险，现状防不住。
- **请求 11–14 的版本（`v1.4.15` 及更早）：`VersionError`，启动失败。** 不会读到过期数据，但这批版本都没有 `VersionError` 的专门处理（`StorageVersionTooNewError` 是 `b61f4ca0`，2026-11-25 才加；`v1.4.21` 与 `v2.0.0` 的 `db.ts` 里 `grep -c StorageVersionTooNewError` 均为 0，目前没有任何 tag 含它），界面落到通用的「加载失败，请重试」。重试永远是同一个结果，文案也不提示升级。这个行为在迁移版本之前就存在（库只要被升到 15，回滚到 ≤14 就这样），不是迁移引入的。

**结论**：IDB 版本号没有被推进，请求 15 的旧版本就没有任何信号知道自己在读过期数据。D5 的机制（原生私有目录里的状态文件）旧版本的代码不会去读。

### 3.4 缓解建议（只论证，不实施；由 lead 决定）

核心矛盾：要让旧版本**自己拒绝服务**，信号必须写在旧版本会读的地方；而旧版本会读的只有 IDB。所以「在旧 IDB 里留一个见证」是唯一一类旧版本能看见的手段。逐个候选：

1. **把 IDB 版本升到 16（推荐，语义最干净）。** 旧版本请求 11–15，打开版本 16 的库得到 `VersionError`，启动失败而不是静默读过期数据。代价是要改 D6「不改旧库 schema」这一条——只升版本号、`upgrade` 回调空操作，不新增 store 也不写业务数据，旧库的 schema 与内容都不变，但「版本号」确实变了。需要 lead 确认 D6 的本意是否包含版本号。
   - 旧代码的反应（3.3 已实测）：全部 tag 都没有 `VersionError` 分支，`openDB` 失败落到通用的「加载失败，请重试」，重试永远同一个结果，文案不提示升级。这是坏体验，但**不是数据损坏**，且比「静默显示过期数据并继续写入」强得多。它把 3.3 里「请求 15 的 7 个 tag」并入「请求 ≤14」那一类的行为。
   - 副作用要先想清楚：升到 16 之后，**迁移版本自己的失败回退也受影响**。若迁移在 `committed` 前失败、而 IDB 版本已被升到 16，之后用户回滚到旧版本，旧版本也打不开它本来能用的 IDB（迁移根本没成功，旧库才是真源）。所以「升到 16」必须与 `committed` 同一步，不能提前。
   - `b61f4ca0` 之后的构建会显示「本机数据版本比当前应用新，请更新应用」（`src/i18n/zh.ts:42`），文案正确，但它挡不住已发布的 tag。
2. **写一条旧代码不会读的见证记录（不可行，已排除）。** 想过往 `appAssets` 或某个 store 写一条特殊 key。论证结果是它保护不了任何人：旧代码对 `appAssets` 只按已知 key 取（`appAssets.ts` 的 `get(key)`），对 `sessions` 的多余行则会当成真会话渲染出来；没有任何旧代码路径会因为「多了一条不认识的记录」而拒绝启动。见证写进去，旧版本看不见，新版本也不需要（它有状态文件）。
3. **写一条会让旧代码崩溃的记录（否决）。** 例如往 `sessions` 放一条缺 `messages` 的行。旧代码的游标扫描（`db.ts` 的孤儿清理、导入替换）直接读 `cursor.value.fileIds`、`session.messages`，缺字段会抛 `TypeError`，事务中止。但这是**用数据损坏换保护**：一旦用户之后又升级回来，这条坏记录变成新版本要迁移的源数据，等于我们自己把源弄脏了。违背 D2/D6。
4. **不改 IDB，只在文档和发布说明里禁止降级（现状，不够）。** 应用内更新器已经拒绝降级，但手动装包拦不住，且没有任何运行时信号。

建议取第 1 条，并把「升到 16」放在 `committed` **之前**而不是之后：若放在之后，崩溃窗口里会出现「状态文件未提交但版本已升」的中间态，旧版本打不开、新版本重跑又要重做。放在 commit 的同一步里（先升版本、确认打开成功、再写两份见证）窗口最小。

另有一个与回滚无关但同根的问题，留给 schema 设计：**SQLite TEXT 列对 JS 字符串不是无损的**。本审计用 Node 22.23.4 的 `node:sqlite` 实测，写入再读回：含 `\u0000` 的字符串在 NUL 处被截断（`"a\u0000b"` → `"a"`），孤立代理项被替换成 U+FFFD（`"a\ud800b"` → `"a\ufffdb"`）。两者都是 JS 字符串的合法值，IndexedDB 原样保存。若目标 schema 用 TEXT 存主键或正文，迁移会静默丢数据，且校验器若用同样的 TEXT 读回就**发现不了**（两边都是坏的）。见 `docs/sqlite-schema.md` 是否已规定「字符串以 JSON 或 BLOB 形式落库」——本审计不改那份文档，但 oracle 与数据集已把这两个值列为必测项。

**主键列同样受影响，而且后果是丢行而不是丢字符（node:sqlite 实测，Node 22.23.4）**：

- 两个不同的孤立代理项键 `'a\ud800b'` 与 `'a\udc00b'` 写入 `TEXT PRIMARY KEY` 后只剩 **1 行**（都被换成 U+FFFD，后写覆盖先写，upsert 不报错）。
- 含 NUL 的键 `'id\u0000x'` 与 `'id\u0000y'` 都被截成 `'id'`，**两行并成一个键**，值被覆盖。
- 排序不同：SQLite 对 TEXT 按 UTF-8 字节序，IndexedDB 与 JS 按 UTF-16 码元序。`['～'(U+FF5E), '😀'(U+1F600), 'a']` 在 SQLite 是 `a, ～, 😀`，在 IDB 是 `a, 😀, ～`。契约要求 `readBatch` 按「主键升序」分页、`after` 为上一页 `next`（不含）。若后端用 `WHERE key > ? ORDER BY key` 分页，而迁移引擎用 JS 比较去续迁/比对检查点，**会漏行或重复行**，且只在含 BMP 以上字符与 U+E000–U+FFFF 字符并存的键上出现，普通测试数据碰不到。

实际用户键多为 `crypto.randomUUID()` 或 `attachment-<hex>`，现实风险低，但 IndexedDB 允许任意字符串键，导入包里的会话 id 来自外部文件。建议 schema 层二选一：主键列存 UTF-16 码元的无损编码（如 hex 或 BLOB），并让 `ORDER BY` 的序与 JS 序一致；或者在迁移预检里**显式扫描并拒绝**含孤立代理项 / NUL / 与 JS 序不一致的键，报 `unsupported`，不要静默并行。`dataset.mjs` 的 `exoticKeys: true` 选项造的就是这类键，`oracle.mjs` 按 JS 序检查「主键严格升序」，所以按 UTF-8 序返回的后端会被判 `source-contract`。

## 4. 数据量与预检阈值

### 4.1 最坏情况体积（从 `src/services/limits.ts` 与 `db.ts` 推出）

有上限的：

| 项 | 上限 | 出处 |
|---|---|---|
| 单条消息图片 | 20 张、合计 20MB（编码后），原图单张 ≤ 16MB | `LIMITS.images` |
| 单条消息文档 | 10 个；txt ≤ 5MB、docx ≤ 20MB、pdf ≤ 50MB | `LIMITS.attachments.doc`、`maxFilesPerMessage` |
| 单次导入包 | 500MB | `DEFAULT_MAX_IMPORT_BYTES` |
| 单会话记忆 | 200 条、≤ 2MB | `LIMITS.memory` |

**没有上限的（决定最坏情况的就是这几项）**：会话数、每会话消息数、`files` 里的原件总数、`attachmentTexts` 的全文总量、`appAssets` 的数量。`importMaxBytes` 只限制**单个导入包**，不限制导入次数，因此不是库体积上限。

按「用户真能走完的路径」估一版上界，而不是纯理论无穷：

- 附件字节：导入路径一次 500MB，多次导入可叠加；加上聊天中逐个添加的图片原件（16MB 档）与文档原件（50MB 档）。取 **2GB** 作为「预检必须扛得住、再大就拒绝并提示用户先导出」的设计上界。
- 结构化数据（会话 JSON、摘要、附件元数据、记忆）：与附件相比小两个数量级，按 200MB 估（1 万个会话 × 每会话几十条消息的量级）。
- `attachmentTexts` 全文：每条文档解析后的正文，按附件字节的 1 倍估（纯文本通常远小于原件，1 倍是保守的偏高）。

### 4.2 迁移期间的磁盘与内存

磁盘（计划 §4 的公式：源估算 × 2 + 备份 + 余量）：

| 组成 | 估算 |
|---|---|
| 源（IDB，不动） | S |
| 备份（9 个 store 原样导出，含 Blob） | ≈ S |
| 目标 SQLite（含 512KiB 分块、sha256、索引；BLOB 分块有页浪费，按 1.3×S 估） | ≈ 1.3S |
| WAL（`synchronous=FULL` 仍可能在提交窗口里持有与单批同量级的 WAL） | 单批大小，可忽略 |
| 余量（文件系统与 WebView 自身） | 256MB |

S = 2GB 时峰值约 **2 + 2 + 2.6 + 0.25 ≈ 6.9GB**。这是设计上界，不是典型值；典型用户（几十 MB）按同一公式只需要几百 MB。

内存：复制按批走，内存峰值应为「一批的行 + 一个 Blob 的分块缓冲」，与 S 无关。**危险点是全量读**：`loadSessionSummaries`（`src/services/chat/db.ts` 里那个 `sessions` 的 `getAll()`）、校验器若把一个 store 的主键全量物化、备份若整库读进内存，都会在大库上 OOM。预检通过不等于内存安全，校验与备份必须流式（oracle 也是按批比较，见 `oracle.mjs`）。

### 4.3 预检阈值建议

- **拒绝线**：`freeBytes() < S×2 + 备份估算 + 256MB` 时 `insufficient-space`，不开始。S 取 `estimateBytes()`（契约要求只许偏高），备份估算按 S 计。
- **警告线**：`S > 200MB` 时在迁移页显示预计体积与所需空间，让用户决定是否先清理。200MB 这个数的来由：它是 25MB 备份配额的 8 倍，超过它的用户「系统备份里没有这份数据」几乎是肯定的，迁移是他们唯一的副本，值得多确认一次。
- **硬上界**：`S > 2GB` 直接拒绝并提示导出后删旧数据。理由：6.9GB 的峰值在中端机上不现实，与其迁到一半 `ENOSPC`，不如事先拒绝。
- 三个数都该进 `LIMITS`（仓库纪律：阈值只有一处），本审计不改 `limits.ts`（不在名下路径），请 lead 安排。

## 5. 需要 lead 决策的点

1. **D6 是否允许只升版本号**（3.4 第 1 条）。这是回滚保护里唯一论证成立的方案，但它触碰已定决策，本审计不实施。
2. **SQLite 库文件的落点**（`getDatabasePath()` 还是 `getFilesDir()`）必须在写第一个字节之前定，因为备份排除规则要按路径写，而排除规则必须随第一个写这些文件的版本发布。
3. **字符串与主键落库形式**（TEXT 会丢 NUL 与孤立代理项，主键会并行丢行、排序与 JS 不同，实测见 3.4 末尾）。若 schema 已规定用 JSON/BLOB，请在 `sqlite-schema.md` 里写明「TEXT 不可用于可能含 NUL 或孤立代理项的字段」；否则这是一个会静默丢数据的缺陷。
4. 预检的三个阈值（拒绝线公式、200MB 警告、2GB 硬上界）是否采纳，采纳的话进 `LIMITS`。
5. 已发布 APK 实物的 `capacitor.config.json` 抽查（1 节的未知项）由谁做。
