# vision 图片夹具（#553）

四份加起来 **296 B**，用途是「喂字节」而不是给人看的照片：
magic bytes 白名单、EXIF 方向、阈值分支各要一种输入，真实解码由浏览器/替身负责。

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `tiny-64x32.png` | 78 B | 阈值内（长边 64 ≤ 1568、像素 2 048 ≤ 1.15MP、< 3.5MB）→ 走**原图直发**分支，字节一个不改 |
| `exif-orientation-6.jpg` | 117 B | 存储 4000×3000 + EXIF `Orientation=6`（显示 3000×4000）→ 必须压缩且方向正确 |
| `oversize-6000x4000.jpg` | 77 B | 长边 6000 > 1568 且 2 400 万像素 > 1.15MP → 压到长边 1568、输出 webp |
| `heic-sample.heic` | 24 B | ISO-BMFF `ftyp` 头，白名单之外 → 必须**明确拒绝**（HEIC 目前不支持） |

## 格式：真实文件头 + 测试专用栅格

每份都是「能被 `src/services/attachments/imageSource.ts` 的 magic-bytes / 尺寸 / EXIF 解析认出来的
真实文件头」+ 一段 `FKE1` 载荷（4×4 个采样点，四象限各一色）。载荷是本仓库**测试替身**
（`tests/helpers/fake-image-dom.mjs`）自己的栅格格式 —— 它不冒充真实编码产物：真实 JPEG/PNG 解码
归浏览器，由 #551 的头部解析用例 + 真机/集成层覆盖；L0 里只验证「按字节喂进去、按协议形状取出来」。
用象限而不是图案，是因为方向错误的三种典型形态（多转 90° / 转反 / 少转）都会改变象限排列。

**不要往这里放大图**（#553 硬要求）。要新的字节形态，改 `tests/tools/make-vision-fixtures.mjs` 后重跑：

```bash
node tests/tools/make-vision-fixtures.mjs
```
