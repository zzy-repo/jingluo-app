/**
 * #596：测试里「本机已经领到服务端那把 Key」的落盘形态。
 *
 * 为什么要它：从 #596 起，「我们的渠道」的 Key **只能由服务端下发** —— 只写
 * `chat-demo:api-key` 会被发送前守卫判成 `unclaimed`（本机那把没有下发标记）并拦下。
 * 这是**产品的正确行为**（也正是本单要的），所以任何「在 ours 渠道里发消息」的 L1/L2 用例，
 * 环境准备都必须和真实路径一致：Key + 下发标记一起写。否则红的是用例的种子数据，不是产品。
 *
 * 指纹用**真实现**（`src/services/invite/keyIdentity.ts`）：手抄一份 djb2 会在实现变化时
 * 悄悄失配，症状是「产品把一把好 Key 拦了」——那种红最难查。本仓的 `.js` 说明符指向 `.ts`
 * 源码，裸 Node 解析不到，所以借 `tests/helpers/dom-env.mjs` 的解析 hook（与单测、黄金用例
 * 同一套装配；装载它顺带把 `__ENDPOINTS__` 等注入值挂上，对 L1 进程无副作用）。
 */
import { installTsResolve } from './dom-env.mjs'

installTsResolve()
const { keyFingerprint } = await import('../../src/services/invite/keyIdentity.ts')

/** 一条下发标记（与 `apiConfig.markServerKey` 的存储形态一致：只含指纹 / 尾号 / 时间 / id） */
export const oursServerKeyMark = (apiKey, id = 1) => ({
  fingerprint: keyFingerprint(apiKey),
  tail: apiKey.trim().slice(-4),
  at: 1_700_000_000_000,
  id,
})

/** 已领取形态的存储项，可直接摊进 `openGoldenPage({ storage })` 一类的选项 */
export const claimedOursStorage = (apiKey, id = 1) => ({
  'chat-demo:api-key': apiKey,
  'chat-demo:ours-server-key': JSON.stringify(oursServerKeyMark(apiKey, id)),
})

/**
 * 页内种入「已领取」的 Key（**不改渠道**）：给那些「渠道由构建/用例自己决定」的 L1 用例用。
 * 内测构建的默认渠道就是 ours，切渠道会把用例的前提改掉。
 */
export const seedClaimedApiKey = async (page, apiKey, id = 1) => {
  await page.evaluate(
    ([key, mark]) => {
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:ours-server-key', mark)
    },
    [apiKey, JSON.stringify(oursServerKeyMark(apiKey, id))]
  )
}

/** 页内种入：渠道 = 我们的渠道 + 已领取的 Key 与标记 */
export const seedClaimedOursKey = async (page, apiKey, id = 1) => {
  await page.evaluate(
    ([key, mark]) => {
      window.localStorage.setItem('chat-demo:provider-kind', 'ours')
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:ours-server-key', mark)
    },
    [apiKey, JSON.stringify(oursServerKeyMark(apiKey, id))]
  )
}
