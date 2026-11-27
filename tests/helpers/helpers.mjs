// 共享的 Playwright 步骤：把用户真的会走的路收成一处（打开设置 → 账户与消费 → 模型来源 → 改一项 → 确认使用），
// 并捕获 /models 探测请求。
//
// ## 这一层的职责（gate/helpers 重写口径，2026-11-25）
//
// 辅助层只做两件事：**让用例像用户那样点到目标**、**失败时说清卡在哪一步**。它不替用例钉住某个
// testid 的现状 —— 所以要按「产品的**身份**」取（testid / 行 id / aria 关系），而不是按位置
// （`.last()`）或按文案子串（`name: /渠道/`）取；后者在 UI 一改版时要么静默点到别的东西，
// 要么把一次红变成 30s 超时堆栈。
//
// ## 设置层的现状（2026-11-24 改版 + #727 + #807，改之前的口径全都过期了）
//
//   · **全仓没有 `role="tab"` 了**：一级是「分组列表」（`settings-list`，行 = `settings-row-*`
//     / `account-consume-open`），点行把内容区整页换成二级页（`settings-page-<page>`）。
//   · **「数据管理」页里没有渠道/Key 字段**：那些字段全在
//     「设置 → 账户与消费 → 模型来源」（`account-consume-source` → `settings-source-accordion`）。
//   · **「渠道」下拉不存在**：来源页是三行**单层手风琴**（内置服务 / 第三方服务 / DeepSeek 官方服务，
//     `settings-source-<row>`），`ApiConfigFields` 在这一页 `hideProviderKind`。改渠道 =
//     展开那一行 → 填草稿（`settings-source-draft-*`）→ 点行底「确认使用」
//     （`settings-source-<row>-confirm`）；**展开 ≠ 生效**，「正在使用」= 打勾的那一行
//     （`settings-source-current`），落盘在既有键 `chat-demo:provider-kind`。
//   · 内置服务那一行**没有字段**（Key 由服务端下发，#800），点行头 = 领取 / 直接生效。
//
// 于是本层只有**一条**真实路径（`openSettingsRoot` → `openSettingsPage` → `openApiConfigSection`
// → `openSourceRow` → `fill*` → `clickApiKeyConfirm`），旧函数名全部保留并改成走它；
// 每一步失败都抛出「卡在哪一步 / 期望什么 / 现在是什么 / 已经走通了哪几步」，不用读超时堆栈。
import { chromium } from 'playwright'
import { defaultDist, verifyAppUrl } from './env.mjs'
// #673：出站总闸复用 golden 层那一套（withStubbedBackends），不另写一份实现。
import { withStubbedBackends } from './golden.mjs'
// #803 × 测试接缝：未配置首屏会真的去领内置 Key（GET apia.ecsafe.cn/api/v1/keys → 401）。
// 它是「与用例无关的启动链路」，由本层的 `openApp()` 默认装成外部服务替身（见 openApp 的注释）。
// 「与用例无关的启动链路」替身清单（黄金层与 L1 共用同一份，别在这里另列一遍）
import { GATEWAY_STARTUP_STUBS } from '../fixtures/startup/startup-chain-stubs.mjs'

/**
 * 默认装进 `openApp()` / `installEgressGate()` 的桩：**与用例无关、但每次都会真出网**的两条链。
 *
 *   · `builtin-key-claim`（#803 × 测试接缝）：「登录后自动领内置 Key」的查重 → 冷启动 2 次、401；
 *   · `consume-profile`（2026-11-24 设置改版）：「账户与消费」页挂载时拉一次账号资料 → 401。
 *
 * 两条都**不是**放宽：host 仍要在白名单里，桩命中之外的出站照样记「未登记出站」→ 红。
 * 断言这两条链本身的用例传 `stubBuiltinKeyClaim: false` / 自己传 `stubs`。
 */
const DEFAULT_STUBS = GATEWAY_STARTUP_STUBS

// 默认走 127.0.0.1：语音输入用例需要「安全上下文」（localhost/127.0.0.1）才拿到麦克风，
// 局域网 IP（100.113.135.55）不是安全上下文，按钮会被置灰成「非 HTTPS 页面无法使用语音输入」。
export const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
export const FAKE_KEY = 'sk-testkey-0123456789'

/** 本进程里装配过的出站总闸（`finish` / `assertNoEgress` 收尾统一断言一遍） */
const egressGates = []

/**
 * 收尾断言：**本进程装配过的每一个总闸**都不许有漏出的请求（#673）。
 *
 * 为什么是「兜底」而不是「用例自己写」：`openApp()` 里就装上了闸，本层 9 个文件共用它；
 * 用例忘了写断言时，漏出去的请求照样把 `failures` 顶红 —— 判据不能靠自觉。
 * 失败行一句话给出 `METHOD host+path` 与白名单外的 host，与 golden 的口径一致。
 */
export const assertNoEgress = (failures, step = '不连真实服务') => {
  for (const guard of egressGates) {
    if (guard.asserted) {
      continue
    }
    guard.assertNoLeak({
      expect: (label, pass, { expected, actual }) => {
        if (!pass) {
          failures.push(`${label || step} · 期望=${expected} · 实际=${actual}`)
          return
        }
        // #686：通过时也留一行证据。「漏出 = 0」要能原样贴进 Issue/PR，不能只靠「没红」反推；
        // 这一行只说事实（命中几次、白名单是谁），不放宽任何判据。
        console.log(`  ok  ${label || step}：${actual}`)
      },
    })
  }
}

