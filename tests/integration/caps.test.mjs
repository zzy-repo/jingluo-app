// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 新用例（1.2.3）：Anthropic 协议不支持搜索 / 语音，这两个入口必须隐藏或置灰，
// 「深度思考」保留可用（该协议仍支持 thinking）。
// 附件入口自 #548 起拆成**图片**与**文档**两个，两者在 Anthropic 渠道都**可用**（见下方分档断言）：
//   - 图片入口 `attach-image`：base64 本地编码内联（#548 / #551 / #552），入口可点；
//   - 文档入口 `attach-document`：`textInjection: true`（#480），入口可点。
// 旧口径把「上传文件」列进降级清单，那是**图片入口还没开**时写的 —— 而「上传文件」这个文案
// 挂在的正是图片入口上，所以那条断言数的从来不是「文档附件」。#586 的根因即此。
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/integration/caps.test.mjs
import {
  closeSettings,
  fillApiKey,
  finish,
  openApp,
  openSettingsDataSection,
  selectProviderKind,
} from '../helpers/helpers.mjs'

const name = 'tests/integration/caps.test.mjs'
const { browser, page } = await openApp()
const failures = []

/** 入口的客观事实：在不在、有没有被标成不可用（文档入口的 unavailable / aria-disabled） */
const entryFacts = async (selector) => {
  const locator = page.locator(selector)
  const count = await locator.count()
  if (count === 0) {
    return { count, ariaDisabled: null, unavailable: null }
  }
  const first = locator.first()
  return {
    count,
    ariaDisabled: await first.getAttribute('aria-disabled'),
    unavailable: await first.getAttribute('data-attachment-entry'),
  }
}

/** 按钮不可见，或可见但置灰（aria-disabled），都算降级成功 */
const expectDegraded = async (label, nameRe) => {
  const button = page.getByRole('button', { name: nameRe })
  if ((await button.count()) === 0) {
    console.log(`ok: ${label} 入口已隐藏`)
    return
  }
  const first = button.first()
  if (!(await first.isVisible())) {
    console.log(`ok: ${label} 入口不可见`)
    return
  }
  const disabled =
    (await first.getAttribute('aria-disabled')) === 'true' || (await first.isDisabled())
  if (disabled) {
    console.log(`ok: ${label} 入口已置灰`)
    return
  }
  failures.push(`${label} 在 Anthropic 模式下仍然可用（既没有隐藏也没有置灰）`)
}

try {
  await openSettingsDataSection(page)
  await selectProviderKind(page, /Anthropic 协议|Anthropic-compatible/)
  await fillApiKey(page, 'sk-testkey-caps')
  await closeSettings(page)

  await expectDegraded('智能搜索', /^智能搜索$|^Search$/)
  await expectDegraded('语音输入', /^语音输入$|^Voice input$/)

  // 两个附件入口分别断言（#586 根因：两者在 DOM 里没有各自的稳定标识，只能靠 aria-label 猜，
  // 而「上传文件」只挂在图片入口上）。这里用 testid 精确取，期望是**都可用**：
  // 图 片：base64 内联；文 档：文本注入。真正被能力门关掉的只有 deepseek（acceptsDocuments=false），
  // 那条守卫在 provider-channels.test.mjs / full-acceptance.test.mjs 里各有一条。
  const image = await entryFacts('[data-testid="attach-image"]')
  if (image.count === 1 && image.ariaDisabled !== 'true') {
    console.log('ok: 图片入口可用（attach-image ×1，base64 内联，#548）')
  } else {
    failures.push(
      `Anthropic 模式下图片入口应存在且可点（#548），实际 count=${image.count} aria-disabled=${image.ariaDisabled}`
    )
  }
  const document = await entryFacts('[data-testid="attach-document"]')
  if (document.count === 1 && document.unavailable === null && document.ariaDisabled !== 'true') {
    console.log('ok: 文档入口可用（attach-document ×1，textInjection，#480）')
  } else {
    failures.push(
      `Anthropic 模式下文档入口应存在且可点（#480），实际 count=${document.count} marker=${document.unavailable} aria-disabled=${document.ariaDisabled}`
    )
  }

  // 深度思考必须保留
  const thinking = page.getByRole('button', { name: /^深度思考$|^DeepThink$/ })
  if ((await thinking.count()) === 0 || !(await thinking.first().isVisible())) {
    failures.push('Anthropic 模式下「深度思考」被误删了，应该保留')
  } else if ((await thinking.first().getAttribute('aria-disabled')) === 'true') {
    failures.push('Anthropic 模式下「深度思考」被置灰了，thinking 仍应可用')
  } else {
    console.log('ok: 深度思考仍然可用')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
