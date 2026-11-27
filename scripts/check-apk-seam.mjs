#!/usr/bin/env node
// 第 7 项发布校验：**APK 里不许有登录接缝（test auth seam）** —— Issue #487 W1-B / #510 / vc44 交付要求。
//
// ## 为什么这一项必须单独存在
//
// 前六项（debuggable / variant / loopback / cert / insecure / consumeBase）验的是「产物形态」，
// 没有任何一项会去看**包里那坨 web 资产是怎么构建的**。而 `TEST_AUTH_SEAM=1` 打开后，
// `AuthGate` 会**直接进已登录态、不读盘、不续期、不调 `me()`** —— 这个包一旦分发出去，
// 等于把「绕过登录」的开关发给用户。它比任何功能缺陷都严重，所以做成硬断言，不靠人记。
//
// ## 判据（两个标记都必须是 0 命中）
//
// 标记的唯一出处是 `scripts/lib/testAuthSeam.mjs`（`SEAM_MARKERS`）：
//   · `test-token-not-real` —— 假访问凭据真值被编译进产物 = 接缝开着；
//   · `__TEST_AUTH_STATE__` —— DefinePlugin 没定义它时标识符会原样留在产物里。
//
// 只扫文本型条目（`.js/.mjs/.cjs/.css/.html/.json/.map/.txt/.svg`）：二进制（dex / 字体 / 图标）
// 装不下这段代码，扫了只是浪费门禁时间。**扫不到任何文本条目 = 判不出来（exit 2），不是 PASS。**
//
// ## 用法
//
//   node scripts/check-apk-seam.mjs <apk>           # 硬闸：命中 = exit 1
//   node scripts/check-apk-seam.mjs <apk> --json    # 结构化（workflow 消费）
//
// 退出码：0 干净 / 1 命中（禁止分发）/ 2 判不出来（APK 里没有可扫的文本条目）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listZipEntries, readZipEntryRecord } from '../deploy/dl-release/apk-manifest.mjs'
import { SEAM_MARKERS } from './lib/testAuthSeam.mjs'

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.txt', '.svg'])

/** 单条目上限：主 bundle 十几 MB，给到 64MB 足够，再大多半是打错了 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

const isTextEntry = (name) => TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())

/**
 * 扫一个 APK，返回 `{ scanned, hits }`。
 * `hits` 形如 `[{ entry, marker }]`；`scanned` 是真正读过的条目数。
 */
export function scanApkForSeam(apkPath) {
  const buf = fs.readFileSync(apkPath)
  const entries = listZipEntries(buf)
  const targets = entries.filter((e) => isTextEntry(e.name))
  const hits = []
  for (const entry of targets) {
    let text
    try {
      text = readZipEntryRecord(buf, entry, MAX_ENTRY_BYTES).toString('utf8')
    } catch (error) {
      // 读不动一个条目 ⇒ 判不出来，不能当「没命中」糊过去（throw 给调用方，exit 2）
      throw new Error(`读不动 zip 条目 ${entry.name}：${error instanceof Error ? error.message : error}`)
    }
    for (const marker of SEAM_MARKERS) {
      if (text.includes(marker)) hits.push({ entry: entry.name, marker })
    }
  }
  return { scanned: targets.length, total: entries.length, hits }
}

const SCRIPT = path.basename(fileURLToPath(import.meta.url))

function main(argv) {
  const args = argv.slice(2)
  const json = args.includes('--json')
  const apk = args.find((a) => !a.startsWith('--'))

  if (!apk) {
    console.error(`用法：node scripts/${SCRIPT} <apk> [--json]`)
    return 2
  }
  if (!fs.existsSync(apk)) {
    console.error(`找不到 APK：${apk}`)
    return 2
  }

  let result
  try {
    result = scanApkForSeam(apk)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (json) {
      console.log(JSON.stringify({ ok: false, status: 'UNKNOWN', error: message }, null, 2))
    } else {
      console.error(`7  APK 不含登录接缝标记         UNKNOWN  判不出来：${message}`)
      console.error('   → 不是 PASS。先确认这个 APK 打得开、里面有 assets/public 的 web 资产。')
    }
    return 2
  }

  const counts = Object.fromEntries(SEAM_MARKERS.map((m) => [m, 0]))
  for (const hit of result.hits) counts[hit.marker] += 1
  const clean = result.hits.length === 0 && result.scanned > 0

  if (json) {
    console.log(
      JSON.stringify(
        { ok: clean, status: clean ? 'PASS' : result.scanned === 0 ? 'UNKNOWN' : 'FAIL', scanned: result.scanned, counts, hits: result.hits },
        null,
        2,
      ),
    )
    return clean ? 0 : result.scanned === 0 ? 2 : 1
  }

  const detail = SEAM_MARKERS.map((m) => `${m}=${counts[m]}`).join('  ')
  if (result.scanned === 0) {
    console.error(`7  APK 不含登录接缝标记         UNKNOWN   扫了 0 个文本条目（共 ${result.total} 个）：判不出来`)
    return 2
  }
  if (!clean) {
    console.error(`7  APK 不含登录接缝标记         FAIL      ${detail}`)
    for (const hit of result.hits.slice(0, 10)) {
      console.error(`   · ${hit.entry} 命中 ${hit.marker}`)
    }
    console.error('   → 这个包带着「启动即已登录」的开关，**禁止分发**：')
    console.error('     重新构建，并确认构建环境里没有 TEST_AUTH_SEAM（生产构建一律不带）。')
    return 1
  }
  console.log(`7  APK 不含登录接缝标记         PASS      ${detail}（扫了 ${result.scanned} 个文本条目 / 共 ${result.total} 个）`)
  return 0
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === SCRIPT
if (invokedDirectly) process.exit(main(process.argv))
