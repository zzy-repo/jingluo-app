// Issue #133 取证：长会话首屏耗时曲线（Android Emulator API33 / WebView 109）。
//
// 造法（报告里要写清楚）：
//   1. 用 CDP Runtime.evaluate 在页面里直接调 IndexedDB API（库名 chat-demo，版本 12，
//      store：sessions / sessionSummaries）写入「1 个大会话 + 30 个小会话」；
//      字段严格照 src/services/chat/types.ts：Session{id,title,createdAt,updatedAt,messages[]}，
//      summary 走 toSessionSummary 的同名字段 + fileIds: []。
//   2. 每条消息都是真实形态的问答：user 一段问题（含代码片段），
//      assistant 3 段正文 + 一个 ``` 代码块 + 一个有序列表，status:'done'、blocks:[{type:'text',text}]。
//   3. 写库后 Page.reload，走应用真实启动路径（initChat → loadSessionSummaries），
//      再点侧栏会话项（真实点击，dispatch click），量「点击 → 内容可见」。
//
// 度量口径（页面内 performance.now()，导航起点为 0）：
//   coldListMs  reload 到「侧栏会话项可点」（含 React 挂载 + IndexedDB 摘要读取 + 抽屉展开）
//   firstRowMs  点击会话 → 消息区出现第一个虚拟行（内容出现，loading 结束）
//   lastTextMs  点击会话 → 贴底那条最后消息的文本已经渲染出来（默认可读位置）
//   topFirstMs  滚到顶 → 首条消息（data-row-index=0）出现在 DOM
import { writeFileSync } from 'node:fs'
import { attach, shot, heap, sleep, sh, PACKAGE, OUT } from './cdp.mjs'

const SIZES = (process.env.SIZES || '200,1000,2000,4000').split(',').map(Number)
const SMALL_SESSIONS = 30
const SMALL_MESSAGES = 10

const seedSource = (total, title) => `(async () => {
  const total = ${total}
  const title = ${JSON.stringify(title)}
  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const db = await openDb()
  const clearAll = () => new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    tx.objectStore('sessions').clear()
    tx.objectStore('sessionSummaries').clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  await clearAll()

  const ANSWER = [
    '结论先给：\`useEffect\` 的依赖数组不是「什么时候执行」的开关，而是「这次渲染用到的值变了没有」的声明。',
    '第一段正文：如果依赖里漏掉了某个值，闭包里就会一直读到第一次渲染时的那份快照，于是出现「值明明更新了但界面不动」的现象。这不是 React 缓存了你的数据，而是你声明少了一项。',
    '第二段正文：清理函数在两次执行之间一定跑，卸载时也跑；所以订阅、定时器、事件监听都该在这里解绑，否则长会话里反复切会话很容易叠加出多份。',
    '第三段正文：真的需要「只在挂载时执行一次」时，明确写空依赖并加注释说明为什么其他值可以读到旧快照；不要为了消掉 lint 警告而把依赖塞满。',
  ].join('\\n\\n')
  const CODE = '\\n\\n\`\`\`ts\\n' + [
    'useEffect(() => {',
    '  const timer = setInterval(() => setTick((value) => value + 1), 1000)',
    '  return () => clearInterval(timer)',
    '}, [])',
  ].join('\\n') + '\\n\`\`\`'
  const LIST = '\\n\\n1. 先看依赖数组里有没有漏项\\n2. 再看闭包读的是不是旧快照\\n3. 最后确认清理函数有没有真的跑\\n'

  const sessions = []
  const messages = []
  const base = Date.now() - total * 60_000
  for (let index = 0; index < total; index += 1) {
    const round = Math.floor(index / 2) + 1
    if (index % 2 === 0) {
      messages.push({
        id: 'big-u' + index,
        role: 'user',
        content: '第 ' + round + ' 轮：这段 useEffect 为什么每次渲染都重新订阅？\\n\\n\`\`\`tsx\\nuseEffect(() => {\\n  subscribe(roomId)\\n}, [roomId, filter])\\n\`\`\`',
        files: [],
        createdAt: base + index * 60_000,
      })
    } else {
      messages.push({
        id: 'big-a' + index,
        role: 'assistant',
        createdAt: base + index * 60_000,
        model: 'probe-model',
        prefix: false,
        status: 'done',
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: '第 ' + round + ' 轮回答。\\n\\n' + ANSWER + CODE + LIST }],
      })
    }
  }
  const big = {
    id: 'fact133-big',
    title: title,
    createdAt: base,
    updatedAt: Date.now(),
    messages: messages,
  }
  sessions.push(big)
  for (let index = 1; index <= ${SMALL_SESSIONS}; index += 1) {
    const smallMessages = []
    for (let slot = 0; slot < ${SMALL_MESSAGES}; slot += 1) {
      const at = base + slot * 1000
      smallMessages.push(slot % 2 === 0
        ? { id: 's' + index + '-u' + slot, role: 'user', content: '小会话 ' + index + ' 第 ' + slot + ' 问', files: [], createdAt: at }
        : { id: 's' + index + '-a' + slot, role: 'assistant', createdAt: at, model: 'probe-model', prefix: false, status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text: '小会话 ' + index + ' 第 ' + slot + ' 答' }] })
    }
    sessions.push({
      id: 'fact133-small-' + index,
      title: '小会话 ' + index,
      createdAt: base,
      updatedAt: Date.now() - index * 1000,
      messages: smallMessages,
    })
  }

  for (const session of sessions) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        fileIds: [],
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
  return { sessions: sessions.length, messages: total, approxBytes: Math.round(JSON.stringify(sessions).length) }
})()`

