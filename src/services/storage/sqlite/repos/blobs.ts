/** BlobRepo 的 SQLite 实现。原件字节只经 `../blobStore.ts` 读写。 */
import type { StoredFile } from '../../../chat/db.js'
import type { BlobRepo } from '../../types.js'
import { readBlob } from '../blobStore.js'
import type { Runner } from './context.js'
import { deleteRow, pageKeys, putRow } from './rows.js'

export const createBlobRepo = (runner: Runner): BlobRepo => ({
  get: (id) => runner.direct((ex) => readBlob(ex, 'files', id)),

  putMany: (files) =>
    runner.tx(async (ex) => {
      for (const file of files) {
        await putRow(ex, 'files', file.id, file)
      }
    }),

  listKeys: (query) => runner.direct((ex) => pageKeys(ex, 'files', query)),

  delete: (id) =>
    runner.tx(async (ex) => {
      await deleteRow(ex, 'files', id)
    }),

  clearExcept: (keep) =>
    runner.tx(async (ex) => {
      const keys = [...(await pageKeys(ex, 'files')).items]
      for (const key of keys) {
        if (!keep(key)) {
          await deleteRow(ex, 'files', key)
        }
      }
    }),
})

/** 读一条完整的原件行（`{id, blob}`）。 */
export const readStoredFile = async (runner: Runner, store: 'files' | 'filesStaging', id: string): Promise<StoredFile | undefined> =>
  runner.direct(async (ex) => {
    const blob = await readBlob(ex, store, id)
    return blob === undefined ? undefined : { id, blob }
  })