/**
 * 给**自起静态服务 / 自己要视口 / 自己要 mock 上游**的 L1 用例装同一个出站总闸（#686）。
 *
 * 为什么不直接用 `openApp()`：`openApp()` 只服务「5181 注入 + 干净应用」那 9 个文件；其余 20 个
 * 集成层文件各有各的脚手架（自 serve `dist` / 自建上下文 / 自己起本机 mock 上游 / 自建 harness 产物），
 * 但它们要的是**同一道闸**。所以这里只做两件事，**不另写一份实现**：
 *   1. 调 `withStubbedBackends`（golden 层那一套：host+path 匹配、未登记一律记录 + abort）；
 *   2. 把闸登记进本模块的 `egressGates`，让 `assertNoEgress(failures)` 收尾统一断言。
 *
 * 必须在 `page.goto()` **之前**调用 —— 首屏请求一旦发出去就收不回来了（#673 的 g16 就是这么漏的）。
 *
 * 白名单口径比 `openApp()` 更严：默认 `allowLoopback: false`。这些用例里本机服务的 `host:port`
 * 在起服务那一刻就知道了，能写精确值就别退化成「回环随便哪个端口」。
 *
 * `stubBuiltinKeyClaim`（默认开）：见 {@link openApp} 里那段 —— #803 之后「已登录 + 未配置」的首屏
 * 会真的去离线网关领内置 Key，**和用例要测的东西无关**，所以由本层默认装成外部服务替身。
 * 要断言那条链路本身的用例传 `false` 自己装。
 *
 *   const guard = await installEgressGate(page, {
 *     appUrl: APP_URL,
 *     allowHosts: [new URL(mock.url).host],   // 本机真起的 mock 上游（精确 host:port）
 *     stubs: [{ name: 'feedback', host: 'feedback.rose7.cn', path: '/api/v1/feedback', respond: () => ({ status: 503 }) }],
 *   })
 *   …用例…
 *   assertNoEgress(failures)                   // 收尾：漏出 = 0，否则进 failures → 非 0 退出
 */
export const installEgressGate = async (
  page,
  { appUrl = '', stubs = [], allowHosts = [], allowLoopback = false, stubBuiltinKeyClaim = true } = {}
) => {
  const guard = await withStubbedBackends(page, {
    appUrl,
    stubs: [...(stubBuiltinKeyClaim ? DEFAULT_STUBS : []), ...stubs],
    allowHosts,
    allowLoopback,
  })
  egressGates.push(guard)
  return guard
}

/**
 * 启动浏览器并进入「干净」的应用状态：清掉 localStorage 里已保存的配置后重载。
 *
 * ## `stubs` 透传（旧签名 `openApp()` 保持不变）
 *
 *   const { browser, page, guard } = await openApp({
 *     stubs: [{ name: 'feedback', host: 'feedback.rose7.cn', path: '/api/v1/feedback', respond: () => ({ status: 503 }) }],
 *   })
 *
 * 桩的形状与 `installEgressGate` / golden 层同一份（`{ name, host, path, method?, respond }`），
 * 在 `page.goto()` **之前**登记好 —— 首屏请求一旦发出去就收不回来了。
 *
 * ## 默认装的那两条桩（都与用例无关，却每次都会真出网）
 *
 * 1. `builtin-key-claim`（#803 × 测试接缝）：`TEST_AUTH_SEAM=1` 让产物以为「已登录」，于是
 *    **未配置**的首屏会真的走「登录后自动领内置 Key」——冷启动实测发 2 次
 *    `GET https://apia.ecsafe.cn/api/v1/keys?...` 并拿到 401；
 * 2. `consume-profile`（2026-11-24 设置改版）：新路径一进「账户与消费」就拉一次
 *    `GET https://apia.ecsafe.cn/api/v1/user/profile`（L1 要显示钱包 / 账号），接缝下同样 401。
 *
 * 两条都不是被测物的问题，却会同时带红两类断言：装了总闸的用例记成「未登记出站」，
 * 断言 `console error = 0` 的用例被 `Failed to load resource: 401` 带红。
 * 文件在 `tests/fixtures/consume-gateway-stubs/`（前者是 L1 那边写好的 11 个文件共用桩，
 * 这里只是**默认装载**，语义一个字没动）。
 *
 * **总闸的断言一个字没放宽**：桩只是「本机应答这条 host+path」，仍然要在白名单里登记；
 * 真往别处发照样记 `未登记出站` → 红；桩的路径写错（服务端改了 `/keys`）那一刻请求又变成
 * 未登记 → 立刻红。传 `stubBuiltinKeyClaim: false` 可以关掉它（要断言这条链路本身时）。
 */