const measureSource = (title, total) => `(async () => {
  const title = ${JSON.stringify(title)}
  const total = ${total}
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const deadline = performance.now() + 120000
  const findHost = () => {
    const queue = [document.body]
    let best = null
    while (queue.length) {
      const element = queue.shift()
      const overflow = getComputedStyle(element).overflowY
      if (/(auto|scroll|overlay)/.test(overflow) && element.scrollHeight - element.clientHeight > 0) {
        if (!best || element.scrollHeight > best.scrollHeight) best = element
      }
      for (const child of element.children) queue.push(child)
    }
    return best
  }

  // 打开移动端抽屉，点会话项（优先点标题文本所在的 div，事件冒泡到 SessionItem 的 onClick）
  const menu = [...document.querySelectorAll('button[aria-label]')].find((node) =>
    node.getAttribute('aria-label') && !node.closest('[role="dialog"]')
  )
  if (!menu) return { error: '找不到菜单按钮' }
  menu.click()
  let target = null
  while (performance.now() < deadline) {
    await frame()
    target = [...document.querySelectorAll('div')].find((node) => node.children.length === 0 && node.textContent.trim() === title)
    if (target) break
  }
  if (!target) return { error: '抽屉里没有目标会话' }
  await frame()

  const t0 = performance.now()
  target.click()
  let firstRowMs = null
  let lastTextMs = null
  while (performance.now() < deadline) {
    await frame()
    const rows = document.querySelectorAll('[data-row-id]')
    if (firstRowMs === null && rows.length > 0) firstRowMs = performance.now() - t0
    const last = document.querySelector('[data-row-index="' + (total - 1) + '"]')
    if (last && last.textContent.trim().length > 0) {
      lastTextMs = performance.now() - t0
      break
    }
  }
  const host = findHost()
  const hostInfo = host
    ? { scrollHeight: host.scrollHeight, clientHeight: host.clientHeight, scrollTop: host.scrollTop }
    : null
  const rowsAfterOpen = document.querySelectorAll('[data-row-id]').length

  // 回到首条消息：走产品自己的入口（Issue #106「双击标题」→ scrollToFirstMessage 逐帧插值到 0），
  // 量「双击 → 首条消息（data-row-index=0）出现在 DOM」。含 220~600ms 的动画时长。
  let topFirstMs = null
  const titleButton = [...document.querySelectorAll('button[aria-label]')].find((node) =>
    /回到首条|first message/i.test(node.getAttribute('aria-label') || '')
  )
  if (titleButton) {
    const t1 = performance.now()
    titleButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    while (performance.now() < deadline) {
      await frame()
      if (document.querySelector('[data-row-index="0"]')) {
        topFirstMs = performance.now() - t1
        break
      }
    }
  }
  // 再滚回底部，确认贴底仍然正常
  if (host) host.scrollTop = host.scrollHeight
  await frame()
  await frame()
  const rowsAfterTop = document.querySelectorAll('[data-row-id]').length
  return {
    firstRowMs: firstRowMs === null ? null : Math.round(firstRowMs),
    lastTextMs: lastTextMs === null ? null : Math.round(lastTextMs),
    topFirstMs: topFirstMs === null ? null : Math.round(topFirstMs),
    hostInfo,
    rowsAfterOpen,
    rowsAfterTop,
    domNodes: document.querySelectorAll('*').length,
    messageRowsTotal: total,
  }
})()`

