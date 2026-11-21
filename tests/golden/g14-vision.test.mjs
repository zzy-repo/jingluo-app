// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 本机 mock 上游 | 预算: ≤60s]
//
// 黄金回归 · 域「图片 vision」（#567 定的三主线之一，B 线；母单 #548）。**只跑 1 条主路径**：
//   选一张 png → 编码成内联图片 → 发一条消息（mock 上游）→ 收到回复
//
// 这条为什么值钱：图片比纯文本多了一段「本地编码 → 内联进请求体」的链路（imageSource 编码 →
// 缓存 → drafts 就绪态 → store.prepareInlineImages → reply.toFileBlocks → openaiAdapter 翻译）。
// 任何一环接错，**界面上都不会红**：文字照发、回复照收，只是模型看不见图（或发出去的是一张空图）。
// 所以这里不看界面长什么样，直接把真浏览器发出去的那份请求体抓下来，按**字节**钉死：
//   · 图片是 `data:image/png;base64,…`（anthropic 是 `source.data`，openai / ours 是 data URL）；
//   · 这份字节解回像素必须是 `#3366cc`（不是「有张图」就算过）；
//   · 三渠道形状**不同**、**字节相同**（同一张原图，阈值内原图直发，一个字节都不许变）。
//
// 夹具：`tests/fixtures/golden/tiny.png`（74 B，8×8 纯色 #3366cc，随仓库入库，#578）。
// **不要手拼 base64** —— 手拼的 png 前缀对、CRC 错，浏览器 `<img>` 不出图，红起来像 vision 链路坏了。
//
// 与 L0 / L1 的分工：#553 的 18 条用例已经逐字钉了请求体、预处理边界、EXIF、前缀稳定、负向 8/8；
// 这里只回答一个问题：**普通用户选一张图、点发送，图片真的进了发出去的请求，且三家说法一致。**
//
// 跑法（仓库根目录）：pnpm run build && node --test tests/golden/g14-vision.test.mjs
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'

import { openAiSse } from '../fixtures/domain03-04/ours-upstream.mjs'
// #596：ours 的 Key 由服务端下发，种子数据要带「下发标记」，否则发送前守卫会拦（这是产品行为）
import { claimedOursStorage } from '../helpers/ours-claim.mjs'
import {
  bodyText,
  brief,
  openGoldenPage,
  runGolden,
  serveGoldenApp,
  waitFor,
  waitForBoot,
} from '../helpers/golden.mjs'

const KEY = 'sk-golden-g14-0123456789abcdef'
const MODEL = 'mock-model'
const QUESTION = '这张图是什么颜色？'
const ANSWER = '这是一整块蓝色'

/** 中转服务的 CORS 口径：预检必须被放行，否则浏览器内存里的桩也接不到 POST */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key,anthropic-version,x-session-id',
  'access-control-max-age': '600',
}

/**
 * 本次用例**登记的桩地址**（白名单）：三个渠道各一条。
 *
 * 为什么必须白名单（#404 判据「stub 后端：断言没有请求打到 `:18000` / 生产」）：
 * `page.route` 的 path glob（`v1/messages`、`v1/chat/completions`）**只看路径、不看 host** —— 请求发到哪台机器它都接得住。
 * 于是「请求体对吗」这一组断言对「流量被改道到生产域名」完全无感：把 `resolveBaseUrl()` 改成
 * 忽略用户填的地址、回落到内置生产地址，本用例照样全绿（#654 的负向对照 B4 实测如此）。
 * 所以补两条：① 每条 chat 请求的 host 必须等于该渠道登记的桩 host；② 兜底闸把任何没登记的
 * 请求挡下来并留证 —— 「没连真实服务」这件事要被断言，而不是靠自觉。
 */
const ENDPOINTS = JSON.parse(await readFile(new URL('../../config/endpoints.json', import.meta.url), 'utf8'))
/** ours 的地址内置且 locked：唯一来源是 config/endpoints.json（构建期注入），不是 127.0.0.1:18000 */
const OURS_HOST = new URL(ENDPOINTS.chatBaseUrl).host
const ANTHROPIC_STUB_HOST = '127.0.0.1:18414'
const OPENAI_STUB_HOST = '127.0.0.1:18415'
/** 本机真实例端口：任何请求打到这里都算「测试连了真服务」 */
const REAL_INSTANCE_PORT = 18000

