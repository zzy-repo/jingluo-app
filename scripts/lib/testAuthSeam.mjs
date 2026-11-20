// 登录接缝（test auth seam）的**唯一事实来源** —— Issue #487 W1-B 后半（#510）。
//
// ## 这是什么
//
// `src/components/auth/AuthGate.tsx` 里有一句 `__TEST_AUTH_STATE__` 的**构建期常量**读取：
// 有值时直接进已登录态（不读盘、不续期、不调 `me()`），没有值时就是原来那条路。
// 这里是那个常量的取值、形状与「产物里许不许出现」的唯一出处 —— rspack 的 DefinePlugin、
// 构建后的自动扫描（`scripts/build.mjs`）、门禁（`scripts/check-test-seam.mjs`）与单测
// （`tests/unit/auth-seam.test.mjs`）都读这一份，免得「注入的会话长什么样」在四处各抄一遍。
//
// ## 为什么生产安全
//
// 1. **默认（生产）构建注入 `undefined`**：`pnpm build` / `pnpm build:internal` 都不带
//    `TEST_AUTH_SEAM=1`，DefinePlugin 把标识符内联成 `undefined`，于是
//    `typeof __TEST_AUTH_STATE__ !== 'undefined' ? … : undefined` 折叠成 `undefined`、
//    守卫整段被死代码消除 —— 线上产物里既没有这个会话，也没有「读到某个标记就放行」的分支。
// 2. **没有运行期开关**：AuthGate **不读** `globalThis` / URL 参数 / localStorage 标记。
//    线上就算有人在控制台里写 `window.__TEST_AUTH_STATE__ = …` 也没有任何代码去读它
//    （`tests/unit/auth-seam.test.mjs` 有一条源码断言专门钉这件事）。
// 3. **产物扫描兜底**：只要有人误把 `TEST_AUTH_SEAM=1` 带进发版构建，
//    `scripts/build.mjs`（每次构建后自扫）与 `scripts/check-test-seam.mjs`（CI 门禁）都会在
//    `dist/` 里扫到下面的标记并判红。
//
// ## 谁能开
//
// 只有**测试构建**：黄金回归与 L1 需要「启动即进主界面」的用例，CI 里那两步构建带
// `TEST_AUTH_SEAM=1`（见 `.github/workflows/ci.yml`）。发版构建一律不带。

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 环境变量名：唯一开关（`TEST_AUTH_SEAM=1` 才注入假会话） */
export const SEAM_FLAG = 'TEST_AUTH_SEAM'

/** 假访问凭据：**一眼假**的字符串，故意做成不可能是合法 JWT 的样子 */
export const SEAM_ACCESS_TOKEN = 'test-token-not-real'

/**
 * 注入给 `__TEST_AUTH_STATE__` 的假会话（形状见 `src/components/auth/AuthGate.tsx` 的 `TestAuthState`）。
 * `id: 0` 与 `.invalid` 域名同样是「一眼假」。
 */
export const SEAM_SESSION = Object.freeze({
  accessToken: SEAM_ACCESS_TOKEN,
  user: Object.freeze({
    id: 0,
    email: 'seam@test.invalid',
    username: '',
    role: 'user',
    emailVerified: true,
  }),
})

/**
 * 产物里**不许出现**的标记（#510 的安全底线）。
 *
 * - `__TEST_AUTH_STATE__`：DefinePlugin 没定义它时源码标识符会被原样留在产物里 → 说明这条构建
 *   路径漏了注入，「运行期读全局变量」的兜底写法也可能趁虚而入；
 * - 假 token：真值被编译进产物 = 接缝被打开了。
 */
export const SEAM_MARKERS = Object.freeze(['__TEST_AUTH_STATE__', SEAM_ACCESS_TOKEN])

/** 这次构建要不要打开接缝（缺省关闭；只认 `1` / `true`） */
export const seamEnabled = (env = process.env) => {
  const raw = String(env[SEAM_FLAG] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/** 只扫文本型产物：二进制（字体 / 图标）装不下这段代码，扫了只是浪费门禁时间 */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.txt', '.svg'])

/**
 * 在目录里找接缝标记，返回命中清单 `[{ file, marker }]`。
 *
 * 目录不存在按「没有命中」处理，由调用方决定这是不是错（构建后扫描一定存在；门禁脚本另有存在性检查）。
 */
export const scanForSeam = (dir) => {
  const hits = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue
      }
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const marker = SEAM_MARKERS.find((candidate) => text.includes(candidate))
      if (marker !== undefined) {
        hits.push({ file: full, marker })
      }
    }
  }
  walk(dir)
  return hits
}
