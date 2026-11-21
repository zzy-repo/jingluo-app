#!/usr/bin/env node
/**
 * P0 · 兜底页两条分支的正向验证 + P1 · 白屏边界复测（一台模拟器串行）。
 *
 * 为什么一定要在 WebView < 80 上做：
 *   - 兜底页（src/index.html 里的内联 ES5 守卫）有且只有两条分支：
 *       ① `缺少：<API 列表>`  —— 12 条特性探针里至少一条不满足；
 *       ② `脚本 12 秒内没有启动（内核过旧或资源加载失败）` —— 探针都过但主包 12 秒没置位 __DEEPSEEK_BOOTED__。
 *     在 WebView 83/91/109 上这两条**从来没被触发过**（api30/api31 的 README 已记录），
 *     所以它们是「写着但没验过」的代码。只有内核真的缺东西/真的解析不了主包时才会走到。
 *   - 主包用了可选链（Chrome 80 才有），WebView < 80 会整包 SyntaxError，
 *     于是 ①（如果探针也缺）或 ②（探针齐但包挂了）必然命中一条 —— 这是唯二可能的落点，
 *     到底落哪条、文案对不对、__DEEPSEEK_BOOTED__ 有没有置位，只能实测。
 *
 * 用法：
 *   node scripts/compat/p0-fallback.mjs --avd compat-api26 --api 26
 *   node scripts/compat/p0-fallback.mjs --api 30 --attach          # 设备已在跑，直接测
 *   node scripts/compat/p0-fallback.mjs --avd compat-api26 --api 26 --no-kill
 *
 * 产物（全部落 docs/compat/compat-old/api<NN>/）：
 *   result-p0.json      本次所有原始测量值
 *   logcat-api<NN>.txt  冷启动全程 logcat（-v threadtime，含 chromium CONSOLE 行）
 *   shots/*.png         2s/6s/13s/20s 四帧
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  ADB,
  PACKAGE,
  adb,
  calmDown,
  coldStart,
  devices,
  ensureDir,
  environment,
  evidenceDir,
  installApk,
  killEmulator,
  now,
  pidOf,
  saveJson,
  screencap,
  shell,
  sleep,
  startEmulator,
  uiTexts,
  uiTree,
  waitBoot,
} from './lib/device.mjs'
import { BOOT_STATE, attach as attachCdp } from './lib/cdp.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const AVd = option('avd')
const API = option('api')
const ATTACH = flag('attach')
const KEEP = flag('no-kill')
if (!API || (!ATTACH && !AVd)) {
  console.error('用法：node scripts/compat/p0-fallback.mjs --avd <avd> --api <NN> [--attach] [--no-kill]')
  process.exit(2)
}

const stamp = (label) => console.log(`[${now()}] ${label}`)

/** 冷启动后按时间点取帧与页内状态；每一步都容错，缺数据就记 null，绝不猜。 */
const sampleAt = async (offsets, outDir, cdpState) => {
  const samples = []
  const startedAt = Date.now()
  for (const offset of offsets) {
    const wait = offset * 1000 - (Date.now() - startedAt)
    if (wait > 0) {
      await sleep(wait)
    }
    const at = Math.round((Date.now() - startedAt) / 100) / 10
    const shot = `${outDir}/shots/t${String(offset).padStart(2, '0')}s.png`
    try {
      screencap(shot)
    } catch (error) {
      samples.push({ at, error: `截图失败 ${error.message}` })
      continue
    }
    let page = null
    let cdpError = null
    if (cdpState.cdp === null) {
      try {
        cdpState.cdp = (await attachCdp()).cdp
      } catch (error) {
        cdpError = error.message
      }
    }
    if (cdpState.cdp !== null) {
      try {
        page = await cdpState.cdp.evaluate(BOOT_STATE, 20_000)
      } catch (error) {
        cdpError = error.message
        cdpState.cdp = null
      }
    }
    const xml = uiTree()
    samples.push({
      at,
      shot,
      page,
      cdpError,
      uiTexts: uiTexts(xml).slice(0, 20),
    })
    stamp(`  t=${at}s 截图 ${shot} ${page ? `booted=${page.booted}` : cdpError ? `CDP ${cdpError}` : ''}`)
  }
  return samples
}

const collectLogcat = (file) => {
  const text = adb(['logcat', '-d', '-v', 'threadtime'])
  writeFileSync(file, `${text}\n`)
  return text
}

