// [layer: integration | 依赖: playwright + chromium + 本地静态服务（dist-standard） | 耗时: ~1 分钟]
//
// Issue #813：**官方渠道（`kind === 'deepseek'`）的输入框右侧工具栏只留最右边的文件上传**。
//
// 票面口径（markup 级即可，视觉 / 真机不在本用例里）：
//   [1] `kind=deepseek` → DOM 里**不存在**语音入口（`VoiceButton`，`aria-label=语音输入`）、
//       **不存在**文档入口 `[data-testid="attach-document"]`（含 `data-attachment-entry="unavailable"`
//       那一支「不可用」占位）；回形针 `[data-testid="attach-image"]` 仍在且可用；发送仍在。
//   [2] 回归：`ours` / `openai` / `anthropic` 与现状一致 —— 文档入口在且可点（#480 文本注入），
//       语音入口本来就不渲染（三渠道 `caps.asr === false`），图片入口在且可用（#548 / #552）。
//       这一条守的是「别把精简做成一刀切」。
//   [3] 草稿里挂着别的渠道留下的文档：**不能卡成死局** —— 点发送要给出可读提示（文案逐字比对
//       `zh.ts` 的 `attachDraftChannelUnsupported`），提示条上还有**真能点**的「移除附件」动作；
//       点完文档卡片与草稿引用一起清空（用户看得出怎么把文档拿掉）。
//
//   node tests/integration/compact-toolbar-813.test.mjs
//
// 产物按 main 的约定**不隐式构建**（缺 dist-standard 就 SKIP(env) 并打印构建命令）：
//   NODE_ENV=production DIST_OUT=dist-standard npx rspack build -c rspack.config.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
import { installTsResolve } from '../helpers/dom-env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
import { consumeApiV1Prefix, consumeBaseUrl } from '../../scripts/lib/endpoints.mjs'

// 文案断言拿**真** zh 文案表（源码里写的是 `.js` 说明符，裸 Node 解析不到 `.ts`，先装解析 hook）
installTsResolve()
const { zh } = await import('../../src/i18n/zh.ts')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT
const APP_URL = process.env.APP_URL || ''

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => console.log(`  ·   ${message}`)

/**
 * 输入区右侧工具栏的客观事实。
 *
 * 附件入口一律按**产品侧给出的稳定 testid** 取，不按 `aria-label` 里的中文猜（#586）：
 * 图片入口的可访问名就是「上传文件」，按文案数会把图片和文档搅成一件东西；而按文案前缀数
 * 「能用的那个 picker」又数不出「不可用」占位在不在（那正是 #538 能力门的守卫）。
 */
const toolbar = (page) =>
  page.evaluate(() => {
    const all = (selector) => document.querySelectorAll(selector)
    const visible = (node) =>
      getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'
    return {
      image: all('[data-testid="attach-image"]').length,
      imageReady: all('[data-testid="attach-image"]:not([aria-disabled="true"])').length,
      document: all('[data-testid="attach-document"]').length,
      documentReady: all(
        '[data-testid="attach-document"]:not([data-attachment-entry="unavailable"])'
      ).length,
      unavailable: all('[data-attachment-entry="unavailable"]').length,
      voice: all('button[aria-label="语音输入"],button[aria-label="Voice input"]').length,
      send: all('button[aria-label="发送"],button[aria-label="Send"]').length,
      docCards: [...all('button[aria-label="移除附件"],button[aria-label="Remove attachment"]')]
        .filter(visible).length,
    }
  })

/** 种一份 localStorage 再刷新（渠道与 Key 都走既有的 storage 键，不额外造接口） */
const seed = async (page, kind) => {
  await page.evaluate((nextKind) => {
    window.localStorage.clear()
    // 种一把 Key：避免空态自动弹「设置」挡住输入区（与本用例无关）
    window.localStorage.setItem('chat-demo:api-key', 'sk-compact-toolbar-813')
    if (nextKind !== 'deepseek' && nextKind !== null) {
      // 文本注入渠道要自填地址 / 模型；这里只为了让「挂文档」这一步有个能用的渠道
      window.localStorage.setItem(`chat-demo:base-url:${nextKind}`, 'https://relay.example.com')
      window.localStorage.setItem(`chat-demo:model:${nextKind}`, 'relay-model')
    }
    if (nextKind !== null) {
      window.localStorage.setItem('chat-demo:provider-kind', nextKind)
    }
  }, kind)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('textarea').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
}

