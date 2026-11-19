#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性开发工具：从 docs/ui/app-icon/source.png 生成 Android 启动图标资源（#266）。

不是构建依赖：`pnpm build` / `pnpm test` 都不会调用本脚本，产物（PNG/XML）直接提交进仓库。
手动重跑需要本机 Python 3 + Pillow + numpy：

    python scripts/gen-app-icon.py

处理逻辑（对应 #266 的关键要求）：

1. 源图是「白底 + 深色圆角方块」的 App Store 预览样式。裁掉白底，只保留深色方块。
2. 圆角外的四个角用「按角度径向取色」填满深色背景 —— 不留白，也不会在角落留下生硬的纯色块。
3. 自适应图标分层：背景走 `@color/ic_launcher_background`（纯色），前景是**透明背景**的鲸鱼图形，
   由源图反解 alpha（对背景做二次曲面拟合后 unmultiply），内容缩放到画布 68%（官方安全区 66%–72%）。
4. legacy 图标：圆角方块（ic_launcher.png）/ 圆形（ic_launcher_round.png），圆角外 RGB 填深色、alpha=0，
   保证 `pnpm run check:icon` 的四边白像素统计为 0。
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "ui", "app-icon", "source.png")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
DOCS = os.path.join(ROOT, "docs", "ui", "app-icon")

# 源图里深色圆角方块的精确边界（沿中线用 L 穿越 128 的亚像素交点测得：
# left 121.31 / right 1133.96 / top 123.32 / bottom 1133.55）。
# 取内侧 1008×1008，保证像素完全落在深色区域内（不含 1px 白边抗锯齿）。
CROP_BOX = (124, 124, 1132, 1132)
SQ = CROP_BOX[2] - CROP_BOX[0]  # 1008

# 圆角半径比例：源图实测 ~280px / 1012px ≈ 0.276（App Store 式圆角方块）
RADIUS_RATIO = 0.276

