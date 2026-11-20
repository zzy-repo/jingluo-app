// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// 原生下载的白名单请求头 + 私有下载端点（Issue #639）。
//
// #622 把 JS 侧的私有清单读取做完了，但内测自动更新仍然跑不通：#601 之后私有 APK 已经不在
// 公网 `/apk/…` 里（404），而 `/api/v1/releases/internal/download?file=` 要 `X-DL-Token`，
// 原生 `download()` 却**不带任何头**。本文件钉住三件事：
//
//   1. **选中的条目 → 下载目标**（`downloadTarget`）：internal 条目走带令牌的私有端点，
//      公网条目原样拼 base（规则一字不改）；
//   2. **令牌只进请求头**：不进 URL、不进日志（源码层扫描，同 #622 的做法）；
//   3. **两边契约同值**：JS 的 `PRIVATE_DOWNLOAD_PATH` 与 Java 白名单里的路径必须是同一个
//      字面量 —— 一旦漂移，原生会把「JS 拼出来的地址」判成 INVALID_URL，而错误信息只说
//      「下载失败」，排查成本极高。
//
// 头白名单本身（`X-DL-Token` / `Authorization` 之外一律忽略）在 JVM 侧更该验，那里有真单测：
// `android/app/src/test/java/com/example/deepseekchat/UpdateEndpointTest.java`。这里的静态扫描
// 是给**只跑 JS 测试的 CI** 兜一层底（gradle 单测不在 CI 的必跑路径上）。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

const {
  DEFAULT_RELEASE_BASE,
  PRIVATE_DOWNLOAD_SUFFIX,
  PRIVATE_MANIFEST_TOKEN_HEADER,
  RELEASE_BASES,
  downloadTarget,
  releaseUrl,
} = await loadTsModule('src/services/updateManifest.ts')
const { downloadUpdate } = await loadTsModule('src/services/appUpdate.ts')

/** 注入表的默认值（`tests/helpers/injected.mjs` 装的那份，全部来自 config/endpoints.json） */
const BASE_ENDPOINTS = globalThis.__ENDPOINTS__
/** 私有清单端点：形状对齐 #621 的线上契约（完整路径，不是 base） */
const PRIVATE_URL = 'https://dl.rose7.cn/api/v1/releases/internal'
const PRIVATE_ORIGIN = 'https://dl.rose7.cn'
/** 私有下载端点（= 清单端点 + `/download`，见 #621 的服务端契约；src 里不再抄一份路径字面量） */
const PRIVATE_DOWNLOAD_URL = `${PRIVATE_URL}${PRIVATE_DOWNLOAD_SUFFIX}`
/** 一眼假的令牌：任何断言里出现它都说明它跑到了不该去的地方 */
const TOKEN = 'tok-639-should-stay-in-header'

const INTERNAL_ROW = {
  version: '1.4.0',
  versionCode: 19,
  artifactVariant: 'internal',
  buildType: 'prerelease',
  size: 5_428_086,
  file: 'apk/deepseek-chat-1.4.0-internal.apk',
  changes: ['1.4.0 内测说明'],
  sha256: 'b'.repeat(64),
}
const STANDARD_ROW = {
  version: '1.4.1',
  versionCode: 20,
  artifactVariant: 'standard',
  buildType: 'stable',
  size: 4_000,
  file: 'apk/deepseek-chat-1.4.1.apk',
  changes: ['1.4.1 正式说明'],
  sha256: 'a'.repeat(64),
}

/** 按用例装注入值（`privateManifestConfig` 是懒读的，同进程逐行替换即可，见 #622）。 */
const installPrivate = ({ enabled = true, token = TOKEN, url = PRIVATE_URL } = {}) => {
  globalThis.__ENDPOINTS__ = Object.freeze({
    ...BASE_ENDPOINTS,
    update: Object.freeze({ privateManifest: Object.freeze({ enabled, url, token }) }),
  })
}

