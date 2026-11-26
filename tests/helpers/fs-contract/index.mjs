// AppFileSystem 契约（#907）：任何实现（memoryFs / 将来的其他实现）都必须通过。
// 原生实现的同一份契约在 Java 侧没法在 Node 跑，对应真机清单见 docs/fs-device-checklist.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const enc = (text) => new TextEncoder().encode(text)
const dec = (bytes) => new TextDecoder().decode(bytes)

const rejectsPath = async (fn) => {
  await assert.rejects(fn, (error) => error?.name === 'FsPathError')
}

/**
 * @param {{
 *   name?: string,
 *   create: () => any,
 *   injectEnospc?: (fs: any) => void,
 *   injectCrashMidWrite?: (fs: any) => void,
 *   tempFiles?: (fs: any) => string[],
 * }} options  inject* 在调用后让「下一次 writeAtomic」失败；tempFiles 返回残留的内部临时文件
 */
export const runFsContract = ({ name = 'fs', create, injectEnospc, injectCrashMidWrite, tempFiles }) => {
  const t = (title, fn) => test(`[${name}] ${title}`, () => fn(create()))

  t('supported 为 true，freeBytes 为正数或 undefined', async (fs) => {
    assert.equal(fs.supported, true)
    const free = await fs.freeBytes()
    assert.ok(free === undefined || (Number.isFinite(free) && free >= 0))
  })

  t('往返：字符串与二进制', async (fs) => {
    await fs.writeAtomic('a/b.txt', '你好 hello')
    assert.equal(await fs.readText('a/b.txt'), '你好 hello')
    const bytes = new Uint8Array([0, 1, 2, 254, 255])
    await fs.writeAtomic('bin.dat', bytes)
    assert.deepEqual([...(await fs.read('bin.dat'))], [...bytes])
  })

  t('覆盖：第二次写入完全替换第一次', async (fs) => {
    await fs.writeAtomic('x.txt', 'longer-old-content')
    await fs.writeAtomic('x.txt', 'new')
    assert.equal(await fs.readText('x.txt'), 'new')
  })

  t('不存在：read / readText 返回 undefined，remove 不抛', async (fs) => {
    assert.equal(await fs.read('nope.txt'), undefined)
    assert.equal(await fs.readText('nope/deeper.txt'), undefined)
    await fs.remove('nope.txt')
  })

  t('list：形状正确、目录不存在返回 []、只列直接子文件', async (fs) => {
    assert.deepEqual(await fs.list('empty'), [])
    await fs.writeAtomic('d/one.txt', 'abc')
    await fs.writeAtomic('d/two.txt', 'de')
    await fs.writeAtomic('d/sub/three.txt', 'f')
    const entries = await fs.list('d')
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['one.txt', 'two.txt'])
    const one = entries.find((entry) => entry.name === 'one.txt')
    assert.equal(one.size, 3)
    assert.equal(typeof one.modifiedAt, 'number')
    assert.deepEqual(Object.keys(one).sort(), ['modifiedAt', 'name', 'size'])
    assert.deepEqual((await fs.list('')).map((entry) => entry.name), [])
  })

  t('remove 幂等：重复删除不抛，删除后读不到；目录递归删除', async (fs) => {
    await fs.writeAtomic('r/a.txt', '1')
    await fs.writeAtomic('r/b/c.txt', '2')
    await fs.remove('r/a.txt')
    await fs.remove('r/a.txt')
    assert.equal(await fs.read('r/a.txt'), undefined)
    await fs.remove('r')
    assert.equal(await fs.read('r/b/c.txt'), undefined)
    assert.deepEqual(await fs.list('r'), [])
  })

  t('路径拒绝：.. / 绝对路径 / 空段 / 空串 / NUL / 反斜杠，且先于任何 I/O', async (fs) => {
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a/', '', 'a\0b', 'a\\b', './a']) {
      await rejectsPath(() => fs.writeAtomic(bad, 'x'))
      await rejectsPath(() => fs.read(bad))
      await rejectsPath(() => fs.readText(bad))
      await rejectsPath(() => fs.remove(bad))
    }
    await rejectsPath(() => fs.list('../x'))
    await rejectsPath(() => fs.list('/abs'))
    assert.deepEqual(await fs.list(''), [])
  })

  t('内部临时文件后缀不能被调用方命名', async (fs) => {
    await rejectsPath(() => fs.writeAtomic('a.fstmp', 'x'))
  })

  t('二进制与大文件：5MB 往返逐字节一致', async (fs) => {
    const big = new Uint8Array(5 * 1024 * 1024)
    for (let index = 0; index < big.length; index += 1) {
      big[index] = (index * 31 + 7) & 0xff
    }
    await fs.writeAtomic('big/blob.bin', big)
    const back = await fs.read('big/blob.bin')
    assert.equal(back.length, big.length)
    assert.ok(Buffer.compare(Buffer.from(back), Buffer.from(big)) === 0)
    assert.equal((await fs.list('big'))[0].size, big.length)
  })

  t('read 返回副本：改动返回值不影响存储', async (fs) => {
    await fs.writeAtomic('copy.bin', new Uint8Array([1, 2, 3]))
    const first = await fs.read('copy.bin')
    first[0] = 99
    assert.equal((await fs.read('copy.bin'))[0], 1)
  })

  if (injectCrashMidWrite) {
    t('原子性：写到一半崩溃 → 旧内容完好、无残留临时文件', async (fs) => {
      await fs.writeAtomic('p/state.json', 'OLD-CONTENT')
      injectCrashMidWrite(fs)
      await assert.rejects(() => fs.writeAtomic('p/state.json', 'NEW-CONTENT-LONGER-THAN-OLD'))
      assert.equal(await fs.readText('p/state.json'), 'OLD-CONTENT')
      assert.deepEqual((await fs.list('p')).map((entry) => entry.name), ['state.json'])
      if (tempFiles) {
        assert.deepEqual(tempFiles(fs), [])
      }
      await fs.writeAtomic('p/state.json', 'AFTER')
      assert.equal(await fs.readText('p/state.json'), 'AFTER')
    })

    t('原子性：首次写入崩溃 → 目标不存在、无残留', async (fs) => {
      injectCrashMidWrite(fs)
      await assert.rejects(() => fs.writeAtomic('fresh.txt', 'data'))
      assert.equal(await fs.read('fresh.txt'), undefined)
      assert.deepEqual(await fs.list(''), [])
      if (tempFiles) {
        assert.deepEqual(tempFiles(fs), [])
      }
    })
  }

  if (injectEnospc) {
    t('ENOSPC → FsError.kind=quota，旧内容完好、无残留临时文件', async (fs) => {
      await fs.writeAtomic('q/data.bin', 'OLD')
      injectEnospc(fs)
      await assert.rejects(
        () => fs.writeAtomic('q/data.bin', new Uint8Array(1024)),
        (error) => error?.name === 'FsError' && error.kind === 'quota'
      )
      assert.equal(await fs.readText('q/data.bin'), 'OLD')
      assert.deepEqual((await fs.list('q')).map((entry) => entry.name), ['data.bin'])
      if (tempFiles) {
        assert.deepEqual(tempFiles(fs), [])
      }
    })
  }
}
