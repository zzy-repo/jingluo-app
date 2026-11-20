// 测试用最小 PDF 夹具工厂（#480 / #544 / #571）：**不往仓库里塞二进制**，现场按 PDF 1.4 结构拼字节。
//
// 为什么抽成 helper：`tests/unit/attachment-character-count-480.test.mjs`（#544 口径）与
// `tests/unit/pdf-parser-480.test.mjs`（#571 关闭条件）都要「一份正文可预测的真 PDF」。
// 两份各抄一遍 50 行生成器会被 `check:test-duplication`（R1 逐字 ≥20 行）判红 —— 而且那种红
// 是对的：两份生成器一旦漂移，两个文件对「同一份 PDF」的断言就不可比了。
//
// 结构固定为：1 个 Catalog、1 个 Pages、每页一对（Page + 内容流）、1 个 Helvetica 字体、
// 一张手算偏移的 xref 表。正文只用 ASCII（WinAnsi），避免字体/编码把变量带进来。
//
// 已知边界：只够测「文本提取」这条链路 —— 没有图片、没有 CJK 字体、没有加密字典、
// 没有跨页表格。需要那些形状的用例请另建夹具（`tests/fixtures/`）。

/** PDF 字符串转义（括号与反斜杠） */
export const escapePdfText = (text) =>
  text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

/**
 * 手工拼一份最小 PDF：`pages` 是「每页的文本行」，一页一个内容流、每行一个 `Tj`。
 * 行距 18（字号 12 的 1.5 倍），保证 pdfLayout 的行聚类不会把两行并成一行。
 * 传 `[[]]` 这类空行数组即可得到「有页、无文本」的样本（无文本层用例）。
 */
export const buildPdf = (pages) => {
  const objects = []
  const pageIds = pages.map((_, index) => 3 + index * 2)
  const fontId = 3 + pages.length * 2
  objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' })
  objects.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  })
  pages.forEach((lines, index) => {
    const pageId = 3 + index * 2
    const contentId = 4 + index * 2
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    })
    const ops = ['BT', '/F1 12 Tf', '72 760 Td']
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        ops.push('0 -18 Td')
      }
      ops.push(`(${escapePdfText(line)}) Tj`)
    })
    ops.push('ET')
    const stream = ops.join('\n')
    objects.push({ id: contentId, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` })
  })
  objects.push({
    id: fontId,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  })
  objects.sort((a, b) => a.id - b.id)

  let out = '%PDF-1.4\n'
  const offsets = new Map()
  for (const object of objects) {
    offsets.set(object.id, out.length)
    out += `${object.id} 0 obj\n${object.body}\nendobj\n`
  }
  const xrefStart = out.length
  const maxId = objects[objects.length - 1].id
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id += 1) {
    out += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

/**
 * 一份「每页都有足够正文」的 PDF 的默认行长。
 * 为什么在意长度：`pdfMinCharsPerPage`（20）判的是**平均**每页字符数，太短的样本会被
 * 误判成扫描版（这正是几份早期探针踩过的坑）。
 */
export const PDF_SAMPLE_LINE = 'The quick brown fox jumps over the lazy dog, again and again.'