MASTER = 1024          # 主稿边长
FG_SAFE = 0.68         # 自适应前景内容占画布比例（官方建议 66%–72%）
ALPHA_CUT = 0.02       # 低于此 alpha 视为无内容（去背景拟合噪声）


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    x0 = np.clip(np.floor(x).astype(int), 0, w - 1)
    y0 = np.clip(np.floor(y).astype(int), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    return (
        img[y0, x0] * (1 - fx) * (1 - fy)
        + img[y0, x1] * fx * (1 - fy)
        + img[y1, x0] * (1 - fx) * fy
        + img[y1, x1] * fx * fy
    )


def shift2d(a: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """out[y,x] = a[y+dy, x+dx]，越界补 0（不能用 np.roll，否则边缘会互相串色）。"""
    h, w = a.shape[:2]
    out = np.zeros_like(a)
    y_src = slice(max(0, -dy), h - max(0, dy))
    x_src = slice(max(0, -dx), w - max(0, dx))
    y_dst = slice(max(0, dy), h - max(0, -dy))
    x_dst = slice(max(0, dx), w - max(0, -dx))
    out[y_dst, x_dst] = a[y_src, x_src]
    return out


def shape_mask(rgb: np.ndarray) -> np.ndarray:
    """求「深色圆角方块」的真实形状（源图是 squircle，圆弧近似不精确）。

    从画布四边向内扩散，收集与边界连通的亮像素（= 方块外面的白底）；鲸鱼的白被深色包住、
    不与边界连通，因此不会被误判。返回 True = 方块内部。
    """
    light = rgb.mean(axis=2) > 120
    prop = np.zeros(light.shape, bool)
    prop[0, :] |= light[0, :]
    prop[-1, :] |= light[-1, :]
    prop[:, 0] |= light[:, 0]
    prop[:, -1] |= light[:, -1]
    while True:
        p = prop.astype(np.float32)
        nbr = np.zeros_like(p)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nbr += shift2d(p, dy, dx)
        nxt = prop | (light & (nbr > 0))
        if nxt.sum() == prop.sum():
            break
        prop = nxt
    return ~prop


def fill_outside(rgb: np.ndarray, mask: np.ndarray, radius: float) -> np.ndarray:
    """圆角外的区域用「邻域扩散」从深色区域一层层向内补满：接住源图柔和的径向渐变，
    不留下生硬色块，也不残留任何白色像素。"""
    s = rgb.shape[0]
    out = rgb.astype(np.float32).copy()
    known = mask.copy()
    unknown = ~mask
    for _ in range(int(radius) + 40):
        if not unknown.any():
            break
        acc = np.zeros_like(out)
        cnt = np.zeros((s, s), np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = shift2d(known.astype(np.float32), dy, dx)
            acc += shift2d(out, dy, dx) * k[:, :, None]
            cnt += k
        grow = unknown & (cnt > 0)
        if not grow.any():
            break
        out[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
        unknown = unknown & ~grow
    return out


def fit_background(rgb: np.ndarray) -> np.ndarray:
    """对深色背景做二次曲面拟合（背景本身是柔和径向渐变，不能当成常数）。"""
    s = rgb.shape[0]
    yy, xx = np.mgrid[0:s, 0:s]
    xs = (xx + 0.5 - s / 2) / (s / 2)
    ys = (yy + 0.5 - s / 2) / (s / 2)
    feats = [np.ones_like(xs), xs, ys, xs * xs, ys * ys, xs * ys]
    lum = rgb.mean(axis=2)
    sel = lum < 60  # 背景亮度 22–31，鲸鱼/波浪远高于此
    a = np.stack([f[sel] for f in feats], axis=1)
    coef, *_ = np.linalg.lstsq(a, rgb[sel], rcond=None)
    bg = np.zeros_like(rgb)
    for i, f in enumerate(feats):
        bg += coef[i] * f[:, :, None]
    return bg


def extract_foreground(rgb: np.ndarray, keep: np.ndarray) -> np.ndarray:
    """反解前景 RGBA：pixel = alpha*F + (1-alpha)*B，F 保证不超 255（无需裁剪）。
    keep 限定只保留圆角形状内的像素，避免圆角填充区被误判成内容。"""
    bg = fit_background(rgb)
    res = np.clip(rgb - bg, 0, None)
    alpha = np.zeros(rgb.shape[:2])
    for c in range(3):
        alpha = np.maximum(alpha, res[:, :, c] / np.maximum(255.0 - bg[:, :, c], 1.0))
    alpha = np.clip(alpha, 0.0, 1.0)
    alpha[~keep] = 0.0
    alpha[alpha < ALPHA_CUT] = 0.0
    alpha[alpha > 0.995] = 1.0
    fg_rgb = bg.copy()
    nz = alpha > 0
    fg_rgb[nz] = bg[nz] + res[nz] / alpha[nz][:, None]
    rgba = np.dstack([np.clip(fg_rgb, 0, 255), alpha * 255.0])
    return rgba


def premultiplied_resize(rgba: np.ndarray, size: int) -> Image.Image:
    """预乘 alpha 后缩放，避免半透明边缘出现暗边/白边。"""
    img = Image.fromarray(rgba.astype(np.uint8), "RGBA")
    if img.size != (size, size):
        arr = np.asarray(img).astype(np.float32) / 255.0
        a = arr[:, :, 3:4]
        pm = np.concatenate([arr[:, :, :3] * a, a], axis=2)
        pm_img = Image.fromarray((pm * 255.0).astype(np.uint8), "RGBA").resize(
            (size, size), Image.LANCZOS
        )
        out = np.asarray(pm_img).astype(np.float32) / 255.0
        a2 = np.clip(out[:, :, 3:4], 0, 1)
        rgb2 = np.where(a2 > 1e-4, out[:, :, :3] / np.maximum(a2, 1e-4), 0.0)
        res = np.concatenate([np.clip(rgb2, 0, 1), a2], axis=2)
        img = Image.fromarray((res * 255.0).round().astype(np.uint8), "RGBA")
    return img


def content_bbox(alpha: np.ndarray, thr: float = 0.2) -> tuple[int, int, int, int]:
    m = alpha > thr
    rows = np.where(m.any(axis=1))[0]
    cols = np.where(m.any(axis=0))[0]
    return int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1


def compose_foreground(rgba: np.ndarray, canvas: int, content_ratio: float) -> np.ndarray:
    """把内容按 content_ratio 缩放并居中放到透明画布上。"""
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    x0, y0, x1, y1 = content_bbox(alpha)
    crop = rgba[y0:y1, x0:x1]
    ch, cw = crop.shape[0], crop.shape[1]
    target = content_ratio * canvas
    scale = target / max(cw, ch)
    new_w = max(1, int(round(cw * scale)))
    new_h = max(1, int(round(ch * scale)))
    resized = premultiplied_resize(crop, max(new_w, new_h)).resize((new_w, new_h), Image.LANCZOS)
    out = np.zeros((canvas, canvas, 4), np.float32)
    ox = (canvas - new_w) // 2
    oy = (canvas - new_h) // 2
    part = np.asarray(resized).astype(np.float32)
    out[oy:oy + new_h, ox:ox + new_w, :3] = part[:, :, :3]
    out[oy:oy + new_h, ox:ox + new_w, 3] = part[:, :, 3]
    return out


def shaped_legacy_icon(master: np.ndarray, mask_img: Image.Image, size: int, bg_color) -> Image.Image:
    """legacy 圆角方块图标：用源图 flood fill 出来的真实形状做 alpha，圆角外 RGB 填深色、alpha=0。"""
    full = Image.fromarray(master, "RGB").resize((size, size), Image.LANCZOS)
    mask = mask_img.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), tuple(int(v) for v in bg_color) + (0,))
    out.paste(full, (0, 0), mask)
    return out


def circle_mask_icon(fg_rgba: np.ndarray, size: int, bg_color) -> Image.Image:
    """圆形 legacy 图标：圆形深色底 + 前景（内容 68%），外层 alpha=0。"""
    fg = premultiplied_resize(fg_rgba, size)
    out = Image.new("RGBA", (size, size), tuple(int(v) for v in bg_color) + (0,))
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    base = Image.new("RGBA", (size, size), tuple(int(v) for v in bg_color) + (255,))
    base.alpha_composite(fg)
    out.paste(base, (0, 0), mask)
    return out


def edge_band_color(rgb: np.ndarray, band: int = 10):
    """取方块四边内侧细带的 RGB 中位色，作为纯色背景与圆角填充色。"""
    s = rgb.shape[0]
    top = rgb[4:4 + band, :, :].reshape(-1, 3)
    left = rgb[:, 4:4 + band, :].reshape(-1, 3)
    bot = rgb[s - 4 - band:s - 4, :, :].reshape(-1, 3)
    right = rgb[:, s - 4 - band:s - 4, :].reshape(-1, 3)
    allp = np.concatenate([top, left, bot, right], axis=0)
    return np.median(allp, axis=0)


def main() -> int:
    if not os.path.exists(SRC):
        print(f"[gen-app-icon] 缺少源图: {SRC}", file=sys.stderr)
        return 1

    src = Image.open(SRC).convert("RGB")
    print(f"[gen-app-icon] 源图 {src.size[0]}×{src.size[1]}")
    crop = src.crop(CROP_BOX)
    assert crop.size == (SQ, SQ), crop.size
    rgb = np.asarray(crop).astype(np.float32)

    band_color = edge_band_color(rgb)
    radius = RADIUS_RATIO * SQ
    print(f"[gen-app-icon] 方块边长 {SQ}px，圆角半径 {radius:.1f}px，边缘深色 "
          f"#{int(band_color[0]):02X}{int(band_color[1]):02X}{int(band_color[2]):02X}")

    mask_small = shape_mask(rgb)
    print(f"[gen-app-icon] 方块形状覆盖率 {mask_small.mean()*100:.1f}%")
    filled = fill_outside(rgb, mask_small, radius)
    master_img = Image.fromarray(np.clip(filled, 0, 255).astype(np.uint8), "RGB").resize(
        (MASTER, MASTER), Image.LANCZOS
    )
    master = np.asarray(master_img).copy()
    # 最外 2px 用第 3 像素行/列覆盖：源图方块边缘本就是纯深色，这样彻底杜绝
    # 圆角外残余的抗锯齿亮像素（含 LANCZOS 重采样的过冲）。
    master[:2, :, :] = master[2:3, :, :]
    master[-2:, :, :] = master[-3:-2, :, :]
    master[:, :2, :] = master[:, 2:3, :]
    master[:, -2:, :] = master[:, -3:-2, :]

    # 主稿自检：四边 2px 无白像素
    for name, band in (
        ("top", master[:2]), ("bottom", master[-2:]),
        ("left", master[:, :2]), ("right", master[:, -2:]),
    ):
        w = int(((band[:, :, 0] > 245) & (band[:, :, 1] > 245) & (band[:, :, 2] > 245)).sum())
        print(f"[gen-app-icon] 主稿 {name} 2px 白像素: {w}")

    mask_img = Image.fromarray((mask_small * 255).astype(np.uint8), "L").resize(
        (MASTER, MASTER), Image.LANCZOS
    )
    keep = np.asarray(mask_img.filter(ImageFilter.MinFilter(9))) > 127
    fg_rgba = extract_foreground(master.astype(np.float32), keep)
    alpha = fg_rgba[:, :, 3] / 255.0
    bbox = content_bbox(alpha)
    print(f"[gen-app-icon] 前景内容 bbox {bbox} → 占画布 "
          f"{(bbox[2]-bbox[0])/MASTER*100:.1f}% × {(bbox[3]-bbox[1])/MASTER*100:.1f}%")

    # ---- 写 Android 资源 ----
    densities = [("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216),
                 ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)]
    for dpi, legacy_px, fg_px in densities:
        outdir = os.path.join(RES, f"mipmap-{dpi}")
        os.makedirs(outdir, exist_ok=True)

        rounded_icon = shaped_legacy_icon(master, mask_img, legacy_px, band_color)
        rounded_icon.save(os.path.join(outdir, "ic_launcher.png"))

        fg_canvas = compose_foreground(fg_rgba, fg_px, FG_SAFE)
        fg_img = premultiplied_resize(fg_canvas, fg_px)
        # 透明区域 RGB 也写成深色，任何口径下的白像素统计都为 0
        arr = np.asarray(fg_img).astype(np.float32)
        arr[arr[:, :, 3] < 1] = np.array([band_color[0], band_color[1], band_color[2], 0.0])
        Image.fromarray(arr.astype(np.uint8), "RGBA").save(
            os.path.join(outdir, "ic_launcher_foreground.png")
        )

        circle_icon = circle_mask_icon(
            compose_foreground(fg_rgba, legacy_px, FG_SAFE), legacy_px, band_color
        )
        circle_icon.save(os.path.join(outdir, "ic_launcher_round.png"))
        print(f"[gen-app-icon] mipmap-{dpi}: legacy {legacy_px}px, foreground {fg_px}px")

    os.makedirs(DOCS, exist_ok=True)
    Image.fromarray(master, "RGB").resize((512, 512), Image.LANCZOS).save(
        os.path.join(DOCS, "icon-512.png")
    )
    print("[gen-app-icon] docs/ui/app-icon/icon-512.png 512×512")

    # 纯色背景写进 values（自适应图标 background 层）
    color = "#%02X%02X%02X" % (int(round(band_color[0])), int(round(band_color[1])),
                               int(round(band_color[2])))
    values_path = os.path.join(RES, "values", "ic_launcher_background.xml")
    with open(values_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<resources>\n"
            f'    <color name="ic_launcher_background">{color}</color>\n'
            "</resources>\n"
        )
    print(f"[gen-app-icon] values/ic_launcher_background.xml → {color}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
