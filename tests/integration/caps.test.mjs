// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 新用例（1.2.3）：Anthropic 协议不支持搜索 / 语音，这两个入口必须隐藏或置灰，
// 「深度思考」保留可用（该协议仍支持 thinking）。
//
// ⚠ 随 #552 变更：三渠道支持图片。撤回的是「附件」里**图片那一半**的旧期望 ——
//   - **图片入口**（`data-testid="attach-image"`）现在必须**存在且可用**：三家没有 `paths.files`，
//     图片走 `providerCapability.ts` 的 `image.base64` 本地编码内联，完全不碰端点。
//     旧断言「上传文件 在 Anthropic 模式下必须隐藏或置灰」是 #552 之前的现实。
//   - **文档入口**（`data-testid="attach-document"`，TXT / DOCX / PDF）**这条没变**：Anthropic 走 #480 的
//     `documents.textInjection`，入口一律可用。所以这里单独钉一条：文档能力不许跟着图片入口一起被放宽。
//
// 两个入口都按**产品侧给出的 testid** 取，不按 `aria-label` 的中文猜（#586 / #596）：
// 图片入口的可访问名就是「上传文件」，按文案数节点会把「图片」和「文档」搅成一件东西；
// 而按文案前缀数「能用的那个 picker」又数不出禁用态占位在不在 —— 那正是 #538 能力门的守卫。
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

  // 随 #552 变更：三渠道支持图片 —— 图片入口必须**在且可用**（走 `image.base64` 本地编码内联，
  // 不依赖 `paths.files`）。按 testid 取，不按「上传文件」这个文案取。
  {
    const image = await entryFacts('[data-testid="attach-image"]')
    if (image.count !== 1) {
      failures.push(`Anthropic 模式下图片入口（attach-image）应恰好 1 个，实际 ${image.count} 个`)
    } else if (image.ariaDisabled === 'true') {
      failures.push('Anthropic 模式下图片入口仍是降级态（aria-disabled=true）：#552 起走 base64 内联，应可用')
    } else {
      console.log('ok: 图片入口可用（attach-image ×1，base64 内联，#548 / #552）')
    }
  }

  // 文档入口 **不在这次变更范围内**：Anthropic 仍是 `documents.textInjection`，
  // 那个 picker 必须**在、且可点**（这条断言守的是别把「文档入口」和「图片入口」混成一件事）。
  {
    const document = await entryFacts('[data-testid="attach-document"]')
    if (document.count !== 1) {
      failures.push(`Anthropic 模式下文档入口（attach-document）应恰好 1 个，实际 ${document.count} 个`)
    } else if (document.unavailable !== null || document.ariaDisabled === 'true') {
      failures.push(
        `Anthropic 模式下文档入口被误标为不可用（marker=${document.unavailable} aria-disabled=${document.ariaDisabled}）：#480 文本注入仍然成立`
      )
    } else {
      console.log('ok: 文档入口在且可点（attach-document ×1，#480 文本注入）')
    }
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
