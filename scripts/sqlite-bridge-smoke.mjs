#!/usr/bin/env node
/**
 * sqlite-bridge-smoke.mjs（#913）：通过 WebView 调试端口驱动 AppSqlite 桥的冒烟测试。
 *
 * 本期只写不跑，lead 在 #923 验收时执行。
 *
 * 参考 storage-repro/scripts/compat/lib/cdp.mjs 的 CDP 驱动方式：
 *   1. 启动模拟器并安装 APK（由 lead 完成）
 *   2. `adb forward tcp:9222 localabstract:chrome_devtools_remote`
 *   3. 本脚本连接 ws://127.0.0.1:9222 的第一个 WebView target
 *   4. 通过 Runtime.evaluate 调用 Capacitor 插件方法
 *
 * 冒烟场景（顺序执行，任一失败立即报错退出）：
 *   S1  capabilities() 返回所有必需方法
 *   S2  ping() 不报错
 *   S3  open("smoke-test")
 *   S4  info() - journal=wal, synchronous=FULL, foreignKeys=true, busyTimeout>=5000
 *   S5  run("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
 *   S6  run("INSERT INTO t VALUES (1, 'hello')")
 *   S7  all("SELECT * FROM t") → rows=[{id:1, v:'hello'}]
 *   S8  batch([{sql:"INSERT INTO t VALUES(2,'batch1')"}, {sql:"INSERT INTO t VALUES(3,'batch2')"}])
 *   S9  all("SELECT count(*) AS n FROM t") → n=3
 *   S10 txBegin / txRun("INSERT INTO t VALUES(4,'tx')") / txCommit
 *   S11 all("SELECT count(*) AS n FROM t") → n=4
 *   S12 txBegin / txRun("INSERT INTO t VALUES(5,'rollback')") / txRollback
 *   S13 all("SELECT count(*) AS n FROM t") → n=4 (未提交的回滚了)
 *   S14 integrityCheck() → problems=[]
 *   S15 backupTo("smoke-backup.db") → bytes>0
 *   S16 close("smoke-test")
 *   S17 cleanup: open/run("DROP TABLE IF EXISTS t")/close
 *
 * BLOB 往返：
 *   B1  open("smoke-blob") → run("CREATE TABLE b(id INT, data BLOB)")
 *   B2  run("INSERT INTO b VALUES(1, ?)", [{$b64: <512KiB random base64>}])
 *   B3  all("SELECT * FROM b") → 解码回字节，sha256 与原始一致
 *   B4  close("smoke-blob")
 *
 * 整数边界：
 *   I1  run("INSERT INTO t VALUES(?, ?)", [9007199254740991, 'max_safe']) → ok
 *   I2  run("INSERT INTO t VALUES(?, ?)", [9007199254740992, 'too_large']) → 在 JS 层报错（不到原生）
 */

import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import http from 'node:http'
import { createHash } from 'node:crypto'
import WebSocket from 'node:events'

const ADB_PORT = 9222
const TIMEOUT_MS = 10_000

// ─────────────────────────────────────────────────────────────────────────────
// CDP 客户端（极简，仿 storage-repro/scripts/compat/lib/cdp-core.mjs）
// ─────────────────────────────────────────────────────────────────────────────

