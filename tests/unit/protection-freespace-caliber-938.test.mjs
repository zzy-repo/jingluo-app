// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #938（第二点）：低空间阈值的**口径校准**。`FREE_SPACE_MIN_BYTES = 64MiB` 比的是
// `StatFs.getAvailableBytes()`（ext4 的 `f_bavail`），不是 `df` / `getFreeBytes()`（`f_bfree`）。
//
// #910 实测（同一台设备）：
//   应用可见 = 0（`f_bavail = 0`，已经写不进去：`ping()` 报 no space left、`SET_UP_METADATA`）时，
//   `f_bfree` / `df` 仍显示 16MB~139MB —— 差值就是 ext4 的 root 保留块。
// 结论（本文件钉住）：**口径只能取应用可见的 `f_bavail`**。
//   · 换成 `f_bfree` / `df`：会在「一个字都写不进去」的那一刻显示还有上百 MB，
//     横幅恰好在最该报警的时候沉默；
//   · 阈值本身就是那个可调旋钮（`FREE_SPACE_MIN_BYTES`，改数字只改 constants.ts 一处）。
//
//   [C1] 阈值边界：阈值-1 → low；恰好阈值 → ok；0 → low（0 永远不是 ok）
//   [C2] 口径：`f_bfree` 很大而 `f_bavail = 0` 的实测场景 → 仍判 low（不许读 df 的口径）
//   [C3] `refreshFreeSpace()`：绕开 10s 缓存立刻重读，刷新值同时替换缓存
//   [C4] 刷不出来（抛错 / 非法值）→ unknown，不得当成「空间够」
//
// 负向对照：把 `measure()` 改成读 `f_bfree`（或把 `<` 改成 `<=`）→ C1/C2 红；
// 把 `refresh()` 实现成直接返回缓存值 → C3 红。
//
//   node tests/run-layer.mjs unit --only protection-freespace-caliber-938
//   node --test tests/unit/protection-freespace-caliber-938.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadProtection, setupProtection } from '../helpers/protection-env.mjs'

const P = await loadProtection()
const { createFreeSpace, resetProtectionDiagnosticsForTests, FREE_SPACE_MIN_BYTES, FREE_SPACE_CACHE_MS } = P
const MiB = 1024 * 1024

/** 只暴露「应用可见的可用字节」的 fs 替身；`dfFreeBytes` 故意存在，用来证明没人去读它 */
const fsWithCaliber = ({ f_bavail, f_bfree }) => {
  const reads = []
  return {
    reads,
    supported: true,
    freeBytes: async () => {
      reads.push('f_bavail')
      return f_bavail
    },
    /** 模拟 `df` / `StatFs.getFreeBytes()`：含 root 保留块，不是本进程能用的字节数 */
    dfFreeBytes: async () => {
      reads.push('f_bfree')
      return f_bfree
    },
  }
}

const spaceOf = (fs) =>
  createFreeSpace({ fs, storage: undefined, now: () => 1_700_000_000_000, local: undefined })

test('C #938 低空间阈值口径：按应用可见的 f_bavail 判，阈值边界不许抖', async (t) => {
  await t.test('C1 阈值边界：阈值-1 → low；恰好阈值 → ok；0 → low', async () => {
    assert.equal(FREE_SPACE_MIN_BYTES, 64 * MiB, '默认阈值 64MiB：改它就要同步改本用例的期望')
    const at = async (bytes) => (await spaceOf(fsWithCaliber({ f_bavail: bytes, f_bfree: bytes })).check()).status
    assert.equal(await at(FREE_SPACE_MIN_BYTES - 1), 'low')
    assert.equal(await at(FREE_SPACE_MIN_BYTES), 'ok', '恰好等于阈值算够（原口径不变）')
    assert.equal(await at(0), 'low', '一个字节都写不进去时永远不是 ok')
  })

  await t.test('C2 f_bfree ≫ f_bavail（ext4 保留块）：满盘必须判 low，不许按 df 的口径', async () => {
    // 实测三种形态（#910 评论 7209936829）：(f_bfree, f_bavail, 期望状态)
    const measured = [
      { f_bfree: 139 * MiB, f_bavail: 0, expect: 'low', note: '满盘：保留块仍算 free，应用可见 = 0' },
      { f_bfree: 139 * MiB + 57 * MiB, f_bavail: 57 * MiB, expect: 'low', note: '实测 57.9MB 时可写、横幅已亮' },
      { f_bfree: 139 * MiB + 512 * MiB, f_bavail: 512 * MiB, expect: 'ok', note: '腾出空间后两个口径都够' },
    ]
    for (const row of measured) {
      const fs = fsWithCaliber(row)
      const result = await spaceOf(fs).check()
      assert.equal(result.status, row.expect, row.note)
      assert.equal(result.freeBytes, row.f_bavail, '报出去的字节数必须是应用可见的那个数（不是 df 的数）')
      assert.deepEqual(fs.reads, ['f_bavail'], '口径只能是 f_bavail：读 f_bfree 会在满盘时误判成「还够」')
    }
    // 反证：第一行如果按 f_bfree 比阈值，会判成「空间足够」—— 正是本单要否掉的口径
    assert.ok(measured[0].f_bfree > FREE_SPACE_MIN_BYTES, '按 df 口径 139MB > 64MB 会判 ok，而实际一个字都写不进去')
  })

  await t.test('C3 refreshFreeSpace()：绕开 10s 缓存立刻重读，并替换缓存值', async () => {
    const env = setupProtection(P, { freeBytes: FREE_SPACE_MIN_BYTES * 4 })
    const first = await env.protection.checkFreeSpace()
    assert.equal(first.status, 'ok')

    // 下一次写满：还在 10s 缓存窗口里，普通 check 拿到的仍是旧值
    env.fs.freeBytes = async () => 0
    env.now.value += FREE_SPACE_CACHE_MS - 1000
    assert.equal((await env.protection.checkFreeSpace()).status, 'ok', '缓存窗口内不跨桥（原有行为不变）')

    // 写失败后调用：不看缓存，立刻重读
    const refreshed = await env.protection.refreshFreeSpace()
    assert.equal(refreshed.status, 'low', '刷新必须读到现实（0 字节）')
    assert.equal(refreshed.freeBytes, 0)
    assert.equal((await env.protection.checkFreeSpace()).status, 'low', '刷新值要顶掉缓存，别让下一次 check 又回旧值')
  })

  await t.test('C4 刷不出来 → unknown（不得当成「空间够」），且不抛', async () => {
    resetProtectionDiagnosticsForTests()
    const fs = fsWithCaliber({ f_bavail: 0, f_bfree: 0 })
    fs.freeBytes = async () => {
      throw new P.FsError('unavailable', 'injected')
    }
    assert.deepEqual(await spaceOf(fs).refresh(), { status: 'unknown' })
    const bad = fsWithCaliber({ f_bavail: Number.NaN, f_bfree: 0 })
    assert.deepEqual(await spaceOf(bad).refresh(), { status: 'unknown' })
  })
})
