/**
 * public-artifact-redaction.test.mjs —— `check:public-artifact-redaction` 的负向对照（Issue #745 第 3 步）。
 *
 * 被测的是「**产物里有没有已经没用的旧地址**」这条判据本身（口径见指挥台 11:12 裁决第 4 条：
 * 要清的不是「所有 IP」，是「已经没用的旧地址」）。它守的东西看不见摸不着（bundle 里一句
 * `http://<内网IP>:<高位端口>`），一旦判宽了就永远不会红，所以这里**逐条钉住这些方向**：
 *
 *   T1 **未登记的裸 IP 必须红**：`http(s)://<IPv4>:<port>` 形态出现在产物里、且配置里查不到它
 *      → exit 1，`[FAIL-UNREGISTERED]`，点名「未在 config.endpoints.json 登记」。
 *   T1b **旧池的裸主机必须红**：`legacyHosts` 里那些 IP 以字符串形态进包 → `[FAIL-LEGACY]`。
 *   T2 **内网端口必须红**：端口表从配置**动态派生**（`allowedPorts` / 配置 URL 的显式端口），
 *      真域名上挂着 7002 → 红；产物里独立写死的 `const PORT = 7002` 同样红。
 *   T3 **允许清单真的起作用**：`--allow-host` + `--allow-port` 双给 → exit 0 并打印放行清单；
 *      **只给主机不给端口 → 仍然红**（否则一条 `--allow-host` 会顺手放过这台机器的所有端口）。
 *   T4 **判不了必须 exit 2**：非 zip / 打不开 / 空目录 / 参数冲突 —— 不知道有没有泄漏 ≠ 没有泄漏。
 *   T5 **不误报**：XML 命名空间（`http://www.w3.org/2000/svg`）与占位域名（`redacted.local`）
 *      跳过并**计数打印**（#678：跳过也必须记账，不许静默）。
 *   T7 **产品端点不判红**：`chatBaseUrl` / `pay.baseUrl` / `download.fallbackBase` 这类
 *      「客户端真要连」的字段 → `[OK-ENDPOINT]` + **exit 0**（把功能需要从红里摘出来，不是放宽）。
 *   T8 **旧池命中即红**：`inviteBaseUrl` / `feedbackUrl` / `legacyHosts[]` → `[FAIL-LEGACY]` + exit 1，
 *      并提示「先 grep 调用方 0 处再删」。
 *   T9 **未裁决字段命中即红**：登记了但没裁决属于哪一类（`download.primaryBase`）→ exit 1，
 *      **宁可红也不替人猜它有用**。
 *   T10 **争议域名只 WARN**：`sub2api.rose7.cn` → `[WARN-DISPUTED]` + **exit 0**（等 #745 的 A/B/C
 *      裁决，门禁不替裁决投票）。
 *   T11 **去重断言**：同一地址只许落一类 —— 既在产品端点表又像旧池时按产品端点算，
 *      且绝不出现「同一地址既 [OK-ENDPOINT] 又 [FAIL-*]」（报告自相矛盾比红更坏）。
 *
 * 两条与她人的分界（改这个文件前先读）：
 *   · **不要在测试里写 `config/endpoints.json` 里那三个真实端点地址** —— `check:endpoints` 的 R3
 *     正因为「测试里抄一份地址」才存在。这里用临时配置 + 假地址（T6 需要真配置时，
 *     地址从 JSON 里**读出来拼**，不写字面量）。
 *   · 用例只跑 `--dist`（临时产物目录），**不依赖 APK**：CI 里没有 APK，这条必须每次 `pnpm test` 都真跑。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 直接 import 判定模块：T11b 要喂一份「自相矛盾」的命中给 summarize，证明去重断言真的会抛。
// （import 不会触发 CLI —— 模块末尾只在「被直接执行」时才跑 run。）
import { CLASS, summarize } from '../../scripts/check-public-artifact-redaction.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-public-artifact-redaction.mjs')
const ENDPOINTS = path.join(ROOT, 'config', 'endpoints.json')

const EXIT = { CLEAN: 0, LEAK: 1, UNKNOWN: 2 }

/** 临时工作区：一份临时配置 + 一个临时产物目录（用完连根删掉，不留垃圾给 check:hygiene） */
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-artifact-redaction-'))
  return {
    dir,
    writeConfig: (value) => {
      const file = path.join(dir, 'endpoints.json')
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
      return file
    },
    writeDist: (name, text) => {
      const distDir = path.join(dir, 'dist')
      const file = path.join(distDir, 'static', 'js', name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      return distDir
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * 跑一次门禁。`env: {}` 里盖掉 `NODE_TEST_CONTEXT`：父 runner 留的这个变量会让子进程
 * 以为自己被递归调用（#733 记过同一个坑），这里用不到 `node --test` 所以直接摘掉更稳。
 */
const runGate = (args) => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  })
  assert.equal(result.error, undefined, `门禁没跑起来：${result.error?.message}`)
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * 一份「联调用」的临时端点配置：内网 IP + 几个高位端口，与真实配置无关（地址全是假的）。
 *
 * 五个端口的用途各不相同，**别合并** —— 每个端口就是一类判定样本：
 *   7001 `chatBaseUrl`      产品端点（客户端真要连的聊天后端）
 *   7002 `inviteBaseUrl` / `feedbackUrl`  旧池（一个删了调用方、一个裁决归旧池）
 *   7004 `pay.baseUrl`      产品端点，且**域名 + 内网端口**（"既像产品端点又像内网端口"）
 *   7005 只在 `allowedPorts` 里 —— 端口表派生的内网端口，背后没有任何端点 → 旧池
 *   7006 `download.primaryBase` 登记了但**没裁决**归类 → 未裁决（与真实配置同形，判红）
 */
const TEMP_ENDPOINTS = {
  chatBaseUrl: 'http://10.11.12.13:7001',
  inviteBaseUrl: 'http://10.11.12.13:7002',
  feedbackUrl: 'http://10.11.12.13:7002/feedback',
  legacyHosts: ['10.11.12.13'],
  allowedHosts: ['10.11.12.13'],
  allowedPorts: [7001, 7002, 7004, 7005],
  pay: { baseUrl: 'https://pay.rose7.cn:7004' },
  consume: { baseUrl: 'https://consume.example.test' },
  download: { primaryBase: 'http://10.11.12.13:7006', fallbackBase: 'https://dl.example.test' },
}

// ---------------------------------------------------------------- T1 内网 IP

test('T1 未登记的裸 IP：产物里出现 http://<IPv4>:<port> 且配置里查不到 → exit 1', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000001.js',
      'const base="http://203.0.113.9:9000/v1",other="https://sub2api.rose7.cn";export{base,other};\n'
    )

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK, `未登记的裸 IP 必须判红，实际 exit=${red.code}\n${red.stdout}${red.stderr}`)
    assert.match(
      red.stdout,
      /\[FAIL-UNREGISTERED\][^\n]*http:\/\/203\.0\.113\.9:9000/,
      '必须逐条点名那个未登记的地址'
    )
    assert.match(red.stdout, /内网 IP/, '分类要写清是「内网 IP」')
    assert.match(red.stdout, /未在 config\.endpoints\.json 登记/, '未登记就要明说未登记，不许含糊成「有地址」')
    assert.match(red.stderr, /清不掉的地址/, '最后要有一句人能看懂的结论')
    // 判据不是「有 http:// 就叫红」：同一个产物里的公网域名不许被算进 FAIL
    assert.doesNotMatch(red.stdout, /\[FAIL-[A-Z]+\][^\n]*sub2api\.rose7\.cn/, '公网域名不许被误判成红')
    assert.match(red.stdout, /\[WARN-DISPUTED\][^\n]*sub2api\.rose7\.cn/, '争议域名只许 WARN + 点名')
  } finally {
    work.cleanup()
  }
})

