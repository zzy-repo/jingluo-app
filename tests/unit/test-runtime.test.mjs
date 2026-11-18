import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runCase, serveDist, requireDist } from '../helpers/runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'runtime-regression-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const execute = (file, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, output }))
})

test('case success, failure, independent temp roots and cleanup', async (t) => {
  const dir = await privateRoot(t)
  const file = path.join(dir, 'fixture.mjs')
  await writeFile(file, `console.log('LIVE', process.env.TEST_TMP_DIR); process.exit(Number(process.env.EXIT || 0))`)
  const [a, b] = await Promise.all([
    runCase(file, { cwd: dir, output: false }),
    runCase(file, { cwd: dir, output: false, env: { ...process.env, EXIT: '7' } }),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.code, 7)
  assert.match(a.tail.join(''), /LIVE/)
  assert.notEqual(a.tempDir, b.tempDir)
  await assert.rejects(access(a.tempDir))
  await assert.rejects(access(b.tempDir))
})

test('timeout kills owned descendants, releases listener, keeps unrelated process', { skip: process.platform === 'win32' ? 'POSIX process-group ownership regression' : false }, async (t) => {
  const dir = await privateRoot(t)
  const evidence = path.join(dir, 'ready.json')
  const fixture = path.join(dir, 'hang.mjs')
  await writeFile(fixture, `import { spawn } from 'node:child_process';
    const code = \`const http=require('node:http'); const fs=require('node:fs'); const server=http.createServer(); server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port}))); process.on('SIGTERM',()=>{});\`;
    spawn(process.execPath,['-e',code,${JSON.stringify(evidence)}],{stdio:'inherit'}); setInterval(()=>{},1000);`)
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  t.after(() => new Promise((resolve) => { unrelated.once('close', resolve); unrelated.kill() }))
  const result = await runCase(fixture, { cwd: dir, timeoutMs: 1500, output: false })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  const { pid, port } = JSON.parse(await readFile(evidence, 'utf8'))
  // Rebinding the exact port is a stronger cleanup check than a killed-parent status.
  const dist = path.join(dir, 'dist'); await mkdir(dist); await writeFile(path.join(dist, 'index.html'), 'fixture')
  const server = await serveDist(dist, { port })
  await server.close()
  assert.equal(unrelated.exitCode, null)
  assert.equal(process.kill(unrelated.pid, 0), true)
  assert.ok(pid > 0)
  await assert.rejects(access(result.tempDir))
})

test('prebuilt dist reuse is read-only, concurrent ports differ and close is awaited', async (t) => {
  const dir = await privateRoot(t)
  const index = path.join(dir, 'index.html')
  await writeFile(index, 'private prebuilt')
  assert.equal(await requireDist(dir), dir)
  await assert.rejects(requireDist(path.join(dir, 'missing')), /Missing prebuilt/)
  const [a, b] = await Promise.all([serveDist(dir), serveDist(dir)])
  try {
    assert.notEqual(a.url, b.url)
    assert.equal(await (await fetch(a.url)).text(), 'private prebuilt')
    assert.equal(await (await fetch(b.url)).text(), 'private prebuilt')
    assert.equal(await readFile(index, 'utf8'), 'private prebuilt')
  } finally { await Promise.all([a.close(), b.close()]) }
  await assert.rejects(fetch(a.url))
})

test('two suite entrypoints reuse injected dist without build, and fail missing dist', async (t) => {
  const dir = await privateRoot(t)
  await mkdir(path.join(dir, 'tests/helpers'), { recursive: true })
  await mkdir(path.join(dir, 'tests/integration'))
  await mkdir(path.join(dir, 'node_modules/playwright'), { recursive: true })
  await writeFile(path.join(dir, 'node_modules/playwright/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  await writeFile(path.join(dir, 'node_modules/playwright/index.mjs'), `export const chromium={launch:async()=>{throw new Error('MOCK_LAUNCH_REACHED')}}`)
  await cp(path.join(root, 'tests/helpers/runtime.mjs'), path.join(dir, 'tests/helpers/runtime.mjs'))
  const dist = path.join(dir, 'prebuilt'); await mkdir(dist); await writeFile(path.join(dist, 'index.html'), 'immutable')
  for (const name of ['auto-title', 'diagnostics-contract']) {
    const file = path.join(dir, `tests/integration/${name}.test.mjs`)
    await cp(path.join(root, `tests/integration/${name}.test.mjs`), file)
    const result = await runCase(file, { cwd: dir, output: false, env: { ...process.env, DIST_DIR: dist, STANDARD_DIST_DIR: dist, PORT: '0', STANDARD_PORT: '0' } })
    assert.equal(result.ok, false) // Intentional browser stop, never counted as suite PASS.
    assert.match(result.tail.join(''), /MOCK_LAUNCH_REACHED/)
    const missing = await runCase(file, { cwd: dir, output: false, env: { ...process.env, DIST_DIR: dist + '-missing', STANDARD_DIST_DIR: dist + '-missing' } })
    assert.equal(missing.ok, false)
    assert.match(missing.tail.join(''), /Missing prebuilt/)
  }
  assert.equal(await readFile(path.join(dist, 'index.html'), 'utf8'), 'immutable')
})

test('runner streams output before case exit (handshake, not buffered)', async (t) => {
  const dir = await privateRoot(t)
  const file = path.join(dir, 'live.mjs')
  const release = path.join(dir, 'release')
  await writeFile(file, `import { watch, existsSync } from 'node:fs'; const watcher=watch(${JSON.stringify(dir)},()=>{if(existsSync(${JSON.stringify(release)})){watcher.close()}}); console.log('READY');`)
  const driver = path.join(dir, 'driver.mjs')
  await writeFile(driver, `import {runCase} from ${JSON.stringify(new URL('../helpers/runtime.mjs', import.meta.url).href)}; const r=await runCase(${JSON.stringify(file)},{cwd:${JSON.stringify(dir)},timeoutMs:10000}); process.exitCode=r.ok?0:1;`)
  const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise((resolve) => child.once('close', resolve))
  t.after(() => { if (child.exitCode === null) child.kill() })
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('missing live output')), 5000)
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) { clearTimeout(deadline); resolve() } })
    child.once('error', reject)
  })
  assert.equal(child.exitCode, null)
  await writeFile(release, 'continue')
  assert.equal(await closed, 0)
})