export const openApp = async ({ stubs = [], allowHosts = [], stubBuiltinKeyClaim = true } = {}) => {
  // 环境守卫：APP_URL 不可达 / serve 的不是本地 dist（端口撞车）/ 产物陈旧 → SKIP(env)，不产生假红
  await verifyAppUrl(APP_URL, defaultDist(), { variant: 'standard' })
  // 伪造麦克风：语音输入用例要真的走一次 /v1/tools/asr（被测页需为 localhost/127.0.0.1 这类安全上下文）
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
  })
  const page = await context.newPage()
  /**
   * #673：**桩/总闸必须在 `page.goto` 之前装好**。golden 层 G16 的漏网就是「桩注册晚于打开页面」——
   * 首屏请求一旦发出去就收不回来了。这里同样把闸装在 goto 前面：未登记的出站一律记录 + abort。
   * 回环（127.0.0.1 的随机端口 mock）放行，见 `withStubbedBackends` 的 `allowLoopback`。
   */
  const guard = await withStubbedBackends(page, {
    appUrl: APP_URL,
    allowLoopback: true,
    allowHosts,
    stubs: [...(stubBuiltinKeyClaim ? DEFAULT_STUBS : []), ...stubs],
  })
  egressGates.push(guard)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  return { browser, page, guard }
}

// ───────────────────────────────── 设置层：从首屏走到「某一页 → 改一项 → 确认」的唯一路径
//
// 这一段的每个函数都按**产品的身份**取节点，失败时抛一条能直接贴进 Issue 的错：
//   卡在哪一步 · 期望什么 · 现在是什么 · 已经走通了哪几步
// 期望值一律写「产品的形状」（testid / aria-expanded / data-status），不写「上次见到的文案」——
// 文案改了要红，但红的时候得一眼看出是文案改了还是路径断了。

/** 设置一级列表的**行**（`settings-list` 里的一行 = 一个二级页的入口） */
export const SETTINGS_ROW = {
  consume: 'account-consume-open',
  appearance: 'settings-row-appearance',
  general: 'settings-row-general',
  voice: 'settings-row-voice',
  data: 'settings-row-data',
  announcement: 'settings-row-announcement',
  update: 'settings-row-update',
  help: 'settings-row-help',
}

/** 「模型来源」手风琴的三行（#807；同一时间只展开一行） */
export const SOURCE_ROW = { builtin: 'builtin', third: 'third', official: 'official' }

const SETTINGS_LIST = '[data-testid="settings-list"]'
const SETTINGS_ACCORDION = '[data-testid="settings-source-accordion"]'
/** 展开区：`hidden` 只在收起时存在，所以「没 hidden 的那一个」= 当前正在编辑的一行 */
const OPEN_SOURCE_PANEL = `${SETTINGS_ACCORDION} [data-testid$="-panel"]:not([hidden])`
/** 每步默认的等待上限：够慢机渲染，又不至于把一次红拖成 30s 超时堆栈 */
const STEP_TIMEOUT_MS = 5000

/** 生效来源（`ProviderKind`）→ 手风琴的那一行。与产品 `sourceAccordion.rowOfKind` 同一份口径 */
const rowOfKind = (kind) => (kind === 'ours' ? 'builtin' : kind === 'deepseek' ? 'official' : 'third')

/**
 * 设置弹层：**按内容里的身份取**，不按标题文案、也不按 `role=dialog` 的 DOM 顺序。
 *
 * 为什么不能用标题：弹层标题随二级页变（「设置」/「数据管理」/「模型来源」/「账户与消费」…），
 * 按 `name: /设置/` 取会在一进二级页就变成 0 个 —— 那正是「关设置」静默不生效、后面所有点击
 * 被遮罩吃掉的开端。为什么不按 `.first()`：首屏的公告弹层、更新提示、附件面板都是 `role=dialog`，
 * 谁在前取决于用户当时开了什么。稳定的身份只有一个：**它里面装着设置自己的节点**
 * （一级列表 `settings-list` 或任一二级页 `settings-page-*`）。
 */
const settingsDialog = (page) =>
  page.locator('[role="dialog"]:has([data-testid="settings-list"], [data-testid^="settings-page-"])')