/**
 * 三个 base64 渠道：**同一张图、同一条消息**，各发一次。
 *
 * `ours` 的地址与模型是内置的（`locked`，来自 `config/endpoints.json`），所以只预置 kind + Key；
 * anthropic / openai 的地址指到**本机一个没人监听的端口**：请求全靠 `page.route` 拦下来，
 * 万一桩没接上就是 connection refused（一条能看懂的错），而不是悄悄打到真实上游。
 */
const CHANNELS = [
  {
    kind: 'anthropic',
    name: 'Anthropic 协议',
    protocol: 'anthropic',
    storage: {
      'chat-demo:provider-kind': 'anthropic',
      'chat-demo:api-key': KEY,
      'chat-demo:base-url:anthropic': 'http://127.0.0.1:18414',
      'chat-demo:model:anthropic': MODEL,
    },
    /** 这个渠道的请求**只许**落在这个 host 上（桩的门牌号，见上面的白名单说明） */
    stubHost: ANTHROPIC_STUB_HOST,
  },
  {
    kind: 'openai',
    name: 'OpenAI 兼容',
    protocol: 'openai',
    storage: {
      'chat-demo:provider-kind': 'openai',
      'chat-demo:api-key': KEY,
      'chat-demo:base-url:openai': 'http://127.0.0.1:18415',
      'chat-demo:model:openai': MODEL,
    },
    stubHost: OPENAI_STUB_HOST,
  },
  {
    kind: 'ours',
    name: '我们的渠道',
    protocol: 'openai',
    storage: { 'chat-demo:provider-kind': 'ours', ...(await claimedOursStorage(KEY)) },
    stubHost: OURS_HOST,
  },
]

/** Anthropic 协议的 SSE（deepseek / anthropic 共用这套事件）；少一个事件拿不到正文 */
const anthropicSse = (text) =>
  [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_golden_g14',
        type: 'message',
        role: 'assistant',
        content: [],
        model: MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    })}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')

/**
 * 上游桩：两条路径各一套 SSE，**把发出去的原始请求体收下来**。
 * 用 `page.route` 而不是真起一个 HTTP 服务：这里不造流式时序，只需要「请求体那一串字节」。
 *
 * 另外挂一张**兜底闸**（`appUrl` 之外的任何请求都挡下并记账）：`page.route` 只匹配
 * 按 path 的 glob（`v1/messages` 前缀那条），host 不管 —— 流量被改道到生产域名时桩照样应答、
 * 用例照样绿。兜底闸的作用是让「漏出去的请求」变成一条**可断言的失败行**，而不是静默出网。
 * 注册顺序有讲究：Playwright 后注册的先匹配，所以兜底闸必须**最先**注册（优先级最低）。
 */
const stubUpstream = async (page, appUrl) => {
  const calls = []
  /** 落在桩表之外的请求（含真实例 / 生产域名）：必须为空，非空就是「测试连了真服务」 */
  const escaped = []
  const appOrigin = new URL(appUrl).origin
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith(`${appOrigin}/`) || url.startsWith('blob:') || url.startsWith('data:')) {
      await route.fallback()
      return
    }
    escaped.push(url)
    await route.abort()
  })
  const routeOf = (protocol) => async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    calls.push({
      protocol,
      url: request.url(),
      headers: request.headers(),
      body: request.postData() ?? '',
    })
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: protocol === 'anthropic' ? anthropicSse(ANSWER) : openAiSse(ANSWER),
    })
  }
  await page.route('**/v1/messages', routeOf('anthropic'))
  await page.route('**/v1/chat/completions', routeOf('openai'))
  return { calls, escaped }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 把 PNG 解回像素（8bit、非隔行；按行反滤波 —— 规范 9.2 的 0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）。
 *
 * 为什么要真解一遍：断言「base64 里有一段字符串」证明不了这是一张**能出图**的 png ——
 * 手拼夹具的老坑就是这样（前缀对、CRC 错 / 像素不对，浏览器 `<img>` 不出图）。这里解到像素，
 * 断言「满屏都是 #3366cc」，等于把「用户真的看到那张图」也钉住了。
 */