const main = async () => {
  const outDir = ensureDir(evidenceDir(API))
  ensureDir(`${outDir}/shots`)
  const result = {
    phase: 'p0-fallback + p1-whitescreen',
    api: Number(API),
    avd: AVd ?? '(attach)',
    startedAt: new Date().toISOString(),
    device: null,
    install: null,
    coldStart: null,
    samples: [],
    logcat: {},
    notes: [],
  }

  if (!ATTACH) {
    const busy = devices()
    if (busy.length > 0) {
      console.error(
        `宿主上已有设备在跑（${busy.map(([serial]) => serial).join(', ')}）——串行纪律要求先等它结束，本次不启动。`
      )
      process.exit(3)
    }
    stamp(`启动 ${AVd}`)
    startEmulator(AVd)
    const booted = await waitBoot(300_000, stamp)
    if (!booted) {
      console.error('开机超时')
      killEmulator()
      process.exit(4)
    }
    stamp('开机完成')
  }

  await sleep(2000)
  result.device = environment()
  stamp(`WebView 原文行：${result.device.webViewVersionLine}`)
  const abi = result.device.abi
  if (!/x86_64|arm64/.test(abi)) {
    result.notes.push(`ABI 是 ${abi}，APK 只有 x86_64/arm64 原生库，risk 见 install 结果`)
  }

  calmDown()
  result.install = installApk()
  stamp(`安装：${result.install.output.split(/\r?\n/).slice(-1)[0]}（${result.install.elapsedMs}ms）`)

  // 冷启动——这是 P0 的主场景：从零到兜底页/主界面
  result.coldStart = coldStart()
  stamp(`am start -W：${result.coldStart.elapsedMs}ms`)
  const cdpState = { cdp: null }
  result.samples = await sampleAt([2, 6, 13, 20], outDir, cdpState)

  // 再等 8 秒确认「12 秒兜底」之后状态不再变化（有的内核是慢慢崩的）
  await sleep(8000)
  const finalShot = screencap(`${outDir}/shots/t-final.png`)
  let finalPage = null
  if (cdpState.cdp !== null) {
    finalPage = await cdpState.cdp.evaluate(BOOT_STATE, 20_000).catch(() => null)
  }
  result.final = {
    shot: finalShot,
    page: finalPage,
    pid: pidOf(),
    uiTexts: uiTexts(uiTree()).slice(0, 20),
  }
  stamp(`最终帧 ${finalShot}，pid=${result.final.pid}`)

  const logcatFile = `${outDir}/logcat-api${API}.txt`
  const logcat = collectLogcat(logcatFile)
  result.logcat = {
    file: logcatFile,
    consoleLines: logcat
      .split(/\r?\n/)
      .filter((line) => /chromium|CONSOLE|SyntaxError|Uncaught|chromium:/.test(line))
      .slice(0, 120),
    syntaxErrors: logcat.split(/\r?\n/).filter((line) => /SyntaxError|Unexpected token/.test(line)).slice(0, 40),
  }

  // 结论字段：只记录实测到的东西，没测到就是 null
  const failureText = result.samples.map((sample) => sample.page?.boxText).find((text) => text) ?? null
  result.verdict = {
    fallbackBranch: failureText
      ? failureText.startsWith('缺少')
        ? 'missing-api'
        : failureText.includes('12 秒')
          ? 'watchdog'
          : 'other'
      : null,
    fallbackText: failureText,
    booted: result.samples.some((sample) => sample.page?.booted === true) ||
      result.final?.page?.booted === true,
    compatibilityErrorValue:
      result.samples.map((sample) => sample.page?.compatibilityError).find((value) => value) ?? null,
    syntaxErrorInLogcat: result.logcat.syntaxErrors.length > 0,
    appAliveAtEnd: result.final.pid !== null,
  }
  result.finishedAt = new Date().toISOString()
  saveJson(`${outDir}/result-p0.json`, result)

  console.log('\n=== 结论 ===')
  console.log(JSON.stringify(result.verdict, null, 2))
  console.log(`证据：${outDir}`)

  if (!ATTACH && !KEEP) {
    stamp('关闭模拟器')
    killEmulator()
  }
}

// 显式 exit：CDP 的 WebSocket 不 close 的话 Node 会一直挂着不退出，
// 上一轮就是「结果已落盘但进程不退」→ 被外层 kill → 连带杀掉 detached 的模拟器。
main()
  .then(() => process.exit(0))
  .catch(async (error) => {
  console.error(`失败：${error.message}`)
  if (!ATTACH && !KEEP) {
    try {
      killEmulator()
    } catch {
      // ignore
    }
  }
  process.exit(1)
})