const waitUntil = async (predicate, timeoutMs = STEP_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** 一条可归因的失败：`卡在哪一步 · 期望 · 实际 · 已走通` */
const stepError = (step, expected, actual, walked = []) => {
  const lines = [`[helpers] 卡在「${step}」`, `  期望：${expected}`, `  实际：${actual}`]
  if (walked.length > 0) {
    lines.push(`  已走通：${walked.join(' → ')}`)
  }
  return new Error(lines.join('\n'))
}

/**
 * 打开设置弹层，落在**一级列表**（`settings-list`）。
 *
 * 侧栏那个「设置」按钮没有 testid（产品侧未给），所以按**整串可访问名**锚定 —— 不用
 * `name: /设置/` 子串（会命中「设置」二字出现在别的按钮里的情况）、也不靠 `.last()` 的 DOM 顺序。
 * 已经在设置里（任意二级页）时不重复点，先一层层「返回」回到一级列表。
 */
export const openSettingsRoot = async (page) => {
  const walked = []
  if ((await settingsDialog(page).count()) === 0) {
    const entry = page.getByRole('button', { name: /^设置$|^Settings$/ })
    if ((await entry.count()) === 0) {
      throw stepError(
        '打开设置（点侧栏底部「设置」）',
        '一个可访问名整串等于「设置」的按钮',
        '0 个：侧栏没渲染 / 窄屏被收起 / 首屏还没画完',
        walked
      )
    }
    await entry.first().click()
    if (!(await waitUntil(async () => (await settingsDialog(page).count()) > 0))) {
      throw stepError(
        '打开设置（点侧栏底部「设置」）',
        '点完出现设置弹层（role=dialog 且里面装着 settings-list / settings-page-*）',
        '点了但目前没有这个弹层（可能是别的弹层抢了焦点，或弹层还没挂载）',
        [...walked, '已点「设置」按钮']
      )
    }
    walked.push('设置弹层已打开')
  }
  // 回到一级列表：二级页里没有 settings-list，只有「返回」（账户与消费的下级页用 account-consume-back）
  for (let hop = 0; hop < 4; hop += 1) {
    if ((await page.locator(SETTINGS_LIST).count()) > 0) {
      return walked.concat('停在一级列表')
    }
    const back = page.getByTestId('settings-back')
    const innerBack = page.getByTestId('account-consume-back')
    const button = (await back.count()) > 0 ? back : innerBack
    if ((await button.count()) === 0) {
      throw stepError(
        '回到设置一级列表',
        'settings-list（一级列表）或可点的 settings-back / account-consume-back',
        '三者都不在页面上：设置弹层里的内容区是空的或停在未知页',
        walked
      )
    }
    await button.first().click()
    walked.push('点一次「返回」')
    await page.waitForTimeout(120)
  }
  throw stepError('回到设置一级列表', 'settings-list（一级列表）', '点了 4 次「返回」仍没到一级列表：二级页层数变了', walked)
}

/**
 * 一级列表 → 某个二级页。`testId` 取 {@link SETTINGS_ROW} 里的值。
 *
 * 落点锚点按产品的命名规则推：`account-consume-open` → `settings-page-consume`，
 * `settings-row-data` → `settings-page-data`（`SettingsDialog` 的 `data-testid={'settings-page-' + page}`）。
 */
export const openSettingsPage = async (page, testId) => {
  const walked = await openSettingsRoot(page)
  const row = page.getByTestId(testId)
  if ((await row.count()) === 0) {
    const rows = await page
      .locator(`${SETTINGS_LIST} [data-testid]`)
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
    throw stepError(
      `点一级列表的「${testId}」这一行`,
      `恰好 1 个 [data-testid="${testId}"] 的行`,
      `0 个；一级列表上现有的行 = ${rows.join('、') || '（一个都没有）'}`,
      walked
    )
  }
  const pageId = testId === SETTINGS_ROW.consume ? 'consume' : testId.replace('settings-row-', '')
  await row.first().click()
  if (
    !(await waitUntil(async () => (await page.getByTestId(`settings-page-${pageId}`).count()) > 0))
  ) {
    throw stepError(
      `点一级列表的「${testId}」这一行`,
      `点完出现二级页 [data-testid="settings-page-${pageId}"]`,
      `点了但没有这个二级页（弹层文本片段：${JSON.stringify(
        await page
          .getByRole('dialog')
          .first()
          .innerText()
          .then((text) => text.slice(0, 120))
          .catch(() => '（连弹层都没有）')
      )}）`,
      walked
    )
  }
  return walked.concat(`进到二级页 settings-page-${pageId}`)
}

/** 「账户与消费」一级列表（L1）的三行：模型来源 / 我的钱包 / 账号 */
export const ACCOUNT_ROW = {
  source: 'account-consume-source',
  wallet: 'account-consume-wallet',
  account: 'account-consume-tab-account',
}

/**
 * 设置 → 账户与消费 → 点 L1 的某一行（`ACCOUNT_ROW` 里的值）。
 *
 * 为什么需要它：账户与消费是**两级页**（L1 三行 → L2 钱包 / 模型来源 / 账号 / 卡密 / 购买），
 * 而 L1 与各 L2 用的是同一个容器 testid（`account-consume-page`）—— 光看容器分不出自己在第几层，
 * 能分出来的只有「L1 的三行在不在」。所以这里：不在 L1 就沿 `account-consume-back` 一层层退回来，
 * 再点目标行。L2 页里没有那一行时**当场报错并列出真实行**，不许点到超时。
 *
 * @param {string} testId {@link ACCOUNT_ROW} 里的值
 */
export const openAccountRow = async (page, testId) => {
  const walked = []
  if ((await page.getByTestId(testId).count()) === 0) {
    // 还没进「账户与消费」：先按一级列表那一行进（openSettingsPage 会先回设置一级列表）
    await openSettingsPage(page, SETTINGS_ROW.consume)
    walked.push('进到「账户与消费」L1')
  }
  for (let hop = 0; hop < 4 && (await page.getByTestId(testId).count()) === 0; hop += 1) {
    const back = page.getByTestId('account-consume-back')
    if ((await back.count()) === 0) {
      break
    }
    await back.first().click()
    await page.waitForTimeout(120)
    walked.push('点一次「返回」')
  }
  const row = page.getByTestId(testId)
  if ((await row.count()) === 0) {
    const rows = await page
      .locator('[data-testid="account-consume-page"] [data-testid]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
    throw stepError(
      `点「账户与消费」里的「${testId}」这一行`,
      `恰好 1 个 [data-testid="${testId}"] 的行（L1 三行之一）`,
      `0 个；当前页现有的 testid = ${rows.join('、') || '（一个都没有）'}`,
      walked
    )
  }
  await row.first().click()
  return walked.concat(`点了「${testId}」`)
}

/**
 * 展开「模型来源」里的某一行（`builtin` / `third` / `official`）。
 *
 * 为什么是「展开」而不是「选中」：#807 起**展开 ≠ 生效**。展开只是「正在查看」，切换生效来源
 * 只有两条路 —— 内置服务领取成功，或第三方/官方点行底的「确认使用」（{@link clickApiKeyConfirm}）。
 * 已展开的行再点会**收起**，所以这里先读 `aria-expanded` 再决定点不点。
 *
 * @param {string} row {@link SOURCE_ROW} 里的值
 * @param {{steps?: string[]}} [options] 调用方已走过的步骤（只用于失败时的那一行「已走通」）
 */
export const openSourceRow = async (page, row, { steps = [] } = {}) => {
  const testId = `settings-source-${row}`
  const header = page.locator(`${SETTINGS_ACCORDION} [data-testid="${testId}"]`)
  if (!(await waitUntil(async () => (await header.count()) === 1))) {
    const known = await page
      .locator(`${SETTINGS_ACCORDION} button[aria-expanded][data-testid]`)
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
    throw stepError(
      `展开来源行「${testId}」`,
      `「模型来源」页上恰好 1 个可点的行头 [data-testid="${testId}"]`,
      `找到 ${await header.count()} 个；同页现有的行头 = ${known.join('、') || '（一个都没有 —— 可能还没进到「模型来源」页）'}`,
      steps
    )
  }
  if ((await header.getAttribute('aria-expanded')) === 'true') {
    return row
  }
  await header.first().click()
  const opened = await waitUntil(async () => (await header.getAttribute('aria-expanded')) === 'true')
  if (!opened) {
    const status = await page
      .locator(`[data-testid="${testId}-status"]`)
      .getAttribute('data-status')
      .catch(() => null)
    throw stepError(
      `展开来源行「${testId}」`,
      '点行头后 aria-expanded="true"（展开区里才有草稿字段与「确认使用」）',
      `点了但 aria-expanded=${JSON.stringify(await header.getAttribute('aria-expanded'))}，行状态=${JSON.stringify(status)}` +
        (status === 'claiming' ? '（领取中整行禁用，等领取结束再点）' : ''),
      steps
    )
  }
  return row
}

/** 当前展开着的那一行的展开区（`#807` 保证同一时间只有一行展开） */
const openSourcePanel = async (page, step) => {
  const panel = page.locator(OPEN_SOURCE_PANEL)
  const count = await panel.count()
  if (count !== 1) {
    const open = await page
      .locator(`${SETTINGS_ACCORDION} button[aria-expanded]`)
      .evaluateAll((nodes) =>
        nodes.filter((node) => node.getAttribute('aria-expanded') === 'true').map((node) => node.getAttribute('data-testid'))
      )
    throw stepError(
      step,
      '恰好 1 个展开的来源行（[data-testid$="-panel"]:not([hidden])）—— 字段区只在展开的那一行里',
      `${count} 个；aria-expanded=true 的行头 = ${open.join('、') || '（没有行展开）'}；` +
        '先 openSourceRow() / selectProviderKind()，或用 openSettingsDataSection() 直接落到当前生效来源那一行',
      []
    )
  }
  return panel
}

/** 展开区的行名（`settings-source-<row>-panel` → `<row>`），失败信息里要用它说清「改的是哪一行」 */
const rowOfPanel = async (panel) => {
  const testId = await panel.getAttribute('data-testid')
  return String(testId ?? '').replace(/^settings-source-/, '').replace(/-panel$/, '')
}

/** 读当前生效来源（落盘的 `chat-demo:provider-kind`；从没写过 = 构建默认，标准包是 deepseek） */
export const readProviderKind = (page) =>
  page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))