const pngPixels = (bytes) => {
  const buffer = Buffer.from(bytes)
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是 PNG 签名')
  }
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  for (let p = 8; p + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(p)
    const type = buffer.subarray(p + 4, p + 8).toString('latin1')
    const data = buffer.subarray(p + 8, p + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) {
        throw new Error('不支持隔行 PNG')
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    p += 12 + length
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`期望 8bit RGB/RGBA，实际 ${bitDepth}bit / 颜色类型 ${colorType}`)
  }
  const channels = colorType === 2 ? 3 : 4
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`IDAT 解压后 ${raw.length} 字节，期望 ${height * (stride + 1)}`)
  }
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i += 1) {
      const value = raw[src + i]
      const left = i >= channels ? pixels[dst + i - channels] : 0
      const up = y > 0 ? pixels[dst - stride + i] : 0
      const upLeft = i >= channels && y > 0 ? pixels[dst - stride + i - channels] : 0
      let restored
      if (filter === 0) {
        restored = value
      } else if (filter === 1) {
        restored = value + left
      } else if (filter === 2) {
        restored = value + up
      } else if (filter === 3) {
        restored = value + ((left + up) >> 1)
      } else if (filter === 4) {
        const pa = Math.abs(up - upLeft)
        const pb = Math.abs(left - upLeft)
        const pc = Math.abs(left + up - 2 * upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        restored = value + predictor
      } else {
        throw new Error(`第 ${y} 行的滤波类型 ${filter} 不认识`)
      }
      pixels[dst + i] = restored & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/** 这张图是不是整块纯色（逐像素，不看体积、不看文件名） */
const isSolidColor = ({ width, height, channels, pixels }, rgb) => {
  for (let i = 0; i < width * height; i += 1) {
    const p = i * channels
    if (pixels[p] !== rgb[0] || pixels[p + 1] !== rgb[1] || pixels[p + 2] !== rgb[2]) {
      return false
    }
  }
  return true
}

/**
 * 从请求体里取出「图片那一段」，**按协议分别读**（形状本来就不同，这正是本用例要钉的东西）：
 * - anthropic：`{type:'image', source:{type:'base64', media_type, data}}`
 * - openai / ours：`{type:'image_url', image_url:{url:'data:<media>;base64,<data>'}}`
 * 找不到返回 null —— 那就是「图片没进请求体」，主路径断了。
 */
const imageInRequest = (rawBody, protocol) => {
  let body = null
  try {
    body = JSON.parse(rawBody)
  } catch {
    return null
  }
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const user = [...messages].reverse().find((message) => message?.role === 'user')
  const content = user?.content
  if (!Array.isArray(content)) {
    return null
  }
  const part = content.find((item) => item?.type === 'image' || item?.type === 'image_url')
  if (!part) {
    return null
  }
  if (protocol === 'anthropic') {
    const source = part.source ?? {}
    return {
      shape: '{type:image, source:{type:base64, media_type, data}}',
      mediaType: source.media_type ?? '',
      data: typeof source.data === 'string' ? source.data : '',
      url: '',
      sourceType: source.type ?? '',
    }
  }
  const url = part.image_url?.url ?? ''
  const matched = /^data:([^;]+);base64,(.*)$/su.exec(url)
  return {
    shape: '{type:image_url, image_url:{url:data:…}}',
    mediaType: matched ? matched[1] : '',
    data: matched ? matched[2] : '',
    url,
    sourceType: 'url',
  }
}

/** 回答区正文（压成单行） */
const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  return (await nodes.count()) === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/gu, ' ').trim()
}

/** 发送按钮（流式时同一个位置是「停止」，所以只在点之前读它） */
const sendButton = (page) => page.locator('button[aria-label="发送"], button[aria-label="Send"]').first()