test('T1b 裸 IP 主机字面量：配置里登记过的 IP 以字符串形态进包 → 也要红', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    // `LEGACY_HOSTS` 就是这么进包的：一组引号包着的字符串
    const dist = work.writeDist('main.00000002.js', 'const H=["10.11.12.13","api.example.test"];export{H};\n')

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK, `裸 IP 字面量必须判红，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, /裸 IP 主机字面量/)
    assert.match(red.stdout, /\[FAIL-LEGACY\][^\n]*10\.11\.12\.13/, '旧池就是旧池，得按旧池报')
    assert.match(red.stdout, /legacyHosts\[0\]/, '点名到 legacyHosts 的那一条')
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T2 内网端口

test('T2 内网端口：真域名上挂着内网端口 → exit 1；独立写死的端口同样红', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000003.js',
      [
        'const upstream="https://api.rose7.cn:7002/v1";',
        // 不带 scheme 的 `主机:端口` 字面量：同样是「内网端口进了产物」，且不带 IP 就绕过了 R1
        'const legacy="legacy-upstream:7002";',
        'export{upstream,legacy};',
        '',
      ].join('\n')
    )

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK, `内网端口必须判红，实际 exit=${red.code}\n${red.stdout}`)
    // URL 上挂着的那个端口，与不带 scheme 的 `主机:端口` 字面量，两条都要点名
    assert.match(red.stdout, /内网端口 7002/, '分类里要有「内网端口」')
    assert.match(red.stdout, /\[FAIL-LEGACY\][^\n]*api\.rose7\.cn:7002/, 'URL 形态的端口要逐条点名')
    assert.match(red.stdout, /\[FAIL-LEGACY\][^\n]*\s:7002 →/, '不带 scheme 的 :7002 字面量也要点名')
  } finally {
    work.cleanup()
  }
})

test('T2b 端口表是动态派生的：换一份配置，60010 就不再是问题、7005 才是', () => {
  const work = scratch()
  try {
    // 临时配置里 7005 只出现在 allowedPorts；bundle 里同时出现 60010（谁的配置里都没有）与 7005
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000004.js',
      'const a="https://api.rose7.cn:7005/x",b="https://api.rose7.cn:60010/y";export{a,b};\n'
    )

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK)
    assert.match(red.stdout, /api\.rose7\.cn:7005/, '在端口表里的必须报')
    assert.doesNotMatch(red.stdout, /\[FAIL-[A-Z]+\][^\n]*:60010/, '不在端口表里的不许凭「端口长得像」就报')
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T3 允许清单

test('T3 允许清单：--allow-host + --allow-port 双给 → exit 0，且打印放行清单', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    // 这条本来是**旧池命中（该红）**：允许清单要能把它显式放行给联调包用，且必须打印清单
    const dist = work.writeDist('main.00000005.js', 'const base="http://10.11.12.13:7002/v1";export{base};\n')

    const green = runGate([
      '--dist',
      dist,
      '--config',
      config,
      '--allow-host',
      '10.11.12.13',
      '--allow-port',
      '7002',
    ])
    assert.equal(green.code, EXIT.CLEAN, `显式放行后必须绿，实际 exit=${green.code}\n${green.stdout}${green.stderr}`)
    assert.match(green.stdout, /放行清单/, '放行必须打印清单，不许悄悄放过')
    assert.match(green.stdout, /\[ALLOW\][^\n]*10\.11\.12\.13:7002/, '逐条说明哪一条被放行了')
    assert.match(green.stdout, /仅供联调|正式包不许带/, '文案要写清这些参数不属于正式包')
    assert.doesNotMatch(green.stdout, /\[FAIL-LEGACY\][^\n]*10\.11\.12\.13:7002/, '显式放行的那条不许同时又算红')
  } finally {
    work.cleanup()
  }
})

test('T3b 只放行主机、不放行端口 → 仍然红（一条 --allow-host 不许顺手放过所有端口）', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist('main.00000006.js', 'const base="http://10.11.12.13:7002/v1";export{base};\n')

    const red = runGate(['--dist', dist, '--config', config, '--allow-host', '10.11.12.13'])
    assert.equal(red.code, EXIT.LEAK, `只放主机必须仍然红，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, /缺 --allow-port 7002/, '要告诉人还差哪一个开关')
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T4 判不了

