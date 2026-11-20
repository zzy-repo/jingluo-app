// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 兼容用例（1.2.3）：升级前的老用户只有 chat-demo:api-key / base-url / model，没有 provider-kind。
// 升级后必须：按 deepseek 处理、路径不变、并且继续用他们已存的服务地址与模型（无感兼容）。
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/integration/legacy-config.test.mjs
import {
  capturePaths,
  closeSettings,
  finish,
  openApp,
  openSettingsDataSection,
  providerKindTrigger,
  sendChat,
  stubMessagesStream,
  stubModels,
} from '../helpers/helpers.mjs'

const name = 'tests/integration/legacy-config.test.mjs'
const LEGACY_BASE = 'https://legacy-relay.example.com'
const LEGACY_MODEL = 'legacy-model'
const { browser, page } = await openApp()
const failures = []
const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}
try {
  await stubModels(page)
  await stubMessagesStream(page)

  // 造一份 1.2.2 的本地存储：有 key、地址、模型，没有 kind
  await page.evaluate(
    ({ base, model }) => {
      window.localStorage.setItem('chat-demo:api-key', 'sk-legacy-key')
      window.localStorage.setItem('chat-demo:base-url', base)
      window.localStorage.setItem('chat-demo:model', model)
    },
    { base: LEGACY_BASE, model: LEGACY_MODEL }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  const requests = capturePaths(page)

  await openSettingsDataSection(page)
  // 渠道行怎么读（#555）：用共享的 `providerKindTrigger`（整串锚定）而不是
  // `/渠道|Channel|服务类型|Service type/` 子串 + `.first()`。
  // 后者在 #480/#538 之后会命中聊天页那个**禁用态文档入口**图标按钮（aria-label
  // 「当前渠道不支持文档附件…」含「渠道」、DOM 顺序在设置弹窗之前、且没有可见文本），
  // 于是读出来是空串 —— 看起来像「老用户默认渠道丢了」的产品回归，实际是取数方式过时。
  const kindLabel = (await providerKindTrigger(page).first().innerText()).trim()
  if (!/DeepSeek/.test(kindLabel)) {
    failures.push(`老用户默认服务类型不是 DeepSeek 官方：${JSON.stringify(kindLabel)}`)
  } else {
    console.log(`ok: 默认服务类型 = ${kindLabel}`)
  }
  // 再钉一层：默认渠道必须真的落在配置层（localStorage 没写过 kind 也要按构建默认渠道生效，
  // 见 apiConfig.ts 的 getProviderKind）。避免「界面文案对了但状态是空的」这种半对。
  const effectiveKind = await page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))
  if (effectiveKind !== null && effectiveKind !== 'deepseek') {
    failures.push(`老用户生效渠道不是 deepseek：${JSON.stringify(effectiveKind)}`)
  } else {
    console.log(`ok: 生效渠道 = ${effectiveKind ?? 'deepseek（未落盘，按构建默认）'}`)
  }
  await closeSettings(page)

  await sendChat(page, '你好')
  const hit = await (async () => {
    await waitFor(() => requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages')))
    return requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'))
  })()

  if (!hit) {
    failures.push('老配置下没有发出消息请求')
  } else {
    console.log(`ok: 消息路径 = ${hit.path}`)
    if (hit.path !== '/anthropic/v1/messages') {
      failures.push(`老配置下路径变了：${hit.path}`)
    }
    if (!hit.url.startsWith(`${LEGACY_BASE}/`)) {
      failures.push(`老配置的服务地址被丢弃：${hit.url}`)
    } else {
      console.log(`ok: 仍在用老地址 ${LEGACY_BASE}`)
    }
    const body = JSON.parse(hit.postData ?? '{}')
    if (body.model !== LEGACY_MODEL) {
      failures.push(`老配置的模型被丢弃：${JSON.stringify(body.model)}`)
    } else {
      console.log(`ok: 仍在用老模型 ${LEGACY_MODEL}`)
    }
    if (!body.safety_check || !body.tools) {
      failures.push('老用户（deepseek）请求体丢了 safety_check / tools')
    }
    // 自填地址（中转）不带 anthropic-version：中转的 CORS 白名单一般不允许，
    // 带上会让浏览器预检失败，老用户升级后直接变成网络错误。
    if (hit.headers['anthropic-version']) {
      failures.push(`打自填地址时不应带 anthropic-version：${hit.headers['anthropic-version']}`)
    } else {
      console.log('ok: 自填地址不带 anthropic-version（CORS 安全）')
    }
  }
  // ---------- 第二个场景（#339）：只有残留 model、没有 base-url → 必须发官方内置模型 ----------
  // 造一份「旧版在别的渠道填过模型」的本地存储：共享 chat-demo:model 里残留 deepseek-v4.1-flash，
  // 但没有任何中转地址（= 官方渠道），且没有 config-schema 版本号（= 本次升级后第一次启动）。
  await page.evaluate(() => {
    window.localStorage.removeItem('chat-demo:base-url')
    window.localStorage.removeItem('chat-demo:config-schema')
    window.localStorage.setItem('chat-demo:model', 'deepseek-v4.1-flash')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // 迁移痕迹：版本号落盘、残留键被删（用户不必再手工 removeItem）
  const schema = await page.evaluate(() => window.localStorage.getItem('chat-demo:config-schema'))
  if (schema !== '2') {
    failures.push(`#339：配置迁移版本号没写对：${JSON.stringify(schema)}`)
  } else {
    console.log('ok: #339 配置迁移版本号 = 2')
  }
  const residue = await page.evaluate(() => window.localStorage.getItem('chat-demo:model'))
  if (residue !== null) {
    failures.push(`#339：升级后残留模型没有被清掉：${JSON.stringify(residue)}`)
  } else {
    console.log('ok: #339 升级启动时清掉了残留 chat-demo:model（用户不必手工删 localStorage）')
  }

  requests.length = 0
  await sendChat(page, '你好（残留模型）')
  const residueHit = await (async () => {
    await waitFor(() =>
      requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))
    )
    return requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'))
  })()
  if (!residueHit) {
    failures.push('#339：残留模型场景下没有发出消息请求')
  } else {
    const body = JSON.parse(residueHit.postData ?? '{}')
    if (body.model !== 'deepseek-flash') {
      failures.push(`#339：残留模型仍在生效（实际发出 ${JSON.stringify(body.model)}）`)
    } else {
      console.log('ok: #339 残留模型被忽略，实际发出 deepseek-flash')
    }
    if (!residueHit.url.startsWith('https://api.deepseek.com/')) {
      failures.push(`#339：官方渠道地址不对：${residueHit.url}`)
    } else {
      console.log(`ok: #339 发到官方地址 ${new URL(residueHit.url).origin}`)
    }
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
