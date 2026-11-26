/** AssetRepo 的 SQLite 实现。`updatedAt` 由实现填（调用方不传时钟）。 */
import type { StoredAsset } from '../../../chat/db.js'
import type { AssetRepo } from '../../types.js'
import type { Runner } from './context.js'
import { deleteRow, getRow, putRow } from './rows.js'

export const createAssetRepo = (runner: Runner): AssetRepo => ({
  get: (key) => runner.direct((ex) => getRow<StoredAsset>(ex, 'appAssets', key)),

  put: (key, blob) =>
    runner.tx(async (ex) => {
      await putRow(ex, 'appAssets', key, { key, blob, updatedAt: Date.now() })
    }),

  delete: (key) =>
    runner.tx(async (ex) => {
      await deleteRow(ex, 'appAssets', key)
    }),
})
