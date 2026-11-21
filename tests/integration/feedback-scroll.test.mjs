// Focused real Chromium touch regression; CSS/keyboard capability simulations are not an old WebView.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { withStubbedBackends } from '../helpers/golden.mjs'
// 路径一律走 fileURLToPath：Windows 下 pathname 是 /D:/... （前导斜杠 + 盘符），拼出来会变成 D:\D:\...
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const out = fileURLToPath(new URL('../../docs/ui/feedback-scroll/', import.meta.url))
await mkdir(out, { recursive: true })
// 产物目录与端口都可覆盖（默认保持 dist-scroll / 5418）；端口被占用时自动挑空闲端口。
const DIST_DIR = path.resolve(ROOT, process.env.SCROLL_DIST_DIR || 'dist-scroll')
const PREFERRED_PORT = Number(process.env.SCROLL_PORT || 5418)
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.woff2':'font/woff2', '.map':'application/json; charset=utf-8', '.txt':'text/plain; charset=utf-8' }
const staticServer = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://127.0.0.1')
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const file = path.resolve(DIST_DIR, '.' + rel)
    if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) { res.writeHead(403).end('forbidden'); return }
    const info = await stat(file).catch(() => null)
    if (!info || !info.isFile()) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': info.size })
    createReadStream(file).pipe(res)
  } catch (error) { res.writeHead(500).end(String(error)) }
})
const listening = (server, port) => new Promise((resolve, reject) => {
  const onError = (error) => { server.off('listening', onListening); reject(error) }
  const onListening = () => { server.off('error', onError); resolve(server.address().port) }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port, '127.0.0.1')
})
// 忘了建产物就直说，别让它表现成「连不上端口」。
if (!(await stat(DIST_DIR).catch(() => null))) {
  throw new Error(`静态产物目录不存在：${DIST_DIR}\n先构建：DIST_OUT=${path.basename(DIST_DIR)} NODE_ENV=production npx rspack build -c rspack.config.ts\n或用 SCROLL_DIST_DIR 指向已构建的目录。`)
}
let port
try {
  port = await listening(staticServer, PREFERRED_PORT)
} catch (error) {
  if (error.code !== 'EADDRINUSE') throw error
  port = await listening(staticServer, 0)
  console.log(`端口 ${PREFERRED_PORT} 已被占用，自动改用空闲端口 ${port}`)
}
const server = staticServer
const BASE_URL = `http://127.0.0.1:${port}`
console.log(`静态服务：${DIST_DIR} → ${BASE_URL}`)
const browser = await chromium.launch({ headless:true })
const results = []
const baseline = process.env.BASELINE === '1'
try {
 for (const [width,height,scale,legacy,keyboard] of [[360,640,1,false,false],[360,780,1.3,false,false],[393,851,1.5,false,false],[360,640,1.5,true,false],[360,640,1.5,false,true]]) {
  const context = await browser.newContext({ viewport:{width,height}, isMobile:true, hasTouch:true, locale:'zh-CN', reducedMotion:'reduce' })
  await context.addInitScript(() => localStorage.setItem('chat-demo:api-key','sk-scroll-local-fixture'))
  const page = await context.newPage()
  /**
   * #673：出站总闸 + 上游桩，**都在打开页面之前**装上。
   * 改前这里只有一条 glob 桩（`**` + `/chat/completions`），而本用例种的是 DeepSeek 官方渠道的 Key，
   * 官方协议打的是 `/anthropic/v1/messages` —— 那条桩从来没命中过，3 次发送是**真打到生产**
   * api.deepseek.com 的（实测 3 次 CONNECT api.deepseek.com:443）。现在按 host + path 打桩，
   * 并在每轮收尾断言「漏出 = 0」。
   */
  const guard = await withStubbedBackends(page, { appUrl: BASE_URL, allowLoopback: true })
  guard.stub({
    name: 'deepseek-anthropic-messages',
    host: 'api.deepseek.com',
    path: /^\/anthropic\/v1\/messages$/,
    method: 'POST',
    respond: () => ({ status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'offline' }),
  })
  await page.goto(`${BASE_URL}/?diag-debug`)
  await page.waitForFunction(() => !!window.__diagnostics)
  await page.evaluate(() => { for(let i=0;i<30;i++) window.__diagnostics.recordError('scroll regression log '+i); window.__diagnostics.setFeedbackTransport({name:'offline',send:async()=>({ok:false,error:'network'})}) })
  const baseOverflow=await page.evaluate(()=>getComputedStyle(document.body).overflow)
  if (!await page.getByRole('dialog').count()) { await page.getByRole('button',{name:/边栏|菜单|sidebar|menu/i}).first().tap(); await page.getByRole('button',{name:/设置|Settings/}).last().tap() }
  await page.getByRole('tab',{name:/数据管理|Data/}).tap()
  await page.getByRole('button',{name:'写反馈',exact:true}).tap()
  await page.locator('#feedback-description').waitFor()
  const form = page.getByRole('dialog').last()
  await form.waitFor()
  await page.waitForTimeout(300)
  await page.evaluate(({scale,legacy}) => {
   if (legacy) { const strip = rules => { for(const rule of rules) { if(rule.style) for(const key of [...rule.style]) if(/dvh/.test(rule.style.getPropertyValue(key))) rule.style.removeProperty(key); if(rule.cssRules) strip(rule.cssRules) } }; for(const sheet of document.styleSheets) {try{strip(sheet.cssRules)}catch{}} }
   // Model Android font scaling without page zoom (all existing CSS text roles).
   const textStyles = [...document.querySelectorAll('[role="dialog"] *')].map(el=>{const s=getComputedStyle(el);return [el,parseFloat(s.fontSize),parseFloat(s.lineHeight)]})
   for(const [el,size,line] of textStyles) { el.style.fontSize=size*scale+'px'; if(Number.isFinite(line)) el.style.lineHeight=line*scale+'px' }
  }, {scale,legacy})
  if(keyboard) await page.evaluate(() => { document.querySelector('#feedback-description').focus(); Object.defineProperty(window.visualViewport,'height',{configurable:true,value:340}); window.visualViewport.dispatchEvent(new Event('resize')) })
  const cdp = await context.newCDPSession(page)
  const main = form.locator('[class*="feedbackMain"]')
  async function metrics() { return main.evaluate(el => { const d=el.closest('[role="dialog"]'); const r=d.getBoundingClientRect(); return {top:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,overflow:getComputedStyle(el).overflowY,dialogTop:r.top,dialogBottom:r.bottom,viewport:visualViewport.height,buttons:[...d.querySelectorAll('button')].filter(b=>/提交|关闭|保存日志文件/.test(b.textContent+' '+b.getAttribute('aria-label'))).map(b=>({text:b.textContent||b.getAttribute('aria-label'),y:b.getBoundingClientRect().y,bottom:b.getBoundingClientRect().bottom}))} }) }
  const starts=[]
  async function swipe(up=true, target=main) {
   const r=await target.boundingBox(); const y=Math.min(r.y+r.height-12,(keyboard?340:height)-18); const end=Math.max(r.y+12,Math.min(y-150,150)); const x=Math.max(8,r.x+8)
   starts.push(await page.evaluate(({x,y})=>{const e=document.elementFromPoint(x,y);return {x,y,element:e?.tagName,className:e?.className}}, {x,y}))
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:up?y:end}]})
   for(let i=1;i<=12;i++) {await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:up?y+(end-y)*i/12:end+(y-end)*i/12}]}); await page.waitForTimeout(17)}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await page.waitForTimeout(100)
  }
  // 滑到底为止（最多 limit 次）：键盘态下「日志预览」自己也是一个滚动容器，一次手势可能先被它吃掉，
  // 固定次数预算会随内容高度变化而不够用（#406 实测键盘态 24 次只到 1746/2079，差 333px；
  // 再滑 24 次就到底）。这里只改「滑多少次」，断言仍然是「必须能滚到底」。
  async function swipeToBottom(limit=24) {
   for(let i=0;i<limit;i++) {
    await swipe()
    const m=await metrics()
    if(m.scrollHeight-m.clientHeight-m.top<3) return i+1
   }
   return -1
  }
  // 关弹窗：先走触摸路径 tap，没关掉再补一次 click。
  // 用 CDP Input.dispatchTouchEvent 连发几十次滑动之后，渲染进程会有一段不再为 tap 合成 click
  // 的窗口（事件序列里只有 pointerdown / touchstart / touchend，没有 click，用别的按钮复现同样如此），
  // tap 于是静默落空、弹窗还挂在 DOM 上；同一个位置一次 click 就能关。这是驱动层的输入状态，
  // 不是弹窗关不掉。断言仍然卡「关掉后 dialog 必须等于 expected」，没有放宽。
  async function closeDialog(target, expected) {
   await target.tap().catch(()=>{})
   await page.waitForTimeout(300)
   if(await page.getByRole('dialog').count()!==expected) { await target.click().catch(()=>{}); await page.waitForTimeout(300) }
  }
  const before=await metrics()
  const name=`${width}x${height}-${scale}${legacy?'-no-dvh':''}${keyboard?'-keyboard':''}`
  await page.screenshot({path:out+`${baseline?'before':'after'}-${name}-top.png`})
  await swipeToBottom(16)
  const after=await metrics()
  if(!baseline) {
   assert(after.top>0, name+' touch must scroll')
   assert(after.scrollHeight-after.clientHeight-after.top<3,name+' touch reaches bottom')
   const submit=form.getByRole('button',{name:'提交',exact:true}); const box=await submit.boundingBox(); assert(box.y>=0 && box.y+box.height<=(keyboard?340:height), name+' submit reachable')
   // Expand logs and integrity, then upload image; locators can scroll for setup only.
   await form.getByRole('button',{name:/日志预览/}).tap()
   await form.getByRole('button',{name:/检查日志完整性/}).tap()
   await form.locator('input[type=file]').setInputFiles({name:'shot.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=','base64')})
   await form.locator('img').waitFor()
   for(let i=0;i<24;i++) await swipe(false)
   assert((await metrics()).top<3,name+' touch returns to export')
   await form.getByRole('button',{name:'保存日志文件',exact:true}).tap()
   await swipeToBottom(60)
   assert((await metrics()).scrollHeight-(await metrics()).clientHeight-(await metrics()).top<3,name+' expanded bottom')
  }
  await page.screenshot({path:out+`${baseline?'before':'after'}-${name}-bottom.png`})
  results.push({name,before,after,final:await metrics(),starts})
  if(!baseline) {
   await closeDialog(form.getByRole('button',{name:'关闭',exact:true}),1)
   assert.equal(await page.getByRole('dialog').count(),1,'nested close keeps settings')
   const panel=page.getByRole('tabpanel'); const pb=await panel.evaluate(e=>e.scrollTop); await swipe(false,panel); assert((await panel.evaluate(e=>e.scrollTop))<pb,'parent settings touch restored')
   await closeDialog(page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}),0); assert.equal(await page.getByRole('dialog').count(),0)
   // A tall local message exercises the app's actual main scroller, not document.body.
   if(!keyboard && !legacy) {
    // 抽屉状态在移动端不确定：先确保 sidebar 已打开，再真实点击「收起边栏」，主会话输入框才可见。
    const menu=page.getByRole('button',{name:/边栏|菜单|sidebar|menu/i}).first()
    const inputVisible=async()=>await page.locator('textarea').last().isVisible().catch(()=>false)
    if(!(await inputVisible()) && await menu.isVisible().catch(()=>false)) { await menu.tap(); await page.waitForTimeout(300) }
    const collapse=page.getByRole('button',{name:'收起边栏',exact:true})
    if(await collapse.isVisible().catch(()=>false)) { await collapse.tap(); await page.waitForTimeout(300) }
    assert(await inputVisible(),'sidebar 已收起，主会话输入框可见')
    // Modal 关闭后不得残留滚动锁（真实锁未释放则会挡住主会话触控）
    const lockState=await page.evaluate(()=>{const b=getComputedStyle(document.body);return {overflow:b.overflow,attr:document.body.hasAttribute('data-scroll-lock')}})
    assert.equal(lockState.attr,false,'Modal 关闭后 body 无 data-scroll-lock 残留')
    assert.equal(lockState.overflow,baseOverflow,'Modal 关闭后 body overflow 回到基线（无新增滚动锁）')
    await page.locator('textarea').last().fill('主页面滚动恢复验证\n'.repeat(80))
    await page.getByRole('button',{name:'发送',exact:true}).tap()
    const scroller=page.locator('[class^="scroll-"]').first()
    await scroller.waitFor(); await page.waitForTimeout(300)
    const original=await scroller.evaluate(e=>e.scrollTop)
    await swipe(false,scroller)
    const restored=await scroller.evaluate(e=>e.scrollTop)
    assert(original>0 && restored<original,'main page touch scroll restored')
    results.at(-1).mainRestored={original,restored}
   }
  }
   // #673：本轮收尾断言 —— 请求一条都不许漏出白名单
   const leaks=[]
   guard.assertNoLeak({ expect:(label,pass,{expected,actual})=>{ if(!pass) leaks.push(`${label} · 期望=${expected} · 实际=${actual}`) } })
   assert.deepEqual(leaks,[],`出站漏网：${leaks.join('；')}`)
  await context.close()
 }
} finally {await writeFile(out+(baseline?'before':'after')+'.json',JSON.stringify(results,null,2)); console.log(JSON.stringify(results.map(({name,before,after})=>({name,before,after})),null,2)); await browser.close();server.close()}
