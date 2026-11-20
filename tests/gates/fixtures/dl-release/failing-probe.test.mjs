// 负向对照 fixture（Issue #415 / #369）——`test:dl-release` 的必错输入：**一条真的会红的用例**。
//
// 本文件被整体拷到 `deploy/dl-release/test/__gate-neg-dl-release-probe.test.mjs`，于是
// `pnpm run test:dl-release`（= `node --test deploy/dl-release/test/*.test.mjs`）多跑一条必然失败的
// 用例 → 退出码必须非 0。删掉它 → 退出码必须回到 0。
//
// 为什么需要这条对照：这一步是「跑用例」，不是「扫描器」，看起来没有可注入的缺陷 —— 但那正是
// #415 要防的形状：如果 CI 那一步被换成 `pnpm run test:dl-release || true`、被加 `continue-on-error`、
// 或者 glob 被改窄到只剩一个文件，整批 34 条就又回到「红也没人知道」。四拍对照钉住的正是这个。
//
// 注意本目录在 `tests/gates/fixtures/` 下：`check-test-layout` 的 walkTests 会跳过 `fixtures/`，
// 所以它自己不会被当成用例；只有被拷进 deploy/dl-release/test 的那一刻才是「一条会红的用例」。
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('这条用例永远失败（它只是 test:dl-release 的负向对照输入）', () => {
  assert.equal(1, 2, '负向对照：故意红 —— 看到这条断言失败说明 test:dl-release 真的会红')
})
