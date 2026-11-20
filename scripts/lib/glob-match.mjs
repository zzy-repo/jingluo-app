/**
 * scripts/lib/glob-match.mjs —— 只做 `tests/domain-map.json` 需要的那点 glob 匹配（Issue #409）。
 *
 * 为什么不用 `path.matchesGlob`：它在 Node 22 起才是实验 API，而仓库 engines 写的是 `>=22`，
 * 语义（尤其 `**` 是否跨目录、`**∕` 是否匹配零层）跟着 Node 版本走会变。这份映射要的是**可复现**，
 * 所以把语义写死在这里，并用 `--self-test` 自证：
 *   `**`  跨目录（含零层：`src/**∕*.css` 能匹配 `src/a.css`）
 *   `*`   不跨 `/`
 *   `?`   单个非 `/` 字符
 *   其余字符按字面量
 */

const escape = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

export function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` → 任意层（含零层）；裸 `**` → 任意字符
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += escape(char)
  }
  return new RegExp(`^${out}$`)
}

const cache = new Map()

/** 一个改动路径是否命中一条 source glob（两个方向都按 posix 归一化后比） */
export function matchesGlob(file, pattern) {
  const key = pattern
  let re = cache.get(key)
  if (!re) {
    re = globToRegExp(pattern)
    cache.set(key, re)
  }
  return re.test(file.replace(/\\/g, '/').replace(/^\.\//, ''))
}

/** 把一条用例 glob 展开成真实存在的文件（`files` 是仓库内所有候选用例的相对路径） */
export function expandGlob(pattern, files) {
  return files.filter((file) => matchesGlob(file, pattern))
}

export const SELF_TEST_ROWS = [
  { file: 'src/services/chat/history/urlImport.ts', pattern: 'src/services/chat/history/**', expect: true },
  { file: 'src/services/chat/history/urlImport.ts', pattern: 'src/services/chat/history/*.ts', expect: true },
  { file: 'src/services/chat/history/deep/x.ts', pattern: 'src/services/chat/history/*.ts', expect: false },
  { file: 'src/services/chat/history/deep/x.ts', pattern: 'src/services/chat/history/**', expect: true },
  { file: 'src/styles/a.css', pattern: 'src/**/*.css', expect: true },
  { file: 'src/a.css', pattern: 'src/**/*.css', expect: true },
  { file: 'src/services/chat/autoTitleStream.ts', pattern: 'src/services/chat/autoTitle*.ts', expect: true },
  { file: 'src/services/chat/autoTitle/x.ts', pattern: 'src/services/chat/autoTitle*.ts', expect: false },
  { file: 'tests/unit/a.test.mjs', pattern: 'tests/unit/*.test.mjs', expect: true },
  { file: 'tests/unit/sub/a.test.mjs', pattern: 'tests/unit/*.test.mjs', expect: false },
  { file: 'src/main.tsx', pattern: 'src/main.tsx', expect: true },
  { file: 'src/main.ts', pattern: 'src/main.tsx', expect: false },
  { file: 'deploy/dl-release/server.mjs', pattern: 'deploy/dl-release/**', expect: true },
]

/** `node scripts/lib/glob-match.mjs --self-test` */
export function selfTest() {
  let failed = 0
  for (const row of SELF_TEST_ROWS) {
    const actual = matchesGlob(row.file, row.pattern)
    if (actual !== row.expect) {
      failed += 1
      console.log(`FAIL ${row.pattern} × ${row.file}：期望 ${row.expect}，实际 ${actual}`)
    }
  }
  console.log(failed === 0 ? `glob 匹配自证通过 ✅（${SELF_TEST_ROWS.length} 条）` : `glob 匹配自证失败 ${failed} 条 ❌`)
  return failed === 0 ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(selfTest())
}