test('CLI exact failure rerun, JSON, no-match, invalid arguments and node:test detection', async (t) => {
  const dir = await privateRoot(t)
  await mkdir(path.join(dir, 'tests/helpers'), { recursive: true })
  await mkdir(path.join(dir, 'tests/unit'))
  await cp(path.join(root, 'tests/run-layer.mjs'), path.join(dir, 'tests/run-layer.mjs'))
  await cp(path.join(root, 'tests/helpers/runtime.mjs'), path.join(dir, 'tests/helpers/runtime.mjs'))
  await writeFile(path.join(dir, 'tests/unit/pass.test.mjs'), `import test from 'node:test'; test('pass',()=>{});`)
  await writeFile(path.join(dir, 'tests/unit/fail.test.mjs'), 'process.exit(9)')
  const runner = path.join(dir, 'tests/run-layer.mjs'), report = path.join(dir, 'report.json')
  const first = await execute(runner, ['unit', '--json', report])
  assert.equal(first.code, 1)
  const json = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(json.passed, 1); assert.equal(json.failed, 1); assert.ok(json.totalMs >= 0)
  assert.match(first.output, /Rerun:.*--case tests\/unit\/fail.test.mjs/)
  const rerun = await execute(runner, ['unit', '--failed-from', report, '--json', report])
  assert.equal(rerun.code, 1)
  assert.equal(JSON.parse(await readFile(report, 'utf8')).executed, 1)
  assert.equal((await execute(runner, ['unit', '--case', 'pass.test.mjs'])).code, 0)
  assert.equal((await execute(runner, ['unit', '--only', 'absent'])).code, 1)
  assert.equal((await execute(runner, ['unit', '--only', 'absent', '--list'])).code, 1)
  assert.equal((await execute(runner, ['unit', '--only'])).code, 2)
  assert.equal((await execute(runner, ['unit', '--timeout-ms', 'NaN'])).code, 2)
})