const table = (rows) => {
  for (const [id, name, run] of rows) {
    test(`[${id}] ${name}`, run)
  }
}

/** 假原生桥：记下 `download()` 的入参，其余方法够用即可 */
const fakeBridge = () => {
  const downloads = []
  return {
    downloads,
    addListener: async () => ({ remove: async () => {} }),
    cancel: async () => {},
    download: async (options) => {
      downloads.push(options)
      return { cached: false }
    },
  }
}

table([
  [
    'C1',
    '私有条目 → 私有下载端点 + X-DL-Token 请求头（令牌不进 URL）',
    () => {
      installPrivate()
      const target = downloadTarget(INTERNAL_ROW, DEFAULT_RELEASE_BASE)
      assert.equal(
        target.url,
        `${PRIVATE_URL}${PRIVATE_DOWNLOAD_SUFFIX}?file=deepseek-chat-1.4.0-internal.apk`
      )
      assert.deepEqual(target.headers, { [PRIVATE_MANIFEST_TOKEN_HEADER]: TOKEN })
      assert.equal(target.url.includes(TOKEN), false, '令牌不许出现在 URL 里')
    },
  ],
  [
    'C2',
    '公网条目 → 原样拼清单生效的 base，且不带任何头（私有配置开着也一样）',
    () => {
      installPrivate()
      for (const base of RELEASE_BASES) {
        const target = downloadTarget(STANDARD_ROW, base)
        assert.equal(target.url, releaseUrl(STANDARD_ROW.file, base))
        assert.equal(Object.hasOwn(target, 'headers'), false, '公网下载不许带私有头')
      }
    },
  ],
  [
    'C3',
    'internal 条目但私有清单关着 → 回落到公网地址（不假装能下）',
    () => {
      installPrivate({ enabled: false })
      const target = downloadTarget(INTERNAL_ROW, DEFAULT_RELEASE_BASE)
      assert.equal(target.url, releaseUrl(INTERNAL_ROW.file, DEFAULT_RELEASE_BASE))
      assert.equal(Object.hasOwn(target, 'headers'), false)
      // 关着时连「拼私有 URL」这条路都不该走：URL 里不许出现私有端点
      assert.equal(target.url.includes(PRIVATE_DOWNLOAD_URL), false)
    },
  ],
  [
    'C4',
    '文件名不合清单契约（带路径成分）→ INVALID_APK_URL，而不是拼出一个可疑地址',
    () => {
      installPrivate()
      for (const file of [
        'apk/../a.apk',
        'deepseek-chat-1.4.0-internal.apk',
        'apk/sub/a.apk',
        'apk/a.txt',
      ]) {
        assert.throws(
          () => downloadTarget({ ...INTERNAL_ROW, file }, DEFAULT_RELEASE_BASE),
          /INVALID_APK_URL/
        )
      }
    },
  ],
  [
    'C5',
    'downloadUpdate 把 headers 透传给原生桥；公网条目连 headers 字段都不出现',
    async () => {
      installPrivate()
      const privateBridge = fakeBridge()
      await downloadUpdate(
        INTERNAL_ROW,
        new AbortController().signal,
        () => {},
        privateBridge,
        DEFAULT_RELEASE_BASE
      )
      assert.equal(privateBridge.downloads.length, 1)
      assert.deepEqual(privateBridge.downloads[0].headers, {
        [PRIVATE_MANIFEST_TOKEN_HEADER]: TOKEN,
      })
      assert.equal(
        privateBridge.downloads[0].url,
        `${PRIVATE_URL}${PRIVATE_DOWNLOAD_SUFFIX}?file=deepseek-chat-1.4.0-internal.apk`
      )

      const publicBridge = fakeBridge()
      await downloadUpdate(
        STANDARD_ROW,
        new AbortController().signal,
        () => {},
        publicBridge,
        PRIVATE_ORIGIN
      )
      assert.equal(publicBridge.downloads.length, 1)
      assert.equal(Object.hasOwn(publicBridge.downloads[0], 'headers'), false)
      assert.equal(publicBridge.downloads[0].url, releaseUrl(STANDARD_ROW.file, PRIVATE_ORIGIN))
    },
  ],
])