/**
 * 等「生效来源」真的变成 `kind` —— **断的是 `chat-demo:provider-kind` 这个事实**，不是界面文案。
 *
 * 为什么需要它：点「确认使用」是同步写存储，但 React 落到界面上还要一次渲染；用例若立刻去读
 * 行头的 ✓，会偶发读到上一帧。等的是终态（存储），不是「睡一会儿」。
 */
export const waitForProviderKind = async (page, kind, { timeoutMs = STEP_TIMEOUT_MS, steps = [] } = {}) => {
  let actual = null
  const ok = await waitUntil(async () => {
    actual = await readProviderKind(page)
    return actual === kind
  }, timeoutMs)
  if (!ok) {
    const statuses = await page
      .locator(`${SETTINGS_ACCORDION} [data-testid$="-status"]`)
      .evaluateAll((nodes) =>
        nodes.map((node) => `${node.getAttribute('data-testid') ?? '?'}=${node.getAttribute('data-status')}`)
      )
    throw stepError(
      `等生效来源切到「${kind}」`,
      `localStorage 里 chat-demo:provider-kind === ${JSON.stringify(kind)}`,
      `实际 ${JSON.stringify(actual)}${actual === null ? '（键不存在 = 从没写过，按构建默认）' : ''}；` +
        `行状态 = ${statuses.join('、') || '（页面上没有来源行）'}`,
      steps
    )
  }
  return kind
}