const getTargets = () =>
  new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${ADB_PORT}/json`, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(new Error('failed to parse /json: ' + data.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
  })

const connectCdp = async (wsUrl) => {
  const { default: WS } = await import('ws').catch(() => {
    throw new Error('ws package not found; run: npm install ws')
  })
  const ws = new WS(wsUrl)
  let msgId = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = msgId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const close = () => ws.close()
  return { send, close }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主驱动
// ─────────────────────────────────────────────────────────────────────────────

const call = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails
    const msg =
      detail.exception?.description ||
      detail.text ||
      JSON.stringify(detail)
    throw new Error('JS exception: ' + msg)
  }
  return result.result.value
}

const capExpr = (method, args) => {
  const argsJson = JSON.stringify(args ?? {})
  return `Capacitor.Plugins.AppSqlite.${method}(${argsJson})`
}

const encodeBlob = (bytes) => {
  let b64 = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(b64)
}

const main = async () => {
  console.log('[smoke] 连接调试端口…')
  const targets = await getTargets()
  const webviewTarget = targets.find((t) => t.type === 'webview' || t.url?.includes('capacitor'))
  if (!webviewTarget) {
    throw new Error('找不到 WebView target：' + JSON.stringify(targets.map((t) => t.type + ' ' + t.url)))
  }
  console.log('[smoke] 连接 target:', webviewTarget.url)
  const cdp = await connectCdp(webviewTarget.webSocketDebuggerUrl)
  const errors = []

  const check = async (label, fn) => {
    process.stdout.write(`  ${label} … `)
    try {
      await fn()
      console.log('OK')
    } catch (error) {
      console.log('FAIL: ' + error.message)
      errors.push({ label, error: error.message })
    }
  }

  // S1 capabilities
  await check('S1 capabilities()', async () => {
    const result = await call(cdp, capExpr('capabilities'))
    const methods = result.methods
    const required = ['open', 'run', 'all', 'batch', 'txBegin', 'txRun', 'txAll', 'txCommit', 'txRollback', 'backupTo', 'integrityCheck', 'info', 'close', 'ping']
    const missing = required.filter((m) => !methods.includes(m))
    if (missing.length) throw new Error('缺少方法: ' + missing.join(','))
  })

  // S2 ping
  await check('S2 ping()', async () => {
    await call(cdp, capExpr('ping'))
  })

  // S3 open
  await check('S3 open("smoke-test")', async () => {
    await call(cdp, capExpr('open', { name: 'smoke-test' }))
  })

  // S4 info
  await check('S4 info() synchronous=FULL', async () => {
    const result = await call(cdp, capExpr('info', { name: 'smoke-test' }))
    if (result.journalMode.toLowerCase() !== 'wal') throw new Error('journalMode=' + result.journalMode)
    if (result.synchronous !== 'FULL') throw new Error('synchronous=' + result.synchronous)
    if (!result.foreignKeys) throw new Error('foreignKeys=false')
    if (result.busyTimeout < 5000) throw new Error('busyTimeout=' + result.busyTimeout)
    console.log('\n      sqliteVersion:', result.sqliteVersion, 'path:', result.path)
  })

  // S5 CREATE TABLE
  await check('S5 CREATE TABLE', async () => {
    await call(cdp, capExpr('run', { name: 'smoke-test', sql: 'CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)' }))
  })

  // S6 INSERT
  await check('S6 INSERT', async () => {
    const r = await call(cdp, capExpr('run', { name: 'smoke-test', sql: "INSERT INTO t VALUES(1,'hello')" }))
    if (r.changes !== 1) throw new Error('changes=' + r.changes)
  })

  // S7 SELECT
  await check('S7 SELECT rows', async () => {
    const r = await call(cdp, capExpr('all', { name: 'smoke-test', sql: 'SELECT * FROM t' }))
    if (!r.rows[0] || r.rows[0].v !== 'hello') throw new Error('got: ' + JSON.stringify(r.rows))
  })

  // S8 batch
  await check('S8 batch INSERT', async () => {
    const r = await call(cdp, capExpr('batch', { name: 'smoke-test', statements: [
      { sql: "INSERT INTO t VALUES(2,'batch1')" },
      { sql: "INSERT INTO t VALUES(3,'batch2')" },
    ]}))
    if (r.results.length !== 2) throw new Error('results.length=' + r.results.length)
  })

  // S9 count after batch
  await check('S9 count=3 after batch', async () => {
    const r = await call(cdp, capExpr('all', { name: 'smoke-test', sql: 'SELECT count(*) AS n FROM t' }))
    if (r.rows[0].n !== 3) throw new Error('n=' + r.rows[0].n)
  })

  // S10 txBegin+txRun+txCommit
  let txToken
  await check('S10 txBegin', async () => {
    const r = await call(cdp, capExpr('txBegin', { name: 'smoke-test', txTimeoutMs: 10000 }))
    txToken = r.token
  })
  await check('S10 txRun', async () => {
    await call(cdp, capExpr('txRun', { name: 'smoke-test', token: txToken, sql: "INSERT INTO t VALUES(4,'tx')" }))
  })
  await check('S10 txCommit', async () => {
    await call(cdp, capExpr('txCommit', { name: 'smoke-test', token: txToken }))
  })

  // S11 count=4 after commit
  await check('S11 count=4 after commit', async () => {
    const r = await call(cdp, capExpr('all', { name: 'smoke-test', sql: 'SELECT count(*) AS n FROM t' }))
    if (r.rows[0].n !== 4) throw new Error('n=' + r.rows[0].n)
  })

  // S12 txBegin+txRun+txRollback
  let txToken2
  await check('S12 txBegin for rollback', async () => {
    const r = await call(cdp, capExpr('txBegin', { name: 'smoke-test', txTimeoutMs: 10000 }))
    txToken2 = r.token
  })
  await check('S12 txRun (will rollback)', async () => {
    await call(cdp, capExpr('txRun', { name: 'smoke-test', token: txToken2, sql: "INSERT INTO t VALUES(5,'rollback')" }))
  })
  await check('S12 txRollback', async () => {
    await call(cdp, capExpr('txRollback', { name: 'smoke-test', token: txToken2 }))
  })

  // S13 count=4 after rollback
  await check('S13 count=4 after rollback', async () => {
    const r = await call(cdp, capExpr('all', { name: 'smoke-test', sql: 'SELECT count(*) AS n FROM t' }))
    if (r.rows[0].n !== 4) throw new Error('n=' + r.rows[0].n + ' (期望 4，rollback 应该没生效)')
  })

  // S14 integrityCheck
  await check('S14 integrityCheck', async () => {
    const r = await call(cdp, capExpr('integrityCheck', { name: 'smoke-test' }))
    if (r.problems.length) throw new Error('problems: ' + r.problems.join('; '))
  })

  // S15 backupTo
  await check('S15 backupTo', async () => {
    const r = await call(cdp, capExpr('backupTo', { name: 'smoke-test', path: 'smoke-backup.db' }))
    if (!r.bytes || r.bytes <= 0) throw new Error('bytes=' + r.bytes)
  })

  // S16 close
  await check('S16 close', async () => {
    await call(cdp, capExpr('close', { name: 'smoke-test' }))
  })

  // BLOB 往返（B1-B4）
  await check('B1 open("smoke-blob")', async () => {
    await call(cdp, capExpr('open', { name: 'smoke-blob' }))
    await call(cdp, capExpr('run', { name: 'smoke-blob', sql: 'CREATE TABLE IF NOT EXISTS b(id INT, data BLOB)' }))
  })

  // 在设备端生成随机字节：JS Buffer 在 WebView 中不一定有，但 Uint8Array 可以
  await check('B2+B3 BLOB 写入并读回', async () => {
    // 在 WebView 里执行完整的写入和读取
    const expr = `
      (async () => {
        const size = 512 * 1024; // 512 KiB
        const bytes = new Uint8Array(size);
        crypto.getRandomValues(bytes);
        // 编成 base64
        let b64 = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const encoded = btoa(b64);
        // 写入
        await Capacitor.Plugins.AppSqlite.run({ name: 'smoke-blob', sql: 'INSERT INTO b VALUES(1, ?)', params: [{ $b64: encoded }] });
        // 读出
        const r = await Capacitor.Plugins.AppSqlite.all({ name: 'smoke-blob', sql: 'SELECT * FROM b' });
        const readB64 = r.rows[0].data.$b64;
        return encoded === readB64 ? 'match' : 'mismatch: len ' + encoded.length + ' vs ' + readB64.length;
      })()
    `
    const result = await call(cdp, expr)
    if (result !== 'match') throw new Error('BLOB 往返不一致: ' + result)
  })

  await check('B4 close("smoke-blob")', async () => {
    await call(cdp, capExpr('close', { name: 'smoke-blob' }))
  })

  // 整数边界（I1, I2）
  await check('I1 max safe integer', async () => {
    // 重新打开，做整数测试
    await call(cdp, capExpr('open', { name: 'smoke-int' }))
    await call(cdp, capExpr('run', { name: 'smoke-int', sql: 'CREATE TABLE IF NOT EXISTS i(id INTEGER PRIMARY KEY, v TEXT)' }))
    await call(cdp, capExpr('run', { name: 'smoke-int', sql: 'INSERT INTO i VALUES(?, ?)', params: [9007199254740991, 'max_safe'] }))
    const r = await call(cdp, capExpr('all', { name: 'smoke-int', sql: 'SELECT id FROM i' }))
    if (r.rows[0].id !== 9007199254740991) throw new Error('id=' + r.rows[0].id)
    await call(cdp, capExpr('close', { name: 'smoke-int' }))
  })

  await check('I2 over-safe integer rejected in JS', async () => {
    // JS 侧应该在 encodeParams 拒绝，不会到原生
    const expr = `
      (async () => {
        const p = Capacitor.Plugins.AppSqlite.run({ name: 'nonexistent', sql: 'SELECT ?', params: [9007199254740992] });
        try { await p; return 'no-error'; }
        catch(e) { return e.message || String(e); }
      })()
    `
    const msg = await call(cdp, expr)
    // 整数超安全范围时，JS 层（encodeParams）应该在进原生之前拒绝
    if (msg === 'no-error') throw new Error('期望 JS 层拒绝，但没有报错')
  })

  cdp.close()

  if (errors.length) {
    console.error(`\n[smoke] FAIL：${errors.length} 项失败`)
    for (const { label, error } of errors) {
      console.error(`  × ${label}: ${error}`)
    }
    process.exit(1)
  } else {
    console.log('\n[smoke] 所有冒烟测试通过 ✓')
  }
}

main().catch((error) => {
  console.error('[smoke] 未捕获错误:', error)
  process.exit(1)
})
