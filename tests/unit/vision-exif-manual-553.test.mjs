// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #553（母单 #548 的 vision-4）：EXIF 方向的**另一半** —— 79 档（引擎不自动应用方向）的手动校正分支。
//
// 为什么单独一个文件、而且要独占进程：`imageSource.probeAutoOrient()` 的探测结果是**模块级缓存**
// （一个进程只探一次，见 PR 说明与 `exif-orientation-findings.md`）。83 档（自动转）在
// `vision-acceptance-553.test.mjs` 里跑；这里把替身切成 79 档，让真实代码走 `orientCanvas()` 那条分支。
// 若两个档混在一个进程，第二个会读到第一个探到的结论 —— 那样两边都不是真的在测。
//
// 两个文件断言的是**同一份期望方向**（`uprightQuadrants(6)`）：
//   - 83 档：引擎已经转好，代码原样画一次 → 结果必须正立；
//   - 79 档：引擎不转，代码手动转一次 → 结果必须正立。
// 两边都正立即「只转一次、没有 90°/180° 错位」在两种内核上都成立（双转会在任一侧露出来）。
//
//   node tests/run-layer.mjs unit --only vision-exif-manual-553
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

installChatHostStubs()

const fake = await import('../helpers/fake-image-dom.mjs')
const imageSource = await fake.loadImageSource()
// 79 档：引擎**不**应用 EXIF 方向（config/compat.json 的 probeTiers 里仍然有 79）
const dom = fake.installFakeImageDom({ autoOrient: false })

const FIXTURES = 'tests/fixtures/vision'
const EXIF6 = ['exif-orientation-6.jpg', 'image/jpeg']
const TINY = ['tiny-64x32.png', 'image/png']
const fixtureBytes = (name) => new Uint8Array(readFileSync(`${FIXTURES}/${name}`))
const blobOf = (name, type) => new Blob([fixtureBytes(name)], { type })
const FIXTURE_QUADRANTS = fake.quadrantColors({
  gridW: 4,
  gridH: 4,
  samples: fake.quadrantGrid(4, 4),
})

test('[1] 79 档：探测结论是「不自动转」，于是手动校正一次后方向正立', async () => {
  assert.equal(
    await imageSource.probeAutoOrient(),
    false,
    '替身模拟 79 档：探测必须报「引擎不应用 EXIF 方向」，否则手动分支永远走不到'
  )
  const stored = imageSource.sniffImage(fixtureBytes(...EXIF6))
  assert.equal(stored.orientation, 6)
  assert.deepEqual([stored.width, stored.height], [4000, 3000], '存储态（未转）尺寸')

  const before = dom.statistics()
  const part = await imageSource.toImagePart(blobOf(...EXIF6))
  const after = dom.statistics()
  assert.equal(part.mediaType, 'image/webp')
  // 方向 6 手动校正会先把长宽对调（3000×4000），再按长边 1568 缩放
  assert.deepEqual([part.width, part.height], [1176, 1568], '手动校正必须改变显示尺寸（未对调 = 没转）')
  assert.deepEqual(
    fake.quadrantColors(fake.readRaster(new Uint8Array(Buffer.from(part.base64, 'base64')))),
    fake.uprightQuadrants(6, FIXTURE_QUADRANTS),
    '象限排列必须是「顺时针 90° 一次」的结果（双转 = 180° 错位，少转 = 仍歪）'
  )
  // 手动校正 = 多一趟 canvas（orientCanvas + 重编码各一张），但只多**一趟**：
  // 多两趟就说明转了两次（典型的「先手动转一遍再被重编码转一遍」的写法）。
  assert.equal(after.toBlobs - before.toBlobs, 1, '只允许一次重编码')
  assert.equal(after.canvases - before.canvases, 2, '手动分支 = 校正画布 + 重编码画布，正好两张')
})

test('[1] 79 档下不超阈值的图仍然原图直发：方向靠 EXIF 标签本身，不动字节', async () => {
  const part = await imageSource.toImagePart(blobOf(...TINY))
  assert.equal(part.mediaType, 'image/png')
  assert.equal(
    Buffer.from(part.base64, 'base64').toString('hex'),
    Buffer.from(fixtureBytes(...TINY)).toString('hex'),
    '直发分支一个字节都不改（EXIF 方向由上游解码器按标签应用）'
  )
})
