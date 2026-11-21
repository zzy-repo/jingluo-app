/**
 * N6 设置重载 + 渠道凭证隔离（域 9）的**唯一数据源**。
 *
 * N2 已经证明「模块层读回」：写进去、重启后 `useSettings` / `getProviderKind()` 读得到。
 * 但那只证明**模块读到了键**，证不到**界面真的消费了它**（主题没落到 `body.dark`、
 * 阅读档没落到根 `data-*`、渠道没落到设置页的输入行）。这一层需要真实产物 + reload。
 *
 * 一行 = 一张 seed 表 + 一次 reload + 一组界面断言：
 *   `seed` → reload → `probe` 决定了要看界面的哪一处，`expect` 是期望值。
 * F9-10（切渠道凭证隔离）用两行对称的 seed 证明「A 的地址/模型不会被带进 B」。
 */

export const FAKE_KEY = 'sk-reload-matrix-0123456789'

const ANTHROPIC_BASE = 'https://relay-a.example.com'
const ANTHROPIC_MODEL = 'claude-relay-model'
const OPENAI_BASE = 'https://relay-o.example.com'
const OPENAI_MODEL = 'gpt-relay-model'

/**
 * 这两个自填渠道的 host 会真的被界面拿去探测（打开设置页时 `GET {base}/v1/models`）。
 * 用例必须按 **host + path** 给它们打桩，否则探针会一路发到外网（#673 实测：改前每条真出网）。
 * 在 fixture 里导出 host，避免用例自己再抄一遍字符串。
 */
export const ANTHROPIC_HOST = new URL(ANTHROPIC_BASE).host
export const OPENAI_HOST = new URL(OPENAI_BASE).host

/** 两个自填渠道各自一份配置：切来切去都不许互串（#339 的根因在读取侧） */
const SCOPED_SEED = {
  'chat-demo:provider-kind': 'anthropic',
  'chat-demo:api-key': FAKE_KEY,
  'chat-demo:base-url:anthropic': ANTHROPIC_BASE,
  'chat-demo:model:anthropic': ANTHROPIC_MODEL,
  'chat-demo:base-url:openai': OPENAI_BASE,
  'chat-demo:model:openai': OPENAI_MODEL,
  'chat-demo:base-url': 'https://shared-legacy.example.com',
  'chat-demo:model': 'shared-legacy-model',
}

export const RELOAD_CASES = [
  {
    id: 'R1',
    fn: 'F9-01',
    label: '主题=深色：重载后界面真的是深色',
    seed: { 'chat-demo:theme-preference': 'dark' },
    probe: 'theme',
    expect: { dark: true, light: false },
  },
  {
    id: 'R2',
    fn: 'F9-01',
    label: '主题=浅色：重载后界面真的是浅色',
    seed: { 'chat-demo:theme-preference': 'light' },
    probe: 'theme',
    expect: { dark: false, light: true },
  },
  {
    id: 'R3',
    fn: 'F9-01',
    label: '主题=跟随系统 + 系统深色 → 界面深色',
    seed: { 'chat-demo:theme-preference': 'system' },
    context: { colorScheme: 'dark' },
    probe: 'theme',
    expect: { dark: true, light: false },
  },
  {
    id: 'R4',
    fn: 'F9-02',
    label: '阅读三档（大 / 加粗 / 宽松）落到根元素 data-*',
    seed: {
      'chat-demo:reading-font-size': 'xlarge',
      'chat-demo:reading-font-weight': 'bold',
      'chat-demo:reading-line-height': 'relaxed',
    },
    probe: 'reading',
    expect: { size: 'xlarge', weight: 'bold', line: 'relaxed' },
  },
  {
    id: 'R5',
    fn: 'F9-03',
    label: '思考显示=展开：设置页的选择器显示「展开」',
    seed: { 'chat-demo:thinking-display': 'expanded' },
    probe: 'select',
    expect: { ariaLabel: '思考过程', label: '展开' },
  },
  {
    id: 'R6',
    fn: 'F9-05',
    label: '回车=只换行：输入框 enterKeyHint 变 enter，选择器同步',
    seed: { 'chat-demo:enter-key-mode': 'button-only' },
    probe: 'enter-key',
    expect: { enterKeyHint: 'enter', ariaLabel: '回车键行为', label: '只换行（点发送按钮才发送）' },
  },
  {
    id: 'R7',
    fn: 'F9-05',
    label: '回车=回车发送：输入框 enterKeyHint = send',
    seed: { 'chat-demo:enter-key-mode': 'enter-send' },
    probe: 'enter-key',
    expect: { enterKeyHint: 'send', ariaLabel: '回车键行为', label: '回车发送（Shift + 回车换行）' },
  },
  {
    id: 'R8',
    fn: 'F9-09',
    label: '渠道=Anthropic 协议：重载后渠道还在，且渲染服务地址 / 模型两行',
    seed: { 'chat-demo:provider-kind': 'anthropic', 'chat-demo:api-key': FAKE_KEY },
    probe: 'channel',
    expect: { channelLabel: 'Anthropic 协议', hasBaseUrl: true, hasModel: true },
  },
  {
    id: 'R9',
    fn: 'F9-09',
    label: '渠道=OpenAI 兼容：重载后渠道还在，且渲染服务地址 / 模型两行',
    seed: { 'chat-demo:provider-kind': 'openai', 'chat-demo:api-key': FAKE_KEY },
    probe: 'channel',
    expect: { channelLabel: 'OpenAI 兼容', hasBaseUrl: true, hasModel: true },
  },
  {
    id: 'R10',
    fn: 'F9-10',
    label: '渠道=Anthropic：地址/模型只读自己那份（不串 OpenAI 也不串共享老键）',
    seed: SCOPED_SEED,
    probe: 'channel',
    expect: { channelLabel: 'Anthropic 协议', baseUrl: ANTHROPIC_BASE, model: ANTHROPIC_MODEL },
  },
  {
    id: 'R11',
    fn: 'F9-10',
    label: '渠道=OpenAI：地址/模型只读自己那份（不串 Anthropic）',
    seed: { ...SCOPED_SEED, 'chat-demo:provider-kind': 'openai' },
    probe: 'channel',
    expect: { channelLabel: 'OpenAI 兼容', baseUrl: OPENAI_BASE, model: OPENAI_MODEL },
  },
  {
    id: 'R12',
    fn: 'F9-10',
    label: '切渠道后 Key 不丢（四渠道共用一把，只提示可重填）',
    seed: { ...SCOPED_SEED, 'chat-demo:api-key': FAKE_KEY },
    probe: 'switch-keep-key',
    expect: { masked: true, hint: true },
  },
  {
    id: 'R13',
    fn: 'F9-06',
    label: '语言=en-US：重载后设置弹窗标题是英文',
    seed: { 'chat-demo:locale': 'en-US' },
    probe: 'locale',
    expect: { settingsTitle: 'Settings' },
  },
]
