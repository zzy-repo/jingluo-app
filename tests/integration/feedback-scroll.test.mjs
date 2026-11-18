// Focused real Chromium touch regression; CSS/keyboard capability simulations are not an old WebView.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const out = new URL('../../docs/ui/feedback-scroll/', import.meta.url).pathname
await mkdir(out, { recursive: true })
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
// 产物目录可注入（默认用标准产物 dist-standard；原写法写死 dist-scroll，而没有任何流程产出它），
// 端口交给 serveDir 自动分配（原写死 5418）
const scrollDist = process.env.DIST_DIR_STANDARD || process.env.DIST_DIR || 'dist-standard'
const served = await serveDir(scrollDist, { port: process.env.PORT, label: 'dist-scroll 产物' })
await verifyAppUrl(served.url, scrollDist, { variant: 'standard' })
const browser = await chromium.launch({ headless:true })
const results = []
const baseline = process.env.BASELINE === '1'
try {
 for (const [width,height,scale,legacy,keyboard] of [[360,640,1,false,false],[360,780,1.3,false,false],[393,851,1.5,false,false],[360,640,1.5,true,false],[360,640,1.5,false,true]]) {
  const context = await browser.newContext({ viewport:{width,height}, isMobile:true, hasTouch:true, locale:'zh-CN', reducedMotion:'reduce' })
  await context.addInitScript(() => localStorage.setItem('chat-demo:api-key','sk-scroll-local-fixture'))
  const page = await context.newPage()
  await page.goto(`${served.url}/?diag-debug`)
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
  const before=await metrics()
  const name=`${width}x${height}-${scale}${legacy?'-no-dvh':''}${keyboard?'-keyboard':''}`
  await page.screenshot({path:out+`${baseline?'before':'after'}-${name}-top.png`})
  for(let i=0;i<16;i++) await swipe()
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
   for(let i=0;i<24;i++) await swipe()
   assert((await metrics()).scrollHeight-(await metrics()).clientHeight-(await metrics()).top<3,name+' expanded bottom')
  }
  await page.screenshot({path:out+`${baseline?'before':'after'}-${name}-bottom.png`})
  results.push({name,before,after,final:await metrics(),starts})
  if(!baseline) {
   await form.getByRole('button',{name:'关闭',exact:true}).tap(); await page.waitForTimeout(300)
   assert.equal(await page.getByRole('dialog').count(),1,'nested close keeps settings')
   const panel=page.getByRole('tabpanel'); const pb=await panel.evaluate(e=>e.scrollTop); await swipe(false,panel); assert((await panel.evaluate(e=>e.scrollTop))<pb,'parent settings touch restored')
   await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).tap(); await page.waitForTimeout(300); assert.equal(await page.getByRole('dialog').count(),0)
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
    await page.route('**/chat/completions',route=>route.fulfill({status:500,body:'offline'}))
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
  await context.close()
 }
} finally {await writeFile(out+(baseline?'before':'after')+'.json',JSON.stringify(results,null,2)); console.log(JSON.stringify(results.map(({name,before,after})=>({name,before,after})),null,2)); await browser.close();served.kill()}
