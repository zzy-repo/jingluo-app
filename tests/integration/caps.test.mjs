// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 新用例（1.2.3）：Anthropic 协议不支持搜索 / 语音，这两个入口必须隐藏或置灰，
// 「深度思考」保留可用（该协议仍支持 thinking）。
//
// ⚠ 随 #552 变更：三渠道支持图片。撤回的是「附件」里**图片那一半**的旧期望 ——
//   - **图片入口**（纸夹「上传文件」）现在必须**存在且可用**：三家没有 `paths.files`，
//     图片走 `providerCapability.ts` 的 `image.base64` 本地编码内联，完全不碰端点。
//     旧断言「上传文件 在 Anthropic 模式下必须隐藏或置灰」是 #552 之前的现实。
//   - **文档入口**（TXT / DOCX / PDF）**这条没变**：Anthropic 走 #480 的
//     `documents.textInjection`，入口一直是那个可用的 picker（可访问名「添加文档（TXT / DOCX / PDF）」）。
//     所以这里单独钉一条：文档能力不许跟着图片入口一起被放宽或被误删。
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

  // 随 #552 变更：三渠道支持图片 —— 图片入口（纸夹「上传文件」）必须**在且可用**。
  // 它走 `image.base64` 本地编码内联，不依赖 `paths.files`（这条渠道没有），所以不再降级。
  {
    const upload = page.getByRole('button', { name: /^上传文件$|^Upload files$/ })
    if ((await upload.count()) === 0) {
      failures.push('Anthropic 模式下「上传文件」（图片入口）被误删了：#552 起三渠道支持图片')
    } else if (
      !(await upload.first().isVisible()) ||
      (await upload.first().getAttribute('aria-disabled')) === 'true' ||
      (await upload.first().isDisabled())
    ) {
      failures.push('Anthropic 模式下「上传文件」（图片入口）仍是降级态：#552 起走 base64 内联，应可用')
    } else {
      console.log('ok: 图片入口「上传文件」可用（随 #552：三渠道支持图片）')
    }
  }

  // 文档入口 **不在这次变更范围内**：Anthropic 仍是 `documents.textInjection`，
  // 那个 picker 必须还在（这条断言守的是别把「文档入口」和「图片入口」混成一件事）。
  {
    const docs = page.getByRole('button', { name: /^添加文档|^Add document/ })
    if ((await docs.count()) === 0) {
      failures.push('Anthropic 模式下「文档附件」入口消失了：#480 的文本注入仍然成立，不该删')
    } else {
      console.log('ok: 文档入口仍在（#480 文本注入，未被 #552 影响）')
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
