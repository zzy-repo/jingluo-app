/**
 * #596：测试里「本机已经领到服务端那把 Key」的落盘形态。
 *
 * 为什么要它：从 #596 起，「我们的渠道」的 Key **只能由服务端下发** —— 只写
 * `chat-demo:api-key` 会被发送前守卫判成 `unclaimed`（本机那把没有下发标记）并拦下。
 * 这是**产品的正确行为**（也正是本单要的），所以任何「在 ours 渠道里发消息」的 L1/L2 用例，
 * 环境准备都必须和真实路径一致：Key + 下发标记一起写。否则红的是用例的种子数据，不是产品。
 *
 * 指纹用**真实现**（`src/services/invite/keyIdentity.ts`）：手抄一份 djb2 会在实现变化时
 * 悄悄失配，症状是「产品把一把好 Key 拦了」——那种红最难查。
 *
 * **懒加载**（为什么要这样而不是模块顶层 import）：`tests/unit/test-runtime.test.mjs` 会复制一份
 * 「仓库的小型镜像」沙箱 —— 只整目录复制 `tests/helpers` / `scripts` / `config`，**不复制 `src/`**，
 * 再在里面跑两个集成入口。模块顶层就 import `src/**` 会让那种镜像直接
 * `ERR_MODULE_NOT_FOUND`，看起来像「被测入口坏了」（#555 就吃过一次同类亏）。
 * 所以真指纹只在**真的要种数据时**才去取；沙箱里那两个入口在启动浏览器时就停了，永远走不到这里。
 */
let fingerprintOf = null

/** 懒加载真指纹实现（`.js` 说明符 → `.ts`，借 `dom-env.mjs` 的解析 hook） */
const resolveFingerprint = async () => {
  if (fingerprintOf === null) {
    const { installTsResolve } = await import('./dom-env.mjs')
    installTsResolve()
    fingerprintOf = (await import('../../src/services/invite/keyIdentity.ts')).keyFingerprint
  }
  return fingerprintOf
}

/** 一条下发标记（与 `apiConfig.markServerKey` 的存储形态一致：只含指纹 / 尾号 / 时间 / id） */
export const oursServerKeyMark = async (apiKey, id = 1) => {
  const fingerprint = await resolveFingerprint()
  return {
    fingerprint: fingerprint(apiKey),
    tail: apiKey.trim().slice(-4),
    at: 1_700_000_000_000,
    id,
  }
}

/** 已领取形态的存储项，可直接摊进 `openGoldenPage({ storage })` 一类的选项 */
export const claimedOursStorage = async (apiKey, id = 1) => ({
  'chat-demo:api-key': apiKey,
  'chat-demo:ours-server-key': JSON.stringify(await oursServerKeyMark(apiKey, id)),
})

/**
 * 页内种入「已领取」的 Key（**不改渠道**）：给那些「渠道由构建/用例自己决定」的 L1 用例用。
 * 内测构建的默认渠道就是 ours，切渠道会把用例的前提改掉。
 */
export const seedClaimedApiKey = async (page, apiKey, id = 1) => {
  const mark = JSON.stringify(await oursServerKeyMark(apiKey, id))
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:ours-server-key', value)
    },
    [apiKey, mark]
  )
}

/** 页内种入：渠道 = 我们的渠道 + 已领取的 Key 与标记 */
export const seedClaimedOursKey = async (page, apiKey, id = 1) => {
  const mark = JSON.stringify(await oursServerKeyMark(apiKey, id))
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem('chat-demo:provider-kind', 'ours')
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:ours-server-key', value)
    },
    [apiKey, mark]
  )
}
