/**
 * 正文内联 `路径:行` 引用的**自检**辅助（#946）。
 *
 * 背景：`docs/capabilities/*.md` 里有两类机器可读的 `文件:行`：
 *   1. 生成器自己产出的**明细表**单元格（`| \`src/x.ts:12\` | 假设内容 | … |`）；
 *   2. 人在正文里写的**内联引用**（`src/x.ts:12 ⇒ 这段代码`）。
 * `gen-capabilities-docs.mjs` 只重锚第 1 类，第 2 类它一个都不碰、`--check` 也不看 ——
 * 2026-11-27 #944 往 `collector.ts` 插 10 行，12 处内联引用集体 +10，`--check` 打印
 * 「✔ 三份表与实时复算一致」，而 `check:doc-refs` 红 12 条把 CI 焊死在第一个失败步骤。
 *
 * 这里**不放判定逻辑**（判据只有 `check-doc-refs.mjs` 一份，第二套口径正是两边打架的来源）：
 * 只放两个纯函数 —— 从门禁的 JSON 里挑出 capabilities 文档的硬失败、规划「能唯一定位就自动重锚」
 * 的编辑清单。生成器负责跑门禁与写盘，本模块可被单测直接覆盖（不扫仓库、无 IO）。
 */

/** capabilities 文档在仓库里的相对前缀。 */
export const CAPABILITY_DOC_PREFIX = 'docs/capabilities/'

/**
 * 「同一段代码被插行 / 删行挤走」的最大距离。超过它就不再当作漂移：
 * 那是代码搬家或符号重名，自动改行号等于猜。
 */
export const PLAUSIBLE_DRIFT_LINES = 200

/**
 * 从 `check-doc-refs.mjs --json` 的 `fails[]` 里挑出 `docs/capabilities/` 下的硬失败。
 *
 * 只看前缀、不改判据：门禁说红的就是红的，生成器不自作主张放行任何一条。
 */
export const filterCapabilityDocFails = (fails, prefix = CAPABILITY_DOC_PREFIX) =>
  (fails ?? []).filter((fail) => typeof fail?.doc === 'string' && fail.doc.startsWith(prefix))

/** 从 `路径:916` 这类引用里取行号；取不到返回 `null`（没有行号的引用交给门禁的其它判据）。 */
export const lineOf = (raw) => {
  const matched = typeof raw === 'string' ? raw.match(/:(\d+)$/u) : null
  return matched ? Number(matched[1]) : null
}

/**
 * 规划「能唯一定位就自动重锚」的编辑清单。
 *
 * 只处理 `kind === 'content-mismatch'`（文档声明了「这一行是 X」，而它不在这一行了）：
 * 把 `expect`（文档里写的原文）拿到目标文件里找，**只要它落在原行号附近（±`PLAUSIBLE_DRIFT_LINES`）
 * 且窗口内唯一**就改行号。窗口外的不动 —— 那是「这段代码搬到别处了 / 符号重名了」，
 * 得人重新论证锚点，自动改反而是猜（`Capacitor.registerPlugin` 这类同名调用就是活例子）。
 *
 * @param {Array<object>} fails `check-doc-refs --json` 的 `fails`
 * @param {(target: string) => string | null} readTarget 读取仓库相对路径的文本，读不到返回 `null`
 * @param {string} [prefix] 只处理这些文档
 * @returns {Array<{doc: string, docLine: number, from: string, to: string, targetLine: number}>}
 */
export const planInlineRefFixes = (fails, readTarget, prefix = CAPABILITY_DOC_PREFIX) => {
  const edits = []
  const seen = new Set()
  for (const fail of fails ?? []) {
    if (fail?.kind !== 'content-mismatch') continue
    if (typeof fail.doc !== 'string' || !fail.doc.startsWith(prefix)) continue
    const expect = typeof fail.expect === 'string' ? fail.expect.trim() : ''
    const raw = typeof fail.raw === 'string' ? fail.raw : ''
    const target = typeof fail.target === 'string' ? fail.target : ''
    const docLine = Number(fail.docLine)
    if (!expect || !raw || !target || !Number.isInteger(docLine) || lineOf(raw) === null) continue
    const text = readTarget(target)
    if (typeof text !== 'string') continue
    const current = lineOf(raw)
    const hits = []
    text.split('\n').forEach((line, index) => {
      const at = index + 1
      if (line.trim() === expect && Math.abs(at - current) <= PLAUSIBLE_DRIFT_LINES) hits.push(at)
    })
    // 窗口内找不到 / 不唯一：不猜
    if (hits.length !== 1) continue
    const key = `${fail.doc}\u0000${docLine}\u0000${raw}`
    if (seen.has(key)) continue
    seen.add(key)
    edits.push({
      doc: fail.doc,
      docLine,
      from: raw,
      to: raw.replace(/:\d+$/u, `:${hits[0]}`),
      targetLine: hits[0],
    })
  }
  return edits
}

/**
 * 把**同一行**的若干处编辑一次落到文档行上：只替换那些引用的行号，同一行里的其它引用原样保留。
 *
 * 必须一次算完、按位置切片，不能一条条 `split/join`：先改的会造出后改的 `from`
 * （文档里同时有 `x.ts:10` 和 `x.ts:20` 时，把 10 改成 20 之后，第二处编辑就会把**两处**都改掉），
 * 结果是把另一条引用顺手改错。同一位置多处命中取**最长**的那条（`x.ts:1` 是 `x.ts:10` 的前缀）。
 *
 * @returns {{text: string, applied: number} | null} 一处都没命中返回 `null`（文档已被别人改过）
 */
export const applyInlineRefEdits = (line, edits) => {
  if (typeof line !== 'string' || !Array.isArray(edits) || edits.length === 0) return null
  const byFrom = edits.filter((edit) => edit?.from && edit.to)
  let out = ''
  let applied = 0
  let index = 0
  while (index < line.length) {
    let matched = null
    for (const edit of byFrom) {
      if (!line.startsWith(edit.from, index)) continue
      if (matched === null || edit.from.length > matched.from.length) matched = edit
    }
    if (matched === null) {
      out += line[index]
      index += 1
      continue
    }
    out += matched.to
    index += matched.from.length
    applied += 1
  }
  return applied > 0 ? { text: out, applied } : null
}

/** 单处编辑的便捷包装：只替换那一条引用的行号，没命中返回 `null`。 */
export const applyInlineRefEdit = (line, edit) => applyInlineRefEdits(line, [edit])?.text ?? null