const result = await runGolden(
  {
    id: 'G14',
    domain: '图片 vision',
    title: '选一张 png → 内联编码 → 发一条消息（三渠道形状不同、图片字节相同）',
  },
  async (ctx) => {
    const app = await serveGoldenApp()
    // 夹具是**真二进制**（#578 入库的 74 B png），不是手拼的 base64
    const fixture = await readFile(new URL('../fixtures/golden/tiny.png', import.meta.url))
    const expectedBase64 = fixture.toString('base64')
    const expectedRgb = [0x33, 0x66, 0xcc]

    ctx.begin('夹具自证')
    const decoded = pngPixels(fixture)
    ctx.expect(
      'tiny.png 解出来是 8×8、满屏 #3366cc（夹具自证：别拿坏文件去断言产品）',
      decoded.width === 8 && decoded.height === 8 && isSolidColor(decoded, expectedRgb),
      {
        expected: '8×8 纯色 #3366cc',
        actual: `${decoded.width}×${decoded.height} / 首像素 rgb(${[...decoded.pixels.subarray(0, 3)].join(',')})`,
      }
    )

    const { page, close } = await openGoldenPage(app.url, { storage: {} })
    const { calls, escaped } = await stubUpstream(page, app.url)
    /** 每个渠道「真正发出去的那份 base64」：渠道之间必须逐字相同 */
    const sentBase64 = new Map()
    try {
      for (const channel of CHANNELS) {
        const label = channel.name
        // 预置这个渠道（kind + Key + 自填渠道的地址/模型），再 reload 让配置从存储里读一遍
        await page.evaluate((entries) => {
          window.localStorage.clear()
          for (const [key, value] of Object.entries(entries)) {
            window.localStorage.setItem(key, value)
          }
        }, channel.storage)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await waitForBoot(page)

        // ── 1. 选图：图片附件入口 → 真 png 喂进去（走 File → addDraftFiles → 本地编码） ──
        ctx.begin(`${label} · 选图`)
        const fileInput = page.locator('input[type="file"][accept*="image/png"]')
        if ((await fileInput.count()) === 0) {
          ctx.abort(
            `${label} · 图片附件入口在`,
            '1 个 accept 含 image/png 的 file input',
            `body=${brief(await bodyText(page))}`
          )
        }
        await fileInput.setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: fixture })
        const accepted = await waitFor(page, async () => (await page.locator('img[alt="tiny.png"]').count()) > 0)
        if (!accepted) {
          ctx.abort(
            `${label} · 选中的图进了输入区（缩略图出现）`,
            'img[alt="tiny.png"] = 1',
            `body=${brief(await bodyText(page))}`
          )
        }
        // 编码完成 = 发送按钮解除置灰（编码中 / 失败时 canSend 一直是 false，绝不静默丢图）
        const encoded = await waitFor(page, async () => (await sendButton(page).getAttribute('aria-disabled')) !== 'true')
        ctx.expect(`${label} · 本地编码完成后才能发送（发送按钮解除置灰）`, encoded, {
          expected: 'aria-disabled 不是 true',
          actual: `aria-disabled=${await sendButton(page).getAttribute('aria-disabled')}`,
        })

        // ── 2. 发一条消息：抓请求体，看图片是不是真的在里面 ────────────────────────
        ctx.begin(`${label} · 发一条消息`)
        const offset = calls.length
        await page.locator('textarea').last().fill(QUESTION)
        await sendButton(page).click()
        const replied = await waitFor(page, async () => (await answerText(page)).includes(ANSWER))
        ctx.expect(`${label} · 回答上屏（请求真的走通并收到流式正文）`, replied, {
          expected: `回答区含「${ANSWER}」`,
          actual: `回答区=${brief(await answerText(page))}`,
        })
        const call = calls.slice(offset).find((item) => item.protocol === channel.protocol)
        if (!call) {
          ctx.abort(
            `${label} · 发出的请求落到 ${channel.protocol} 协议路径`,
            channel.protocol === 'anthropic' ? 'POST …/v1/messages' : 'POST …/v1/chat/completions',
            `抓到 ${calls.slice(offset).length} 次请求`
          )
        }
        // 先钉「这一枪打向谁」：host 必须是本渠道登记的桩（`page.route` 不看 host，所以只能靠断言）
        const landedHost = new URL(call.url).host
        ctx.expect(
          `${label} · 请求落在本渠道登记的桩地址（不连生产 / 不连 :${REAL_INSTANCE_PORT}）`,
          landedHost === channel.stubHost,
          {
            expected: `host=${channel.stubHost}`,
            actual: `host=${landedHost}（${brief(call.url, 70)}）`,
          }
        )
        const image = imageInRequest(call.body, channel.protocol)
        if (!image) {
          ctx.abort(
            `${label} · 请求体里带上了图片`,
            channel.protocol === 'anthropic' ? 'content 里有 {type:"image"}' : 'content 里有 {type:"image_url"}',
            `user content=${brief(JSON.stringify(JSON.parse(call.body).messages?.at(-1)?.content ?? null))}`
          )
        }
        ctx.expect(`${label} · 图片形状是 ${image.shape}`, image.data.length > 0 && image.mediaType === 'image/png', {
          expected: `${image.shape}，media_type=image/png`,
          actual: `type=${image.sourceType} / media_type=${image.mediaType || '（没有）'} / data=${image.data.length} 字符`,
        })
        if (channel.protocol === 'openai') {
          // openai / ours 的 url 前缀就是这个协议的唯一形状：必须是 data:image/…;base64,
          ctx.expect(
            `${label} · 图片以 data:image/png;base64, 内联（OpenAI 协议只有这一种形状）`,
            image.url.startsWith('data:image/png;base64,'),
            {
              expected: 'data:image/png;base64,…',
              actual: `${brief(image.url, 40)}…`,
            }
          )
        }
        ctx.expect(
          `${label} · 图片字节 = 夹具原图（阈值内原图直发，一个字节都不许变）`,
          image.data === expectedBase64,
          {
            expected: `与 tiny.png 逐字相同（${expectedBase64.length} 字符）`,
            actual: `${image.data.length} 字符${image.data === expectedBase64 ? '（相同）' : '（不同）'}`,
          }
        )
        // 发出去的这份字节自己解一遍：像素必须还是 #3366cc（不是「有段 base64」就算过）
        const sentPixels = pngPixels(Buffer.from(image.data, 'base64'))
        ctx.expect(
          `${label} · 发出去的图能解回 8×8 纯色 #3366cc`,
          sentPixels.width === 8 &&
            sentPixels.height === 8 &&
            isSolidColor(sentPixels, expectedRgb),
          {
            expected: '8×8 纯色 #3366cc',
            actual: `${sentPixels.width}×${sentPixels.height} / 首像素 rgb(${[...sentPixels.pixels.subarray(0, 3)].join(',')})`,
          }
        )
        sentBase64.set(channel.kind, image.data)
      }

      // ── 3. 三渠道对同一张图的说法必须一致：形状不同、字节相同 ───────────────────
      ctx.begin('三渠道字节一致')
      const datas = CHANNELS.map((channel) => sentBase64.get(channel.kind) ?? '')
      ctx.expect(
        'anthropic / openai / ours 发出的图片字节逐字相同（同一张原图 = 同一份 base64）',
        datas.every((data) => data.length > 0 && data === expectedBase64),
        {
          expected: `三份都等于 tiny.png 的 ${expectedBase64.length} 字符 base64`,
          actual: datas.map((data) => (data ? `${data.length} 字符` : '（没抓到）')).join(' / '),
        }
      )
      // ── 4. 不连真实服务：桩表之外一条请求都不许有 ─────────────────────────────
      ctx.begin('不连真实服务')
      const escapedHosts = [...new Set(escaped.map((url) => new URL(url).host))]
      ctx.expect(
        '整条路径没有请求漏到桩表之外的地址（兜底闸拦下的都记在这里）',
        escaped.length === 0,
        {
          expected: '0 次未登记请求',
          actual:
            escaped.length === 0
              ? '干净'
              : `${escaped.length} 次：${escapedHosts.join('、')}（首个 ${brief(escaped[0], 80)}）`,
        }
      )
      const chatHosts = [...new Set(calls.map((item) => new URL(item.url).host))]
      const declaredHosts = new Set(CHANNELS.map((channel) => channel.stubHost))
      ctx.expect(
        '每一次 chat 请求都落在三个渠道登记的地址上（没有第四个 host）',
        chatHosts.every((host) => declaredHosts.has(host)),
        {
          expected: `host ∈ {${[...declaredHosts].join('、')}}`,
          actual: chatHosts.length === 0 ? '（一次都没抓到）' : chatHosts.join('、'),
        }
      )
      const realHits = [...calls.map((item) => item.url), ...escaped].filter((url) =>
        url.includes(`:${REAL_INSTANCE_PORT}`)
      )
      ctx.expect(
        `没有任何请求打到 :${REAL_INSTANCE_PORT}（本机真实例）`,
        realHits.length === 0,
        {
          expected: '0 次',
          actual: realHits.length === 0 ? '0 次' : `${realHits.length} 次：${brief(realHits[0], 80)}`,
        }
      )
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