test('T4 判不了就是 exit 2：非 zip / 打不开 / 空产物目录 / 参数冲突', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const notZip = path.join(work.dir, 'not-an-apk.apk')
    fs.writeFileSync(notZip, 'this is definitely not a zip archive')
    const emptyDist = path.join(work.dir, 'empty-dist')
    fs.mkdirSync(emptyDist, { recursive: true })
    const dist = work.writeDist('main.00000007.js', 'export{};\n')

    const cases = [
      { args: [notZip, '--config', config], expect: /不是可读的 APK/, why: 'APK 不是 zip' },
      {
        args: [path.join(work.dir, 'missing.apk'), '--config', config],
        expect: /读不出/,
        why: '文件不存在',
      },
      { args: ['--dist', emptyDist, '--config', config], expect: /没有可扫描的文本产物/, why: '空产物目录' },
      {
        args: [notZip, '--dist', dist, '--config', config],
        expect: /二选一/,
        why: 'APK 与 --dist 同时给',
      },
      { args: ['--dist', dist, '--bogus'], expect: /未知参数/, why: '未知参数' },
    ]

    for (const item of cases) {
      const result = runGate(item.args)
      assert.equal(
        result.code,
        EXIT.UNKNOWN,
        `${item.why} 必须 exit 2（判不了 ≠ 干净），实际 exit=${result.code}\n${result.stdout}${result.stderr}`
      )
      assert.match(result.stderr, item.expect, `${item.why}：stderr 要写清为什么判不了`)
    }
  } finally {
    work.cleanup()
  }
})