/** 设置弹层 →「账户与消费 → 模型来源」（#807 起的入口位置；渠道选择住在这里） */
const openModelSource = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    const entry = page.getByRole('button', { name: /^设置$|^Settings$/ })
    if ((await entry.count()) === 0) {
      // 窄屏（402）下设置入口在边栏里
      await page.getByRole('button', { name: /打开边栏|Open sidebar/ }).first().click()
      await page.waitForTimeout(400)
    }
    await entry.last().click()
    await page.waitForTimeout(600)
  }
  await page.getByRole('tab', { name: /账户与消费|Account/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('tab', { name: /模型来源|Model source/ }).first().click()
  await page.waitForTimeout(600)
  return page.getByRole('dialog').first()
}

/** 「模型来源」里把生效渠道切回 DeepSeek 官方（行即动作 → 确认使用 → 关闭） */
const switchToOfficial = async (page) => {
  const dialog = await openModelSource(page)
  await dialog.locator('[data-testid="settings-source-official"]').first().click()
  await page.waitForTimeout(400)
  await dialog.locator('[data-testid="settings-source-official-confirm"]').first().click()
  await page.waitForTimeout(500)
  await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await page.waitForTimeout(600)
  // 窄屏下设置入口在抽屉里：关掉弹层后抽屉的遮罩还盖着输入区（会拦住后续点击）
  const collapse = page.getByRole('button', { name: /收起边栏|Close sidebar/ })
  if ((await collapse.count()) > 0) {
    await collapse.first().click()
    await page.waitForTimeout(500)
  }
}

const served =
  APP_URL === '' ? await serveDir(DIST, { port: PORT, label: '标准产物 dist-standard' }) : null
const appUrl = APP_URL === '' ? served.url : APP_URL
await verifyAppUrl(appUrl, DIST, { variant: 'standard' })

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 402, height: 874 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

/**
 * #686：出站总闸必须在 `page.goto` **之前**装上。
 *
 * 应用启动会自己去拉一次服务端开关（`settings/public`，`main.tsx` 的身份层接线），与 #813 无关；
 * 这里把它登记成**桩**（白名单内的精确 host + path），既不漏网也不产生 `ERR_FAILED` 的
 * console error —— 本用例真正要的是「精简工具栏没有新增任何出站请求」。
 */
await installEgressGate(page, {
  appUrl,
  stubs: [
    {
      name: 'settings-public',
      host: new URL(consumeBaseUrl).host,
      // 注意：`consumeBaseUrl` 自带路径前缀（/staging），所以 pathname 是「前缀 + /api/v1 + /settings/public」
      path: `${new URL(consumeBaseUrl).pathname}${consumeApiV1Prefix}/settings/public`,
      respond: () => ({ status: 200, body: '{}' }),
    },
  ],
})
await page.goto(appUrl, { waitUntil: 'domcontentloaded' })

try {
  // ============ [1] 官方渠道：只剩最右边的文件上传 ============
  console.log('\n[1] kind=deepseek：语音与文档入口彻底不渲染')
  await seed(page, 'deepseek')
  const deepseek = await toolbar(page)
  note(`deepseek 工具栏：${JSON.stringify(deepseek)}`)
  if (deepseek.voice !== 0) {
    bad(`[1] 官方渠道仍然渲染了语音入口（期望 DOM 里没有节点，实际 ${deepseek.voice} 个）`)
  } else {
    ok('[1] 语音输入入口不存在（DOM 里没有节点）')
  }
  if (deepseek.document !== 0) {
    bad(`[1] 官方渠道仍然渲染了文档入口（attach-document，实际 ${deepseek.document} 个）`)
  } else {
    ok('[1] 文档入口 attach-document 不存在（DOM 里没有节点）')
  }
  if (deepseek.unavailable !== 0) {
    bad(
      `[1] 仍然渲染了「不可用」占位（data-attachment-entry="unavailable"，实际 ${deepseek.unavailable} 个）`
    )
  } else {
    ok('[1] 「不可用」占位也不渲染（不是渲成禁用态，是彻底不出现）')
  }
  if (deepseek.image !== 1 || deepseek.imageReady !== 1) {
    bad(
      `[1] 回形针（attach-image）应仍在且可用：总数 ${deepseek.image} / 可点 ${deepseek.imageReady}`
    )
  } else {
    ok('[1] 最右边的文件上传（attach-image）仍在且可用')
  }
  if (deepseek.send !== 1) {
    bad(`[1] 发送按钮应仍在：实际 ${deepseek.send} 个`)
  } else {
    ok('[1] 发送按钮仍在')
  }

  // ============ [1b] 拖入文档：入口没了，提示仍要可读（不静默吞掉） ============
  console.log('\n[1b] 官方渠道拖入 PDF：可读提示仍在')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['%PDF-1.4 issue-813'], 'drop-813.pdf', { type: 'application/pdf' }))
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }))
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })
  await page.waitForTimeout(600)
  const dropToast = (await page.locator('[role="status"]').allInnerTexts()).join(' | ')
  const dropped = await toolbar(page)
  if (!dropToast.includes(zh.attachChannelUnsupported)) {
    bad(
      `[1b] 拖入 PDF 没有给出可读提示（期望 zh.attachChannelUnsupported，实际 toast=${JSON.stringify(dropToast)}）`
    )
  } else {
    ok('[1b] 拖入 PDF 给出可读提示（attachChannelUnsupported，与精简前同一句原因）')
  }
  if (dropped.docCards !== 0) {
    bad(`[1b] 拖入的 PDF 居然挂上卡片了（${dropped.docCards} 张，官方渠道不该收文档）`)
  } else {
    ok('[1b] 拖入的 PDF 没有被加进草稿（不静默收下，也不静默吞掉）')
  }

  // ============ [2] 其它渠道回归 ============
  console.log('\n[2] 回归：ours / openai / anthropic 与现状一致')
  for (const kind of ['ours', 'openai', 'anthropic']) {
    await seed(page, kind)
    const nodes = await toolbar(page)
    note(`${kind} 工具栏：${JSON.stringify(nodes)}`)
    if (nodes.image !== 1 || nodes.imageReady !== 1) {
      bad(`[2] ${kind} 图片入口应仍在且可用：总数 ${nodes.image} / 可点 ${nodes.imageReady}`)
    } else {
      ok(`[2] ${kind} 图片入口在且可用（#548 / #552 未受影响）`)
    }
    if (nodes.document !== 1 || nodes.documentReady !== 1) {
      bad(`[2] ${kind} 文档入口应仍在且可点：总数 ${nodes.document} / 可点 ${nodes.documentReady}`)
    } else {
      ok(`[2] ${kind} 文档入口在且可点（#480 文本注入未受影响）`)
    }
    if (nodes.unavailable !== 0) {
      bad(`[2] ${kind} 文档入口被标成「不可用」（acceptsDocuments 应仍为 true）`)
    }
    if (nodes.voice !== 0) {
      bad(`[2] ${kind} 渲染了语音入口（该渠道 caps.asr=false，本来就不该有）`)
    }
    if (nodes.send !== 1) {
      bad(`[2] ${kind} 发送按钮缺了`)
    }
  }

  // ============ [3] 草稿里有文档 → 可读提示 + 可点的移除动作 ============
  console.log('\n[3] 官方渠道里草稿有文档 → 可读提示 + 可点的移除动作')
  // 先在**支持文档**的渠道挂文档（文本注入渠道的附件入口是真的 picker）
  await seed(page, 'anthropic')
  const anthropic = await toolbar(page)
  if (anthropic.documentReady !== 1) {
    bad(`[3] 前置失败：Anthropic 渠道没有可用的文档入口（${JSON.stringify(anthropic)}）`)
  }
  await page.locator('input[type="file"][accept*=".txt"]').first().setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('issue 813 compact toolbar draft document\n', 'utf8'),
  })
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const text = await page.locator('body').innerText()
    if (text.includes(zh.attachStatusSuccess) || text.includes('Ready')) {
      ready = true
      break
    }
    await page.waitForTimeout(250)
  }
  if (!ready) {
    bad('[3] 前置失败：txt 文档没有进入「已就绪」（草稿里没有可发送的文档引用）')
  }
  const withDraftDoc = await toolbar(page)
  note(`挂好文档后（Anthropic）：${JSON.stringify(withDraftDoc)}`)
  if (withDraftDoc.docCards !== 1) {
    bad(`[3] 前置失败：输入区应有一张文档卡片（移除按钮 ${withDraftDoc.docCards} 个）`)
  }

  // 切回官方渠道：工具栏精简，但**卡片还在**（草稿是会话级的，不随渠道清空）
  await switchToOfficial(page)
  const backToOfficial = await toolbar(page)
  note(`切回官方渠道后：${JSON.stringify(backToOfficial)}`)
  if (backToOfficial.document !== 0 || backToOfficial.voice !== 0) {
    bad(`[3] 切回官方渠道后工具栏没有精简：${JSON.stringify(backToOfficial)}`)
  } else {
    ok('[3] 切回官方渠道后工具栏精简（文档入口 / 语音入口都不在）')
  }
  if (backToOfficial.docCards !== 1) {
    bad('[3] 文档卡片被一起藏掉了（用户就更没法移除它了）')
  } else {
    ok('[3] 文档卡片仍在输入区，卡片自带「移除附件」按钮')
  }

  // 点发送：必须给一句人话 + 一个真能点的动作，而不是静默失败
  const sendButton = page.getByRole('button', { name: /^发送$|^Send$/ }).first()
  const sendDisabledWithDocs = await sendButton.getAttribute('aria-disabled')
  note(`草稿里有文档时发送按钮 aria-disabled=${sendDisabledWithDocs}（草稿非空 → 可点）`)
  await sendButton.click()
  await page.waitForTimeout(500)
  const expected = zh.attachDraftChannelUnsupported.replace('{count}', '1')
  const toastText = await page.locator('[role="status"]').allInnerTexts()
  const hit = toastText.find((text) => text.includes(expected))
  if (hit === undefined) {
    bad(`[3] 发送被拦下时没有给出可读提示（toast=${JSON.stringify(toastText)}）`)
  } else {
    ok(`[3] 提示文案逐字来自 zh.attachDraftChannelUnsupported（count=1）`)
  }
  const action = page.locator('[data-testid="toast-action"]')
  if ((await action.count()) !== 1) {
    bad(`[3] 提示条上没有可操作的「移除附件」动作（toast-action=${await action.count()}）`)
  } else if ((await action.first().innerText()).trim() !== zh.attachRemove) {
    bad(`[3] 动作按钮文案不是「${zh.attachRemove}」：${await action.first().innerText()}`)
  } else {
    ok(`[3] 提示条上有可点的动作「${zh.attachRemove}」`)
    // 点下去：卡片与草稿引用一起清空（用户从提示里走得出死局）
    await action.first().click()
    await page.waitForTimeout(800)
    const afterRemove = await toolbar(page)
    note(`点「移除附件」后：${JSON.stringify(afterRemove)}`)
    if (afterRemove.docCards !== 0) {
      bad(`[3] 点了「移除附件」文档卡片还在（剩 ${afterRemove.docCards} 张）`)
    } else {
      ok('[3] 点了「移除附件」卡片消失（草稿引用一并清掉）')
    }
    /**
     * 草稿里确实空了（不只是卡片被藏起来）：`canSend` 要求草稿非空，
     * 移除前「空文本 + 有文档」是可点的，移除后就成了 aria-disabled。
     * 这条断言不点按钮、不发请求，纯看草稿状态 —— 也就不会把 egress 闸弄红。
     */
    const sendDisabledAfterRemove = await sendButton.getAttribute('aria-disabled')
    note(`移除之后发送按钮 aria-disabled=${sendDisabledAfterRemove}（草稿已空 → 不可点）`)
    if (sendDisabledWithDocs === 'false' && sendDisabledAfterRemove === 'true') {
      ok('[3] 移除之后草稿里不再有文档引用（发送按钮回到空草稿的不可点态）')
    } else {
      bad(
        `[3] 移除前后的草稿状态不对：移除前 aria-disabled=${sendDisabledWithDocs}、移除后=${sendDisabledAfterRemove}`
      )
    }
  }

  // ============ [4] 控制台干净 ============
  if (consoleErrors.length === 0) {
    ok('[4] console error = 0')
  } else {
    bad(`[4] console error = 0（实际：${consoleErrors.join(' | ')}）`)
  }
  assertNoEgress(failures)
} catch (error) {
  bad(`用例执行异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await browser.close()
  served?.kill()
}

if (failures.length === 0) {
  console.log('\n#813 精简工具栏通过 ✅')
  process.exit(0)
}
console.error(`\n#813 精简工具栏 ${failures.length} 条断言失败 ❌`)
process.exit(1)
