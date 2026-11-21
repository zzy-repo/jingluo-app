// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 核心验收（1.2.3）：请求体必须按服务类型剥离 DeepSeek 扩展字段，否则裸 Anthropic 上游每个请求都 400。
//
// A) Anthropic 协议：请求体里不许出现 safety_check / title / tools / role:'latest_reminder'
//    （latestReminder 的内容改拼进 system，不丢信息）
// B) DeepSeek 官方：上述字段原样保留（回归硬约束，不能为适配把官方模式改坏）
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/integration/request-body.test.mjs
import {
  capturePaths,
  clickApiKeyConfirm,
  closeSettings,
  fillApiKey,
  fillBaseUrl,
  fillModel,
  finish,
  assertNoEgress,
  openApp,
  openSettingsDataSection,
  selectProviderKind,
  sendChat,
  stubMessagesStream,
  stubModels,
} from '../helpers/helpers.mjs'

const name = 'tests/integration/request-body.test.mjs'
const failures = []
const ANTHROPIC_PATH = /\/v1\/messages$/
const DEEPSEEK_PATH = /\/anthropic\/v1\/messages$/

const readBody = (requests, pathRe) => {
  const hit = requests.find(
    (r) => r.method === 'POST' && pathRe.test(r.path) && typeof r.postData === 'string'
  )
  if (!hit) {
    return null
  }
  try {
    return JSON.parse(hit.postData)
  } catch {
    return null
  }
}

const waitForBody = async (page, requests, pathRe, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const body = readBody(requests, pathRe)
    if (body) {
      return body
    }
    await page.waitForTimeout(100)
  }
  return null
}

// ---------- A) Anthropic 协议：扩展字段必须全部剥离 ----------
{
  const { browser, page } = await openApp()
  try {
    await stubModels(page, /\/v1\/models$/)
    await stubMessagesStream(page, ANTHROPIC_PATH)
    const requests = capturePaths(page)

    await openSettingsDataSection(page)
    await selectProviderKind(page, /Anthropic 协议|Anthropic-compatible/)
    await fillBaseUrl(page, 'https://anthropic.example.com')
    await fillModel(page, 'deepseek-v4.1-flash')
    await fillApiKey(page, 'sk-testkey-body-anthropic')
    await clickApiKeyConfirm(page)
    await page.waitForTimeout(300)
    await closeSettings(page)

    await sendChat(page, '你好')
    const body = await waitForBody(page, requests, ANTHROPIC_PATH)
    if (!body) {
      failures.push('A) 没有捕获到 /v1/messages 的请求体')
    } else {
      console.log(`A) 请求体顶层字段 = ${JSON.stringify(Object.keys(body))}`)
      // 与 providers.ts 的 REQUEST_GATES 表一一对应：anthropic 全部 withhold
      const roles = (body.messages ?? []).map((message) => message.role)
      const gates = {
        safety_check: Object.hasOwn(body, 'safety_check'),
        title: Object.hasOwn(body, 'title'),
        tools: Object.hasOwn(body, 'tools'),
        latest_reminder: roles.includes('latest_reminder'),
      }
      for (const [field, sent] of Object.entries(gates)) {
        if (sent) {
          failures.push(`A) Anthropic 请求体仍带 ${field}：${JSON.stringify(body.messages ?? '').slice(0, 80)}`)
        } else {
          console.log(`ok: 已剥离 ${field}`)
        }
      }
      const system = String(body.system ?? '')
      if (!system.includes('Web') || system.length <= 20) {
        failures.push(`A) latestReminder 内容没有拼进 system：${JSON.stringify(system)}`)
      } else {
        console.log(`ok: 提醒内容已并入 system（${system.length} 字符）`)
      }
      if (body.thinking && body.thinking.type === 'enabled' && !body.thinking.budget_tokens) {
        failures.push('A) Anthropic 下 thinking 未带 budget_tokens')
      }
    }
  } catch (error) {
    failures.push(`A) 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await browser.close()
  }
}

// ---------- B) DeepSeek 官方：扩展字段必须原样保留 ----------
{
  const { browser, page } = await openApp()
  try {
    await stubModels(page)
    await stubMessagesStream(page, DEEPSEEK_PATH)
    const requests = capturePaths(page)

    await openSettingsDataSection(page)
    await fillApiKey(page, 'sk-testkey-body-deepseek')
    await clickApiKeyConfirm(page)
    await page.waitForTimeout(300)
    await closeSettings(page)

    await sendChat(page, '你好')
    const body = await waitForBody(page, requests, DEEPSEEK_PATH)
    if (!body) {
      failures.push('B) 没有捕获到 /anthropic/v1/messages 的请求体')
    } else {
      console.log(`B) 请求体顶层字段 = ${JSON.stringify(Object.keys(body))}`)
      if (body.safety_check?.level !== 'high') {
        failures.push(`B) DeepSeek 模式丢了 safety_check：${JSON.stringify(body.safety_check)}`)
      } else {
        console.log('ok: safety_check 保留')
      }
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        failures.push(`B) DeepSeek 模式丢了 tools：${JSON.stringify(body.tools)}`)
      } else {
        console.log(`ok: tools 保留（${body.tools.length} 个）`)
      }
      const roles = (body.messages ?? []).map((message) => message.role)
      if (!roles.includes('latest_reminder')) {
        failures.push(`B) DeepSeek 模式丢了 role:'latest_reminder'：${JSON.stringify(roles)}`)
      } else {
        console.log("ok: role:'latest_reminder' 保留")
      }
      if (!Object.hasOwn(body, 'title')) {
        failures.push('B) DeepSeek 模式丢了 title（新会话自动起标题）')
      } else {
        console.log('ok: title 保留')
      }
      if (body.thinking && Object.hasOwn(body.thinking, 'budget_tokens')) {
        failures.push(`B) DeepSeek 模式不该带 budget_tokens：${JSON.stringify(body.thinking)}`)
      }
    }
  } catch (error) {
    failures.push(`B) 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await browser.close()
  }
}

// #673：出站总闸兜底断言（本文件自己收尾、不调 finish()，这里显式兜一次）
assertNoEgress(failures)

if (failures.length > 0) {
  console.error(`\nFAIL ${name}`)
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
console.log(`\nPASS ${name}`)
