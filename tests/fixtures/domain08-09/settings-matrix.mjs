/**
 * N2 设置项持久化矩阵的**唯一数据源**（域 9 · 设置与持久化）。
 *
 * 一行 = 一个设置项；三列 = 合法值生效 / 脏值回落 / 冷启动读回。
 * 覆盖功能点：F9-01（主题）· F9-02（字号字重行距）· F9-03（思考显示）· F9-04（快速/专家模式，持久化半边）
 * · F9-05（回车行为）· F9-06（界面语言）· F9-07（TTS 音色 / 智能搜索 / 侧边栏）· F9-08（更新渠道**不**持久化）
 * · F9-13（脏值容错）。
 *
 * 为什么一张表：域 9 天生条目多（13 个 `chat-demo:*` 键 + 1 个渠道键 + 1 个「本来就没有键」的契约），
 * 一项一条用例会炸；这也是吸收 `reading-settings` / `enter-key-mode` / `thinking-display` 三处
 * 「持久化 + 脏值」重复断言的容器（见 `docs/testing/coverage/domain08-09.md` §8.4）。
 *
 * 列的口径：
 *   - `legal`：`store` = 合法值落盘后的字符串；`expect` = 冷启动读回后应有的值；
 *     `value` = 调用写入口时传的值（默认等于 `store`，布尔项要单独给）；`also` = 同一写入口顺带写的其它键
 *   - `dirty`：`store` 是「手改坏 / 老版本残留」的存储内容，`expect` 是回落值
 *   - `write: null` = 这个键**只读**（位置信息 1.4.0-beta.1 起已从设置页移除，只剩读取与容错）
 *
 * 只放数据，断言在 `tests/unit/domain09-settings-persistence.test.mjs`。
 */

/** 标准构建（非内测）的默认渠道 */
export const DEFAULT_KIND = 'deepseek'