test('T4b 没有输入（既不给 APK 也不给 --dist）→ exit 2，不是 exit 0', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const result = runGate(['--config', config])
    assert.equal(result.code, EXIT.UNKNOWN, `没有输入时不许「什么都没查就绿」，实际 exit=${result.code}`)
    assert.match(result.stderr, /没有输入/)
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T5 不误报 / 跳过记账

test('T5 XML 命名空间与占位域名不误报，但要计数打印（不静默）', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000008.js',
      [
        'const ns1="http://www.w3.org/2000/svg",ns2="http://www.w3.org/1999/xlink";',
        'const ph="https://redacted.local",local="http://localhost:3000/",api="https://sub2api.rose7.cn";',
        'export{ns1,ns2,ph,local,api};',
        '',
      ].join('\n')
    )

    const green = runGate(['--dist', dist, '--config', config])
    assert.equal(
      green.code,
      EXIT.CLEAN,
      `命名空间 / 占位域名必须绿（否则门禁第一天就红在自己身上），实际 exit=${green.code}\n${green.stdout}${green.stderr}`
    )
    assert.match(green.stdout, /已跳过 2 处 XML 命名空间/, 'XML 命名空间要计数打印')
    assert.match(green.stdout, /www\.w3\.org/, '跳过的是谁也要写出来')
    assert.match(green.stdout, /处占位/, '占位域名同样要计数')
    assert.match(green.stdout, /redacted\.local/, '占位也要点名')
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T6 真配置

test('T6 不传 --config 时读的就是 config/endpoints.json（地址在运行时拼，不在测试里抄一份）', () => {
  const raw = JSON.parse(fs.readFileSync(ENDPOINTS, 'utf8'))
  // 用**旧池**那个字段（`inviteBaseUrl`），不是产品端点：产品端点现在按功能需要放行（T7），
  // 拿它当「必须红」的样本就测不出真配置被读到了。
  const invite = raw.inviteBaseUrl
  assert.ok(invite, 'config/endpoints.json 里应当有 inviteBaseUrl（旧池样本）')
  const address = new URL(invite).host

  const work = scratch()
  try {
    const dist = work.writeDist('main.00000009.js', `const base="${invite}";export{base};\n`)
    const red = runGate(['--dist', dist])
    assert.equal(red.code, EXIT.LEAK, `真实配置里的旧池地址必须判红，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, new RegExp(address.replace(/\./g, '\\.')), '要点名真实配置里的地址')
    assert.match(red.stdout, /\[FAIL-LEGACY\]/, '旧池字段命中要按旧池报')
    assert.match(red.stdout, /config\/endpoints\.json/, '要么读到了真配置，要么这条断言就成了摆设')
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T7..T11 三分类（#745 第 4 步）

/** 从输出里抠出「每行标签 → 地址」，用来做去重断言（输出格式就是契约，照着它抠才测得准） */
const tagsByToken = (stdout) => {
  const byToken = new Map()
  for (const line of String(stdout).split('\n')) {
    const m = /^\[(OK-ENDPOINT|FAIL-LEGACY|FAIL-UNREGISTERED|WARN-DISPUTED|ALLOW)\]\s+(\S+)\s+(\S+)\s+→/.exec(line)
    if (!m) continue
    const [, tag, , token] = m
    const set = byToken.get(token) ?? new Set()
    set.add(tag)
    byToken.set(token, set)
  }
  return byToken
}

test('T7 只有产品端点 → exit 0，且逐个点名来源字段 [OK-ENDPOINT]', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000010.js',
      [
        'const chat="http://10.11.12.13:7001/v1";',
        // 「域名 + 内网端口」的产品端点：既像内网端口，又是客户端真要连的 → 按产品端点算
        'const pay="https://pay.rose7.cn:7004/pay";',
        'export{chat,pay};',
        '',
      ].join('\n')
    )

    const green = runGate(['--dist', dist, '--config', config])
    assert.equal(
      green.code,
      EXIT.CLEAN,
      `只有产品端点时必须绿（那是功能需要，不是泄漏），实际 exit=${green.code}\n${green.stdout}${green.stderr}`
    )
    assert.match(green.stdout, /\[OK-ENDPOINT\][^\n]*http:\/\/10\.11\.12\.13:7001/, '产品端点要打印出来，不许静默')
    assert.match(
      green.stdout,
      /\[OK-ENDPOINT\][^\n]*pay\.rose7\.cn:7004/,
      '产品端点 + 内网端口同时成立时，按产品端点算'
    )
    assert.match(green.stdout, /config\.endpoints\.chatBaseUrl/, '逐个打印来源字段（chatBaseUrl）')
    assert.match(green.stdout, /config\.endpoints\.pay\.baseUrl/, '逐个打印来源字段（pay.baseUrl）')
    assert.match(green.stdout, /产品端点 2 条（允许）/, '汇总行要有四类计数')
    assert.match(green.stdout, /旧池地址 0 条（必须清）/, '旧池为 0 也要写出来（不静默）')
    assert.match(green.stdout, /exit 0/, '汇总行要写清退出码规则')
    assert.doesNotMatch(green.stdout, /\[FAIL-/, '产品端点不许被算进任何一类红')
  } finally {
    work.cleanup()
  }
})

test('T8 旧池地址 → exit 1 且 [FAIL-LEGACY]（点名 legacyHosts[0]，提示先 grep 调用方）', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000011.js',
      ['const invite="http://10.11.12.13:7002/v1";', 'const H=["10.11.12.13"];', 'export{invite,H};', ''].join('\n')
    )

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK, `旧池命中必须 exit 1，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, /\[FAIL-LEGACY\][^\n]*http:\/\/10\.11\.12\.13:7002/, 'URL 形态的旧池要逐条点名')
    assert.match(red.stdout, /\[FAIL-LEGACY\][^\n]*legacyHosts\[0\]/, '裸主机那一条要点名到 legacyHosts[0]')
    assert.match(red.stdout, /inviteBaseUrl/, '要点名它出自哪个字段')
    assert.match(red.stdout, /grep 调用方/, '要提示「先 grep 调用方 0 处再删」')
    assert.match(red.stdout, /旧池地址 2 条（必须清）/, '汇总行要摊开旧池条数')
    assert.match(red.stderr, /清不掉的地址/, 'stderr 要有一句人能看懂的结论')
  } finally {
    work.cleanup()
  }
})

test('T9 未裁决字段（download.primaryBase）→ exit 1 且 [FAIL-UNREGISTERED]（宁可红，不替人猜）', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist('main.00000012.js', 'const p="http://10.11.12.13:7006/releases.json";export{p};\n')

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK, `未裁决字段必须先判红，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, /\[FAIL-UNREGISTERED\][^\n]*10\.11\.12\.13:7006/, '要逐条点名')
    assert.match(red.stdout, /download\.primaryBase/, '要说出它登记在哪个字段（登记 ≠ 已裁决）')
    assert.match(red.stdout, /未登记 1 条（必须清）/, '汇总行要摊开未登记条数')
    assert.doesNotMatch(red.stdout, /\[OK-ENDPOINT\]/, '没裁决的字段不许被当成产品端点放行')
  } finally {
    work.cleanup()
  }
})

test('T10 只有争议域名（sub2api.rose7.cn）→ exit 0 且 [WARN-DISPUTED]（不替裁决投票）', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist('main.00000013.js', 'const api="https://sub2api.rose7.cn/api/v1";export{api};\n')

    const green = runGate(['--dist', dist, '--config', config])
    assert.equal(
      green.code,
      EXIT.CLEAN,
      `争议域名不许硬判红（关系还没裁决），实际 exit=${green.code}\n${green.stdout}${green.stderr}`
    )
    assert.match(green.stdout, /\[WARN-DISPUTED\][^\n]*sub2api\.rose7\.cn/, '争议域名要 WARN + 点名')
    assert.match(green.stdout, /#745 裁决/, '要写清待哪一单裁决')
    assert.match(green.stdout, /争议 1 条（待裁决）/, '汇总行要把它单列成「待裁决」')
    assert.doesNotMatch(green.stdout, /\[FAIL-/, '争议域名不计入红')
    assert.doesNotMatch(green.stdout, /\[OK-ENDPOINT\]/, '争议域名也不计入「产品端点（允许）」——一个地址只许落一类')
  } finally {
    work.cleanup()
  }
})

test('T11 同一地址不得同时进 OK 与 FAIL：产品端点优先，并打印为什么归这一类', () => {
  const work = scratch()
  try {
    // 同一个 `主机:端口` 在配置里既是产品端点、又是旧池（现实里 `62.106.70.167` 就有两副面孔）
    const config = work.writeConfig({
      ...TEMP_ENDPOINTS,
      chatBaseUrl: 'http://10.21.22.23:7101',
      feedbackUrl: 'http://10.21.22.23:7101/feedback',
      inviteBaseUrl: 'http://10.21.22.23:7102',
      legacyHosts: ['10.21.22.23'],
      allowedHosts: ['10.21.22.23'],
      allowedPorts: [7101, 7102],
    })
    const dist = work.writeDist('main.00000014.js', 'const base="http://10.21.22.23:7101/v1";export{base};\n')

    const green = runGate(['--dist', dist, '--config', config])
    assert.equal(
      green.code,
      EXIT.CLEAN,
      `既在产品端点表又像旧池时按产品端点算（客户端真要连的字段赢），实际 exit=${green.code}\n${green.stdout}`
    )
    const tags = tagsByToken(green.stdout)
    assert.ok(tags.size > 0, '输出里应当有判定行')
    for (const [token, set] of tags) {
      assert.equal(set.size, 1, `地址 ${token} 落进了多个类：${[...set].join(' / ')} —— 同一地址只许落一类`)
    }
    const hit = [...tags.keys()].find((token) => token.includes('10.21.22.23:7101'))
    assert.ok(hit, '被两边登记的那个地址必须出现在输出里')
    assert.deepEqual([...tags.get(hit)], ['OK-ENDPOINT'], '该地址只许出现在 OK 一类里')
    assert.match(green.stdout, /产品端点优先/, '要把「为什么归这一类」打印出来（不许只给结论）')
    assert.match(green.stdout, /feedbackUrl/, '要说出它同时也登记在哪个旧池字段')
  } finally {
    work.cleanup()
  }
})

test('T11b 去重断言自检：同一地址落进两类时 summarize 直接抛，绝不输出自相矛盾的报告', () => {
  const base = { kind: 'ip-host', file: 'a.js', host: '10.1.1.1', port: 7101, allowed: false, detail: '', why: '' }
  const wrap = (hits) => [{ stats: {}, skips: {}, hits }]

  assert.throws(
    () =>
      summarize(
        wrap([
          { ...base, token: 'http://10.1.1.1:7101/v1', className: CLASS.ENDPOINT },
          { ...base, token: 'http://10.1.1.1:7101/v2', className: CLASS.LEGACY },
        ])
      ),
    /分类自相矛盾/,
    '同一 (host, port) 落进两类必须抛（否则报告自相矛盾，读的人不知道信哪一行）'
  )

  // 正向对照：全落同一类时不抛，且计数对得上
  const ok = summarize(
    wrap([
      { ...base, token: 'http://10.1.1.1:7101/v1', className: CLASS.ENDPOINT },
      { ...base, token: 'http://10.1.1.1:7101/v2', className: CLASS.ENDPOINT },
    ])
  )
  assert.equal(ok.counts[CLASS.ENDPOINT], 2, '同一类的两条要各自计数（去重只跨类，不在类内合并不同 token）')
  assert.equal(ok.counts[CLASS.LEGACY], 0)
  assert.equal(ok.denied.length, 0, '产品端点不算红')
})