const openApp = () => {
  sh('shell', 'am', 'force-stop', PACKAGE)
  sh('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
}

const main = async () => {
  const { cdp } = await attach()
  const results = []

  // 先配好渠道（避免首启弹 API Key 对话框挡住点击），指向本地整形服务
  await cdp.evaluate(`(() => {
    localStorage.setItem('chat-demo:provider-kind', 'openai')
    localStorage.setItem('chat-demo:api-key', 'sk-probe')
    localStorage.setItem('chat-demo:base-url:openai', 'http://10.0.2.2:5399/ok')
    localStorage.setItem('chat-demo:model:openai', 'probe-model')
    return Object.keys(localStorage)
  })()`)

  for (const total of SIZES) {
    const title = `会话 ${total} 条`
    console.log(`\n=== 规模 ${total} 条消息（${total / 2} 轮）===`)
    const seeded = await cdp.evaluate(seedSource(total, title))
    console.log('  写入 IndexedDB:', JSON.stringify(seeded))

    const reloadStarted = Date.now()
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(200)
    // 冷启动：等 App 就绪 -> 打开抽屉 -> 会话项出现
    const cold = await cdp.evaluate(`(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const deadline = performance.now() + 60000
      let menu = null
      while (performance.now() < deadline) {
        await frame()
        if (document.querySelector('[role="status"]')) continue
        menu = [...document.querySelectorAll('button[aria-label]')].find((node) => !node.closest('[role="dialog"]'))
        if (menu) break
      }
      const readyAt = performance.now()
      if (!menu) return { error: 'App 没就绪', readyAt }
      menu.click()
      while (performance.now() < deadline) {
        await frame()
        if (document.body.innerText.includes(${JSON.stringify(title)})) break
      }
      return { readyAt: Math.round(readyAt), listReadyAt: Math.round(performance.now()), navigationType: String(performance.getEntriesByType('navigation')[0]?.type) }
    })()`)
    console.log('  冷启动:', JSON.stringify(cold), `(host 侧 reload 至今 ${Date.now() - reloadStarted}ms)`)

    const measured = await cdp.evaluate(measureSource(title, total))
    const memory = await heap(cdp)
    const meminfo = sh('shell', 'dumpsys', 'meminfo', PACKAGE).split('\n')
    const totalPss = meminfo.find((line) => line.includes('TOTAL PSS'))?.trim() ?? ''
    const javaHeap = meminfo.find((line) => line.trim().startsWith('Java Heap:'))?.trim() ?? ''
    console.log('  打开耗时:', JSON.stringify(measured))
    console.log('  JS 堆:', JSON.stringify(memory), '|', javaHeap, '|', totalPss)

    const bottomShot = await shot(cdp, `133-long-${total}-bottom-360dp`)
    // 回到首条后截图（走产品自己的双击标题入口）
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button[aria-label]')].find((node) =>
        /回到首条|first message/i.test(node.getAttribute('aria-label') || '')
      )
      if (!button) return false
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)
    const topShot = await shot(cdp, `133-long-${total}-top-360dp`)

    results.push({ total, rounds: total / 2, cold, measured, jsHeapMB: memory.usedMB, javaHeap, totalPss, seeded, shots: [bottomShot, topShot] })
    console.log('  截图:', bottomShot, topShot)
  }

  writeFileSync(`${OUT}firstscreen-results.json`, JSON.stringify(results, null, 2))
  console.log('\n结果写入 firstscreen-results.json')
  cdp.close()
}

main().catch((error) => {
  console.error('失败:', error)
  process.exit(1)
})
