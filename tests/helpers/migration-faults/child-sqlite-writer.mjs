// [child process | 依赖: node:sqlite | 只被 killproc.mjs 以子进程方式启动]
//
// #923：真实 node:sqlite 上的「分块 BLOB 写入」子进程。父进程在**精确的保持点**对它发 SIGKILL。
// 保持点协议：到达某个点时先把一行 `HOLD <name>` 同步写到 stdout，再用 Atomics.wait 阻塞最多 60s 等死。
// 父进程读到目标 HOLD 行后立刻 kill -9，所以「杀在哪里」是确定的，不靠计时碰运气。
//
// 参数（argv[2] 的 JSON）：
//   dbPath, synchronous('FULL'|'NORMAL'|'OFF'), blobs, chunksPerBlob, chunkBytes,
//   mode: 'tx'    每个 blob 一个事务：header + 全部 chunk 同一事务提交（正确写法）
//         'split' 反例：header 与每个 chunk 各自自动提交（不原子），用来证明读回检查能抓到残缺 BLOB
//   holdAt: 保持点名字，如 'blob3:chunk2:inserted'、'blob3:precommit'、'blob3:committed'、'blob3:header'
import { writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const cfg = JSON.parse(process.argv[2])
const db = new DatabaseSync(cfg.dbPath)
db.exec('PRAGMA journal_mode=WAL')
db.exec(`PRAGMA synchronous=${cfg.synchronous ?? 'FULL'}`)
db.exec('PRAGMA busy_timeout=5000')
db.exec(`CREATE TABLE IF NOT EXISTS blob_head(id TEXT PRIMARY KEY, total_len INTEGER NOT NULL, sha256 TEXT NOT NULL, chunks INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blob_chunk(id TEXT NOT NULL, idx INTEGER NOT NULL, len INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(id, idx));
CREATE TABLE IF NOT EXISTS progress(k TEXT PRIMARY KEY, v INTEGER NOT NULL);`)

const effective = {
  journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
  synchronous: db.prepare('PRAGMA synchronous').get().synchronous, // 0 OFF 1 NORMAL 2 FULL 3 EXTRA
}
writeSync(1, `CONFIG ${JSON.stringify(effective)}\n`)

const hold = (name) => {
  if (cfg.holdAt !== name) return
  writeSync(1, `HOLD ${name}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  writeSync(1, 'TIMEOUT\n') // 没被杀：父进程会判失败
}

// 确定性内容：与父进程的期望使用同一函数（父进程里有独立的第二份实现，见 killproc.mjs 的 expectedChunk）
export const chunkBytes = (blobIdx, chunkIdx, len) => {
  const out = Buffer.allocUnsafe(len)
  let x = (blobIdx * 2654435761 + chunkIdx * 40503 + 12345) >>> 0
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out[i] = x >>> 24
  }
  return out
}

for (let b = (cfg.skip ?? 0) + 1; b <= cfg.blobs; b++) {
  const id = `blob${b}`
  const chunks = Array.from({ length: cfg.chunksPerBlob }, (_, i) => chunkBytes(b, i, cfg.chunkBytes))
  const whole = createHash('sha256')
  for (const c of chunks) whole.update(c)
  const head = [id, cfg.chunksPerBlob * cfg.chunkBytes, whole.digest('hex'), cfg.chunksPerBlob]
  const insChunk = db.prepare('INSERT INTO blob_chunk(id, idx, len, sha256, data) VALUES (?,?,?,?,?)')
  const insHead = db.prepare('INSERT INTO blob_head(id, total_len, sha256, chunks) VALUES (?,?,?,?)')
  const insChunkRow = (i) => insChunk.run(id, i, chunks[i].length, createHash('sha256').update(chunks[i]).digest('hex'), chunks[i])
  if (cfg.mode === 'split') {
    insChunkRow(0)
    hold(`${id}:chunk0:inserted`)
    for (let i = 1; i < chunks.length; i++) {
      insChunkRow(i)
      hold(`${id}:chunk${i}:inserted`)
    }
    insHead.run(...head)
    hold(`${id}:committed`)
    continue
  }
  db.exec('BEGIN IMMEDIATE')
  insHead.run(...head)
  hold(`${id}:header`)
  for (let i = 0; i < chunks.length; i++) {
    insChunkRow(i)
    hold(`${id}:chunk${i}:inserted`)
  }
  db.prepare('INSERT INTO progress(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('lastBlob', b)
  hold(`${id}:precommit`)
  db.exec('COMMIT')
  writeSync(1, `COMMITTED ${id}\n`)
  hold(`${id}:committed`)
}
writeSync(1, 'DONE\n')
db.close()
