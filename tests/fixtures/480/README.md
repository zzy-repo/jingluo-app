# `tests/fixtures/480/` —— #528 验收测试的自建最小样本

全部二进制产物都随仓库提交；**生成它们的脚本也提交**（`build-fixtures.mjs`），删掉重跑即可得到同一份字节：

```bash
node tests/fixtures/480/build-fixtures.mjs
```

为什么自建而不是拿真实业务文件：真实文档带用户内容、体积和不该进仓库的元数据；
验收测试要的是「每条断言都能指着某几个字节说话」的最小充分样本。

## 清单

| 文件 | 字节数 | 用来断言什么 |
| --- | --- | --- |
| `enc/utf8.txt` | 41 B | UTF-8 识别（无 BOM），一行中文 + ASCII |
| `enc/utf8-bom.txt` | 44 B | UTF-8 BOM：标签是 `UTF-8 BOM`，正文首字符不能是 U+FEFF |
| `enc/utf16le.txt` | 36 B | UTF-16LE（带 BOM） |
| `enc/utf16be.txt` | 36 B | UTF-16BE（带 BOM） |
| `enc/gbk.txt` | 23 B | GBK：`中文测试` 的固定码 `D6D0 CEC4 B2E2 CAD4` |
| `enc/gb18030.txt` | 23 B | GB18030：含**四字节**序列 `95 32 82 36`（与 GBK 区分得开的唯一特征） |
| `txt/empty.txt` | 0 B | 空文件 → `TxtParseError('empty')` |
| `txt/binary.txt` | 10 B | NUL + 控制字符 → `TxtParseError('binary')` |
| `txt/mojibake.txt` | 23 B | 合法 UTF-8 里掺 2 个坏字节 → 有损但可读：`warnings` 有「乱码」，正文完整 |
| `docx/minimal.docx` | 2.2 KB | 标题/段落/列表/表格按文档顺序转 GFM + 一张真 PNG（只计数进 warnings） |
| `docx/xxe.docx` | 485 B | DOCTYPE + 外部实体 `file:///etc/passwd`：声明必须被剥离、实体不许展开 |
| `docx/path-traversal.docx` | 923 B | 条目名含 `../../../../etc/passwd` 与 `word/../../../../evil.xml` → 整包拒绝 |
| `docx/traversal-only.docx` | 542 B | 主文档只存在于穿越路径下 → 同样拒绝（不许「按后缀找主文档」蒙过去） |
| `docx/zip-bomb.docx` | 41 KB | 40 MiB 零字节（压缩比 ~1000:1）→ 压缩比闸拒绝 |
| `pdf/text-layer.pdf` | 904 B | **真**文本层（2 页，`pdftotext` 可取出 `Hello 480 page 1/2`）→ `[第N页]` 逐页格式 |
| `pdf/empty.pdf` | 549 B | 有页面、无文本流 → `PdfParseError('noTextLayer')` |
| `pdf/encrypted.pdf` | 639 B | trailer 带 `/Encrypt` → `PdfParseError('encryptedPdf')`（不起 pdfjs） |
| `pdf/not-a-pdf.pdf` | 46 B | 扩展名骗人的纯文本 → `PdfParseError('notPdfFile')` |

超限样本（TXT 5 MiB + 1）**不进仓库**：用例里 `mkdtemp` 现造（`Buffer.alloc`），
避免为一条「超限」断言往仓库塞 5 MB。

## 两个辅助模块（不是夹具数据，是「换掉宿主边界」的替身）

| 文件 | 作用 | 被替身的是什么 / 什么是真的 |
| --- | --- | --- |
| `pdfjs-node-loader.mjs` | 把 `parsers/pdfLoader.ts`（浏览器 `<script src>` 注入）换到 Node 侧 | 只换**加载方式**：用的是同一个 `pdfjs-dist@2.16.105` 的 legacy UMD 产物；`pdf.ts` 的逐页循环、`[第N页]` 拼装、无文本层阈值、取消语义全是真代码 |
| `memory-attachment-db.mjs` | 附件存储的**内存版 IndexedDB 落点** | 只换「IndexedDB 引擎」：`attachments/{store,manager}.ts` 的 sha256、`sha256:parserVersion` 缓存键、引用计数删除、状态机全是真代码 |

两者的边界写在各文件头部；`db.ts` 的 **v13 schema 与升级路径**由
`tests/golden/g13-480-doc-attach.test.mjs` 在真浏览器里覆盖（真 IndexedDB，断言 `version===13`
与 `attachments` / `attachmentTexts` 两个 store 存在）。
