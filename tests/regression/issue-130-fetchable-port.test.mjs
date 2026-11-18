// [layer: regression | 依赖: 无（本机回环 socket，不联网） | Issue #130（关联 #9 / #24）]
//
// 回归对象：挑端口的口径——tests/helpers/ports.mjs。
//
// 修复前症状（#130）：测试里用随机端口监听，撞上 fetch 层的"禁用端口表"
//   （1719/1723/6665-6669/10080 …）时，请求还没发出就被 undici 拒掉，
//   用例表现成"业务失败"，让人以为产品坏了。
// 修复后预期：被判死的端口一个都不许用来监听；listenFetchablePort 遇到禁用端口当场拒绝，
//   listenFreePort 会换端口重试，最终落到一个 fetch 真能连的端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { isFetchUsablePort, listenFetchablePort, listenFreePort } = await import('../helpers/ports.mjs')

test('#130 禁用端口表必须判死（撞上它们 = 用例假红）', () => {
  for (const port of [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6679, 6697, 10080]) {
    assert.equal(isFetchUsablePort(port), false, `${port} 会让 fetch 直接拒连`)
  }
  for (const port of [6665, 6666, 6667, 6668, 6669]) {
    assert.equal(isFetchUsablePort(port), false, `${port} 属于 IRC 段，同样被禁`)
  }
})

test('#130 可被监听的普通端口是允许的；0 / 特权端口 / 越界端口不算', () => {
  for (const port of [1024, 8080, 18080, 49152]) {
    assert.equal(isFetchUsablePort(port), true, `${port} 应该可用`)
  }
  for (const port of [0, 80, 443, 1023, 65536, -1, 1.5, Number.NaN]) {
    assert.equal(isFetchUsablePort(port), false, `${port} 不该被当成可用端口`)
  }
})

test('#130 listenFetchablePort 遇到禁用端口直接拒绝，不留一个连不上的监听', async () => {
  const server = createServer(() => {})
  await assert.rejects(() => listenFetchablePort(server, 1723), /bad port/i)
  await assert.rejects(() => listenFetchablePort(server, 0), /bad port/i)
  server.close()
})

test('#130 listenFreePort 会跳过不可用端口，最终落在 fetch 能连的端口上', async () => {
  const server = createServer((_request, response) => response.end('ok'))
  let calls = 0
  const port = await listenFreePort(server, {
    choosePort: () => {
      calls += 1
      return calls <= 3 ? 1723 : 0 // 前几次都给禁用端口：helper 必须丢掉重来
    },
  })
  assert.equal(isFetchUsablePort(port), true, `最终端口 ${port} 必须能被 fetch 连接`)
  assert.equal(port === 1723, false)
  assert.ok(calls >= 4, '撞到坏端口必须重绑，而不是把坏端口交出去')
  const response = await fetch(`http://127.0.0.1:${port}/ping`)
  assert.equal(await response.text(), 'ok')
  await new Promise((resolve) => server.close(resolve))
})
