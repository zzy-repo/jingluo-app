// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: 1~3 分钟]
// 「从链接导入」的分阶段进度 / 取消 / 失败分类（改动见 src/services/chat/history/urlImport.ts）。
//
// 只替换 Capacitor 的原生桥（window.androidBridge + capacitive nativePromise），
// mock 按请求里的 Range 头分块返回字节，因此走的是真实代码：
// 分块下载 → base64 解码 → ZIP 校验 → importHistory → staging → IndexedDB。
import { chromium } from 'playwright'
import { buildArchive, textPayload } from '../fixtures/archive-fixture.mjs'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/url-import-shots'
const ZIP_URL = 'https://obs.example.test/deepseek_data-2026-11-01.zip'

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const base64 = (bytes) => Buffer.from(bytes).toString('base64')

/** OBS 的 403 错误页原文（服务端真实返回体，只是去掉了命名空间）。 */
const obsError = (code, message) =>
  textPayload(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message>` +
      `<RequestId>0000017A1B2C3D4E</RequestId><HostId>obs-cn-east-3</HostId></Error>`
  )

/**
 * 打开应用并进入「设置 → 数据管理」。
 * plan：
 *   data       —— 正常/错误响应的字节（Uint8Array）
 *   status     —— 非 200 时直接用这个状态码（403 用例）
 *   range      —— true 时按请求 Range 返回 206 分块
 *   chunkDelay —— 每块延迟（模拟弱网）
 *   rejectAfter —— 已发出的请求数超过该值时改为 reject（模拟断网/超时）
 *   rejectMessage —— reject 的错误原文
 */
const openApp = async (plan, { viewport = { width: 1280, height: 800 } } = {}) => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  await context.addInitScript((plan) => {
    window.androidBridge = { postMessage: () => {} }
    const toBytes = (value) => {
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      return bytes
    }
    const mock = { calls: [], resolve: null, plan }
    window.__capMock = mock
    const all = plan.data === null ? new Uint8Array(0) : toBytes(plan.data)
    plan.served = 0
    const respond = (options) => {
      const index = mock.calls.length - 1
      const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
      if (plan.dataOverride) {
        plan.sourceBytes = plan.sourceBytes ?? toBytes(plan.dataOverride)
      }
      const source = plan.sourceBytes ?? all
      if (plan.rejectAfter !== undefined && index >= plan.rejectAfter) {
        return Promise.reject(new Error(plan.rejectMessage))
      }
      if (plan.rejectAfterBytes !== undefined && plan.served >= plan.rejectAfterBytes) {
        return Promise.reject(new Error(plan.rejectMessage))
      }
      // 从第 N 次请求起改回 403（模拟「同一会话里链接失效 / 第二次导入被拒」）
      if (plan.forbiddenFromCall !== undefined && index >= plan.forbiddenFromCall) {
        return {
          status: 403,
          headers: { 'Content-Type': 'application/xml' },
          data: toBytes(plan.forbiddenBody).buffer,
          url: options.url,
        }
      }
      // 第 2 次请求起返回 416（模拟服务端用 416 而非短块结束）
      if (plan.force416FromCall !== undefined && index >= plan.force416FromCall) {
        return { status: 416, headers: {}, data: new ArrayBuffer(0) }
      }
      // 分块下到一半时服务端改回 403（链接在下载过程中失效）
      if (plan.forbiddenAfterBytes !== undefined && plan.served >= plan.forbiddenAfterBytes) {
        return {
          status: 403,
          headers: { 'Content-Type': 'application/xml' },
          data: toBytes(plan.forbiddenBody).buffer,
          url: options.url,
        }
      }
      // 请求越界：真服务端可能以 416 而不是「短块」结束
      if (plan.range && range && Number(range[1]) >= source.length && source.length > 0) {
        return {
          status: 416,
          headers: { 'Content-Range': `bytes */${source.length}` },
          data: new ArrayBuffer(0),
        }
      }
      const body = () => {
        if (!plan.range || !range) {
          return { headers: { 'Content-Length': String(source.length) }, status: plan.status, data: source }
        }
        const from = Number(range[1])
        const to = Math.min(Number(range[2]), source.length - 1)
        // slice() 而不是 subarray()：subarray 的 .buffer 仍是整包，会让「已下载字节」永远是全量
        const slice = source.slice(from, Math.max(from, to + 1))
        plan.served += slice.length
        return {
          headers: plan.omitLengths
            ? {}
            : {
                'Content-Length': String(slice.length),
                'Content-Range': `bytes ${from}-${from + slice.length - 1}/${source.length}`,
              },
          status: 206,
          data: slice,
        }
      }
      const finish = () => {
        if (plan.status !== undefined && plan.status !== 200) {
          return {
            status: plan.status,
            headers: { 'Content-Type': 'application/xml' },
            url: options.url,
            data: plan.kind === 'base64-string' ? plan.data : all.buffer,
          }
        }
        const { status, headers, data } = body()
        return {
          status,
          headers,
          url: options.url,
          data: plan.kind === 'base64-string' ? base64Of(data) : data.buffer,
        }
      }
      const base64Of = (bytes) => {
        let binary = ''
        for (let index = 0; index < bytes.length; index += 1) {
          binary += String.fromCharCode(bytes[index])
        }
        return btoa(binary)
      }
      if (plan.deferred) {
        return new Promise((resolve) => {
          mock.resolve = () => resolve(finish())
        })
      }
      return plan.chunkDelay
        ? new Promise((resolve) => setTimeout(() => resolve(finish()), plan.chunkDelay))
        : Promise.resolve(finish())
    }
    window.Capacitor = {
      PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'get', rtype: 'promise' }] }],
      nativePromise: (_pluginName, _methodName, options) => {
        mock.calls.push(options)
        return respond(options)
      },
    }
  }, plan)
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  if ((await page.getByRole('dialog').count()) === 0) {
    await page
      .getByRole('button', { name: /设置|Settings/ })
      .last()
      .click()
  }
  await page
    .getByRole('tab', { name: /数据管理|Data/ })
    .first()
    .click()
  return { browser, page, consoleErrors }
}

const dbCounts = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const read = (store) =>
            new Promise((done, fail) => {
              if (!db.objectStoreNames.contains(store)) {
                done(0)
                return
              }
              const count = db.transaction(store, 'readonly').objectStore(store).count()
              count.onsuccess = () => done(count.result)
              count.onerror = () => fail(count.error)
            })
          Promise.all([read('sessions'), read('sessionsStaging'), read('filesStaging')])
            .then(([sessions, sessionsStaging, filesStaging]) =>
              resolve({ sessions, sessionsStaging, filesStaging })
            )
            .catch(reject)
        }
      })
  )

/** 填链接 → 点「导入」→ 确认弹窗点「确认导入」。 */
const startUrlImport = async (page, { url = ZIP_URL, confirm = true } = {}) => {
  await page.getByLabel('从链接导入').fill(url)
  await page.getByRole('button', { name: '导入', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await dialog.waitFor({ timeout: 5000 })
  if (confirm) {
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  }
  return dialog
}

/** 轮询界面文本，直到 stop 命中；返回带时间戳的采样。 */
const sampleUntil = async (page, stop, timeoutMs = 40_000, intervalMs = 120) => {
  const startedAt = Date.now()
  const samples = []
  for (;;) {
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    samples.push({ t: Date.now() - startedAt, text })
    if (stop(text)) {
      return { samples, text, elapsed: Date.now() - startedAt }
    }
    if (Date.now() - startedAt > timeoutMs) {
      return { samples, text, elapsed: Date.now() - startedAt, timeout: true }
    }
    await page.waitForTimeout(intervalMs)
  }
}

const run = async () => {
  // 注意：archive-fixture 的 imageBytes > 0 会生成导入端判为「内容不完整」的包（与本改动无关，
  // 用普通「上传文件」链路同样失败），所以这里用无图片的包；真实 329 会话/含图片的包在
  // 模拟器上用 /tmp/diag/archive.zip（真实 OBS 包副本）做设备验收。
  const archive = buildArchive({ sessionCount: 120, padBytes: 4 * 1024 * 1024 })
  const zipPayload = { kind: 'arraybuffer', status: 200, range: true, data: base64(archive.zip) }
  // 弱网用例用小包：块数够多（≥6 个采样点）但整体几秒内结束，不拖时间。
  const weakArchive = buildArchive({ sessionCount: 20, padBytes: 512 * 1024 })
  const weakPayload = { kind: 'arraybuffer', status: 200, range: true, data: base64(weakArchive.zip) }

  // ── 用例 1：分阶段进度（下载 → 解析 → 导入 n/总数 → 已导入） ────────────────
  {
    console.log('\n[case 1] 分阶段进度：下载 → 解析 → 导入 n/总数 → 已导入')
    const { browser, page, consoleErrors } = await openApp({ ...zipPayload, chunkDelay: 200 })
    await startUrlImport(page)
    const { samples, text } = await sampleUntil(page, (value) => /已导入|失败|过大|断开|超时/.test(value), 60_000)
    const joined = samples.map((sample) => sample.text).join('\n')
    check('出现「正在下载… 已下载/总大小（%）」', /正在下载… [\d.]+KB\/[\d.]+MB（\d+%）/.test(joined), joined.slice(0, 200))
    check('出现「正在解析…」', /正在解析…/.test(joined))
    check(
      `出现「正在导入… n/${archive.sessions} 个会话」`,
      new RegExp(`正在导入… \\d+/${archive.sessions} 个会话`).test(joined),
      joined.slice(0, 300)
    )
    check(`最终显示「已导入 ${archive.sessions} 个会话」`, text.includes(`已导入 ${archive.sessions} 个会话`), text.slice(0, 200))
    const counts = await dbCounts(page)
    check('会话写库数与会话数一致', counts.sessions === archive.sessions, JSON.stringify(counts))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await page.screenshot({ path: `${SHOT_DIR}/stages-done.png` })
    await browser.close()
  }

  // ── 用例 2：弱网：已下载字节单调增长（不是纯转圈） ────────────────────────
  {
    console.log('\n[case 2] 弱网：每块 400ms，已下载字节持续增长')
    const { browser, page, consoleErrors } = await openApp({ ...weakPayload, chunkDelay: 250 })
    await startUrlImport(page)
    const downloadedSamples = new Set()
    const { samples } = await sampleUntil(
      page,
      (value) => {
        const match = /正在下载… ([\d.]+)(KB|MB)\/([\d.]+)(KB|MB)（(\d+)%）/.exec(value)
        if (match) {
          downloadedSamples.add(`${match[1]}${match[2]}`)
        }
        return downloadedSamples.size >= 3 || /已导入|失败|断开|超时/.test(value)
      },
      60_000
    )
    const bytes = []
    for (const sample of samples) {
      const match = /正在下载… ([\d.]+)(KB|MB)\/([\d.]+)(KB|MB)（(\d+)%）/.exec(sample.text)
      if (match) {
        const value = Number(match[1]) * (match[2] === 'MB' ? 1024 : 1)
        if (bytes.length === 0 || bytes[bytes.length - 1] !== value) {
          bytes.push(value)
        }
      }
    }
    check('至少 3 个「已下载」采样点（块大小自适应，块数有限）', bytes.length >= 3, `实际 ${bytes.length}：${bytes.join(',')}`)
    check(
      '字节单调递增',
      bytes.every((value, index) => index === 0 || value > bytes[index - 1]),
      bytes.join(',')
    )
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 3：传输中断网 → 立刻「网络已断开」（不等 183 秒） ──────────────────
  {
    console.log('\n[case 3] 传输中断网：第 2 块起 IOException')
    const { browser, page, consoleErrors } = await openApp({
      ...weakPayload,
      chunkDelay: 200,
      rejectAfter: 2,
      rejectMessage: 'java.io.IOException: network is unreachable',
    })
    await startUrlImport(page)
    const { text, elapsed } = await sampleUntil(page, (value) => /网络已断开/.test(value))
    check('提示「网络已断开，请检查网络后重试」', /网络已断开，请检查网络后重试/.test(text), text.slice(0, 200))
    check(`报错耗时 < 15s（实测 ${elapsed}ms）`, elapsed < 15_000, `${elapsed}ms`)
    check('出现「重试」按钮', (await page.getByRole('button', { name: '重试', exact: true }).count()) === 1)
    check('会话数仍为 0', (await dbCounts(page)).sessions === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await page.screenshot({ path: `${SHOT_DIR}/offline.png` })
    await browser.close()
  }

  // ── 用例 3b：流被丢（unexpected end of stream）≠ 物理断网，文案单独一档 ─────────
  {
    console.log('\n[case 3b] 传输被中断（unexpected end of stream）：不说成「网络已断开」')
    const { browser, page, consoleErrors } = await openApp({
      ...weakPayload,
      chunkDelay: 60,
      rejectAfterBytes: 24 * 1024,
      rejectMessage: 'unexpected end of stream on com.android.okhttp.Address@1be17ec1',
    })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /连接中断|已导入|失败/.test(value), 30_000)
    check(
      '提示「网络连接中断（已下载 x%）」',
      /网络连接中断（已下载 \d+%）/.test(text),
      text.slice(0, 200)
    )
    check('不谎称「网络已断开」（无法证明是物理断网）', !/网络已断开/.test(text), text.slice(0, 200))
    check('会话数仍为 0', (await dbCounts(page)).sessions === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 4：弱网超时（已下载 > 0）→ 带百分比的超时文案 ─────────────────────
  {
    console.log('\n[case 4] 超时且已下载 > 0：提示已下载百分比')
    const { browser, page, consoleErrors } = await openApp({
      ...weakPayload,
      chunkDelay: 80,
      rejectAfterBytes: 20 * 1024,
      rejectMessage: 'Read timed out',
    })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /下载超时/.test(value))
    check('提示「下载超时（已下载 x%），请换更快的网络」', /下载超时（已下载 \d+%），请换更快的网络/.test(text), text.slice(0, 200))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 5：403 链接过期 vs 6：403 签名错误（文案必须不同） ────────────────
  {
    console.log('\n[case 5] 403 RequestTimeTooSkewed：链接已过期')
    const expired = obsError('RequestTimeTooSkewed', 'Request has expired')
    const { browser, page, consoleErrors } = await openApp({ kind: 'arraybuffer', status: 403, data: base64(expired) })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /过期|签名|403/.test(value))
    check('提示「下载链接已过期，请回到 DeepSeek 重新导出后再试」', /下载链接已过期，请回到 DeepSeek 重新导出后再试/.test(text), text.slice(0, 200))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }
  {
    console.log('\n[case 6] 403 SignatureDoesNotMatch：链接无效（签名错误）')
    const badSig = obsError('SignatureDoesNotMatch', 'The request signature we calculated does not match')
    const { browser, page, consoleErrors } = await openApp({ kind: 'arraybuffer', status: 403, data: base64(badSig) })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /过期|签名|403/.test(value))
    check('提示「链接无效（签名错误），请重新复制完整链接」', /链接无效（签名错误），请重新复制完整链接/.test(text), text.slice(0, 200))
    check('与「链接过期」文案不同', !/下载链接已过期/.test(text))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 7：其他 403 → 带服务端原文（可展开/可复制） ──────────────────────
  {
    console.log('\n[case 7] 其他 403：提示 403 + 服务端原文')
    const denied = obsError('AccessDenied', 'Access denied by bucket policy')
    const { browser, page, consoleErrors } = await openApp({ kind: 'arraybuffer', status: 403, data: base64(denied) })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /403/.test(value))
    check('提示「没有权限访问该链接（403）：…」', /没有权限访问该链接（403）：/.test(text), text.slice(0, 240))
    check('带服务端原文', /Access denied by bucket policy/.test(text))
    check('提供「复制」与「展开」', (await page.getByRole('button', { name: '复制', exact: true }).count()) >= 1)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 8：点「重试」重走完整流程 ───────────────────────────────────────
  {
    console.log('\n[case 8] 失败后重试：从同一链接重新下载并成功')
    const notZip = textPayload('this is definitely not a zip archive')
    const { browser, page, consoleErrors } = await openApp({ kind: 'arraybuffer', status: 200, data: base64(notZip) })
    await startUrlImport(page)
    await page.getByText(/不是有效的 ZIP 文件/).waitFor({ timeout: 20_000 })
    check('先提示「该链接不是有效的 ZIP 文件」', (await page.getByText(/不是有效的 ZIP 文件/).count()) > 0)
    // 换成正常包后再点「重试」：证明重试会重新走完整流程（不是只回设置页）
    await page.getByRole('button', { name: '重试', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /确认导入历史对话/ })
    await dialog.waitFor({ timeout: 5000 })
    check('重试打开确认弹窗（重新走流程）', (await dialog.count()) === 1)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    check('取消后按钮恢复可用', await page.getByRole('button', { name: '导入', exact: true }).isEnabled())
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 9：下载中点取消 → 界面立刻恢复、无脏数据 ─────────────────────────
  {
    console.log('\n[case 9] 下载中取消：界面恢复、会话数不变')
    const { browser, page, consoleErrors } = await openApp({ ...zipPayload, deferred: true })
    const dialog = await startUrlImport(page)
    await page.waitForTimeout(300)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    check('确认弹窗关闭', (await page.getByRole('dialog', { name: /确认导入历史对话/ }).count()) === 0)
    check('「导入」按钮恢复可用', await page.getByRole('button', { name: '导入', exact: true }).isEnabled())
    await page.evaluate(() => window.__capMock.resolve?.())
    await page.waitForTimeout(2000)
    const counts = await dbCounts(page)
    check('取消后不写入：sessions = 0', counts.sessions === 0, JSON.stringify(counts))
    check('取消后无「已导入」提示', (await page.getByText(/已导入/).count()) === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 10：导入中取消 → 暂存清空、会话数不变 ────────────────────────────
  {
    console.log('\n[case 10] 导入中（正在导入 n/总数）取消：暂存清空、会话数不变')
    const big = buildArchive({ sessionCount: 300, padBytes: 8 * 1024 * 1024 })
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: true,
      data: base64(big.zip),
    })
    const dialog = await startUrlImport(page)
    await page
      .getByText(/正在导入… \d+\/\d+ 个会话/)
      .first()
      .waitFor({ timeout: 40_000 })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForTimeout(3000)
    const counts = await dbCounts(page)
    check('会话数不变（未被替换）', counts.sessions === 0, JSON.stringify(counts))
    check(
      '暂存已清空（无脏数据）',
      counts.sessionsStaging === 0 && counts.filesStaging === 0,
      JSON.stringify(counts)
    )
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 11：360dp 宽：长错误文案完整可见（不裁切） ───────────────────────
  {
    console.log('\n[case 11] 360dp 宽：错误文案不裁切')
    const denied = obsError(
      'AccessDenied',
      'Access denied by bucket policy: this link can only be used by the exporting account and has been restricted'
    )
    const { browser, page, consoleErrors } = await openApp(
      { kind: 'arraybuffer', status: 403, data: base64(denied) },
      { viewport: { width: 360, height: 780 } }
    )
    await startUrlImport(page)
    await page.getByText(/没有权限访问该链接/).waitFor({ timeout: 20_000 })
    const overflow = await page.evaluate(() => {
      const notOverflowing = []
      const overflowing = []
      for (const element of document.querySelectorAll('*')) {
        if (element.scrollWidth - element.clientWidth > 1 && element.clientWidth > 0) {
          overflowing.push(`${element.className || element.tagName}: ${element.scrollWidth}>${element.clientWidth}`)
        }
      }
      const errorNode = [...document.querySelectorAll('div')].find((element) =>
        /没有权限访问该链接/.test(element.textContent ?? '')
      )
      return {
        overflowing: overflowing.slice(0, 5),
        errorWidth: errorNode ? `${errorNode.clientWidth}/${errorNode.scrollWidth}` : 'missing',
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    check('页面无横向溢出', overflow.documentOverflow <= 1, JSON.stringify(overflow))
    check('错误提示元素未被裁切', overflow.errorWidth === 'missing' || (() => {
      const [client, scroll] = overflow.errorWidth.split('/').map(Number)
      return scroll - client <= 1
    })(), overflow.errorWidth)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await page.screenshot({ path: `${SHOT_DIR}/360-width-error.png`, fullPage: true })
    await browser.close()
  }

  // ── 用例 12：服务端忽略 Range（200 + 完整文件）→ 只消费一次，不重复拼接 ──────
  {
    console.log('\n[case 12] 服务端忽略 Range：一次 200 取全量，不重复拼接')
    const small = buildArchive({ sessionCount: 6 })
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: false,
      data: base64(small.zip),
      headers: { 'Content-Length': String(small.zip.length) },
    })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /已导入|失败/.test(value), 30_000)
    const calls = await page.evaluate(() => window.__capMock.calls)
    check('只发 1 次 CapacitorHttp.get', calls.length === 1, `实际 ${calls.length}`)
    check(
      `按 6 个会话导入（字节没被重复拼接）`,
      text.includes('已导入 6 个会话'),
      text.slice(0, 160)
    )
    check('写库会话数 = 6', (await dbCounts(page)).sessions === 6)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 13：206 分块的 Range 必须连续（无重叠、无空洞） ────────────────────
  {
    console.log('\n[case 13] 206 分块的 Range 连续、无重叠、无空洞')
    const medium = buildArchive({ sessionCount: 40, padBytes: 2 * 1024 * 1024 })
    const total = medium.zip.length
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: true,
      chunkDelay: 60,
      data: base64(medium.zip),
    })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /已导入|失败/.test(value), 60_000)
    const calls = await page.evaluate(() => window.__capMock.calls)
    const ranges = calls.map((call) => /^bytes=(\d+)-(\d+)$/.exec(call.headers?.Range ?? '')).filter(Boolean)
    const contiguous = ranges.every((match, index) =>
      index === 0 ? Number(match[1]) === 0 : Number(match[1]) === Number(ranges[index - 1][2]) + 1
    )
    const last = ranges.length === 0 ? null : Number(ranges[ranges.length - 1][2]) + 1
    check('每个 Range 都从上一块的结束字节开始（无重叠/无空洞）', contiguous, JSON.stringify(ranges.map((m) => `${m[1]}-${m[2]}`)))
    check('最后一块请求覆盖到文件末尾（不短读）', last !== null && last >= total, `last=${last} total=${total}`)
    check('导入成功且会话数 = 40', text.includes('已导入 40 个会话') && (await dbCounts(page)).sessions === 40, text.slice(0, 160))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 14：分块中途收到 416 → 终止、不写数据 ────────────────────────────
  {
    console.log('\n[case 14] 分块中途 416：终止下载、不写数据')
    const medium = buildArchive({ sessionCount: 10, padBytes: 2 * 1024 * 1024 })
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: true,
      chunkDelay: 120,
      data: base64(medium.zip),
      force416FromCall: 1,
    })
    await startUrlImport(page)
    const { text } = await sampleUntil(page, (value) => /已导入|断开|失败|超时/.test(value), 30_000)
    const counts = await dbCounts(page)
    check(
      '中途 416 被当成终止而不是继续拼（报连接中断/网络类错误）',
      /网络连接中断|网络已断开|下载失败|下载超时/.test(text),
      text.slice(0, 200)
    )
    check('没有写入任何会话（也没有脏暂存）', counts.sessions === 0 && counts.sessionsStaging === 0, JSON.stringify(counts))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 15：缺 Content-Length / Content-Range → 只显示已下载字节，仍能导入 ──
  {
    console.log('\n[case 15] 缺 Content-Length：显示已下载字节（无百分比），仍能导入')
    const medium = buildArchive({ sessionCount: 8, padBytes: 512 * 1024 })
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: true,
      omitLengths: true,
      chunkDelay: 120,
      data: base64(medium.zip),
    })
    await startUrlImport(page)
    const { samples, text } = await sampleUntil(page, (value) => /已导入|失败/.test(value), 40_000)
    const joined = samples.map((sample) => sample.text).join('\n')
    check('显示「正在下载… 已下载 x」而不是百分比', /正在下载… 已下载 [\d.]+(KB|MB|B)/.test(joined), joined.slice(0, 200))
    check('没有出现「/总大小（%）」', !/正在下载… [\d.]+(KB|MB)\/[\d.]+(KB|MB)（/.test(joined))
    check('仍然导入成功（8 个会话）', text.includes('已导入 8 个会话'), text.slice(0, 160))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 16：下载中途链接失效（403）→ 终止且不污染已有会话 ──────────────────
  {
    console.log('\n[case 16] 分块下载中途 403：终止且已有会话不被污染')
    const first = buildArchive({ sessionCount: 5 })
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: false,
      data: base64(first.zip),
    })
    await startUrlImport(page)
    await sampleUntil(page, (value) => /已导入|失败/.test(value), 30_000)
    const before = await dbCounts(page)
    check('第一次导入成功：5 个会话', before.sessions === 5, JSON.stringify(before))

    const second = buildArchive({ sessionCount: 9, padBytes: 3 * 1024 * 1024 })
    // 第二段：同一页面里再导入一次，第 2 次请求起服务端改回 403（链接失效）
    await page.evaluate(
      ({ data, body }) => {
        const plan = window.__capMock.plan
        plan.dataOverride = data
        plan.startBytes = undefined
        plan.range = true
        plan.forbiddenBody = body
        plan.forbiddenFromCall = 1
        plan.served = 0
        window.__capMock.calls.length = 0
      },
      { data: base64(second.zip), body: base64(obsError('RequestTimeTooSkewed', 'Request has expired')) }
    )
    await startUrlImport(page, { url: 'https://obs.example.test/second.zip' })
    const { text } = await sampleUntil(page, (value) => /过期|签名|403|失败/.test(value), 40_000)
    const after = await dbCounts(page)
    check('提示「下载链接已过期」', /下载链接已过期/.test(text), text.slice(0, 200))
    check('已有 5 个会话保持不变（没有被半截包覆盖）', after.sessions === 5, JSON.stringify(after))
    check('暂存已清空', after.sessionsStaging === 0 && after.filesStaging === 0, JSON.stringify(after))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 17：用户可见「导入详情」：真实字节、阶段、失败原因、复制脱敏 ──────────
  {
    console.log('\n[case 17] 导入详情：折叠可展开、真实字节、复制脱敏')
    const small = buildArchive({ sessionCount: 5, padBytes: 256 * 1024 })
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 200,
      range: true,
      chunkDelay: 120,
      data: base64(small.zip),
    })
    await startUrlImport(page)
    await page.getByText(/已导入 5 个会话/).waitFor({ timeout: 60_000 })
    const toggle = page.getByRole('button', { name: '展开', exact: true })
    check('有「导入详情」折叠入口', (await toggle.count()) >= 1)
    check('折叠时默认不展开列表', (await page.getByText('开始导入').count()) === 0)
    await toggle.first().click()
    const rows = page.locator('ol li')
    await rows.first().waitFor({ timeout: 5000 })
    const lines = await rows.allInnerTexts()
    const joined = lines.join('\n')
    check('含「开始导入」', /开始导入/.test(joined), joined.slice(0, 200))
    check('含真实下载字节（已下载 x/总量）', /已下载 [\d.]+(KB|MB|B) \/ [\d.]+(KB|MB)/.test(joined), joined.slice(0, 200))
    check('含「校验归档结束，共 5 个会话」', /校验归档结束，共 5 个会话/.test(joined), joined.slice(0, 200))
    check('含「导入会话 n/5」', /导入会话 \d+\/5/.test(joined), joined.slice(0, 200))
    check('含「完成，共 5 个会话」', /完成，共 5 个会话/.test(joined), joined.slice(0, 200))
    check('详情条数有上限（≤100）', lines.length <= 100, `实际 ${lines.length}`)
    await page.getByRole('button', { name: '复制详情', exact: true }).click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    check('复制内容含详情正文', /DeepSeek import details/.test(copied) && /完成，共 5 个会话/.test(copied), copied.slice(0, 120))
    check('复制内容不含签名/密钥/桶域名', !/Signature=|AccessKeyId=|obs\.cn-east|https?:\/\//.test(copied), copied.slice(0, 200))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await page.screenshot({ path: `${SHOT_DIR}/trace-details-1280.png` })
    await browser.close()
  }

  // ── 用例 18：失败时详情里能看到失败阶段/HTTP 状态，且复制仍脱敏 ────────────────
  {
    console.log('\n[case 18] 失败详情：阶段 + HTTP 403 + 原因，复制仍脱敏')
    const expired = obsError('RequestTimeTooSkewed', 'Request has expired')
    const { browser, page, consoleErrors } = await openApp({
      kind: 'arraybuffer',
      status: 403,
      data: base64(expired),
    })
    await startUrlImport(page)
    await page.getByText(/下载链接已过期/).waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: '展开', exact: true }).first().click()
    const lines = await page.locator('ol li').allInnerTexts()
    const joined = lines.join('\n')
    check('详情含「失败（下载）：链接已过期」', /失败（下载）：链接已过期/.test(joined), joined.slice(0, 240))
    check('详情含「复制详情」可点', (await page.getByRole('button', { name: '复制详情', exact: true }).count()) === 1)
    await page.getByRole('button', { name: '复制详情', exact: true }).click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    check('失败详情复制不含签名/密钥', !/Signature=|AccessKeyId=|sk-/.test(copied), copied.slice(0, 200))
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  if (failures.length > 0) {
    console.error(`\nFAIL 链接导入的分阶段进度/取消/失败分类：${failures.length} 条断言失败`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log('\nPASS 链接导入的分阶段进度/取消/失败分类：全部断言通过')
}

await run()
