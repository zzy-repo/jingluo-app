// [layer: unit | 依赖: 无（纯 Node + renderToStaticMarkup + 源码体检，零浏览器零网络） | 耗时: <1s]
//
// Issue #817 ——「我的钱包」页三处调整：
//
//   ① 余额卡**右侧**补一个付款入口，与余额卡同一行；入口只做一次换页，付款仍是既有 `BuyTab`
//      （`/api/pay-link` + `openPayLinkInApp`）—— 不许出现第二套付款逻辑；
//   ② 余额卡里那条「我的额度」入口（`account-consume-tab-quota`）删掉，并且**整页**「我的额度」
//      一起退场（`AccountSubPage` / `AccountConsumeTab` / `SUB_PAGE_TITLES` / i18n 词条 / 死链）；
//   ③ 390 / 360 两档：余额卡与入口同一行、放不下整块折行、余额数字不被挤断、**不出现横向滚动**；
//   ④ 消息流「额度用完 → 去充值」的 CTA 不再指向已删页面（改指钱包页，且落点真的生效）；
//   ⑤ 付款回来（收款页关掉）停在「我的卡密」—— 调用链一路钉到 `onClosed`。
//
// 为什么这么测：`.tsx` 在裸 Node 里 import 不了（JSX 不在类型擦除范围内），所以按仓库既有的两条规矩：
//   · 能被渲染的部分抽进 `walletHeaderView.ts`（真 zh 文案 + `renderToStaticMarkup`）→ ①②③ 按 markup 断；
//   · 页面接线（哪一句接哪个回调）读源码断言 → ①⑤ 的接线部分；
//   · 落点判定收进 `walletPayFlow.ts`（纯函数）→ ⑤ 断的是「真被调用的那个函数返回哪一页」。
//
// 断言断的都是**界面真的会渲染 / 真的会调**的那一份，不是一份平行真理。
//
//   node --test tests/unit/wallet-pay-entry-817.test.mjs
//   node tests/run-layer.mjs unit --only wallet-pay-entry-817
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'
import { pinLocale } from '../helpers/locale.mjs'

// 原生桥 + 诊断写入口替身：`settingsDialogState` / `apiConfig` 会调 `recordAction`；
// 代身里 `Capacitor.isNativePlatform()` 恒为 false —— 正好是下面 ⑤ 要断的 **Web 分支**。
installChatBridge()
// 构建期注入值（`__ENDPOINTS__` / `__API_ORIGIN__`）：`apiConfig` 顶层就要读
installEndpointsGlobals()
const dom = setupDom()