/**
 * 设置 → 账户与消费 → 模型来源，并**展开当前生效来源那一行**（旧口径里「数据管理」页上那块
 * 渠道/Key 字段区，现在长在这里；见文件头的 IA 变更）。
 *
 * 为什么展开「当前生效」那一行而不是固定某一行：旧 helper 的落点是「当前渠道的字段区」——
 * 内置服务没有字段（Key 由服务端下发），第三方/官方才有；这里保持同一个落点语义。
 * 要改别的来源，接着调 {@link openSourceRow}。
 *
 * @returns {Promise<string>} 展开的行（`builtin` / `third` / `official`）
 */
export const openApiConfigSection = async (page, { row } = {}) => {
  const walked = await openSettingsPage(page, SETTINGS_ROW.consume)
  const sourceRow = page.getByTestId('account-consume-source')
  if ((await page.locator(SETTINGS_ACCORDION).count()) === 0) {
    if ((await sourceRow.count()) === 0) {
      const rows = await page
        .locator('[data-testid="account-consume-page"] [data-testid]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
      throw stepError(
        '点「账户与消费」里的「模型来源」这一行',
        `一行 [data-testid="account-consume-source"]（或已经在「模型来源」页，有 ${SETTINGS_ACCORDION}）`,
        `两者都不在；这一页现有的 testid = ${rows.join('、') || '（一个都没有）'}`,
        walked
      )
    }
    await sourceRow.first().click()
    if (!(await waitUntil(async () => (await page.locator(SETTINGS_ACCORDION).count()) > 0))) {
      throw stepError(
        '点「账户与消费」里的「模型来源」这一行',
        `点完出现 ${SETTINGS_ACCORDION}`,
        '点了但手风琴没渲染出来',
        walked
      )
    }
    walked.push('进到「模型来源」（settings-source-accordion）')
  }
  const target = row ?? rowOfKind((await readProviderKind(page)) ?? 'deepseek')
  await openSourceRow(page, target, { steps: walked })
  return target
}

/**
 * 兼容名（旧语义：进「能改渠道 / 填 Key / 测连通性」的那一页）。
 *
 * 「数据管理」页在 2026-11-24 改版后**只剩导入/导出/反馈/删除**，渠道与 Key 全搬到了
 * 「设置 → 账户与消费 → 模型来源」—— 所以这个名字里的 "Data" 已经是历史名词，落点按**意图**
 * （那一页现在叫模型来源）走，函数名保留是为了不让 12 个调用点二次改动。
 *
 * @param {{row?: string}} [options] 只用于自证「指向不存在的行必须快速红」，正常不用传
 */
export const openSettingsDataSection = async (page, options = {}) => openApiConfigSection(page, options)

/** 旧别名（`openSettingsDataTab === openSettingsDataSection`）保留 */
export const openSettingsDataTab = openSettingsDataSection

/** 监听 /models 请求，返回数组（元素为 { url, authorization, apiKey, version }） */
export const captureProbeRequests = (page) => {
  const captured = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.endsWith('/models')) {
      const headers = request.headers()
      captured.push({
        url: request.url(),
        authorization: headers['authorization'],
        apiKey: headers['x-api-key'],
        version: headers['anthropic-version'],
      })
    }
  })
  return captured
}

/**
 * 点草稿区里的「测试」按钮（连通性探测）。
 *
 * 按 testid 取（`settings-source-draft-test`），不按文案 —— 设置页别处还有「测试」二字
 * （旧口径的 `name: /^测试$/` + `.first()` 会点到 DOM 顺序在前的那个，改版后就成了猜）。
 * 探测失败不影响「确认使用」（#807：探测结果只是告诉用户，不拦按钮）。
 */
export const clickTest = async (page) => {
  const panel = await openSourcePanel(page, '点草稿区的「测试」')
  const button = panel.getByTestId('settings-source-draft-test')
  if ((await button.count()) === 0) {
    throw stepError(
      '点草稿区的「测试」',
      '展开区里有 [data-testid="settings-source-draft-test"]',
      `当前展开的是「${await rowOfPanel(panel)}」那一行，它没有探测按钮（内置服务没有可编辑字段）`,
      []
    )
  }
  await button.first().click()
}

/** 等待第一条探测请求出现（等不到返回 false） */
export const waitForProbe = async (page, captured, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (captured.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(100)
  }
  return captured.length > 0
}

