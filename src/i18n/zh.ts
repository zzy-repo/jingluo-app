export const zh = {
  welcomeMessageChat250808: '今天有什么可以帮到你？',
  contentCaveat: '内容由 AI 生成，请仔细甄别',
  modeSwitchLabel: '对话模式',
  modeFast: '快速模式',
  modeExpert: '专家模式',
  expandSiderbarButton: '打开边栏',
  collapseSiderbarButton: '收起边栏',
  newChat: '开启新对话',
  untitledChat: '新对话',
  sessionLoading: '正在加载对话...',
  sessionListLoadFailed: '对话列表加载失败，请重试',
  sessionLoadFailed: '对话加载失败，请重试',
  sessionSaveFailed: '对话或附件尚未保存到本机，关闭页面可能丢失，请重试',
  sessionDeleteFailed: '删除对话失败，请重试',
  settings: '设置',
  appName: '鲸落',
  deleteSessionModalContentTitle: '永久删除对话',
  deleteSessionWithFilesDescription: '删除后，该对话及其中上传的文件将不可恢复。确认删除吗？',
  cancel: '取消',
  delete: '删除',
  sessionItemMenuRenameOption: '重命名',
  sessionItemMenuPinOption: '置顶会话',
  sessionItemMenuUnpinOption: '取消置顶',
  sessionPinnedLabel: '已置顶',
  sessionPinnedGroup: '置顶会话',
  more: '更多',
  close: '关闭',
  sessionHistoryTimelineLabelToday: '今天',
  sessionHistoryTimelineLabelYesterday: '昨天',
  sessionHistoryTimelineLabel7days: '7 天内',
  sessionHistoryTimelineLabel30days: '30 天内',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败，请长按或选中文本后复制',
  copyTooLargeTitle: '内容过长，未复制',
  copyTooLargeBody:
    '这段内容约 {size} KiB，超过剪贴板能稳定写入的上限（{limit} KiB）；直接复制会被截断或静默失败，请改为保存 TXT 后查看。',
  copyTooLargeSave: '保存为 TXT',
  copySaveFailed: '保存失败，请重试或长按选中文本后复制',
  send: '发送',
  scrollToBottom: '回到底部',
  scrollToBottomHasNew: '回到底部（有新内容）',
  editMessage: '编辑消息',
  regenerate: '重新生成',
  continueGenerating: '继续生成',
  changeApiKey: '更换 API Key',
  /** 错误提示条里的「打开设置」入口（#347 / #353）：模型与接口配置都在「数据管理」 */
  openSettingsEntry: '打开设置',
  topUp: '前往充值',
  messageSearchSummary: '1 个网页',
  messageSearchSummaries: '{count} 个网页',
  messageVersions: '消息版本',
  previousVersion: '上一个版本',
  nextVersion: '下一个版本',
  searchResult: '搜索结果',
  mermaidDiagram: '图表',
  mermaidCode: '代码',
  mermaidEmpty: '图表为空',
  mermaidLoading: '图表生成中...',
  mermaidRenderFail: '渲染失败',
  mermaidSwitchLabel: 'Mermaid 图表与代码切换',
  toolSearchIntro: '搜索',
  messageSearching: '搜索中...',
  imageSearching: '图像搜索中...',
  searchStopped: '搜索已停止',
  toolSearchFail: '联网搜索暂不可用',
  toolSearchNoResult: '未搜索到合适内容',
  messageSearchNoResult: '未搜索到相关内容',
  toolSearch1Result: '搜索到 1 个网页',
  toolSearchResults: '搜索到 {count} 个网页',
  messageSearchResult: '已阅读 1 个网页',
  messageSearchResults: '已阅读 {count} 个网页',
  toolOpenOneIntro: '浏览 1 个页面',
  toolOpensIntro: '浏览 {count} 个页面',
  toolOpenFail: '浏览页面失败',
  toolOpenFailTooltip: '浏览失败',
  toolOpenViewAll: '查看全部',
  toolFindFail: '查找失败',
  toolFindIntro: '查找关键词',
  toolFindFailTooltip: '未查找到相关内容',
  readingLink: '正在阅读',
  commonNetworkErrorToast: '网络异常，请检查你的网络状况',
  /**
   * Key 失效（#374）：以前只有这一句「无效或已被删除」，把「格式错 / 不存在 / 被轮换」
   * 三种完全不同的处境说成同一件事。现在这一句只当**上游没说清原因**时的兜底，
   * 细分文案见下面 replyApiKey* 四个 key。
   */
  replyInvalidApiKey: '上游拒绝了这把 API Key，但没说明具体原因（可能无效、已过期或不属于当前服务地址）',
  /** Key 格式不对（#374）：本地就能判，请求根本没发出去 */
  replyApiKeyFormatWrong:
    '当前填写的 API Key 格式不对（含空格、换行，或长度不像一把 Key），请求还没有发到上游',
  /** Key 不存在 / 已被服务端删除（#374） */
  replyApiKeyNotFound: '这把 API Key 无效或已被删除（上游查不到它：没绑定成功，或已被服务端删除）',
  /**
   * Key 被轮换 / 吊销（#374 的 `rotated` 档）。
   *
   * #451 校对（与 #357 对齐）：本机设置里的「重置额度」（`/rotate`）**不换 Key**、只重算额度，
   * 所以这条失效**不是**用户在这里点出来的 —— 是服务端那边把旧 Key 作废了。旧文案那句
   * 「换 Key 时旧 Key 会立即作废」是 #90 时代的说法，留着会让用户以为「点了重置把我的 Key 弄废了」。
   */
  replyApiKeyRotated:
    '这把 API Key 已被轮换或吊销，旧的已经失效（本机「重置额度」只重算额度、不换 Key，所以是服务端那边作废的）；可以在「我们的渠道」里按设备码重新取回当前 Key，或直接换一把新 Key',
  /** 提示里的 Key 身份：只说尾 4 位，让用户确认「是哪把 Key 出问题」（#374） */
  replyApiKeyTailNote: '（当前 Key 尾号 {tail}）',
  /**
   * 换 Key 之前的提醒（#374）：用户最怕的是「换 Key 把额度弄丢」，
   * 所以文案必须说清额度归账号 / 设备、并且先在额度面板确认当前账号。
   */
  replyApiKeyQuotaNote:
    '换 Key 会影响额度归属，请先在额度面板确认当前账号，再决定是否更换',
  /** Key 失效提示里的「先看额度」入口（#374）：落到额度面板 / 充值页，不动 Key */
  openQuotaPanel: '查看额度',
  replyInsufficientBalance: '余额或额度不足，无法继续生成（不要重试，充值后再发）',
  /** 额度不足提示里的出路入口（#299）：复用「额度与卡密」弹层，充值套餐与卡密兑换都在里面 */
  quotaTopUpEntry: '去充值 / 兑换卡密',
  /**
   * 限流（#347 补状态码）：429 是**可重试**的临时故障，与终态错误的「不要重试」必须能分辨。
   * 码写进文案而不只在日志里：用户贴进反馈群时，「HTTP 429」比「请求过于频繁」更能自证。
   */
  replyRateLimited: '请求过于频繁（HTTP 429，临时限流，可以重试）：等一会儿再发，或点重新生成',
  completionServerBusyToast: '服务器繁忙，请稍后再试',
  /** 回答失败时的「服务器繁忙」（#324）：显式写明可重试，与终态错误的「不要重试」区分开 */
  replyServerBusy: '服务器繁忙，属于临时故障，回答没有完成，可以重试（点重新生成）',
  replyUnknownError: '回答没有完成，出现了未知错误，可以重新生成',
  /** 上下文超出模型上限（#122）：重试没用，给两条能走的路 */
  replyContextLimit:
    '这段对话已经超出模型的上下文上限，这次请求没能发出去。可以开一个新会话继续，或者删掉几条较早的消息后再试',
  replyStreamInterrupted:
    '连接中断，回答没有接收完整；已收到的内容已保留，属于临时故障，可以重试（点重新生成）',
  /** 空响应（#324）：上游 200 却什么内容都没给，换条连接通常就好 */
  replyEmptyStream: '上游这次没有返回任何内容（空响应）；属于临时故障，可以重试（点重新生成）',
  /** 内容安全拦截（#324）：原文重发一定还是被拦，所以明说不要重试 */
  replyContentFiltered:
    '这条内容被上游安全审核拦截了：改一下措辞或删掉敏感内容再发。原来的内容不要重试，重发同样会被拦',
  /**
   * 模型不存在 / 已下线（#324 / #339）：带上**实际发出的模型名**与上游给出的可用列表。
   * 内置渠道（官方）设置页没有模型行，所以文案要明说「升级到已修复版本」而不是让人去改设置。
   */
  replyModelInvalid:
    '当前模型「{model}」在上游不可用（模型名可能已下线）；上游可用模型：{models}。DeepSeek 官方渠道用的是内置模型，设置里没有这一行，升级到已修复版本即可；其它渠道请在设置里换一个模型再发，重试同一个请求不会有变化（不要重试）',
  /** 上游那句话里没有可解析的列表时（#339） */
  replyModelInvalidNoModels: '上游未提供列表',
  /** 回复里没记录模型名（导入的历史回复）时（#339） */
  replyModelUnknownName: '未记录',
  /** 其它被上游拒绝的请求（#347）：400 / 422 参数错误里上游**没说清字段**时用 */
  replyBadRequest:
    '请求参数有误（{status}）：这是请求被上游拒绝（不是网络问题，也不是我们服务端故障），重试不会有变化，请检查设置里的模型与接口配置（不要重试）',
  /**
   * 参数 / 字段不合法且上游**点出了字段名**（#347 / #353）：把字段直接写进文案，
   * 用户才知道该改哪一项，而不是被笼统地叫去「检查设置」。
   */
  replyParamInvalid:
    '请求参数有误（{status}）：上游指出字段「{field}」不合法 —— 这是请求被上游拒绝（不是网络问题，也不是我们服务端故障），重试不会有变化（不要重试）',
  /**
   * 其余被上游拒绝的 4xx（#347）：403 / 404 / 405 / 409 / 415。
   * 文案不再猜原因（这类状态里既有权限、也有路径与方法），只说「上游拒绝了请求」，
   * 具体原因放在折叠区的上游原文里。
   */
  replyUpstreamRejected:
    '上游拒绝了这条请求（{status}）：重试不会有变化（不要重试）；展开下面的上游原文可以看到具体原因，或点「复制诊断信息」反馈给我们',
  /** 流内错误帧没有 HTTP 状态码时，文案里的状态占位（#347） */
  replyUpstreamStatusUnknown: '上游未给出状态码',
  /** 折叠区开关：默认收起，用户主动展开才看到上游原文（#347 / #353） */
  upstreamDetailToggle: '查看上游原文',
  /** 未识别但**有**状态码 / 上游 code（#324）：把可自证的信息摆出来，并按是否可重试分两档文案 */
  replyUnclassifiedRetryable: '回答没有完成：{detail}，属于临时故障，可以重试（点重新生成）',
  replyUnclassifiedFatal:
    '回答没有完成：{detail}，重试不会有变化（不要重试），请先检查设置，或用「复制诊断信息」反馈给我们',
  replyWaitingFirstToken: '正在等待响应',
  replyWaitingSlow: '服务响应较慢，仍在等待',
  replyWaitingStalled: '等待时间过长，可以停止后重新生成',
  /**
   * 三段超时（#568）：**每段一句**，用户能看出到底卡在哪一段，而不是一句笼统的「超时」。
   * 秒数由实现按实际阈值注入（connect / first_token / idle 各用各的数字），文案里不写死。
   */
  replyIdleTimeout: '等待时间过长：连续 {seconds} 秒没有收到新内容，可以停止后重新生成',
  replyFirstTokenTimeout: '已连上上游，但 {seconds} 秒内没等到第一个字，可以重新发送或稍后再试',
  /** 首字前的阶段名（#328）：和三档提示一起显示，秒数由 waitElapsed 注入，不写死 */
  waitStagePreparing: '正在准备请求',
  waitStageUploading: '正在上传附件',
  waitStageConnecting: '正在连接上游，等待响应',
  waitStageAwaitingFirstToken: '已连接，等待模型首字',
  waitStageThinking: '模型正在思考',
  waitElapsed: '已等待 {seconds}s',
  /** 自动重试进度：请求失败后不会静默卡住（#105） */
  chatRetrying: '正在第 {attempt} 次重试（共 {limit} 次）',
  replyRefused: '你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。',
  messageThinkDuration: '已思考（用时 {count} 秒）',
  messageThinkDurationPlural: '已思考（用时 {count} 秒）',
  messageThinkStopped: '已停止',
  deepSearchSearching: '正在搜索',
  groupTitleToolOpen: '正在浏览网页',
  messageThinking: '正在思考',
  backupInvalidJson: '文件不是有效的 JSON',
  backupUnrecognized: '无法识别该文件，请选择 DeepSeek 导出的历史对话 ZIP 文件',
  backupNewerVersion: '文件版本过新，请升级后再导入',
  backupInvalidVersion: '文件版本无效，无法导入',
  backupIncomplete: '文件内容不完整，无法导入',
  backupInvalidBranches: '文件中的消息分支已损坏，无法导入',
  backupInvalidFiles: '文件中的附件数据已损坏，无法导入',
  backupManifestNotFirst: '导入包的第一个文件是「{found}」，不是必需的「{expected}」；请选择 DeepSeek 导出的原始 ZIP，不要解压后重新打包',
  backupEmptyArchive: 'ZIP 里没有任何文件，请选择 DeepSeek 导出的历史对话 ZIP 文件',
  backupArchiveDamaged: 'ZIP 结构损坏：读取第 {index} 个文件「{entry}」时校验失败，文件可能被截断或被其它工具重新打包',
  backupArchiveUnreadable: 'ZIP 结构损坏：读不到文件目录，文件可能被截断或被其它工具重新打包',
  backupEntryOutOfOrder: '第 {index} 个文件「{entry}」排在会话「{session}」之后，却不属于该会话的图片目录；会话索引还没读到，无法判断它属于哪个会话。请选择 DeepSeek 导出的原始 ZIP，不要解压后重排文件',
  backupEntryUnreferenced: '第 {index} 个文件「{entry}」既不是会话文件，也不属于任何已导入会话的图片目录；导入包可能被重排或改过名，请选择 DeepSeek 导出的原始 ZIP',
  settingsLocalePreference: '语言',
  settingsTtsVoice: '朗读音色',
  settingsTtsVoiceStella: '海星（女声）',
  settingsTtsVoiceTide: '暗潮（男声）',
  settingsLocation: '位置信息',
  settingsLocationProvince: '请选择省份/地区',
  settingsLocationCity: '请选择市',
  settingsLocationRegion: '请选择国家或地区',
  settingDialogAsideGeneralOptionLabel: '通用设置',
  settingDialogAsideMemoryOptionLabel: '记忆',
  settingDialogAsideDataOptionLabel: '数据管理',
  avatarMenuSettingsDialogThemeItemLabel: '主题',
  avatarMenuSettingsDialogThemeSelectLightOption: '浅色',
  avatarMenuSettingsDialogThemeSelectDarkOption: '深色',
  avatarMenuSettingsDialogThemeSelectSystemOption: '跟随系统',
  apiKeyStart: '输入 API Key 开始使用',
  apiKeyEdit: '修改 API Key',
  apiKeyPlaceholder: '请输入 API Key',
  apiKeyVerifying: '正在验证...',
  confirm: '确定',
  apiKeyInvalid: 'API Key 无效，请检查后重试',
  apiKeyVerificationFailed: '校验失败：{message}',
  historyImport: '导入历史对话',
  historyImportConfirm: '确认导入',
  historyImportConfirmTitle: '确认导入历史对话？',
  historyImportConfirmDescription: '导入前请先选择导入方式：合并会保留本地会话，整包覆盖会清除本地全部会话。',
  historyImportDescription:
    '导入历史对话时会先选择导入方式（合并 / 跳过已存在 / 整包覆盖），支持 DeepSeek 导出的 ZIP 文件。',
  historyImportModeLabel: '导入方式',
  historyImportModeMerge: '合并（推荐）',
  historyImportModeMergeHint: '保留本地全部会话；同一会话按更新时间取舍，包内更新的才覆盖',
  historyImportModeSkip: '跳过已存在',
  historyImportModeSkipHint: '本地已有同一会话的保持不动，只导入本地没有的',
  historyImportModeOverwrite: '整包覆盖',
  historyImportModeOverwriteHint: '清空本地现有 {count} 条会话与附件后导入，等于还原备份',
  historyImportOverwriteAcknowledge: '我已了解，本地现有 {count} 条会话将被清除',
  historyImportConfirmOverwrite: '确认覆盖导入',
  historyImportConflictRule:
    '同一会话只按会话 ID 判定：ID 相同才算同一条；标题相同但 ID 不同视为两条不同会话。',
  historyImportSummaryDetail: '（新增 {added} / 覆盖 {overwritten} / 跳过 {skipped}）',
  historyImportConflictSkippedTitle: '保留了本地版本的会话（同 ID 且本地更新）',
  historyExportEmptySelection: '没有勾选任何会话，无法导出',
  historyExportSelectedCount: '已选 {count} 条',
  historyExportSelectedEmpty: '请先勾选要导出的会话',
  historySelectModeEnter: '选择',
  historySelectModeExit: '退出选择',
  historySelectAll: '全选',
  historySelectInvert: '反选',
  historyExportSelected: '导出选中',
  // #536：选中导出改为和老出口同一个落盘函数后，提示要带上**真正写下去的文件名**
  // （Android 的 SAF 面板可能按重名规则改名；只报条数的话，用户无从确认文件到底落没落盘）。
  historyExportSelectedSaved: '已导出 {count} 条会话，文件：{name}',
  historyImportedOne: '已导入 1 个会话',
  historyImported: '已导入 {count} 个会话',
  historyImportFromUrl: '从链接导入',
  historyImportUrlStart: '导入',
  historyImportUrlDescription:
    '粘贴 DeepSeek 导出的 ZIP 下载链接，由 App 直接下载后导入（仅 Android App 支持）。',
  historyImportUrlPlaceholder: 'https://…/deepseek_data.zip',
  historyImportUrlDownloadingProgress: '正在下载… {done}/{total}（{percent}%）',
  historyImportUrlDownloadingBytes: '正在下载… 已下载 {done}',
  historyImportUrlDecoding: '正在解析…',
  historyImportUrlImporting: '正在导入… {processed}/{total} 个会话',
  historyImportUrlImportingCount: '正在导入… 已处理 {processed} 个会话',
  historyImportUrlExpired: '下载链接已过期，请回到 DeepSeek 重新导出后再试',
  historyImportUrlBadSignature: '链接无效（签名错误），请重新复制完整链接',
  historyImportUrlForbidden: '没有权限访问该链接（403）：{detail}',
  historyImportUrlOffline: '网络已断开，请检查网络后重试',
  historyImportUrlRefused: '连接被拒绝：服务器没有接受连接（服务未启动或被防火墙拦截），请稍后重试',
  historyImportUrlInterrupted: '网络连接中断（已下载 {percent}%），请检查网络后重试',
  historyImportUrlTimeoutPartial: '下载超时（已下载 {percent}%），请换更快的网络',
  historyImportUrlStalled:
    '下载停滞：最近 {seconds} 秒没有收到新数据（已下载 {done} / 共 {total}），可重试',
  historyImportUrlStalledUnknownTotal:
    '下载停滞：最近 {seconds} 秒没有收到新数据（已下载 {done}），可重试',
  historyImportUrlDeadline:
    '下载超时：已超过 {minutes} 分钟上限（已下载 {done} / 共 {total}），可重试',
  historyImportUrlDeadlineUnknownTotal:
    '下载超时：已超过 {minutes} 分钟上限（已下载 {done}），可重试',
  historyImportUrlRestarted: '该链接不支持断点续传，已从头重新下载',
  historyImportUrlResumed: '已从上次中断的地方继续下载（已下载 {done}）',
  historyImportCancelled: '导入已取消',
  importTraceTitle: '导入详情（{count} 条）',
  importTraceCopy: '复制详情',
  importTraceElapsed: '耗时 {time}',
  importTraceStart: '开始导入',
  importTraceDownload: '已下载 {done}',
  importTraceDownloadTotal: '已下载 {done} / {total}',
  importTraceCheck: '校验归档结束，共 {total} 个会话',
  importTraceCheckUnknown: '校验归档中…',
  importTraceSession: '导入会话 {done}/{total}',
  importTraceSessionUnknown: '导入会话 {done} 个',
  importTraceImage: '写入图片 {count} 张',
  importTraceDone: '完成，共 {count} 个会话',
  importTraceCancel: '已取消',
  importTraceError: '失败（{stage}）：{reason}',
  importTraceStageDownload: '下载',
  importTraceReasonUnreachable: '无法连接网络',
  importTraceReasonInterrupted: '连接被中断',
  importTraceReasonTimeout: '下载超时',
  importTraceReasonNetwork: '网络错误',
  importTraceReasonExpired: '链接已过期',
  importTraceReasonSignature: '签名错误',
  importTraceReasonForbidden: '没有权限（403）',
  importTraceReasonHttp: 'HTTP {status}',
  importTraceReasonStalled: '下载停滞（最近 {seconds} 秒无新数据，已下载 {done}）',
  importTraceReasonDeadline: '下载超时（超过 {minutes} 分钟上限）',
  importTraceHeartbeat: '仍在下载…（已下载 {done} / {total}，已 {idle} 秒没有新数据）',
  importTraceHeartbeatUnknown: '仍在下载…（已下载 {done}，已 {idle} 秒没有新数据）',
  importTraceResume: '从已下载的 {done} 处继续（不清零）',
  importTraceRestart: '该链接不支持断点续传，已从头重新下载',
  detailsExpand: '展开',
  detailsCollapse: '收起',
  historyImportUrlDownloading: '下载中...',
  historyImportUrlDownloadingHint:
    '正在下载并导入，20MB 左右的导出包可能需要几十秒，期间请保持页面打开。',
  historyImportFromUrlFailed: '从链接导入失败：{message}',
  historyImportUrlInvalid: '请输入以 http:// 或 https:// 开头的链接',
  historyImportUrlNativeOnly: '网页版不支持链接导入，请下载 ZIP 后手动上传',
  historyImportUrlNetwork: '下载失败，请检查网络连接后重试',
  historyImportUrlTimeout: '下载超时，请检查网络后重试',
  historyImportUrlHttp: '链接返回了异常状态（HTTP {status}），请确认链接是否仍然有效',
  historyImportUrlTooLarge: '文件过大（{size}MB），实测 {actual}，已停止导入',
  historyImportUrlNotZip: '该链接不是有效的 ZIP 文件',
  historyImportUrlBadResponse: '下载返回的数据无法解析，请重试',
  historyImportUrlWebHint: '网页版无法直接下载导出链接，请手动下载 ZIP 后上传。',
  historyImportFailed:
    '文件导入失败，可能是文件格式错误或使用了旧版的对话导出 ZIP 文件，请前往 DeepSeek 重新导出历史对话文件后再次导入。',
  historyExportFailed: '导出失败：{message}',
  historyExportSaved: '已保存到你选择的位置：{name}',
  historyExportFailedStart: '导出失败：无法打开保存位置，请重试',
  historyExportFailedWrite: '导出失败：写入文件失败，请检查剩余存储空间后重试',
  historyExportFailedTooLarge: '导出失败：归档超过 200MB 导出上限（与导入上限一致），请先删减历史对话后重试',
  historyExportTooLarge:
    '当前历史约 {actual}，超过 {size}MB 导出上限。请先删除不需要的对话，或删掉消息里的大图后再试。',
  historyExporting: '导出中…',
  historyExportProgress: '已导出 {exported} / 共 {total} 个对话',
  historyExportEmptyNoSessions: '当前没有可导出的对话',
  exportAllLabel: '导出所有历史对话',
  historyExportDescription:
    '包含所有历史对话及本地图片原件；其他附件仅保留文件信息，不包含 API Key。',
  exportAllDownload: '下载',
  deleteAllSessions: '删除所有对话',
  deleteAllSessionsModalTitle: '删除后，所有对话都将被清空且无法找回',
  deleteAllSessionsModalDescription: '本地保存的附件及未发送的草稿也将被删除。',
  historyDeleting: '删除中...',
  historyDeleted: '删除成功',
  historyDeleteFailed: '删除失败，请重试',
  upload: '上传',
  uploadUnsupportedFormat:
    '上传的文件包含暂未支持的文件格式，请转换文件格式后重试。支持 PDF、DOC、XLSX、PPT、图片、文本、代码等。',
  uploadFileStatusFailed: '上传失败',
  /**
   * #379：上传失败必须点名 —— **哪个附件 + 原因**。以前四种完全不同的失败都只剩一句「上传失败」，
   * 用户不知道该重试、换格式，还是干脆删掉这条附件。
   */
  uploadFailedSourceMissing: '附件「{name}」没有可发送的本机原件（导入的历史会话只保留文件信息），已跳过',
  uploadFailedEndpointMissing: '附件「{name}」上传失败：当前渠道没有上传端点（404）',
  uploadFailedTooLarge: '附件「{name}」上传失败：文件超过大小上限',
  uploadFailedNetwork: '附件「{name}」上传失败：网络异常，请重试',
  uploadFailedUnknown: '附件「{name}」上传失败',
  /** #379：消息里那条持久提示（不是 toast）——说的是「哪几个附件没跟着发」，不是「发送失败」 */
  attachUnavailableSent: '{names} 在本机不可用（导入的历史会话只保留文件信息），本条已按纯文字发送',
  /** #379：附件全被跳过、又没有文字可发时，明说而不是发一条空消息 */
  attachUnavailableNoText: '附件在本机不可用，且这条消息没有文字内容，未发送',
  /** 该渠道没有 Files API（#303）：入口禁用时的提示，以及上传路径走到这里时的失败原因 */
  uploadChannelUnsupported: '当前渠道不支持文件上传，附件入口已不可用',
  uploadRetry: '{message}，点击重试',
  chatInputPlaceholderChat: '请输入消息',
  deactivatedThinkTooltip: '先思考后回答，解决推理问题',
  thinkingSwitch: '深度思考',
  deactivatedSearchTooltip: '按需搜索网页',
  search: '智能搜索',
  uploadFile: '上传文件',
  chatInputStopButtonTooltip: '停止生成',
  uploadMaxMBSize: '单个文件大小超过限制（{size}MB），请调整后重试',
  uploadMaxFiles: '上传文件最多支持 {count} 个',
  uploadFileStatusUploading: '上传中...',
  uploadServerBusy: '服务器繁忙',
  uploadParseFailed: '解析失败',
  /**
   * `{formats}` 由 `IMAGE_MEDIA_TYPES` 派生（`imageSource.ts` 的 `IMAGE_FORMAT_LABELS`）：
   * 白名单里有的格式必须在这句里都出现（GIF 曾漏写，见 #580）。
   */
  imageUnsupportedFormat: '不支持的图片格式：仅支持 {formats}（HEIC 请先转成 JPEG）',
  imageDecodeFailed: '这张图片无法打开，请换一张或先转成 PNG / JPEG',
  imageTooLarge: '图片压缩后仍超过 {size}MB，请先压缩或裁剪后再发',
  imageAnimatedTooLarge: '动图超过 {size}MB 或尺寸过大，压缩会把动画拍成静帧，请先压缩后再发',
  imageEncodeFailed: '图片编码失败，请重试或换一张',
  imageSourceMissing: '这张图片的本地原件已丢失，无法发送，请重新添加',
  imageTooMany: '单条消息最多 {count} 张图片',
  imageTotalTooLarge: '本轮图片总量超过 {size}MB，请减少图片数量',
  /** base64 渠道（#551）根本没有上传端点：非图片文件在这类渠道上只能明说发不了 */
  uploadImageOnly: '当前渠道只支持发送图片，文档附件请切换到支持的渠道',
  visionUnsupported: '当前渠道不支持图片，请切换到支持图片的渠道或模型',
  uploadFileCountLimit: '已上传文件数达到上限（{limit} 个），可 ',
  uploadStorageLimit: '已上传文件占用空间达到上限（{limit}GB），可 ',
  uploadDeleteFiles: '删除文件',
  dragFileToUpload: '文件拖动到此处即可上传',
  dragFileDesc: '最多 {count} 个，每个 {size}MB',
  voiceInput: '语音输入',
  voiceInputTimer: '录音中 {seconds}s',
  voiceInputStop: '结束录音并转写',
  voiceInputCancel: '正在转写，点击取消',
  voiceInputPermissionDenied: '无法使用麦克风，请在浏览器设置中允许访问',
  voiceInputNoDevice: '未检测到麦克风',
  voiceInputFailed: '语音识别失败，请稍后再试',
  voiceInputEmpty: '未识别到语音内容',
  voiceInputLimitReached: '已达到单次录音时长上限',
  voiceInputRequiresHttps: '非 HTTPS 页面无法使用语音输入',
  /** #451：判据与出路一起说清 —— 「换一把」之外还有「按设备码取回本机那把」这条路（#357 之后仍然成立） */
  apiKeyInvalidRetry: 'API Key 无效，请重新填写；或在「我们的渠道」里用「重置额度」按设备码取回本机 Key',
  /** 上游 401 之后的统一提示（#303 问题 3）：既要说明原因，也要说明下一步怎么修 */
  apiKeyRejected: 'Key 无效或已过期，请重新登录或重新填写',
  /** #596：我们的渠道没有可填的地方，401 的出路只有一个 —— 重新领取 */
  apiKeyRejectedOurs: '我们的渠道的 Key 已失效：请在设置里点「重新领取」，由服务端重新下发',
  insufficientBalance: '账户余额不足',
  rateLimited: '操作过于频繁，请稍后再试',
  ttsPlay: '朗读',
  ttsStop: '停止朗读',
  ttsUnavailable: '这条回答暂时无法朗读',
  ttsFailed: '朗读失败，请稍后再试',
  retry: '重试',
  latestReminderLanguage: '中文',
  settingsLocaleZhCN: '简体中文',
  settingsLocaleEnUS: 'English',

  // ---------- 服务配置（渠道 / API Key / 服务地址 / 模型） ----------
  settingsProviderKindLabel: '渠道',
  settingsProviderKindKeyHint: '切换渠道后，请确认 API Key 是否适用',
  settingsApiKeyLabel: 'API Key',
  /**
   * 发送前本地拦截（#451 第 2 点）：Key 有、但格式明显不对 → 消息**没有发出去**。
   * 必须写明「没发出去」：否则用户只会以为是网络或上游问题，然后不停地重发同一条消息。
   */
  settingsApiKeyFormatBlocked:
    '当前填写的 API Key 格式不对（含空格、换行，或长度不像一把 Key），这条消息没有发出去。请清空后重新粘贴一把完整的 Key（去掉空格 / 换行），再发送。',
  /** 只是存着一条可疑的 Key（还没试过发送）：普通提示，不用红字吓人 */
  settingsApiKeyFormatHint:
    '这一行的内容不像一把 API Key（可能多了空格 / 换行，或没复制完整），发送前会被拦下来。',
  /**
   * #596：「我们的渠道」的 API Key 由服务端下发 —— 界面只读（当前尾号）+「重新领取」，
   * 没有输入框。文案里**不许**出现「服务器繁忙」「未知错误」这类掩盖性说法：
   * #596 第 1 条事故就是用户拿着旧 Key 一直 401，却被告知「服务器忙」。
   */
  settingsManagedKeyValue: '当前 Key ···{tail}',
  settingsManagedKeyUnclaimedValue: '尚未领取 Key',
  settingsManagedKeyHint: '由设备自动领取，无需填写；如需更换请重新领取',
  settingsManagedKeyClaim: '重新领取',
  settingsManagedKeyClaiming: '正在领取…',
  settingsManagedKeyClaimed: '已领取，当前 Key 尾号 ···{tail}',
  settingsManagedKeyStale: 'Key 已更新，请重新领取',
  settingsManagedKeyBlockedClaim:
    '请先领取 Key：这条消息没有发出去。我们的渠道的 Key 由服务端下发，不能手填。',
  settingsManagedKeyBlockedStale:
    'Key 已更新，请重新领取：本地这把已经不是服务端下发的那把，这条消息没有发出去。',
  settingsManagedKeyClaimFailed: '领取失败：{message}',
  settingsManagedKeyNeedLogin: '请先在「账户与消费 → 账号」登录，再领取 Key。',
  settingsBaseUrlLabel: '服务地址',
  settingsBaseUrlPlaceholder: '例如 https://your-gateway.example.com',
  settingsModelPlaceholder: '例如 deepseek-v4.1-flash',
  settingsBaseUrlRequired: '请先填写服务地址',
  settingsTestLabel: '连通性测试',
  settingsModelLabel: '模型',
  /**
   * 内置模型的只读行（#339）：官方渠道没有模型输入行，至少要让人看见当前用的是哪个。
   * 只读 + 不可编辑（setModel 拒写），所以提示只说「无需填写」，不说「去改」。
   */
  settingsModelBuiltInHint: '只读；本渠道无需填写',
  settingsBaseUrlInvalid: '服务地址必须以 http:// 或 https:// 开头，并且是合法地址',
  settingsModelInvalid: '模型不能为空',
  settingsModelsLoading: '加载中…',
  settingsModelsRefresh: '刷新',
  settingsModelsEmpty: '接口返回空模型列表，可直接手动输入。',
  settingsModelsFailed: '模型列表加载失败，可直接手动输入。',
  settingsModelsAvailable: '可选模型',
  settingsTest: '测试',
  settingsTesting: '测试中…',
  settingsTestOk: '连接成功（HTTP {status}），共 {count} 个模型：{models}',
  settingsTestOkEmpty: '连接成功（HTTP {status}），但接口没有返回模型列表',
  settingsTestHttp: '请求失败（HTTP {status}）：{message}',
  settingsTestTimeout: '连接超时，请检查地址与网络后再试',
  settingsTestNetwork: '无法连接：{message}（地址错误、服务未启动或被跨域策略拦截）',
  settingsTestBadJson: '返回的不是 JSON：{message}',
  settingsTestApiKeyRequired: '请先填写 API Key',
  settingsTestHtml: '请求返回的是网页（HTTP {status}），不是接口数据；通常是服务地址的路径不匹配或服务异常',
  /**
   * 上游返回的是网页而不是数据（#434）：200 + text/html 的网关首页 / 报错页。
   * 说人话 —— 不是「协议不对」，而是「你打到的地方不是接口」，并且这条路重发没用。
   */
  upstreamReturnedHtml:
    '上游返回的是网页而不是数据，通常是网关或代理出错（接口地址填错了也会这样）；重试同一个请求不会有变化（不要重试），展开下面的响应摘要可以看到返回的内容类型与前 200 字',

  // ---------- 聊天背景 ----------
  settingsChatBackground: '聊天背景',
  settingsChatBackgroundDescription: '图片只保存在本机（IndexedDB），不会上传；最长边压缩到 1600px',
  settingsChatBackgroundUpload: '上传',
  settingsChatBackgroundClear: '清除',
  settingsChatBackgroundSaved: '已应用到聊天区域',
  settingsChatBackgroundCleared: '已清除，聊天区域恢复默认背景',
  settingsChatBackgroundFailed: '图片处理失败，请换一张 JPG/PNG 图片再试',
  settingsChatBackgroundClearConfirm: '确认清除当前聊天背景？',

  // ---------- 反馈与日志 ----------
  feedbackCellLabel: '反馈与日志',
  feedbackCellDescription: '提交问题反馈时会附上最近的操作日志（已在本机脱敏），不包含对话内容与 API Key',
  feedbackCellAction: '写反馈',
  feedbackDialogTitle: '反馈与日志',
  feedbackDescriptionLabel: '问题描述',
  feedbackDescriptionPlaceholder: '遇到了什么问题？可以写清复现步骤',
  feedbackDescriptionRequired: '请先填写问题描述',
  feedbackCategoryLabel: '分类',
  feedbackCategoryBug: '问题反馈',
  feedbackCategoryFeature: '功能建议',
  feedbackCategoryOther: '其他',
  feedbackLogPreview: '日志预览',
  feedbackLogCount: '共 {count} 条',
  feedbackLogPreviewHint: '密钥与签名参数已在本机脱敏；筛选与搜索只影响预览，提交内容不变',
  feedbackLogEmpty: '暂无本地日志',
  feedbackLogSummary: '显示最近 {shown} 条，共 {total} 条，提交上限 {limit} 条',
  feedbackLogSearchLabel: '搜索日志',
  feedbackLogSearchPlaceholder: '搜索正文或 meta 值（如 url.path、404、timeout）',
  feedbackLogFilterLevel: '按级别过滤',
  feedbackLogFilterKind: '按事件类型过滤',
  feedbackLogFilterClear: '清除筛选',
  feedbackLogGroupToggle: '按操作分组',
  feedbackLogGroupNote: '暂无 traceId：按「间隔 ≤2 秒 + 同 kind 族」保守分组，属过渡方案',
  feedbackLogGroupChat: '一次对话交互',
  feedbackLogGroupNet: '一次网络请求',
  feedbackLogGroupImport: '一次导入',
  feedbackLogGroupMisc: '其他记录',
  feedbackLogGroupCount: '{count} 条',
  feedbackLogNoMatch: '没有匹配的日志',
  feedbackLogFew: '本地日志只有 {count} 条（可能刚启动或刚清空）',
  feedbackLogCopyEntry: '复制这条日志',
  feedbackLogCopied: '日志已复制（含完整 meta）',
  feedbackLogTruncated: '匹配 {matched} 条，只显示最近 {shown} 条',
  feedbackExport: '导出反馈日志',
  feedbackSaveFile: '保存日志文件',
  feedbackExportBusy: '正在保存…',
  feedbackExportHint: '离线保存脱敏 JSON：含版本、设备、分类、日志及当前提交失败信息；不含描述、联系方式、截图、聊天正文与支付原文。保存不代表已提交。',
  feedbackExportWebSaved: '已发起下载：{filename}。请到浏览器下载列表或“下载”文件夹查看；反馈尚未因此提交。',
  feedbackExportNativeSaved: '已保存到系统文件选择器中所选位置：{filename}。反馈尚未因此提交。',
  feedbackExportCancelled: '已取消保存，日志和填写内容已保留。',
  feedbackExportFailed: '保存失败，日志和填写内容已保留，请重试。',
  feedbackExportReadFailed: '读取最新日志失败，已保留并导出当前预览快照。',
  feedbackExportTruncated: '文件达到 4 MiB 上限，已标记裁剪及省略条数。',
  feedbackTransport: '上传通道：{name}',
  feedbackScreenshot: '截图（可选）',
  feedbackScreenshotPick: '从相册选择',
  feedbackScreenshotRemove: '移除',
  feedbackScreenshotFailed: '图片处理失败，请换一张再试',
  /** 选错文件（.txt / .pdf / .zip）：明确拒绝，不当截图收下（#388） */
  feedbackScreenshotNotImage: '只能附图片截图：请选择 png / jpg / webp 这类图片文件',
  /** 声明是图片但解不开：改过后缀的假图 / 损坏文件（#388） */
  feedbackScreenshotUndecodable: '这张图片打不开（可能已损坏或不是真的图片），请换一张再试',
  feedbackScreenshotReady: '已压缩后附上',
  feedbackSubmit: '提交',
  feedbackSubmitting: '提交中…',
  feedbackTicketLabel: '已提交，工单号',
  feedbackTicketLogSize: '（日志 {size}）',
  feedbackDone: '完成',
  feedbackClearLogs: '清空本地日志',
  feedbackLogsCleared: '本地日志已清空',
  feedbackErrorNetwork: '网络失败：连不上反馈服务，请检查网络后重试',
  feedbackErrorTimeout: '请求超时，请稍后重试',
  feedbackErrorTooLarge: '截图、描述或关键日志超过上传预算（180 KiB）或服务端上限；请缩小截图或减少描述后重试，截图不会被自动移除',
  feedbackErrorUnauthorized: '上传凭证无效，请稍后重试或联系维护者',
  feedbackErrorRateLimited: '提交过于频繁，请稍后再试',
  feedbackErrorServer: '服务端异常，请稍后再试',
  feedbackErrorRejected: '反馈被服务端拒绝，请检查内容后重试',
  feedbackErrorUnknown: '上传失败，请稍后重试',

  feedbackIntegrityCheck: '检查日志完整性',
  feedbackIntegrityTitle: '日志完整性自检',
  feedbackIntegrityCount: '条数：{count}（上限 500，保留最近 30 分钟）',
  feedbackIntegritySpan: '时间跨度：{span}',
  feedbackIntegrityKinds: '覆盖事件类型：{count} 类',
  feedbackIntegrityKindList: '已覆盖：{kinds}',
  feedbackIntegrityMissing: '缺失项：{kinds}',
  feedbackIntegrityNone: '无',
  feedbackWarningsTitle: '提交前提示（不影响上传）',
  feedbackWarningFewLogs: '日志偏少，建议描述复现步骤',
  feedbackWarningNoNetwork: '未捕获到网络记录',
  feedbackWarningShortSpan: '时间跨度不足 1 秒，可能刚启动，日志信息有限',
  feedbackActionsLabel: '最近动作：{actions}',
  feedbackContactLabel: '联系方式（可选）',
  feedbackContactPlaceholder: '邮箱或微信，方便我们联系你',
  // ---------- 反馈草稿：取消不丢，重开回填（Issue #31） ----------
  feedbackDraftRestored: '已恢复上次未提交的内容',
  feedbackDraftScreenshotHint: '上次选的图片不会保留，需要重新选择',
  feedbackDraftClear: '清空已填内容',
  feedbackDraftClearHint: '清空问题描述、联系方式与截图；下次打开不再回填',
  feedbackDraftClearConfirm: '确定清空已填内容？清空后无法恢复',
  feedbackDraftCleared: '已清空填写内容',
  // #261：同一设备指纹再次领取时服务端没发新额度。**绝不能**显示「领取成功」——
  // 额度可能是 0，说成功就是骗用户。这里只陈述事实，不承诺找回。
  /** 金额单位（#94 / #487）：元口径（1 元 = 1 额度，无 USD），由 services/ours/api.ts 的 formatPoints 拼接，别在代码里写死中文 */
  oursPointsUnit: '元',
  oursQuotaValue: '{points}',
  oursQuotaNeedsClaim: '还没领取凭据：点上方「领取 / 重新领取」后显示额度',
  oursQuotaNeedsBind: '本机还没有绑定 Key：请点「领取新 Key」或「我已有 Key」',
  // #234：线上规则改成「只给邀请人发额度」，被邀请人填码只建立关系（reward_points: 0），
  // 所以成功文案不再报「获得 X 额度」；规则数值一律取服务端 invite_rules，前端不写死金额
  // 套餐
  oursPlansLoading: '正在加载套餐…',
  oursPlansFailed: '套餐加载失败，请重试',
  oursBuyAction: '去支付',
  // 购买入口（Issue #331）：套餐全线下架，直接打开联动小铺收款页
  oursPayTitle: '购买',
  oursPayAction: '前往购买',
  oursPayBusy: '正在获取收款页…',
  oursPayEmpty: '套餐列表已下架，点「前往购买」到联动小铺页面选购即可。',
  oursPayHint: '在 App 内打开联动小铺收款页；付款后由小铺直接发放卡密，关掉页面就回到这里。',
  oursPayUnavailable: '收款通道暂不可用，请稍后再试',
  oursPayOpenFailed: '没能在 App 内打开收款页，请稍后再试',
  oursRedeemAction: '兑换',
  oursRedeemSuccess: '兑换成功，+{points}',
  oursRedeemPending: '兑换处理中，请稍后刷新额度查看',
  // Key 校验
  oursKeyProbeValid: 'Key 已生效 {tail}',
  oursKeyProbeInvalid: 'Key 尚未生效 {tail}',
  oursKeyProbeNetwork: 'Key 校验失败：网络不可用',
  oursKeyProbeTimeout: 'Key 校验超时',
  // 邀请服务错误码
  // #234：A 邀请了 B，B 又填 A 的码 → 服务端 409 circular_invite
  // #421 邮箱账号（绑定 / 换机登录）错误码，逐条对应 Issue 里的表
  oursEmailCodePlaceholder: '6 位验证码',
  // 卡密 / 支付服务错误码
  oursErrBadJson: '请求格式有误，请重试',
  oursErrUnauthorized: '鉴权失败，请重新领取或填写 Key 后再试',
  oursErrForbidden: '订单令牌不匹配，无法查询该订单',
  oursErrNotFound: '记录不存在',
  oursErrCardNotFound: '卡密不存在，请核对后重试',
  oursErrCardUsed: '该卡密已被使用，不要重复提交',
  oursErrCardMissing: '请输入卡密',
  oursErrKeyMissing: '请先领取或填写 Key',
  oursErrKeyInvalid: 'Key 无效，请重新领取或填写',
  oursErrVerifyUnavailable: '额度服务暂时不可用，请稍后重试',
  oursErrRateLimited: '请求过于频繁，请稍后重试',
  oursErrPlanNotFound: '套餐不存在',
  oursErrPlanMissing: '请先选择套餐',
  oursErrNetwork: '网络不可用，请稍后重试',
  oursErrTimeout: '请求超时，请稍后重试',
  oursErrInvalidResponse: '服务端返回异常，请稍后重试',
  oursErrUnknown: '操作失败，请稍后重试',
  errorScreenTitle: '页面没能显示出来',
  errorScreenDescription:
    '应用在渲染界面时遇到了一个错误，为了不让它继续崩下去，先停在这里。本地已保存的对话不会被删除，重载后可以继续使用。',
  errorScreenReload: '重载应用',
  errorScreenCopyDiagnostics: '复制诊断信息',
  errorScreenCopied: '诊断信息已复制',
  errorScreenCopyFailed: '复制失败，请重试',
  errorScreenHint:
    '若重载后仍然这样，请复制诊断信息附在反馈里（只有错误位置与版本，不含聊天正文与 API Key）。',
  // Issue #72：兑换迁本机池 / device 自愈 / 202 处理中 / 设备码备份提示
  oursErrCardLeased: '该卡密已转入 App 兑换通道，请在 App 内兑换',
  oursErrCardNotFoundOrExpired: '卡密不存在或已失效',
  oursErrApiKeyNotIssued: '请先在 App 内领取 Key 再兑换',
  // Issue #46：思考过程显示方式三档
  settingDialogThinkingDisplayLabel: '思考过程',
  settingDialogThinkingDisplayDescription: '深度思考开启后，思考内容在消息里怎么显示；切换后立即对已打开的会话生效。',
  settingDialogThinkingDisplayCollapsed: '折叠',
  settingDialogThinkingDisplayExpanded: '展开',
  settingDialogThinkingDisplayHidden: '不显示',
  // Issue #18：会话自动标题的 system prompt（zh 侧逐字沿用修复前的硬编码文案）
  autoTitlePromptIntro: '根据提供的用户消息，为这段 AI 对话生成一个简洁标题。',
  autoTitlePromptFormat: '只输出标题本身，一行纯文本，不要引号、前缀、解释、Markdown、XML 或控制字符，不允许输出代码。',
  autoTitlePromptLanguage: '使用消息的语言。',
  autoTitlePromptLength: '目标长度：约 8–14 个中文字符（或 3–5 个英文单词）。',
  autoTitlePromptFallback: '如果消息信息量太少，也要给一个简短的最佳猜测标题（如「打招呼」），不要解释。',
  oursPayRecordsEntryAction: '查看',
  oursPayRecordsNotRedeemed: '尚未兑换',
  oursPayRecordsRedeemed: '已兑换',
  oursPayRecordsCopyCard: '复制卡密',
  oursPayRecordsCopied: '卡密已复制',
  // Issue #45：请求统一超时的提示（与网络失败、4xx/5xx 分开说）
  /// #568：这一段只覆盖「发起到拿到响应头」，所以文案说「连接」，与首字/空闲分开
  requestTimeout: '连接上游超时（{seconds} 秒内没有拿到响应），网络较慢时可以重新发送',
  // Issue #106：移动端标题栏双击回到首条消息
  scrollToFirstMessage: '回到首条消息（双击标题）',
  scrollToFirstMessageHint: '双击回顶',
  // Issue #102：消息区阅读设置（字号 / 字重 / 行高），只作用于消息区
  settingDialogReadingGroupLabel: '只作用于消息区：聊天正文、思考内容和你自己发的消息；设置面板与输入框不跟着变。',
  settingDialogReadingFontSize: '字号',
  settingDialogReadingFontWeight: '字重',
  settingDialogReadingLineHeight: '行高',
  settingDialogReadingSizeSmall: '小',
  settingDialogReadingSizeStandard: '标准',
  settingDialogReadingSizeLarge: '大',
  settingDialogReadingSizeXLarge: '特大',
  settingDialogReadingWeightRegular: '常规',
  settingDialogReadingWeightMedium: '中等',
  settingDialogReadingWeightBold: '粗体',
  settingDialogReadingLineCompact: '紧凑',
  settingDialogReadingLineStandard: '标准',
  settingDialogReadingLineRelaxed: '宽松',
  settingDialogEnterKeyMode: '回车键行为',
  settingDialogEnterKeyModeDescription: '回车发送换行、或只换行靠发送按钮，按你的习惯选；手机软键盘的回车键会跟着变。',
  settingDialogEnterKeySend: '回车发送（Shift + 回车换行）',
  settingDialogEnterKeyModifierSend: 'Ctrl / ⌘ + 回车发送（回车换行）',
  settingDialogEnterKeyButtonOnly: '只换行（点发送按钮才发送）',
  // 窗口记忆的 embedding 开关（#398）：默认关闭，关闭后零外部请求。
  // 文案口径与 issue 一致：说清「开 = 会把内容发给外部 embedding 服务」「关 = 完全不联网」，
  // 别用「智能检索」这种听起来免费的说法。
  settingDialogMemoryEmbeddingLabel: '记忆向量化（embedding）',
  settingDialogMemoryEmbeddingDescription:
    '开启后记忆功能会调用外部 embedding 服务；关闭则完全不联网（记忆检索只在本机做关键词匹配）。默认关闭。',
  settingDialogMemoryEmbeddingOn: '已开启',
  settingDialogMemoryEmbeddingOff: '已关闭',
  settingDialogMemoryEmbeddingNoEndpoint:
    '已开启，但当前渠道没有 embedding 端点（只有 OpenAI 兼容渠道提供）：请到「数据管理」换成 OpenAI 兼容渠道并填好服务地址。',
  settingDialogMemoryEmbeddingNoCredential:
    '已开启，但当前渠道还缺可用的 embedding 凭据（服务地址或 API Key）：请到「数据管理」补齐，否则记忆检索会退化为本地关键词匹配。',
  // 窗口记忆的容量提示（#399）：淘汰与拒绝**都要说出来**，不许静默丢。
  // 两条都点明「只在当前会话内」——用户最容易误解的是「我的记忆被别的会话挤掉了」。
  memoryEvicted: '当前会话的记忆已达容量上限，已清理最早写入的 {count} 条（只影响当前会话）',
  memoryEntryTooLarge: '这条记忆超过单条容量上限（约 {kb} KB），没有写入',
  // Issue #49：导入容错——坏消息截断、坏会话跳过，界面要能说清「丢了哪几条、为什么」
  historyImportedPartial: '已导入 {count} 个会话，跳过 {skipped} 处损坏数据',
  historyImportSkippedTitle: '跳过了 {count} 处损坏数据',
  historyImportSkippedHint: '其余会话与消息已正常导入',
  historyImportSkipScopeSession: '会话',
  historyImportSkipScopeMessage: '消息',
  historyImportSkipScopeBranch: '分支',
  historyImportSkipWhereSession: '会话「{session}」整段无法读取',
  historyImportSkipWhereMessage: '会话「{session}」第 {message} 条消息',
  historyImportSkipWhereBranch: '会话「{session}」当前指向 {message}',
  historyImportSkipMissingParent: '缺失的父消息 {parent}',
  historyImportSkipReasonBranches: '消息分支损坏（父消息缺失或角色接不上）',
  historyImportSkipReasonFiles: '附件数据损坏（图片路径越界或重复）',
  // #314：归档里的 reason 来自别的版本 / 第三方构造，认不出来时给一句人话，不再把裸字符串当 key 查表
  historyImportSkipReasonUnknown: '未识别的跳过原因（来自别的版本或第三方归档）',
  // 抖音号展示项（用户直接指定的改动）：值可点、可复制
  settingDouyinLabel: '抖音号',
  settingDouyinDescription: '点一下号码即可复制，去抖音搜索就能找到。',
  settingDouyinCopyAria: '复制抖音号',
  settingDouyinCopied: '抖音号已复制',
  oursErrCustomerNeedsKey:
    '请先在 App 内领取 Key（没有 Key 就拿不到客户编号，本次没有下单）',
  backupEntryDuplicated: '导入包里「{entry}」这条路径重复出现了两次，无法判断该用哪一条；请选择 DeepSeek 导出的原始 ZIP，不要解压后重新打包',
  // 「我的购买」页（Issue #158）：入口、筛选、分页、卡片动作与错误文案
  oursPurchasesLoading: '正在加载购买记录…',
  oursPurchasesEmpty: '还没有购买记录。购买套餐后，这里会列出每一笔。',
  oursPurchasesRetry: '重试',
  oursPurchasesGoRedeem: '去兑换',
  oursPurchasesErrKeyMissing: '填写 API Key 后可以查看这个账号的购买记录',
  oursPurchasesErrUnauthorized: 'API Key 无效或已过期，请重新填写后再试',
  oursPurchasesErrRateLimited: '查询太频繁了，请稍后再试',
  oursPurchasesErrTimeout: '查询超时了，请检查网络后重试',
  oursPurchasesErrNetwork: '网络连接失败，请检查网络后重试',
  oursPurchasesErrServer: '服务器暂时无法处理，请稍后重试',
  oursPurchasesErrRejected: '订单查询被拒绝，请稍后重试',
  oursPurchasesErrBadResponse: '返回的数据无法解析，请稍后重试',
  oursPurchasesErrUnknown: '购买记录查询失败，请稍后重试',
  // 兜底页出口文案（issue #180 / #104）。与 src/index.html 内联的 COPY 表逐字一致，
  // tests/unit/compat-guard-diagnostics.test.mjs 会比对两侧 —— 改文案必须两边同时改。
  //
  // 注意（issue #413）：兜底页在业务包挂掉之后才出现，守卫只能把文案内联在 HTML 里，
  // 运行时永远读不到这张表。所以**只登记存量 key**，#104 新增的那批（低内核主文案 / 五项
  // 环境信息 / 复制与截断提示，共 17 个）在 i18n 里就是「定义未引用」的死 key（check-i18n R4），
  // 已从 zh/en 删除，逐字参照副本挪到 tests/fixtures/compat-boot/compat-boot-copy.mjs。
  // 新加兜底页文案请改 src/index.html 的 COPY 表 + 那个 fixture，**不要**往这里加。
  compatBootTitle: '页面启动失败',
  compatBootLead: '这个页面需要更新版本的 Android System WebView（或浏览器）才能正常打开。',
  compatBootMissing: '缺少的运行环境能力：{apis}',
  compatBootRuntimeError: '页面脚本在启动时出错，没能启动。',
  compatBootTimeout: '页面脚本 12 秒内没有启动（内核过旧或资源加载失败）。',
  compatBootHowTo: '更新方法：在应用商店里搜索「Android System WebView」并更新，然后重新打开本应用。',
  compatBootFooter: '若更新后仍然失败，请反馈上面的内核版本与本页截图。',
  // 导入失败的「不可达」档（issue #18）：有网、但连不上导入服务（DNS 解析不到 / 路由不可达 / 切网瞬间断链）。
  // 不能复用 historyImportUrlOffline 的「网络已断开」—— 用户网络明明是通的，那句只会把人往错方向带。
  historyImportUrlUnreachable: '暂时无法连接导入服务，请稍后重试',
  historyImportReadFailed:
    '导出包已经下载完成，但本机无法读取（通常是内存不足）。请关闭其它应用后重试，或重启应用再导入。',
  /**
   * 检查更新失败兜底（Issue #412）：失败态下展示上次成功的清单快照 + 手动下载出口。
   * 文案里只放用户已知的事实（时间、条数），不放地址、不放堆栈。
   */
  updateCacheFallbackTitle: '缓存数据，可能不是最新',
  updateCacheFallbackNote:
    '这是 {time} 成功取到的版本列表（共 {count} 条）。当前连不上更新服务，列表可能已经过期。',
  updateManualDownload: '手动下载最新版',
  updateManualOpenFailed: '没能在 App 内打开下载页，请稍后再试，或复制诊断信息反馈给我们。',
  /**
   * 更新弹窗与策略（Issue #517）：三档策略（强制 / 软性 / 普通）的文案都在这里。
   * 只讲用户能做的动作与已知事实，不出现 SOP、错误码或服务端内部名字。
   */
  updateDialogTitleNormal: '发现新版本',
  updateDialogTitleSoft: '有新版本可用',
  updateDialogTitleForced: '必须更新后才能继续使用',
  updateDialogChangesTitle: '更新内容',
  updateDialogLabelSize: '安装包大小',
  updateDialogLabelPublishedAt: '发布时间',
  updateDialogLabelCurrent: '当前版本',
  updateDialogPublishedUnknown: '未提供',
  updateDialogForcedNotice: '这个版本必须更新后才能继续使用。',
  updateDialogBelowMinimumNotice:
    '当前版本 {current} 已低于最低支持版本，更新到 {version} 后才能继续使用。',
  updateDialogForcedReason: '说明：{reason}',
  updateDialogSoftNotice: '可以稍后提醒，{hours} 小时内不再弹出。',
  updateDialogSnooze: '稍后提醒',
  updateDialogClose: '关闭',
  updateDialogCancel: '取消',
  updateDialogSnoozed: '已设为稍后提醒，{hours} 小时内不再弹出该提示。',
  // ---------------------------------------------------------------------------
  // 重构词条骨架（#487 铺路）：登录注册 / 账户与消费 / 卡密兑换 / 邀请 / 邮箱绑定
  // 只新增、不改上面的既有文案；语义依据 #482（支付与消费拆分）与 #484（sub2api 客户端约束）。
  // 这批 key 在 UI 线落地前没有被引用是预期的，已登记到 scripts/check-i18n.mjs 的 ORPHAN_BASELINE。
  // ---------------------------------------------------------------------------

  // 登录注册（sub2api /api/v1/auth）
  sub2authEmail: '邮箱',
  sub2authPassword: '密码',
  sub2authConfirmPassword: '确认密码',
  sub2authLogin: '登录',
  sub2authRegister: '注册',
  sub2authForgotPassword: '忘记密码',
  sub2authSendCode: '发送验证码',
  /** 倒计时占位：{seconds} 由调用方按服务端冷却时间注入，不在代码里写死秒数 */
  sub2authCodeSent: '验证码已发送，{seconds}s 后可重新发送',
  sub2authCodeInvalid: '验证码错误',
  sub2authEmailInvalid: '邮箱格式错误',
  sub2authCredentialInvalid: '账号或密码错误',
  sub2authLoginFailed: '登录失败，请重试',
  sub2authNetworkError: '网络错误，请检查网络后重试',
  sub2authLogout: '退出登录',
  sub2authSwitchAccount: '切换账号',
  sub2authAccount: '账号',
  sub2authSessionExpired: '登录已过期，请重新登录',
  sub2authRegisterSuccess: '注册成功',
  sub2authEmailVerifyRequired: '需要先验证邮箱',
  sub2authTwoFactorHint: '这个账号已开启两步验证，请输入验证器里的 6 位验证码',

  // 「账户与消费」页（#482 三弹层合一 / #487 W1-C1）：一个页面四个 tab。
  // 标题与三个 tab 名在词条骨架里没有对应项，这里最小新增；Tab 2「购买」复用 oursPayTitle。
  accountConsumeTitle: '账户与消费',
  accountConsumeEntryDescription: '我的卡密、购买套餐、额度与账号，一个页面四件事',
  accountConsumeTabCards: '我的卡密',
  accountConsumeTabQuota: '我的额度',
  accountConsumeTabAccount: '账号',

  // 拆掉登录墙（#608）：账户降级为「我们的渠道」里的**可选**能力。
  // 口径三条（改文案前先看 #608 / #421）：① 主 CTA 是「填 Key 就能用」，不是「登录」；
  // ② 不登录失去的只有账单类信息，聊天 / Key / 导入导出一样不少；③ 不许写「账号更安全」这类夸大。
  accountOptionalHint: '不登录也可以：在设置里填 API Key 即可使用各渠道',
  accountOptionalStatusLoggedOut: '当前未登录 —— 只填 Key 也能正常聊天',
  accountOptionalStatusLoggedIn: '当前已登录：{email}',
  accountOptionalBenefitsTitle: '账号只多这些账单类信息',
  accountOptionalBenefitBalance: '余额与用量明细（我们的渠道按账号结算）',
  accountOptionalBenefitKeys: 'Key 管理：创建、停用、删除',
  accountOptionalBenefitInvite: '邀请码与返利余额',
  accountOptionalKeep: '聊天、各渠道 Key、导入导出都不受影响 —— 不登录一样不少',
  accountOptionalLoginEntry: '登录 / 注册（可选）',
  accountOptionalChecking: '正在检查登录状态…',
  // 主 CTA 与它的落点（#608）：账户是次要的 —— 先能聊天，再谈账号
  accountFillKeyCta: '去填 API Key',
  accountFillKeyHint: '设置 → 数据管理 → API Key，填上就能直接聊天',
  accountSignInCta: '去登录',
  quotaNeedLoginTitle: '登录后可查看额度',
  quotaNeedLoginBody: '额度按账号结算；只想聊天的话，在设置里填 Key 即可',
  inviteNeedLoginTitle: '登录后可查看邀请',
  inviteNeedLoginBody: '邀请码与返利跟着账号走；不登录不影响聊天',

  // 账户与消费（金额单位是元：1 元 = 1 额度，无 USD；展示走 utils/money.ts，客户端不做汇率）
  consumeBalance: '¥{amount}',
  consumeBalanceApprox: '约合 ¥{amount}',
  consumeQuota: '额度',
  consumeUsage: '用量',
  consumeUsageToday: '今日用量',
  consumeUsageMonth: '本月用量',
  consumeCreateKey: '创建 Key',
  consumeKeyList: 'Key 列表',
  consumeKeyName: 'Key 名称',
  consumeKeyExpiresAt: '过期时间',
  consumeKeyStatus: '状态',
  consumeKeyStatusActive: '启用',
  consumeKeyStatusInactive: '停用',
  consumeCopyKey: '复制 Key',
  consumeKeyCopied: 'Key 已复制',
  consumeDeleteKey: '删除 Key',
  consumeDeleteConfirm: '删除后不可恢复，确认删除这个 Key 吗？',

  // 卡密兑换（沿用「兑换卡密」措辞，见 #482 第三节）
  consumeRedeemTitle: '兑换卡密',
  consumeRedeemPlaceholder: '请输入卡密',
  consumeRedeemBusy: '兑换中…',
  /** 兑换超时后查历史补偿时用：不要让用户以为可以重复提交 */
  consumeRedeemConfirming: '正在确认兑换结果，请不要重复提交',
  consumeRedeemSuccess: '兑换成功',
  consumeRedeemFailed: '兑换失败，请稍后重试',
  consumeRedeemCodeUsed: '卡密已使用',
  consumeRedeemCodeInvalid: '卡密无效',

  // 邀请（sub2api aff；邀请关系只能在注册时一次填定）
  inviteTitle: '我的邀请',
  inviteCode: '邀请码',
  inviteCopyCode: '复制邀请码',
  inviteCount: '已邀请人数',
  inviteRebateBalance: '返利余额',
  inviteCodeAtRegister: '注册时填写邀请码（可选）',
  inviteCodeInvalid: '邀请码无效',
  inviteDisabled: '邀请功能未开放',

  // 邮箱绑定（sub2api account-bindings）
  emailBindBind: '绑定邮箱',
  emailBindChange: '更换邮箱',
  emailBindUnbind: '解绑',
  emailBindSendCode: '发送验证码',
  emailBindCodeSent: '验证码已发送',
  emailBindSuccess: '绑定成功',
  emailBindUnbindSuccess: '解绑成功',
  emailBindFailed: '绑定失败，请稍后重试',

  // sub2api 归一化错误的**上屏文案**（#487：`src/services/consume/errors.ts` 的 `ConsumeMessageKey`
  // 一条不落，共 27 条）。消费层只回 key、不拼文案，所以这里就是「用户能看到的那句话」的唯一来源。
  // 写文案的三条规矩（#484 §4.4 的语义口径）：
  //   · 说人话 + 可操作：「下一步做什么」写在句子里（重登 / 换 Key / 充值 / 找客服），不只报事实；
  //   · **不出现「未知错误」**：兜底只有 `consumeErrUnknown` 一条，其余每条都要具体到根因；
  //   · 金额统一用 `{amount}`（单位**元**：1 元 = 1 额度，无 USD 概念；服务端额度就是元，
  //     文案里不写货币符号，符号由 utils/money.ts 拼）；限流的秒数用 `{seconds}`（来自 `Retry-After`）。
  consumeErrUnknown: '这次请求没成功，请稍后重试；反复出现请把这条提示反馈给我们',
  consumeErrNetwork: '网络连不上，检查一下网络再试',
  consumeErrTimeout: '请求超时了，稍等一会儿再试',
  consumeErrUnsupported: '当前版本不支持这个功能，请更新到最新版本',
  consumeErrBadRequest: '提交的内容有问题，请检查后重试',
  consumeErrInvalidResponse: '服务返回的数据读不懂，请稍后重试；反复出现请反馈给我们',
  consumeErrUnauthorized: '登录已过期，请重新登录',
  consumeErrAccountDisabled: '账号已被停用，请联系客服',
  consumeErrForbidden: '没有权限做这个操作，请确认当前账号的权限',
  consumeErrNotFound: '要调用的接口不存在，请更新到最新版本',
  consumeErrRateLimited: '操作太频繁，请 {seconds} 秒后再试',
  consumeErrServerUnavailable: '服务暂时不可用，请稍后重试',
  consumeErrKeyMissing: '还没填 API Key，先填上再试',
  consumeErrKeyInvalid: 'API Key 无效，请检查是否复制完整',
  consumeErrKeyDisabled: '这个 API Key 已停用，请启用它或换一个',
  consumeErrKeyExpired: '这个 API Key 已过期，请重新创建',
  consumeErrKeyQuotaExhausted: '这个 API Key 的额度用完了，请换一个 Key 或提高额度',
  consumeErrKeyExists: '已经有同名的 API Key，换个名字再创建',
  // 金额单位是元（#487 / 后端 8b12ab2）。这条**不留 `{amount}` 占位**：消费层的错误映射只回
  // i18n key、不回差额，占位符没人填就会把 `{amount}` 原样端给用户（#504 留下的坑）。
  consumeErrInsufficientBalance: '余额不足，请先充值后重试',
  consumeErrGroupNotAllowed: '当前分组不能用这个 Key，请换分组或联系客服',
  consumeErrCardNotFound: '没找到这张卡密，请核对后再输入',
  consumeErrCardNotFoundOrExpired: '卡密不存在或已过期，请核对后再输入',
  consumeErrCardUsed: '这张卡密已经被用过了，额度没到账请联系客服',
  consumeRedeemProcessing: '正在确认兑换结果',
  consumeErrInvitationInvalid: '邀请码无效，请核对后再填',
  consumeErrEmailCodeInvalid: '验证码不对或已过期，请重新获取',
  // 邮箱没验证（`EMAIL_VERIFY_REQUIRED`）：说清「下一步做什么」——先去验证，不是稍后重试
  consumeErrEmailVerifyRequired: '请先完成邮箱验证',
  consumeErrNotEnabled: '这个功能还没开放，请联系客服开通',
  // 写操作 2xx 但**证据不足**（#660：邮箱绑定 200 + 空体、回查也没有脱敏邮箱）：
  // 这是「结果未知」，不是「已经成了」——文案必须给出下一步（重试 / 去账号页核对）。
  consumeErrBindUnconfirmed: '绑定结果未确认，请重试或稍后在账号页查看',
  // 退出所有设备（#679 第 5 处，安全语义）：撤销接口回了 2xx，但回查证明不了会话已失效。
  // **不许**写「已退出所有设备」——文案必须说清「已提交、未确认」并给出下一步（重新登录验证 / 查其他设备）。
  consumeErrRevokeUnconfirmed: '退出请求已提交，但结果未确认（所有设备是否都已退出还不知道）：请重新登录验证，并到其他设备上检查是否仍处于登录状态',
  // 解绑 / 改 Key / 删 Key 的「2xx 但没生效」（#679 第 2/3/4 处）：都要求用户去核对真实状态，不许显示成功。
  consumeErrUnbindUnconfirmed: '解绑结果未确认：请刷新账号页核对，若仍显示已绑定请稍后重试',
  consumeErrUpdateUnconfirmed: '改动结果未确认：请刷新后核对这把 Key 的最新值，必要时重新保存',
  consumeErrDeleteUnconfirmed: '删除结果未确认：这把 Key 可能仍然有效并继续产生费用，请刷新列表核对后重试',
  // 「已确认失败」时附在文案下面的那一行：HTTP 码 + 脱敏后的服务端原文（`panels.ts` 的 errorBlock 渲染）
  consumeErrUpstreamDetail: '服务端返回：{detail}',
  // ---------------------------------------------------------------------------
  // W1-C2 四个面板（额度 / 账号 / 邀请 / 邮箱绑定，#487）：
  //   1. `consumeErr*` 的 27 条错误文案已由 #504 落地（W1-A 收尾），本单**不重复定义**；
  //      面板只认 `error.i18nKey` 取文案，永不显示服务端英文 message（#484 §四）。
  //   2. 这里只补四个面板必需的纯标签（已用 / 剩余 / 加载更多 / 一次性 Key 提示…）。金额一律「元」
  //      （CNY，1 元 = 1 额度）：符号由组件层的 formatCurrency 按 currency 渲染，不经这份表；
  //      不写任何「填邀请码立刻得积分」的旧玩法（#484 §3.1b）。
  // ---------------------------------------------------------------------------
  /** 卡密「已用过」= 可能正是自己上一次成功：先让用户核对余额，不要直接说失败 */
  /** `REDEEM_CODE_LOCKED` 是「处理中」不是失败（#484 §4.4：禁止提示换卡 / 重复提交） */

  // 额度面板（唯一入口是 sk- Key 的 /v1/usage；余额只在内存里跟着响应走）
  /** 「余额」标签：`consumeBalance` 是金额模板（`${amount}`），不是标签，别混用 */
  consumeBalanceLabel: '余额',
  consumeUsed: '已用',
  consumeRemaining: '剩余',
  /** `quota.limit === 0` = 不限（不是零额度，#484 §4.5 第 10 条） */
  consumeUnlimited: '不限',
  consumeLoadMore: '加载更多',
  consumeLoadingMore: '正在加载…',
  consumeUsageEmpty: '还没有用量记录',
  consumeRequestsCount: '{count} 次请求',
  consumeTokensCount: '{count} 令牌',
  consumeNoKeyTitle: '还没有可用的 Key',
  consumeNoKeyBody: '余额和用量都要用 Key 才能查。请到「账号」标签页创建一把 Key。',

  // 账号面板（Key 创建后只完整显示一次是安全设计，必须在界面上说清）
  consumeAccountTitle: '账号',
  consumeProfileTitle: '账号资料',
  consumeRegisteredAt: '注册时间',
  consumeKeyEmpty: '还没有 Key。给它起个名字，点「创建 Key」就好。',
  consumeKeyOnceTitle: 'Key 只显示这一次',
  consumeKeyOnceBody: '为了安全，完整 Key 只在创建成功后显示一次，关掉后就无法再次查看。请现在复制并妥善保存。',
  consumeKeyTailOnly: '列表里只显示末尾 4 位',
  /** 一次性 Key 那个块的关闭按钮：说「我保存好了」而不是干巴巴的「确定」 */
  consumeKeyOnceSaved: '我保存好了',
  consumeKeyNameRequired: '请先给 Key 起个名字',
  consumeKeyDeleted: '已删除',
  consumeNeedLogin: '登录状态已失效，请重新登录',
  consumeLogoutConfirm: '退出后需要重新登录才能继续使用，确认退出吗？',
  consumeLogoutSuccess: '已退出登录',

  // 邀请面板（返利按消费额的比例以「元」结算，邀请关系只在注册时一次填定）
  inviteRebateRate: '返利按下线消费额的 {percent}% 结算，结算后计入返利余额',
  inviteRebateFrozen: '其中 {amount} 冻结中',

  // 邮箱绑定面板（`email_verify_enabled=false` 时不再强调「必须先验证」）
  emailBindNotBound: '尚未绑定邮箱',
  emailBindCodeLabel: '验证码',
  emailBindUnbindConfirm: '解绑后这个邮箱将不再与账号关联，确认解绑吗？',
  emailBindCannotUnbind: '这是账号唯一的登录方式，不能解绑',
  // 老账号额度迁移（#498 的临时尾巴，@remove-after 1.6.0）：
  // 登录后一次性调用，失败静默；这几条只服务于那一个自包含按钮（src/legacy/migration/）。
  // 删除方法见 src/legacy/migration/README.md（届时这 5 条一起删）。
  legacyMigrateTitle: '迁移历史额度',
  legacyMigrateDone: '历史额度已迁移：{amount}',
  legacyMigrateManual: '如需迁移历史额度，请联系客服',
  legacyMigrateExpired: '额度迁移已结束',
  legacyMigrateFailed: '迁移失败',
  legacyMigrateDeviceMismatch: '设备信息不匹配，请联系客服',
  legacyMigrateAlreadyUnsettled: '已迁移过，如未到账请联系客服',
  legacyMigrateRetryAnyway: '仍要迁移',
  attachPickButton: '添加文档（TXT / DOCX / PDF）',
  attachPickUnsupported: '「{name}」不是支持的文档类型，当前仅支持 TXT、DOCX、PDF',
  attachPickTooLarge: '「{name}」为 {size}，超过该类型的上限 {limit}',
  attachPickEmpty: '「{name}」是空文件，没有可解析的内容',
  attachPickTooMany: '一条消息最多 {limit} 个文档，已拒绝多出的 {count} 个',
  attachUnavailable: '附件管理器尚未就绪，本次没有添加任何文档',
  attachChannelUnsupported:
    '当前渠道不支持文档附件：本渠道既没有可用的原生文件上传，也不做文本注入，请切换到其他渠道',
  // 五态 + 取消
  attachStatusPending: '等待解析',
  attachStatusParsing: '解析中 {percent}%',
  attachStatusParsingStage: '解析中 · {stage}',
  attachStatusParsingPlain: '解析中…',
  attachStatusSuccess: '已就绪',
  attachStatusPartial: '部分内容已就绪 · {count} 条警告',
  attachStatusFailed: '解析失败，点击查看原因',
  attachStatusCancelled: '解析已取消',
  attachCancel: '取消解析',
  attachRetry: '重新解析',
  attachRemove: '移除附件',
  attachRemoveFailed: '移除附件失败，请重试',
  // 详情小面板
  attachOpenDetail: '查看附件详情',
  attachDetailWarnings: '警告（{count} 条）',
  attachDetailFailure: '失败原因',
  attachDetailCharacters: '{chars} 字符 · 约 {tokens} tokens',
  attachDetailPages: '第 {extracted}/{total} 页',
  attachDetailRaw: '技术信息',
  attachDetailTruncated: '内容过长已截断，剩余 {rest} 字符未发送',
  attachWarnPageGap: '共 {total} 页，仅成功提取 {extracted} 页',
  // 失败原因（按 manager 的 reason 码出文案）
  attachFailUnsupportedFormat: '文件类型不受支持（当前仅支持 TXT、DOCX、PDF）',
  attachFailMimeMismatch: '文件内容与扩展名不一致，可能被改过扩展名',
  attachFailEmpty: '文件为空，没有可解析的内容',
  attachFailTooLarge: '文件超过该类型的大小上限，请压缩或拆分后重新上传',
  attachFailNotFound: '找不到这条附件记录，请重新添加',
  attachFailSourceMissing: '本地原件已不存在，请重新添加该文件',
  attachFailNoParser: '该格式的解析器尚未就绪，暂时无法解析',
  attachFailUnknown: '解析过程中出现了未知问题',
  // PDF 解析器的硬失败码（#574）：每种成因一句人话 + 下一步怎么做。
  // 扫描版 PDF 那句是 #480 §5.3 原文，别改字。
  attachPdfErrNoTextLayer:
    '该 PDF 未检测到可提取的文本，暂不支持扫描版 PDF，请上传包含文本层的 PDF 文件',
  attachPdfErrTooManyPages: 'PDF 共 {pages} 页，超过上限 {limit} 页，请拆分后再上传',
  attachPdfErrTooManyPagesPlain: 'PDF 页数超过上限 {limit} 页，请拆分后再上传',
  attachPdfErrEncrypted: '不支持加密 PDF，请先解除密码保护后再上传',
  attachPdfErrNotPdf: '这个文件不是有效的 PDF（内容与扩展名对不上），请确认文件后重新上传',
  attachPdfErrFileTooLarge: 'PDF 超过该类型的体积上限，请压缩或拆分后再上传',
  attachPdfErrLibUnavailable: 'PDF 解析组件没有加载成功，请重试；反复失败请检查网络后刷新页面',
  attachPdfErrOpenFailed: 'PDF 打不开，文件可能已损坏，请重新导出后再上传',
  // 解析阶段（manager 的 onProgress.stage）
  attachStageValidate: '校验文件',
  attachStageUnzip: '解压文档',
  attachStageParse: '读取正文',
  attachStageRender: '整理文本',
  attachStageOpen: '打开文档',
  attachStagePage: '提取第 {page} 页',
  attachStageRead: '读取文件',
  attachStageDecode: '识别编码',
  attachStageDone: '收尾',
  // 清理与占位
  attachSweepFailed: '清理无用附件失败，请稍后重试',
  attachMissing: '附件记录已清理，无法查看详情',
  attachLoading: '正在读取附件信息',
  // 发送前拦截必错配置（#490）：五类各一句话，都写明「这条消息没有发出」——
  // 用户看到的必须是他该改哪一个字段，而不是一句笼统的「配置有误」
  sendBlockedBaseUrlEmpty: '服务地址为空，这条消息没有发出：请先填写服务地址',
  sendBlockedBaseUrlNoProtocol: '服务地址缺少 http:// 或 https://，这条消息没有发出：请补上协议再试',
  sendBlockedBaseUrlEndpointPath:
    '服务地址填成了具体接口地址（如 …/chat/completions），这条消息没有发出：请只填到域名，可以带 /v1',
  sendBlockedModelEmpty: '模型名为空，这条消息没有发出：请先填写模型名',
  sendBlockedModelSpace: '模型名里有空格（首尾或中间），这条消息没有发出：模型名必须是连续的一串字符',
} as const