export const SETTING_ROWS = [
  {
    id: 'S1',
    fn: 'F9-01',
    label: '主题偏好（浅色 / 深色 / 跟随系统）',
    keys: ['chat-demo:theme-preference'],
    read: (m) => m.settings.useSettings.getState().themePreference,
    write: (m, value) => m.settings.setThemePreference(value),
    legal: [
      { store: 'light', expect: 'light' },
      { store: 'dark', expect: 'dark' },
      { store: 'system', expect: 'system' },
    ],
    dirty: [
      { store: 'Blue', expect: 'system' },
      { store: 'LIGHT', expect: 'system' },
      { store: '', expect: 'system' },
      { store: 'system ', expect: 'system' },
    ],
  },
  {
    id: 'S2',
    fn: 'F9-06',
    label: '界面语言（zh-CN / en-US）',
    keys: ['chat-demo:locale'],
    read: (m) => m.settings.useSettings.getState().locale,
    write: (m, value) => m.settings.setLocale(value),
    legal: [
      { store: 'zh-CN', expect: 'zh-CN' },
      { store: 'en-US', expect: 'en-US' },
    ],
    // 脏值回落到浏览器语言（zh 浏览器 → zh-CN，见 N2-e）
    dirty: [
      { store: 'fr-FR', expect: 'zh-CN' },
      { store: 'zh', expect: 'zh-CN' },
      { store: '', expect: 'zh-CN' },
    ],
  },
  {
    id: 'S3',
    fn: 'F9-13',
    label: '位置信息（**只读**键：设置页已移除，只剩读取与容错）',
    keys: ['chat-demo:location'],
    write: null,
    read: (m) => m.settings.useSettings.getState().location,
    // 口径按 zh 浏览器（读取侧对 zh 浏览器只认「国家 + 省市」齐全的记录）
    legal: [
      { store: '{"region":"CN","province":"110000"}', expect: { region: 'CN', province: '110000' } },
      { store: '{"region":"CN","province":"110000","city":"110100"}', expect: { region: 'CN', province: '110000', city: '110100' } },
      { store: 'null', expect: null },
    ],
    dirty: [
      { store: 'not-json', expect: null },
      { store: '[]', expect: null },
      { store: '{"region":"ZZ"}', expect: null },
      { store: '{"region":"CN","province":"999999"}', expect: null },
      // zh 浏览器下「只有 region 没有省份」= 选了国家却没选省市，读取侧按「没配过」处理
      { store: '{"region":"CN"}', expect: null },
      // zh 浏览器不保留境外记录（这些记录只对 en 浏览器有意义，见 N2-f）
      { store: '{"region":"US"}', expect: null },
    ],
  },
  {
    id: 'S4',
    fn: 'F9-07',
    label: 'TTS 音色',
    keys: ['chat-demo:tts-voice'],
    read: (m) => m.settings.useSettings.getState().ttsVoice,
    write: (m, value) => m.settings.setTtsVoice(value),
    legal: [
      { store: 'stella', expect: 'stella' },
      { store: 'tide', expect: 'tide' },
    ],
    dirty: [
      { store: 'Tide', expect: 'stella' },
      { store: 'other', expect: 'stella' },
      { store: '', expect: 'stella' },
    ],
  },
  {
    id: 'S5',
    fn: 'F9-04',
    label: '快速 / 专家模式（+ 兼容键 chat-demo:thinking）',
    keys: ['chat-demo:chat-mode', 'chat-demo:thinking'],
    read: (m) => m.settings.useSettings.getState().chatMode,
    write: (m, value) => m.settings.setChatMode(value),
    legal: [
      { value: 'fast', store: 'fast', expect: 'fast', also: { 'chat-demo:thinking': 'false' } },
      { value: 'expert', store: 'expert', expect: 'expert', also: { 'chat-demo:thinking': 'true' } },
    ],
    dirty: [
      // 老键「深度思考 = 开」的老用户升级后仍然算专家模式
      { store: { 'chat-demo:chat-mode': 'turbo', 'chat-demo:thinking': 'true' }, expect: 'expert' },
      { store: { 'chat-demo:chat-mode': 'turbo', 'chat-demo:thinking': 'false' }, expect: 'fast' },
      { store: { 'chat-demo:chat-mode': 'turbo' }, expect: 'fast' },
    ],
  },
  {
    id: 'S6',
    fn: 'F9-03',
    label: '思考过程显示方式',
    keys: ['chat-demo:thinking-display'],
    read: (m) => m.settings.useSettings.getState().thinkingDisplay,
    write: (m, value) => m.settings.setThinkingDisplay(value),
    legal: [
      { store: 'collapsed', expect: 'collapsed' },
      { store: 'expanded', expect: 'expanded' },
      { store: 'hidden', expect: 'hidden' },
    ],
    dirty: [
      { store: 'open', expect: 'collapsed' },
      { store: 'Collapsed', expect: 'collapsed' },
      { store: '', expect: 'collapsed' },
    ],
  },
  {
    id: 'S7',
    fn: 'F9-02',
    label: '阅读字号',
    keys: ['chat-demo:reading-font-size'],
    read: (m) => m.settings.useSettings.getState().readingFontSize,
    write: (m, value) => m.settings.setReadingFontSize(value),
    legal: [
      { store: 'small', expect: 'small' },
      { store: 'standard', expect: 'standard' },
      { store: 'large', expect: 'large' },
      { store: 'xlarge', expect: 'xlarge' },
    ],
    dirty: [
      { store: 'huge', expect: 'standard' },
      { store: '24px', expect: 'standard' },
      { store: '', expect: 'standard' },
    ],
  },
  {
    id: 'S8',
    fn: 'F9-02',
    label: '阅读字重',
    keys: ['chat-demo:reading-font-weight'],
    read: (m) => m.settings.useSettings.getState().readingFontWeight,
    write: (m, value) => m.settings.setReadingFontWeight(value),
    legal: [
      { store: 'regular', expect: 'regular' },
      { store: 'medium', expect: 'medium' },
      { store: 'bold', expect: 'bold' },
    ],
    dirty: [{ store: 'heavy', expect: 'regular' }, { store: '700', expect: 'regular' }],
  },
  {
    id: 'S9',
    fn: 'F9-02',
    label: '阅读行距',
    keys: ['chat-demo:reading-line-height'],
    read: (m) => m.settings.useSettings.getState().readingLineHeight,
    write: (m, value) => m.settings.setReadingLineHeight(value),
    legal: [
      { store: 'compact', expect: 'compact' },
      { store: 'standard', expect: 'standard' },
      { store: 'relaxed', expect: 'relaxed' },
    ],
    dirty: [{ store: 'wide', expect: 'standard' }, { store: '1.8', expect: 'standard' }],
  },
  {
    id: 'S10',
    fn: 'F9-05',
    label: '回车键行为',
    keys: ['chat-demo:enter-key-mode'],
    read: (m) => m.settings.useSettings.getState().enterKeyMode,
    write: (m, value) => m.settings.setEnterKeyMode(value),
    legal: [
      { store: 'enter-send', expect: 'enter-send' },
      { store: 'modifier-send', expect: 'modifier-send' },
      { store: 'button-only', expect: 'button-only' },
    ],
    dirty: [{ store: 'send', expect: 'enter-send' }, { store: '', expect: 'enter-send' }],
  },
  {
    id: 'S11',
    fn: 'F9-07',
    label: '智能搜索开关',
    keys: ['chat-demo:search'],
    read: (m) => m.settings.useSettings.getState().search,
    write: (m, value) => m.settings.setSearch(value),
    legal: [
      { value: true, store: 'true', expect: true },
      { value: false, store: 'false', expect: false },
    ],
    dirty: [{ store: 'TRUE', expect: false }, { store: '1', expect: false }, { store: '', expect: false }],
  },
  {
    id: 'S12',
    fn: 'F9-07',
    label: '侧边栏收起状态',
    keys: ['chat-demo:sider-collapsed'],
    read: (m) => m.settings.useSettings.getState().siderCollapsed,
    write: (m, value) => m.settings.setSiderCollapsed(value),
    legal: [
      { value: true, store: 'true', expect: true },
      { value: false, store: 'false', expect: false },
    ],
    dirty: [{ store: 'True', expect: false }, { store: 'yes', expect: false }],
  },
  {
    id: 'S13',
    fn: 'F9-08',
    label: '更新渠道（**不持久化**：重启按包版本号推断）',
    keys: [],
    // 没有写入口也没有存储键：这一行断言的是「契约」（见 N2-d 的静态断言）
    write: null,
    read: null,
  },
  {
    id: 'S14',
    fn: 'F9-13',
    label: '渠道选择（provider-kind，读回与脏值回落）',
    keys: ['chat-demo:provider-kind'],
    read: (m) => m.api.getProviderKind(),
    write: (m, value) => m.api.setProviderKind(value),
    legal: [
      { store: 'deepseek', expect: 'deepseek' },
      { store: 'anthropic', expect: 'anthropic' },
      { store: 'openai', expect: 'openai' },
      { store: 'ours', expect: 'ours' },
    ],
    dirty: [
      { store: 'gpt', expect: DEFAULT_KIND },
      { store: 'DeepSeek', expect: DEFAULT_KIND },
      { store: '', expect: DEFAULT_KIND },
    ],
  },
]

/** 更新渠道（S13）的契约证据：源码里没有任何存储读写，初值由包版本号推断 */
export const UPDATE_CHANNEL_CONTRACT = {
  file: 'src/components/settings/AppUpdateField.tsx',
  /** 初值推断 */
  derive: /useState<UpdateChannel>\(\s*\/-[/]\.test\(bundledApp\(\)\.version\)\s*\?\s*'prerelease'\s*:\s*'stable'\s*\)/,
  /** 不许出现的存储痕迹 */
  forbidden: [/localStorage/, /chat-demo:/, /setChannel\(\s*[^)]*\)[\s\S]{0,80}localStorage/],
}