/** 统一的收尾：出站总闸断言（#673）→ 打印失败原因并以非 0 退出，或用例通过 */
export const finish = async (browser, name, failures) => {
  // 先断言再关浏览器：abort/记录都发生在页面还活着的时候
  assertNoEgress(failures)
  await browser.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}`)
}

// ---------- 1.2.3 服务类型 / 协议适配用例共用的步骤 ----------

/** 伪造一段合法的 Messages SSE 响应，让用例不依赖真实上游 */
export const MESSAGES_SSE_OK = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"deepseek-flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好呀"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

/** 捕获所有请求 { method, path, url, headers } */
export const capturePaths = (page) => {
  const list = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    list.push({
      method: request.method(),
      path: url.pathname,
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
    })
  })
  return list
}

/** 把消息接口打桩成正常 SSE（避免真的连上游） */
export const stubMessagesStream = async (page, pathRe = /\/anthropic\/v1\/messages$/) => {
  await page.route(pathRe, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: MESSAGES_SSE_OK,
    })
  })
}

/** 把 /models 打桩成正常模型列表 */
export const stubModels = async (page, pathRe = /\/models$/) => {
  await page.route(pathRe, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }),
    })
  })
}

/** 把 /v1/tools/asr 打桩成识别结果 */
export const stubAsr = async (page) => {
  await page.route(/\/v1\/tools\/asr$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '语音转写内容' }),
    })
  })
}

/**
 * 在**当前展开的那一行**里填 API Key（不点「确认使用」）。
 *
 * 为什么必须先有展开行：字段区只在展开的那一行里（`settings-source-<row>-panel`），
 * 而三行的 `data-testid` 是同名的（`settings-source-draft-apiKey` 在第三方与官方两份面板里
 * 各有一个）—— 裸 `input[type="password"]` 或裸 testid 取到的都是 2 个，只有「展开的那一个」
 * 才是用户此刻在改的那一份。所以这里按**面板归属**取，不按位置取。
 */
export const fillApiKey = async (page, key) => {
  const panel = await openSourcePanel(page, '填 API Key')
  const input = panel.getByTestId('settings-source-draft-apiKey')
  if ((await input.count()) === 0) {
    throw stepError(
      '填 API Key',
      '展开区里有 [data-testid="settings-source-draft-apiKey"]',
      `当前展开的是「${await rowOfPanel(panel)}」那一行，它没有 Key 输入框` +
        '（内置服务的 Key 由服务端下发，#800 起该行字段清单为空；要改它请点行头领取）',
      []
    )
  }
  await input.first().fill(key)
}

/**
 * 点当前展开行的「确认使用」（= 旧口径的「确定」，`settings-source-<row>-confirm`）。
 *
 * #807：这是**切换生效来源**的两条路之一（另一条是内置服务领取成功）。校验不过时产品只在行内
 * 写红字、不切渠道 —— 那种情况下后面那条「渠道没切」的断言会红得莫名其妙，所以这里当场把行内
 * 红字原样抛出来，红在「哪一格填错了」上。
 *
 * @returns {Promise<string>} 确认的是哪一行（`third` / `official`）
 */
export const clickApiKeyConfirm = async (page) => {
  const panel = await openSourcePanel(page, '点「确认使用」')
  const row = await rowOfPanel(panel)
  const confirm = panel.locator('[data-testid$="-confirm"]')
  if ((await confirm.count()) === 0) {
    throw stepError(
      '点「确认使用」',
      `展开区底部有 [data-testid="settings-source-${row}-confirm"]`,
      `当前展开的「${row}」那一行没有确认按钮（内置服务那一行是「行即动作」：点行头才生效）`,
      []
    )
  }
  await confirm.first().click()
  // 一次渲染：校验不过 → 行内红字；通过 → 生效来源改写（由调用方 waitForProviderKind 断）
  await page.waitForTimeout(150)
  const error = panel.locator('[data-testid$="-error"]')
  if ((await error.count()) > 0) {
    throw stepError(
      '点「确认使用」',
      '校验通过 → 生效来源切到这一行（产品在这种情况下不写行内红字）',
      `行内红字：${JSON.stringify((await error.first().innerText()).trim())}（字段=${await error.first().getAttribute('data-field')}）`,
      []
    )
  }
  return row
}

/**
 * 关掉设置弹层（按内容里的身份取那一个弹层，不按 `role=dialog` 的顺序取第一个）。
 *
 * 三种情况分得很清（旧实现只有 `.first()`，会把别的弹层当设置关掉、或者关不掉也不说）：
 *   · 设置弹层在 → 点它自己的「关闭」，并**等它真的从 DOM 上消失**（退出动画没走完就重开，遮罩会吃掉下一次点击）；
 *   · 一个弹层都没有 → 幂等返回（「已经不在了」不是失败）；
 *   · 开着**别的**弹层 → 报错点名那个弹层的标题（多半是上一步没关干净，或断言的落点根本不对）。
 */
export const closeSettings = async (page) => {
  const dialog = settingsDialog(page)
  if ((await dialog.count()) === 0) {
    const others = page.getByRole('dialog')
    if ((await others.count()) > 0) {
      const titles = []
      for (let index = 0; index < (await others.count()); index += 1) {
        titles.push(JSON.stringify((await others.nth(index).innerText()).slice(0, 40)))
      }
      throw stepError(
        '关掉设置弹层',
        '设置弹层（装着 settings-list / settings-page-* 的那个 dialog）',
        `设置弹层不在，但开着 ${titles.length} 个别的弹层：${titles.join('、')} —— 要关的可能根本不是设置`,
        []
      )
    }
    return
  }
  const close = dialog.getByRole('button', { name: /^关闭$|^Close$/ })
  if ((await close.count()) === 0) {
    throw stepError(
      '关掉设置弹层',
      '设置弹层里有可访问名为「关闭」的按钮（Modal 的 X）',
      '弹层在，但找不到关闭按钮：可能被另一个弹层盖住（弹层标题 = ' +
        JSON.stringify((await dialog.first().innerText()).slice(0, 40)) +
        '）',
      []
    )
  }
  await close.first().click()
  if (!(await waitUntil(async () => (await settingsDialog(page).count()) === 0))) {
    throw stepError('关掉设置弹层', '点完设置弹层从 DOM 上消失', '点了但弹层还在（退出动画 / 有确认框挡着）', [])
  }
}

/**
 * 「当前生效来源」那一行（旧口径的「渠道」触发器）—— 打勾的那一行，`settings-source-current`。
 *
 * 为什么不按文案取：旧实现读的是「渠道」下拉的触发器，2026-11-24 改版 + #807 之后这个控件
 * 已经不存在（来源页 `hideProviderKind`），`name: /^(渠道|Channel|...)$/` 从此永远 0 个 →
 * 一次红变成 30s `locator.click` 超时。新口径里「用户看得到的当前渠道」就是这一行的行头：
 * `innerText()` 形如 `DeepSeek 官方服务\n✓\n当前使用`（含渠道名），与旧断言（`/DeepSeek/`）同义。
 *
 * 一行都没打勾时（未配置 / 从没选过）返回空 locator —— 调用方按 `count()` 自己判，
 * 别在这里编一个「默认渠道」出来（那会把「渠道丢了」伪装成通过）。
 */
export const providerKindTrigger = (page) =>
  page.locator(`${SETTINGS_ACCORDION} button[aria-expanded]:has([data-testid="settings-source-current"])`)

/**
 * 「选一个来源」= 展开手风琴里对应的那一行（旧名保留，语义按新 IA 收敛）。
 *
 * ⚠ **这不是「切换生效来源」**：#794 之后没有「协议二选一」，协议按地址 / 模型自动适配；
 * #807 之后展开只是「正在查看」，真正切换要么点行底「确认使用」（{@link clickApiKeyConfirm}），
 * 要么由发送链路按地址/模型自动适配。所以本函数只做「把那一行展开，让字段区可填」，
 * 并在名字对不上任何一行时**立刻**报错（列出真实的三行），而不是点到超时。
 *
 * 旧名兼容的映射（旧用例传的是下拉里的选项名）：
 *   · `Anthropic 协议` / `OpenAI 兼容` / `第三方服务` → `third`（同一行：协议由地址/模型判）
 *   · `我们的渠道` / `内置服务` → `builtin`
 *   · `DeepSeek 官方` / `官方服务` → `official`
 *
 * @returns {Promise<string>} 展开的行
 */
export const selectProviderKind = async (page, nameRe) => {
  const wanted = String(nameRe)
  const aliases = [
    { row: 'third', re: /Anthropic 协议|Anthropic-compatible|OpenAI 兼容|OpenAI-compatible|第三方服务|third[-\s]?party/i },
    { row: 'official', re: /DeepSeek|官方服务|official/i },
    { row: 'builtin', re: /我们的渠道|Our Channel|内置服务|builtin/i },
  ]
  const hit = aliases.find((alias) => alias.re.test(wanted))
  if (!hit) {
    throw stepError(
      `按名字展开来源行（${wanted}）`,
      '能对上三行之一：第三方服务（Anthropic 协议 / OpenAI 兼容）、DeepSeek 官方服务、内置服务（我们的渠道）',
      '对不上任何一行 —— #794 / #807 之后没有「协议下拉」，三行就是全部选项',
      []
    )
  }
  await openSourceRow(page, hit.row)
  return hit.row
}

/** 在**当前展开的那一行**里填服务地址（草稿，不落盘；点「确认使用」才生效） */
export const fillBaseUrl = async (page, value) => {
  const panel = await openSourcePanel(page, '填服务地址')
  const input = panel.getByTestId('settings-source-draft-baseUrl')
  if ((await input.count()) === 0) {
    throw stepError(
      '填服务地址',
      '展开区里有 [data-testid="settings-source-draft-baseUrl"]',
      `当前展开的是「${await rowOfPanel(panel)}」那一行，它没有可编辑的服务地址` +
        '（官方服务的地址是内置的：同一展开区里是只读行 settings-source-base-url-fixed）',
      []
    )
  }
  await input.first().fill(value)
}

/** 在**当前展开的那一行**里填模型（草稿，不落盘） */
export const fillModel = async (page, value) => {
  const panel = await openSourcePanel(page, '填模型')
  const input = panel.getByTestId('settings-source-draft-model')
  if ((await input.count()) === 0) {
    throw stepError(
      '填模型',
      '展开区里有 [data-testid="settings-source-draft-model"]',
      `当前展开的是「${await rowOfPanel(panel)}」那一行，它没有可编辑的模型（官方服务的模型是内置的）`,
      []
    )
  }
  await input.first().fill(value)
}

/** 在输入框里发一条消息并点发送 */
export const sendChat = async (page, text) => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
}

/** 语音输入：点麦克风开始、再点结束，触发 ASR */
export const recordVoice = async (page) => {
  const mic = page.getByRole('button', { name: /语音输入|Voice input/ }).first()
  await mic.click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /结束录音并转写|Stop and transcribe/ }).first().click()
}
