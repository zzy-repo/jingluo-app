/**
 * public-artifact-redaction.test.mjs —— `check:public-artifact-redaction` 的负向对照（Issue #745 第 3 步）。
 *
 * 被测的是「**产物里有没有内网地址**」这条判据本身。它守的东西看不见摸不着（bundle 里一句
 * `http://<内网IP>:<高位端口>`），一旦判宽了就永远不会红，所以这里**逐条钉住五个方向**：
 *
 *   T1 **内网 IP 必须红**：`http(s)://<IPv4>` 形态出现在产物里 → exit 1，且点名到 config 字段。
 *   T2 **内网端口必须红**：端口表从配置**动态派生**（`allowedPorts` / 配置 URL 的显式端口），
 *      真域名上挂着 7002 → 红；产物里独立写死的 `const PORT = 7002` 同样红。
 *   T3 **允许清单真的起作用**：`--allow-host` + `--allow-port` 双给 → exit 0 并打印放行清单；
 *      **只给主机不给端口 → 仍然红**（否则一条 `--allow-host` 会顺手放过这台机器的所有端口）。
 *   T4 **判不了必须 exit 2**：非 zip / 打不开 / 空目录 / 参数冲突 —— 不知道有没有泄漏 ≠ 没有泄漏。
 *   T5 **不误报**：XML 命名空间（`http://www.w3.org/2000/svg`）与占位域名（`redacted.local`）
 *      跳过并**计数打印**（#678：跳过也必须记账，不许静默）。
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

/** 一份「联调用」的临时端点配置：内网 IP + 两个高位端口，与真实配置无关 */
const TEMP_ENDPOINTS = {
  chatBaseUrl: 'http://10.11.12.13:7001',
  inviteBaseUrl: 'http://10.11.12.13:7002',
  feedbackUrl: 'http://10.11.12.13:7002/feedback',
  legacyHosts: ['10.11.12.13'],
  allowedHosts: ['10.11.12.13'],
  allowedPorts: [7001, 7002],
  download: { primaryBase: 'https://dl.example.test', fallbackBase: 'https://dl.example.test' },
}

// ---------------------------------------------------------------- T1 内网 IP

test('T1 内网 IP：产物里出现 http://<IPv4>:<port> → exit 1 且点名到 config 字段', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000001.js',
      'const base="http://10.11.12.13:7001/v1",other="https://sub2api.rose7.cn";export{base,other};\n'
    )

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK, `内网 IP 必须判红，实际 exit=${red.code}\n${red.stdout}${red.stderr}`)
    assert.match(red.stdout, /\[FAIL\].*http:\/\/10\.11\.12\.13:7001/, '必须逐条点名那个内网地址')
    assert.match(red.stdout, /内网 IP/, '分类要写清是「内网 IP」')
    assert.match(red.stdout, /config\.endpoints\.chatBaseUrl/, '必须点名这个地址出自配置哪个字段')
    assert.match(red.stderr, /发现内网地址/, '最后要有一句人能看懂的结论')
    // 判据不是「有 http:// 就叫红」：同一个产物里的公网域名不许被算进 FAIL
    assert.doesNotMatch(red.stdout, /\[FAIL\][^\n]*sub2api\.rose7\.cn/, '公网域名不许被误判')
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
    assert.match(red.stdout, /\[FAIL\][^\n]*api\.rose7\.cn:7002/, 'URL 形态的端口要逐条点名')
    assert.match(red.stdout, /\[FAIL\][^\n]*\s:7002 →/, '不带 scheme 的 :7002 字面量也要点名')
  } finally {
    work.cleanup()
  }
})

test('T2b 端口表是动态派生的：换一份配置，60010 就不再是问题、7001 才是', () => {
  const work = scratch()
  try {
    // 配置里只登记 7001 这一个端口；bundle 里同时出现 60010 与 7001
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist(
      'main.00000004.js',
      'const a="https://api.rose7.cn:7001/x",b="https://api.rose7.cn:60010/y";export{a,b};\n'
    )

    const red = runGate(['--dist', dist, '--config', config])
    assert.equal(red.code, EXIT.LEAK)
    assert.match(red.stdout, /api\.rose7\.cn:7001/, '在端口表里的必须报')
    assert.doesNotMatch(red.stdout, /\[FAIL\][^\n]*:60010/, '不在端口表里的不许凭「端口长得像」就报')
  } finally {
    work.cleanup()
  }
})

// ---------------------------------------------------------------- T3 允许清单

test('T3 允许清单：--allow-host + --allow-port 双给 → exit 0，且打印放行清单', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist('main.00000005.js', 'const base="http://10.11.12.13:7001/v1";export{base};\n')

    const green = runGate([
      '--dist',
      dist,
      '--config',
      config,
      '--allow-host',
      '10.11.12.13',
      '--allow-port',
      '7001',
    ])
    assert.equal(green.code, EXIT.CLEAN, `显式放行后必须绿，实际 exit=${green.code}\n${green.stdout}${green.stderr}`)
    assert.match(green.stdout, /放行清单/, '放行必须打印清单，不许悄悄放过')
    assert.match(green.stdout, /\[ALLOW\][^\n]*10\.11\.12\.13:7001/, '逐条说明哪一条被放行了')
    assert.match(green.stdout, /仅供联调|正式包不许带/, '文案要写清这些参数不属于正式包')
  } finally {
    work.cleanup()
  }
})

test('T3b 只放行主机、不放行端口 → 仍然红（一条 --allow-host 不许顺手放过所有端口）', () => {
  const work = scratch()
  try {
    const config = work.writeConfig(TEMP_ENDPOINTS)
    const dist = work.writeDist('main.00000006.js', 'const base="http://10.11.12.13:7001/v1";export{base};\n')

    const red = runGate(['--dist', dist, '--config', config, '--allow-host', '10.11.12.13'])
    assert.equal(red.code, EXIT.LEAK, `只放主机必须仍然红，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, /缺 --allow-port 7001/, '要告诉人还差哪一个开关')
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
  const host = raw.allowedHosts[0]
  const port = raw.allowedPorts[0]
  assert.ok(host && port, 'config/endpoints.json 里应当有 allowedHosts / allowedPorts')

  const work = scratch()
  try {
    const dist = work.writeDist(
      'main.00000009.js',
      `const base="http://${host}:${port}/v1";export{base};\n`
    )
    const red = runGate(['--dist', dist])
    assert.equal(red.code, EXIT.LEAK, `真实配置里的内网地址必须判红，实际 exit=${red.code}\n${red.stdout}`)
    assert.match(red.stdout, new RegExp(`http://${host.replace(/\./g, '\\.')}:${port}`), '要点名真实配置里的地址')
    assert.match(red.stdout, /config\/endpoints\.json/, '要么读到了真配置，要么这条断言就成了摆设')
  } finally {
    work.cleanup()
  }
})