// ---------------------------------------------------------------------------
// 源码层：令牌不进日志 + 三处契约同值
// ---------------------------------------------------------------------------

const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8')
const PLUGIN = 'android/app/src/main/java/com/example/deepseekchat/AppUpdatePlugin.java'
const ENDPOINT = 'android/app/src/main/java/com/example/deepseekchat/UpdateEndpoint.java'

test('C6 源码层：AppUpdatePlugin 的每一行日志都不含令牌 / 头值', () => {
  const lines = read(PLUGIN)
    .split('\n')
    .filter((line) => line.includes('Log.'))
  assert.ok(lines.length > 0, '一条 Log 都没扫到：扫描条件与实现漂移了（断言不能空转）')
  for (const line of lines) {
    const lower = line.toLowerCase()
    assert.equal(lower.includes('token'), false, `日志里出现令牌变量：${line.trim()}`)
    assert.equal(lower.includes('optstring'), false, `日志里回显了头值：${line.trim()}`)
    assert.equal(
      lower.includes('authorization'),
      false,
      `日志里回显了 Authorization：${line.trim()}`
    )
  }
})

test('C7 源码层：头只按白名单写进连接，且写在请求发出之前', () => {
  const source = read(PLUGIN)
  assert.ok(source.includes('UpdateEndpoint.canonicalDownloadHeader('), '没有走白名单判定')
  assert.ok(
    source.includes('UpdateEndpoint.isSafeDownloadHeaderValue('),
    '没有校验头值形状（CRLF 注入）'
  )
  assert.ok(
    source.includes('connection.setRequestProperty(canonical'),
    '没有按白名单的规范头名设置'
  )
  // 负向：不许出现「拿调用方给的原始头名直接设置」
  assert.equal(source.includes('setRequestProperty(name'), false)
  assert.equal(source.includes('setRequestProperty(key'), false)
  const applied = source.indexOf('applyHeaders(call, connection);')
  const sent = source.indexOf('connection.getResponseCode() != 200', applied)
  assert.ok(
    applied > 0 && sent > applied,
    '请求头必须在 getResponseCode() 之前写入（否则等于没带）'
  )
})

test('C8 三处同值：JS 拼出来的 pathname == Java 白名单路径 == #621 的服务端路径', () => {
  installPrivate()
  // 真正的端到端同值：拿 downloadTarget 真的拼一次，取 pathname 与两边的常量比
  const produced = new URL(downloadTarget(INTERNAL_ROW, DEFAULT_RELEASE_BASE).url).pathname
  const javaPath = /PRIVATE_DOWNLOAD_PATH = "([^"]+)"/.exec(read(ENDPOINT))?.[1]
  const serverPath = /PRIVATE_DOWNLOAD_PATH = '([^']+)'/.exec(
    read('deploy/dl-release/server.mjs')
  )?.[1]
  assert.equal(javaPath, '/api/v1/releases/internal/download', 'Java 白名单里的私有下载路径')
  assert.equal(serverPath, javaPath, 'Java 与服务端必须是同一条路径')
  assert.equal(produced, javaPath, 'JS 拼出来的地址必须落在原生白名单的那条路径上')
})

test('C9 源码层：私有路径必须 https-only（令牌走请求头，明文等于泄露）', () => {
  const source = read(ENDPOINT)
  const start = source.indexOf('private static boolean allowsPrivateDownload')
  assert.ok(start > 0, '找不到 allowsPrivateDownload')
  const body = source.slice(start, source.indexOf('\n    }', start))
  assert.ok(body.includes('"https".equals(url.getProtocol())'), '私有下载没有强制 https')
  assert.equal(body.includes('"http".equals'), false, '私有下载放行了明文')
})