const { renderToStaticMarkup } = await import('react-dom/server')
const { translate } = await import('../../src/i18n/index.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const headerView = await import('../../src/components/consume/walletHeaderView.ts')
const payFlow = await import('../../src/components/consume/walletPayFlow.ts')
const dialogState = await import('../../src/components/settings/settingsDialogState.ts')
const transport = await import('../../src/services/ours/transport.ts')

test.after(() => {
  dom.restore()
})

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

const PAGE = 'src/components/consume/AccountConsumePage.tsx'
const DIALOG = 'src/components/settings/SettingsDialog.tsx'
const ASSISTANT = 'src/components/messages/AssistantMessage.tsx'
const CSS = 'src/components/consume/AccountConsume.module.css'

/** 仓库内源码（`.tsx` 裸 Node import 不了，接线只能读源码断言） */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')
/** 去掉注释的源码：`'quota'` 这类字符串只许出现在说明里，不许出现在代码里 */
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** CSS Module 类名表替身：取什么给什么（断言不依赖哈希后的类名，只为让真视图能渲染） */
const classNames = new Proxy({}, { get: (_t, name) => String(name) })

const markupOf = (element) => renderToStaticMarkup(element)
const hasTestId = (markup, testId) => markup.includes(`data-testid="${testId}"`)

/** 在 React 元素树里按 `data-testid` 找节点（要拿它真实的 `onClick`，而不是在 markup 里猜） */
const findByTestId = (element, testId) => {
  if (element === null || typeof element !== 'object') {
    return null
  }
  const props = element.props ?? {}
  if (props['data-testid'] === testId) {
    return element
  }
  const children = props.children
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  for (const child of list) {
    const hit = findByTestId(child, testId)
    if (hit !== null) {
      return hit
    }
  }
  return null
}

/** 钱包页首那一行（默认：已登录、余额 ¥128.50、点付款记一笔） */
const headerProps = (over = {}) => ({
  t: translate,
  styles: classNames,
  signedIn: true,
  balance: 128.5,
  onPay: () => {},
  ...over,
})
const renderHeader = (over = {}) => markupOf(headerView.WalletHeaderView(headerProps(over)))

/** 取一条 CSS 规则（`selector { ... }`）的声明块；找不到就红 —— 别让断言在「规则被删了」时静默通过 */
const cssBlock = (css, selector) => {
  const at = css.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `CSS 里找不到 ${selector} 规则（这条规则是 #817 版式契约的一部分）`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

// ─────────────────────────────────────────── ① 付款入口（复用 BuyTab，不另写付款逻辑） ──

test('① 钱包页顶部有付款入口，与余额卡同一行；点它进「购买」子页（那里挂的就是既有 BuyTab）', () => {
  const markup = renderHeader()
  assert.equal(hasTestId(markup, 'account-consume-wallet-head'), true, '页首那一行要有自己的容器')
  assert.equal(hasTestId(markup, 'account-consume-balance'), true, '余额卡 testid 是既有契约，必须保留')
  assert.equal(hasTestId(markup, 'account-consume-wallet-pay'), true, '付款入口必须在')
  assert.match(markup, /去支付/u, '入口文案走既有词条（oursBuyAction），不新造一句')

  // 同一行：两个节点在同一个 flex 行容器里，且余额卡在前、入口在后
  const head = headerView.WalletHeaderView(headerProps())
  const order = head.props.children.map((child) => child.props['data-testid'])
  assert.deepEqual(order, ['account-consume-balance', 'account-consume-wallet-pay'], '余额卡与入口是同一行的两格（卡在前）')

  // 点一下真的会调 onPay（不是只渲染了个按钮）
  let clicks = 0
  const pay = findByTestId(headerView.WalletHeaderView(headerProps({ onPay: () => {
    clicks += 1
  } })), 'account-consume-wallet-pay')
  assert.equal(pay.props.type, 'button', '付款入口是按钮（键盘可达）')
  pay.props.onClick()
  assert.equal(clicks, 1, '点付款入口触发一次 onPay')

  // 接线：页面把 onPay 指到「购买」子页，而那一页挂的就是既有 BuyTab
  const page = codeOf(PAGE)
  assert.match(page, /onPay=\{\(\) => onNavigate\(WALLET_PAY_ENTRY_PAGE\)\}/u, '页面的付款入口只吐一个换页动作')
  assert.equal(payFlow.WALLET_PAY_ENTRY_PAGE, 'buy', '付款入口的目标页是「购买」子页')
  assert.match(page, /if \(page === 'buy'\)[\s\S]*?<BuyTab onPurchased=\{backToCards\} \/>/u, '「购买」子页挂的是既有 BuyTab')

  // 不新增第二套付款逻辑：页面自己一个付款接口都不打、一个收款页都不开
  for (const forbidden of ['fetchPayLink(', 'openPayLinkInApp(', 'window.open(', '/api/pay-link']) {
    assert.equal(page.includes(forbidden), false, `页面里不该出现 ${forbidden}（付款只有 BuyTab 那一份）`)
  }
})

// ───────────────────────────────── ② 「我的额度」入口与整页一起退场（含死链与词条） ──────

test('② 余额卡里不再有「我的额度」入口；那一页也整页退场（类型 / 标题 / 词条 / 死链）', () => {
  const markup = renderHeader()
  assert.equal(hasTestId(markup, 'account-consume-tab-quota'), false, '余额卡里不该再有额度入口')
  assert.equal(markup.includes('我的额度'), false, '整行文案也从这一屏消失')

  const page = codeOf(PAGE)
  assert.equal(page.includes('account-consume-tab-quota'), false, '页面里没有那个 testid')
  assert.equal(/['"]quota['"]/u.test(page), false, "`'quota'` 不许再出现在页面的代码里（子页已删）")
  assert.equal(page.includes('<QuotaPanel'), false, '「我的额度」子页的挂载点已删')
  assert.equal(/export type AccountSubPage =[^\n]*quota/u.test(page), false, "`AccountSubPage` 里不再有 `'quota'`")
  // 每个值仍然有自己的二级页标题（Record 是全的，tsc 会兜住，这里再钉一次口径）
  assert.match(page, /history: 'accountConsumeHistory'/u, '历史消费仍是可达的二级页')

  const dialog = codeOf('src/components/settings/settingsDialogState.ts')
  assert.equal(/export type AccountConsumeTab =[^\n]*quota/u.test(dialog), false, "`AccountConsumeTab` 里不再有 `'quota'`")

  // 词条：删干净（`check:i18n` R4 也会查孤立 key，这里是同一口径的前置断言）
  assert.equal('accountConsumeTabQuota' in zh, false, 'zh 里的 accountConsumeTabQuota 已删')
  assert.equal('accountConsumeTabQuota' in en, false, 'en 里的 accountConsumeTabQuota 已删')

  // 死链：全仓库不该还有人往那一页跳
  for (const file of [ASSISTANT, PAGE, DIALOG]) {
    assert.equal(/openAccountConsume\('quota'\)|onNavigate\('quota'\)/u.test(codeOf(file)), false, `${file} 里没有指向已删页面的跳转`)
  }

  // 连带清理：只服务那个入口的样式一起删（不留死 CSS）
  assert.equal(sourceOf(CSS).includes('balanceMore'), false, '`.balanceMore`（额度入口）的样式已删')
})

// ──────────────────────────────────────── ③ 390 / 360：同一行、折行、数字不被挤断 ──────

test('③ 窄屏：卡与入口同一行、放不下整块折行、余额数字完整、不出现横向滚动', () => {
  const css = sourceOf(CSS)

  const head = cssBlock(css, '.walletHead')
  assert.match(head, /display:\s*flex/u, '页首那一行是 flex 行')
  assert.match(head, /flex-wrap:\s*wrap/u, '放不下就折行（绝不横向滚动）')
  assert.equal(/overflow-x/u.test(head), false, '这一行不许声明 overflow-x（没有横向滚动这回事）')

  const card = cssBlock(css, '.walletHead .balance')
  assert.match(card, /flex:\s*1 1 auto/u, '卡吃掉剩余宽度（入口才贴得到右边）')
  assert.match(card, /min-width:\s*min-content/u, '卡可以被压，但不会被压到比余额数字还窄（数字不被挤断）')

  const pay = cssBlock(css, '.walletPay')
  assert.match(pay, /flex:\s*0 0 auto/u, '入口不参与压缩（不然窄屏先挤它）')
  assert.match(pay, /margin-left:\s*auto/u, '折到第二行时仍然贴右')
  assert.match(pay, /white-space:\s*nowrap/u, '入口文案不折成两行')

  const value = cssBlock(css, '.balanceValue')
  assert.equal(/overflow:\s*hidden/u.test(value), false, '余额数字不能被裁掉')
  assert.equal(/text-overflow/u.test(value), false, '余额数字不能打省略号')
  assert.equal(/white-space:\s*nowrap/u.test(value), false, '余额数字不靠 nowrap 硬撑（撑出去就是横向溢出）')

  // markup 侧：数字是**完整**的一串（未截断 / 未分段），两种登录态都说人话
  const markup = renderHeader()
  assert.match(markup, />¥128\.50</u, '余额完整上屏（¥128.50，不被截断）')
  assert.equal(renderHeader({ signedIn: null }).includes('>…<'), true, '恢复中给 `…`（不显示来路不明的 0.00）')
  assert.equal(renderHeader({ balance: undefined }).includes('>—<'), true, '还没读到余额给 `—`')

  /**
   * 真浏览器里量过的那两档（`docs/ui/817-wallet-pay-entry/{390,360}/metrics.json`）：
   * 把量出来的数字也钉进用例 —— 「不横向滚动」「数字完整」不是靠读 CSS 推理出来的。
   * 文件不存在就跳过这一半（例如只跑单测、还没跑过测量脚本），但存在就必须自洽。
   */
  for (const viewport of [390, 360]) {
    const file = path.join(ROOT, `docs/ui/817-wallet-pay-entry/${viewport}/metrics.json`)
    let metrics
    try {
      metrics = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    assert.equal(metrics.viewport, viewport, `${viewport} 档 metrics 记的是自己的视口`)
    assert.equal(metrics.head.scrollWidth, metrics.head.clientWidth, `${viewport}：页首那一行没有横向溢出`)
    assert.equal(metrics.head.rowCount, 1, `${viewport}：余额卡与付款入口在同一行`)
    assert.equal(metrics.balance.clipped, false, `${viewport}：余额数字没有被裁`)
    assert.equal(metrics.balance.text, '¥128.50', `${viewport}：余额数字完整上屏`)
  }
})

// ─────────────────────────────── ④ 额度用完的提示改指钱包页（并且落点真的生效） ─────────

test('④ AssistantMessage 的「去充值」不再指向已删页面：改指钱包页且真能落上去', () => {
  const assistant = codeOf(ASSISTANT)
  assert.match(assistant, /openAccountConsume\('wallet'\)/u, '额度用完的 CTA 落在钱包页')
  assert.equal(assistant.includes("openAccountConsume('quota')"), false, '不再指向已删的「我的额度」')

  // 落点真的生效：store 里记的是哪一页……
  dialogState.useSettingsDialog.setState({ open: false, section: 'general', accountConsumeTab: null })
  dialogState.openAccountConsume('wallet')
  const now = dialogState.useSettingsDialog.getState()
  assert.equal(now.open, true, '打开设置')
  assert.equal(now.section, 'account', '切到第三个 tab「账户与消费」')
  assert.equal(now.accountConsumeTab, 'wallet', '落点是钱包页（不是已删的额度页）')

  // ……设置弹层真的拿它当账户与消费的初值（#817 修的「字段没人读」）……
  assert.match(
    codeOf(DIALOG),
    /useState<AccountSubPage \| null>\(\s*\(\) => useSettingsDialog\.getState\(\)\.accountConsumeTab\s*\)/u,
    'SettingsDialog 用 store 里的落点初始化 accountPage'
  )
  // ……而钱包页确实有内容（页首那一行就是余额卡 + 付款入口）
  assert.match(
    codeOf(PAGE),
    /if \(page === 'wallet'\)[\s\S]*?\{walletHeader\}/u,
    '钱包页首渲染的正是余额卡 + 付款入口那一行'
  )
})

// ───────────────────────────────────────── ⑤ 付款回来停在「我的卡密」 ─────────────────

test('⑤ 收款页关掉 → 停在「我的卡密」：onClosed → onPurchased → backToCards → cards', () => {
  assert.equal(payFlow.WALLET_PAY_RETURN_PAGE, 'cards', '落点是我的卡密')
  const visited = []
  payFlow.landAfterPayReturn((page) => visited.push(page))
  assert.deepEqual(visited, ['cards'], 'landAfterPayReturn 真的把用户送到卡密页')

  const page = codeOf(PAGE)
  assert.match(page, /landAfterPayReturn\(onNavigate\)/u, 'backToCards 用同一个落点（不另写一份）')
  assert.match(page, /<BuyTab onPurchased=\{backToCards\} \/>/u, 'BuyTab 的关页回调接的是 backToCards')

  const buyTab = codeOf('src/components/consume/BuyTab.tsx')
  assert.match(buyTab, /openPayLinkInApp\(link\.url, \(\) => \{/u, 'BuyTab 把关页回调交给 openPayLinkInApp')
  assert.match(buyTab, /onPurchased\?\.\(\)/u, '关页回调里调 onPurchased —— 这条链不能断')

  // Web 分支：真跑一次（替身里 isNativePlatform() 恒为 false）。打不开就**不触发** onClosed，
  // 界面停在购买页给可读提示 —— 不会「假装付款回来了」跳去卡密。
  assert.equal(transport.isNativePlatform(), false, '单测环境 = Web 分支')
  let closed = 0
  return transport.openPayLinkInApp('https://pay.example.com/checkout', () => {
    closed += 1
  }).then((opened) => {
    assert.equal(opened, false, 'Web / 没有内嵌浏览器：openPayLinkInApp 返回 false')
    assert.equal(closed, 0, '返回 false 时 onClosed 一次都不调（不会假回跳）')
    assert.match(buyTab, /messageKey: 'oursPayOpenFailed'/u, '打不开时给可读提示（停在购买页，不跳页）')
  })
})
